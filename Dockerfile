# Build the signalling server binary
FROM golang:1.18 AS signalling-builder

WORKDIR /app

COPY signalling/go.mod signalling/go.sum ./
RUN go mod download

COPY signalling/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o main ./cmd/signalling

# Build the frontend assets
FROM node:18-alpine AS frontend-builder

WORKDIR /app

RUN npm install -g yarn@1.22.22

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive

COPY tsconfig.json vite.config.ts tailwind.config.js postcss.config.js ./
COPY index.html manifest.json ./
COPY public ./public
COPY src ./src

RUN yarn build

# Final runtime image with Nginx and the signalling server
FROM nginx:alpine

RUN rm /etc/nginx/conf.d/default.conf \
    && apk --no-cache add ca-certificates gettext

WORKDIR /app

COPY --from=signalling-builder /app/main /usr/local/bin/main
COPY --from=frontend-builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/nginx.conf.template
COPY signalling/start.sh ./start.sh

RUN chmod +x ./start.sh

EXPOSE 80 443 18937

CMD ["/bin/sh", "./start.sh"]
