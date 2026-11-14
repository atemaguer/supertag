package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
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

func profileStore(t *testing.T) *controlPlaneStore {
	t.Helper()
	return &controlPlaneStore{filepath.Join(t.TempDir(), "private", "tui-control-planes.json")}
}

func TestSavedControlPlanesReopenRotateAndPreserveLaunchCredentials(t *testing.T) {
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
	if len(profiles.ControlPlanes) != 2 || profiles.ControlPlanes[1] != second {
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
		t.Fatal("saved-only startup did not reopen the selected Control Plane")
	}
	rotated := first
	rotated.Token = "replacement-token"
	if _, err = store.save(rotated); err != nil {
		t.Fatal(err)
	}
	profiles, err = store.load()
	if err != nil || len(profiles.ControlPlanes) != 2 || profiles.ControlPlanes[0] != rotated {
		t.Fatal("credential rotation did not replace exactly one saved profile")
	}
	foreign := rotated
	foreign.URL = second.URL
	if _, err = store.save(foreign); err == nil {
		t.Fatal("a saved name must not move its credential to another origin")
	}
	merged := mergeControlPlanes([]client.Target{first}, profiles.ControlPlanes)
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
	if err != nil || len(profiles.ControlPlanes) != 1 || profiles.ControlPlanes[0] != second {
		t.Fatal("forget removed another Control Plane")
	}
}

