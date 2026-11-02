# syntax=docker/dockerfile:1

#
# DEEPWELL build
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

# Install system dependencies
RUN apt update
RUN apt install -y build-essential libmagic-dev pkg-config musl-tools

# The runtime image is Debian Bookworm (glibc 2.36), while the pinned Rust
# builder image currently carries a newer glibc.  Build the migration helper
# statically so the immutable runtime image does not inherit that builder
# libc requirement.
RUN rustup target add x86_64-unknown-linux-musl

# Keep migration execution in the immutable standing image.  The runtime
# wrapper runs this binary before the prebuilt Deepwell server starts.  It does
# not depend on the Deepwell sources, so it is built before they are copied and
# a source change reuses this layer.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo install sqlx-cli --version 0.9.0 --locked \
    --target x86_64-unknown-linux-musl \
    --root /tmp/sqlx-root \
    --no-default-features --features rustls,postgres

# Copy source
RUN mkdir /src
COPY ./deepwell /src/deepwell
WORKDIR /src/deepwell

# Build deepwell server.  The registry and target directory are build caches,
# so a source change recompiles only what it affects; the binary is copied out
# of the cache because cache mounts are not part of the image.  Standing
# promotion builds pass CARGO_PROFILE=standing (see deepwell/Cargo.toml).
ARG CARGO_PROFILE=release
# Source commit for the platform information page (WJ-1279).
ARG WIKIJUMP_GIT_COMMIT=
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/deepwell/target,id=deepwell-target,sharing=locked \
    cargo build --profile "${CARGO_PROFILE}" --locked \
    && install -D "target/${CARGO_PROFILE}/deepwell" /out/deepwell

#
# Final image
#

# Match the pinned Rust builder's Debian 13/trixie libc family.  Deepwell is
# intentionally shipped dynamically linked because libmagic is a runtime
# dependency; keeping both stages on the same pinned distribution avoids a
# hidden builder-to-runtime libc mismatch.
FROM debian:trixie-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd

ENV LOCALIZATION_PATH="/opt/locales"

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl libmagic1 libmagic-mgc && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=rust /out/deepwell /usr/local/bin/deepwell
COPY --from=rust /tmp/sqlx-root/bin/sqlx /usr/local/bin/sqlx
COPY ./deepwell/migrations /opt/deepwell/migrations
COPY ./deepwell/seeder /opt/deepwell/seeder
COPY ./install/prod/deepwell/deepwell-start /usr/local/bin/wikijump-deepwell-start
COPY ./install/prod/deepwell/health-check.sh /bin/wikijump-health-check
COPY ./install/prod/deepwell/config.toml /etc/deepwell.toml
COPY ./locales/fluent /opt/locales/fluent

USER daemon
ENV PORT=2747
EXPOSE 2747
CMD ["/usr/local/bin/wikijump-deepwell-start"]
