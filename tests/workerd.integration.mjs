// Optional real workerd/D1 compatibility check. Requires npm dependencies.
import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex');
const mf = new Miniflare({
  modules: true, scriptPath: '.worker-test/index.js', compatibilityDate: '2026-10-01',
  d1Databases: ['DB'], serviceBindings: { ASSETS: () => new Response('asset') },
  bindings: { COOKIE_SECRET:randomBytes(32).toString('hex'), SESSION_SECRET:randomBytes(32).toString('hex'), ADMIN_PASSWORD_HASH:`100000:${salt}:${pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex')}` }
});
try {
  const db=await mf.getD1Database('DB');
  const split=spawnSync('python3',['-c',`import sqlite3,json,sys
out=[];buf=''
for line in open(sys.argv[1]):
 buf+=line
 if sqlite3.complete_statement(buf):
  out.append(buf);buf=''
print(json.dumps(out))`,'migrations/0001_initial.sql'],{encoding:'utf8',timeout:5000});
  assert.equal(split.status,0,split.stderr);
  for(const sql of JSON.parse(split.stdout))await db.prepare(sql).run();
  let ac='',csrf='';
  async function call(path,data,cookie=ac){
    const headers={Cookie:cookie};if(data!==undefined){headers.Origin='https://festival.test';headers['Content-Type']='application/json';headers['X-CSRF-Token']=csrf;}
    const res=await mf.dispatchFetch('https://festival.test/api/'+path,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data)});
    const value=await res.json();return {res,status:res.status,value,cookie:res.headers.get('Set-Cookie')?.split(';')[0]};
  }
  assert.equal((await call('admin/history')).status,401);
  const login=await call('admin/login',{password},'');assert.equal(login.status,200);ac=login.cookie;csrf=login.value.csrf;
  const a=(await call('admin/participants',{display_name:'학생A',mask_name:'가면A'})).value.id;
  const b=(await call('admin/participants',{display_name:'학생B',mask_name:'가면B'})).value.id;
  const created=await call('admin/matches',{match_title:'실환경 호환 시험',round_label:'시험',participant_a_id:a,participant_b_id:b,event_version:1});assert.equal(created.status,201);const id=created.value.match.id;
  assert.equal((await call('admin/matches/'+id+'/open',{version:1})).status,200);
  const vc=(await call('public/my-vote?match_id='+id,undefined,'')).cookie;
  const payload={match_id:id,selected_participant_id:a,request_id:crypto.randomUUID()};
  const requests=await Promise.all(Array.from({length:8},()=>call('public/vote',payload,vc)));assert.ok(requests.every(r=>r.status===200));
  assert.equal((await call('admin/matches/'+id+'/stats')).value.total,1);
  assert.equal((await call('public/state')).value.result,null);
  assert.equal((await call('admin/matches/'+id+'/close',{version:2})).status,200);
  const fresh=(await call('public/my-vote?match_id='+id,undefined,'')).cookie;
  assert.equal((await call('public/vote',{...payload,request_id:crypto.randomUUID()},fresh)).status,409);
  assert.equal((await call('public/vote',payload,vc)).status,200);
  assert.equal((await call('public/result?match_id='+id)).status,404);
  assert.equal((await call('admin/matches/'+id+'/publish',{version:3})).status,200);
  assert.equal((await call('public/result?match_id='+id)).value.total,1);
  console.log('workerd / D1 compatibility checks passed');
} finally { await mf.dispose(); }
