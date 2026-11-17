package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"golang.org/x/sys/unix"
)

// The terminal UI keeps on disk what it shows on launch, so `supertag` shows the last Tag's
// conversation before the Control Plane answers: the Tag list with each conversation's row, the
// selected Tag, the latest messages of each conversation shown, messages not yet sent, and unsent
// drafts. Each Control Plane and principal has its own directory, named by digests. The files hold
// only what the terminal UI read or wrote, never a credential, and only this user can read them.

// cacheSchema is what every entry records; an entry written with another schema is discarded.
const cacheSchema = 1

// maxCacheEntryBytes is the most one entry may take.
const maxCacheEntryBytes = 4 << 20

// maxCacheEntries is how many entries each Control Plane and principal keep; the least recently
// written are removed first.
const maxCacheEntries = 64

// maxPrincipals is how many credentials each Control Plane remembers the principal of.
const maxPrincipals = 16

// cacheTurns is how many of a conversation's latest messages its entry keeps.
const cacheTurns = 50

// cacheDirectory is where the cache lives: supertag/tui in the user's cache directory. Tests
// point it elsewhere.
var cacheDirectory = func() (string, error) {
	directory, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "supertag", "tui"), nil
}

type stored struct {
	SchemaVersion int             `json:"schemaVersion"`
	Value         json.RawMessage `json:"value"`
}

func cacheDigest(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		var size [8]byte
		binary.BigEndian.PutUint64(size[:], uint64(len(part)))
		hash.Write(size[:])
		hash.Write([]byte(part))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// localCache is the cache of one Control Plane, by its origin.
type localCache struct {
	root   string
	origin string
	// mu orders writes, which run off the program's goroutine.
	mu sync.Mutex
}

// openCache opens the cache of the Control Plane at origin; nil when there is no cache directory.
func openCache(origin string) *localCache {
	root, err := cacheDirectory()
	if err != nil || root == "" {
		return nil
	}
	return &localCache{root: root, origin: origin}
}

func (c *localCache) controlPlaneDirectory() string {
	return filepath.Join(c.root, cacheDigest(c.origin))
}

// credentialDigest names a credential in the cache without keeping it: a one-way digest bound to
// this cache and Control Plane, which cannot be presented to any Control Plane.
func (c *localCache) credentialDigest(token string) string {
	return cacheDigest("supertag-tui-cache-credential", c.origin, token)
}

// principal is whom the Control Plane last resolved this credential to, if it ever did.
func (c *localCache) principal(token string) string {
	var known map[string]string
	if !c.readFile(filepath.Join(c.controlPlaneDirectory(), "principals.json"), &known) {
		return ""
	}
	return known[c.credentialDigest(token)]
}

// rememberPrincipal records whom this credential acts as, for the next launch.
func (c *localCache) rememberPrincipal(token, principal string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	path := filepath.Join(c.controlPlaneDirectory(), "principals.json")
	var known map[string]string
	if !c.readFile(path, &known) || len(known) >= maxPrincipals {
		known = map[string]string{}
	}
	known[c.credentialDigest(token)] = principal
	_ = writeCacheFile(c.root, path, known)
}

// entry is the file of key in the principal's directory.
func (c *localCache) entry(principal, key string) string {
	return filepath.Join(c.controlPlaneDirectory(), cacheDigest(principal), cacheDigest(key)+".json")
}

// read decodes the principal's entry under key into value; false when there is no valid one.
func (c *localCache) read(principal, key string, value any) bool {
	if c == nil || principal == "" {
		return false
	}
	return c.readFile(c.entry(principal, key), value)
}

// write replaces the principal's entry under key, and keeps the directory to its newest entries.
func (c *localCache) write(principal, key string, value any) error {
	if c == nil || principal == "" {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	path := c.entry(principal, key)
	if err := writeCacheFile(c.root, path, value); err != nil {
		return err
	}
	pruneCache(filepath.Dir(path))
	return nil
}

// forget removes everything cached for the Control Plane, for every principal.
func (c *localCache) forget() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = os.RemoveAll(c.controlPlaneDirectory())
}

func (c *localCache) readFile(path string, value any) bool {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return false
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	var stat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG ||
		stat.Uid != uint32(os.Geteuid()) || stat.Mode&0o077 != 0 {
		return false
	}
	data, err := io.ReadAll(io.LimitReader(f, maxCacheEntryBytes+1))
	if err != nil || len(data) > maxCacheEntryBytes {
		return false
	}
	// One pass decodes the value with its schema; a value of another schema is not used.
	entry := struct {
		SchemaVersion int `json:"schemaVersion"`
		Value         any `json:"value"`
	}{Value: value}
	return json.Unmarshal(data, &entry) == nil && entry.SchemaVersion == cacheSchema
}

// privateCacheDirectory creates directory owner-only, and checks that it is.
func privateCacheDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	var stat unix.Stat_t
	if err := unix.Lstat(directory, &stat); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR || stat.Uid != uint32(os.Geteuid()) || stat.Mode&0o077 != 0 {
		return errors.New("the terminal UI cache directory must be private and owned by this user")
	}
	return nil
}

// writeCacheFile replaces path, under root, with value, atomically: a reader sees the old entry or
// the new one. Every directory from root to the file is owner-only.
func writeCacheFile(root, path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	data, err := json.Marshal(stored{SchemaVersion: cacheSchema, Value: raw})
	if err != nil {
		return err
	}
	if len(data) > maxCacheEntryBytes {
		// Too large to keep; the conversation still loads from the Control Plane.
		_ = os.Remove(path)
		return nil
	}
	directory := filepath.Dir(path)
	relative, err := filepath.Rel(root, directory)
	if err != nil || relative == ".." || filepath.IsAbs(relative) || len(relative) > 1 && relative[:2] == ".." {
		return errors.New("a cache entry must be inside the cache directory")
	}
	dir := root
	if err := privateCacheDirectory(dir); err != nil {
		return err
	}
	if relative != "." {
		for _, part := range splitPath(relative) {
			dir = filepath.Join(dir, part)
			if err := privateCacheDirectory(dir); err != nil {
				return err
			}
		}
	}
	// CreateTemp creates the file owner-only.
	staged, err := os.CreateTemp(directory, ".entry-*")
	if err != nil {
		return err
	}
	defer os.Remove(staged.Name())
	if _, err := staged.Write(data); err != nil {
		staged.Close()
		return err
	}
	if err := staged.Close(); err != nil {
		return err
	}
	return os.Rename(staged.Name(), path)
}

func splitPath(relative string) []string {
	var parts []string
	for relative != "." && relative != "" {
		parts = append([]string{filepath.Base(relative)}, parts...)
		relative = filepath.Dir(relative)
	}
	return parts
}

// pruneCache keeps the newest maxCacheEntries entries of one directory.
func pruneCache(directory string) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	type file struct {
		path     string
		modified int64
	}
	var files []file
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		if info, err := entry.Info(); err == nil {
			files = append(files, file{filepath.Join(directory, entry.Name()), info.ModTime().UnixNano()})
		}
	}
	if len(files) <= maxCacheEntries {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].modified < files[j].modified })
	for _, f := range files[:len(files)-maxCacheEntries] {
		_ = os.Remove(f.path)
	}
}
