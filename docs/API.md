# REST API

경로는 같은 도메인의 `/api`부터 시작합니다. JSON 응답이며 공개 전 집계 필드는 공개 응답에 존재하지 않습니다. 모든 응답은 `Cache-Control: no-store`입니다. CORS를 열지 않습니다.

## 공통 요청과 오류

쓰기 요청은 `Content-Type: application/json`, 현재 URL과 같은 `Origin`을 요구합니다. 본문은 실제 읽은 바이트 기준 최대 8,192바이트입니다. ID는 UUID, 버전은 양의 정수입니다. 날짜는 UTC ISO 문자열이며 화면은 한국 시각으로 표시합니다. 투표자 식별 쿠키는 자바스크립트에서 읽지 않습니다.

```json
{"error":{"code":"STATE_CONFLICT","message":"다른 관리자가 변경했거나 허용되지 않은 상태입니다. 새로고침해 주세요."}}
```

| HTTP | 코드 예시 | 대응 |
|---|---|---|
| 400 | INVALID_INPUT / INVALID_ID / INVALID_JSON / VERSION_REQUIRED / SAME_PARTICIPANT | 입력 수정 |
| 401 | AUTH_REQUIRED / SESSION_EXPIRED / INVALID_PASSWORD / INVALID_VISITOR | 로그인 또는 방문자 쿠키 재발급 |
| 403 | CSRF | 같은 사이트에서 새로고침, 관리자 CSRF 갱신 |
| 404 | NOT_FOUND / MATCH_NOT_FOUND / RESULT_NOT_PUBLIC | 경로 또는 결과 공개 여부 확인 |
| 405 | METHOD_NOT_ALLOWED | HTTP 메서드 확인 |
| 409 | ALREADY_VOTED / VOTE_NOT_ALLOWED / REQUEST_ID_CONFLICT / STATE_CONFLICT / CREATE_CONFLICT | 새로고침·내 표 확인, 변경 충돌 처리 |
| 413 | BODY_TOO_LARGE | 본문 축소 |
| 415 | JSON_REQUIRED | JSON 형식 사용 |
| 428 | VISITOR_REQUIRED | my-vote 먼저 호출, 쿠키 저장 확인 |
| 429 | RATE_LIMITED | 기다린 뒤 재시도 (Retry-After 제공) |
| 503 | SERVER_ERROR / SETUP_REQUIRED | 처리 여부를 확정하지 말고 내 표 조회 및 같은 요청 재시도, 서버 설정 확인 |

예상하지 못한 내부 오류·DB 오류도 503으로 일반화하며 쿼리나 비밀값을 응답/로그로 내보내지 않습니다. 429의 `Retry-After: 60`은 최소 대기 안내이며 관리자 로그인 제한 창은 15분이므로 다음 창까지 기다려야 할 수도 있습니다.

## 공개 API

### GET /api/public/state

쿠키 없이 조회 가능합니다. 현재 경기만 반환합니다.

```json
{"match":{"id":"UUID","round_label":"결승","match_title":"마지막 대결","status":"OPEN","version":2,"a":{"id":"UUID-A","name":"황금 가면","image_url":""},"b":{"id":"UUID-B","name":"은빛 가면","image_url":""}},"result":null,"server_time":"2026-10-22T09:00:00.000Z"}
```

경기가 없으면 `match:null`. PUBLISHED에서만 `result`가 득표수 객체가 됩니다. 실제 이름·메모는 항상 제외합니다.

### GET /api/public/my-vote?match_id=UUID

ID 생략 시 현재 경기. 최초 방문자 쿠키를 발급하고 자기 표만 확인합니다.

```json
{"vote":null}
```

표가 있으면 `vote:{match_id,selected_participant_id,request_id,created_at}`. 원본 방문자 ID·해시를 반환하지 않습니다. 현재 경기 전환 뒤에도 지정한 과거 경기의 본인 표는 조회할 수 있습니다.

### POST /api/public/vote

먼저 my-vote를 호출해 방문자 쿠키를 받아야 합니다. 요청 ID는 클라이언트의 `crypto.randomUUID()`로 생성하여 확인 전까지 보존합니다.

```json
{"match_id":"UUID","selected_participant_id":"UUID","request_id":"UUID"}
```

성공은 HTTP 200과 `{vote:{match_id,selected_participant_id,request_id,created_at}}`. 같은 방문자·경기의 기존 선택이 같으면 기존 성공 객체를 반환하며 새 표를 추가하지 않습니다. 동일 요청 재시도는 마감 이후에도 같은 성공을 반환합니다. 다른 선택은 409 ALREADY_VOTED입니다. 기존 표가 없고 현재 OPEN 경기가 아니면 409 VOTE_NOT_ALLOWED입니다. 경기 변경 시 요청의 match_id를 새 경기로 바꾸어 재사용하지 않습니다.

### GET /api/public/result?match_id=UUID

PUBLISHED인 경기만 `{match_id,a_votes,b_votes,total,a_percent,b_percent,winner,tie}`를 반환합니다. 미공개는 404입니다. 동점이면 `winner:null,tie:true`. 투표가 0이면 비율은 둘 다 0, 동점입니다.

