#!/usr/bin/env node
// Entry point. node:sqlite prints an "experimental" warning on Node 22; it is expected, so it is hidden here.
process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
await import('./cli.js');
