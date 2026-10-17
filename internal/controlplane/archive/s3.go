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
}

func NewS3(ctx context.Context, bucket, region string) (*S3, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, err
	}
	c := s3.NewFromConfig(cfg)
	return &S3{Bucket: bucket, client: c, up: manager.NewUploader(c, func(u *manager.Uploader) { u.PartSize = 8 << 20 }),
		presign: s3.NewPresignClient(c)}, nil
}

// Put uploads r to key (streaming, multipart when large) and returns the
// stored object's size as S3 reports it afterwards.
func (a *S3) Put(ctx context.Context, key string, r io.Reader) (int64, error) {
	_, err := a.up.Upload(ctx, &s3.PutObjectInput{
		Bucket: &a.Bucket, Key: &key, Body: r,
		ContentType:     aws.String("application/x-ndjson"),
		ContentEncoding: aws.String("gzip"),
		// Object Lock buckets require an integrity checksum on every write
		ChecksumAlgorithm:    types.ChecksumAlgorithmCrc32,
		ServerSideEncryption: types.ServerSideEncryptionAes256,
	})
	if err != nil {
		return 0, fmt.Errorf("s3 upload %s: %w", key, err)
	}
	h, err := a.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &a.Bucket, Key: &key})
	if err != nil {
		return 0, fmt.Errorf("s3 head %s: %w", key, err)
	}
	return aws.ToInt64(h.ContentLength), nil
}

// Check proves the role can write to the bucket (a tiny object under
// events/_health/, kept like every archive) so a missing permission shows up
// at start, not 90 days later.
func (a *S3) Check(ctx context.Context) error {
	key := "events/_health/probe.txt"
	_, err := a.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &a.Bucket, Key: &key,
		Body:              strings.NewReader("effigent control plane write check " + time.Now().UTC().Format(time.RFC3339) + "\n"),
		ChecksumAlgorithm: types.ChecksumAlgorithmCrc32, ServerSideEncryption: types.ServerSideEncryptionAes256})
	if err != nil {
		return fmt.Errorf("s3 write check on %s: %w", a.Bucket, err)
	}
	return nil
}

// PresignGet returns a short-lived download link.
func (a *S3) PresignGet(ctx context.Context, key, filename string, ttl time.Duration) (string, error) {
	r, err := a.presign.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: &a.Bucket, Key: &key,
		ResponseContentDisposition: aws.String(`attachment; filename="` + filename + `"`)},
		s3.WithPresignExpires(ttl))
	if err != nil {
		return "", err
	}
	return r.URL, nil
}
