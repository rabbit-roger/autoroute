# Changelog

## 0.1.0 - 2026-11-08

First public release.

- Claude Code plugin that picks the model and effort for each task, opt-in per conversation (`/autoroute-on`) or for every conversation (plugin setting).
- One Claude Haiku classification per routed task; rules for Haiku, Sonnet and Opus; manual choices kept; prompt-cache switch guard; served-model self-check.
- Local service with a live dashboard: spend, saving against the most expensive model, cache hit rate, charts, request history, export and purge, light and dark themes.
- `autoroute setup` installs a login item on macOS, Linux and Windows.
