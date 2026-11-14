# Build tools only; no product state, provider credentials, or published artifacts.
FROM rust:1.93.1-bookworm@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git make g++ pkg-config libsecret-1-dev python3-venv tmux xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; case "$TARGETARCH" in \
      amd64) node_arch=x64; node_sha=3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6; go_sha=031f088e5d955bab8657ede27ad4e3bc5b7c1ba281f05f245bcc304f327c987a ;; \
      arm64) node_arch=arm64; node_sha=5de54a12983d0de6ba23597d4d0194e64933e26b0f04a469db3be9c3e18b6b2b; go_sha=a290581cfe4fe28ddd737dde3095f3dbeb7f2e4065cab4eae44dfc53b760c2f7 ;; \
      *) exit 1 ;; \
    esac; \
    curl --fail --location --retry 3 "https://nodejs.org/dist/v22.13.0/node-v22.13.0-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
    printf '%s  /tmp/node.tar.xz\n' "$node_sha" | sha256sum --check -; \
    mkdir /opt/node; tar -xJf /tmp/node.tar.xz --strip-components=1 -C /opt/node; \
    curl --fail --location --retry 3 "https://go.dev/dl/go1.26.1.linux-${TARGETARCH}.tar.gz" -o /tmp/go.tar.gz; \
    printf '%s  /tmp/go.tar.gz\n' "$go_sha" | sha256sum --check -; \
    tar -xzf /tmp/go.tar.gz -C /opt; rm /tmp/node.tar.xz /tmp/go.tar.gz
ENV PATH="/opt/node/bin:/opt/go/bin:/opt/release-python/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin" \
    UV_PYTHON_INSTALL_DIR=/opt/python
RUN npm install --global --ignore-scripts --no-audit --no-fund pnpm@11.18.0 \
    && python3 -m venv /opt/uv \
    && /opt/uv/bin/pip install --no-cache-dir uv==0.9.5 \
    && /opt/uv/bin/uv python install --no-bin 3.13.9 \
    && /opt/uv/bin/uv venv /opt/release-python --python 3.13.9 \
    && /opt/uv/bin/uv pip install --python /opt/release-python/bin/python \
        PyYAML==6.0.3 grpcio==1.85.1 grpcio-tools==1.85.1 protobuf==7.36.2 \
    && rm -rf /root/.cache /root/.npm
COPY --chmod=0755 native_release_container.sh /usr/local/bin/native-release-container
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/native-release-container"]
