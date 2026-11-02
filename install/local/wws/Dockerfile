#
# WWS build
#

# This image is modified for development, it retains the
# full rust container and rebuilds as needed, to ease
# iteration during development.

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

ENV CARGO_BUILD_JOBS=2 \
    CARGO_INCREMENTAL=1

# Install helpers
RUN cargo install cargo-watch --version 8.5.3 --locked

# Install files
COPY ./install/local/wws/wws-start /usr/local/bin/wikijump-wws-start
COPY ./install/local/wws/health-check.sh /usr/local/bin/wikijump-health-check

# Copy source
# Don't build until container execution (see cargo-watch)
RUN mkdir -p /src/.cargo
COPY .cargo/config.toml /src/.cargo/config.toml
COPY ./wws /src/wws
WORKDIR /src/wws

EXPOSE 3466
CMD ["/usr/local/bin/wikijump-wws-start"]
