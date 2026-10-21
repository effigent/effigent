// Package archive stores agent events past their retention in S3 (one gzip'd
// JSON-lines object per tenant-day), in a bucket with versioning and Object
// Lock so archived evidence can't be overwritten or deleted early.
package archive

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3 writes archives with the process's AWS role.
type S3 struct {
	Bucket  string
	client  *s3.Client
	up      *manager.Uploader
	presign *s3.PresignClient
	sse     types.ServerSideEncryption
}

func NewS3(ctx context.Context, bucket, region string) (*S3, error) {
	return NewS3With(ctx, bucket, region, S3Options{})
}

// S3Options points the archive at an S3-compatible store (self-hosted:
// MinIO, Ceph, …). The zero value is AWS S3.
type S3Options struct {
	Endpoint  string // e.g. https://minio.internal:9000; "" = AWS
	PathStyle bool   // bucket in the path, not the host name (MinIO)
	// NoSSE leaves out the SSE-S3 header, for stores without a KMS (MinIO
	// refuses it then); encrypt the volume instead.
	NoSSE bool
}

func NewS3With(ctx context.Context, bucket, region string, o S3Options) (*S3, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, err
	}
	c := s3.NewFromConfig(cfg, func(so *s3.Options) {
		if o.Endpoint != "" {
			so.BaseEndpoint = aws.String(o.Endpoint)
		}
		so.UsePathStyle = o.PathStyle
	})
	a := &S3{Bucket: bucket, client: c, up: manager.NewUploader(c, func(u *manager.Uploader) { u.PartSize = 8 << 20 }),
		presign: s3.NewPresignClient(c), sse: types.ServerSideEncryptionAes256}
	if o.NoSSE {
		a.sse = ""
	}
	return a, nil
}

// Put uploads r to key (streaming, multipart when large) and returns the
// stored version's size as S3 reports it afterwards, and its version id.
func (a *S3) Put(ctx context.Context, key string, r io.Reader) (int64, string, error) {
	in := &s3.PutObjectInput{
		Bucket: &a.Bucket, Key: &key, Body: r,
		ContentType:     aws.String("application/x-ndjson"),
		ContentEncoding: aws.String("gzip"),
		// Object Lock buckets require an integrity checksum on every write
		ChecksumAlgorithm:    types.ChecksumAlgorithmCrc32,
		ServerSideEncryption: a.sse,
	}
	out, err := a.up.Upload(ctx, in)
	if err != nil {
		return 0, "", fmt.Errorf("s3 upload %s: %w", key, err)
	}
	h, err := a.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &a.Bucket, Key: &key, VersionId: out.VersionID})
	if err != nil {
		return 0, "", fmt.Errorf("s3 head %s: %w", key, err)
	}
	return aws.ToInt64(h.ContentLength), aws.ToString(out.VersionID), nil
}

// SetLegalHold puts (on) or lifts an Object Lock legal hold on every
// version under prefix and returns how many it set. Delete markers are
// skipped (they hold no data). Each call is idempotent, so a failed run is
// simply run again. Needs s3:ListBucketVersions and s3:PutObjectLegalHold.
func (a *S3) SetLegalHold(ctx context.Context, prefix string, on bool) (int, error) {
	status := types.ObjectLockLegalHoldStatusOff
	if on {
		status = types.ObjectLockLegalHoldStatusOn
	}
	n := 0
	var keyMarker, versionMarker *string
	for {
		page, err := a.client.ListObjectVersions(ctx, &s3.ListObjectVersionsInput{Bucket: &a.Bucket, Prefix: &prefix,
			KeyMarker: keyMarker, VersionIdMarker: versionMarker})
		if err != nil {
			return n, fmt.Errorf("s3 list versions %s: %w", prefix, err)
		}
		for _, v := range page.Versions {
			if _, err := a.client.PutObjectLegalHold(ctx, &s3.PutObjectLegalHoldInput{Bucket: &a.Bucket, Key: v.Key, VersionId: v.VersionId,
				LegalHold: &types.ObjectLockLegalHold{Status: status}, ChecksumAlgorithm: types.ChecksumAlgorithmCrc32}); err != nil {
				return n, fmt.Errorf("s3 legal hold %s@%s: %w", aws.ToString(v.Key), aws.ToString(v.VersionId), err)
			}
			n++
		}
		if !aws.ToBool(page.IsTruncated) {
			return n, nil
		}
		keyMarker, versionMarker = page.NextKeyMarker, page.NextVersionIdMarker
	}
}

// Check proves the role can write to the bucket (a tiny object under
// events/_health/, kept like every archive) so a missing permission shows up
// at start, not 90 days later.
func (a *S3) Check(ctx context.Context) error {
	key := "events/_health/probe.txt"
	_, err := a.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &a.Bucket, Key: &key,
		Body:              strings.NewReader("effigent control plane write check " + time.Now().UTC().Format(time.RFC3339) + "\n"),
		ChecksumAlgorithm: types.ChecksumAlgorithmCrc32, ServerSideEncryption: a.sse})
	if err != nil {
		return fmt.Errorf("s3 write check on %s: %w", a.Bucket, err)
	}
	return nil
}

// PresignGet returns a short-lived download link to one version ("" = the
// current one; a version needs s3:GetObjectVersion).
func (a *S3) PresignGet(ctx context.Context, key, versionID, filename string, ttl time.Duration) (string, error) {
	in := &s3.GetObjectInput{Bucket: &a.Bucket, Key: &key,
		ResponseContentDisposition: aws.String(`attachment; filename="` + filename + `"`)}
	if versionID != "" {
		in.VersionId = &versionID
	}
	r, err := a.presign.PresignGetObject(ctx, in, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", err
	}
	return r.URL, nil
}
