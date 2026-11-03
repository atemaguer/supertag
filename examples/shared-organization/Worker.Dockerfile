FROM node:22-bookworm-slim
RUN apt-get update && apt-get install --no-install-recommends --yes ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY supertag-ai.tgz /app/supertag-ai.tgz
RUN npm install --omit=dev --no-audit --no-fund /app/supertag-ai.tgz && rm /app/supertag-ai.tgz
COPY worker.mjs mcp-tools.mjs /app/
COPY seed /app/seed
ENTRYPOINT ["node", "/app/worker.mjs"]
