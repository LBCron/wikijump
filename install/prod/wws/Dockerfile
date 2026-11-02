# syntax=docker/dockerfile:1

#
# WWS build
#

FROM rust:1.99.1@sha256:09027f873d45b8ecd1dc86f1fa13b7a62b875c961f017a0e331267b350430137 AS rust

# The pinned image still trusts the compromised emSign ECC Root CA - G3 and
# Comodo AAA cross-sign. Refresh the OS bundle before any HTTPS bootstrap.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Rustup before 1.29.2 trusts a compromised eMudhra intermediate
# (CVE-2026-111943, RUSTSEC-2026-0382,
# https://blog.rust-lang.org/2026/10/20/Rustup-1.29.2/). The pinned base
# image still ships rustup 1.29.0 and has not been rebuilt upstream, so a
# re-pin does not fix it. Replace the image's rustup with 1.29.2 here,
# before any rustup or cargo network use. The Rust toolchain itself stays
# 1.99.1 per rust-toolchain.toml.
RUN set -eux; \
    curl -fsSL -o /tmp/rustup-init https://static.rust-lang.org/rustup/archive/1.29.2/x86_64-unknown-linux-gnu/rustup-init; \
    printf '%s  %s\n' "5be191e8c70a5007074254cb74d78dbfdd25cd5a61c27de7b8e5410122ec24f4" /tmp/rustup-init | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    cp /tmp/rustup-init "$(command -v rustup)"; \
    rm /tmp/rustup-init; \
    rustup --version | grep -F "1.29.2"

# Install files
COPY ./install/prod/wws/health-check.sh /usr/local/bin/wikijump-health-check

# Copy source
RUN mkdir /src
COPY ./wws /src/wws
WORKDIR /src/wws

# Build wws.  The registry and target directory are build caches, so a source
# change recompiles only what it affects; the binary is copied out of the
# cache because cache mounts are not part of the image.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/wws/target,id=wws-release-target,sharing=locked \
    cargo build --release --locked \
    && install -D target/release/wws /out/wws

#
# Final image
#

# Match the pinned Rust builder's Debian 13/trixie libc family so the
# dynamically linked WWS binary runs on the immutable standing image.
FROM debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd

# Install dependencies.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install files
COPY --from=rust /out/wws /usr/local/bin/wws
COPY ./install/prod/wws/health-check.sh /usr/local/bin/wikijump-health-check

USER daemon
EXPOSE 3466
CMD ["/usr/local/bin/wws"]
