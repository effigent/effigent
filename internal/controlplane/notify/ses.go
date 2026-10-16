package notify

import (
	"context"
	"fmt"
	"net/mail"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	"github.com/aws/aws-sdk-go-v2/service/sesv2/types"
)

// sesSender sends through the Amazon SES API with the process's own AWS
// credentials (App Runner's instance role): no SMTP password to store.
type sesSender struct {
	region string
	once   sync.Once
	client *sesv2.Client
	err    error
}

func (s *sesSender) send(ctx context.Context, from *mail.Address, to []string, raw []byte) error {
	s.once.Do(func() {
		cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(s.region))
		if err != nil {
			s.err = err
			return
		}
		s.client = sesv2.NewFromConfig(cfg)
	})
	if s.err != nil {
		return fmt.Errorf("ses: %w", s.err)
	}
	_, err := s.client.SendEmail(ctx, &sesv2.SendEmailInput{
		FromEmailAddress: aws.String(from.Address),
		Destination:      &types.Destination{ToAddresses: to},
		Content:          &types.EmailContent{Raw: &types.RawMessage{Data: raw}},
	})
	if err != nil {
		return fmt.Errorf("ses: %w", err)
	}
	return nil
}
