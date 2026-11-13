package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/atemaguer/supertag/apps/tui/client"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

func profileStore(t *testing.T) *gatewayStore {
	t.Helper()
	return &gatewayStore{filepath.Join(t.TempDir(), "private", "tui-gateways.json")}
}

func TestSavedGatewaysReopenRotateAndPreserveLaunchCredentials(t *testing.T) {
	store := profileStore(t)
	first := client.Target{Name: "first", URL: "https://first.example", Token: "first-token"}
	second := client.Target{Name: "second", URL: "https://second.example", Token: "second-token", ServerCAFile: "/trusted/ca.pem", ClientCertFile: "/trusted/client.pem", ClientKeyFile: "/trusted/client.key"}
	if _, err := store.save(first); err != nil {
		t.Fatal(err)
	}
	if _, err := store.save(second); err != nil {
		t.Fatal(err)
	}
	profiles, err := store.load()
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles.Gateways) != 2 || profiles.Gateways[1] != second {
		t.Fatal("stored independent credentials or TLS paths changed")
	}
	if err = store.selectTarget(first); err != nil {
		t.Fatal(err)
	}
	profiles, err = store.load()
	if err != nil {
		t.Fatal(err)
	}
	h, err := startupTargets(nil, profiles)
	if err != nil || h.Contexts[h.Current] != first {
		t.Fatal("saved-only startup did not reopen the selected Gateway")
	}
	rotated := first
	rotated.Token = "replacement-token"
	if _, err = store.save(rotated); err != nil {
		t.Fatal(err)
	}
	profiles, err = store.load()
	if err != nil || len(profiles.Gateways) != 2 || profiles.Gateways[0] != rotated {
		t.Fatal("credential rotation did not replace exactly one saved profile")
	}
	foreign := rotated
	foreign.URL = second.URL
	if _, err = store.save(foreign); err == nil {
		t.Fatal("a saved name must not move its credential to another origin")
	}
	merged := mergeGateways([]client.Target{first}, profiles.Gateways)
	if merged[0] != first || len(merged) != 3 {
		t.Fatal("saved credentials overrode an explicit launch target")
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(handover{Contexts: []client.Target{first}, Protocol: "runtime.v2"})
	if _, err = w.Write(data); err != nil {
		t.Fatal(err)
	}
	w.Close()
	h, err = startupTargets(r, profiles)
	if err != nil || h.Contexts[h.Current] != first {
		t.Fatal("handover selection must win")
	}
	for _, path := range []string{store.path, store.path + ".lock"} {
		stat, err := os.Stat(path)
		if err != nil || stat.Mode().Perm() != 0600 {
			t.Fatal("credential file must be mode 0600")
		}
	}
	if _, err = store.remove(rotated); err != nil {
		t.Fatal(err)
	}
	profiles, err = store.load()
	if err != nil || len(profiles.Gateways) != 1 || profiles.Gateways[0] != second {
		t.Fatal("forget removed another Gateway")
	}
}

func TestSavedGatewayStorageRejectsUnsafeFilesAndHasNoSmallProfileCap(t *testing.T) {
	store := profileStore(t)
	for i := 0; i < 40; i++ {
		if _, err := store.save(client.Target{Name: fmt.Sprintf("gateway-%d", i), URL: fmt.Sprintf("https://gateway-%d.example", i), Token: "credential"}); err != nil {
			t.Fatal(err)
		}
	}
	profiles, err := store.load()
	if err != nil || len(profiles.Gateways) != 40 {
		t.Fatal("all configured Gateways should be retained")
	}
	if err = os.Chmod(store.path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = store.load(); err == nil {
		t.Fatal("read publicly accessible credentials")
	}
	if err = os.Chmod(store.path, 0600); err != nil {
		t.Fatal(err)
	}
	original := store.path + ".original"
	if err = os.Rename(store.path, original); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(original, store.path); err != nil {
		t.Fatal(err)
	}
	if _, err = store.load(); err == nil {
		t.Fatal("followed a credential symlink")
	}
	if _, err = store.save(profiles.Gateways[0]); err == nil {
		t.Fatal("overwrote a credential symlink")
	}
	if err = os.Remove(store.path); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(store.path, []byte("invalid private-token-value"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = store.load(); err == nil || strings.Contains(err.Error(), "private-token-value") {
		t.Fatal("invalid credential file should fail without leaking its contents")
	}
}

func gatewayFixture(t *testing.T, name, token string) (client.Target, *atomic.Int32) {
	t.Helper()
	bad := new(atomic.Int32)
	mux := http.NewServeMux()
	mux.Handle(rpc.OperatorListTagsProcedure, connect.NewUnaryHandler(rpc.OperatorListTagsProcedure, func(ctx context.Context, r *connect.Request[v2.ListTagsRequest]) (*connect.Response[v2.ListTagsResponse], error) {
		if r.Header().Get("Authorization") != "Bearer "+token {
			bad.Add(1)
			return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("untrusted provider error with %s", r.Header().Get("Authorization")))
		}
		return connect.NewResponse(&v2.ListTagsResponse{Tags: []*v2.Tag{{TagId: name, Name: name}}}), nil
	}))
	handleNegotiation(mux)
	server := httptest.NewUnstartedServer(mux)
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	t.Cleanup(server.Close)
	return client.Target{Name: name, URL: server.URL, Token: token}, bad
}

func gatewayTestApp(t *testing.T, targets []client.Target) *app {
	t.Helper()
	connector := func(ctx context.Context, target client.Target) (model, error) {
		c, err := client.NewRuntimeV2(target, "test")
		if err != nil {
			return model{}, err
		}
		return newModel(ctx, c, client.NewFollower(c), nil), nil
	}
	a, err := newApp(t.Context(), connector, targets, 0)
	if err != nil {
		t.Fatal(err)
	}
	a.gatewayStore = profileStore(t)
	t.Cleanup(a.stop)
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 26})
	return a
}

