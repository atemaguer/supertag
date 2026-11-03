// An independent wire conformance peer, deliberately not a production Worklet or SDK.
// It loads descriptors compiled from the repository's published .proto contract.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

type object = map[string]any

type attempt struct {
	TaskID    string            `json:"taskId"`
	ID        string            `json:"attemptId"`
	Digest    string            `json:"specDigest"`
	Status    string            `json:"status"`
	Events    []object          `json:"events"`
	Controls  map[string]object `json:"controls"`
	Cancelled bool              `json:"cancelled"`
}
type state struct {
	Attempts    map[string]*attempt `json:"attempts"`
	Acceptances int                 `json:"acceptances"`
}
type reservation struct {
	ID        string
	ExpiresAt string
	WorkerID  string
	ProfileID string
	Revision  string
}
type peer struct {
	files        *protoregistry.Files
	state        state
	statePath    string
	host         string
	protocol     int
	send         func(object) error
	watchers     map[string]watcher
	reservations map[string]reservation
}
type watcher struct {
	AttemptID string
	After     int
}

func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		panic("Missing " + name)
	}
	return value
}
func (p *peer) message(name string) *dynamicpb.Message {
	descriptor, err := p.files.FindDescriptorByName(protoreflect.FullName("supertag.worklet.v1." + name))
	if err != nil {
		panic(err)
	}
	return dynamicpb.NewMessage(descriptor.(protoreflect.MessageDescriptor))
}
func field(message protoreflect.Message, name string) protoreflect.Value {
	return message.Get(message.Descriptor().Fields().ByName(protoreflect.Name(name)))
}
func has(message protoreflect.Message, name string) bool {
	return message.Has(message.Descriptor().Fields().ByName(protoreflect.Name(name)))
}
func str(message protoreflect.Message, name string) string { return field(message, name).String() }
func (p *peer) save() error {
	bytes, err := json.Marshal(p.state)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(p.statePath), "state-")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err = temporary.Chmod(0600); err == nil {
		_, err = temporary.Write(bytes)
	}
	if err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(name, p.statePath); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(p.statePath))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
