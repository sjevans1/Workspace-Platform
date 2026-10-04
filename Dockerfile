FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 API_INTERNAL_URL=http://api:4000
RUN npm run typecheck && npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# Apply available Debian security fixes to the shipped runtime image.
# Keep Trivy HIGH/CRITICAL blocking; never rely on a waived vulnerability.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p /data/files /backups \
    && chown -R node:node /data /backups
USER node
EXPOSE 3000 4000 1234
CMD ["node","--import","tsx","apps/api/src/main.ts"]
