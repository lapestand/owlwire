# Development container used by ./dev (deploy/compose/docker-compose.dev.yml).
# The base digest is kept current by Dependabot (docker ecosystem, /docker).
FROM node:26-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssl \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g corepack@0.36.0 && corepack enable
RUN mkdir -p /workspace/node_modules /pnpm/store /home/dev \
  && chmod 1777 /workspace/node_modules /pnpm/store /home/dev
