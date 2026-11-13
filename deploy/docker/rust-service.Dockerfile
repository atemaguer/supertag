FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 supertag \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /var/lib/supertag supertag \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/supertag

COPY --chown=0:0 --chmod=0755 supertag /usr/local/bin/supertag
ENV HOME=/var/lib/supertag
WORKDIR /var/lib/supertag
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/supertag"]

# The public Control Plane. Compose and the hosted platforms name the same command.
FROM runtime AS control-plane
ENV SUPERTAG_DATABASE_URL=sqlite:///var/lib/supertag/control-plane.sqlite?mode=rwc
EXPOSE 3434/tcp
CMD ["control-plane", "--listen", "0.0.0.0:3434", "--transfer-directory", "/var/lib/supertag/transfers"]

# The optional surfaces-only Gateway: a client of the Control Plane with no public listener.
# Its gRPC listener (the test notification) stays on loopback inside the container.
FROM runtime AS gateway
CMD ["gateway", "--listen", "127.0.0.1:3436", "--control-plane", "https://control-plane:3434"]

# For platforms that mount root-owned volumes and pass TLS material as secrets (Fly.io,
# Railway). Starts as root only to prepare /var/lib/supertag and /run/supertag-tls, then runs
# the service as UID 10001; see rust-hosted-entrypoint.sh. The platform definition supplies
# the service command. Build context: the verified `supertag` binary and this entrypoint.
FROM runtime AS hosted
USER 0:0
COPY --chown=0:0 --chmod=0755 rust-hosted-entrypoint.sh /usr/local/bin/supertag-hosted-entrypoint
ENTRYPOINT ["/usr/local/bin/supertag-hosted-entrypoint"]
CMD ["--help"]