func fillGateway(a *app, target client.Target) {
	a.openGatewayDialog(false)
	for i, value := range []string{target.Name, target.URL, target.Token, target.ServerCAFile, target.ClientCertFile, target.ClientKeyFile} {
		a.gatewayDialog.inputs[i].SetValue(value)
	}
}

func TestRuntimeGatewayAddSwitchAndForgetKeepRostersAndCredentialsIsolated(t *testing.T) {
	alpha, badAlpha := gatewayFixture(t, "alpha-only", "alpha-token")
	beta, badBeta := gatewayFixture(t, "beta-only", "beta-token")
	a := gatewayTestApp(t, []client.Target{alpha})
	runApp(t, a, a.scope(a.inner.tagsCmd()))
	oldContext := a.inner.ctx
	stale := a.scope(a.inner.tagsCmd())()
	a.inner.input.SetValue("unsent on alpha")
	a.Update(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	if !a.choosing || !strings.Contains(appScreen(a), "Gateways") {
		t.Fatal("a single Gateway must offer the manager")
	}
	fillGateway(a, beta)
	if strings.Contains(appScreen(a), beta.Token) {
		t.Fatal("token field leaked into the screen")
	}
	cmd := a.checkGateway()
	if cmd == nil {
		t.Fatal("valid profile must verify")
	}
	_, _ = a.Update(cmd()) // Validation is real HTTP/2; load only the roster below.
	if a.gatewayDialog != nil || a.contexts[a.current] != beta || oldContext.Err() == nil {
		t.Fatal("saving must switch and cancel old calls")
	}
	runApp(t, a, a.scope(a.inner.tagsCmd()))
	if !strings.Contains(appScreen(a), "beta-only") || strings.Contains(appScreen(a), "alpha-only") || a.inner.input.Value() != "" {
		t.Fatal("old roster or draft survived a Gateway switch")
	}
	a.Update(stale)
	if a.inner.tags[0].GetMetadata().GetId() != "beta-only" {
		t.Fatal("stale roster replaced the current Gateway")
	}
	if badAlpha.Load() != 0 || badBeta.Load() != 0 {
		t.Fatal("credentials crossed Gateway origins")
	}
	profiles, err := a.gatewayStore.load()
	if err != nil || profiles.Active != beta.Name {
		t.Fatal("active Gateway was not persisted")
	}
	a.choosing = true
	a.choice = a.current
	a.forgetGateway()
	if !a.hasTarget || a.contexts[a.current] != beta {
		t.Fatal("forget must not abruptly close the active connection")
	}
	a.choice = 0
	a.chooseKey(key(tea.KeyEnter))
	if len(a.contexts) != 1 || a.contexts[0] != alpha {
		t.Fatal("forgotten connection reappeared after switching")
	}
}

func TestEmptyGatewayStartupCanAddAndCancelDoesNotSave(t *testing.T) {
	h, err := startupTargets(nil, gatewayProfiles{Version: 1})
	if err != nil || len(h.Contexts) != 0 || h.Protocol != "runtime.v2" {
		t.Fatal("first launch must open an empty chooser")
	}
	a := gatewayTestApp(t, nil)
	if !strings.Contains(appScreen(a), "Add a Gateway") {
		t.Fatal("empty startup needs an add action")
	}
	target, _ := gatewayFixture(t, "first", "token-secret")
	fillGateway(a, target)
	checked := a.checkGateway()()
	a.gatewayKey(key(tea.KeyEscape))
	a.Update(checked)
	profiles, err := a.gatewayStore.load()
	if err != nil || len(profiles.Gateways) != 0 {
		t.Fatal("cancelled validation saved a credential")
	}
	fillGateway(a, target)
	a.Update(a.checkGateway()())
	if !a.hasTarget || a.contexts[a.current] != target {
		t.Fatal("first verified Gateway did not become active")
	}
	a.editGateway(target)
	a.gatewayDialog.inputs[1].SetValue("https://another.example")
	if a.checkGateway() != nil || !strings.Contains(a.gatewayDialog.note, "different Gateway") {
		t.Fatal("editing URL must not send a prefilled token to a new origin")
	}
	a.closeGatewayDialog()
}

func TestGatewayRefusalDoesNotSaveOrEchoCredential(t *testing.T) {
	target, _ := gatewayFixture(t, "secured", "correct")
	a := gatewayTestApp(t, nil)
	target.Token = "wrong-private-token"
	fillGateway(a, target)
	a.Update(a.checkGateway()())
	if a.hasTarget || a.gatewayDialog == nil || a.gatewayDialog.busy {
		t.Fatal("refused credentials should leave the form open")
	}
	if strings.Contains(appScreen(a), target.Token) {
		t.Fatal("provider error exposed a credential")
	}
	profiles, err := a.gatewayStore.load()
	if err != nil || len(profiles.Gateways) != 0 {
		t.Fatal("failed authentication was saved")
	}
}

func TestGatewaySwitchCancelsInflightRuntimeRequest(t *testing.T) {
	started, stopped := make(chan struct{}), make(chan struct{})
	mux := http.NewServeMux()
	handleNegotiation(mux)
	mux.Handle(rpc.OperatorListTagsProcedure, connect.NewUnaryHandler(rpc.OperatorListTagsProcedure, func(ctx context.Context, _ *connect.Request[v2.ListTagsRequest]) (*connect.Response[v2.ListTagsResponse], error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return nil, ctx.Err()
	}))
	server := httptest.NewUnstartedServer(mux)
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	defer server.Close()
	other, _ := gatewayFixture(t, "other", "other-token")
	a := gatewayTestApp(t, []client.Target{{Name: "blocked", URL: server.URL, Token: "blocked-token"}, other})
	cmd := a.scope(a.inner.tagsCmd())
	result := make(chan tea.Msg, 1)
	go func() { result <- cmd() }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not reach Gateway")
	}
	if err := a.start(1); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("switch did not cancel in-flight Gateway RPC")
	}
	select {
	case msg := <-result:
		a.Update(msg)
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled command did not return")
	}
	if a.inner.tagsErr != nil {
		t.Fatal("old Gateway cancellation poisoned the new model")
	}
}

