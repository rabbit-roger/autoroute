import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

// Runs the real CLI against a throwaway data folder and port. No login item is written (--no-autostart).
test('setup starts the service, writes the connection file, and stop/uninstall clean up',()=>{
 const dir=mkdtempSync(join(tmpdir(),'autoroute-cli-'));
 const port=String(44000+Math.floor(Math.random()*1000));
 // A fake home keeps the real login item (if any) out of reach of stop/uninstall.
 const home=join(dir,'home');
 const env={...process.env,AUTOROUTE_DATA_DIR:join(dir,'data'),AUTOROUTE_PORT:port,HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData'),XDG_CONFIG_HOME:join(home,'.config')};
 const run=(...args:string[])=>spawnSync(process.execPath,[resolve('dist/src/cli/main.js'),...args],{env,encoding:'utf8',timeout:20000});
 try{
  const setup=run('setup','--no-autostart');
  assert.equal(setup.status,0,setup.stderr);
  assert.match(setup.stdout,/Autoroute is running: http:\/\/127\.0\.0\.1:/);
  assert.match(setup.stdout,/plugin install autoroute --marketplace rabbit-roger\/autoroute/);
  const c=JSON.parse(readFileSync(join(dir,'data','connection.json'),'utf8'));
  assert.equal(c.url,`http://127.0.0.1:${port}`);assert.match(c.token,/^[a-f0-9]{64}$/);
  const status=run('status');assert.match(status.stdout,/running at/);
  const doctor=run('doctor');assert.match(doctor.stdout,/Models: claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5/);assert.match(doctor.stdout,/Prices: 3 models/);
  const stop=run('stop');assert.equal(stop.status,0,stop.stderr);
  assert.match(run('status').stdout,/not running/);
  const un=run('uninstall','--purge');assert.equal(un.status,0,un.stderr);assert.equal(existsSync(join(dir,'data')),false);
 }finally{run('stop');rmSync(dir,{recursive:true,force:true});}
});
