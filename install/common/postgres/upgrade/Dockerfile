# The server image's PostgreSQL plus the previous major's binaries, which
# pg_upgrade needs side by side. Both are the same Alpine release: the clusters
# use libc collations, so the C library must not change under their indexes.
FROM postgres:19rc1-alpine3.24@sha256:a3095ec8782b77587ca34006edaf09df362212351745069cb7758e256ecd488f

COPY --from=postgres:17-alpine3.24@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b /usr/local/ /opt/pg17/

RUN apk add --no-cache musl-locales

COPY ./install/common/postgres/upgrade/upgrade-cluster.sh /usr/local/bin/wikijump-upgrade-cluster
