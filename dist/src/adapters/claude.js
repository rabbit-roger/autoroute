import { parse } from '../core/parser.js';
import { features, rewrite } from '../core/policy.js';
import { classify } from '../core/classifier.js';
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let warned = false;
/** The last folder of a project path, with / or \ separators (Windows paths use \). Only this name is stored, never the full path. */
export function folderName(root) { const n = typeof root === 'string' ? root.split(/[\\/]+/).filter(Boolean).pop() : undefined; return n ? n.replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 80) : undefined; }
async function projectName($) { try {
    return folderName(await $.session.root());
}
catch {
    return undefined;
} }
function warn($, message) { if (!warned) {
    warned = true;
    $.ui.log(`Autoroute: ${message} Claude keeps using your own model and effort.`);
} }
/** The service's data folder: AUTOROUTE_DATA_DIR, else ~/.autoroute. On Windows the home is USERPROFILE even when HOME is set (Git Bash, MSYS), because that is what Node's os.homedir(), and so the service, uses. */
async function dataDir($) {
    const custom = await $.env.get('AUTOROUTE_DATA_DIR');
    if (custom)
        return custom.replace(/[\\/]+$/, '');
    const windows = (await $.env.get('OS')) === 'Windows_NT';
    // Each variable is named literally: the host lists the variables a plugin reads from its source.
    const profile = await $.env.get('USERPROFILE'), posixHome = await $.env.get('HOME');
    const home = windows ? (profile || posixHome) : (posixHome || profile);
    if (!home)
        throw new Error('no home folder');
    return home.replace(/[\\/]+$/, '') + '/.autoroute';
}
/** Reads the address and key the running service wrote. Read again on every session start, so a new key is picked up. */
async function readConnection($) {
    const c = JSON.parse(await $.fs.read(`${await dataDir($)}/connection.json`));
    if (typeof c?.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(c.url) || typeof c.token !== 'string' || !/^[a-f0-9]{64}$/.test(c.token))
        throw new Error('invalid local connection');
    return { url: c.url, token: c.token };
}
const sameModel = (a, b) => a === b || a.startsWith(b + '-') || b.startsWith(a + '-');
export function registerAdapter(on, supplied, options = {}) {
    const defaultEnabled = options.defaultRouting === 'on';
    let mismatches = 0;
    const owner = uid();
    let call = supplied;
    let lastModel, lastAt; // main-loop model of the last request and when it finished: this is what the prompt cache belongs to
    let app, project, serviceUrl;
    let key = '', version = 'unverified', pending;
    const turns = new Map();
    const request = async (path, body) => { if (!call)
        throw new Error('not connected'); return call(path, body); };
    const logEvent = async (e, usage) => { try {
        await request('/v1/events', { schemaVersion: 1, eventId: uid(), key, host: 'claude', hostVersion: version, provenance: 'host', coverage: 'request-only', ...(project ? { project } : {}), ...(app ? { app } : {}), ...e, nativeUsage: usage });
    }
    catch { /* Never replay inference for telemetry. */ } };
    on('session.start', async ($, e, next) => {
        try {
            if (!supplied) {
                let c = await readConnection($);
                serviceUrl = c.url;
                const send = (path, body) => $.http.fetch(c.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), timeoutMs: 300 });
                call = async (path, body) => {
                    let r = await send(path, body);
                    // The key changes when the service is set up again; pick up the new one once before giving up.
                    if (r.status === 401 || r.status === 403) {
                        try {
                            c = await readConnection($);
                            serviceUrl = c.url;
                            r = await send(path, body);
                        }
                        catch { }
                    }
                    if (!r.ok) {
                        if (r.status === 401 || r.status === 403)
                            warn($, 'the service rejected this conversation\'s key, so nothing is routed or recorded here. Run `autoroute setup` again or open a new conversation.');
                        throw new Error('router unavailable');
                    }
                    return JSON.parse(r.text);
                };
            }
            app = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop' ? 'desktop' : 'cli';
            version = (await $.session.version()).version;
            if (typeof version !== 'string' || !version)
                throw new Error('Host version unavailable');
            key = `claude:${await $.session.id()}`;
            project = await projectName($);
            await request('/v1/session', { key, host: 'claude', hostVersion: version, defaultEnabled });
            warned = false;
        }
        catch {
            warn($, 'the local service is not running or not set up, so routing is off. Run `autoroute start` (or `autoroute setup` the first time).');
        }
        const COMMANDS = { 'autoroute-on': 'Enable session routing and release manual pins', 'autoroute-off': 'Disable session routing', 'autoroute-status': 'Routing state for this session', 'autoroute-dashboard': 'Open the Autoroute dashboard', 'autoroute-task-on': 'Route one task; original submission only', 'autoroute-task-off': 'Do not route one task' };
        for (const name of Object.keys(COMMANDS)) {
            try {
                await $.command.register({ name, description: COMMANDS[name], argumentHint: name.startsWith('autoroute-task-') ? '<task>' : '' });
            }
            catch {
                warn($, 'command registration failed');
                call = undefined;
            }
        }
        return next(e);
    });
    on('command.run', async ($, e, next) => {
        // A host may namespace plugin commands (plugin:command); handle both spellings.
        const prefix = `${$.plugin.name ?? 'autoroute'}:`;
        if (typeof e.command === 'string' && e.command.startsWith(prefix))
            e = { ...e, command: e.command.slice(prefix.length) };
        key = `claude:${await $.session.id()}`;
        project = await projectName($);
        if (e.command === 'model' || e.command === 'effort') {
            const result = await next(e);
            if (e.origin?.kind === 'composer')
                try {
                    const model = await $.session.model();
                    if (e.command === 'model')
                        await request('/v1/pin', { key, model });
                    else if (['low', 'medium', 'high', 'xhigh', 'max'].includes(e.args.trim()))
                        await request('/v1/pin', { key, effort: e.args.trim() });
                    else { // Picker intent with unknown resulting effort: suspend automatic application conservatively.
                        const s = await request('/v1/session', { key, host: 'claude', hostVersion: version, defaultEnabled });
                        await request('/v1/command', { key, enabled: false, revision: s.revision, commandId: uid() });
                        $.ui.log('Autoroute paused after effort picker. /autoroute-on explicitly returns control.');
                    }
                }
                catch {
                    call = undefined;
                    warn($, 'manual selection could not be tracked');
                }
            return result;
        }
        if (!['autoroute-status', 'autoroute-dashboard', 'autoroute-on', 'autoroute-off', 'autoroute-task-on', 'autoroute-task-off'].includes(e.command))
            return next(e);
        if (e.origin?.kind !== 'composer')
            return { text: 'Only a command typed in the chat box can change routing.' };
        // If the host dispatched task commands before prompt.submit, do not synthesize a submission: attachment bytes are not exposed here.
        if (e.command === 'autoroute-task-on' || e.command === 'autoroute-task-off')
            return { text: 'This version of Claude Code ran the task command before Autoroute could see your message, so nothing was sent. Send the task as a normal message instead.' };
        const p = parse(`/${e.command}${e.args ? ` ${e.args}` : ''}`);
        if (p.kind === 'error')
            return { text: p.message };
        try {
            if (p.kind === 'dashboard') {
                try {
                    await request('/v1/session', { key, host: 'claude', hostVersion: version, defaultEnabled });
                    return { text: `Your dashboard: ${serviceUrl ?? 'http://127.0.0.1:43821'}/ (open it in a browser; it updates by itself).` };
                }
                catch {
                    return { text: 'The Autoroute service is not running, so the dashboard is unavailable. Run `autoroute start` in a terminal (or `autoroute setup` the first time), then `autoroute dashboard`.' };
                }
            }
            const s = await request('/v1/session', { key, host: 'claude', hostVersion: version, defaultEnabled });
            if (p.kind === 'session') {
                const r = await request('/v1/command', { key, enabled: p.enabled, commandId: uid(), revision: s.revision });
                return { text: r.message + (s.routable === false ? ' Note: this Claude Code version is older than Autoroute supports, so nothing will be changed. Update Claude Code.' : '') };
            }
            const pins = [s.pins.model ? `model ${s.pins.model}` : '', s.pins.effort ? `effort ${s.pins.effort}` : ''].filter(Boolean).join(', ');
            return { text: `Routing is ${s.enabled ? 'ON' : 'OFF'} for this conversation. ` + (s.routable === false ? 'It is not working: this Claude Code version is older than Autoroute supports, so your own settings are used. Update Claude Code. ' : s.enabled ? 'Autoroute chooses the model and effort for your messages. ' : 'Claude uses the model and effort you chose. ') + (pins ? `Chosen by hand and kept: ${pins}.` : 'Nothing is chosen by hand.') };
        }
        catch {
            return { text: 'The Autoroute service is not running, so nothing was changed and Claude uses your own settings. Run `autoroute start` in a terminal (or `autoroute setup` the first time).' };
        }
    }).catch(($, e, next) => ['autoroute-status', 'autoroute-dashboard', 'autoroute-on', 'autoroute-off', 'autoroute-task-on', 'autoroute-task-off'].includes(e.command) ? { text: 'The command failed. Nothing was changed.' } : next(e));
    on('prompt.submit', async ($, e, next) => {
        key = `claude:${await $.session.id()}`;
        project = await projectName($);
        const p = e.origin?.kind === 'composer' ? parse(e.text) : { kind: 'prompt', text: e.text };
        if (p.kind === 'error')
            return { drop: p.message };
        if (p.kind === 'session' || p.kind === 'status' || p.kind === 'dashboard')
            return next(e); // command.run handles control only
        if (p.kind === 'task' && e.turnId)
            return { drop: 'Wait for the current task before submitting a one-task override.' };
        if (e.turnId)
            return next(e); // steering remains attached to the active task
        // The host fires turn.start after this hook's next() has returned, so the record must outlive it. turn.start consumes it; a drop or error clears it.
        pending = { text: p.text, override: p.kind === 'task' ? p.enabled : undefined, attachments: !!e.attachments?.length, at: Date.now() };
        try {
            const r = await next(p.kind === 'task' ? { ...e, text: p.text } : e);
            if (r?.drop)
                pending = undefined;
            return r;
        }
        catch (error) {
            pending = undefined;
            throw error;
        }
    }).catch(($, e, next) => /^\/autoroute-task-(?:on|off)(?:\s|$)/.test(e.text) ? { drop: 'Autoroute failed before task submission; retry when the service is available.' } : next(e));
    on('turn.start', async ($, e, next) => {
        try {
            const s = await request('/v1/session', { key, host: 'claude', hostVersion: version, defaultEnabled });
            // Non-user continuations get no inherited override. Never match task ownership by text/hash.
            const fresh = pending && Date.now() - pending.at < 10000 ? pending : undefined;
            pending = undefined;
            if (fresh)
                turns.set(e.turnId, { enabled: fresh.override ?? s.enabled, routable: s.routable !== false, text: fresh.text, attachment: fresh.attachments, edits: 0, verified: false, reviewed: false, failed: new Set() });
        }
        catch {
            warn($, 'cannot establish task state');
        }
        return next(e);
    });
    on('turn.step', async function* ($, e, next) {
        const turn = turns.get(e.turnId);
        let decision;
        if (!e.agentId && turn)
            try {
                if (!turn.task) {
                    // One cheap classification per routed task. Skipped when routing is off or the host is too old; failure means native settings.
                    let f;
                    const attempted = turn.enabled && turn.routable;
                    if (attempted) {
                        const c = await classify($, turn.text, turn.attachment);
                        f = c.features;
                        await logEvent({ kind: 'classifier', requestedModel: 'haiku', requestedEffort: 'low', status: f ? 'completed' : 'failed' }, c.usage);
                    }
                    turn.task = await request('/v1/task', { key, owner, turnId: e.turnId, baseline: { model: e.model, effort: e.effort }, features: f ?? { complexity: 0, risk: false, activity: 'explain', uncertain: true, attachment: turn.attachment }, override: turn.enabled && (!attempted || !!f) });
                    turn.text = '';
                }
                // GUI picker changes that escaped command.run suspend routing rather than guessing pin provenance.
                if (e.model !== turn.task.baseline.model) {
                    await request('/v1/pin', { key, model: e.model });
                }
                if (e.effort !== undefined && turn.task.baseline.effort !== undefined && e.effort !== turn.task.baseline.effort)
                    await request('/v1/pin', { key, effort: e.effort });
                let cache;
                if (lastModel) {
                    let tokens;
                    try {
                        const u = await $.session.usage();
                        if (Number.isFinite(u?.context?.tokens))
                            tokens = u.context.tokens;
                    }
                    catch { }
                    cache = { lastModel, ...(lastAt !== undefined ? { idleMs: Date.now() - lastAt } : {}), ...(tokens !== undefined ? { contextTokens: tokens } : {}) };
                }
                decision = await request('/v1/decide', { taskId: turn.task.id, owner, ...(cache ? { cache } : {}) });
            }
            catch {
                warn($, 'route unavailable or task expired');
            }
        if (next.signal?.aborted || (turn && turns.get(e.turnId) !== turn))
            decision = undefined;
        const outgoing = decision ? rewrite(e, decision) : e;
        let result;
        try {
            result = yield* next(outgoing);
        }
        catch (error) {
            await logEvent({ kind: 'request', taskId: turn?.task?.id, turnId: e.turnId, agentId: e.agentId, requestedModel: outgoing.model, requestedEffort: outgoing.effort, status: 'failed' });
            throw error;
        }
        await logEvent({ kind: 'request', taskId: turn?.task?.id, turnId: e.turnId, agentId: e.agentId, requestedModel: outgoing.model, requestedEffort: outgoing.effort, observedModel: result?.usage?.model, reasons: decision?.reasons, status: result?.stopReason === null ? 'unknown' : 'completed' }, result?.usage);
        if (!e.agentId && result?.stopReason !== null) {
            lastModel = outgoing.model;
            lastAt = Date.now();
        }
        // Safeguard: if the host keeps answering with a different model than the one requested, stop routing this conversation.
        const served = result?.usage?.model;
        if (decision?.action === 'apply' && typeof served === 'string' && served && !sameModel(served, outgoing.model) && ++mismatches >= 2) {
            mismatches = 0;
            try {
                const s = await request('/v1/session', { key, host: 'claude', hostVersion: version, defaultEnabled });
                await request('/v1/command', { key, enabled: false, revision: s.revision, commandId: uid() });
            }
            catch { }
            $.ui.log(`Autoroute turned routing off for this conversation: Claude Code answered with ${served} instead of the requested ${outgoing.model} twice. /autoroute-on turns it back on.`);
        }
        return result;
    });
    on('tool.call', async ($, e, next) => {
        if (!e.agentId && turns.size === 1 && ['Edit', 'Write', 'MultiEdit'].includes(e.tool)) {
            const active = turns.values().next().value;
            if (active?.enabled && active.task && features('Implement ' + String(e.file_path ?? '')).risk) {
                active.task.features.risk = true;
                try {
                    await request('/v1/risk', { taskId: active.task.id });
                }
                catch { }
            }
        }
        const result = await next(e);
        if (e.agentId || turns.size !== 1)
            return result;
        const t = turns.values().next().value;
        if (!t || !t.enabled || !t.task)
            return result;
        if (['Edit', 'Write', 'MultiEdit'].includes(e.tool) && !result?.deny && !result?.isError) {
            t.edits++;
            t.verified = false;
        }
        if (e.tool === 'Bash' && /^(?:npm (?:run )?(?:test|build|lint|check)|pnpm (?:test|build|lint|check)|pytest|cargo (?:test|check)|go test)(?:\s|$)/.test(String(e.command ?? '')) && !result?.deny) {
            const knownFailure = result?.isError === true;
            const knownSuccess = !knownFailure && result?.result?.interrupted === false && !result.result.backgroundTaskId;
            if (knownSuccess)
                t.verified = true;
            // An expected first red test never escalates; only a repeated failure after an edit.
            const signature = String(e.command).trim();
            if (knownFailure && t.failed.has(signature) && t.edits > 0)
                try {
                    await request('/v1/evidence', { taskId: t.task.id, signature: 'repeat-verifier-failure-' + t.edits, passed: false });
                }
                catch { }
            if (knownFailure)
                t.failed.add(signature);
            await logEvent({ kind: 'verification', taskId: t.task.id, status: knownSuccess ? 'passed' : knownFailure ? 'failed' : 'unknown' });
        }
        if (e.tool === 'Agent' && /review/i.test(String(e.subagent_type ?? '')) && !result?.isError && !result?.deny)
            t.reviewed = true;
        return result;
    });
    on('turn.complete', async ($, e, next) => {
        const t = turns.get(e.turnId);
        if (!e.agentId) {
            turns.delete(e.turnId);
            if (t?.task)
                try {
                    await request('/v1/finish', { taskId: t.task.id, state: e.isAborted ? 'cancelled' : ((t.edits > 0 || ['implement', 'debug'].includes(t.task.features.activity)) && !t.verified) || (t.task.features.risk && !t.reviewed) ? 'incomplete' : 'completed' });
                }
                catch {
                    warn($, 'completion not recorded');
                }
        }
        return next(e);
    });
    on('session.end', async ($, e, next) => { for (const t of turns.values())
        if (t.task)
            try {
                await request('/v1/finish', { taskId: t.task.id, state: 'abandoned' });
            }
            catch { } turns.clear(); pending = undefined; return next(e); });
}
/** Entry point the host calls with the plugin's user options. */
export function register(on, options) { return registerAdapter(on, undefined, options ?? {}); }
