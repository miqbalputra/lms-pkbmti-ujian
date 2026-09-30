FROM node:24-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM golang:1.25-alpine AS backend-build
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY backend ./backend
RUN CGO_ENABLED=0 go build -o /cbt-server ./backend

FROM alpine:3.21
WORKDIR /app
RUN apk add --no-cache ca-certificates wget && adduser -D -H -u 10001 cbt && mkdir -p /app/uploads && chown -R cbt:cbt /app
COPY --from=backend-build /cbt-server /app/cbt-server
COPY --from=frontend-build /app/frontend/dist /app/public
USER cbt
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD wget --spider -q http://127.0.0.1:8080/health || exit 1
CMD ["/app/cbt-server"]