func TestSavedControlPlaneStorageRejectsUnsafeFilesAndHasNoSmallProfileCap(t *testing.T) {
	store := profileStore(t)
	for i := 0; i < 40; i++ {
		if _, err := store.save(client.Target{Name: fmt.Sprintf("gateway-%d", i), URL: fmt.Sprintf("https://gateway-%d.example", i), Token: "credential"}); err != nil {
			t.Fatal(err)
		}
	}
	profiles, err := store.load()
	if err != nil || len(profiles.ControlPlanes) != 40 {
		t.Fatal("all configured Control Planes should be retained")
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
	if _, err = store.save(profiles.ControlPlanes[0]); err == nil {
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

func controlPlaneFixture(t *testing.T, name, token string) (client.Target, *atomic.Int32) {
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
	mux.Handle(rpc.EnrollmentsWhoAmIProcedure, connect.NewUnaryHandler(rpc.EnrollmentsWhoAmIProcedure, func(ctx context.Context, r *connect.Request[v2.WhoAmIRequest]) (*connect.Response[v2.WhoAmIResponse], error) {
		if r.Header().Get("Authorization") != "Bearer "+token {
			bad.Add(1)
			return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("untrusted provider error with %s", r.Header().Get("Authorization")))
		}
		return connect.NewResponse(&v2.WhoAmIResponse{Role: v2.PrincipalRole_PRINCIPAL_ROLE_OPERATOR, Principal: "operator:local", Admin: true}), nil
	}))
	handleNegotiation(mux)
	server := httptest.NewUnstartedServer(mux)
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	t.Cleanup(server.Close)
	return client.Target{Name: name, URL: server.URL, Token: token}, bad
}

// A pasted client Auth Key enrolls this device once and only the enrolled credential is saved;
// the device then sees no Worker Host status.
func TestAddingAControlPlaneWithAnAuthKeyEnrollsThisDeviceAndSavesOnlyItsCredential(t *testing.T) {
	key := "stak_" + strings.Repeat("ab", 32)
	var credential atomic.Value
	var enrolledName atomic.Value
	mux := http.NewServeMux()
	handleNegotiation(mux)
	mux.Handle(rpc.EnrollmentsEnrollProcedure, connect.NewUnaryHandler(rpc.EnrollmentsEnrollProcedure, func(ctx context.Context, r *connect.Request[v2.EnrollRequest]) (*connect.Response[v2.Enrollment], error) {
		if r.Header().Get("Authorization") != "Bearer "+key || r.Msg.GetRole() != v2.PrincipalRole_PRINCIPAL_ROLE_CLIENT || len(r.Msg.GetTokenDigest()) != 32 {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("refused"))
		}
		enrolledName.Store(r.Msg.GetName())
		credential.Store(r.Msg.GetTokenDigest())
		return connect.NewResponse(&v2.Enrollment{Role: v2.PrincipalRole_PRINCIPAL_ROLE_CLIENT, Name: r.Msg.GetName(), Principal: "client:" + r.Msg.GetName(), CredentialRevision: 1}), nil
	}))
	mux.Handle(rpc.EnrollmentsWhoAmIProcedure, connect.NewUnaryHandler(rpc.EnrollmentsWhoAmIProcedure, func(ctx context.Context, r *connect.Request[v2.WhoAmIRequest]) (*connect.Response[v2.WhoAmIResponse], error) {
		presented := strings.TrimPrefix(r.Header().Get("Authorization"), "Bearer ")
		digest := sha256.Sum256([]byte(presented))
		if want, _ := credential.Load().([]byte); !client.IsClientCredential(presented) || string(want) != string(digest[:]) {
			return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("valid bearer credential required"))
		}
		return connect.NewResponse(&v2.WhoAmIResponse{Role: v2.PrincipalRole_PRINCIPAL_ROLE_CLIENT, Principal: "client:" + enrolledName.Load().(string)}), nil
	}))
	mux.Handle(rpc.OperatorListHostsProcedure, connect.NewUnaryHandler(rpc.OperatorListHostsProcedure, func(ctx context.Context, r *connect.Request[v2.ListHostsRequest]) (*connect.Response[v2.ListHostsResponse], error) {
		t.Error("a client device read Worker Host status")
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("refused"))
	}))
	server := httptest.NewUnstartedServer(mux)
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	defer server.Close()

	a := controlPlaneTestApp(t, nil)
	fillControlPlane(a, client.Target{Name: "work", URL: server.URL, Token: key})
	_, verify := a.Update(a.checkControlPlane()())
	if a.controlPlaneDialog == nil || !strings.Contains(a.controlPlaneDialog.note, "Connected as client:"+client.DeviceName()) {
		t.Fatal("the dialog did not say which client this device joined as")
	}
	if a.controlPlaneDialog.inputs[2].Value() == key || verify == nil {
		t.Fatal("the Auth Key stayed in the credential field")
	}
	a.Update(verify())
	profiles, err := a.controlPlaneStore.load()
	if err != nil || len(profiles.ControlPlanes) != 1 {
		t.Fatal("the enrolled connection was not saved")
	}
	if saved := profiles.ControlPlanes[0].Token; saved == key || !client.IsClientCredential(saved) {
		t.Fatal("only the enrolled client credential may be saved")
	}
	if !a.hasTarget || a.inner.reloadHosts() != nil {
		t.Fatal("a client device must not read Worker Host status")
	}
}

func controlPlaneTestApp(t *testing.T, targets []client.Target) *app {
	t.Helper()
	connector := func(ctx context.Context, target client.Target) (model, error) {
		c, err := client.New(target, "test")
		if err != nil {
			return model{}, err
		}
		return newModel(ctx, c, client.NewFollower(c), nil), nil
	}
	a, err := newApp(t.Context(), connector, targets, 0)
	if err != nil {
		t.Fatal(err)
	}
	a.controlPlaneStore = profileStore(t)
	t.Cleanup(a.stop)
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 26})
	return a
}

func fillControlPlane(a *app, target client.Target) {
	a.openControlPlaneDialog(false)
	for i, value := range []string{target.Name, target.URL, target.Token, target.ServerCAFile, target.ClientCertFile, target.ClientKeyFile} {
		a.controlPlaneDialog.inputs[i].SetValue(value)
	}
}

