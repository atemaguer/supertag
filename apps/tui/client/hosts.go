package client

import (
	"context"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// maxHostPages bounds ListWorkerHosts, so an organization with very many Worker Hosts still gets
// an answer.
const maxHostPages = 10

// hostPage is the page size ListWorkerHosts asks for, the most HostService returns.
const hostPage = 500

// ListWorkerHosts returns the organization's Worker Hosts, the earliest enrolled first, as
// `supertag list worker-host` shows them.
func (c *Client) ListWorkerHosts(ctx context.Context) ([]*operatorv1.WorkerHost, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var all []*operatorv1.WorkerHost
	token := ""
	for range maxHostPages {
		res, err := c.hosts.ListWorkerHosts(ctx, connect.NewRequest(&operatorv1.ListWorkerHostsRequest{
			PageSize: hostPage, PageToken: token,
		}))
		if err != nil {
			return nil, apiError(err)
		}
		all = append(all, res.Msg.GetWorkerHosts()...)
		token = res.Msg.GetNextPageToken()
		if token == "" {
			break
		}
	}
	return all, nil
}
