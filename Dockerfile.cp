# effigent-cp — the control plane (api.effigent.ai).
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/effigent-cp ./cmd/effigent-cp

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/effigent-cp /effigent-cp
ENV EFFIGENT_LISTEN=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/effigent-cp"]
