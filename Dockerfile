FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

FROM nginx:1.28-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

FROM deps AS runtime
ENV NODE_ENV=production
COPY . .
RUN mkdir -p /app/server/.storage && chown -R node:node /app
USER node
EXPOSE 4000
CMD ["node", "server/index.js"]
