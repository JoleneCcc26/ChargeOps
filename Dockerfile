# Three images come out of this file, all from one source tree:
#   web      Nginx serving the built React app
#   runtime  Node running the API, the workers or the traffic simulator
# Each stage installs only what it needs, so the runtime image never carries a
# compiler, a bundler or a React package it would not load.

# ── Build-time dependencies (everything, including Vite and TypeScript) ───────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Front end bundle ─────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

FROM nginx:1.28-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

# ── Runtime dependencies only ────────────────────────────────────────────────
# `--omit=dev` drops Vite, TypeScript, ESLint and the React packages, which the
# server never imports: the front end is already bundled into the web image.
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── API, workers and traffic simulator ───────────────────────────────────────
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
# Only the files the server actually loads. No React source, no build tooling,
# no course deliverables — see .dockerignore for the rest.
COPY package.json ./
COPY server ./server
COPY scripts ./scripts
RUN mkdir -p /app/server/.storage && chown -R node:node /app
USER node
EXPOSE 4000
CMD ["node", "server/index.js"]
