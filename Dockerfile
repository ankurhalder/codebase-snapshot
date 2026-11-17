# syntax=docker/dockerfile:1
# Runs the published bundle as a non-root user and serves the browser page and MCP on 4788.
#
#   npm run build
#   docker build -t codebase-snapshot .
#   docker run --rm -p 4788:4788 -e SNAPSHOT_TOKEN=change-me codebase-snapshot
#
# The image is not published to a registry by this repository; build it where you need it.
FROM node:22.11.0-alpine3.20
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY dist ./dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 4788
ENTRYPOINT ["docker-entrypoint.sh"]
