# Owlwire

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lapestand/owlwire/badge)](https://scorecard.dev/viewer/?uri=github.com/lapestand/owlwire)

Owlwire is a source-available, self-hostable notification router. Your application sends an event once over HTTP;
Owlwire delivers it to everyone who subscribed to it, on whichever platform they use: chat apps such as WhatsApp,
Telegram and Discord, outgoing webhooks, and more over time. Channels are adapters, so new platforms can be added
without changing the core.

It is multi-tenant from the start: one instance can serve many independent communities (workspaces), each with its
own connections, recipients and rules, isolated from each other at the database level.

> **Status: early development.** The data model, tenant isolation, encryption and a minimal Telegram delivery path
> are in place. The other channels, user accounts and the web UI are not implemented yet. Do not run it in
> production.

## Channels

| Channel | Direction | Status |
|---|---|---|
| Telegram (shared bot or your own bot) | out | minimal delivery works, full adapter planned |
| WhatsApp (your own number, via [Evolution API](https://github.com/evolution-foundation/evolution-api)) | out | planned |
| Discord (bot or channel webhook) | out | planned |
| Outgoing webhooks (any HTTP endpoint, e.g. Slack, Teams, Matrix, n8n) | out | planned |
| Email | out | planned |
| HTTP API and incoming webhooks | in | available |
| Alertmanager, Grafana, Home Assistant | in | planned |

New channels are written against the adapter SDK in `packages/adapter-sdk`.

## How it works

```
your app ──POST /v1/events──▶ Owlwire ──rules──▶ deliveries ──▶ Telegram / WhatsApp / Discord / webhooks / …
```

- **Workspace**: a community or team. Every row of tenant data belongs to exactly one workspace.
- **Installation**: an app connected to a workspace; it authenticates with its own token (`ow_inst_…`).
- **Connection**: a channel account the workspace owns, for example a Telegram bot, a WhatsApp number, a Discord
  bot or an outgoing webhook.
- **Destination / audience**: a chat, group or channel to deliver to, and named groups of them.
- **Rule**: which event types (and severities) go to which destinations.

Delivery is at-least-once with deduplication, serialised per connection, through a PostgreSQL-backed job queue
written in the same transaction as the event (outbox).

## Security model

- PostgreSQL row level security on every tenant table; the server runs as a role that cannot bypass it, and
  refuses to start if it could.
- Connection secrets (bot tokens, webhook URLs, API keys) are encrypted with a per-workspace data key, which is
  wrapped by an instance key (`owlwire keys rotate` re-wraps without downtime).
- Append-only audit log; query parameters and secrets are scrubbed from logs and error responses.

See [docs/security.md](docs/security.md) for details and accepted risks.

## Sending an event

```sh
curl -X POST http://localhost:8080/v1/events \
  -H "Authorization: Bearer $OWLWIRE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"type":"player.inactive","severity":"warning","title":"Inactive","body":"Player X went inactive","idempotencyKey":"evt-123"}'
```

Installation tokens (`$OWLWIRE_TOKEN`) come with the apps and installations API, in a later release.

## Running with Docker Compose

```sh
cd deploy/compose
cp .env.example .env   # fill in the passwords and OWLWIRE_KEK as described in the file
docker compose up -d
```

Registration is closed by default. Create the first instance admin; the generated password is printed once:

```sh
docker compose exec owlwire owlwire admin create --email you@example.com
# or choose the password yourself (read it into $PASSWORD first, so it stays out of the shell history):
printf '%s' "$PASSWORD" | docker compose exec -T owlwire owlwire admin create --email you@example.com --password-stdin
```

Upgrading an existing install: [deploy/compose/UPGRADING.md](deploy/compose/UPGRADING.md).

## Development

Everything runs inside a Docker toolbox container, so only Docker is needed on the host:

```sh
./dev pnpm install
./dev pnpm lint && ./dev pnpm typecheck
./dev pnpm test        # unit tests
./dev pnpm test:int    # integration tests (Testcontainers, needs the Docker socket)
./dev pnpm test:coverage  # unit + integration coverage (v8), report in coverage/
./dev pnpm test:mutation  # Stryker mutation testing of the security-critical modules, report in reports/mutation/
```

Mutation testing covers tenant scoping, the crypto AEAD/DEK/keyring code, the audit secret guard and log
redaction (`stryker.config.mjs`). It takes the better part of an hour, so CI runs it weekly rather than on pull
requests and writes the score and the surviving mutants to the job summary.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) in English, for example
`fix(db): close scoped transactions on rollback`. Enable the local check with
`git config core.hooksPath tools/hooks`; CI runs the same check on every push and pull request.

Stack: TypeScript, Node.js, Hono, Drizzle ORM, PostgreSQL, Graphile Worker, React + Vite, pnpm + Turborepo.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems
privately as described in [SECURITY.md](SECURITY.md).

## License

Owlwire is licensed under the [Business Source License 1.1](LICENSE).

- **Free** for individuals, non-profits and communities, and for any organisation that uses it to send
  notifications to its own members, employees, customers or users, including commercial organisations.
- **A commercial license is required** to offer Owlwire, or a modified version of it, to third parties as part of a
  paid product or service, for example a hosted notification service or a product that bundles it.
  Contact lapestand@gmail.com.
- Each version becomes available under the **Apache License 2.0** four years after it is published.

Copyright (c) 2026 İzzet Yılmaz.
