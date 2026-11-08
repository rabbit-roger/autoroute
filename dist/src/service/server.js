import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { normalize } from '../core/usage.js';
import { validCapabilities } from '../core/policy.js';
const VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
/** The key the plugin presents. Created once per data folder, readable only by the user. */
export function secret(dir) { mkdirSync(dir, { recursive: true, mode: 0o700 }); try {
    chmodSync(dir, 0o700);
}
catch { } const p = join(dir, 'token'); if (!existsSync(p))
    writeFileSync(p, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); try {
    chmodSync(p, 0o600);
}
catch { } return readFileSync(p, 'utf8').trim(); }
/** Where the plugin finds the service: written each time the service starts listening. */
export function writeConnection(dir, url, token) { writeFileSync(join(dir, 'connection.json'), JSON.stringify({ url, token }), { mode: 0o600 }); try {
    chmodSync(join(dir, 'connection.json'), 0o600);
}
catch { } }
const safeString = (v, max = 200) => { if (typeof v !== 'string' || !v || v.length > max || /[\x00-\x1f]/.test(v))
    throw new Error('Invalid string'); return v; };
const uuid = (v) => { const s = safeString(v); if (!/^[a-zA-Z0-9:._-]+$/.test(s))
    throw new Error('Invalid identifier'); return s; };
function validFeatures(v) { if (!v || !Number.isInteger(v.complexity) || v.complexity < 0 || v.complexity > 8 || !['explain', 'docs', 'implement', 'debug', 'plan', 'review'].includes(v.activity) || ['risk', 'uncertain', 'attachment'].some(k => typeof v[k] !== 'boolean'))
    throw new Error('Invalid features'); return { complexity: v.complexity, risk: v.risk, activity: v.activity, uncertain: v.uncertain, attachment: v.attachment }; }
