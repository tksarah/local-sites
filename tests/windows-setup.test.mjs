import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {main} from '../windows-setup/setup-client.mjs';
import {Enrollment} from '../dist/enrollment.js';
import {authenticate} from '../dist/security.js';
test('Windows client enrolls, persists receipt, preserves other plugins and reuses token on rerun',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'windows-client-')),state=path.join(root,'state'),home=path.join(root,'home'),file=path.join(root,'tokens.json');await mkdir(state);await mkdir(path.join(home,'.agents/plugins'),{recursive:true});await writeFile(file,'[]');await writeFile(path.join(home,'.agents/plugins/marketplace.json'),JSON.stringify({name:'personal',plugins:[{name:'other',source:{path:'./plugins/other',source:'local'}}]}));
 const originalFetch=globalThis.fetch,originalEnv={...process.env};let creates=0,installs=0;const s=new Enrollment(file);
 process.env.LOCAL_SITES_SETUP_DIR=state;process.env.LOCAL_SITES_CODEX='C:\\test\\codex.exe';delete process.env.LOCAL_SITES_TOKEN;
 globalThis.fetch=async(url,options)=>{const u=new URL(url),body=JSON.parse(options.body);let result;if(u.pathname==='/mcp'){assert.ok(await authenticate(file,options.headers.Authorization));result={result:{content:[]}};}else if(u.pathname==='/setup/api/requests'){creates++;result=await s.create(body.name);await s.approve(result.id,result.code);}else{const [,id,operation]=u.pathname.match(/requests\/([^/]+)\/(\w+)/),secret=options.headers.Authorization.slice(7);result=await s[operation==='ack'?'acknowledge':operation](id,secret);}return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});};
 const options={connection:{serverUrl:"https://192.0.2.10"},home,pluginSource:path.resolve('plugins/local-sites'),io:{question:async text=>text.includes('端末名')?'windows-test':'YES',close(){}},install:(exe,args)=>{assert.equal(args[2],'local-sites@personal');installs++;return {status:0};}};
 try{await main(options);const first=await readFile(path.join(state,'device.token'),'utf8');assert.equal(await authenticate(file,'Bearer '+first.trim()),'windows-test');const market=JSON.parse(await readFile(path.join(home,'.agents/plugins/marketplace.json'),'utf8'));assert.equal(market.plugins[0].name,'other');assert.equal(market.plugins[1].name,'local-sites');await new Promise(r=>setTimeout(r,5));await main(options);assert.equal(creates,1);assert.equal(installs,2);assert.equal(await readFile(path.join(state,'device.token'),'utf8'),first);}finally{globalThis.fetch=originalFetch;for(const k of ['LOCAL_SITES_SETUP_DIR','LOCAL_SITES_CODEX','LOCAL_SITES_TOKEN']){if(originalEnv[k]===undefined)delete process.env[k];else process.env[k]=originalEnv[k];}await rm(root,{recursive:true,force:true});}
});
