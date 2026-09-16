import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../dist/config.js';
import { Manager } from '../dist/manager.js';
import { createApp } from '../dist/server.js';
import { digest } from '../dist/security.js';
async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'portal-test-'));
 const config=configuration({DATA_DIR:root,SITE_IP:'127.0.0.1'}), calls=[];
 let container=true, mismatch=false, failVolume=false;
 const docker={run:async args=>{calls.push(args);if(args[0]==='inspect'){if(!container)throw Error('No such container');return JSON.stringify([{Config:{Labels:{'local-sites.app':mismatch?'other':'demo'}},State:{Status:'running'}}]);}if(args[0]==='rm')container=false;if(args[0]==='volume'&&args[1]==='rm'&&failVolume)throw Error('volume in use');return 'ok';}};
 const manager=new Manager(config,docker);await manager.init();
 manager.state.apps.demo={id:'demo',port:18000,url:'http://127.0.0.1:18000',desired:'running'};
 await writeFile(config.tokenFile,JSON.stringify([{name:'test',sha256:digest('secret')}]));
 const server=createApp(config,manager).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 // Wait for enrollment startup recovery before this fixture can be torn down.
 await fetch('http://127.0.0.1:'+server.address().port+'/setup/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 t.after(async()=>{await manager.idle();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
 return {config,manager,calls,url:'http://127.0.0.1:'+server.address().port,setMismatch:()=>mismatch=true,setFailVolume:()=>failVolume=true};
}
test('portal login, secure cookie, CSRF, logout and token revocation',async t=>{
 const {url,config}=await fixture(t);
 assert.equal((await fetch(url)).status,200);
 assert.equal((await fetch(url+'/api/apps')).status,401);
 const login=()=>fetch(url+'/api/login',{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify({token:'secret'})});
 const response=await login();assert.equal(response.status,200);
 const cookie=response.headers.get('set-cookie');assert.match(cookie,/Secure; HttpOnly; SameSite=Strict/);
 const {csrf}=await response.json(),headers={Cookie:cookie.split(';')[0],Origin:config.origin,'Content-Type':'application/json'};
 assert.equal((await fetch(url+'/api/apps',{headers})).status,200);
 assert.equal((await fetch(url+'/api/apps/demo/delete',{method:'POST',headers,body:'{"purge":false}'})).status,403);
 assert.equal((await fetch(url+'/api/apps/demo/delete',{method:'POST',headers:{...headers,'X-CSRF-Token':csrf,Origin:'https://evil.example'},body:'{"purge":false}'})).status,403);
 assert.equal((await fetch(url+'/api/logout',{method:'POST',headers:{...headers,'X-CSRF-Token':csrf},body:'{}'})).status,200);
 assert.equal((await fetch(url+'/api/apps',{headers})).status,401);
 const again=await login();const h={Cookie:again.headers.get('set-cookie').split(';')[0]};await again.text();await writeFile(config.tokenFile,'[]');
 assert.equal((await fetch(url+'/api/apps',{headers:h})).status,401);
});
test('soft deletion persists data and URL; purge requires exact confirmation',async t=>{
 const {manager,calls,config}=await fixture(t);
 assert.equal((await manager.deleteApp('demo')).dataRetained,true);
 assert.equal((await manager.status('demo')).status,'deleted');
 assert.equal(calls.some(a=>a[0]==='volume'),false);
 await assert.rejects(()=>manager.setRunning('demo',true),/deploy again/);
 const loaded=new Manager(config,manager.docker);await loaded.init();assert.equal(loaded.state.apps.demo.url,'http://127.0.0.1:18000');
 await assert.rejects(()=>manager.deleteApp('demo',true,'wrong'));
 assert.equal((await manager.deleteApp('demo',true,'demo')).dataRetained,false);
 assert.equal(manager.state.apps.demo,undefined);
 assert.deepEqual(calls.filter(a=>a[0]==='volume'&&a[1]==='rm'),[['volume','rm','local-sites-data-demo']]);
});
test('ownership mismatch and active deployment prevent destructive work',async t=>{
 const {manager,calls,setMismatch}=await fixture(t);
 manager.state.jobs.job={appId:'demo',status:'running'};
 await assert.rejects(()=>manager.deleteApp('demo'),/progress/);delete manager.state.jobs.job;
 setMismatch();await assert.rejects(()=>manager.deleteApp('demo'),/ownership/);
 assert.equal(calls.some(a=>a[0]==='rm'),false);
});
test('failed volume removal retains a recoverable app record',async t=>{
 const {manager,setFailVolume}=await fixture(t);setFailVolume();
 await assert.rejects(()=>manager.deleteApp('demo',true,'demo'),/in use/);
 assert.ok(manager.state.apps.demo.deletedAt);
});
