import { homedir, platform } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, openSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createService, secret, writeConnection } from '../service/server.js';
import { Store } from '../service/store.js';
import { assertCatalog } from '../core/policy.js';
import { assertPrices } from '../core/usage.js';
import type { Capabilities } from '../core/types.js';
import type { Price } from '../core/usage.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const main = join(dirname(fileURLToPath(import.meta.url)), 'main.js');
const dir = resolve(process.env.AUTOROUTE_DATA_DIR ?? join(homedir(), '.autoroute'));
const port = Number(process.env.AUTOROUTE_PORT ?? 43821);
const version: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const [command = 'help', ...args] = process.argv.slice(2);
const os = platform();
const LABEL = 'dev.autoroute.service';

const PLUGIN_STEPS = `Next, add the Claude Code plugin (once):
  In a terminal session of Claude Code:
    /plugin install autoroute --marketplace rabbit-roger/autoroute
  In the Claude desktop app:
    click + next to the prompt box -> Plugins -> Add marketplace "rabbit-roger/autoroute" -> Add plugin
Then type /autoroute-on in a conversation to let Autoroute pick the model.`;

function bundledDefaults(): { catalog: Capabilities; prices: Price[] } {
  const catalog = JSON.parse(readFileSync(join(root, 'config/catalog.json'), 'utf8'));
  const prices = JSON.parse(readFileSync(join(root, 'config/prices.json'), 'utf8'));
  assertCatalog(catalog);
  assertPrices(prices);
  return { catalog, prices };
}

function connection(): { url: string; token: string } | undefined {
  try { return JSON.parse(readFileSync(join(dir, 'connection.json'), 'utf8')); } catch { return undefined; }
}