func TestSavedGatewaysAcceptWebSocketTunnelURLs(t *testing.T) {
	for _, url := range []string{"wss://gateway.example", "wss://gateway.example:8443/supertag", "ws://127.0.0.1:7001/tunnel", "ws://[::1]:7001"} {
		if err := validateSavedGateway(client.Target{Name: "tunnel", URL: url, Token: "credential"}); err != nil {
			t.Errorf("%s: %v", url, err)
		}
	}
	tls := client.Target{Name: "tunnel", URL: "wss://gateway.example/supertag", Token: "credential", ServerCAFile: "/ca.pem", ClientCertFile: "/c.pem", ClientKeyFile: "/c.key"}
	if err := validateSavedGateway(tls); err != nil {
		t.Errorf("wss with TLS files: %v", err)
	}
	for _, target := range []client.Target{
		{Name: "tunnel", URL: "ws://gateway.example", Token: "credential"},
		{Name: "tunnel", URL: "ws://localhost:7001", Token: "credential"},
		{Name: "tunnel", URL: "ws://127.0.0.1:7001", Token: "credential", ServerCAFile: "/ca.pem"},
		{Name: "tunnel", URL: "wss://user:secret@gateway.example", Token: "credential"},
		{Name: "tunnel", URL: "wss://gateway.example/?token=secret", Token: "credential"},
		{Name: "tunnel", URL: "wss://gateway.example/#secret", Token: "credential"},
		{Name: "tunnel", URL: "https://gateway.example/path", Token: "credential"},
	} {
		if validateSavedGateway(target) == nil {
			t.Errorf("accepted %s", target.URL)
		}
	}
	for raw, want := range map[string]string{
		"WSS://Gateway.Example:443/":          "wss://gateway.example",
		"wss://gateway.example:8443/Supertag": "wss://gateway.example:8443/Supertag",
		"ws://127.0.0.1:80/tunnel/":           "ws://127.0.0.1/tunnel/",
		"https://Gateway.Example:443/":        "https://gateway.example",
	} {
		if got := gatewayOrigin(raw); got != want {
			t.Errorf("gatewayOrigin(%q) = %q, want %q", raw, got, want)
		}
	}
}
