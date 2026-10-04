FROM node:20-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
COPY docs/openapi.yaml ./docs/openapi.yaml
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/public ./public
COPY --from=build /app/docs/openapi.yaml ./docs/openapi.yaml

ENV NODE_ENV=production
ENV DB_PATH=/data/xahauindex.db
ENV API_HOST=0.0.0.0
ENV API_PORT=3000

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:3000/v1/status').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
