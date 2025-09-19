#!/bin/sh

set -eu

LISTEN_ADDRESS="${LISTEN_ADDRESS:-0.0.0.0}"
PORT="${PORT:-5000}"
CORS_ENDPOINT="${CORS_ENDPOINT:-*}"
TURN_REALM="${TURN_REALM:-localhost}"
TURN_LISTEN_IP="${TURN_LISTEN_IP:-0.0.0.0}"
PUBLIC_IP="${PUBLIC_IP:-0.0.0.0}"
TURN_PORT="${TURN_PORT:-18937}"
SERVER_NAME="${SERVER_NAME:-_}"

cat <<EOF > kabootar.toml
listen_address = "${LISTEN_ADDRESS}:${PORT}"
cors_endpoint = "${CORS_ENDPOINT}"
turn_realm = "${TURN_REALM}"
turn_listen_ip = "${TURN_LISTEN_IP}"
public_ip = "${PUBLIC_IP}"
turn_port = ${TURN_PORT}
EOF

envsubst '$PORT $SERVER_NAME' < /etc/nginx/conf.d/nginx.conf.template > /etc/nginx/conf.d/default.conf

main &
MAIN_PID=$!

cleanup() {
    if [ -n "${MAIN_PID:-}" ] && kill -0 "$MAIN_PID" 2>/dev/null; then
        kill "$MAIN_PID" 2>/dev/null || true
        wait "$MAIN_PID" 2>/dev/null || true
    fi
}

trap cleanup INT TERM EXIT

nginx -g 'daemon off;'
