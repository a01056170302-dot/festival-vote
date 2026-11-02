import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
const remote = process.argv.includes('--remote');
if (!remote) { try { await access('.dev.vars'); console.error('.dev.vars가 이미 있습니다. 기존 키와 투표 식별자를 보존하기 위해 중단합니다.');process.exit(1); }catch(e){if(e.code!=='ENOENT')throw e;} }
const silent = new Writable({write(_chunk,_encoding,done){done();}});
const rl = createInterface({ input:process.stdin, output:silent, terminal:true });
const ask = text => new Promise(resolve=>{ process.stdout.write(text);rl.question('',answer=>{process.stdout.write('\n');resolve(answer);}); });
const password=await ask('관리자 비밀번호 (화면에 표시되지 않음, 16~128자): ');
const confirm=await ask('비밀번호 재입력: ');rl.close();
if(password!==confirm||password.length<16||password.length>128){console.error('비밀번호가 일치하지 않거나 길이가 올바르지 않습니다.');process.exit(1);}
const salt=randomBytes(16).toString('hex');
const secrets={ ADMIN_PASSWORD_HASH:`100000:${salt}:${pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex')}`, COOKIE_SECRET:randomBytes(32).toString('hex'), SESSION_SECRET:randomBytes(32).toString('hex') };
if(remote){
  console.log('초기 배포용 비밀키를 등록합니다. 이미 행사 중인 서버에는 실행하지 마세요. 키 교체는 기존 방문자 식별을 변경합니다.');
  for(const [name,value] of Object.entries(secrets)){
    const p=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','put',name],{input:value+'\n',stdio:['pipe','inherit','inherit']});if(p.status!==0)process.exit(p.status||1);
  }
}else{await writeFile('.dev.vars',Object.entries(secrets).map(([k,v])=>`${k}="${v}"`).join('\n')+'\n',{mode:0o600,flag:'wx'});console.log('.dev.vars 생성 완료. Git에 올리지 마세요.');}
