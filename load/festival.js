import http from 'k6/http';
import {check,sleep,fail} from 'k6';
import exec from 'k6/execution';
import {Counter} from 'k6/metrics';
const mode=__ENV.SCENARIO||'B';
const base=(__ENV.BASE_URL||'http://localhost:8787').replace(/\/$/,'');
const local=/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(base);
if(!local&&__ENV.ALLOW_REMOTE_LOAD_TEST!=='YES')throw new Error('원격 부하는 명시적으로 허가된 스테이징에서 ALLOW_REMOTE_LOAD_TEST=YES로만 실행하세요.');
if(!['A','B','C','D','E','F'].includes(mode))throw new Error('SCENARIO=A~F');
const accepted=new Counter('accepted_votes');
export const options={
 scenarios:mode==='A'?{audience:{executor:'constant-vus',vus:700,duration:'1m'}}:mode==='D'?{voters:{executor:'per-vu-iterations',vus:700,iterations:1,maxDuration:'2m',exec:'audience'},closer:{executor:'per-vu-iterations',vus:1,iterations:1,startTime:'500ms',maxDuration:'2m',exec:'closeMatch'}}:{audience:{executor:'per-vu-iterations',vus:mode==='C'?10:700,iterations:1,maxDuration:'3m'}},
 thresholds:{http_req_duration:['p(95)<3000'],http_req_failed:['rate<0.01'],checks:['rate==1']},
 summaryTrendStats:['avg','med','p(95)','p(99)','max'],
};
// Expected 409 rejections are successful HTTP behavior for race and stale-vote tests.
http.setResponseCallback(http.expectedStatuses({min:200,max:299},409));
function id(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{let r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16);});}
function parse(r){try{return r.json();}catch{fail('JSON 응답 아님: HTTP '+r.status);}}
function opts(cookie,csrf){return {headers:{'Content-Type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},responseType:'text'};}
function post(path,data,cookie,csrf){return http.post(base+'/api/'+path,JSON.stringify(data),opts(cookie,csrf));}
function get(path,cookie){return http.get(base+'/api/'+path,opts(cookie));}
export function setup(){
 if(!__ENV.ADMIN_PASSWORD)throw new Error('테스트 서버의 ADMIN_PASSWORD 환경변수가 필요합니다.');
 const login=post('admin/login',{password:__ENV.ADMIN_PASSWORD});if(login.status!==200)throw new Error('관리자 로그인 실패: '+login.status);
 const cookie=Object.entries(login.cookies).map(([k,v])=>k+'='+v[0].value).join('; '),csrf=parse(login).csrf;
 const existing=parse(get('admin/dashboard',cookie));if(existing.match?.status==='OPEN')throw new Error('열려 있는 경기가 있습니다. 테스트 전에 마감하세요.');
 let people=[];for(let i=0;i<4;i++){const p=post('admin/participants',{display_name:'부하시험 전용 '+i,mask_name:'시험 가면 '+i},cookie,csrf);if(p.status!==200)throw new Error('참가자 생성 실패');people.push(parse(p).id);}
 const create=(a,b,title)=>{const e=parse(get('admin/dashboard',cookie)).event;const r=post('admin/matches',{match_title:title,round_label:'부하시험 '+mode,participant_a_id:a,participant_b_id:b,event_version:e.version},cookie,csrf);if(r.status!==201)throw new Error('경기 생성 실패');return parse(r).match;};
 const transition=(m,act)=>{const r=post('admin/matches/'+m.id+'/'+act,{version:m.version},cookie,csrf);if(r.status!==200)throw new Error('상태 변경 실패 '+act);return parse(r).match;};
 let m=create(people[0],people[1],'k6 '+mode+' '+Date.now());m=transition(m,'open');let old=null;
 if(mode==='F'){old=m;m=transition(m,'close');m=transition(m,'publish');m=create(people[2],people[3],'경기 전환 시험');m=transition(m,'open');}
 let sharedCookie='';if(mode==='C'){const r=get('public/my-vote?match_id='+m.id);sharedCookie=Object.entries(r.cookies).filter(([k])=>k==='__Host-festival-voter').map(([k,v])=>k+'='+v[0].value).join('; ');}
 http.cookieJar().clear(base);return {match:m,old,people,cookie,csrf,sharedCookie};
}
export default function(data){audience(data);}
export function audience(data){
 const m=data.match;
 if(mode==='A'){const r=get('public/state');check(r,{'state 200':r=>r.status===200,'prepublish no counts':r=>parse(r).result===null&&!r.body.includes('a_votes')});sleep(10+Math.random()*4);return;}
 if(mode==='D')sleep(Math.random());
 let vc=data.sharedCookie;
 if(!vc){const r=get('public/my-vote?match_id='+m.id);check(r,{'identity bootstrap':r=>r.status===200});vc=Object.entries(r.cookies).filter(([k])=>k==='__Host-festival-voter').map(([k,v])=>k+'='+v[0].value).join('; ');}
 const target=mode==='F'?data.old:m;
 const payload={match_id:target.id,selected_participant_id:target.participant_a_id,request_id:id()};
 if(mode==='C'){
   const rs=http.batch(Array.from({length:2},()=>['POST',base+'/api/public/vote',JSON.stringify(payload),opts(vc)]));
   check(rs,{'duplicates all resolved':rs=>rs.every(r=>r.status===200)});
 }else{
   const r=post('public/vote',payload,vc);check(r,{'vote status expected':r=>mode==='F'?r.status===409:mode==='D'?[200,409].includes(r.status):r.status===200});if(r.status===200)accepted.add(1);
   if(mode==='E'){ // Deliberately discard first response as if it were lost.
     const retry=post('public/vote',payload,vc);check(retry,{'same request retry success':r=>r.status===200&&parse(r).vote.request_id===payload.request_id});
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
 const expected=mode==='B'||mode==='E'?700:mode==='C'?1:mode==='A'||mode==='F'?0:null;
 if(expected!==null)check(m,{'exact final count':m=>m.total===expected});
 if(mode==='D'){
  const count=m.total;
  const boot=get('public/my-vote?match_id='+m.id);const vc=Object.entries(boot.cookies).filter(([k])=>k==='__Host-festival-voter').map(([k,v])=>k+'='+v[0].value).join('; ');
  const r=post('public/vote',{match_id:m.id,selected_participant_id:m.participant_a_id,request_id:id()},vc);check(r,{'late rejected':r=>r.status===409});
  check(parse(get('admin/matches/'+m.id+'/stats',data.cookie)),{'count fixed after close':x=>x.total===count&&x.status==='CLOSED'});
 }
 if(mode==='F')check(parse(get('admin/matches/'+data.old.id+'/stats',data.cookie)),{'old preserved':x=>x.total===0&&x.status==='PUBLISHED'});
 console.log(JSON.stringify({scenario:mode,match_id:m.id,total:m.total,status:m.status,closed_at:m.closed_at}));
 post('admin/logout',{},data.cookie,data.csrf);
}
