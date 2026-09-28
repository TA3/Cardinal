# syntax=docker/dockerfile:1

# Self-hosted Cardinal: the app and its proxy in one binary, which also works
# as a relay for the hosted app (see README → Self-host).
#
#   docker build -t cardinal .
#   docker run -p 9181:9181 cardinal

# Build on the host's platform and cross-compile, so arm64 images need no emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.3 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ARG TARGETARCH
ARG VERSION=""
RUN bun run build \
  && CARDINAL_VERSION="$VERSION" bun relay/build.ts "bun-linux-$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)" --outfile /out/cardinal

# glibc and libstdc++, no shell, runs as uid 65532.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/cardinal /cardinal
ENV CARDINAL_HOST=0.0.0.0 \
  CARDINAL_PORT=9181
USER nonroot
EXPOSE 9181
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/cardinal", "healthcheck"]
ENTRYPOINT ["/cardinal"]

ARG VERSION=""
LABEL org.opencontainers.image.title="Cardinal" \
  org.opencontainers.image.description="Find and cut cardinality in Prometheus and Loki. Self-hosted app and relay." \
  org.opencontainers.image.source="https://github.com/TA3/cardinal" \
  org.opencontainers.image.url="https://cardinal.ta3.dev" \
  org.opencontainers.image.version="${VERSION}"
