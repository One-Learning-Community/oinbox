# syntax=docker/dockerfile:1
# oinbox web image: builds the SPA and serves it with Caddy (deploy/Caddyfile), which also
# reverse-proxies Stalwart on the same origin. Used by deploy/docker-compose.yml (service `caddy`).

FROM node:24.19.0-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# .git is not in the build context, so the commit comes in as an argument.
ARG OINBOX_COMMIT=unknown
ENV OINBOX_COMMIT=$OINBOX_COMMIT
RUN pnpm build

FROM caddy:2.11.4-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv/oinbox/dist
EXPOSE 8080
