# Contributing

Issues and pull requests are welcome.

## Setup

```bash
npm ci
npm test
```

Node.js 22.13 or newer is required.

## Layout

| Path | Contents |
| --- | --- |
| `src/core/` | Routing policy, classifier, command parser, usage and price math |
| `src/adapters/claude.ts` | The Claude Code plugin's hooks |
| `src/service/` | The local HTTP service and its SQLite store |
| `src/cli/` | The `autoroute` command |
| `web/` | The dashboard (plain HTML, CSS and JavaScript, no build) |
| `plugin/` | The plugin as installed from the marketplace |
| `config/` | Bundled model catalog and prices |

## Rules

- `dist/` and `plugin/hooks/register.mjs` are build output and are committed. Run `npm run build` and commit them with your change; CI fails if they are out of date.
- The plugin bundle must pass `claude plugin validate plugin`.
- `web/app.js` is loaded as a classic script: no `import`/`export`.
- Never store prompt text, responses, file contents or credentials.
- Any failure must leave the user's own model and effort in place.
