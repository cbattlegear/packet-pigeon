FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.mjs scripts/lan-companion.mjs ./scripts/
COPY src/radio/lan-bridge.ts src/radio/transport.ts ./src/radio/
USER node
EXPOSE 4175
CMD ["node", "scripts/docker-entrypoint.mjs"]
