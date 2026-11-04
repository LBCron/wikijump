# syntax=docker/dockerfile:1

#
# Framerail build
#

FROM node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d

# SvelteKit materializes CSP and CSRF options while `pnpm build` runs; standing may pass `local` for CSP only.
ARG FRAMERAIL_ENV=prod
ARG FRAMERAIL_CSRF_CHECK_ORIGIN=true
# Source commit for the platform information page (WJ-1279).
ARG WIKIJUMP_GIT_COMMIT=
ENV FRAMERAIL_ENV=${FRAMERAIL_ENV}
ENV FRAMERAIL_CSRF_CHECK_ORIGIN=${FRAMERAIL_CSRF_CHECK_ORIGIN}

# Install dependencies
RUN apk add --no-cache --upgrade ca-certificates ca-certificates-bundle
RUN apk add --no-cache curl && \
    npm install --global pnpm@11.10.0

# Install the locked dependencies before copying the sources, so a source
# change reuses this layer. The pnpm store is a build cache.
RUN mkdir /app
WORKDIR /app
COPY framerail/package.json framerail/pnpm-lock.yaml framerail/pnpm-workspace.yaml framerail/.npmrc ./
COPY framerail/patches ./patches
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

# Copy sources
COPY framerail/ ./
COPY assets ./src/assets

# Build app
RUN \
    pnpm build && \
    pnpm prune --prod && \
    rm -rf tests/

# Run command
USER node:node
ENV NODE_ENV=production
# 2 MiB form-body limit: a maximum-length (200,001 character) page
# source must fit; Deepwell enforces the source limit itself.
ENV BODY_SIZE_LIMIT=2097152
ENV PORT=3393
EXPOSE 3393

CMD ["/usr/local/bin/node", "server.ts"]
