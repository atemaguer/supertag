package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"golang.org/x/sys/unix"

	"github.com/atemaguer/supertag/apps/tui/client"
)

// Gateway credentials remain in this native, owner-only store. It is deliberately separate
// from both the legacy CLI credential vault and the local runtime's service credentials.
type gatewayStore struct{ path string }
type gatewayProfiles struct {
	Version  int             `json:"version"`
	Active   string          `json:"active,omitempty"`
	Gateways []client.Target `json:"gateways"`
}

func defaultGatewayStore() (*gatewayStore, error) {
	directory, err := os.UserConfigDir()
	if err != nil {
		return nil, errors.New("could not locate the saved Gateway directory")
	}
	return &gatewayStore{filepath.Join(directory, "supertag", "tui-gateways.json")}, nil
}

func privateGatewayFile(path string, flags int) (*os.File, error) {
	fd, err := unix.Open(path, flags|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		f.Close()
		return nil, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != uint32(os.Geteuid()) || stat.Mode&0077 != 0 || stat.Nlink != 1 {
		f.Close()
		return nil, errors.New("saved Gateway files must be private regular files owned by this user")
	}
	return f, nil
}

func (s *gatewayStore) directory(create bool) error {
	directory := filepath.Dir(s.path)
	if create {
		if err := os.MkdirAll(directory, 0700); err != nil {
			return errors.New("could not create the saved Gateway directory")
		}
	}
	var stat unix.Stat_t
	if err := unix.Lstat(directory, &stat); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR || stat.Uid != uint32(os.Geteuid()) || stat.Mode&0077 != 0 {
		return errors.New("saved Gateway directory must be private and owned by this user")
	}
	return nil
}

func (s *gatewayStore) load() (gatewayProfiles, error) {
	empty := gatewayProfiles{Version: 1}
	if err := s.directory(false); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return empty, nil
		}
		return empty, err
	}
	f, err := privateGatewayFile(s.path, unix.O_RDONLY)
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return empty, errors.New("could not safely read saved Gateways")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return empty, errors.New("saved Gateway file is unreadable or too large")
	}
	var profiles gatewayProfiles
	if json.Unmarshal(data, &profiles) != nil || profiles.Version != 1 {
		return empty, errors.New("saved Gateway file has an unsupported format")
	}
	seen := map[string]bool{}
	for _, target := range profiles.Gateways {
		if validateSavedGateway(target) != nil || seen[target.Name] {
			return empty, errors.New("saved Gateway file contains invalid connections")
		}
		seen[target.Name] = true
	}
	return profiles, nil
}

func validateSavedGateway(target client.Target) error {
	if strings.TrimSpace(target.Name) == "" || len(target.Name) > 64 || strings.ContainsFunc(target.Name, unicode.IsControl) {
		return errors.New("enter a Gateway name of 1 to 64 characters")
	}
	u, err := url.Parse(target.URL)
	tunnel := err == nil && (u.Scheme == "ws" || u.Scheme == "wss")
	if err != nil || u.Hostname() == "" || u.User != nil || (!tunnel && u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https" && !tunnel) || len(target.URL) > 2048 {
		return errors.New("enter a Gateway origin without credentials, path, query or fragment, or a ws or wss tunnel URL without credentials, query or fragment")
	}
	if u.Scheme == "http" || u.Scheme == "ws" {
		if ip := net.ParseIP(u.Hostname()); ip == nil || !ip.IsLoopback() {
			return errors.New("remote Gateways require HTTPS or WSS; HTTP and WS require a loopback IP")
		}
		if target.ServerCAFile != "" || target.ClientCertFile != "" || target.ClientKeyFile != "" {
			return errors.New("TLS files require an HTTPS or WSS Gateway")
		}
	}
	if (target.ClientCertFile == "") != (target.ClientKeyFile == "") {
		return errors.New("provide both the client certificate and key")
	}
	for _, path := range []string{target.ServerCAFile, target.ClientCertFile, target.ClientKeyFile} {
		if len(path) > 4096 || strings.ContainsFunc(path, unicode.IsControl) {
			return errors.New("invalid TLS file path")
		}
	}
	if target.Token == "" || len(target.Token) > 8192 || strings.ContainsFunc(target.Token, func(r rune) bool { return r < 33 || r > 126 }) {
		return errors.New("enter a valid operator token")
	}
	return nil
}

