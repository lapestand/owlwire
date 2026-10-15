# Upgrading the compose deployment

## To 0.36 (accounts and sign-in, auth database role)

1. **New required variables `OWLWIRE_DB_AUTH_PASSWORD` and `OWLWIRE_AUTH_SECRET`.** Sign-in data (sessions, password
   hashes, sign-in and reset tokens) lives in tables that only a third database role, `owlwire_auth`, can read. The
   application role `owlwire_app` loses all access to them and keeps a read-only view of a few user columns (id,
   name, email, image). Existing `.env` files need both lines, or `docker compose up` stops with
   `set OWLWIRE_DB_AUTH_PASSWORD in .env` or `set OWLWIRE_AUTH_SECRET in .env` before starting anything. Without
   compose, a missing `OWLWIRE_AUTH_SECRET` stops the server with a configuration error:

   ```sh
   echo "OWLWIRE_DB_AUTH_PASSWORD=$(openssl rand -hex 24)" >> .env
   echo "OWLWIRE_AUTH_SECRET=$(openssl rand -base64 32)" >> .env
   ```

   The compose file passes `OWLWIRE_AUTH_DATABASE_URL` (built from the password) to the server. On the next start,
   `owlwire serve` / `owlwire migrate` creates the role with that password and sets the grants of both roles. If
   the role already exists, its password is left untouched. If the migration role cannot create roles, create it
   yourself first (`CREATE ROLE owlwire_auth LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS`) and run
   `docker compose exec owlwire owlwire migrate`.

2. **`serve` checks the split on every start.** It refuses to start when `owlwire_app` can access the session,
   account, verification, two-factor, passkey or rate-limit tables, when the auth connection is `owlwire_app`, or
   when the auth role is a superuser, has `BYPASSRLS` or owns the tables. `OWLWIRE_ALLOW_INSECURE_DB_ROLE=true`
   turns these into warnings for single-role local development only, as for row level security. If you run without
   compose, set `OWLWIRE_AUTH_DATABASE_URL=postgres://owlwire_auth:<password>@<host>:5432/<db>` yourself.

3. **Behind a reverse proxy, set `OWLWIRE_TRUSTED_PROXIES`.** Sign-in attempts are rate limited per client address.
   By default the server uses the TCP peer and ignores `X-Forwarded-For`, so behind a proxy every user would share
   the proxy's limit. List the proxy's own address or subnet (for example `172.18.0.0/16` for a proxy container on
   the compose network); never a range that also contains clients, because a client in that range could then
   choose its own address.

4. **`OWLWIRE_PUBLIC_URL` must be `https://` for verification and password reset emails in production.** With an
   `http://` public URL the server skips those emails and logs a warning instead of sending a link that would expose
   its token in transit.

   Passkeys are bound to the host name of `OWLWIRE_PUBLIC_URL`. Changing that host later (a new domain, or moving
   from `localhost`) makes every registered passkey unusable; users then sign in with their password or a social
   account and register a new passkey. An IP address as the host does not work for passkeys at all, and `serve`
   warns about it. With `NODE_ENV=production`, `serve` also warns when `OWLWIRE_SMTP_URL` is `smtp://` without
   `?requireTLS=true`; use `smtps://` or add that flag so mail with sign-in links cannot be downgraded to clear text.

   **Setting `OWLWIRE_SMTP_URL` on an instance that ran without it** turns on email verification for password
   sign-in. Accounts created with email and password while SMTP was off are unverified, so their password sign-in
   answers `403 EMAIL_NOT_VERIFIED` until the user requests a verification email and follows the link (the link
   verifies only; the user then signs in as usual, with the second factor if it is on). Passkey and linked social
   sign-in keep working, accounts that signed up through a provider are already verified, and so are accounts
   created with `owlwire admin create`. Tell your users before you turn SMTP on.

5. **Create an instance admin.** Registration is `closed` by default (personal profile), so nobody can sign up
   until an admin exists or the mode is changed. Run
   `docker compose exec owlwire owlwire admin create --email you@example.com`; it creates the user with a verified
   email and prints a generated password once (or reads one with `--password-stdin`), or promotes an existing user.
   `serve` logs a warning on every start while no admin exists.

6. **The development surface is gone.** `OWLWIRE_DEV_ADMIN_TOKEN`, `OWLWIRE_DEV_FAKE_ADAPTER`, the `/api/dev/*`
   endpoints, the `dev:seed` command and the dev panel of the web UI are removed:

   - `/api/dev/*` answers `404`, and the old token grants nothing. Sign in as an instance admin instead (item 5,
     `owlwire admin create`) and use the management API under `/api`.
   - The server no longer registers the logging fake adapter for the `webhook` platform. Existing `webhook`
     connections created with it stop delivering (their deliveries fail with no adapter for the platform).
   - The web UI shows a placeholder page until the management interface ships.
   - Remove both variables from `.env`. While either is still set, `serve` logs a warning on every start; its value is
     ignored.

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
