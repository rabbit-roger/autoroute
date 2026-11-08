export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Host = 'claude';
export type Tier = 'light' | 'balanced' | 'strong';
export type Features = { complexity: number; risk: boolean; activity: 'explain' | 'docs' | 'implement' | 'debug' | 'plan' | 'review'; uncertain: boolean; attachment: boolean };
export type Candidate = { model: string; tier: Tier; efforts: Effort[]; defaultEffort?: Effort; contextWindow: number; modalities: string[]; relativeCost: number };
/** The models Autoroute may choose between. `bundled` ships with the package and is refreshed on upgrade; `custom` is imported by the user and kept. */
export type Capabilities = { host: Host; catalogVersion: string; minHostVersion: string; source: 'bundled' | 'custom'; candidates: Candidate[] };
export type Pins = { model?: string; effort?: Effort };
export type Route = { model: string; effort?: Effort };
export type Decision = { action: 'apply' | 'passthrough'; route: Route; reasons: string[]; policyVersion: string };
export type Session = { key: string; host: Host; hostVersion: string; enabled: boolean; pins: Pins; revision: number; lastRoute?: Route; dwell: number };
export type Task = { id: string; key: string; nativeTurnId: string; owner: string; enabled: boolean; override?: boolean; features: Features; state: 'running' | 'completed' | 'cancelled' | 'abandoned' | 'incomplete'; baseline: Route; route?: Route; failures: number; evidence: string[]; createdAt: string };
export type Usage = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null; cacheWrite5m?: number | null; cacheWrite1h?: number | null };
export type Event = { schemaVersion: 1; eventId: string; key: string; host: Host; taskId?: string; turnId?: string; agentId?: string; timestamp: string; kind: string; requestedModel?: string; observedModel?: string; requestedEffort?: Effort; reasons?: string[]; usage?: Usage; provenance: 'host' | 'router' | 'estimate'; coverage: 'request-only' | 'unknown'; status?: string; project?: string; app?: 'desktop' | 'cli'; hostVersion?: string };

/** What the adapter knows about the prompt cache: the model of the last main-loop request, time since then, and current context size. */
export type CacheContext = { lastModel?: string; idleMs?: number; contextTokens?: number };
