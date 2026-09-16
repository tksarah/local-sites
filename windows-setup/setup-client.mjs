import { readFile, writeFile, mkdir, cp, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
export function mergeMarketplace(current) {
  if(!/^[A-Za-z0-9_-]+$/.test(current.name)||!Array.isArray(current.plugins))throw Error('個人用マーケットプレイスの形式を確認してください。');
  const entry={name:'local-sites',source:{source:'local',path:'./plugins/local-sites'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'};
  const i=current.plugins.findIndex(p=>p.name==='local-sites');if(i>=0)current.plugins[i]=entry;else current.plugins.push(entry);return current;
}
let base;
async function json(url,body,secret){const r=await fetch(base+url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(secret?{Authorization:'Bearer '+secret}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'サーバーに接続できません。時間をおいて再実行してください。');return data;}
async function readJson(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function exists(file){try{await stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function atomic(file,value){const temp=file+'.tmp';await writeFile(temp,value,{mode:0o600});await rename(temp,file);}
async function verify(token){const r=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_apps',arguments:{}}}),signal:AbortSignal.timeout(20000)});const d=await r.json().catch(()=>({}));if(!r.ok||d.error||d.result?.isError||!d.result)throw Error('接続確認に失敗しました。認証情報を上書きせず停止します。管理者に確認してください。');}
export async function main(options={}){
  const settings=options.connection||await readJson(path.join(path.dirname(fileURLToPath(import.meta.url)),'connection.json'));
  const url=new URL(settings?.serverUrl);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw Error('Invalid server URL.');
  base=url.origin;
  const dir=process.env.LOCAL_SITES_SETUP_DIR;if(!dir)throw Error('START.cmdから実行してください。');
  const io=options.io||createInterface({input:process.stdin,output:process.stdout});
  const tokenFile=path.join(dir,'device.token'),pendingFile=path.join(dir,'pending.json');
  try{
    const serverFile=path.join(dir,'server.json'), previous=await readJson(serverFile);
    if(previous && previous.serverUrl!==base)throw Error('This Windows profile is registered to another server. Use a separate profile.');
    await atomic(serverFile,JSON.stringify({serverUrl:base}));
    let token=await exists(tokenFile)?(await readFile(tokenFile,'utf8')).trim():process.env.LOCAL_SITES_TOKEN;
    const pending=await readJson(pendingFile);
    if(pending){
      const status=await json('/setup/api/requests/'+pending.id+'/status',{},pending.secret);
      if(status.status==='approved') {token=(await json('/setup/api/requests/'+pending.id+'/receive',{},pending.secret)).token;await atomic(tokenFile,token+'\n');await json('/setup/api/requests/'+pending.id+'/ack',{},pending.secret);}
      else if(status.status!=='complete')throw Error('前回の申請は未完了です。管理者が承認してから再実行してください。期限切れの場合はREADMEの手順で申請をやり直してください。');
      await rm(pendingFile);console.log('前回の登録を再開しました。');
    }
    if(token && process.env.LOCAL_SITES_TOKEN && token!==process.env.LOCAL_SITES_TOKEN){
      console.log('保存ファイルと既存の環境設定に異なる認証情報があります。値は表示しません。');
      const choice=(await io.question('環境設定を保持する場合 KEEP、保存ファイル側へ変更する場合 REPLACE（それ以外は中止）: ')).trim();
      if(choice==='KEEP')token=process.env.LOCAL_SITES_TOKEN;else if(choice!=='REPLACE')throw Error('認証情報を変更せず中止しました。');
    }
    if(token){console.log('既存の認証情報を再利用します（値は表示しません）。');await verify(token);await atomic(tokenFile,token+'\n');}
    else{
      const name=(await io.question('端末名（英小文字・数字・ハイフン、例 laptop2）: ')).trim();
      const request=await json('/setup/api/requests',{name});await atomic(pendingFile,JSON.stringify(request));
      console.log('管理者に端末名 '+name+' と照合コード '+request.code+' を伝えてください。10分以内に管理画面の「端末管理」で承認します。');
      while(Date.now()<request.expiresAt){
        const state=await json('/setup/api/requests/'+request.id+'/status',{},request.secret);
        if(state.status==='rejected')throw Error('申請は拒否されました。管理者に確認してください。');
        if(state.status==='approved'){
          token=(await json('/setup/api/requests/'+request.id+'/receive',{},request.secret)).token;
          await atomic(tokenFile,token+'\n');await json('/setup/api/requests/'+request.id+'/ack',{},request.secret);await rm(pendingFile);break;
        }
        await new Promise(r=>setTimeout(r,3000));
      }
      if(!token)throw Error('申請の期限が切れました。READMEの再申請手順を確認してください。');
      await verify(token);
    }
    const home=options.home||os.homedir(),marketFile=path.join(home,'.agents/plugins/marketplace.json'),pluginDir=path.join(home,'plugins/local-sites');
    const old=await readJson(marketFile),current=old||{name:'personal',interface:{displayName:'Personal'},plugins:[]};
    const existing=current.plugins?.find(p=>p.name==='local-sites');
    if(existing||await exists(pluginDir)){
      console.log('既存のlocal-sites配布設定があります。配布元: '+(existing?.source?.path||'(未登録)')+' → ./plugins/local-sites');
      console.log('既存の配布フォルダーをバックアップし、このZIPの版に更新します。認証情報と他のプラグインは保持します。');
      if((await io.question('更新する場合は YES: ')).trim()!=='YES')throw Error('プラグイン更新を中止しました。接続情報は保存済みです。');
    }
    const merged=mergeMarketplace(current),backup=path.join(dir,'backup-plugin-'+Date.now());await mkdir(backup);
    if(old)await cp(marketFile,path.join(backup,'marketplace.json'));
    if(await exists(pluginDir))await cp(pluginDir,path.join(backup,'local-sites'),{recursive:true});
    await mkdir(path.dirname(marketFile),{recursive:true});await mkdir(path.dirname(pluginDir),{recursive:true});
    const source=options.pluginSource||path.join(path.dirname(fileURLToPath(import.meta.url)),'plugin');
    await cp(source,pluginDir,{recursive:true});await atomic(marketFile,JSON.stringify(merged,null,2));
    const codex=process.env.LOCAL_SITES_CODEX;
    if(!codex||!codex.toLowerCase().endsWith('.exe'))throw Error('Codexの実行ファイルが見つかりません。Codexアプリを更新してください。');
    const result=(options.install||spawnSync)(codex,['plugin','add','local-sites@'+merged.name],{encoding:'utf8',windowsHide:true,timeout:120000});
    if(result.status!==0)throw Error('プラグインのインストールを完了できませんでした。Codexを再起動し、プラグイン一覧からlocal-sitesをインストールしてください。設定は保存済みです。');
    console.log('端末の登録とプラグインの接続確認が完了しました。');
  }finally{io.close();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main().catch(e=>{console.error(e.message);process.exitCode=1;});