func TestRuntimeControlPlaneAddSwitchAndForgetKeepRostersAndCredentialsIsolated(t *testing.T) {
	alpha, badAlpha := controlPlaneFixture(t, "alpha-only", "alpha-token")
	beta, badBeta := controlPlaneFixture(t, "beta-only", "beta-token")
	a := controlPlaneTestApp(t, []client.Target{alpha})
	runApp(t, a, a.scope(a.inner.tagsCmd()))
	oldContext := a.inner.ctx
	stale := a.scope(a.inner.tagsCmd())()
	a.inner.input.SetValue("unsent on alpha")
	a.Update(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	if !a.choosing || !strings.Contains(appScreen(a), "Control Planes") {
		t.Fatal("a single Control Plane must offer the manager")
	}
	fillControlPlane(a, beta)
	if strings.Contains(appScreen(a), beta.Token) {
		t.Fatal("token field leaked into the screen")
	}
	cmd := a.checkControlPlane()
	if cmd == nil {
		t.Fatal("valid profile must verify")
	}
	_, _ = a.Update(cmd()) // Validation is real HTTP/2; load only the roster below.
	if a.controlPlaneDialog != nil || a.contexts[a.current] != beta || oldContext.Err() == nil {
		t.Fatal("saving must switch and cancel old calls")
	}
	runApp(t, a, a.scope(a.inner.tagsCmd()))
	if !strings.Contains(appScreen(a), "beta-only") || strings.Contains(appScreen(a), "alpha-only") || a.inner.input.Value() != "" {
		t.Fatal("old roster or draft survived a Control Plane switch")
	}
	a.Update(stale)
	if a.inner.tags[0].GetMetadata().GetId() != "beta-only" {
		t.Fatal("stale roster replaced the current Control Plane")
	}
	if badAlpha.Load() != 0 || badBeta.Load() != 0 {
		t.Fatal("credentials crossed Control Plane origins")
	}
	profiles, err := a.controlPlaneStore.load()
	if err != nil || profiles.Active != beta.Name {
		t.Fatal("active Control Plane was not persisted")
	}
	a.choosing = true
	a.choice = a.current
	a.forgetControlPlane()
	if !a.hasTarget || a.contexts[a.current] != beta {
		t.Fatal("forget must not abruptly close the active connection")
	}
	a.choice = 0
	a.chooseKey(key(tea.KeyEnter))
	if len(a.contexts) != 1 || a.contexts[0] != alpha {
		t.Fatal("forgotten connection reappeared after switching")
	}
}

func TestEmptyControlPlaneStartupCanAddAndCancelDoesNotSave(t *testing.T) {
	h, err := startupTargets(nil, controlPlaneProfiles{Version: 1})
	if err != nil || len(h.Contexts) != 0 || h.Protocol != "runtime.v2" {
		t.Fatal("first launch must open an empty chooser")
	}
	a := controlPlaneTestApp(t, nil)
	if !strings.Contains(appScreen(a), "Add a Control Plane") {
		t.Fatal("empty startup needs an add action")
	}
	target, _ := controlPlaneFixture(t, "first", "token-secret")
	fillControlPlane(a, target)
	checked := a.checkControlPlane()()
	a.controlPlaneKey(key(tea.KeyEscape))
	a.Update(checked)
	profiles, err := a.controlPlaneStore.load()
	if err != nil || len(profiles.ControlPlanes) != 0 {
		t.Fatal("cancelled validation saved a credential")
	}
	fillControlPlane(a, target)
	a.Update(a.checkControlPlane()())
	if !a.hasTarget || a.contexts[a.current] != target {
		t.Fatal("first verified Control Plane did not become active")
	}
	a.editControlPlane(target)
	a.controlPlaneDialog.inputs[1].SetValue("https://another.example")
	if a.checkControlPlane() != nil || !strings.Contains(a.controlPlaneDialog.note, "different Control Plane") {
		t.Fatal("editing URL must not send a prefilled token to a new origin")
	}
	a.closeControlPlaneDialog()
}

func TestControlPlaneRefusalDoesNotSaveOrEchoCredential(t *testing.T) {
	target, _ := controlPlaneFixture(t, "secured", "correct")
	a := controlPlaneTestApp(t, nil)
	target.Token = "wrong-private-token"
	fillControlPlane(a, target)
	a.Update(a.checkControlPlane()())
	if a.hasTarget || a.controlPlaneDialog == nil || a.controlPlaneDialog.busy {
		t.Fatal("refused credentials should leave the form open")
	}
	if strings.Contains(appScreen(a), target.Token) {
		t.Fatal("provider error exposed a credential")
	}
	profiles, err := a.controlPlaneStore.load()
	if err != nil || len(profiles.ControlPlanes) != 0 {
		t.Fatal("failed authentication was saved")
	}
}

func TestControlPlaneSwitchCancelsInflightRuntimeRequest(t *testing.T) {
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
	other, _ := controlPlaneFixture(t, "other", "other-token")
	a := controlPlaneTestApp(t, []client.Target{{Name: "blocked", URL: server.URL, Token: "blocked-token"}, other})
	cmd := a.scope(a.inner.tagsCmd())
	result := make(chan tea.Msg, 1)
	go func() { result <- cmd() }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not reach Control Plane")
	}
	if err := a.start(1); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("switch did not cancel in-flight Control Plane RPC")
	}
	select {
	case msg := <-result:
		a.Update(msg)
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled command did not return")
	}
	if a.inner.tagsErr != nil {
		t.Fatal("old Control Plane cancellation poisoned the new model")
	}
}

