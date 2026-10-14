# Upgrading the compose deployment

## To 0.35 (two database roles, row level security)

1. **New required variable `OWLWIRE_DB_APP_PASSWORD`.** The server now connects as the application role `owlwire_app`,
   which is subject to row level security. Migrations run as the owner role `owlwire` (`OWLWIRE_DB_OWNER_PASSWORD`).
   Existing `.env` files need the new line, or `docker compose up` stops with
   `set OWLWIRE_DB_APP_PASSWORD in .env`:

   ```sh
   echo "OWLWIRE_DB_APP_PASSWORD=$(openssl rand -hex 24)" >> .env
   ```

   On the first start, `owlwire serve` / `owlwire migrate` creates the role with that password. If the role already
   exists, its password is left untouched.

2. **Upgrade every Owlwire process before writing new connections.** Migration `0006` changes the default of
   `connections.config_enc_scheme` from `kek_v0` to `dek_v1`. Existing rows keep `kek_v0`, and the server re-encrypts
   them with workspace keys when it starts. During a rolling upgrade (for example separate `--role api` and
   `--role worker` processes), an older process that still inserts connections (only `dev:seed` does) would write
   rows that the new code cannot decrypt. Stop or upgrade all old processes first, then run `dev:seed`.

3. **`OWLWIRE_ALLOW_INSECURE_DB_ROLE` (local development only).** `serve` refuses to start when its database
   connection can bypass row level security: a superuser, `BYPASSRLS`, or the table owner. The usual cause is that
   `OWLWIRE_DATABASE_URL` and `OWLWIRE_MIGRATION_DATABASE_URL` use the same role. For a single-role local database,
   `OWLWIRE_ALLOW_INSECURE_DB_ROLE=true` lets it start and logs each reason as a warning. It is ignored when
   `NODE_ENV=production`, which the Owlwire image sets. Keep it `false` in any real deployment.

4. **The server container is hardened.** `docker-compose.yml` now runs `owlwire` with a read-only root filesystem,
   all Linux capabilities dropped and `no-new-privileges`. The image already ran as the non-root user `1000:1000`.
   The server writes nothing to disk, so no change is needed. If you added your own mounts or tooling that writes
   inside the `owlwire` container, give it a dedicated volume or `tmpfs` path instead.
