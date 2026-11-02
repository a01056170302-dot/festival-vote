import {randomBytes,pbkdf2Sync} from 'node:crypto';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {spawnSync} from 'node:child_process';
const hidden=new Writable({write(_c,_e,done){done();}});
const rl=createInterface({input:process.stdin,output:hidden,terminal:true});
const ask=msg=>new Promise(resolve=>{process.stdout.write(msg);rl.question('',s=>{process.stdout.write('\n');resolve(s);});});
const a=await ask('새 관리자 비밀번호 (16~128자, 표시되지 않음): '),b=await ask('한 번 더 입력: ');rl.close();
if(a!==b||a.length<16||a.length>128){console.error('길이 또는 일치 여부를 확인하세요.');process.exit(1);}
const salt=randomBytes(16).toString('hex'),hash=`100000:${salt}:${pbkdf2Sync(a,salt,100000,32,'sha256').toString('hex')}`;
const r=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','put','ADMIN_PASSWORD_HASH'],{input:hash+'\n',stdio:['pipe','inherit','inherit']});
if(r.status!==0)process.exit(r.status||1);
console.log('비밀번호 해시를 변경했습니다. 필요하면 기존 관리자 세션을 별도로 무효화하세요. 방문자 비밀키는 유지됩니다.');
