import { randomBytes, randomInt } from 'node:crypto';
import { digest } from './security.js';
import { tokenTransaction } from './token-store.js';
type Request = { id: string; name: string; code: string; secretHash: string; expiresAt: number; status: 'pending'|'approved'|'rejected'|'complete'; token?: string };
export class Enrollment {
  private requests = new Map<string, Request>();
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  constructor(private file: string, private now = () => Date.now()) {
    this.ready = tokenTransaction(file, entries => { for (let i=entries.length-1;i>=0;i--) if(entries[i].pending) entries.splice(i,1); });
    this.ready.catch(() => {});
  }
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => { await this.ready; await this.expire(); return fn(); });
    this.queue = task.catch(() => {}); return task;
  }
  private async expire() {
    const expired = [...this.requests.values()].filter(r=>r.expiresAt<=this.now());
    if(!expired.length)return;
    await tokenTransaction(this.file, entries=>{for(let i=entries.length-1;i>=0;i--)if(entries[i].pending && (entries[i].expiresAt||0)<=this.now())entries.splice(i,1);});
    expired.forEach(r=>this.requests.delete(r.id));
  }
  create(name: string) { return this.run(async()=>{
    if(!/^[a-z][a-z0-9-]{0,39}$/.test(name))throw Error('端末名は英小文字で始まる英小文字・数字・ハイフン40文字以内です。');
    if(this.requests.size>=100)throw Error('申請が混み合っています。10分後に再実行してください。');
    if([...this.requests.values()].some(r=>r.name===name && r.status!=='rejected'))throw Error('この端末名は申請済みです。');
    await tokenTransaction(this.file, entries=>{if(entries.some(e=>e.name===name))throw Error('この端末名は登録済みです。');});
    const secret=randomBytes(32).toString('base64url'), id=randomBytes(24).toString('hex');
    let code: string; do {code=String(randomInt(10000000,100000000));} while([...this.requests.values()].some(r=>r.code===code));
    const request: Request={id,name,code,secretHash:digest(secret),expiresAt:this.now()+600000,status:'pending'};
    this.requests.set(id,request); return {id,secret,code,expiresAt:request.expiresAt};
  }); }
  private get(id: string, secret?: string) {
    const r=this.requests.get(id); if(!r || (secret!==undefined && digest(secret)!==r.secretHash))throw Error('申請が見つからないか、有効期限が切れています。'); return r;
  }
  status(id: string, secret: string) {return this.run(async()=>{const r=this.get(id,secret);return {status:r.status,expiresAt:r.expiresAt};});}
  receive(id: string, secret: string) {return this.run(async()=>{const r=this.get(id,secret);if(r.status!=='approved'||!r.token)throw Error('資格情報は受領できません。');return {token:r.token,expiresAt:r.expiresAt};});}
  acknowledge(id: string, secret: string) {return this.run(async()=>{const r=this.get(id,secret);if(r.status==='complete')return {ok:true};if(r.status!=='approved')throw Error('未承認です。');await tokenTransaction(this.file, entries=>{const e=entries.find(e=>e.name===r.name && e.sha256===digest(r.token!));if(!e)throw Error('認証情報は失効しています。');delete e.pending;delete e.expiresAt;});r.status='complete';delete r.token;return {ok:true};});}
  list(){return this.run(async()=>({requests:[...this.requests.values()].filter(r=>r.status==='pending'||r.status==='approved').map(({id,name,status,expiresAt})=>({id,name,status,expiresAt})),devices:await tokenTransaction(this.file, entries=>entries.filter(e=>!e.pending).map(({name,createdAt})=>({name,createdAt})))}));}
  approve(id: string, code: string){return this.run(async()=>{const r=this.get(id);if(r.code!==code)throw Error('照合コードが一致しません。');if(r.status!=='pending')throw Error('この申請は処理済みです。');const token=randomBytes(32).toString('base64url');await tokenTransaction(this.file, entries=>{if(entries.some(e=>e.name===r.name))throw Error('端末名は登録済みです。');entries.push({name:r.name,sha256:digest(token),pending:true,expiresAt:r.expiresAt,createdAt:this.now()});});r.token=token;r.status='approved';return {ok:true};});}
  reject(id: string){return this.run(async()=>{const r=this.get(id);if(r.status==='complete')throw Error('登録済み端末は失効操作を使ってください。');await tokenTransaction(this.file, entries=>{const i=entries.findIndex(e=>e.name===r.name&&e.pending);if(i>=0)entries.splice(i,1);});r.status='rejected';delete r.token;return {ok:true};});}
  revoke(name: string){return this.run(async()=>{await tokenTransaction(this.file, entries=>{const i=entries.findIndex(e=>e.name===name);if(i<0)throw Error('端末が見つかりません。');entries.splice(i,1);});for(const r of this.requests.values())if(r.name===name){r.status='rejected';delete r.token;}return {ok:true};});}
}
