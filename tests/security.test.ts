import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hmac,visitor,csvCell,body,passwordOK} from '../worker/security.ts';
import {pbkdf2Sync} from 'node:crypto';
test('HMAC domain separation, signed cookie, tamper rejection',async()=>{
 const secret='secret'.repeat(10);assert.notEqual(await hmac(secret,'voter:abc'),await hmac(secret,'cookie:abc'));
 const v=await visitor(new Request('https://test/'),secret);assert.match(v.setCookie,/Secure; HttpOnly; SameSite=Strict/);
 const cookie=v.setCookie.split(';')[0];const same=await visitor(new Request('https://test/',{headers:{Cookie:cookie}}),secret);assert.equal(same.voterHash,v.voterHash);
 await assert.rejects(visitor(new Request('https://test/',{headers:{Cookie:cookie+'x'}}),secret));
 await assert.rejects(visitor(new Request('https://test/',{headers:{Cookie:cookie+'.extra'}}),secret));
});
test('PBKDF2 matches setup helper and rejects wrong password',async()=>{
 const salt='a'.repeat(32),hash=pbkdf2Sync('test-password',salt,100000,32,'sha256').toString('hex');
 assert.equal(await passwordOK('test-password',`100000:${salt}:${hash}`),true);assert.equal(await passwordOK('wrong',`100000:${salt}:${hash}`),false);
});
test('CSV formulas, quotes and control-prefixes',()=>{
 for(const s of ['=1+1','+cmd','-1','@SUM(A1)',' \t=1','\r=1'])assert.ok(csvCell(s).startsWith('"\''));
 assert.equal(csvCell('가면"왕'),'"가면""왕"');
});
test('body length is checked on actual streamed bytes',async()=>{
 await assert.rejects(body(new Request('https://test/',{method:'POST',body:JSON.stringify({x:'a'.repeat(9000)})})));
 await assert.rejects(body(new Request('https://test/',{method:'POST',body:'[]'})));
});
