# Development container used by ./dev (deploy/compose/docker-compose.dev.yml).
# The base digest is kept current by Dependabot (docker ecosystem, /docker).
FROM node:26-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0
# Fail a RUN when any command in a pipe fails, not only the last one (the checksum check below pipes into sha512sum).
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# Debian replaces package versions in place on security updates, so exact apt pins would break this build within
# weeks. The base image is pinned by digest and Dependabot bumps it; apt installs the current Debian release of these.
# procps provides `ps`, which Stryker (pnpm test:mutation) uses to stop its test runner processes.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssl procps \
  && rm -rf /var/lib/apt/lists/*
# corepack is installed from the exact npm registry tarball, checked against pinned digests (BuildKit verifies the
# sha256 on download, sha512sum the npm `dist.integrity`), instead of `npm install -g`, which cannot pin by hash.
# The node 26 image no longer bundles corepack. To bump: update the URL, the sha256 and the sha512 (the hex form of
# `npm view corepack@<version> dist.integrity`).
ADD --checksum=sha256:9128cfe26aee0c99f4fc68c15c6b8b12309a68be0de2c012cdfea2a463cb722f \
  https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz /tmp/corepack.tgz
RUN echo "4a2889b01859a9d0623c74c497a393dec012ad1aca21c61340cb15197c7a104fe033c5853306237885fc4edf11894e08bf627a2db4fc2a919f08eb01a51581ff  /tmp/corepack.tgz" | sha512sum -c - \
  && mkdir -p /usr/local/lib/node_modules/corepack \
  && tar -xzf /tmp/corepack.tgz --no-same-owner --strip-components=1 -C /usr/local/lib/node_modules/corepack \
  && rm /tmp/corepack.tgz \
  && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
  && corepack enable
RUN mkdir -p /workspace/node_modules /pnpm/store /home/dev \
  && chmod 1777 /workspace/node_modules /pnpm/store /home/dev
