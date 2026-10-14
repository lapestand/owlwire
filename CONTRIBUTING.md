# Contributing to Owlwire

Thanks for your interest in Owlwire. The project is in early development: the data model and internal APIs still
change often. Small fixes are welcome as pull requests. For anything larger (a new feature, a new channel adapter, a
schema change or a refactor), please open an issue first so we can agree on the approach before you spend time on it.

Security problems are not reported in public issues. See [SECURITY.md](SECURITY.md).

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Everything runs inside a Docker toolbox container through the `./dev` script, so only Docker is needed on the host.
`./dev <command>` runs the command in the container with the repository mounted at `/workspace`; `./dev` on its own
opens a shell.

```sh
./dev pnpm install
```

Set `OWLWIRE_DEV_PORTS=1` to publish ports 8080 (server) and 5173 (web) to the host. If your Docker socket is not
at `/var/run/docker.sock` or in `DOCKER_HOST`, set `OWLWIRE_DEV_DOCKER_SOCK` to its path.

## Checks and tests

```sh
./dev pnpm lint           # Biome, the system-mode guard, the .env.example sync check and knip
./dev pnpm depcruise      # dependency boundaries
./dev pnpm typecheck
./dev pnpm test           # unit tests
./dev pnpm test:int       # integration tests (Testcontainers, needs the Docker socket)
./dev pnpm test:coverage  # unit and integration coverage, report in coverage/
./dev pnpm format         # apply Biome formatting
```

CI runs the same checks, plus the build, migration checks, the Docker image smoke test, CodeQL, Gitleaks,
dependency review, actionlint, zizmor (workflow security) and typos (spelling, allowlist in `_typos.toml`).
hadolint lints Dockerfiles when they change, and lychee checks Markdown links when Markdown changes and weekly. A
Trivy scan of the Docker image runs on pull requests that touch the image inputs and weekly; it fails on high or
critical findings that have a fix. squawk lints the migrations a pull request adds or changes in
`packages/db/drizzle` for statements that lock or rewrite tables; rule choices and the `-- squawk-ignore <rule>`
escape hatch are explained in `.squawk.toml`.

## Tests

Behaviour changes need tests: a unit test where the logic allows it, and an integration test when the change touches
the database, the queue or a channel adapter.

Changes that touch tenant data need a cross-tenant case. `packages/db/src/cross-tenant.int.test.ts` keeps a registry
with one entry for every function exported from `packages/db/src/repos/index.ts`. Each entry is an attack run from
another workspace's scope: `read` (the result must contain no victim data), `denied` (the call must fail with
`RepoNotFoundError`) or `contained` (the victim's rows must not change). An `exempt` entry is allowed only with a
concrete reason. The registry test fails when an exported function has no entry or an entry has no function, so a
new repository function and its case land in the same pull request. The same file also checks that every public
table with a `workspace_id` column is listed in `VICTIM_TABLES`, and that every other table is a documented
exclusion. Do not loosen these tests to make a change pass.

## Branches and pull requests

`main` is protected. Every change goes through a pull request from a branch, and it can be merged only when the
required checks pass. Keep pull requests focused on one change, and rebase on `main` rather than merging `main` into
your branch.

If a change affects how Owlwire is deployed or upgraded, update `deploy/compose/UPGRADING.md`. If it changes the
security model or an accepted risk, update `docs/security.md`.

## Commit messages

Commit messages and pull request titles are checked by `scripts/check-commit-msg.mjs`, in CI and optionally on your
machine. To run the check locally on every commit:

```sh
git config core.hooksPath tools/hooks
```

The rules:

- Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional scope>): <description>`,
  for example `fix(db): close scoped transactions on rollback`. The scope is lowercase.
- Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Write in English.
- Start the description with a lowercase letter and do not end it with punctuation.
- Keep the header at 72 characters or less.
- Leave a blank line between the header and the body.
- Do not add `Co-authored-by` lines or tool attribution lines.

The pull request title follows the same rules, because a squash merge uses it as the commit message.

## Licensing of contributions

Owlwire is licensed under the [Business Source License 1.1](LICENSE), and the licensor also offers commercial
licenses. By submitting a contribution, you:

- confirm that you have the right to submit it;
- agree that it is licensed under the project's license;
- grant İzzet Yılmaz, the licensor, a perpetual, worldwide, non-exclusive, royalty-free right to use, modify,
  sublicense and relicense your contribution, including under commercial licenses.

A contributor license agreement may be required in the future.
