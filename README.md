# Autoroute

Autoroute picks the Claude model and effort level for each task you give Claude Code, so simple questions go to a cheaper, faster model and hard or risky work goes to the strongest one. A local dashboard shows what was routed where and what it cost.

- **Works in the Claude desktop app and the `claude` CLI**, on macOS, Linux and Windows.
- **Opt-in per conversation.** Nothing changes until you type `/autoroute-on` (or turn on routing for every new conversation in the plugin settings).
- **Local only.** A small service on `127.0.0.1` keeps the history. No prompts, responses, code or credentials are stored, and nothing is sent anywhere except the one classification call described below.

## How it decides

When routing is on, the first request of each task makes **one extra call to Claude Haiku at low effort**. It reads your prompt (the first 4,000 characters, any language) and answers with four facts: the kind of work, a complexity score from 0 to 8, whether the task is risky (deploys, deletes, auth, payments, databases, production), and whether it is too vague to judge. That call is billed to your plan like any other request and is shown separately in the dashboard.

From those facts a fixed set of rules chooses:

| Task | Model |
| --- | --- |
| Short, clear questions and docs edits (complexity 0-2) | Haiku |
| Ordinary features and bugs | Sonnet |
| Risky, complex (6+) or repeatedly failing work | Opus, with higher effort |

A few guards keep this safe and cheap:

- **Your own choices win.** If you pick a model or effort with `/model` or the picker, Autoroute keeps it until you run `/autoroute-on` again.
- **The prompt cache is respected.** Each model keeps its own cache, so moving down to a cheaper model mid-conversation re-reads the whole context. Autoroute only does that when the saving pays for it.
- **Failures fall back to your settings.** If the service is down, the classifier fails or Claude Code is too old, your own model and effort are used unchanged.
- **Self-check.** If Claude Code twice answers with a different model than the one requested, routing turns itself off in that conversation and tells you.

See [docs/how-it-works.md](docs/how-it-works.md) for the full rules and the list of reasons shown in the dashboard.

## Install

You need [Node.js](https://nodejs.org) 22.13 or newer and Claude Code 2.1.317 or newer.

**1. Install the service** (in a terminal):

```bash
npm install -g github:rabbit-roger/autoroute
```

```bash
autoroute setup
```

`setup` creates `~/.autoroute`, starts the service and makes it start at login (a LaunchAgent on macOS, a `systemd --user` unit on Linux, a hidden item in the Startup folder on Windows). Use `autoroute setup --no-autostart` to skip the login item and run `autoroute start` yourself.

**2. Add the Claude Code plugin.**

In a terminal session of Claude Code:

```
/plugin install autoroute --marketplace rabbit-roger/autoroute
```

In the Claude desktop app, click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter `rabbit-roger/autoroute`, then **Add plugin**.

**3. Turn it on** in a conversation:

```
/autoroute-on
```

## Use

| Command | What it does |
| --- | --- |
| `/autoroute-on` | Route this conversation from the next message on. Also releases models or efforts you chose by hand. |
| `/autoroute-off` | Stop routing this conversation. |
| `/autoroute-task-on <task>` | Route just this one task. |
| `/autoroute-task-off <task>` | Send just this one task with your own settings. |
| `/autoroute-status` | Show whether routing is on and what you chose by hand. |
| `/autoroute-dashboard` | Show the dashboard link. |

In the desktop app the commands appear in autocomplete after the first message of a conversation; before that you can type them in full.

**Plugin setting.** *Routing in new conversations* is `off` by default (routing starts with `/autoroute-on`). Set it to `on` to route every new conversation: run `/config` in a terminal session of Claude Code. The setting is saved in your user settings, so it applies to the desktop app too.

### Dashboard

```bash
autoroute dashboard
```

It opens `http://127.0.0.1:43821` and updates live. You get requests, spend, the saving against always using the most expensive model, token and cache totals, spend over time, cost by model and why each route was chosen, plus the full request history with export and purge. Filter by project, app (CLI or desktop) and time range. Light and dark themes are included.

**About the money figures.** Spend is the recorded tokens priced at Anthropic's published API list prices (see `config/prices.json` for the date). On a Claude subscription you do not pay per token, so read it as the size of your usage, not a bill. When Claude Code does not report how long a cache write was kept, the figure is an average of the two possible prices and is marked `~`.

### Service commands

```text
autoroute setup [--no-autostart]   create the data folder, start the service and start it at login
autoroute start | stop | status    control the background service
autoroute dashboard                open the dashboard
autoroute doctor                   check the installation
autoroute prices <file.json>       import a newer price list (service must be stopped)
autoroute catalog <file.json>      import a custom model catalog (service must be stopped)
autoroute export                   print all recorded data as JSON
autoroute purge --confirm          delete recorded history and conversation settings
autoroute uninstall [--purge]      remove the login item; --purge also deletes ~/.autoroute
```

Environment variables: `AUTOROUTE_DATA_DIR` (default `~/.autoroute`) and `AUTOROUTE_PORT` (default `43821`). If you change the data folder, set the same variable for Claude Code so the plugin finds it.

## Privacy

Stored in `~/.autoroute` on your machine, for 30 days: time, conversation and task identifiers, the project folder name, which app was used, requested and answered model, effort, token counts, the routing reasons and the conversation's routing setting.

Never stored: prompts, responses, file contents, tool output, error messages, API keys or account details. The prompt text is held in memory only until the classification call and sent only to that call.

The service listens on `127.0.0.1` only and accepts requests from the plugin with a random key kept in `~/.autoroute/token` (readable only by you). The dashboard answers only its own page.

## Uninstall

```bash
autoroute uninstall --purge
```

```bash
npm uninstall -g autoroute
```

Then remove the plugin with `/plugin` in Claude Code or under **Plugins** in the desktop app.

## Troubleshooting

- **Nothing shows up in the dashboard.** Run `autoroute doctor`. Check that the service is running and that the plugin is installed and enabled. Conversations that were open before setup need to be reopened.
- **"The local service is not running"** in Claude Code: run `autoroute start`.
- **"The service rejected this conversation's key"**: the service was set up again. Open a new conversation.
- **The answer came from a different model than expected.** Check `/autoroute-status`: a model you picked by hand is kept until `/autoroute-on`.

## Limitations

- Prices and the model list are a snapshot (see the dates in `config/`). Upgrading Autoroute refreshes them; you can import your own with `autoroute prices` and `autoroute catalog`.
- The routing rules are deliberately simple and have not been benchmarked against a fixed-model setup on real workloads. The dashboard's saving figure prices the same tokens at the most expensive model; it does not account for how a different model would have changed the conversation.
- Subagents are not routed.
- Windows support is covered by automated tests but has had less real-world use than macOS.

## Development

```bash
npm ci
```

```bash
npm test
```

`npm run build` compiles the service into `dist/` and bundles the plugin into `plugin/hooks/register.mjs`. Both are committed so that installing from GitHub needs no build step; CI checks they match the sources. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
