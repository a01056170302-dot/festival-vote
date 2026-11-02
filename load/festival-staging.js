import http from 'k6/http';
import {check,sleep,fail} from 'k6';
import exec from 'k6/execution';
import {Counter,Trend} from 'k6/metrics';
const mode=__ENV.SCENARIO||'B';
const audienceSize=Number(__ENV.VUS||700);
if(!Number.isInteger(audienceSize)||audienceSize<1||audienceSize>700)throw new Error('VUS must be an integer from 1 to 700.');
const base=(__ENV.BASE_URL||'http://localhost:8787').replace(/\/$/,'');
const local=/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(base);
if(!local&&__ENV.ALLOW_REMOTE_LOAD_TEST!=='YES')throw new Error('원격 부하는 명시적으로 허가된 스테이징에서 ALLOW_REMOTE_LOAD_TEST=YES로만 실행하세요.');
if(!['A','B','C','D','E','F'].includes(mode))throw new Error('SCENARIO=A~F');
const accepted=new Counter('accepted_votes');
const voteDuration=new Trend('vote_endpoint_duration',true);
const initialVoteDuration=new Trend('vote_initial_duration',true);
const voteCodes={};
for(const code of [0,200,400,401,403,408,409,428,429,500,502,503,504])voteCodes[code]=new Counter('vote_http_'+code);
const otherVoteCode=new Counter('vote_http_other');
const workerLimitHints=new Counter('vote_worker_limit_hints');
const initialErrors=new Counter('vote_initial_errors');
const savedAfterError=new Counter('vote_saved_despite_error');
const confirmedAfterRetry=new Counter('vote_confirmed_after_retry');
const unresolvedAfterError=new Counter('vote_unresolved_after_error');
const identityErrors=new Counter('identity_initial_errors');
const identityRecovered=new Counter('identity_recovered');
const identityUnresolved=new Counter('identity_unresolved');
const identityLimitHints=new Counter('identity_worker_limit_hints');
function reportError(response,phase,event){
 const status=Number(response.status)||0;
 let apiCode=null,errorId=null;
 try{const e=response.json()?.error;const c=e?.code;if(typeof c==='string'&&/^[A-Z0-9_]{1,60}$/.test(c))apiCode=c;if(typeof e?.error_id==='string'&&/^[0-9a-f-]{36}$/i.test(e.error_id))errorId=e.error_id;}catch{}
 const text=typeof response.body==='string'?response.body:'';
 const edgeCode=text.match(/(?:error(?:\s+code)?\s*[:=]?\s*)(10\d{2}|11\d{2})/i)?.[1]||null;
 const resourceLimit=/worker exceeded (?:cpu|resource) limits|exceeded cpu time limit/i.test(text)||edgeCode==='1102';
 const headers=response.headers||{};
 console.warn(JSON.stringify({event,scenario:mode,phase,http_status:status,api_code:apiCode,error_id:errorId,edge_code:edgeCode,resource_limit_hint:resourceLimit,cf_ray:headers['Cf-Ray']||headers['CF-Ray']||null,network_error_code:response.error_code||null}));
 return resourceLimit;
}
function diagnostic(response,phase){
 const status=Number(response.status)||0;
 (voteCodes[status]||otherVoteCode).add(1);
 if(response.timings){voteDuration.add(response.timings.duration);if(phase==='initial')initialVoteDuration.add(response.timings.duration);}
 const expected=status===200||(['D','F'].includes(mode)&&status===409);
 if(!expected&&reportError(response,phase,'vote_response_error'))workerLimitHints.add(1);
}
function identityCookie(response){
 const received=response.cookies?.['__Host-festival-voter']?.[0]?.value;
 if(received)return '__Host-festival-voter='+received;
 const jar=http.cookieJar();
 const stored=typeof jar.cookiesForURL==='function'?jar.cookiesForURL(base)?.['__Host-festival-voter']?.[0]:null;
 return stored?'__Host-festival-voter='+stored:'';
}
function bootstrap(matchId){
 let response=get('public/my-vote?match_id='+matchId);
 let cookie=identityCookie(response);
 const initiallyReady=response.status===200&&!!cookie;
 check(response,{'identity initial response':()=>initiallyReady});
 if(!initiallyReady){
   identityErrors.add(1);
   if(reportError(response,'initial','identity_response_error'))identityLimitHints.add(1);
   for(let attempt=0;attempt<2&&[0,408,500,502,503,504].includes(Number(response.status));attempt++){
     sleep(0.3*Math.pow(2,attempt)+Math.random()*0.4);
     response=get('public/my-vote?match_id='+matchId);cookie=identityCookie(response);
     if(response.status===200&&cookie){identityRecovered.add(1);break;}
     if(reportError(response,'bootstrap-retry','identity_response_error'))identityLimitHints.add(1);
   }
 }
 const ready=response.status===200&&!!cookie;
 check(response,{'identity available before vote':()=>ready});
 if(!ready){identityUnresolved.add(1);return '';}
 return cookie;
}

