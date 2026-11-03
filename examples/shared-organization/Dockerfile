FROM node:24-bookworm-slim
ARG CODEX_VERSION
WORKDIR /app
COPY supertag-ai.tgz /app/supertag-ai.tgz
RUN npm install --omit=dev /app/supertag-ai.tgz && npm install --global "@openai/codex@${CODEX_VERSION}" && rm /app/supertag-ai.tgz
RUN groupadd --gid 10001 workload && useradd --uid 10001 --gid 10001 --no-create-home workload
COPY execution-service.mjs mcp-fixture.cjs /app/
CMD ["node", "/app/execution-service.mjs"]
