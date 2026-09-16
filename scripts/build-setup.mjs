import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function buildSetup(config) {
const files=[];
const windowsFiles = ['START.cmd','RESUME-DNS.cmd','README-ja.txt','setup.ps1','setup-client.mjs','dns.ps1','config.ps1'];
const pluginFiles = ['.mcp.json','.codex-plugin/plugin.json','skills/local-sites/SKILL.md','scripts/client.mjs','examples/notes/Dockerfile','examples/notes/local-sites.json','examples/notes/package.json','examples/notes/server.mjs'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const [folder, prefix, names] of [['windows-setup','local-sites-windows',windowsFiles],['plugins/local-sites','local-sites-windows/plugin',pluginFiles]]) {
  for (const name of names) {
    let current = root;
    for (const part of (folder+'/'+name).split('/')) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw Error('Distribution source must not contain links');
    }
    const bytes = await readFile(current);
    if (/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(bytes.toString())) throw Error('Private key in distribution source');
    files.push([prefix+'/'+name, bytes]);
  }
}
const settings={serverUrl:config.origin,siteIp:config.ip,lanCidr:config.lanCidr,appDomain:config.appDomain,portalUrl:config.portalOrigin};
files.push(['local-sites-windows/connection.json',Buffer.from(JSON.stringify(settings,null,2))]);
files.push(['local-sites-windows/plugin/connection.json',Buffer.from(JSON.stringify(settings,null,2))]);
for (const entry of files) {
 if(entry[0].endsWith('/.mcp.json')) entry[1]=Buffer.from(JSON.stringify({mcpServers:{'local-sites':{type:'http',url:config.origin+'/mcp',bearer_token_env_var:'LOCAL_SITES_TOKEN'}}},null,2));
}
function crc(data){let c=0xffffffff;for(const v of data){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
const local=[],central=[];let offset=0;
for(const [name,data] of files){const n=Buffer.from(name),sum=crc(data),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(33,12);h.writeUInt32LE(sum,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);local.push(h,n,data);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(33,14);c.writeUInt32LE(sum,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=h.length+n.length+data.length;}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const {configuration}=await import('../dist/config.js');
 await mkdir('setup-public',{recursive:true});
 await writeFile('setup-public/windows.zip',await buildSetup(configuration()));
 console.log('Setup ZIP built from explicit allowlist and current configuration.');
}
