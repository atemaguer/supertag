package client

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strings"

	"connectrpc.com/connect"

	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
)

// Secret prefixes: an Auth Key enrolls this device once; an enrolled client credential is what a
// saved connection keeps. Operator Tokens start with stop_, and the admin token has no prefix.
const (
	AuthKeyPrefix    = "stak_"
	CredentialPrefix = "stcr_"
)

// IsAuthKey reports whether a pasted secret is an Auth Key rather than a credential to save.
func IsAuthKey(secret string) bool { return isSecret(AuthKeyPrefix, secret) }

// IsClientCredential reports whether a saved credential is an enrolled client device's.
func IsClientCredential(secret string) bool { return isSecret(CredentialPrefix, secret) }

func isSecret(prefix, value string) bool {
	rest, ok := strings.CutPrefix(value, prefix)
	if !ok || len(rest) != 64 {
		return false
	}
	_, err := hex.DecodeString(rest)
	return err == nil && strings.ToLower(rest) == rest
}

// DeviceName is this machine's host name as a client name: letters, digits, hyphens,
// underscores and dots.
func DeviceName() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "device"
	}
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			return r
		}
		return '-'
	}, host)
}

// Caller is who the Control Plane resolved a credential to.
type Caller struct {
	// Principal is such as operator:local, operator:token:laptop or client:alice-laptop.
	Principal string
	Client    bool
	Admin     bool
}

// WhoAmI asks the Control Plane whose credential this client presents.
func (c *Client) WhoAmI(ctx context.Context) (Caller, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.runtime.enrollments.WhoAmI(ctx, connect.NewRequest(&v2.WhoAmIRequest{}))
	if err != nil {
		return Caller{}, apiError(err)
	}
	return Caller{
		Principal: res.Msg.GetPrincipal(),
		Client:    res.Msg.GetRole() == v2.PrincipalRole_PRINCIPAL_ROLE_CLIENT,
		Admin:     res.Msg.GetAdmin(),
	}, nil
}

// Enroll joins this device as client:NAME with a client Auth Key, which is presented once as
// the bearer and never kept. It returns the target with the new enrolled credential in place of
// the key; only that credential is saved.
func Enroll(ctx context.Context, target Target, version, name string) (Target, string, error) {
	key := target.Token
	if !IsAuthKey(key) {
		return target, "", errors.New("an Auth Key starts with stak_ and has 64 hex digits")
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return target, "", err
	}
	credential := CredentialPrefix + hex.EncodeToString(random)
	operation := make([]byte, 16)
	if _, err := rand.Read(operation); err != nil {
		return target, "", err
	}
	c, err := New(target, version)
	if err != nil {
		return target, "", err
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	digest := sha256.Sum256([]byte(credential))
	res, err := c.runtime.enrollments.Enroll(ctx, connect.NewRequest(&v2.EnrollRequest{
		Role:        v2.PrincipalRole_PRINCIPAL_ROLE_CLIENT,
		Name:        name,
		OperationId: hex.EncodeToString(operation),
		TokenDigest: digest[:],
	}))
	if err != nil {
		return target, "", apiError(err)
	}
	target.Token = credential
	return target, res.Msg.GetPrincipal(), nil
}