async function call(path: string, body?: unknown) {
  const c = connection();
  if (!c) throw new Error('The service has never been started. Run `autoroute setup`.');
  const r = await fetch(c.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  if (!r.ok) throw new Error(`Service returned ${r.status}`);
  return r.json();
}

async function running(): Promise<boolean> {
  try { await call('/v1/health'); return true; } catch { return false; }
}

async function waitFor(state: boolean, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (await running() === state) return true;
  return false;
}

/** Commands that change the database while the service holds it open are refused. */
async function requireStopped(what: string) {
  if (await running()) throw new Error(`Stop the service first (autoroute stop), then ${what}, then autoroute start.`);
}

// ---------- autostart, one implementation per OS ----------
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const env = () => ({ ...(process.env.AUTOROUTE_DATA_DIR ? { AUTOROUTE_DATA_DIR: dir } : {}), ...(process.env.AUTOROUTE_PORT ? { AUTOROUTE_PORT: String(port) } : {}) });

const autostart = {
  file(): string {
    if (os === 'darwin') return join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
    if (os === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'Microsoft/Windows/Start Menu/Programs/Startup/autoroute.vbs');
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user/autoroute.service');
  },
  installed(): boolean { return existsSync(this.file()); },
  install() {
    const file = this.file();
    mkdirSync(dirname(file), { recursive: true });
    if (os === 'darwin') {
      const vars = Object.entries(env()).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('');
      writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(main)}</string><string>serve</string></array>
${vars ? `<key>EnvironmentVariables</key><dict>${vars}</dict>` : ''}
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StandardOutPath</key><string>${xml(join(dir, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(dir, 'service.log'))}</string>
</dict></plist>
`, { mode: 0o600 });
    } else if (os === 'win32') {
      const q = (s: string) => s.replaceAll('"', '""');
      const vars = Object.entries(env()).map(([k, v]) => `sh.Environment("Process")("${k}") = "${q(v)}"\r\n`).join('');
      // Windows Script Host reads a script without a BOM in the ANSI code page, which breaks non-ASCII paths (a Cyrillic user name, say). UTF-16 LE with a BOM is always read correctly.
      writeFileSync(file, String.fromCharCode(0xfeff) + `Set sh = CreateObject("WScript.Shell")\r\n${vars}sh.Run """${q(process.execPath)}"" ""${q(main)}"" serve", 0, False\r\n`, 'utf16le');
    } else {
      const quote = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
      const vars = Object.entries(env()).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}\n`).join('');
      writeFileSync(file, `[Unit]
Description=Autoroute local service
[Service]
ExecStart=${quote(process.execPath)} ${quote(main)} serve
${vars}Restart=on-failure
[Install]
WantedBy=default.target
`);
      spawnSync('systemctl', ['--user', 'daemon-reload']);
      spawnSync('systemctl', ['--user', 'enable', 'autoroute.service']);
    }
  },
  start(): boolean {
    if (!this.installed()) return false;
    if (os === 'darwin') { spawnSync('launchctl', ['bootstrap', `gui/${process.getuid!()}`, this.file()]); spawnSync('launchctl', ['kickstart', `gui/${process.getuid!()}/${LABEL}`]); return true; }
    if (os === 'win32') { spawn('wscript.exe', [this.file()], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; }
    return spawnSync('systemctl', ['--user', 'start', 'autoroute.service']).status === 0;
  },
  stop() {
    if (!this.installed()) return;
    if (os === 'darwin') spawnSync('launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`]);
    else if (os !== 'win32') spawnSync('systemctl', ['--user', 'stop', 'autoroute.service']);
  },
  remove() {
    this.stop();
    if (os === 'linux' && this.installed()) spawnSync('systemctl', ['--user', 'disable', 'autoroute.service']);
    rmSync(this.file(), { force: true });
    if (os === 'linux') spawnSync('systemctl', ['--user', 'daemon-reload']);
  },
};

function startDetached() {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dir, 'service.log'), 'a', 0o600);
  spawn(process.execPath, [main, 'serve'], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env }).unref();
}

function stopByPid() {
  try {
    const pid = Number(readFileSync(join(dir, 'service.pid'), 'utf8'));
    if (Number.isInteger(pid) && pid > 0) process.kill(pid);
  } catch { /* not running */ }
}

async function start() {
  if (await running()) return console.log(`Autoroute is already running: ${connection()!.url}`);
  if (!autostart.start()) startDetached();
  if (!(await waitFor(true))) throw new Error(`The service did not start. See ${join(dir, 'service.log')}.`);
  console.log(`Autoroute is running: ${connection()!.url}`);
}

async function stop() {
  autostart.stop();
  if (await running()) stopByPid();
  if (!(await waitFor(false))) throw new Error('The service is still running.');
  console.log('Autoroute stopped.');
}

function openBrowser(url: string) {
  if (os === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  else if (os === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

// ---------- commands ----------
const HELP = `Autoroute ${version} - picks the Claude model and effort for each task.

Usage: autoroute <command>

  setup [--no-autostart]   create the data folder, start the service and start it at login
  start | stop | status    control the background service
  dashboard                open the dashboard in your browser
  doctor                   check the installation
  prices <file.json>       import a newer price list (service must be stopped)
  catalog <file.json>      import a custom model catalog (service must be stopped)
  export                   print all recorded data as JSON
  purge --confirm          delete recorded history and conversation settings
  uninstall [--purge]      remove the login item; --purge also deletes ${dir}
  serve                    run the service in the foreground

Data folder: ${dir} (set AUTOROUTE_DATA_DIR to change). Port: ${port} (AUTOROUTE_PORT).`;

try {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('AUTOROUTE_PORT must be a number between 1024 and 65535.');
  switch (command) {
    case 'serve': {
      const { catalog, prices } = bundledDefaults();
      const { server, store, token } = createService(dir, join(root, 'web'));
      store.installDefaults(catalog, prices);
      server.on('error', () => { console.error(`Cannot start: port ${port} is in use or the service is already running.`); process.exitCode = 1; });
      server.listen(port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${port}`;
        writeConnection(dir, url, token);
        writeFileSync(join(dir, 'service.pid'), String(process.pid));
        console.log(`Autoroute ${version}: ${url}`);
      });
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { rmSync(join(dir, 'service.pid'), { force: true }); server.close(); });
      break;
    }
    case 'setup': {
      const major = Number(process.versions.node.split('.')[0]), minor = Number(process.versions.node.split('.')[1]);
      if (major < 22 || (major === 22 && minor < 13)) throw new Error(`Node.js 22.13 or newer is required (found ${process.versions.node}).`);
      secret(dir);
      bundledDefaults();
      if (await running()) { await stop().catch(() => undefined); }
      if (!args.includes('--no-autostart')) {
        autostart.remove();
        autostart.install();
        console.log(`Login item installed: ${autostart.file()}`);
      }
      await start();
      console.log(`\nData folder: ${dir}\n\n${PLUGIN_STEPS}`);
      break;
    }
    case 'start': await start(); break;
    case 'stop': await stop(); break;
    case 'status': {
      const up = await running();
      console.log(`Service: ${up ? `running at ${connection()!.url}` : 'not running (autoroute start)'}`);
      console.log(`Starts at login: ${autostart.installed() ? 'yes' : 'no (autoroute setup)'}`);
      console.log(`Data folder: ${dir}`);
      break;
    }
    case 'dashboard': {
      if (!(await running())) throw new Error('The service is not running. Run `autoroute start`.');
      const url = connection()!.url + '/';
      console.log(`Dashboard: ${url}`);
      openBrowser(url);
      break;
    }
    case 'doctor': {
      console.log(`Autoroute ${version}, Node.js ${process.versions.node}, ${os}`);
      console.log(`Data folder: ${dir} ${existsSync(dir) ? '' : '(missing: run autoroute setup)'}`);
      console.log(`Starts at login: ${autostart.installed() ? 'yes' : 'no'}`);
      if (await running()) {
        const h: any = await call('/v1/history');
        const c = h.capabilities.find((x: any) => x.host === 'claude');
        console.log(`Service: running at ${connection()!.url}`);
        console.log(`Models: ${c ? c.candidates.map((x: any) => x.model).join(', ') + ` (${c.source} catalog ${c.catalogVersion}, needs Claude Code ${c.minHostVersion}+)` : 'none'}`);
        const dates = [...new Set(h.prices.map((p: any) => p.date))];
        console.log(`Prices: ${h.prices.length} models, dated ${dates.join(', ') || 'n/a'}`);
        console.log(`Recorded requests: ${h.events.filter((e: any) => e.kind === 'request').length}`);
      } else console.log('Service: not running (autoroute start)');
      console.log(`\nIf conversations are not recorded, check that the plugin is installed:\n${PLUGIN_STEPS}`);
      break;
    }
    case 'prices': {
      if (!args[0]) throw new Error('Usage: autoroute prices <file.json>');
      const prices = JSON.parse(readFileSync(resolve(args[0]), 'utf8')); assertPrices(prices);
      await requireStopped('import prices');
      const store = new Store(join(dir, 'router.sqlite')); store.setPrices(prices); store.close();
      console.log(`Imported prices for ${prices.length} model(s).`);
      break;
    }
    case 'catalog': {
      if (!args[0]) throw new Error('Usage: autoroute catalog <file.json>');
      const c = JSON.parse(readFileSync(resolve(args[0]), 'utf8')); c.source = 'custom'; assertCatalog(c);
      await requireStopped('import the catalog');
      const store = new Store(join(dir, 'router.sqlite')); store.setCatalog(c); store.close();
      console.log(`Imported custom catalog with ${c.candidates.length} models. It is kept across upgrades.`);
      break;
    }
    case 'export': console.log(JSON.stringify(await call('/v1/export'), null, 2)); break;
    case 'purge': {
      if (args[0] !== '--confirm') throw new Error('This deletes recorded history and conversation settings. Run `autoroute purge --confirm` to proceed.');
      await call('/v1/purge', { confirm: 'PURGE' });
      console.log('History deleted.');
      break;
    }
    case 'uninstall': {
      autostart.remove();
      if (await running()) { stopByPid(); await waitFor(false); }
      if (args.includes('--purge')) { rmSync(dir, { recursive: true, force: true }); console.log(`Deleted ${dir}.`); }
      console.log('Autoroute service removed. To remove the plugin, run /plugin in Claude Code (or Plugins in the desktop app).');
      console.log('To remove the command itself: npm uninstall -g autoroute');
      break;
    }
    case 'version': case '--version': case '-v': console.log(version); break;
    default: console.log(HELP);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
