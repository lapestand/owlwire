# Owlwire

Owlwire is a source-available, self-hostable notification router. Your application sends one event over HTTP; Owlwire
routes it to the chats that subscribed to it on **WhatsApp**, **Telegram** and **Discord**.

It is multi-tenant from the start: one instance can serve many independent communities (workspaces), each with its
own connections, recipients and rules, isolated from each other at the database level.

> **Status: early development.** The data model, tenant isolation, encryption and a minimal Telegram delivery path
> are in place. WhatsApp, Discord, user accounts and the web UI are not implemented yet. Do not run it in
> production.

## How it works

```
your app ──POST /v1/events──▶ Owlwire ──rules──▶ deliveries ──▶ Telegram / WhatsApp / Discord
```

- **Workspace**: a community or team. Every row of tenant data belongs to exactly one workspace.
- **Installation**: an app connected to a workspace; it authenticates with its own token (`ow_inst_…`).
- **Connection**: a channel account the workspace owns (a Telegram bot, a WhatsApp number via
  [Evolution API](https://github.com/EvolutionAPI/evolution-api), a Discord bot or webhook).
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

## Running with Docker Compose

```sh
cd deploy/compose
cp .env.example .env   # fill in the passwords and OWLWIRE_KEK as described in the file
docker compose up -d
```

Upgrading an existing install: [deploy/compose/UPGRADING.md](deploy/compose/UPGRADING.md).

## Development

Everything runs inside a Docker toolbox container, so only Docker is needed on the host:

```sh
./dev pnpm install
./dev pnpm lint && ./dev pnpm typecheck
./dev pnpm test        # unit tests
./dev pnpm test:int    # integration tests (Testcontainers, needs the Docker socket)
```

Stack: TypeScript, Node.js, Hono, Drizzle ORM, PostgreSQL, Graphile Worker, React + Vite, pnpm + Turborepo.

## License

Owlwire is licensed under the [Business Source License 1.1](LICENSE).

- **Free** for individuals, non-profits and communities, and for any organisation that uses it to send
  notifications to its own members, employees, customers or users, including commercial organisations.
- **A commercial license is required** to offer Owlwire, or a modified version of it, to third parties as part of a
  paid product or service, for example a hosted notification service or a product that bundles it.
  Contact lapestand@gmail.com.
- Each version becomes available under the **Apache License 2.0** four years after it is published.

Copyright (c) 2026 İzzet Yılmaz.