function cacheContext(v) {
    if (!v || typeof v !== 'object' || typeof v.lastModel !== 'string')
        return undefined;
    const ok = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    return { lastModel: safeString(v.lastModel), ...(ok(v.idleMs) ? { idleMs: v.idleMs } : {}), ...(ok(v.contextTokens) ? { contextTokens: Math.floor(v.contextTokens) } : {}) };
}
function event(raw) {
    const host = raw.host;
    if (host !== 'claude')
        throw new Error('Invalid host');
    const e = { schemaVersion: 1, eventId: uuid(raw.eventId), key: uuid(raw.key), host, timestamp: new Date().toISOString(), kind: safeString(raw.kind, 40), provenance: raw.provenance === 'estimate' ? 'estimate' : raw.provenance === 'router' ? 'router' : 'host', coverage: 'request-only' };
    for (const k of ['taskId', 'turnId', 'agentId', 'project', 'hostVersion'])
        if (raw[k])
            e[k] = uuid(raw[k]);
    if (raw.app === 'desktop' || raw.app === 'cli')
        e.app = raw.app;
    for (const k of ['requestedModel', 'observedModel', 'status'])
        if (raw[k])
            e[k] = safeString(raw[k], 160);
    if (raw.requestedEffort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(raw.requestedEffort))
        e.requestedEffort = raw.requestedEffort;
    if (Array.isArray(raw.reasons))
        e.reasons = raw.reasons.slice(0, 20).map((x) => safeString(x, 100));
    // Only vendor counters are accepted. Raw errors, prompts, source and tool output are discarded.
    if (raw.nativeUsage)
        e.usage = normalize(host, raw.nativeUsage);
    return e;
}
export function createService(dir, webRoot = resolve('web')) {
    const token = secret(dir), store = new Store(join(dir, 'router.sqlite'));
    // Live view: the dashboard holds one server-sent-events stream open and re-reads history when told something was written.
    const clients = new Set();
    let pending;
    const notify = () => { if (pending)
        return; pending = setTimeout(() => { pending = undefined; for (const c of clients)
        c.write('event: change\ndata: 1\n\n'); }, 150); };
    const server = http.createServer(async (req, res) => {
        const origin = `http://${req.headers.host}`;
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); if (code === 200 && req.method === 'POST')
            notify(); };
        try {
            if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? ''))
                return reply(403, { error: 'Invalid Host' });
            if (req.headers.origin && req.headers.origin !== origin)
                return reply(403, { error: 'Invalid Origin' });
            const url = new URL(req.url ?? '/', origin);
            if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/favicon.svg', '/favicon.ico'].includes(url.pathname)) {
                const name = url.pathname === '/' ? 'index.html' : url.pathname === '/favicon.ico' ? 'favicon.svg' : url.pathname.slice(1);
                res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
                res.end(readFileSync(join(webRoot, name)));
                return;
            }
            const supplied = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
            const tokenOk = supplied.length === token.length && timingSafeEqual(supplied, Buffer.from(token));
            // The dashboard needs no key: its own page proves itself with headers a browser sets and other websites cannot forge
            // (Sec-Fetch-Site same-origin, plus a custom header that forces a CORS preflight). Only the read and purge calls it uses
            // are open this way; everything the plugin sends still requires the key, which never leaves the local files.
            const sameOrigin = req.headers['sec-fetch-site'] === 'same-origin';
            // EventSource cannot set headers, so the stream (which carries only a content-free change ping) needs just the browser's same-origin mark.
            const dashboardCall = (['/v1/history', '/v1/export', '/v1/purge'].includes(url.pathname) && sameOrigin && req.headers['x-autoroute-ui'] === '1') || (url.pathname === '/v1/stream' && req.method === 'GET' && sameOrigin);
            if (!tokenOk && !dashboardCall)
                return reply(401, { error: 'Authentication required' });
            if (req.method === 'GET' && url.pathname === '/v1/stream') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
                res.write(': connected\n\n');
                clients.add(res);
                const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
                beat.unref();
                res.on('close', () => { clearInterval(beat); clients.delete(res); });
                return;
            }
            if (req.method === 'GET') {
                if (url.pathname === '/v1/history')
                    return reply(200, store.history());
                if (url.pathname === '/v1/health')
                    return reply(200, { ok: true, version: VERSION });
                if (url.pathname === '/v1/export') {
                    const data = store.history();
                    if (url.searchParams.get('format') === 'csv') {
                        const cell = (v) => '"' + String(v ?? '').replace(/^[=+@-]/, "'" + '$&').replaceAll('"', '""') + '"';
                        const rows = data.events.map((e) => [e.timestamp, e.host, e.taskId, e.kind, e.requestedModel, e.observedModel, e.requestedEffort, e.usage?.input, e.usage?.output, e.usage?.cacheRead, e.usage?.cacheWrite]);
                        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="autoroute.csv"' });
                        res.end([['time', 'host', 'task', 'kind', 'requested_model', 'observed_model', 'effort', 'input', 'output', 'cache_read', 'cache_write'], ...rows].map(r => r.map(cell).join(',')).join('\n'));
                        return;
                    }
                    return reply(200, data);
                }
                return reply(404, { error: 'Not found' });
            }
            if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json')
                return reply(415, { error: 'JSON POST required' });
            let body = '';
            for await (const chunk of req) {
                body += chunk;
                if (Buffer.byteLength(body) > 65536)
                    return reply(413, { error: 'Body too large' });
            }
            const b = JSON.parse(body), key = b.key ? uuid(b.key) : '';
            switch (url.pathname) {
                case '/v1/session': {
                    if (b.host !== 'claude')
                        throw new Error('Invalid host');
                    const s = store.session(key, b.host, safeString(b.hostVersion), b.defaultEnabled === true);
                    return reply(200, { ...s, routable: validCapabilities(store.catalog(s.host), s) });
                }
                case '/v1/command': {
                    if (typeof b.enabled !== 'boolean' || !Number.isInteger(b.revision))
                        throw new Error('Invalid command');
                    return reply(200, store.command(key, b.enabled, uuid(b.commandId), b.revision));
                }
                case '/v1/pin': {
                    const pin = {};
                    if (b.model)
                        pin.model = safeString(b.model);
                    if (b.effort) {
                        if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort))
                            throw new Error('Invalid effort');
                        pin.effort = b.effort;
                    }
                    return reply(200, store.pin(key, pin));
                }
                case '/v1/task': {
                    const baseline = { model: safeString(b.baseline?.model) };
                    if (b.baseline.effort) {
                        if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(b.baseline.effort))
                            throw new Error('Invalid effort');
                        baseline.effort = b.baseline.effort;
                    }
                    if (b.override !== undefined && typeof b.override !== 'boolean')
                        throw new Error('Invalid override');
                    return reply(200, store.start(key, uuid(b.turnId), uuid(b.owner), baseline, validFeatures(b.features), b.override));
                }
                case '/v1/decide': return reply(200, store.route(uuid(b.taskId), uuid(b.owner), cacheContext(b.cache)));
                case '/v1/finish': {
                    if (!['completed', 'cancelled', 'abandoned', 'incomplete'].includes(b.state))
                        throw new Error('Invalid state');
                    store.finish(uuid(b.taskId), b.state);
                    return reply(200, { ok: true });
                }
                case '/v1/risk': {
                    const t = store.task(uuid(b.taskId));
                    if (t.state !== 'running')
                        throw new Error('Task ended');
                    t.features.risk = true;
                    store.saveTask(t);
                    return reply(200, { ok: true });
                }
                case '/v1/evidence': {
                    if (typeof b.passed !== 'boolean')
                        throw new Error('Invalid evidence');
                    store.evidence(uuid(b.taskId), uuid(b.signature), b.passed);
                    return reply(200, { ok: true });
                }
                case '/v1/events':
                    store.event(event(b));
                    return reply(200, { ok: true });
                case '/v1/purge':
                    if (b.confirm !== 'PURGE')
                        throw new Error('Explicit confirmation required');
                    store.purge();
                    return reply(200, { ok: true });
                default: return reply(404, { error: 'Not found' });
            }
        }
        catch {
            if (!res.headersSent)
                reply(400, { error: 'Invalid request or stale state; inspect doctor/status' });
        }
    });
    server.requestTimeout = 2000;
    server.headersTimeout = 2000;
    const retention = setInterval(() => store.retain(), 3600000);
    retention.unref();
    const close = server.close.bind(server);
    server.close = ((cb) => { for (const c of clients)
        c.end(); return close(cb); });
    server.on('close', () => { clearInterval(retention); store.close(); });
    return { server, store, token };
}
