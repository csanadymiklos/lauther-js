# syntax=docker/dockerfile:1

# lauther-mcp speaks MCP over stdio. There is no port to expose and no
# HEALTHCHECK worth writing — run it with -i or the transport has nothing
# to read from.
#
#   docker build -t lauther-mcp .
#   docker run -i --rm -e LAUTHER_TOKEN=lpt_... lauther-mcp
#
# LAUTHER_TOKEN is REQUIRED, including for a bare introspection. Without it
# the process prints setup help and exits 0 straight away, which a harness
# reading stdio sees as a server that answered nothing — so pass a token even
# when all you want is tools/list. The token is not validated at startup, so a
# placeholder is enough to list the tools.

FROM node:22-alpine

WORKDIR /app

# Manifest first: editing src should not re-resolve the dependency tree.
# No lockfile is copied because this package is one workspace of a monorepo
# and the lockfile lives at the repo root; the three runtime dependencies are
# all pure JavaScript, so there is nothing to compile.
COPY package.json ./
RUN npm install --omit=dev --no-package-lock

COPY src ./src

ENTRYPOINT ["node", "src/index.js"]
