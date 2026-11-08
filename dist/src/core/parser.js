export function parse(text) {
    if (!/^\/autoroute(?:-(?:task-)?(?:on|off)|-task|-status|-dashboard)?(?:\s|$)/.test(text))
        return { kind: 'prompt', text };
    const task = /^\/autoroute-task-(on|off)(?:[ \t]|\r?\n)([\s\S]*)$/.exec(text);
    if (task) {
        const body = task[2];
        if (!body.trim() || /^\/autoroute(?:-task)?\b/m.test(body))
            return { kind: 'error', message: 'Supply one command and a nonempty task.' };
        return { kind: 'task', enabled: task[1] === 'on', text: body };
    }
    const session = /^\/autoroute-(on|off)[ \t]*$/.exec(text);
    if (session)
        return { kind: 'session', enabled: session[1] === 'on' };
    const auxiliary = /^\/autoroute-(status|dashboard)[ \t]*$/.exec(text);
    if (auxiliary)
        return { kind: auxiliary[1] };
    return { kind: 'error', message: 'Use /autoroute-on, /autoroute-off, /autoroute-task-on <task>, /autoroute-task-off <task>, /autoroute-status or /autoroute-dashboard.' };
}
