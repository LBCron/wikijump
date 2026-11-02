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
RUN apt install -y build-essential libmagic-dev pkg-config

# Install helpers
RUN cargo install sqlx-cli --version 0.9.0 --locked --no-default-features --features rustls,postgres

# Copy source
RUN mkdir /src
COPY ./deepwell /src/deepwell
WORKDIR /src/deepwell

# Adjust seeder files for dev
RUN patch /src/deepwell/seeder/sites.json /src/deepwell/seeder/sites.dev.patch

# Cache rust dependencies
RUN mkdir .cargo && cargo vendor > .cargo/config.toml

# Build deepwell server
RUN cargo build --release

#
# Final image
#

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

ENV LOCALIZATION_PATH="/opt/locales"

# Install system dependencies
RUN mkdir /opt/database
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl libmagic1 libmagic-mgc postgresql-client && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install files
COPY --from=rust /usr/local/cargo/bin/sqlx /usr/local/cargo/bin/sqlx
COPY --from=rust /src/deepwell/target/release/deepwell /usr/local/bin/deepwell
COPY --from=rust /src/deepwell/migrations /opt/database/migrations
COPY --from=rust /src/deepwell/seeder /opt/database/seeder
COPY ./install/dev/deepwell/config.toml /etc/deepwell.toml
COPY ./install/dev/deepwell/deepwell-start /usr/local/bin/wikijump-deepwell-start
COPY ./install/dev/deepwell/health-check.sh /usr/local/bin/wikijump-health-check
COPY ./locales/fluent /opt/locales/fluent

USER daemon
EXPOSE 2747
CMD ["/usr/local/bin/wikijump-deepwell-start"]
