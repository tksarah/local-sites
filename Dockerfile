FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY windows-setup ./windows-setup
COPY plugins ./plugins
COPY scripts/build-setup.mjs ./scripts/build-setup.mjs
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/windows-setup ./windows-setup
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/scripts/build-setup.mjs ./scripts/build-setup.mjs
COPY scripts/token.mjs ./scripts/token.mjs
COPY package.json ./
CMD ["node", "dist/server.js"]
