import { ApiError, fail, hmac, equal, randomToken, cookie, cookieValue, visitor, passwordOK, originCheck, body, textField, uuid, version, csvCell, safeFailureCode } from './security.ts';
interface Env { DB: D1Database; ASSETS: Fetcher; COOKIE_SECRET: string; SESSION_SECRET: string; ADMIN_PASSWORD_HASH: string }
type Row = Record<string, any>;
const json = (data: unknown, status = 200) => Response.json(data, { status });
const currentSQL = 'SELECT m.* FROM event_state e LEFT JOIN matches m ON m.id=e.current_match_id WHERE e.id=1';
async function stats(db: D1Database, matchId: string): Promise<Row> {
  const r = await db.prepare(`SELECT m.*, COALESCE(SUM(v.selected_participant_id=m.participant_a_id),0) a_votes, COALESCE(SUM(v.selected_participant_id=m.participant_b_id),0) b_votes, COUNT(v.id) total FROM matches m LEFT JOIN votes v ON v.match_id=m.id WHERE m.id=? GROUP BY m.id`).bind(matchId).first<Row>();
  if (!r) return fail(404, 'MATCH_NOT_FOUND', '경기가 없습니다.');
  return { ...r, winner: r.a_votes === r.b_votes ? null : r.a_votes > r.b_votes ? r.participant_a_id : r.participant_b_id, tie: r.a_votes === r.b_votes, a_percent: r.total ? r.a_votes / r.total * 100 : 0, b_percent: r.total ? r.b_votes / r.total * 100 : 0 };
}
function publicMatch(m: Row | null) {
  if (!m?.id) return null;
  return { id: m.id, round_label: m.round_label, match_title: m.match_title, status: m.status, version: m.version,
    a: { id: m.participant_a_id, name: m.participant_a_mask_snapshot, image_url: m.participant_a_image_snapshot },
    b: { id: m.participant_b_id, name: m.participant_b_mask_snapshot, image_url: m.participant_b_image_snapshot } };
}
function publicResult(m: Row) { return { match_id: m.id, a_votes: m.a_votes, b_votes: m.b_votes, total: m.total, a_percent: m.a_percent, b_percent: m.b_percent, winner: m.winner, tie: m.tie }; }
async function limit(db: D1Database, key: string, seconds: number, max: number) {
  const window = Math.floor(Date.now() / (seconds * 1000));
  const r = await db.prepare(`INSERT INTO rate_limits(key,window,attempts) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window=excluded.window THEN attempts+1 ELSE 1 END, window=excluded.window RETURNING attempts`).bind(key, window).first<{ attempts: number }>();
  if (!r || !Number.isFinite(Number(r.attempts))) return fail(503, 'RATE_LIMIT_UNAVAILABLE', '요청 제한 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
  if (r.attempts > max) fail(429, 'RATE_LIMITED', '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
}
async function session(req: Request, env: Env) {
  const token = cookieValue(req, '__Host-festival-admin');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return fail(401, 'AUTH_REQUIRED', '관리자 로그인이 필요합니다.');
  const tokenHash = await hmac(env.SESSION_SECRET, token);
  const s = await env.DB.prepare('SELECT csrf FROM admin_sessions WHERE token_hash=? AND expires_at>?').bind(tokenHash, Date.now()).first<{ csrf: string }>();
  if (!s) return fail(401, 'SESSION_EXPIRED', '로그인 시간이 만료되었습니다.');
  if (!['GET', 'HEAD'].includes(req.method) && !equal(req.headers.get('X-CSRF-Token') || '', s.csrf)) fail(403, 'CSRF', '관리자 화면을 새로고침해 주세요.');
  return { ...s, tokenHash };
}
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url), path = url.pathname, db = env.DB, method = req.method;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
  if (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32 || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || !env.ADMIN_PASSWORD_HASH) return fail(503, 'SETUP_REQUIRED', '서버 비밀키 설정이 필요합니다. 운영자에게 알려 주세요.');
  if (!['GET', 'POST', 'PATCH'].includes(method)) return fail(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.');
  if (method !== 'GET') originCheck(req);
  if (path === '/api/public/state' && method === 'GET') {
    const m = await db.prepare(currentSQL).first<Row>();
    return json({ match: publicMatch(m), result: m?.status === 'PUBLISHED' ? publicResult(await stats(db, m.id)) : null, server_time: new Date().toISOString() });
  }
  if (path === '/api/public/result' && method === 'GET') {
    const id = uuid(url.searchParams.get('match_id'));
    const m = await db.prepare("SELECT id FROM matches WHERE id=? AND status='PUBLISHED'").bind(id).first();
    if (!m) return fail(404, 'RESULT_NOT_PUBLIC', '아직 공개되지 않은 결과입니다.');
    return json(publicResult(await stats(db, id)));
  }
  if (path === '/api/public/my-vote' && method === 'GET') {
    const requestedId = url.searchParams.get('match_id');
    if (requestedId !== null) uuid(requestedId);
    const v = await visitor(req, env.COOKIE_SECRET);
    // A newly generated 256-bit identity has no previous vote. Issue its cookie without a D1 round trip.
    if (v.setCookie) {
      const res = json({ vote: null }); res.headers.set('Set-Cookie', v.setCookie); return res;
    }
    const id = requestedId || (await db.prepare('SELECT current_match_id FROM event_state WHERE id=1').first<{ current_match_id: string }>())?.current_match_id;
    const vote = id ? await db.prepare('SELECT match_id,selected_participant_id,request_id,created_at FROM votes WHERE match_id=? AND voter_hash=?').bind(id, v.voterHash).first() : null;
    return json({ vote });
  }
  if (path === '/api/public/vote' && method === 'POST') {
    // Bootstrap identity on GET before voting: avoids uncertain results on first-cookie response loss.
    if (!cookieValue(req, '__Host-festival-voter')) return fail(428, 'VISITOR_REQUIRED', '먼저 투표 상태를 확인해 주세요. 쿠키 사용이 필요합니다.');
    const v = await visitor(req, env.COOKIE_SECRET), b = await body(req);
    const matchId = uuid(b.match_id), selected = uuid(b.selected_participant_id), requestId = uuid(b.request_id);
    const rateKey = 'vote:' + v.voterHash, rateWindow = Math.floor(Date.now() / 60000);
    // One D1 transaction: rate accounting, conditional insert, and the receipt read share a commit.
    // Rate-exceeded inserts are skipped; the UNIQUE constraints and DB vote_guard remain authoritative.
    const batch = await db.batch<Row>([
      db.prepare(`INSERT INTO rate_limits(key,window,attempts) VALUES(?,?,1)
        ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window=excluded.window THEN attempts+1 ELSE 1 END, window=excluded.window
        RETURNING attempts`).bind(rateKey, rateWindow),
      db.prepare(`INSERT INTO votes(id,match_id,voter_hash,selected_participant_id,request_id)
        SELECT ?,m.id,?,?,? FROM matches m JOIN event_state e ON e.current_match_id=m.id AND e.id=1
        WHERE m.id=? AND m.status='OPEN' AND ? IN(m.participant_a_id,m.participant_b_id)
          AND EXISTS(SELECT 1 FROM rate_limits WHERE key=? AND window=? AND attempts<=30)
        ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), v.voterHash, selected, requestId, matchId, selected, rateKey, rateWindow),
      db.prepare('SELECT match_id,selected_participant_id,request_id,created_at FROM votes WHERE match_id=? AND voter_hash=?').bind(matchId, v.voterHash)
    ]);
    const attempts = Number(batch[0].results[0]?.attempts);
    if (!Number.isFinite(attempts)) return fail(503, 'RATE_LIMIT_UNAVAILABLE', '요청 제한 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    if (attempts > 30) return fail(429, 'RATE_LIMITED', '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    const existing = batch[2].results[0];
    if (existing) {
      if (existing.selected_participant_id !== selected) return fail(409, 'ALREADY_VOTED', '이미 다른 참가자에게 투표했습니다. 투표는 변경할 수 없습니다.');
      return json({ vote: existing });
    }
    if (await db.prepare('SELECT 1 FROM votes WHERE request_id=?').bind(requestId).first()) return fail(409, 'REQUEST_ID_CONFLICT', '이미 사용된 요청 ID입니다. 투표 상태를 확인해 주세요.');
    return fail(409, 'VOTE_NOT_ALLOWED', '현재 경기, 참가자 또는 투표 진행 상태를 확인해 주세요.');
  }
  if (path === '/api/admin/login' && method === 'POST') {
    // IP hash is used for admin password attacks only, never for audience identity.
    const ipHash = await hmac(env.SESSION_SECRET, 'login:' + (req.headers.get('CF-Connecting-IP') || 'local'));
    await limit(db, 'login:' + ipHash, 900, 15);
    const b = await body(req);
    if (typeof b.password !== 'string' || !b.password || b.password.length > 256) return fail(400, 'INVALID_INPUT', '비밀번호 입력 형식을 확인해 주세요.');
    const password = b.password;
    if (!await passwordOK(password, env.ADMIN_PASSWORD_HASH)) return fail(401, 'INVALID_PASSWORD', '비밀번호가 올바르지 않습니다.');
    const token = randomToken(), csrf = randomToken(), expiresAt = Date.now() + 8 * 3600000;
    await db.batch([
      db.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(Date.now()),
      db.prepare("DELETE FROM rate_limits WHERE window<? AND key LIKE 'vote:%'").bind(Math.floor(Date.now() / 60000) - 1440),
      db.prepare('INSERT INTO admin_sessions(token_hash,csrf,expires_at) VALUES(?,?,?)').bind(await hmac(env.SESSION_SECRET, token), csrf, expiresAt)
    ]);
    const res = json({ csrf, expires_at: expiresAt }); res.headers.set('Set-Cookie', cookie('__Host-festival-admin', token, 28800)); return res;
  }
  if (path.startsWith('/api/admin/')) {
    const s = await session(req, env);
    if (path === '/api/admin/session' && method === 'GET') return json({ csrf: s.csrf });
    if (path === '/api/admin/logout' && method === 'POST') {
      await db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(s.tokenHash).run();
      const res = json({ ok: true }); res.headers.set('Set-Cookie', cookie('__Host-festival-admin', '', 0)); return res;
    }
    if (method !== 'GET') await limit(db, 'admin:' + s.tokenHash, 60, 90);
    if (path === '/api/admin/participants' && method === 'GET') return json({ participants: (await db.prepare('SELECT * FROM participants ORDER BY created_at,id').all()).results });
    const participantPath = /^\/api\/admin\/participants\/([^/]+)$/.exec(path);
    if ((path === '/api/admin/participants' && method === 'POST') || (participantPath && method === 'PATCH')) {
      const b = await body(req), name = textField(b, 'display_name'), mask = textField(b, 'mask_name'), image = textField(b, 'image_url', 1000, true), notes = textField(b, 'notes', 2000, true);
      if (image) { try { const u = new URL(image); if (u.protocol !== 'https:' || u.username || u.password) throw 0; } catch { return fail(400, 'INVALID_IMAGE', '이미지는 HTTPS 주소를 입력해 주세요.'); } }
      if (b.active !== undefined && typeof b.active !== 'boolean') return fail(400, 'INVALID_INPUT', 'active는 참/거짓이어야 합니다.');
      const id = participantPath ? uuid(participantPath[1]) : crypto.randomUUID(), active = b.active === false ? 0 : 1;
      const r = participantPath ? await db.prepare("UPDATE participants SET display_name=?,mask_name=?,image_url=?,notes=?,active=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(name, mask, image, notes, active, id).run()
        : await db.prepare('INSERT INTO participants(id,display_name,mask_name,image_url,notes,active) VALUES(?,?,?,?,?,?)').bind(id, name, mask, image, notes, active).run();
      if (!r.meta.changes) return fail(404, 'PARTICIPANT_NOT_FOUND', '참가자가 없습니다.'); return json({ id });
    }
    if (path === '/api/admin/dashboard' && method === 'GET') {
      const e = await db.prepare('SELECT * FROM event_state WHERE id=1').first<Row>();
      return json({ event: e, match: e?.current_match_id ? await stats(db, e.current_match_id) : null, updated_at: new Date().toISOString() });
    }
    if ((path === '/api/admin/matches' || path === '/api/admin/history') && method === 'GET') {
      const rows = await db.prepare(`SELECT m.*, COALESCE(SUM(v.selected_participant_id=m.participant_a_id),0) a_votes, COALESCE(SUM(v.selected_participant_id=m.participant_b_id),0) b_votes, COUNT(v.id) total FROM matches m LEFT JOIN votes v ON v.match_id=m.id GROUP BY m.id ORDER BY m.created_at DESC,m.id`).all();
      return json({ matches: rows.results });
    }
    if (path === '/api/admin/matches' && method === 'POST') {
      const b = await body(req), id = crypto.randomUUID(), a = uuid(b.participant_a_id), other = uuid(b.participant_b_id);
      if (a === other) return fail(400, 'SAME_PARTICIPANT', '서로 다른 참가자 2명을 선택해 주세요.');
      const title = textField(b, 'match_title'), round = textField(b, 'round_label'), ev = version(b.event_version);
      // Conditional creation + selection in a transactional D1 batch. Failed preconditions insert nothing.
      await db.batch([
        db.prepare(`INSERT INTO matches(id,round_label,match_title,participant_a_id,participant_b_id,participant_a_name_snapshot,participant_b_name_snapshot,participant_a_mask_snapshot,participant_b_mask_snapshot,participant_a_image_snapshot,participant_b_image_snapshot)
          SELECT ?,?,?,a.id,b.id,a.display_name,b.display_name,a.mask_name,b.mask_name,a.image_url,b.image_url FROM participants a,participants b,event_state e
          WHERE a.id=? AND b.id=? AND a.active=1 AND b.active=1 AND e.id=1 AND e.version=? AND NOT EXISTS(SELECT 1 FROM matches WHERE status='OPEN')`).bind(id, round, title, a, other, ev),
        db.prepare("UPDATE event_state SET current_match_id=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1 AND version=? AND EXISTS(SELECT 1 FROM matches WHERE id=?)").bind(id, ev, id)
      ]);
      const m = await db.prepare('SELECT * FROM matches WHERE id=?').bind(id).first();
      if (!m) return fail(409, 'CREATE_CONFLICT', '진행 중인 경기를 마감하고 최신 상태에서 활성 참가자를 선택해 주세요.'); return json({ match: m }, 201);
    }
    const mp = /^\/api\/admin\/matches\/([^/]+)\/(select|open|close|reopen|publish|stats)$/.exec(path);
    if (mp) {
      const id = uuid(mp[1]), action = mp[2];
      if (action === 'stats' && method === 'GET') return json(await stats(db, id));
      if (method !== 'POST' || action === 'stats') return fail(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.');
      const b = await body(req);
      if (action === 'select') {
        const r = await db.prepare("UPDATE event_state SET current_match_id=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1 AND version=? AND EXISTS(SELECT 1 FROM matches WHERE id=?) AND NOT EXISTS(SELECT 1 FROM matches WHERE status='OPEN')").bind(id, version(b.event_version), id).run();
        if (!r.meta.changes) return fail(409, 'STATE_CONFLICT', '투표를 먼저 마감하거나 최신 상태를 확인해 주세요.'); return json({ ok: true });
      }
      const from = { open: 'READY', close: 'OPEN', reopen: 'CLOSED', publish: 'CLOSED' }[action as 'open' | 'close' | 'reopen' | 'publish'];
      const to = action === 'close' ? 'CLOSED' : action === 'publish' ? 'PUBLISHED' : 'OPEN';
      const stamp = to === 'OPEN' ? "opened_at=COALESCE(opened_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),closed_at=NULL" : to === 'CLOSED' ? "closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')" : "published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')";
      const r = await db.prepare(`UPDATE matches SET status=?,version=version+1,${stamp} WHERE id=? AND status=? AND version=? AND EXISTS(SELECT 1 FROM event_state WHERE id=1 AND current_match_id=?)`).bind(to, id, from, version(b.version), id).run();
      if (!r.meta.changes) return fail(409, 'STATE_CONFLICT', '다른 관리자가 변경했거나 허용되지 않은 상태입니다. 새로고침해 주세요.'); return json({ match: await stats(db, id) });
    }
    if (path === '/api/admin/export/csv' && method === 'GET') {
      let headers: string[], rows: unknown[][];
      if (url.searchParams.get('type') === 'participants') {
        const r = await db.prepare('SELECT * FROM participants ORDER BY created_at').all<Row>();
        headers = ['ID', '이름', '복면 이름', '이미지 주소', '관리 메모', '활성', '등록 일시'];
        rows = r.results.map(p => [p.id,p.display_name,p.mask_name,p.image_url,p.notes,p.active,p.created_at]);
      } else {
        const id = url.searchParams.get('match_id'); if (id) uuid(id);
        const r = await db.prepare('SELECT id FROM matches WHERE (? IS NULL OR id=?) ORDER BY created_at').bind(id, id).all<{ id: string }>();
        const ms = await Promise.all(r.results.map(m => stats(db, m.id)));
        headers = ['경기 ID','라운드','경기명','상태','A 실제 이름','A 복면','B 실제 이름','B 복면','A 득표','B 득표','총 투표','결과','생성','시작','마감','공개'];
        rows = ms.map(m => [m.id,m.round_label,m.match_title,m.status,m.participant_a_name_snapshot,m.participant_a_mask_snapshot,m.participant_b_name_snapshot,m.participant_b_mask_snapshot,m.a_votes,m.b_votes,m.total,m.tie ? '동점' : m.winner === m.participant_a_id ? m.participant_a_mask_snapshot : m.participant_b_mask_snapshot,m.created_at,m.opened_at,m.closed_at,m.published_at]);
      }
      return new Response('\uFEFF' + [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="festival-export.csv"' } });
    }
  }
  return fail(404, 'NOT_FOUND', '요청한 API가 없습니다.');
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    let res: Response;
    try { res = await route(req, env); }
    catch (e) {
      if (e instanceof ApiError) res = json({ error: { code: e.code, message: e.message } }, e.status);
      else {
        const code = safeFailureCode(e), errorId = crypto.randomUUID();
        const path = new URL(req.url).pathname;
        const area = path === '/api/public/vote' ? 'vote' : path.startsWith('/api/admin/') ? 'admin' : 'public';
        // Log only an opaque correlation ID and a category: never SQL, bodies, cookies, IPs or raw messages.
        console.error(JSON.stringify({ event: 'request_failed', code, error_id: errorId, area }));
        res = json({ error: { code, error_id: errorId, message: '서버 처리가 지연되거나 실패했습니다. 투표 상태를 확인한 뒤 같은 요청으로 재시도해 주세요.' } }, 503);
      }
    }
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer'); headers.set('X-Frame-Options', 'DENY');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (new URL(req.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
    if (res.status === 429) headers.set('Retry-After', '60');
    if (res.status === 401 && new URL(req.url).pathname.startsWith('/api/public/')) headers.append('Set-Cookie', cookie('__Host-festival-voter', '', 0));
    return new Response(res.body, { status: res.status, headers });
  }
};
