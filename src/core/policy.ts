import type { CacheContext, Capabilities, Candidate, Decision, Effort, Features, Route, Session, Task, Tier } from './types.js';
import { effectiveRates, type Price } from './usage.js';
export const POLICY_VERSION = 'balanced-2';
const ranks: Record<Tier, number> = { light: 0, balanced: 1, strong: 2 };
const effortRanks: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export function features(text: string, attachment = false): Features {
  // Do not persist this text or path matches. Unknown tasks cannot qualify as trivial.
  const mutation = /\b(fix|change|implement|add|delete|remove|migrate|deploy|refactor)\b/iu.test(text);
  const consequential = /\b(auth|oauth|credentials?|payments?|billing|migrations?|security|sql|concurrency|race condition|production|schema|irreversible)\b/iu.test(text);
  const debug = /\b(debug|bug|race|crash|flaky)\b/iu.test(text);
  const plan = /\b(architect|design|plan)\b/iu.test(text);
  const explain = /\b(explain|find|where|search)\b/iu.test(text);
  const docs = /\b(document|readme|typo|comment)\b/iu.test(text);
  const review = /\b(review|audit)\b/iu.test(text);
  const ambiguous = text.trim().length < 12 || /\b(maybe|somehow|everything|unknown)\b/iu.test(text);
  const scope = /\b(across|multiple|monorepo|repository|system)\b/iu.test(text) ? 2 : 0;
  const dependent = /\b(then|integrate|end.to.end|pipeline)\b/iu.test(text) ? 2 : 0;
  const knownSimple = (explain || docs) && !mutation && !debug && !plan && !attachment && text.length < 800;
  const uncertain = ambiguous || (!mutation && !explain && !docs && !review && !debug && !plan);
  return { complexity: Math.min(8, (ambiguous ? 2 : 0) + scope + dependent + (debug || plan ? 2 : 0) + (knownSimple ? 0 : 2)), risk: mutation && consequential, uncertain, attachment, activity: debug ? 'debug' : plan ? 'plan' : review ? 'review' : docs ? 'docs' : explain ? 'explain' : 'implement' };
}
/** Compares dotted numeric versions such as 2.1.317. Anything unparsable counts as too old. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : undefined;
  const a = parse(version), b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (x !== y) return x > y; }
  return true;
}
/** Routing needs a catalog for this host with at least two models, and a host at least as new as the catalog requires. */
export function validCapabilities(c: Capabilities | undefined, s: Session): boolean {
  return !!c && c.host === s.host && versionAtLeast(s.hostVersion, c.minHostVersion) && c.candidates.length >= 2;
}
// Assumptions for the switch-cost guard. The cache lifetime depends on billing (one hour on a subscription, five minutes
// otherwise) and is not visible to the mod, so the longer one is assumed: a wrong guess only forgoes a saving.
export const CACHE_WARM_MS = 3_600_000;
const ASSUMED_OUTPUT_TOKENS_PER_STEP = 600;
const UNPRICED_HOLD_CONTEXT_TOKENS = 100_000;
/** Decides whether moving to a cheaper model is worth the uncached re-read of the context. Returns the reason either way. */
export function switchHeld(contextTokens: number | undefined, complexity: number, from?: Price, to?: Price): { hold: boolean; reason: string } {
  if (contextTokens === undefined) return { hold: true, reason: 'cache-switch-context-unknown' };
  if (!from || !to || [from.input, from.output, from.cacheRead, to.input, to.output, to.cacheRead].some(v => !Number.isFinite(v))) return contextTokens >= UNPRICED_HOLD_CONTEXT_TOKENS ? { hold: true, reason: 'cache-switch-unpriced-large-context' } : { hold: false, reason: 'cache-switch-unpriced-small-context' };
  if ((from.maxContext !== undefined && contextTokens > from.maxContext) || (to.maxContext !== undefined && contextTokens > to.maxContext)) return { hold: true, reason: 'cache-switch-price-range-unavailable' };
  const m = contextTokens / 1e6;
  const f = effectiveRates(from, contextTokens), t = effectiveRates(to, contextTokens);
  const oneTime = m * Math.max(t.input, t.cacheWrite5m ?? 0) - m * f.cacheRead;
  const perStep = m * (f.cacheRead - t.cacheRead) + (ASSUMED_OUTPUT_TOKENS_PER_STEP / 1e6) * (f.output - t.output);
  const saving = (2 + complexity) * perStep;
  return saving >= oneTime ? { hold: false, reason: 'cache-switch-paid-back' } : { hold: true, reason: 'cache-switch-not-paid-back' };
}
export function decide(s: Session, t: Task, caps?: Capabilities, prices: Price[] = [], cache?: CacheContext): Decision {
  const pass = (reason: string): Decision => ({ action: 'passthrough', route: t.baseline, reasons: [reason], policyVersion: POLICY_VERSION });
  if (!t.enabled) return pass('routing-off');
  if (!validCapabilities(caps, s)) return pass('host-version-unsupported');
  const f = t.features;
  const tier: Tier = f.risk || f.complexity >= 6 || t.failures >= 2 ? 'strong' : f.complexity <= 2 && !f.uncertain && (f.activity === 'explain' || f.activity === 'docs') ? 'light' : 'balanced';
  const baselineCapability=caps!.candidates.find(c=>c.model===t.baseline.model);
  if(!baselineCapability)return pass('baseline-capability-unknown');
  const candidates = caps!.candidates.filter(c => (!f.attachment || c.modalities.includes('image')) && c.contextWindow >= baselineCapability.contextWindow).sort((a,b) => ranks[a.tier] - ranks[b.tier] || a.relativeCost - b.relativeCost);
  let candidate = s.pins.model ? candidates.find(c => c.model === s.pins.model) : candidates.find(c => ranks[c.tier] >= ranks[tier]);
  if (!candidate) return pass('no-confirmed-route');
  const reasons = [f.risk ? 'hard-risk-floor' : `complexity-${f.complexity}`, `activity-${f.activity}`];
  // Only a cost-saving move down is ever held; upgrades and risk floors are never delayed by cache economics.
  if (!s.pins.model && cache?.lastModel && cache.lastModel !== candidate.model) {
    const incumbent = candidates.find(c => c.model === cache.lastModel);
    if (incumbent && ranks[candidate.tier] < ranks[incumbent.tier]) {
      if (cache.idleMs !== undefined && cache.idleMs >= CACHE_WARM_MS) reasons.push('cache-cold-switch');
      else {
        const g = switchHeld(cache.contextTokens, f.complexity, prices.find(p => p.model === incumbent.model), prices.find(p => p.model === candidate!.model));
        reasons.push(g.reason);
        if (g.hold) candidate = incumbent;
      }
    }
  }
  if (s.pins.model) reasons.push('manual-model-pin', ...(ranks[candidate.tier] < ranks[tier] ? ['risk-floor-pin-conflict'] : []));
  let effort = s.pins.effort ?? candidate.defaultEffort;
  if (!s.pins.effort && (f.risk || f.complexity >= 6 || t.failures > 0)) {
    const current = t.route?.effort ?? effort;
    const index = effortRanks.indexOf(current ?? 'medium');
    effort = candidate.efforts.find(e => effortRanks.indexOf(e) >= Math.max(index + (t.failures ? 1 : 0), 2)) ?? candidate.efforts.at(-1);
  }
  if (s.pins.effort) reasons.push('manual-effort-pin');
  if (effort && !candidate.efforts.includes(effort)) return pass('unsupported-effort-pin');
  return { action: 'apply', route: { model: candidate.model, ...(effort ? { effort } : {}) }, reasons, policyVersion: POLICY_VERSION };
}
export function rewrite<T extends Route>(event: T, decision: Decision): T {
  if (decision.action !== 'apply') return event;
  const request = { ...event, model: decision.route.model };
  if (decision.route.effort) request.effort = decision.route.effort; else delete request.effort;
  return request;
}
export function assertCatalog(raw: unknown): asserts raw is Capabilities {
  const c = raw as Capabilities;
  if (!c || c.host !== 'claude' || typeof c.catalogVersion !== 'string' || !c.catalogVersion || typeof c.minHostVersion !== 'string' || !/^\d+(\.\d+)*$/.test(c.minHostVersion) || !['bundled','custom'].includes(c.source) || !Array.isArray(c.candidates) || c.candidates.length < 2) throw new Error('Invalid model catalog');
  if (new Set(c.candidates.map(x => x.model)).size !== c.candidates.length) throw new Error('Duplicate model');
  for (const x of c.candidates) if (!x || typeof x.model !== 'string' || !/^[a-zA-Z0-9._:/\[\]-]{1,160}$/.test(x.model) || !(x.tier in ranks) || !Array.isArray(x.efforts) || x.efforts.some(e => !effortRanks.includes(e)) || (x.defaultEffort && !x.efforts.includes(x.defaultEffort)) || !Number.isFinite(x.contextWindow) || x.contextWindow <= 0 || !Array.isArray(x.modalities) || !Number.isFinite(x.relativeCost) || x.relativeCost < 0) throw new Error('Invalid model capability');
}
