FROM rust:1.99.1-slim-bookworm@sha256:24707e70a4f1e23d9a7b25202ec43126d28a52294b96aad5c670df1fd1f1d400 AS rustbuild
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake clang pkg-config && rm -rf /var/lib/apt/lists/*
RUN rustup component add rustfmt clippy
WORKDIR /build
COPY vendor/engine vendor/engine
COPY rust-host rust-host
RUN cargo fmt --manifest-path rust-host/Cargo.toml --check && cargo clippy --manifest-path rust-host/Cargo.toml --locked --all-targets -- -D warnings && cargo test --manifest-path rust-host/Cargo.toml --locked && cargo build --manifest-path rust-host/Cargo.toml --release --locked --target-dir /build/target
RUN cargo rustc --manifest-path rust-host/Cargo.toml --release --locked --target-dir /build/target --bin hybrid-engine-host -- -C link-arg=-Wl,-Map=/build/engine-link.map
RUN cargo metadata --manifest-path rust-host/Cargo.toml --locked --format-version 1 --filter-platform "$(rustc -vV | sed -n 's/^host: //p')" > /build/cargo-metadata.json
RUN mkdir -p /build/rust-license && cp -a "$(rustc --print sysroot)"/share/doc/rust/COPYRIGHT*.html "$(rustc --print sysroot)"/share/doc/rust/licenses /build/rust-license/
FROM rustbuild AS storeverification
RUN cp rust-host/Cargo.lock vendor/engine/Cargo.lock && cargo generate-lockfile --manifest-path vendor/engine/Cargo.toml --offline && chown -R 10001:10001 /build /usr/local/cargo
USER 10001:10001
RUN cargo test --manifest-path vendor/engine/Cargo.toml --locked --offline -p code-system-graph-store-sqlite && cargo clippy --manifest-path vendor/engine/Cargo.toml --locked --offline --all-targets -p code-system-graph-store-sqlite -- -D warnings && cargo metadata --manifest-path vendor/engine/Cargo.toml --locked --offline --format-version 1 > /build/store-metadata.json
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS nodebuild
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src src
COPY tests tests
COPY docker docker
RUN npx --no-install tsc
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS verification
WORKDIR /app
COPY --from=nodebuild /app /app
COPY --from=rustbuild /build/target/release/hybrid-engine-host /app/engine
COPY --from=rustbuild /build/target/release/sample_graph /app/sample_graph
COPY scripts scripts
COPY vendor/engine vendor/engine
COPY licenses/vendor-modifications.json licenses/vendor-modifications.json
RUN mkdir artifacts && chown 10001:10001 artifacts
USER 10001:10001
ENV ENGINE_BINARY=/app/engine SAMPLE_GENERATOR=/app/sample_graph
RUN node scripts/test.mjs && node scripts/demo.mjs
FROM nodebuild AS distribution
USER root
RUN apt-get update -o Acquire::Retries=1 && apt-get install -y --no-install-recommends binutils && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /license-inputs/os-source && sed -i 's/Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources && apt-get update -o Acquire::Retries=1 && cd /license-inputs/os-source && apt-get source --download-only --only-source -y glibc=2.41-12+deb13u4 gcc-14=14.2.0-19 && rm -rf /var/lib/apt/lists/*
COPY --from=rustbuild /build/target/release/hybrid-engine-host /app/engine
COPY --from=rustbuild /build/cargo-metadata.json /license-inputs/cargo-metadata.json
COPY --from=rustbuild /build/engine-link.map /license-inputs/engine-link.map
COPY --from=rustbuild /usr/local/cargo/registry /license-inputs/registry
COPY --from=rustbuild /build/rust-license /license-inputs/rust-license
COPY licenses/supplemental /license-inputs/supplemental
COPY vendor/engine /license-inputs/engine
COPY rust-host /license-inputs/host
COPY LICENSE NOTICE /app/
COPY VENDOR.md licenses/vendor-modifications.json /app/
COPY LICENSE /license-inputs/host/LICENSE
COPY scripts/distribution /app/distribution
COPY docker /app/docker
RUN node distribution/collect-notices.mjs && npm prune --omit=dev --ignore-scripts --no-audit --no-fund && node distribution/build-rootfs.mjs
FROM scratch AS runtime
LABEL org.opencontainers.image.title="System Graph Remote MCP" org.opencontainers.image.version="0.1.0-beta.1" org.opencontainers.image.licenses="Apache-2.0" org.opencontainers.image.description="Project Apache-2.0; preserve bundled distribution licenses and corresponding sources"
COPY --from=distribution /out/rootfs /
WORKDIR /app
USER 10001:10001
ENV NODE_ENV=production PATH=/usr/local/bin LANG=C
HEALTHCHECK --interval=5s --timeout=2s --retries=6 CMD ["/usr/local/bin/node","-e","fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/node","/app/docker/entrypoint.mjs","/config/runtime.json","/app/engine"]
