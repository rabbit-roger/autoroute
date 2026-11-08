import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertCatalog, decide } from '../core/policy.js';
import { equivalentRange, type Price } from '../core/usage.js';
import type { CacheContext, Capabilities, Decision, Event, Features, Host, Route, Session, Task } from '../core/types.js';
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA secure_delete=ON;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if (version > 1) throw new Error('Database from a newer version; downgrade refused');
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_key TEXT NOT NULL, native_turn TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(session_key,native_turn));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capabilities(host TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prices(model TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, result TEXT NOT NULL);
      PRAGMA user_version=1;`);
    // Service restart never revives a one-task override.
    for (const row of this.db.prepare('SELECT value FROM tasks').all() as any[]) { const t = JSON.parse(row.value) as Task; if(t.state === 'running') { t.state='abandoned'; this.saveTask(t); } }
    this.retain();
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const out=fn(); this.db.exec('COMMIT'); return out; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  /** Returns the conversation's state, creating it on first sight with routing on or off as the plugin's default says. */
  session(key: string, host?: Host, hostVersion?: string, defaultEnabled = false): Session {
    const row = this.db.prepare('SELECT value FROM sessions WHERE key=?').get(key) as any;
    if(row) { const s=JSON.parse(row.value) as Session; if(hostVersion && s.hostVersion!==hostVersion) { s.hostVersion=hostVersion; s.revision++; this.save(s); } return s; }
    if(!host || !hostVersion) throw new Error('Unknown session');
    const s: Session={key,host,hostVersion,enabled:defaultEnabled,pins:{},revision:0,dwell:0}; this.save(s); return s;
  }
  save(s: Session) { this.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?)').run(s.key,JSON.stringify(s)); }
  saveTask(t: Task) { this.db.prepare('INSERT OR REPLACE INTO tasks VALUES(?,?,?,?)').run(t.id,t.key,t.nativeTurnId,JSON.stringify(t)); }
  task(id: string): Task { const row=this.db.prepare('SELECT value FROM tasks WHERE id=?').get(id) as any; if(!row) throw new Error('Unknown task'); return JSON.parse(row.value); }
  command(key: string, enabled: boolean, commandId: string, revision: number) {
    return this.transaction(() => {
      const old=this.db.prepare('SELECT result FROM commands WHERE id=?').get(commandId) as any; if(old) return JSON.parse(old.result);
      const s=this.session(key); if(s.revision!==revision) throw new Error('State changed; retry command');
      s.enabled=enabled; if(enabled) s.pins={}; s.revision++; this.save(s);
      const out={session:s,message:enabled?'Routing is ON for this conversation. From your next message Autoroute picks the model and effort for you, and any model or effort you chose by hand earlier is released.':'Routing is OFF for this conversation. Claude uses the model and effort you chose.'};
      this.db.prepare('INSERT INTO commands VALUES(?,?)').run(commandId,JSON.stringify(out)); return out;
    });
  }
  pin(key: string, route: Partial<Route>) { const s=this.session(key); s.pins={...s.pins,...route}; s.revision++; this.save(s); return s; }
  start(key: string, turn: string, owner: string, baseline: Route, f: Features, override?: boolean): Task {
    return this.transaction(() => {
      const old=this.db.prepare('SELECT value FROM tasks WHERE session_key=? AND native_turn=?').get(key,turn) as any;
      if(old) { const t=JSON.parse(old.value) as Task; if(t.owner!==owner || t.state!=='running') throw new Error('Turn already completed or belongs to another adapter'); return t; }
      const s=this.session(key);
      for(const row of this.db.prepare('SELECT value FROM tasks WHERE session_key=?').all(key) as any[]) if((JSON.parse(row.value) as Task).state==='running') throw new Error('Another task is running');
      const t: Task={id:randomUUID(),key,nativeTurnId:turn,owner,baseline,features:f,override,enabled:override ?? s.enabled,state:'running',failures:0,evidence:[],createdAt:new Date().toISOString()}; this.saveTask(t); return t;
    });
  }
  route(id: string, owner: string, cache?: CacheContext): Decision {
    const t=this.task(id); if(t.state!=='running'||t.owner!==owner) throw new Error('Task lease expired');
    const s=this.session(t.key), d=decide(s,t,this.catalog(s.host),this.prices(),cache);
    if(d.action==='apply') { if(s.lastRoute?.model!==d.route.model) s.dwell=0; t.route=d.route; s.lastRoute=d.route; this.saveTask(t); this.save(s); }
    return d;
  }
  evidence(id: string, signature: string, passed: boolean) {
    const t=this.task(id); if(t.state!=='running') return; if(!t.evidence.includes(signature)) { t.evidence.push(signature); if(!passed) t.failures++; this.saveTask(t); }
  }
  finish(id: string, state: Task['state']) { const t=this.task(id); if(t.state==='running') {t.state=state; this.saveTask(t);} }
  prices(): Price[] { return (this.db.prepare('SELECT value FROM prices').all() as any[]).map(r=>JSON.parse(r.value)); }
  catalog(host: Host): Capabilities | undefined { const row=this.db.prepare('SELECT value FROM capabilities WHERE host=?').get(host) as any; return row ? JSON.parse(row.value) : undefined; }
  /**
   * Installs the catalog and prices that ship with the package. A bundled catalog is replaced when the package brings a
   * different one; a custom catalog is never touched. Prices are replaced only by a newer dated set.
   */
  installDefaults(c: Capabilities, prices: Price[]) {
    const current=this.catalog(c.host);
    if(!current || (current.source==='bundled' && current.catalogVersion!==c.catalogVersion)) this.setCatalog(c);
    const newest=(ps:Price[])=>ps.reduce((m,p)=>p.date>m?p.date:m,'');
    const have=this.prices();
    if(!have.length || newest(prices)>newest(have)) this.setPrices(prices);
  }
  setCatalog(c: Capabilities) { assertCatalog(c); this.db.prepare('INSERT OR REPLACE INTO capabilities VALUES(?,?)').run(c.host,JSON.stringify(c)); }
  event(e: Event) {
    const inserted=this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?)').run(e.eventId,e.timestamp,JSON.stringify(e));
    if(inserted.changes && e.kind==='request' && e.taskId) { const t=this.task(e.taskId); const s=this.session(t.key); s.dwell++; this.save(s); }
  }
  setPrices(prices: any[]) { this.transaction(()=>{this.db.exec('DELETE FROM prices');for(const p of prices)this.db.prepare('INSERT INTO prices VALUES(?,?)').run(p.model,JSON.stringify(p));}); }
  history() { const prices=this.prices(); return { prices, sessions:(this.db.prepare('SELECT value FROM sessions').all() as any[]).map(r=>JSON.parse(r.value)), tasks:(this.db.prepare('SELECT value FROM tasks ORDER BY rowid DESC LIMIT 1000').all() as any[]).map(r=>JSON.parse(r.value)), events:(this.db.prepare('SELECT value FROM events ORDER BY timestamp DESC LIMIT 10000').all() as any[]).map(r=>JSON.parse(r.value)).map((e:Event)=>e.usage?{...e,costs:Object.fromEntries(prices.map(p=>[p.model,equivalentRange(e.usage,p)]))}:e), capabilities:(this.db.prepare('SELECT value FROM capabilities').all() as any[]).map(r=>JSON.parse(r.value)) }; }
  retain(days=30) {
    this.db.prepare('DELETE FROM events WHERE timestamp<?').run(new Date(Date.now()-days*86400000).toISOString());
    this.db.exec('DELETE FROM commands WHERE rowid NOT IN (SELECT rowid FROM commands ORDER BY rowid DESC LIMIT 10000)');
    for(const row of this.db.prepare('SELECT id,value FROM tasks').all() as any[]) {const t=JSON.parse(row.value) as Task;if(t.state!=='running' && Date.parse(t.createdAt)<Date.now()-days*86400000)this.db.prepare('DELETE FROM tasks WHERE id=?').run(row.id);}
    const size=(Number((this.db.prepare('PRAGMA page_count').get() as any).page_count)-Number((this.db.prepare('PRAGMA freelist_count').get() as any).freelist_count))*Number((this.db.prepare('PRAGMA page_size').get() as any).page_size);
    if(size>250*1024*1024) { this.db.exec('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY timestamp LIMIT 10000)'); }
  }
  purge() { this.db.exec('DELETE FROM events; DELETE FROM tasks; DELETE FROM sessions; DELETE FROM commands; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'); }
  close() { this.db.close(); }
}
