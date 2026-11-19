# Build tools only; no product state, provider credentials, or published artifacts.
FROM rust:1.93.1-bookworm@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git make g++ pkg-config libsecret-1-dev python3-venv unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*
# Bun compiles the terminal UI and embeds its own runtime in it, so amd64 uses Bun's baseline build,
# which runs on x86-64 processors without AVX2. The Bun version must equal .bun-version.
RUN set -eu; case "$TARGETARCH" in \
      amd64) node_arch=x64; node_sha=3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6; \
        bun_build=linux-x64-baseline; bun_sha=dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463 ;; \
      arm64) node_arch=arm64; node_sha=5de54a12983d0de6ba23597d4d0194e64933e26b0f04a469db3be9c3e18b6b2b; \
        bun_build=linux-aarch64; bun_sha=18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84 ;; \
      *) exit 1 ;; \
    esac; \
    curl --fail --location --retry 3 "https://nodejs.org/dist/v22.13.0/node-v22.13.0-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
    printf '%s  /tmp/node.tar.xz\n' "$node_sha" | sha256sum --check -; \
    mkdir /opt/node; tar -xJf /tmp/node.tar.xz --strip-components=1 -C /opt/node; \
    curl --fail --location --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/bun-${bun_build}.zip" -o /tmp/bun.zip; \
    printf '%s  /tmp/bun.zip\n' "$bun_sha" | sha256sum --check -; \
    mkdir -p /opt/bun/bin; unzip -q -j /tmp/bun.zip "bun-${bun_build}/bun" -d /opt/bun/bin; chmod 0755 /opt/bun/bin/bun; \
    rm /tmp/node.tar.xz /tmp/bun.zip
ENV PATH="/opt/node/bin:/opt/bun/bin:/opt/release-python/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin" \
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
