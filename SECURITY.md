# Security

Autoroute runs a service on `127.0.0.1` that only the Claude Code plugin and the dashboard page talk to.

- Plugin requests carry a random 256-bit key stored in `~/.autoroute/token` and `~/.autoroute/connection.json`, created with owner-only permissions.
- Requests must use the exact `127.0.0.1:<port>` host, and a browser `Origin` other than the dashboard's own is refused. The dashboard's read, export and purge calls are allowed without the key only from its own page (`Sec-Fetch-Site: same-origin` plus a custom header that a cross-site page cannot send without a preflight).
- The dashboard has a strict Content Security Policy and loads nothing from the internet.
- Prompts, responses, file contents and credentials are never stored.

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/rabbit-roger/autoroute/security/advisories/new) instead of a public issue. Include the version (`autoroute --version`), your OS and steps to reproduce.
