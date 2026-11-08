# How Autoroute decides

## The flow

1. You send a message in a conversation where routing is on.
2. The plugin asks Claude Haiku (low effort) to classify the task. The prompt is cut to 4,000 characters and wrapped so the model treats it as data, not instructions. The answer must be a strict JSON object:

   ```json
   {"activity": "explain|docs|implement|debug|plan|review", "complexity": 0, "risk": false, "uncertain": false}
   ```

   Any other answer, a timeout (8 seconds) or an error means your own settings are used for that task.
3. The service picks a tier from the classification:
   - **strong** (Opus) when the task is risky, complexity is 6 or more, or verification failed twice in this task;
   - **light** (Haiku) when complexity is 2 or less, the task is clear, and it is an explanation or a docs change;
   - **balanced** (Sonnet) otherwise.
4. Effort is the model's default, raised to at least `high` for risky or complex tasks and raised one step after a failed test run.
5. The plugin rewrites the model and effort of each request in that task. Subagents keep their own settings.

The classification happens once per task. Follow-up requests in the same task (tool calls, steps) reuse the decision.

## Guards

- **Manual choices.** Choosing a model with `/model` or the picker pins it. Choosing an effort pins it. `/autoroute-on` releases the pins.
- **Prompt cache.** Every model has its own prompt cache, so moving to a cheaper model in the middle of a conversation re-reads the whole context at full price. While the cache is assumed warm (up to one hour after the last request), a move down happens only if the expected saving over the task (2 + complexity steps, 600 output tokens each, at the imported prices) is larger than that one-time cost. Moving up is never delayed.
- **Escalation from evidence.** Editing a file whose path looks security-sensitive marks the task risky. A test, build or lint command that fails again after an edit counts as a failure.
- **Host version.** Claude Code older than the catalog's `minHostVersion` is never routed.
- **Served model check.** If Claude Code twice answers with a different model than the one requested, routing turns off in that conversation.

## Reasons in the dashboard

| Reason | Meaning |
| --- | --- |
| `routing-off` | Routing was switched off for this conversation, so the model and effort you chose yourself were used unchanged. |
| `hard-risk-floor` | The task looked risky (deploys, deletes, security, payments, databases, production), so Autoroute used the strongest model. |
| `cache-switch-paid-back` | A cheaper model was chosen even though it means re-reading the conversation, because the saving on this task is larger than that one-time cost. |
| `cache-switch-not-paid-back` | A cheaper model was possible, but the current model kept its memory (cache) of the conversation. Switching would cost more than it saves on this task, so it stayed. |
| `cache-switch-context-unknown` | A cheaper model was possible, but the size of the conversation was unknown, so the model was not changed. |
| `cache-switch-unpriced-large-context` | A cheaper model was possible, but the conversation is large and a price for it is missing, so the model was not changed. |
| `cache-switch-unpriced-small-context` | A cheaper model was chosen. Its price is missing, but the conversation is small, so switching is safe. |
| `cache-switch-price-range-unavailable` | A cheaper model was possible, but the cost of switching could not be estimated, so the model was not changed. |
| `cache-cold-switch` | The model had been idle long enough that its memory of the conversation expired, so switching models cost nothing extra. |
| `manual-model-pin` | You picked the model yourself. Autoroute respects that choice until you run /autoroute-on again. |
| `manual-effort-pin` | You picked the effort level yourself. Autoroute keeps it until you run /autoroute-on again. |
| `risk-floor-pin-conflict` | You picked a model weaker than the task seems to need. Your choice was kept. |
| `unsupported-effort-pin` | The effort you picked is not available on the chosen model, so it was not applied. |
| `no-confirmed-route` | No verified model fits this task (for example an image is attached), so the model was left unchanged. |
| `host-version-unsupported` | This Claude Code version is older than Autoroute supports, so nothing was changed. Update Claude Code. |
| `baseline-capability-unknown` | The model you were using is not in the confirmed list, so nothing was changed. |
| `observation` | A request that was only observed, with no routing decision. |

The dashboard hides two technical reasons that are always present on routed requests: `complexity-N` (the classifier's score) and `activity-X` (the kind of work).

## Model catalog and prices

`config/catalog.json` lists the models Autoroute may choose from, their tier, supported effort levels, context window and relative cost. It ships with the package and is replaced when you upgrade, unless you imported your own with `autoroute catalog <file>` (a custom catalog is kept).

`config/prices.json` holds the per-million-token list prices used for the spend and saving figures and for the cache guard. A newer bundled price list replaces an older one on upgrade; `autoroute prices <file>` imports your own. Each entry needs `host`, `model`, an ISO `date`, an `https://` `source`, and `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` rates. A `longContext` block sets the rates above a prompt-size threshold.