## 관리자 인증

### POST /api/admin/login

```json
{"password":"관리자가 설정한 비밀번호"}
```

성공 시 `{csrf,expires_at}` 및 HttpOnly 세션 쿠키. 비밀번호는 정적 코드에 포함하지 않고 Secrets의 PBKDF2 해시로 검증합니다. IP 원문 대신 HMAC으로 관리자 로그인 시도만 제한합니다.

### GET /api/admin/session

세션 쿠키 필요. `{csrf}`. 화면 재접속 시 CSRF 토큰을 메모리에 복구합니다.

### POST /api/admin/logout

세션 쿠키와 `X-CSRF-Token` 필요, 본문 `{}`. 세션 삭제 및 쿠키 만료.

**나머지 관리자 API도 전부 세션 쿠키가 필요하고 모든 쓰기는 `X-CSRF-Token`이 필요합니다.**

## 참가자

### GET /api/admin/participants

`{participants:[{id,display_name,mask_name,image_url,notes,active,created_at,updated_at}]}`

### POST /api/admin/participants
### PATCH /api/admin/participants/:id

두 API 모두 전체 폼을 보냅니다. 부분 필드 병합 방식이 아닙니다.

```json
{"display_name":"홍길동","mask_name":"황금 가면","image_url":"","notes":"결승 후보","active":true}
```

이름 1~80자, 이미지 최대 1,000자 (빈 문자열 또는 HTTPS), 메모 최대 2,000자. `active`는 요청에서 불리언, 응답에서 0/1입니다. 성공 `{id}`. 비활성화는 새 경기 선택만 제한하며 기존 기록은 유지합니다.

## 경기 및 상태

### GET /api/admin/dashboard

`{event:{id,current_match_id,updated_at,version},match:집계포함경기또는null,updated_at}`. 행사 버전과 경기 버전은 서로 다릅니다.

### GET /api/admin/matches
### GET /api/admin/history

`{matches:[경기및득표집계]}`. 현재까지 모든 경기를 최신순으로 반환합니다. 한 학교 행사 규모를 가정하며 페이지네이션은 없습니다. 표별 개인정보·방문자 해시는 반환하지 않습니다.

### POST /api/admin/matches

```json
{"match_title":"16강 첫 대결","round_label":"16강 1경기","participant_a_id":"UUID-A","participant_b_id":"UUID-B","event_version":1}
```

서로 다른 활성 참가자 2명만 허용합니다. 현재 OPEN 경기가 없어야 합니다. 트랜잭션 배치에서 당시 이름·복면·이미지 스냅샷을 복사하고 현재 경기로 지정합니다. 성공 201 `{match}`. 행사 버전이 다르면 409.

### POST /api/admin/matches/:id/select

`{event_version:현재행사버전}`. OPEN 경기가 없을 때만 현재 경기 지정. 성공 `{ok:true}`. 기존 경기 내용이나 표를 변경하지 않습니다. PUBLISHED 경기를 다시 표시할 수 있습니다.

### POST /api/admin/matches/:id/open
### POST /api/admin/matches/:id/close
### POST /api/admin/matches/:id/reopen
### POST /api/admin/matches/:id/publish

모두 `{version:현재경기버전}`. 성공 `{match:새버전과집계포함경기}`. 현재 경기만 조작할 수 있습니다.

| 동작 | 이전 → 이후 | 영향 |
|---|---|---|
| open | READY → OPEN | 최초 시작 시각 기록 |
| close | OPEN → CLOSED | 마감 시각 기록, 신규표 차단 |
| reopen | CLOSED → OPEN | 표 유지, 마지막 마감 시각 비움, 최초 시작 시각 유지 |
| publish | CLOSED → PUBLISHED | 공개 시각 기록, 이후 변경 불가 |

DB의 부분 고유 인덱스로 OPEN은 전체에서 최대 하나이며, 트리거가 상태 전환과 공개 경기 불변을 보강합니다. 전환·선택·생성은 감사 로그에 DB 트리거로 기록됩니다.

### GET /api/admin/matches/:id/stats

`{id,round_label,match_title,participant_a_id,participant_b_id,각스냅샷,status,각시각,version,a_votes,b_votes,total,a_percent,b_percent,winner,tie}`. 통계는 표를 기준으로 계산하며 별도 증분 카운터를 신뢰하지 않습니다.

## CSV

### GET /api/admin/export/csv

전체 경기. `?match_id=UUID`는 한 경기, `?type=participants`는 참가자 목록입니다. 로그인 필요. Content-Disposition 첨부, UTF-8 BOM, 모든 필드 따옴표 이스케이프, 수식으로 해석될 수 있는 접두사를 `'`로 방어합니다. 방문자 해시·요청 ID·쿠키·세션은 제외합니다. 관리자용 결과 CSV에는 아직 공개되지 않은 경기 집계도 포함됩니다. 공개적으로 배포하기 전에 내용을 확인하세요.
