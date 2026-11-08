const count = (x) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null;
export function normalize(_host, raw) {
    const r = raw ?? {};
    return { input: count(r.input_tokens), output: count(r.output_tokens), cacheRead: count(r.cache_read_input_tokens), cacheWrite: count(r.cache_creation_input_tokens), reasoning: null, cacheWrite5m: count(r.cache_creation?.ephemeral_5m_input_tokens), cacheWrite1h: count(r.cache_creation?.ephemeral_1h_input_tokens) };
}
/** The rates a request with this many prompt tokens is billed at. */
export function effectiveRates(p, promptTokens) {
    return p.longContext && promptTokens > p.longContext.threshold ? p.longContext : p;
}
/** Validates a dated list-price import. Standard list prices only, USD per million tokens. */
export function assertPrices(raw) {
    if (!Array.isArray(raw) || !raw.length)
        throw new Error('Supply a non-empty array of prices');
    const seen = new Set(), rate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    for (const p of raw) {
        if (!p || p.host !== 'claude' || typeof p.model !== 'string' || !/^[a-zA-Z0-9._:/\[\]-]{1,160}$/.test(p.model) || seen.has(p.model))
            throw new Error('Invalid or duplicate price entry');
        seen.add(p.model);
        if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !Number.isFinite(Date.parse(p.date)))
            throw new Error(`Invalid date for ${p.model}`);
        if (typeof p.source !== 'string' || !p.source.startsWith('https://'))
            throw new Error(`HTTPS source required for ${p.model}`);
        if (!rate(p.input) || !rate(p.output) || !rate(p.cacheRead))
            throw new Error(`input, output and cacheRead rates required for ${p.model}`);
        for (const k of ['cacheWrite5m', 'cacheWrite1h'])
            if (p[k] !== undefined && !rate(p[k]))
                throw new Error(`Invalid ${k} for ${p.model}`);
        if (p.maxContext !== undefined && !(Number.isInteger(p.maxContext) && p.maxContext > 0))
            throw new Error(`Invalid maxContext for ${p.model}`);
        if (p.longContext !== undefined) {
            const l = p.longContext;
            if (!l || !(Number.isInteger(l.threshold) && l.threshold > 0) || !rate(l.input) || !rate(l.output) || !rate(l.cacheRead) || ['cacheWrite5m', 'cacheWrite1h'].some(k => l[k] !== undefined && !rate(l[k])))
                throw new Error(`Invalid longContext for ${p.model}`);
        }
    }
}
export function equivalent(u, p) {
    if (!p || u.input === null || u.output === null || u.cacheRead === null)
        return null;
    const prompt = u.input + u.cacheRead + (u.cacheWrite ?? 0);
    if (p.maxContext !== undefined && prompt > p.maxContext)
        return null;
    const r = effectiveRates(p, prompt);
    let writes = 0;
    if (u.cacheWrite && u.cacheWrite > 0) {
        if (u.cacheWrite5m == null || u.cacheWrite1h == null || u.cacheWrite5m + u.cacheWrite1h !== u.cacheWrite || r.cacheWrite5m === undefined || r.cacheWrite1h === undefined)
            return null;
        writes = u.cacheWrite5m * r.cacheWrite5m + u.cacheWrite1h * r.cacheWrite1h;
    }
    return (u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + writes) / 1e6;
}
/**
 * API-equivalent cost as a range. When the host does not report the cache-write TTL split, all written tokens are priced once
 * at the 5-minute and once at the 1-hour rate, so the true list-price cost lies between `low` and `high`. Null means unknown.
 */
export function equivalentRange(u, p) {
    if (!u || !p || u.input === null || u.output === null || u.cacheRead === null)
        return null;
    const exact = equivalent(u, p);
    if (exact !== null)
        return { low: exact, high: exact };
    const w = u.cacheWrite ?? 0;
    if (w <= 0 || u.cacheWrite5m != null || u.cacheWrite1h != null)
        return null; // inconsistent split stays unknown
    const prompt = u.input + u.cacheRead + w;
    if (p.maxContext !== undefined && prompt > p.maxContext)
        return null;
    const r = effectiveRates(p, prompt);
    if (r.cacheWrite5m === undefined || r.cacheWrite1h === undefined)
        return null;
    const base = u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead;
    return { low: (base + w * r.cacheWrite5m) / 1e6, high: (base + w * r.cacheWrite1h) / 1e6 };
}
