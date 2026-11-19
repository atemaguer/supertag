package main

import (
	"context"
	"net/http"

	"connectrpc.com/connect"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
	rpc "github.com/atemaguer/supertag/sdks/go/runtimev2/runtimev2connect"
)

// handleNegotiation answers protocol negotiation as a current Gateway. The TUI negotiates
// before its first call to a Gateway.
func handleNegotiation(mux *http.ServeMux) {
	mux.Handle(rpc.ProtocolNegotiationNegotiateProcedure, connect.NewUnaryHandler(rpc.ProtocolNegotiationNegotiateProcedure,
		func(_ context.Context, _ *connect.Request[v2.NegotiateProtocolRequest]) (*connect.Response[v2.NegotiateProtocolResponse], error) {
			return connect.NewResponse(&v2.NegotiateProtocolResponse{
				Role: v2.ServiceRole_SERVICE_ROLE_GATEWAY, ProtocolVersion: 7, ProtocolVersions: []uint32{7},
			}), nil
		}))
}
