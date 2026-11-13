#!/bin/sh
# Runs the Control Plane and a Gateway side by side in one container, for platforms that give
# containers no network between them (Cloudflare Containers, a Modal app). Started by
# `supertag-hosted-entrypoint pair TUNNEL_ADDRESS`, already as UID 10001 under tini.
#
# The Control Plane accepts the platform's WebSocket tunnel on TUNNEL_ADDRESS (whose plain
# GET /healthz serves the platform health check) and native gRPC on loopback only. The Gateway
# dials that loopback listener with its client certificate, so the Control Plane's certificate
# must also name IP 127.0.0.1. Each process gets only its own role's settings: the Gateway never
# sees the database URL, the operator token, or the Control Plane's TLS key. Both run as the
# same user in one container, so they share one trust boundary.
#
# When either process exits, the other is stopped and this script exits non-zero, so the
# platform restarts the container. SIGTERM and SIGINT stop both and exit 0.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: supertag-hosted-pair TUNNEL_ADDRESS" >&2
  exit 2
fi
tunnel=$1
supertag=/usr/local/bin/supertag
control=
gateway=
stopping=0
stop() {
  stopping=1
  for pid in $control $gateway; do
    kill -TERM "$pid" 2>/dev/null || true
  done
}
trap stop TERM INT

# The Gateway's view: none of the Control Plane's credentials or server TLS settings. A plain
# command (not a function), so a background Gateway's PID is the Gateway itself.
as_gateway="env -u SUPERTAG_DATABASE_URL -u SUPERTAG_OPERATOR_TOKEN -u SUPERTAG_TLS_CERT_FILE
  -u SUPERTAG_TLS_KEY_FILE -u SUPERTAG_TLS_CLIENT_CA_FILE -u SUPERTAG_GITHUB_TOKEN
  -u SUPERTAG_GITHUB_PRIVATE_KEY_FILE"
# Sleeps in the background so a signal interrupts the wait at once.
pause() {
  sleep 1 &
  wait $! || true
}

env -u SUPERTAG_CLIENT_CERT_FILE -u SUPERTAG_CLIENT_KEY_FILE -u SUPERTAG_SERVER_CA_FILE \
  "$supertag" control-plane --listen 127.0.0.1:3434 --websocket-listen "$tunnel" \
  --transfer-directory /var/lib/supertag/transfers &
control=$!

# A Gateway exits when it cannot reach the Control Plane at startup, so wait until the Control
# Plane (which migrates its database first) answers health checks over the Gateway's own TLS.
waited=0
until [ "$stopping" = 1 ] || $as_gateway "$supertag" health --endpoint https://127.0.0.1:3434 \
  >/dev/null 2>&1; do
  if ! kill -0 "$control" 2>/dev/null; then
    echo "supertag-hosted-pair: the Control Plane exited during startup" >&2
    wait "$control" || true
    exit 1
  fi
  waited=$((waited + 1))
  if [ "$waited" -ge 300 ]; then
    echo "supertag-hosted-pair: the Control Plane was not healthy after 300 seconds" >&2
    stop
    wait "$control" || true
    exit 1
  fi
  pause
done
if [ "$stopping" = 0 ]; then
  $as_gateway "$supertag" gateway --listen 127.0.0.1:3436 --control-plane https://127.0.0.1:3434 &
  gateway=$!
fi

# POSIX sh has no `wait -n`: poll both until one exits or a signal arrives.
while [ "$stopping" = 0 ] && kill -0 "$control" 2>/dev/null && kill -0 "$gateway" 2>/dev/null; do
  pause
done
if [ "$stopping" = 0 ]; then
  echo "supertag-hosted-pair: a service exited; stopping the other" >&2
  stop
  stopping=0
fi
for pid in $control $gateway; do
  wait "$pid" 2>/dev/null || true
done
[ "$stopping" = 1 ]
