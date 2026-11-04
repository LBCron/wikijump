#
# Framerail build
#

FROM node:24.22.1-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d

# Install dependencies
RUN apk add --no-cache --upgrade ca-certificates ca-certificates-bundle
RUN apk add --no-cache curl && \
    npm install --global pnpm@11.10.0

# Copy sources
RUN mkdir /app
WORKDIR /app
COPY framerail/ ./
COPY assets ./src/assets

# Install app
RUN \
    pnpm install --frozen-lockfile && \
    pnpm build && \
    pnpm prune --prod && \
    rm -rf tests/

# Run command
USER node:node
ENV NODE_ENV=production
ENV FRAMERAIL_ENV=dev
# 2 MiB form-body limit: a maximum-length (200,001 character) page
# source must fit; Deepwell enforces the source limit itself.
ENV BODY_SIZE_LIMIT=2097152
ENV PORT=3393
EXPOSE 3393

CMD ["/usr/local/bin/node", "server.ts"]
