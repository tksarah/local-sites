import { randomBytes, createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tokenTransaction } from '../dist/token-store.js';
const [action, name, directory = '/var/lib/local-sites'] = process.argv.slice(2);
if (!['create', 'revoke'].includes(action) || !/^[a-z][a-z0-9-]{0,39}$/.test(name || '')) throw new Error('Usage: token.mjs create|revoke device-name [data-directory]');
await mkdir(directory, { recursive: true, mode: 0o700 });
await tokenTransaction(path.join(directory,'tokens.json'), async entries=>{
  if(action==='create'){
    if(entries.some(e=>e.name===name))throw Error('Name already exists');
    const token=randomBytes(32).toString('base64url');
    await writeFile(path.join(directory,name+'.token'),token+'\n',{mode:0o600,flag:'wx'});
    entries.push({name,sha256:createHash('sha256').update(token).digest('hex'),createdAt:Date.now()});
  }else{const i=entries.findIndex(e=>e.name===name);if(i>=0)entries.splice(i,1);}
});
console.log(action==='create'?'Created credential file: '+path.join(directory,name+'.token'):'Revoked '+name);
