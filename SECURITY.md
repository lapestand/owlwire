# Security policy

## Supported versions

Owlwire is pre-1.0. Only the latest release on `main` receives security fixes. Fixes are not backported to older
versions.

## Reporting a vulnerability

Please do not report security problems in public issues, discussions or pull requests.

Report them through GitHub private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**, or go directly to
<https://github.com/lapestand/owlwire/security/advisories/new>. If you cannot use GitHub, email
lapestand@gmail.com.

Please include:

- the version or commit you tested;
- how Owlwire was deployed (the compose files in `deploy/compose` or something else) and the relevant configuration,
  with secrets removed;
- the affected component (for example the HTTP API, tenant isolation, encryption, the worker or a channel adapter);
- steps to reproduce, or a proof of concept;
- the impact as you understand it, for example which data another tenant can read or change.

## What to expect

Owlwire is maintained by one person, so timelines are best effort:

- I will acknowledge your report within 7 days.
- I will confirm whether it is a vulnerability and keep you updated while a fix is prepared.
- Once a fix is released, I will publish a GitHub security advisory and credit you, unless you prefer not to be
  named.

## Coordinated disclosure

Please give me a reasonable time to release a fix before you disclose the issue publicly. If you plan to publish,
let me know the date, and we can agree on a timeline together.

## Design and accepted risks

[docs/security.md](docs/security.md) describes the tenant isolation design, background jobs and the database
role check, and the risks that are accepted on purpose. Reports about a documented accepted risk are still welcome if
you find a way to exploit it beyond what is described there.
