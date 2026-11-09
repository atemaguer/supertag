package operator_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1/operatorv1connect"
)

type organization struct {
	operatorv1connect.UnimplementedOrganizationServiceHandler
}

func (organization) GetStatus(
	_ context.Context,
	request *connect.Request[operatorv1.GetStatusRequest],
) (*connect.Response[operatorv1.GetStatusResponse], error) {
	if request.Header().Get("Authorization") != "Bearer secret" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("token required"))
	}
	return connect.NewResponse(&operatorv1.GetStatusResponse{
		Phase: operatorv1.ControlPlanePhase_CONTROL_PLANE_PHASE_ACCEPTING,
		Controllers: []*operatorv1.Controller{
			{Name: "task-dispatch", Phase: operatorv1.ControllerPhase_CONTROLLER_PHASE_RUNNING},
		},
	}), nil
}

func TestGeneratedClientCallsGetStatus(t *testing.T) {
	mux := http.NewServeMux()
	mux.Handle(operatorv1connect.NewOrganizationServiceHandler(organization{}))
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := operatorv1connect.NewOrganizationServiceClient(
		server.Client(),
		server.URL,
		connect.WithProtoJSON(),
	)

	request := connect.NewRequest(&operatorv1.GetStatusRequest{})
	request.Header().Set("Authorization", "Bearer secret")
	response, err := client.GetStatus(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Msg.GetPhase() != operatorv1.ControlPlanePhase_CONTROL_PLANE_PHASE_ACCEPTING {
		t.Fatalf("phase = %v", response.Msg.GetPhase())
	}
	if got := response.Msg.GetControllers(); len(got) != 1 || got[0].GetName() != "task-dispatch" {
		t.Fatalf("controllers = %v", got)
	}

	_, err = client.GetStatus(context.Background(), connect.NewRequest(&operatorv1.GetStatusRequest{}))
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("anonymous call: %v", err)
	}
}
