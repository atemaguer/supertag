#!/bin/sh
# Entrypoint of the hosted service image (target "hosted" in rust-service.Dockerfile) for
# platforms that mount root-owned volumes and deliver TLS material as secrets (Fly.io, Railway,
# Render, Cloudflare, and Modal).
#
# As root, and only for these fixed paths, it:
#   1. gives the persistent state mount /var/lib/supertag to the service user, and
#   2. writes each SUPERTAG_<NAME>_PEM secret to /run/supertag-tls, sets the matching
#      SUPERTAG_<NAME>_FILE, and removes the PEM value from the environment,
# then runs `supertag "$@"` as UID 10001 with no capabilities and no new privileges.
#
# `pair TUNNEL_ADDRESS [GATEWAY_FLAG...]` instead runs supertag-hosted-pair, which starts the
# Control Plane and a Gateway side by side in this one container (Cloudflare and Modal; see that
# script).
#
# Some platforms' start commands replace the image entrypoint and others only its command, so
# definitions name this entrypoint; when the platform also runs the entrypoint, that leading
# path is skipped.
set -eu

if [ "${1:-}" = /usr/local/bin/supertag-hosted-entrypoint ]; then
  shift
fi
program=/usr/local/bin/supertag
if [ "${1:-}" = pair ]; then
  shift
  program=/usr/local/bin/supertag-hosted-pair
fi

state=/var/lib/supertag
tls=/run/supertag-tls

if [ "$(id -u)" != 0 ]; then
  echo "supertag-hosted-entrypoint must start as root to prepare $state and $tls" >&2
  exit 1
fi

mkdir -p "$state"
chown 10001:10001 "$state"
chmod 0700 "$state"

rm -rf "$tls"
mkdir -m 0700 "$tls"
# NAME FILE: SUPERTAG_<NAME>_PEM becomes $tls/FILE and SUPERTAG_<NAME>_FILE names it.
for pair in "TLS_CERT server.pem" "TLS_KEY server.key" "TLS_CLIENT_CA client-ca.pem" \
  "SERVER_CA server-ca.pem" "CLIENT_CERT client.pem" "CLIENT_KEY client.key"; do
  name=${pair% *}
  file=${pair#* }
  value=$(printenv "SUPERTAG_${name}_PEM" || true)
  if printenv "SUPERTAG_${name}_FILE" >/dev/null; then
    echo "SUPERTAG_${name}_FILE is set by this entrypoint; set SUPERTAG_${name}_PEM instead" >&2
    exit 1
  fi
  if [ -n "$value" ]; then
    (umask 077 && printf '%s\n' "$value" >"$tls/$file")
    chown 10001:10001 "$tls/$file"
    chmod 0400 "$tls/$file"
    export "SUPERTAG_${name}_FILE=$tls/$file"
  fi
  unset "SUPERTAG_${name}_PEM"
done
chown 10001:10001 "$tls"
chmod 0500 "$tls"

cd "$state"
export HOME="$state"
# tini -s also reaps orphans where it is not PID 1, such as under the Modal function.
exec setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all --bounding-set=-all \
  --no-new-privs /usr/bin/tini -s -- "$program" "$@"
