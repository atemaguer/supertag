FROM node:24-alpine
ARG SUPERTAG_CODEX_VERSION=""
RUN if [ -n "$SUPERTAG_CODEX_VERSION" ]; then npm install --global "@openai/codex@$SUPERTAG_CODEX_VERSION"; fi
WORKDIR /app
RUN addgroup -g 10001 -S workload && adduser -u 10001 -S -G workload workload
COPY src/server.ts /app/server.ts
ENV SUPERTAG_SHARED_EXECUTION_HOST=0.0.0.0
ENV SUPERTAG_SHARED_EXECUTION_PORT=8787
ENV SUPERTAG_SHARED_EXECUTION_ROOT=/data
ENV SUPERTAG_SHARED_EXECUTION_STATE=/state/state.json
ENV SUPERTAG_SHARED_EXECUTION_PROCESS_UID=10001
ENV SUPERTAG_SHARED_EXECUTION_PROCESS_GID=10001
CMD ["node", "--experimental-strip-types", "-e", "import('/app/server.ts').then(server => server.runSharedExecutionServerFromEnvironment())"]