// gatewayOrigin is the form a Gateway URL is saved and compared in: lowercase scheme and host
// without a default port, plus the path of a ws or wss tunnel URL.
func gatewayOrigin(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return raw
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if ((scheme == "https" || scheme == "wss") && port == "443") || ((scheme == "http" || scheme == "ws") && port == "80") {
		port = ""
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	path := ""
	if (scheme == "ws" || scheme == "wss") && u.EscapedPath() != "/" {
		path = u.EscapedPath()
	}
	return scheme + "://" + host + path
}

func (s *gatewayStore) update(change func(*gatewayProfiles) error) (gatewayProfiles, error) {
	var empty gatewayProfiles
	if err := s.directory(true); err != nil {
		return empty, err
	}
	lock, err := privateGatewayFile(s.path+".lock", unix.O_RDWR|unix.O_CREAT)
	if err != nil {
		return empty, errors.New("could not safely lock saved Gateways")
	}
	defer lock.Close()
	if unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB) != nil {
		return empty, errors.New("saved Gateways are busy; try again")
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	profiles, err := s.load()
	if err != nil {
		return empty, err
	}
	if err = change(&profiles); err != nil {
		return empty, err
	}
	data, err := json.Marshal(profiles)
	if err != nil {
		return empty, errors.New("could not encode saved Gateways")
	}
	if len(data) > 1<<20 {
		return empty, errors.New("saved Gateways exceed the storage limit")
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".tui-gateways-*")
	if err != nil {
		return empty, errors.New("could not stage saved Gateways")
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(append(data, '\n')); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), s.path)
	}
	if err == nil {
		directory, openErr := os.Open(filepath.Dir(s.path))
		if openErr != nil {
			err = openErr
		} else {
			err = directory.Sync()
			directory.Close()
		}
	}
	if err != nil {
		return empty, errors.New("could not save Gateway connections")
	}
	return profiles, nil
}

func (s *gatewayStore) save(target client.Target) (gatewayProfiles, error) {
	if err := validateSavedGateway(target); err != nil {
		return gatewayProfiles{}, err
	}
	target.URL = gatewayOrigin(target.URL)
	return s.update(func(profiles *gatewayProfiles) error {
		for _, existing := range profiles.Gateways {
			if existing.Name == target.Name {
				if gatewayOrigin(existing.URL) != target.URL {
					return errors.New("this name belongs to another Gateway URL")
				}
				for i := range profiles.Gateways {
					if profiles.Gateways[i].Name == target.Name {
						profiles.Gateways[i] = target
						break
					}
				}
				profiles.Active = target.Name
				return nil
			}
		}
		profiles.Gateways = append(profiles.Gateways, target)
		profiles.Active = target.Name
		return nil
	})
}

func (s *gatewayStore) selectTarget(target client.Target) error {
	_, err := s.update(func(profiles *gatewayProfiles) error {
		for _, existing := range profiles.Gateways {
			if existing == target {
				profiles.Active = target.Name
				return nil
			}
		}
		return nil
	})
	return err
}

func (s *gatewayStore) remove(target client.Target) (gatewayProfiles, error) {
	return s.update(func(profiles *gatewayProfiles) error {
		for i, existing := range profiles.Gateways {
			if existing == target {
				profiles.Gateways = append(profiles.Gateways[:i], profiles.Gateways[i+1:]...)
				if profiles.Active == target.Name {
					profiles.Active = ""
				}
				return nil
			}
		}
		return errors.New("this connection is not saved or changed in another window")
	})
}

func mergeGateways(handed, saved []client.Target) []client.Target {
	targets := append([]client.Target(nil), handed...)
	for _, target := range saved {
		found := false
		for i, existing := range targets {
			if existing == target {
				found = true
				break
			}
			copy := existing
			copy.Name = target.Name
			if copy == target {
				targets[i].Name = target.Name
				found = true
				break
			}
		}
		if !found {
			targets = append(targets, target)
		}
	}
	return targets
}
