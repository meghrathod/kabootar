# Use the official Golang image to create a build artifact.
FROM golang:1.18 as builder

WORKDIR /app

# Copy the Go Modules manifests
COPY signalling/go.mod signalling/go.sum ./
# Download the dependencies
RUN go mod download

# Copy the source code from the signalling directory
COPY signalling/ .

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -o main ./cmd/signalling

# Start a new stage from scratch
FROM alpine:latest  

RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy the pre-built binary file from the previous stage
COPY --from=builder /app/main .

# Copy the start.sh script
COPY signalling/start.sh .

# Ensure start.sh is executable
RUN chmod +x start.sh

# Expose the port the app runs on
EXPOSE 4000

# Use the start script as the entry point
# cat the generated start.sh script to see the contents
RUN [ "cat", "start.sh"]
CMD ["/bin/sh", "./start.sh"]