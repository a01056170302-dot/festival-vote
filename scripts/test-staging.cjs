const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes, pbkdf2Sync } = require('node:crypto');
const dbId = process.argv[2];
const usersArg=process.argv.find(arg=>arg.startsWith('--users='));
const users=usersArg?Number(usersArg.slice('--users='.length)):700;
if(!Number.isInteger(users)||users<1||users>700){console.error('Use --users=500 or another integer from 1 to 700.');process.exit(1);}
const scenarioArg = process.argv.find(arg=>arg.startsWith('--scenarios='));
const scenarios = scenarioArg ? scenarioArg.slice('--scenarios='.length).split(',') : ['A','B','C','D','E','F'];
if (!scenarios.length || scenarios.some(s=>!['A','B','C','D','E','F'].includes(s))) { console.error('Use --scenarios=B or --scenarios=A,B,C,D,E,F'); process.exit(1); }
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dbId || '')) {
  console.error('Usage: node test-staging.cjs NEW_TEST_DATABASE_ID'); process.exit(1);
}
if (!fs.existsSync('worker/index.ts') || !fs.existsSync('load/festival.js')) {
  console.error('Run this inside the festival-vote project folder.'); process.exit(1);
}
const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'));
if (config.d1_databases.some(db => db.database_id === dbId)) {
  console.error('REFUSED: this is the existing website database. Create festival-vote-test and use its ID.'); process.exit(1);
}
const standardK6 = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'k6', 'k6.exe');
const k6Executable = process.platform === 'win32' && fs.existsSync(standardK6) ? standardK6 : 'k6';
const k6 = spawnSync(k6Executable, ['version'], { stdio: 'inherit' });
if (k6.error || k6.status !== 0) {
  console.error('Install k6 first: winget install k6 --source winget');
  console.error('Then reopen the VS Code terminal and rerun this script.'); process.exit(1);
}
function runNode(file, args = [], input, capture = false) {
  const result = spawnSync(process.execPath, [file, ...args], {
    input, stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  });
  if (capture && result.stdout) process.stdout.write(result.stdout);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Command failed: ' + path.basename(file));
  return result.stdout || '';
}
const loadFile = 'load/festival-staging.js';
const loadSource = "import http from 'k6/http';\nimport {check,sleep,fail} from 'k6';\nimport exec from 'k6/execution';\nimport {Counter,Trend} from 'k6/metrics';\nconst mode=__ENV.SCENARIO||'B';\nconst audienceSize=Number(__ENV.VUS||700);\nif(!Number.isInteger(audienceSize)||audienceSize<1||audienceSize>700)throw new Error('VUS must be an integer from 1 to 700.');\nconst base=(__ENV.BASE_URL||'http://localhost:8787').replace(/\\/$/,'');\nconst local=/^https?:\\/\\/(localhost|127\\.0\\.0\\.1|\\[::1\\])(?::\\d+)?$/.test(base);\nif(!local&&__ENV.ALLOW_REMOTE_LOAD_TEST!=='YES')throw new Error('\uc6d0\uaca9 \ubd80\ud558\ub294 \uba85\uc2dc\uc801\uc73c\ub85c \ud5c8\uac00\ub41c \uc2a4\ud14c\uc774\uc9d5\uc5d0\uc11c ALLOW_REMOTE_LOAD_TEST=YES\ub85c\ub9cc \uc2e4\ud589\ud558\uc138\uc694.');\nif(!['A','B','C','D','E','F'].includes(mode))throw new Error('SCENARIO=A~F');\nconst accepted=new Counter('accepted_votes');\nconst voteDuration=new Trend('vote_endpoint_duration',true);\nconst initialVoteDuration=new Trend('vote_initial_duration',true);\nconst voteCodes={};\nfor(const code of [0,200,400,401,403,408,409,428,429,500,502,503,504])voteCodes[code]=new Counter('vote_http_'+code);\nconst otherVoteCode=new Counter('vote_http_other');\nconst workerLimitHints=new Counter('vote_worker_limit_hints');\nconst initialErrors=new Counter('vote_initial_errors');\nconst savedAfterError=new Counter('vote_saved_despite_error');\nconst confirmedAfterRetry=new Counter('vote_confirmed_after_retry');\nconst unresolvedAfterError=new Counter('vote_unresolved_after_error');\nconst identityErrors=new Counter('identity_initial_errors');\nconst identityRecovered=new Counter('identity_recovered');\nconst identityUnresolved=new Counter('identity_unresolved');\nconst identityLimitHints=new Counter('identity_worker_limit_hints');\nfunction reportError(response,phase,event){\n const status=Number(response.status)||0;\n let apiCode=null,errorId=null;\n try{const e=response.json()?.error;const c=e?.code;if(typeof c==='string'&&/^[A-Z0-9_]{1,60}$/.test(c))apiCode=c;if(typeof e?.error_id==='string'&&/^[0-9a-f-]{36}$/i.test(e.error_id))errorId=e.error_id;}catch{}\n const text=typeof response.body==='string'?response.body:'';\n const edgeCode=text.match(/(?:error(?:\\s+code)?\\s*[:=]?\\s*)(10\\d{2}|11\\d{2})/i)?.[1]||null;\n const resourceLimit=/worker exceeded (?:cpu|resource) limits|exceeded cpu time limit/i.test(text)||edgeCode==='1102';\n const headers=response.headers||{};\n console.warn(JSON.stringify({event,scenario:mode,phase,http_status:status,api_code:apiCode,error_id:errorId,edge_code:edgeCode,resource_limit_hint:resourceLimit,cf_ray:headers['Cf-Ray']||headers['CF-Ray']||null,network_error_code:response.error_code||null}));\n return resourceLimit;\n}\nfunction diagnostic(response,phase){\n const status=Number(response.status)||0;\n (voteCodes[status]||otherVoteCode).add(1);\n if(response.timings){voteDuration.add(response.timings.duration);if(phase==='initial')initialVoteDuration.add(response.timings.duration);}\n const expected=status===200||(['D','F'].includes(mode)&&status===409);\n if(!expected&&reportError(response,phase,'vote_response_error'))workerLimitHints.add(1);\n}\nfunction identityCookie(response){\n const received=response.cookies?.['__Host-festival-voter']?.[0]?.value;\n if(received)return '__Host-festival-voter='+received;\n const jar=http.cookieJar();\n const stored=typeof jar.cookiesForURL==='function'?jar.cookiesForURL(base)?.['__Host-festival-voter']?.[0]:null;\n return stored?'__Host-festival-voter='+stored:'';\n}\nfunction bootstrap(matchId){\n let response=get('public/my-vote?match_id='+matchId);\n let cookie=identityCookie(response);\n const initiallyReady=response.status===200&&!!cookie;\n check(response,{'identity initial response':()=>initiallyReady});\n if(!initiallyReady){\n   identityErrors.add(1);\n   if(reportError(response,'initial','identity_response_error'))identityLimitHints.add(1);\n   for(let attempt=0;attempt<2&&[0,408,500,502,503,504].includes(Number(response.status));attempt++){\n     sleep(0.3*Math.pow(2,attempt)+Math.random()*0.4);\n     response=get('public/my-vote?match_id='+matchId);cookie=identityCookie(response);\n     if(response.status===200&&cookie){identityRecovered.add(1);break;}\n     if(reportError(response,'bootstrap-retry','identity_response_error'))identityLimitHints.add(1);\n   }\n }\n const ready=response.status===200&&!!cookie;\n check(response,{'identity available before vote':()=>ready});\n if(!ready){identityUnresolved.add(1);return '';}\n return cookie;\n}\n\nfunction confirmedVote(response,payload){\n if(response.status!==200)return false;\n try{const v=response.json()?.vote;return v?.match_id===payload.match_id&&v?.selected_participant_id===payload.selected_participant_id&&v?.request_id===payload.request_id;}catch{return false;}\n}\nfunction reconcileFailure(payload,cookie,initialStatus){\n // Preserve the original failed check. Recovery never converts B into a passing initial-response test.\n sleep(0.3+Math.random()*0.5);\n const lookup=get('public/my-vote?match_id='+payload.match_id,cookie);\n if(confirmedVote(lookup,payload)){savedAfterError.add(1);return;}\n if(![0,408,500,502,503,504].includes(initialStatus)){unresolvedAfterError.add(1);return;}\n const retry=post('public/vote',payload,cookie,undefined,'recovery-retry');\n if(confirmedVote(retry,payload)){confirmedAfterRetry.add(1);return;}\n const last=get('public/my-vote?match_id='+payload.match_id,cookie);\n if(confirmedVote(last,payload)){confirmedAfterRetry.add(1);return;}\n unresolvedAfterError.add(1);\n}\n\nexport const options={\n scenarios:mode==='A'?{audience:{executor:'constant-vus',vus:audienceSize,duration:'1m'}}:mode==='D'?{voters:{executor:'per-vu-iterations',vus:audienceSize,iterations:1,maxDuration:'2m',exec:'audience'},closer:{executor:'per-vu-iterations',vus:1,iterations:1,startTime:'500ms',maxDuration:'2m',exec:'closeMatch'}}:{audience:{executor:'per-vu-iterations',vus:mode==='C'?Math.min(10,audienceSize):audienceSize,iterations:1,maxDuration:'3m'}},\n thresholds:{http_req_duration:['p(95)<3000'],...(!['A','C'].includes(mode)?{vote_initial_duration:['p(95)<3000']}:{ }),http_req_failed:['rate<0.01'],checks:['rate==1']},\n summaryTrendStats:['avg','med','p(95)','p(99)','max'],\n};\n// Expected 409 rejections are successful HTTP behavior for race and stale-vote tests.\nhttp.setResponseCallback(http.expectedStatuses({min:200,max:299},409));\nfunction id(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{let r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16);});}\nfunction parse(r){try{return r.json();}catch{fail('JSON \uc751\ub2f5 \uc544\ub2d8: HTTP '+r.status);}}\nfunction opts(cookie,csrf){return {headers:{'Content-Type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},responseType:'text'};}\nfunction post(path,data,cookie,csrf,phase='initial'){const r=http.post(base+'/api/'+path,JSON.stringify(data),opts(cookie,csrf));if(path==='public/vote')diagnostic(r,phase);else if(r.status<200||r.status>=300)reportError(r,path,'admin_response_error');return r;}\nfunction get(path,cookie){const r=http.get(base+'/api/'+path,opts(cookie));if(path.startsWith('admin/')&&(r.status<200||r.status>=300))reportError(r,path,'admin_response_error');return r;}\nexport function setup(){\n if(!__ENV.ADMIN_PASSWORD)throw new Error('\ud14c\uc2a4\ud2b8 \uc11c\ubc84\uc758 ADMIN_PASSWORD \ud658\uacbd\ubcc0\uc218\uac00 \ud544\uc694\ud569\ub2c8\ub2e4.');\n const login=post('admin/login',{password:__ENV.ADMIN_PASSWORD});if(login.status!==200)throw new Error('\uad00\ub9ac\uc790 \ub85c\uadf8\uc778 \uc2e4\ud328: '+login.status);\n const cookie=Object.entries(login.cookies).map(([k,v])=>k+'='+v[0].value).join('; '),csrf=parse(login).csrf;\n const dashboard=get('admin/dashboard',cookie);if(dashboard.status!==200)throw new Error('Dashboard setup failed: HTTP '+dashboard.status);\n const existing=parse(dashboard);if(existing.match?.status==='OPEN')throw new Error('\uc5f4\ub824 \uc788\ub294 \uacbd\uae30\uac00 \uc788\uc2b5\ub2c8\ub2e4. \ud14c\uc2a4\ud2b8 \uc804\uc5d0 \ub9c8\uac10\ud558\uc138\uc694.');\n let people=[];for(let i=0;i<4;i++){const p=post('admin/participants',{display_name:'\ubd80\ud558\uc2dc\ud5d8 \uc804\uc6a9 '+i,mask_name:'\uc2dc\ud5d8 \uac00\uba74 '+i},cookie,csrf);if(p.status!==200)throw new Error('Participant setup failed: HTTP '+p.status);people.push(parse(p).id);}\n const create=(a,b,title)=>{const state=get('admin/dashboard',cookie);if(state.status!==200)throw new Error('Dashboard setup failed: HTTP '+state.status);const e=parse(state).event;const r=post('admin/matches',{match_title:title,round_label:'\ubd80\ud558\uc2dc\ud5d8 '+mode,participant_a_id:a,participant_b_id:b,event_version:e.version},cookie,csrf);if(r.status!==201)throw new Error('Match setup failed: HTTP '+r.status);return parse(r).match;};\n const transition=(m,act)=>{const r=post('admin/matches/'+m.id+'/'+act,{version:m.version},cookie,csrf);if(r.status!==200)throw new Error('Transition '+act+' failed: HTTP '+r.status);return parse(r).match;};\n let m=create(people[0],people[1],'k6 '+mode+' '+Date.now());m=transition(m,'open');let old=null;\n if(mode==='F'){\n  const voter=bootstrap(m.id);if(!voter)throw new Error('Identity bootstrap failed');\n  const seed=post('public/vote',{match_id:m.id,selected_participant_id:m.participant_a_id,request_id:id()},voter);\n  if(seed.status!==200)throw new Error('\uc774\uc804 \uacbd\uae30 \ubcf4\uc874 \uac80\uc99d\uc6a9 \ud22c\ud45c \uc2e4\ud328');\n  old=m;m=transition(m,'close');m=transition(m,'publish');m=create(people[2],people[3],'\uacbd\uae30 \uc804\ud658 \uc2dc\ud5d8');m=transition(m,'open');\n }\n let sharedCookie='';if(mode==='C'){sharedCookie=bootstrap(m.id);if(!sharedCookie)throw new Error('Identity bootstrap failed');}\n http.cookieJar().clear(base);return {match:m,old,people,cookie,csrf,sharedCookie};\n}\nexport default function(data){audience(data);}\nexport function audience(data){\n const m=data.match;\n if(mode==='A'){const r=get('public/state');check(r,{'state 200':r=>r.status===200,'prepublish no counts':r=>parse(r).result===null&&!r.body.includes('a_votes')});sleep(10+Math.random()*4);return;}\n if(mode==='D')sleep(Math.random());\n let vc=data.sharedCookie;\n if(!vc){vc=bootstrap(m.id);if(!vc)return;}\n const target=mode==='F'?data.old:m;\n const payload={match_id:target.id,selected_participant_id:target.participant_a_id,request_id:id()};\n if(mode==='C'){\n   const rs=http.batch(Array.from({length:2},()=>['POST',base+'/api/public/vote',JSON.stringify(payload),opts(vc)]));\n   rs.forEach(r=>diagnostic(r,'duplicate'));\n   check(rs,{'duplicates all resolved':rs=>rs.every(r=>r.status===200)});\n }else{\n   const r=post('public/vote',payload,vc);check(r,{'vote status expected':r=>mode==='F'?r.status===409:mode==='D'?[200,409].includes(r.status):r.status===200});if(r.status===200)accepted.add(1);\n   if(mode==='B'&&r.status!==200){initialErrors.add(1);reconcileFailure(payload,vc,r.status);}\n   if(mode==='E'){ // Deliberately discard first response as if it were lost.\n     const retry=post('public/vote',payload,vc,undefined,'same-id-retry');check(retry,{'same request retry success':r=>r.status===200&&parse(r).vote.request_id===payload.request_id});\n     const own=get('public/my-vote?match_id='+m.id,vc);check(own,{'vote lookup confirms':r=>r.status===200&&parse(r).vote?.request_id===payload.request_id});\n   }\n }\n}\nexport function closeMatch(data){\n const r=post('admin/matches/'+data.match.id+'/close',{version:data.match.version},data.cookie,data.csrf);check(r,{'close succeeds':r=>r.status===200});\n}\nexport function teardown(data){\n let m=parse(get('admin/matches/'+data.match.id+'/stats',data.cookie));\n if(m.status==='OPEN'){const r=post('admin/matches/'+m.id+'/close',{version:m.version},data.cookie,data.csrf);check(r,{'teardown close':r=>r.status===200});m=parse(r).match;}\n const expected=mode==='B'||mode==='E'?audienceSize:mode==='C'?1:mode==='A'||mode==='F'?0:null;\n if(expected!==null)check(m,{'exact final count':m=>m.total===expected});\n if(mode==='D'){\n  const count=m.total;\n  const vc=bootstrap(m.id);if(!vc)throw new Error('Identity bootstrap failed during late-vote test');\n  const r=post('public/vote',{match_id:m.id,selected_participant_id:m.participant_a_id,request_id:id()},vc);check(r,{'late rejected':r=>r.status===409});\n  check(parse(get('admin/matches/'+m.id+'/stats',data.cookie)),{'count fixed after close':x=>x.total===count&&x.status==='CLOSED'});\n }\n if(mode==='F')check(parse(get('admin/matches/'+data.old.id+'/stats',data.cookie)),{'old preserved':x=>x.total===1&&x.status==='PUBLISHED'});\n console.log(JSON.stringify({scenario:mode,audience_size:audienceSize,match_id:m.id,total:m.total,status:m.status,closed_at:m.closed_at}));\n post('admin/logout',{},data.cookie,data.csrf);\n}\n";
const cli = 'node_modules/wrangler/bin/wrangler.js';
const testConfig = 'wrangler.loadtest.json';
try {
  runNode('node_modules/typescript/bin/tsc', ['--noEmit']);
  runNode('node_modules/vite/bin/vite.js', ['build']);
  const staging = { ...config, name: 'festival-vote-test', workers_dev: true, preview_urls: false,
    d1_databases: [{ binding: 'DB', database_name: 'festival-vote-test', database_id: dbId, migrations_dir: 'migrations' }] };
  fs.writeFileSync(testConfig, JSON.stringify(staging, null, 2) + '\n', 'utf8');
  const wrangler = (args, input, capture = false) => runNode(cli, [...args, '--config', testConfig], input, capture);
  console.log('\nTEST DATABASE: festival-vote-test\nTEST WORKER: festival-vote-test\n');
  wrangler(['d1', 'migrations', 'apply', 'festival-vote-test', '--remote']);
  const deployment = wrangler(['deploy'], undefined, true);
  const base = deployment.match(/https:\/\/festival-vote-test\.[a-z0-9-]+\.workers\.dev/i)?.[0];
  if (!base) throw new Error('Test URL not found in deployment output. No load test was started.');
  const password = randomBytes(32).toString('hex'), salt = randomBytes(16).toString('hex');
  const secrets = {
    ADMIN_PASSWORD_HASH: `100000:${salt}:${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')}`,
    COOKIE_SECRET: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex')
  };
  wrangler(['secret', 'bulk'], JSON.stringify(secrets) + '\n');
  const reportDir=path.join('load-results',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(loadFile, loadSource, 'utf8');
  const failures = [];
  const measured = [];
  for (const scenario of scenarios) {
    console.log('\n======== STAGING SCENARIO ' + scenario + ' ('+users+' voters) ========\n');
    const summaryPath = path.join(reportDir,scenario+'.json');
    const logPath=path.join(reportDir,scenario+'-diagnostics.jsonl');
    // Remove stale reports so a failed invocation cannot be mistaken for an older successful run.
    fs.rmSync(summaryPath, { force: true });
    const result = spawnSync(k6Executable, ['run', '--summary-export=' + summaryPath, '--log-format=json', '--log-output=file='+logPath, loadFile], {
      stdio: 'inherit', env: { ...process.env, ADMIN_PASSWORD: password, BASE_URL: base, SCENARIO: scenario, VUS:String(users), ALLOW_REMOTE_LOAD_TEST: 'YES' }
    });
    if (result.error) throw result.error;
    let metrics = null;
    if (fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      metrics = summary.metrics;
    }
    const errors=[];
    if(fs.existsSync(logPath))for(const line of fs.readFileSync(logPath,'utf8').split('\n')){
      try{const record=JSON.parse(line);const event=JSON.parse(record.msg||'null');if(['vote_response_error','identity_response_error','admin_response_error'].includes(event?.event))errors.push(event);}catch{}
    }
    const groups={};
    for(const e of errors){const key=JSON.stringify({event:e.event,phase:e.phase,http_status:e.http_status,api_code:e.api_code,edge_code:e.edge_code,resource_limit_hint:e.resource_limit_hint});groups[key]=(groups[key]||0)+1;}
    if(errors.length){console.log('ERROR BREAKDOWN:');for(const [group,count]of Object.entries(groups))console.log(JSON.stringify({...JSON.parse(group),count}));}
    const scriptErrors=[];
    if(fs.existsSync(logPath))for(const line of fs.readFileSync(logPath,'utf8').split('\n')){
      try{const record=JSON.parse(line);if(record.hint==='script exception'&&typeof record.msg==='string')scriptErrors.push(record.msg.split('\n')[0].slice(0,300));}catch{}
    }
    for(const message of scriptErrors)console.log('SCRIPT ERROR: '+message);
    const iterationMetric=metrics?.iterations;
    const iterations=Number(iterationMetric?.values?.count??iterationMetric?.count??0);
    const minimum=scenario==='C'?Math.min(10,users):scenario==='D'?users+1:users;
    const workloadComplete=iterations>=minimum;
    if(!workloadComplete)console.error('WORKLOAD DID NOT COMPLETE: '+iterations+' / '+minimum+' audience/controller iterations. Setup may have failed. This is not a capacity result.');
    measured.push({ scenario, exit_code: result.status, metrics, iterations, workload_complete:workloadComplete, script_errors:scriptErrors, error_groups:groups, diagnostic_file:logPath });
    if (result.status !== 0 || !workloadComplete) {
      failures.push(scenario);
      // Do not continue after setup/network failures: an OPEN test match may need recovery.
      break;
    }
  }
  fs.writeFileSync(path.join(reportDir,'run.json'), JSON.stringify({ tested_at: new Date().toISOString(), url: base, audience_size:users, failed_scenarios: failures, scenarios: measured }, null, 2) + '\n');
  console.log('\nChecking test-database invariants...');
  wrangler(['d1','execute','festival-vote-test','--remote','--command',"SELECT (SELECT COUNT(*) FROM (SELECT match_id,voter_hash FROM votes GROUP BY match_id,voter_hash HAVING COUNT(*)>1)) AS duplicate_voters, (SELECT COUNT(*) FROM votes v JOIN matches m ON m.id=v.match_id WHERE m.closed_at IS NOT NULL AND v.created_at>m.closed_at) AS votes_after_close, (SELECT COUNT(*) FROM votes v JOIN matches m ON m.id=v.match_id WHERE v.selected_participant_id NOT IN(m.participant_a_id,m.participant_b_id)) AS invalid_participants;"]);
  console.log('\nTest site: ' + base);
  console.log('Reports: '+reportDir);
  console.log('Audience size: '+users);
  console.log('Requested scenarios: '+scenarios.join(', ')+'. Only executed scenarios have results in this folder.');
  console.log('All three invariant counts above must be zero. Review the reports before drawing a capacity conclusion.');
  console.log('The test Worker/database remain separate. Revoke test access or remove test resources from Cloudflare after review.');
  if (failures.length) { console.error('FAILED: ' + failures.join(', ')); process.exitCode = 1; }
  else console.log('Requested k6 scenarios passed their configured thresholds. This does not imply unexecuted scenarios passed.');
} catch (e) {
  console.error('Stopped: ' + e.message);
  console.error('Existing website settings were not modified. Test resources may have been created.');
  process.exitCode = 1;
}
