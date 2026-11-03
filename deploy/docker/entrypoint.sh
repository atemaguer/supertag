#!/bin/sh
set -eu

# A managed volume replaces this directory at container start. Initialize only
# this fixed state mount as root, then run the Control Plane as the unprivileged user.
# A supertag.yaml mounted read-only into it keeps its owner; the Control Plane only reads it.
mkdir -p /var/lib/supertag
chown node:node /var/lib/supertag
chown -R node:node /var/lib/supertag 2>/dev/null || true

exec su -s /bin/sh node -c 'exec "$@"' supertag-entrypoint -- "$@"
