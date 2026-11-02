import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync } from 'node:crypto';
import worker from '../worker/index.ts';
const root = fileURLToPath(new URL('..',import.meta.url));
const dir=mkdtempSync(join(tmpdir(),'festival-api-')), db=join(dir,'db.sqlite');
const setup=spawnSync('python3',['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(open(sys.argv[2]).read()); c.close()",db,root+'/migrations/0001_initial.sql'],{encoding:'utf8',timeout:5000});
assert.equal(setup.status,0,setup.stderr);
function execute(statements){const payloadFile=join(dir,'call.json');writeFileSync(payloadFile,JSON.stringify({db,statements}),{mode:0o600});const p=spawnSync('python3',[root+'/tests/sql_bridge.py',payloadFile],{encoding:'utf8',timeout:5000});if(p.status!==0)throw new Error(p.stderr);return JSON.parse(p.stdout);}
class Statement{
  constructor(sql,args=[]){this.sql=sql;this.args=args;}
  bind(...args){return new Statement(this.sql,args);}
  async run(){return execute([this])[0];}
  async all(){return this.run();}
  async first(){return (await this.run()).results[0]||null;}
}
const salt='1'.repeat(32), password='offline-integration-test-password';
const env={DB:{prepare:sql=>new Statement(sql),batch:async stmts=>execute(stmts)},ASSETS:{fetch:async()=>new Response('asset')},COOKIE_SECRET:'cookie-test-key-'.repeat(5),SESSION_SECRET:'session-test-key-'.repeat(5),ADMIN_PASSWORD_HASH:'100000:'+salt+':'+pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex')};
const origin='https://festival.test';
let adminCookie='',csrf='';
async function call(path,data,opts={}){
  const headers=new Headers();if(data!==undefined){headers.set('Origin',opts.badOrigin?'https://evil.test':origin);headers.set('Content-Type','application/json');if(csrf)headers.set('X-CSRF-Token',csrf);}
  if(opts.cookie||path.startsWith('admin/'))headers.set('Cookie',opts.cookie??adminCookie);
  if(opts.noCSRF)headers.delete('X-CSRF-Token');
  const res=await worker.fetch(new Request(origin+'/api/'+path,{method:data===undefined?'GET':opts.method||'POST',headers,body:data===undefined?undefined:JSON.stringify(data)}),env);
  const content=res.headers.get('Content-Type')||'';const result=content.includes('application/json')?await res.json():await res.text();
  return {res,status:res.status,data:result,cookie:res.headers.get('Set-Cookie')?.split(';')[0]};
}
const uid=()=>crypto.randomUUID();
test('full festival lifecycle, access controls, idempotency and result secrecy',async()=>{
 try{
  assert.equal((await call('admin/participants')).status,401);
  assert.equal((await call('admin/login',{password},{badOrigin:true})).status,403);
  assert.equal((await call('admin/login',{password:'incorrect'})).status,401);
  const login=await call('admin/login',{password});assert.equal(login.status,200);adminCookie=login.cookie;csrf=login.data.csrf;
  assert.match(login.res.headers.get('Set-Cookie'),/Secure; HttpOnly; SameSite=Strict/);
  assert.equal((await call('admin/participants',{display_name:'a',mask_name:'b'},{noCSRF:true})).status,403);
  const ids=[];
  for(let i=0;i<16;i++){const p=await call('admin/participants',{display_name:'학생'+i,mask_name:'복면'+i});assert.equal(p.status,200);ids.push(p.data.id);}
  assert.equal((await call('admin/participants')).data.participants.length,16);
  let dash=(await call('admin/dashboard')).data;
  assert.equal((await call('admin/matches',{match_title:'실패',round_label:'16강',participant_a_id:ids[0],participant_b_id:ids[0],event_version:dash.event.version})).status,400);
  const create=async(a,b,title)=>call('admin/matches',{match_title:title,round_label:'16강',participant_a_id:a,participant_b_id:b,event_version:(await call('admin/dashboard')).data.event.version});
  const first=await create(ids[0],ids[1],'첫 경기');assert.equal(first.status,201);const id=first.data.match.id;
  const action=async(kind)=>{const d=(await call('admin/dashboard')).data;return call(`admin/matches/${d.match.id}/${kind}`,{version:d.match.version});};
  const boot=await call('public/my-vote?match_id='+id),vc=boot.cookie;assert.ok(vc);
  const payload={match_id:id,selected_participant_id:ids[0],request_id:uid()};
  assert.equal((await call('public/vote',payload,{cookie:vc})).status,409);
  assert.equal((await action('publish')).status,409);
  assert.equal((await action('open')).status,200);
  assert.equal((await create(ids[2],ids[3],'열린 중 생성')).status,409);
  assert.equal((await call('public/vote',payload,{cookie:vc.slice(0,-1)+'x'})).status,401);
  assert.equal((await call('public/vote',{...payload,selected_participant_id:ids[2]},{cookie:vc})).status,409);
  const results=await Promise.all(Array.from({length:8},()=>call('public/vote',payload,{cookie:vc})));assert.ok(results.every(r=>r.status===200));
  assert.ok(results.every(r=>r.data.vote.request_id===payload.request_id));
  assert.equal((await call('public/vote',{...payload,selected_participant_id:ids[1],request_id:uid()},{cookie:vc})).status,409);
  assert.equal((await call('public/my-vote?match_id='+id,undefined,{cookie:vc})).data.vote.selected_participant_id,ids[0]);
  let state=(await call('public/state')).data;assert.equal(state.result,null);assert.ok(!JSON.stringify(state).includes('a_votes'));assert.ok(!JSON.stringify(state).includes('학생'));
  assert.equal((await call('public/result?match_id='+id)).status,404);
  assert.equal((await call('admin/matches/'+id+'/stats')).data.total,1);
  await call('admin/participants/'+ids[0],{display_name:'바뀐 이름',mask_name:'바뀐 복면',active:false},{method:'PATCH'});
  assert.equal((await call('public/state')).data.match.a.name,'복면0');
  assert.equal((await action('close')).status,200);
  assert.equal((await call('public/vote',payload,{cookie:vc})).status,200); // lost response retry after close
  const vc2=(await call('public/my-vote?match_id='+id)).cookie;
  assert.equal((await call('public/vote',{...payload,request_id:uid()},{cookie:vc2})).status,409);
  assert.equal((await call('public/result?match_id='+id)).status,404);
  state=(await call('public/state')).data;assert.equal(state.result,null);
  assert.equal((await action('reopen')).status,200);assert.equal((await call('admin/matches/'+id+'/stats')).data.total,1);
  assert.equal((await action('close')).status,200);assert.equal((await action('publish')).status,200);
  assert.equal((await call('public/result?match_id='+id)).data.a_votes,1);
  assert.equal((await action('reopen')).status,409);
  const second=await create(ids[2],ids[3],'둘째 경기');assert.equal(second.status,201);const secondId=second.data.match.id;
  assert.equal((await action('open')).status,200);
  assert.equal((await call('public/vote',{...payload,request_id:uid()},{cookie:vc2})).status,409);
  assert.equal((await call('public/vote',{match_id:secondId,selected_participant_id:ids[3],request_id:uid()},{cookie:vc})).status,200);
  assert.equal((await call('admin/matches/'+id+'/stats')).data.total,1);
  assert.equal((await call('admin/matches/'+secondId+'/stats')).data.total,1);
  const vc3=(await call('public/my-vote?match_id='+secondId)).cookie;
  assert.equal((await call('public/vote',{match_id:secondId,selected_participant_id:ids[2],request_id:uid()},{cookie:vc3})).status,200);
  assert.equal((await call('admin/matches/'+secondId+'/stats')).data.total,2);
  assert.equal((await call('admin/matches/'+secondId+'/close',{version:1})).status,409);
  const csv=await call('admin/export/csv');assert.equal(csv.status,200);assert.ok(csv.data.includes('첫 경기'));assert.ok(!csv.data.includes('voter_hash'));assert.ok(csv.res.headers.get('Content-Type').includes('text/csv'));
  assert.equal((await call('admin/history')).data.matches.length,2);
  await action('close');await action('publish');
  const tied=(await call('public/result?match_id='+secondId)).data;assert.equal(tied.tie,true);assert.equal(tied.winner,null);assert.equal(tied.a_percent,50);
  const history=(await call('admin/history')).data.matches;assert.equal(history.reduce((n,m)=>n+m.total,0),3);
  await call('admin/logout',{});assert.equal((await call('admin/session')).status,401);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