func TestSavedControlPlanesAcceptWebSocketTunnelURLs(t *testing.T) {
	for _, url := range []string{"wss://cp.example", "wss://cp.example:8443/supertag", "ws://127.0.0.1:7001/tunnel", "ws://[::1]:7001"} {
		if err := validateSavedControlPlane(client.Target{Name: "tunnel", URL: url, Token: "credential"}); err != nil {
			t.Errorf("%s: %v", url, err)
		}
	}
	tls := client.Target{Name: "tunnel", URL: "wss://cp.example/supertag", Token: "credential", ServerCAFile: "/ca.pem", ClientCertFile: "/c.pem", ClientKeyFile: "/c.key"}
	if err := validateSavedControlPlane(tls); err != nil {
		t.Errorf("wss with TLS files: %v", err)
	}
	for _, target := range []client.Target{
		{Name: "tunnel", URL: "ws://cp.example", Token: "credential"},
		{Name: "tunnel", URL: "ws://localhost:7001", Token: "credential"},
		{Name: "tunnel", URL: "ws://127.0.0.1:7001", Token: "credential", ServerCAFile: "/ca.pem"},
		{Name: "tunnel", URL: "wss://user:secret@cp.example", Token: "credential"},
		{Name: "tunnel", URL: "wss://cp.example/?token=secret", Token: "credential"},
		{Name: "tunnel", URL: "wss://cp.example/#secret", Token: "credential"},
		{Name: "tunnel", URL: "https://cp.example/path", Token: "credential"},
		{Name: "tunnel", URL: "wss://cp.example/a/../supertag", Token: "credential"},
		{Name: "tunnel", URL: "wss://cp.example/./supertag", Token: "credential"},
		{Name: "tunnel", URL: "wss://cp.example/a/%2E%2e/supertag", Token: "credential"},
		{Name: "tunnel", URL: `wss://cp.example/a\supertag`, Token: "credential"},
	} {
		if validateSavedControlPlane(target) == nil {
			t.Errorf("accepted %s", target.URL)
		}
	}
	for raw, want := range map[string]string{
		"WSS://Cp.Example:443/":          "wss://cp.example",
		"wss://cp.example:8443/Supertag": "wss://cp.example:8443/Supertag",
		"ws://127.0.0.1:80/tunnel/":      "ws://127.0.0.1/tunnel/",
		"https://Cp.Example:443/":        "https://cp.example",
	} {
		if got := controlPlaneOrigin(raw); got != want {
			t.Errorf("controlPlaneOrigin(%q) = %q, want %q", raw, got, want)
		}
	}
}
