FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile && pnpm build
RUN pnpm --filter @supertag/cli deploy --prod --legacy /opt/supertag

FROM node:24-bookworm-slim

ENV NODE_ENV=production
# supertag up reads $SUPERTAG_STATE_DIR/supertag.yaml when present. In a container the Control
# Plane listens on every interface; environment variables override the file.
ENV SUPERTAG_STATE_DIR=/var/lib/supertag
ENV SUPERTAG_GATEWAY_HOST=0.0.0.0

WORKDIR /app
COPY --from=build --chown=node:node /opt/supertag ./
COPY deploy/docker/entrypoint.sh /usr/local/bin/supertag-entrypoint

# Render supplies the SSH server and account-key authentication. Keep this
# opt-in image separate from the default image. An unknown random password
# unlocks root without embedding a reusable credential or allowing empty passwords.
# https://render.com/docs/ssh#docker-specific-configuration
RUN chmod 755 /usr/local/bin/supertag-entrypoint \
    && install -d -m 0700 /root/.ssh \
    && node -e 'console.log("root:" + require("node:crypto").randomBytes(64).toString("hex"))' | chpasswd


EXPOSE 3434

ENTRYPOINT ["/usr/local/bin/supertag-entrypoint"]
CMD ["node", "dist/index.js", "up", "--foreground", "control-plane"]
