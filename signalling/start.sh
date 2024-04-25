#!/bin/bash

# Environment variables or default values
LISTEN_ADDRESS=${LISTEN_ADDRESS:-"0.0.0.0"}
PORT=${PORT:-5000}
CORS_ENDPOINT=${CORS_ENDPOINT:-"http://localhost:3000"}
TURN_REALM=${TURN_REALM:-"localhost:3000"}
TURN_LISTEN_IP=${TURN_LISTEN_IP:-"0.0.0.0"}
PUBLIC_IP=${PUBLIC_IP:-"0.0.0.0"}
TURN_PORT=${TURN_PORT:-18937}

# Generate kabootar.toml
cat <<EOF > kabootar.toml
listen_address = "${LISTEN_ADDRESS}:${PORT}"
cors_endpoint = "${CORS_ENDPOINT}"
turn_realm = "${TURN_REALM}"
turn_listen_ip = "${TURN_LISTEN_IP}"
public_ip = "${PUBLIC_IP}"
turn_port = ${TURN_PORT}
EOF

# Start the Go application
./main