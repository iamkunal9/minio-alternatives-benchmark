# MinIO community edition is source-only since late 2025 (no official images),
# so the baseline is built from the last community release tag.
# alpine runtime (not scratch) so the harness can `docker exec cat` cgroup stats.
ARG MINIO_TAG=RELEASE.2025-10-15T17-29-55Z
FROM golang:1.24-alpine AS build
ARG MINIO_TAG
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "$MINIO_TAG" https://github.com/minio/minio.git /src
WORKDIR /src
RUN git rev-parse HEAD > /commit \
 && CGO_ENABLED=0 go build -tags kqueue -trimpath \
      -ldflags "$(go run buildscripts/gen-ldflags.go)" -o /minio .

FROM alpine:3.22
ARG MINIO_TAG
COPY --from=build /minio /usr/bin/minio
COPY --from=build /commit /minio.commit
LABEL org.opencontainers.image.version="$MINIO_TAG"
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data"]
