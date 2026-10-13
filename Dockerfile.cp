# effigent-cp — the control plane (api.effigent.ai).
# Compile on the build machine's own architecture and cross-compile to the target
# (no CPU emulation needed).
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w" -o /out/effigent-cp ./cmd/effigent-cp

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/effigent-cp /effigent-cp
ENV EFFIGENT_LISTEN=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/effigent-cp"]