function confirmedVote(response,payload){
 if(response.status!==200)return false;
 try{const v=response.json()?.vote;return v?.match_id===payload.match_id&&v?.selected_participant_id===payload.selected_participant_id&&v?.request_id===payload.request_id;}catch{return false;}
}
function reconcileFailure(payload,cookie,initialStatus){
 // Preserve the original failed check. Recovery never converts B into a passing initial-response test.
 sleep(0.3+Math.random()*0.5);
 const lookup=get('public/my-vote?match_id='+payload.match_id,cookie);
 if(confirmedVote(lookup,payload)){savedAfterError.add(1);return;}
 if(![0,408,500,502,503,504].includes(initialStatus)){unresolvedAfterError.add(1);return;}
 const retry=post('public/vote',payload,cookie,undefined,'recovery-retry');
 if(confirmedVote(retry,payload)){confirmedAfterRetry.add(1);return;}
 const last=get('public/my-vote?match_id='+payload.match_id,cookie);
 if(confirmedVote(last,payload)){confirmedAfterRetry.add(1);return;}
 unresolvedAfterError.add(1);
}

export const options={
 scenarios:mode==='A'?{audience:{executor:'constant-vus',vus:audienceSize,duration:'1m'}}:mode==='D'?{voters:{executor:'per-vu-iterations',vus:audienceSize,iterations:1,maxDuration:'2m',exec:'audience'},closer:{executor:'per-vu-iterations',vus:1,iterations:1,startTime:'500ms',maxDuration:'2m',exec:'closeMatch'}}:{audience:{executor:'per-vu-iterations',vus:mode==='C'?Math.min(10,audienceSize):audienceSize,iterations:1,maxDuration:'3m'}},
 thresholds:{http_req_duration:['p(95)<3000'],...(!['A','C'].includes(mode)?{vote_initial_duration:['p(95)<3000']}:{ }),http_req_failed:['rate<0.01'],checks:['rate==1']},
 summaryTrendStats:['avg','med','p(95)','p(99)','max'],
};
// Expected 409 rejections are successful HTTP behavior for race and stale-vote tests.
http.setResponseCallback(http.expectedStatuses({min:200,max:299},409));
function id(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{let r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16);});}
function parse(r){try{return r.json();}catch{fail('JSON 응답 아님: HTTP '+r.status);}}
function opts(cookie,csrf){return {headers:{'Content-Type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},responseType:'text'};}
function post(path,data,cookie,csrf,phase='initial'){const r=http.post(base+'/api/'+path,JSON.stringify(data),opts(cookie,csrf));if(path==='public/vote')diagnostic(r,phase);else if(r.status<200||r.status>=300)reportError(r,path,'admin_response_error');return r;}
function get(path,cookie){const r=http.get(base+'/api/'+path,opts(cookie));if(path.startsWith('admin/')&&(r.status<200||r.status>=300))reportError(r,path,'admin_response_error');return r;}
export function setup(){
 if(!__ENV.ADMIN_PASSWORD)throw new Error('테스트 서버의 ADMIN_PASSWORD 환경변수가 필요합니다.');
 const login=post('admin/login',{password:__ENV.ADMIN_PASSWORD});if(login.status!==200)throw new Error('관리자 로그인 실패: '+login.status);
 const cookie=Object.entries(login.cookies).map(([k,v])=>k+'='+v[0].value).join('; '),csrf=parse(login).csrf;
 const dashboard=get('admin/dashboard',cookie);if(dashboard.status!==200)throw new Error('Dashboard setup failed: HTTP '+dashboard.status);
 const existing=parse(dashboard);if(existing.match?.status==='OPEN')throw new Error('열려 있는 경기가 있습니다. 테스트 전에 마감하세요.');
 let people=[];for(let i=0;i<4;i++){const p=post('admin/participants',{display_name:'부하시험 전용 '+i,mask_name:'시험 가면 '+i},cookie,csrf);if(p.status!==200)throw new Error('Participant setup failed: HTTP '+p.status);people.push(parse(p).id);}
 const create=(a,b,title)=>{const state=get('admin/dashboard',cookie);if(state.status!==200)throw new Error('Dashboard setup failed: HTTP '+state.status);const e=parse(state).event;const r=post('admin/matches',{match_title:title,round_label:'부하시험 '+mode,participant_a_id:a,participant_b_id:b,event_version:e.version},cookie,csrf);if(r.status!==201)throw new Error('Match setup failed: HTTP '+r.status);return parse(r).match;};
 const transition=(m,act)=>{const r=post('admin/matches/'+m.id+'/'+act,{version:m.version},cookie,csrf);if(r.status!==200)throw new Error('Transition '+act+' failed: HTTP '+r.status);return parse(r).match;};
 let m=create(people[0],people[1],'k6 '+mode+' '+Date.now());m=transition(m,'open');let old=null;
 if(mode==='F'){
  const voter=bootstrap(m.id);if(!voter)throw new Error('Identity bootstrap failed');
  const seed=post('public/vote',{match_id:m.id,selected_participant_id:m.participant_a_id,request_id:id()},voter);
  if(seed.status!==200)throw new Error('이전 경기 보존 검증용 투표 실패');
  old=m;m=transition(m,'close');m=transition(m,'publish');m=create(people[2],people[3],'경기 전환 시험');m=transition(m,'open');
 }
 let sharedCookie='';if(mode==='C'){sharedCookie=bootstrap(m.id);if(!sharedCookie)throw new Error('Identity bootstrap failed');}
 http.cookieJar().clear(base);return {match:m,old,people,cookie,csrf,sharedCookie};
}
export default function(data){audience(data);}
export function audience(data){
 const m=data.match;
 if(mode==='A'){const r=get('public/state');check(r,{'state 200':r=>r.status===200,'prepublish no counts':r=>parse(r).result===null&&!r.body.includes('a_votes')});sleep(10+Math.random()*4);return;}
 if(mode==='D')sleep(Math.random());
 let vc=data.sharedCookie;
 if(!vc){vc=bootstrap(m.id);if(!vc)return;}
 const target=mode==='F'?data.old:m;
 const payload={match_id:target.id,selected_participant_id:target.participant_a_id,request_id:id()};
 if(mode==='C'){
   const rs=http.batch(Array.from({length:2},()=>['POST',base+'/api/public/vote',JSON.stringify(payload),opts(vc)]));
   rs.forEach(r=>diagnostic(r,'duplicate'));
   check(rs,{'duplicates all resolved':rs=>rs.every(r=>r.status===200)});
 }else{
   const r=post('public/vote',payload,vc);check(r,{'vote status expected':r=>mode==='F'?r.status===409:mode==='D'?[200,409].includes(r.status):r.status===200});if(r.status===200)accepted.add(1);
   if(mode==='B'&&r.status!==200){initialErrors.add(1);reconcileFailure(payload,vc,r.status);}
   if(mode==='E'){ // Deliberately discard first response as if it were lost.
     const retry=post('public/vote',payload,vc,undefined,'same-id-retry');check(retry,{'same request retry success':r=>r.status===200&&parse(r).vote.request_id===payload.request_id});
     const own=get('public/my-vote?match_id='+m.id,vc);check(own,{'vote lookup confirms':r=>r.status===200&&parse(r).vote?.request_id===payload.request_id});
   }
 }
}
export function closeMatch(data){
 const r=post('admin/matches/'+data.match.id+'/close',{version:data.match.version},data.cookie,data.csrf);check(r,{'close succeeds':r=>r.status===200});
}
export function teardown(data){
 let m=parse(get('admin/matches/'+data.match.id+'/stats',data.cookie));
 if(m.status==='OPEN'){const r=post('admin/matches/'+m.id+'/close',{version:m.version},data.cookie,data.csrf);check(r,{'teardown close':r=>r.status===200});m=parse(r).match;}
 const expected=mode==='B'||mode==='E'?audienceSize:mode==='C'?1:mode==='A'||mode==='F'?0:null;
 if(expected!==null)check(m,{'exact final count':m=>m.total===expected});
 if(mode==='D'){
  const count=m.total;
  const vc=bootstrap(m.id);if(!vc)throw new Error('Identity bootstrap failed during late-vote test');
  const r=post('public/vote',{match_id:m.id,selected_participant_id:m.participant_a_id,request_id:id()},vc);check(r,{'late rejected':r=>r.status===409});
  check(parse(get('admin/matches/'+m.id+'/stats',data.cookie)),{'count fixed after close':x=>x.total===count&&x.status==='CLOSED'});
 }
 if(mode==='F')check(parse(get('admin/matches/'+data.old.id+'/stats',data.cookie)),{'old preserved':x=>x.total===1&&x.status==='PUBLISHED'});
 console.log(JSON.stringify({scenario:mode,audience_size:audienceSize,match_id:m.id,total:m.total,status:m.status,closed_at:m.closed_at}));
 post('admin/logout',{},data.cookie,data.csrf);
}
