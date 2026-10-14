# syntax=docker/dockerfile:1

FROM node:26-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS build
# Fail a RUN when any command in a pipe fails, not only the last one (the checksum check below pipes into sha512sum).
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
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
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@owlwire/server... \
  && pnpm --filter @owlwire/server deploy --prod --legacy /out

FROM node:26-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# The server runs on node alone. The npm bundled with the base image is never used at runtime, and its own
# dependencies (undici, brace-expansion) are what the Trivy scan reports, so it is removed from the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && chmod +x /app/dist/main.js && ln -s /app/dist/main.js /usr/local/bin/owlwire
# The node user of the base image, by number, so that runtimes that check runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.OWLWIRE_PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["owlwire"]
CMD ["serve", "--role", "all"]
