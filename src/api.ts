export class RequestError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
let csrf = '';
export const setCSRF = (token: string) => { csrf = token; };
export async function api<T = any>(path: string, data?: unknown, method = 'POST'): Promise<T> {
  const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch('/api/' + path, { method: data === undefined ? 'GET' : method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: data === undefined ? undefined : JSON.stringify(data) });
    const parsed = await res.json() as T & { error?: { code?: string; message?: string } };
    if (!res.ok) throw new RequestError(res.status, parsed.error?.code || 'UNKNOWN', parsed.error?.message || '요청에 실패했습니다.');
    return parsed;
  } catch (e) {
    if (e instanceof RequestError) throw e;
    throw new Error('연결을 확인해 주세요. 응답을 받지 못했어도 표가 저장되었을 수 있습니다.');
  } finally { clearTimeout(timer); }
}
export type PublicMatch = { id: string; round_label: string; match_title: string; status: 'READY'|'OPEN'|'CLOSED'|'PUBLISHED'; version: number; a: {id: string;name: string;image_url: string}; b: {id: string;name: string;image_url: string} };
export type Result = { a_votes:number;b_votes:number;total:number;a_percent:number;b_percent:number;winner:string|null;tie:boolean };
export type PublicState = { match:PublicMatch|null;result:Result|null;server_time:string };
export type Vote = {match_id:string;selected_participant_id:string;request_id:string;created_at:string};
export const statusName = { READY:'투표 준비', OPEN:'투표 진행 중', CLOSED:'투표 마감', PUBLISHED:'결과 공개' };
export const localTime = (s?:string) => s ? new Date(s).toLocaleString('ko-KR', { timeZone:'Asia/Seoul' }) : '—';