func capability() object {
	return object{"version": 1, "operations": []string{"input", "interrupt"}, "inputMode": "queue"}
}
func receipt(a *attempt) object {
	return object{"taskId": a.TaskID, "attemptId": a.ID, "specDigest": a.Digest, "status": a.Status, "workerId": "go-worker", "lastSequence": len(a.Events), "cancellationRequested": a.Cancelled, "control": capability()}
}
func (p *peer) reply(id string, result object) error {
	result["requestId"] = id
	return p.send(object{"reply": result})
}
func document(message protoreflect.Message, name string) (object, error) {
	doc := field(message, name).Message()
	if field(doc, "version").Uint() != 1 {
		return nil, errors.New("Unsupported schema document")
	}
	bytes := field(doc, "json").Bytes()
	if len(bytes) > 3*1024*1024 {
		return nil, errors.New("Oversized schema document")
	}
	var value object
	if err := json.Unmarshal(bytes, &value); err != nil {
		return nil, err
	}
	return value, nil
}
func (p *peer) selectPlacement(id string, command protoreflect.Message) error {
	requirements, err := document(command, "execution_requirements")
	if err != nil {
		return p.reply(id, object{"error": err.Error()})
	}
	if _, err = document(command, "context_plan"); err != nil {
		return p.reply(id, object{"error": err.Error()})
	}
	options := field(command, "options").Message()
	if has(options, "allowed_worker_host_ids") {
		ids := field(field(options, "allowed_worker_host_ids").Message(), "ids").List()
		eligible := false
		for i := 0; i < ids.Len(); i++ {
			if ids.Get(i).String() == p.host {
				eligible = true
			}
		}
		if !eligible {
			return p.reply(id, object{"noPlacement": object{}})
		}
	}
	profileID, revision := "go-conformance", "1"
	if value, ok := requirements["profile"].(map[string]any); ok {
		if value["id"] != profileID || value["revision"] != revision {
			return p.reply(id, object{"noPlacement": object{}})
		}
	}
	if has(options, "compatible_profile") {
		compatible := field(options, "compatible_profile").Message()
		if str(compatible, "id") != profileID || str(compatible, "revision") != revision {
			return p.reply(id, object{"noPlacement": object{}})
		}
	}
	if len(p.reservations) >= 1 {
		return p.reply(id, object{"noPlacement": object{}})
	}
	now := time.Now().UTC()
	entry := reservation{
		ID: fmt.Sprintf("go-reservation-%d", now.UnixNano()), ExpiresAt: now.Add(30 * time.Second).Format(time.RFC3339Nano),
		WorkerID: "go-worker", ProfileID: profileID, Revision: revision,
	}
	p.reservations[entry.ID] = entry
	return p.reply(id, object{"placement": object{
		"workerHostId": p.host, "workletId": p.host, "workerId": entry.WorkerID,
		"workerProfile": object{"id": entry.ProfileID, "revision": entry.Revision},
		"reservation":   object{"id": entry.ID, "expiresAt": entry.ExpiresAt},
	}})
}
func (p *peer) releasePlacement(id string, command protoreflect.Message) error {
	placement := field(command, "placement").Message()
	released := false
	if has(placement, "reservation") {
		wire := field(placement, "reservation").Message()
		reservationID := str(wire, "id")
		if entry, ok := p.reservations[reservationID]; ok &&
			entry.ExpiresAt == str(wire, "expires_at") &&
			str(placement, "worker_host_id") == p.host &&
			str(placement, "worklet_id") == p.host &&
			str(placement, "worker_id") == entry.WorkerID {
			profile := field(placement, "worker_profile").Message()
			if str(profile, "id") == entry.ProfileID && str(profile, "revision") == entry.Revision {
				delete(p.reservations, reservationID)
				released = true
			}
		}
	}
	return p.reply(id, object{"placementRelease": object{"released": released}})
}
func (p *peer) consumeReservation(decoded object) error {
	placement, ok := decoded["placement"].(map[string]any)
	if !ok || placement["workerHostId"] != p.host || placement["workletId"] != p.host || placement["workerId"] != "go-worker" {
		return errors.New("Missing or mismatched placement")
	}
	profile, profileOK := decoded["workerProfile"].(map[string]any)
	reservationValue, reservationOK := placement["reservation"].(map[string]any)
	if !profileOK || !reservationOK {
		return errors.New("Missing placement reservation")
	}
	reservationID, _ := reservationValue["id"].(string)
	entry, exists := p.reservations[reservationID]
	if !exists || reservationValue["expiresAt"] != entry.ExpiresAt || time.Now().UTC().After(mustTime(entry.ExpiresAt)) ||
		profile["id"] != entry.ProfileID || profile["revision"] != entry.Revision {
		return errors.New("Invalid placement reservation")
	}
	delete(p.reservations, reservationID)
	return nil
}
func mustTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		panic(err)
	}
	return parsed
}
func (p *peer) record(a *attempt, kind string, extra object) {
	event := object{"taskId": a.TaskID, "attemptId": a.ID, "type": kind, "at": time.Now().UTC().Format(time.RFC3339Nano)}
	for key, value := range extra {
		event[key] = value
	}
	a.Events = append(a.Events, event)
}
func (p *peer) flush() error {
	for id, w := range p.watchers {
		a := p.state.Attempts[w.AttemptID]
		if a == nil {
			continue
		}
		for w.After < len(a.Events) {
			event := a.Events[w.After]
			payload, err := json.Marshal(event)
			if err != nil {
				return err
			}
			w.After++
			if err = p.send(object{"event": object{"requestId": id, "sequence": w.After, "taskId": a.TaskID, "attemptId": a.ID, "kind": event["type"], "at": event["at"], "taskAttemptEvent": object{"version": 1, "json": payload}}}); err != nil {
				return err
			}
		}
		p.watchers[id] = w
		if a.Status != "ATTEMPT_STATUS_RUNNING" {
			if err := p.send(object{"end": object{"requestId": id}}); err != nil {
				return err
			}
			delete(p.watchers, id)
		}
	}
	return nil
}
func (p *peer) handle(frame protoreflect.Message) error {
	if field(frame, "wire_version").Uint() != 1 {
		return errors.New("Unsupported wire version")
	}
	if has(frame, "ready") {
		ready := field(frame, "ready").Message()
		if field(ready, "protocol_version").Uint() != uint64(p.protocol) {
			return errors.New("Unsupported protocol")
		}
		fmt.Printf("{\"connectedGeneration\":%d}\n", field(ready, "connection_generation").Uint())
		return nil
	}
	if has(frame, "heartbeat_ack") {
		return nil
	}
	if has(frame, "close") {
		c := field(frame, "close").Message()
		code := field(c, "code").Uint()
		if code >= 4001 && code <= 4008 {
			return fmt.Errorf("permanent:%d:%s", code, str(c, "reason"))
		}
		return io.EOF
	}
	if has(frame, "error") {
		return fmt.Errorf("protocol:%s", str(field(frame, "error").Message(), "message"))
	}
	for _, kind := range []string{"select_placement", "release_placement", "accept", "inspect", "events", "unsubscribe", "cancel", "control", "control_capabilities"} {
		if !has(frame, kind) {
			continue
		}
		command := field(frame, kind).Message()
		id := str(command, "request_id")
		if kind == "unsubscribe" {
			delete(p.watchers, id)
			return nil
		}
		if kind == "select_placement" {
			return p.selectPlacement(id, command)
		}
		if kind == "release_placement" {
			return p.releasePlacement(id, command)
		}
		if kind == "accept" {
			spec := field(command, "spec").Message()
			document := field(spec, "task_attempt_spec").Message()
			if field(document, "version").Uint() != 1 {
				return p.reply(id, object{"error": "Unsupported specification document"})
			}
			bytes := field(document, "json").Bytes()
			if len(bytes) > 3*1024*1024 {
				return p.reply(id, object{"error": "Oversized specification document"})
			}
			hash := sha256.Sum256(bytes)
			digest := hex.EncodeToString(hash[:])
			var decoded object
			if err := json.Unmarshal(bytes, &decoded); err != nil {
				return err
			}
			taskID, attemptID := str(spec, "task_id"), str(spec, "attempt_id")
			if digest != str(spec, "payload_sha256") || decoded["taskId"] != taskID || decoded["attemptId"] != attemptID {
				return p.reply(id, object{"error": "Specification identity mismatch"})
			}
			a := p.state.Attempts[attemptID]
			if a == nil {
				if err := p.consumeReservation(decoded); err != nil {
					return p.reply(id, object{"error": err.Error()})
				}
				a = &attempt{TaskID: taskID, ID: attemptID, Digest: digest, Status: "ATTEMPT_STATUS_RUNNING", Controls: map[string]object{}}
				p.state.Attempts[attemptID] = a
				p.state.Acceptances++
				p.record(a, "execution.started", object{"workerId": "go-worker"})
				if err := p.save(); err != nil {
					return err
				}
			} else if a.Digest != digest {
				return p.reply(id, object{"error": "Conflicting accepted Attempt"})
			}
			return p.reply(id, object{"receipt": receipt(a)})
		}
		attemptID := str(command, "attempt_id")
		a := p.state.Attempts[attemptID]
		if a == nil {
			return p.reply(id, object{"absent": object{}})
		}
		switch kind {
		case "inspect":
			return p.reply(id, object{"receipt": receipt(a)})
		case "events":
			after := int(field(command, "after_sequence").Uint())
			if after < 0 || after > len(a.Events) {
				return p.send(object{"end": object{"requestId": id, "error": "Invalid cursor"}})
			}
			p.watchers[id] = watcher{attemptID, after}
			return p.flush()
		case "control_capabilities":
			return p.reply(id, object{"capabilities": capability()})
		case "cancel":
			if a.Status == "ATTEMPT_STATUS_RUNNING" {
				a.Cancelled = true
				a.Status = "ATTEMPT_STATUS_CANCELLED"
				p.record(a, "execution.failed", object{"error": object{"name": "Cancelled", "message": "Conformance cancellation"}})
				if err := p.save(); err != nil {
					return err
				}
			}
			if err := p.reply(id, object{"receipt": receipt(a)}); err != nil {
				return err
			}
			return p.flush()
		case "control":
			commandID := str(command, "id")
			if prior := a.Controls[commandID]; prior != nil {
				return p.reply(id, object{"control": prior})
			}
			acknowledgement := object{"id": commandID, "taskId": str(command, "task_id"), "attemptId": attemptID, "status": "accepted"}
			if str(command, "task_id") != a.TaskID || a.Status != "ATTEMPT_STATUS_RUNNING" {
				acknowledgement["status"] = "rejected"
			} else if has(command, "input") {
				p.record(a, "output.delta", object{"text": str(field(command, "input").Message(), "text")})
			} else if has(command, "interrupt") {
				a.Status = "ATTEMPT_STATUS_COMPLETED"
				p.record(a, "execution.completed", object{})
			} else {
				acknowledgement["status"] = "rejected"
			}
			a.Controls[commandID] = acknowledgement
			if err := p.save(); err != nil {
				return err
			}
			if err := p.reply(id, object{"control": acknowledgement}); err != nil {
				return err
			}
			return p.flush()
		}
	}
	return errors.New("Unknown required frame")
}
func (p *peer) connect(ctx context.Context, client *grpc.ClientConn, token, host string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := client.NewStream(metadata.NewOutgoingContext(ctx, metadata.Pairs("authorization", "Bearer "+token)), &grpc.StreamDesc{ServerStreams: true, ClientStreams: true}, "/supertag.worklet.v1.WorkletService/Connect")
	if err != nil {
		return err
	}
	var mutex sync.Mutex
	p.send = func(value object) error {
		value["wireVersion"] = 1
		bytes, err := json.Marshal(value)
		if err != nil {
			return err
		}
		message := p.message("ConnectRequest")
		if err = protojson.Unmarshal(bytes, message); err != nil {
			return err
		}
		mutex.Lock()
		defer mutex.Unlock()
		return stream.SendMsg(message)
	}
	p.watchers = map[string]watcher{}
	if err = p.send(object{"hello": object{"protocolVersions": []int{p.protocol}, "workletId": host, "workerHostId": host, "descriptorVersion": 1, "durableProtocolVersion": 1, "controlProtocolVersion": 1, "workers": []object{{"id": "go-worker", "type": "conformance", "capabilities": []object{{"id": "supertag.task-attempt.events", "version": 1}}, "profiles": []object{{"id": "go-conformance", "revision": "1"}}, "contextTypes": []object{}, "profileCapabilities": object{"entries": []object{{"profile": object{"id": "go-conformance", "revision": "1"}, "capabilities": []object{{"id": "supertag.task-attempt.events", "version": 1}}, "contextTypes": []object{}}}}, "maxConcurrency": 1}}}}); err != nil {
		return err
	}
	heartbeatStarted := false
	for {
		message := p.message("ConnectResponse")
		if err = stream.RecvMsg(message); err != nil {
			return err
		}
		if err = p.handle(message.ProtoReflect()); err != nil {
			return err
		}
		if has(message.ProtoReflect(), "ready") && !heartbeatStarted {
			heartbeatStarted = true
			ready := field(message.ProtoReflect(), "ready").Message()
			interval := field(ready, "heartbeat_interval_ms").Uint()
			if interval == 0 {
				return errors.New("Invalid heartbeat interval")
			}
			send := p.send
			go func() {
				ticker := time.NewTicker(time.Duration(interval) * time.Millisecond)
				defer ticker.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-ticker.C:
						if send(object{"heartbeat": object{"at": time.Now().UTC().Format(time.RFC3339Nano)}}) != nil {
							return
						}
					}
				}
			}()
		}
	}
}
func main() {
	descriptorBytes, err := os.ReadFile(required("SUPERTAG_CONFORMANCE_DESCRIPTOR"))
	if err != nil {
		panic(err)
	}
	descriptors := &descriptorpb.FileDescriptorSet{}
	if err = proto.Unmarshal(descriptorBytes, descriptors); err != nil {
		panic(err)
	}
	files, err := protodesc.NewFiles(descriptors)
	if err != nil {
		panic(err)
	}
	cert, err := os.ReadFile(required("SUPERTAG_CONFORMANCE_CA"))
	if err != nil {
		panic(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(cert) {
		panic("Invalid CA")
	}
	client, err := grpc.NewClient(required("SUPERTAG_CONFORMANCE_ENDPOINT"), grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12})), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(4*1024*1024), grpc.MaxCallSendMsgSize(4*1024*1024)))
	if err != nil {
		panic(err)
	}
	defer client.Close()
	protocol, err := strconv.Atoi(required("SUPERTAG_CONFORMANCE_PROTOCOL"))
	if err != nil || protocol != 18 {
		panic("Invalid conformance protocol")
	}
	host := required("SUPERTAG_CONFORMANCE_HOST")
	p := &peer{files: files, statePath: required("SUPERTAG_CONFORMANCE_STATE"), host: host, protocol: protocol, reservations: map[string]reservation{}, state: state{Attempts: map[string]*attempt{}}}
	changedPathsFixture := p.message("Heartbeat")
	if err := protojson.Unmarshal([]byte(`{"at":"2026-10-07T00:00:00Z","changedPaths":[{"attemptId":"attempt-1","paths":["src/old.ts","src/new.ts"],"truncated":true}]}`), changedPathsFixture); err != nil {
		panic(err)
	}
	changedPathsWire, err := proto.Marshal(changedPathsFixture)
	if err != nil {
		panic(err)
	}
	changedPathsDecoded := p.message("Heartbeat")
	if err := proto.Unmarshal(changedPathsWire, changedPathsDecoded); err != nil {
		panic(err)
	}
	change := field(changedPathsDecoded.ProtoReflect(), "changed_paths").List().Get(0).Message()
	if str(change, "attempt_id") != "attempt-1" || field(change, "paths").List().Len() != 2 || !field(change, "truncated").Bool() {
		panic("Changed-path heartbeat fixture did not round-trip")
	}
	if bytes, err := os.ReadFile(p.statePath); err == nil {
		if err = json.Unmarshal(bytes, &p.state); err != nil {
			panic(err)
		}
	} else if !os.IsNotExist(err) {
		panic(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	token := required("SUPERTAG_CONFORMANCE_CREDENTIAL")
	for ctx.Err() == nil {
		err = p.connect(ctx, client, token, host)
		if err != nil && len(err.Error()) >= 10 && err.Error()[:10] == "permanent:" {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(3)
		}
		if ctx.Err() != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}
