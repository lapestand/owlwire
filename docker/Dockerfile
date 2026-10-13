# syntax=docker/dockerfile:1

FROM node:26-trixie-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g corepack@latest && corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@owlwire/server...
RUN pnpm --filter @owlwire/server deploy --prod --legacy /out

FROM node:26-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
RUN chmod +x /app/dist/main.js && ln -s /app/dist/main.js /usr/local/bin/owlwire
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.OWLWIRE_PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["owlwire"]
CMD ["serve", "--role", "all"]
