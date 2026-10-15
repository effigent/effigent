package cpclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ApprovalRequest asks the control plane to approve one paused tool call.
// Summary must already be redacted.
type ApprovalRequest struct {
	Fingerprint string `json:"fingerprint"`
	Agent       string `json:"agent"`
	SessionID   string `json:"session_id"`
	Tool        string `json:"tool"`
	Summary     string `json:"summary"`
	Cwd         string `json:"cwd"`
	Rule        string `json:"rule"`
	Reason      string `json:"reason"`
	OSUser      string `json:"os_user"`
	TTLMinutes  int    `json:"ttl_minutes"`
	WaitSeconds int    `json:"wait_seconds"`
}

// ApprovalResponse: State is approved (go ahead, the approval is used up by
// this call), pending, denied or expired.
type ApprovalResponse struct {
	ID            string    `json:"id"`
	State         string    `json:"state"`
	DecidedByName string    `json:"decided_by_name"`
	Note          string    `json:"note"`
	ExpiresAt     time.Time `json:"expires_at"`
	Created       bool      `json:"created"`
	Notified      []string  `json:"notified"`
}

// approvalHTTP has no client-wide timeout: each call is bounded by its
// context (the wait the server holds the request for, plus slack).
var approvalHTTP = &http.Client{}

// RequestApproval files (or finds) the request and waits up to
// req.WaitSeconds on the server for a decision.
func (c *Client) RequestApproval(ctx context.Context, req ApprovalRequest) (ApprovalResponse, error) {
	var out ApprovalResponse
	ctx, cancel := context.WithTimeout(ctx, time.Duration(req.WaitSeconds)*time.Second+20*time.Second)
	defer cancel()
	b, _ := json.Marshal(req)
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, c.State.Server+"/ep/v1/approvals", bytes.NewReader(b))
	if err != nil {
		return out, err
	}
	hr.Header.Set("Authorization", "Bearer "+c.State.Secret)
	hr.Header.Set("Content-Type", "application/json")
	res, err := approvalHTTP.Do(hr)
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return out, fmt.Errorf("control plane answered %s: %s", res.Status, bytes.TrimSpace(msg))
	}
	return out, json.NewDecoder(res.Body).Decode(&out)
}
