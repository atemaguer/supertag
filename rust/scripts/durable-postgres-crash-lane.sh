#!/bin/sh
# Durable PostgreSQL crash lane: run the hard-crash matrix (crates/cli/tests/crash_durability.rs)
# against PostgreSQL with production durability settings (fsync, synchronous_commit, and
# full_page_writes on). The fast PostgreSQL lanes disable those settings and prove only
# logical behavior.
#
# With SUPERTAG_RUST_TEST_POSTGRES_URL_FILE set, the cases use that server (CI starts one
# with the settings on). Otherwise this script creates a disposable trust-auth cluster on
# 127.0.0.1:${SUPERTAG_DURABLE_POSTGRES_PORT:-55439} with initdb/pg_ctl from PATH and removes
# it afterwards. Either way every case refuses a server whose settings are not all on.
# Extra arguments go to the test binary, for example a case filter or --test-threads.
set -eu
umask 077
rust=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export SUPERTAG_RUST_TEST_REQUIRE_DURABLE_POSTGRES=1

if [ -z "${SUPERTAG_RUST_TEST_POSTGRES_URL_FILE:-}" ]; then
  port="${SUPERTAG_DURABLE_POSTGRES_PORT:-55439}"
  # A short path keeps the server's Unix socket under the platform length limit.
  scratch=$(mktemp -d /tmp/supertag-durable-pg.XXXXXX)
  cleanup() {
    pg_ctl -D "$scratch/data" -m fast -w stop >/dev/null 2>&1 || true
    rm -rf "$scratch"
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  initdb -D "$scratch/data" -U supertag --auth=trust >"$scratch/initdb.log"
  pg_ctl -D "$scratch/data" -l "$scratch/postgres.log" -w \
    -o "-c listen_addresses=127.0.0.1 -p $port -k $scratch -c fsync=on -c synchronous_commit=on -c full_page_writes=on" \
    start >/dev/null
  printf 'postgresql://supertag@127.0.0.1:%s/postgres' "$port" >"$scratch/url"
  export SUPERTAG_RUST_TEST_POSTGRES_URL_FILE="$scratch/url"
fi

cargo test --locked --manifest-path "$rust/Cargo.toml" -p supertag-cli --features test-fixtures \
  --test crash_durability -- --ignored postgres:: "$@"
