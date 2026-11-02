# 700명 부하 시험

k6 설치: https://grafana.com/docs/k6/latest/set-up/install-k6/ 를 따른다. 행사 DB와 분리한 스테이징 D1을 사용한다. 테스트는 참가자 4명과 경기를 새로 만들며 기록을 지우지 않는다. 관람객 계정은 필요 없다.

로컬 서버를 켜고 다른 터미널에서 실행한다 (macOS/Linux/Git Bash):

```bash
cd festival-vote
read -r -s -p "테스트 관리자 비밀번호: " ADMIN_PASSWORD
export ADMIN_PASSWORD
printf '\n'
SCENARIO=B BASE_URL=http://localhost:8787 k6 run load/festival.js
unset ADMIN_PASSWORD
```

PowerShell:

```powershell
$credential = Read-Host "테스트 관리자 비밀번호" -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $credential).Password
$env:SCENARIO = 'B'
$env:BASE_URL = 'http://localhost:8787'
k6 run load/festival.js
Remove-Item Env:ADMIN_PASSWORD
```

A부터 F까지 SCENARIO 값만 바꿔 각각 실행한다. 하나가 끝난 뒤 다음 시험을 실행한다. 일반 접속도 준비 단계에서 별도 경기를 생성한다.

| 시험 | 내용 | 성공 기준 |
|---|---|---|
| A | 700 VU, 1분, 10~14초 조회 | 상태 200, 공개 전 수치 없음, 투표 0 |
| B | 700 VU 각 1표 집중 제출 | 성공 700, 최종 총합 정확히 700 |
| C | 같은 쿠키 10 VU × 동시 2요청 | 모두 동일 선택 성공 처리, DB 정확히 1표 |
| D | 700표와 별도 관리자 마감 경합 | 200/409만 허용, CLOSED 이후 추가 표 거부, 집계 고정 |
| E | 첫 응답을 사용하지 않고 같은 ID 재시도 | 두 번째 응답·내 표 조회 성공, 총합 700 |
| F | A 공개 후 B 시작, A의 늦은 투표 | A 요청 모두 409, A 기록 유지, B 총합 0 |

모든 시험은 `checks rate=1`, `http_req_failed <1%`, `p95 <3초`를 기준으로 한다. 409는 D/F에서 정상 거부로 분류하되 각 check가 예상한 상태인지 추가 검증한다. A/B/C/E에 잘못된 409가 오면 check는 실패한다. 총합 불일치는 테스트 실패다. 대기열/네트워크 성능에 따라 기준을 만족하지 못하면 운영 플랜과 폴링 간격을 조정한 뒤 재측정한다.

명시적으로 부하 시험이 허가된 스테이징에서만:

```bash
SCENARIO=B BASE_URL=https://YOUR-STAGING.workers.dev ALLOW_REMOTE_LOAD_TEST=YES k6 run --summary-export=load-results-B.json load/festival.js
```

`ALLOW_REMOTE_LOAD_TEST`는 허가를 대체하지 않는다. 실제 행사 사이트에 실행하지 않는다. 700 VU는 로컬 PC도 많은 자원을 사용한다. 로컬 HTTPS 자체 서명 인증서 환경에서만 필요하면 k6의 `--insecure-skip-tls-verify`를 사용한다. 운영 HTTPS 검증은 끄지 않는다.

D의 DB 시각 검증 (스테이징 DB 대상):

```bash
npx wrangler d1 execute festival-vote --remote --command "SELECT COUNT(*) AS invalid_late_votes FROM votes v JOIN matches m ON m.id=v.match_id WHERE m.closed_at IS NOT NULL AND v.created_at > m.closed_at;"
npx wrangler d1 execute festival-vote --remote --command "SELECT match_id,COUNT(*) FROM votes GROUP BY match_id;"
npx wrangler d1 execute festival-vote --remote --command "SELECT match_id,voter_hash,COUNT(*) FROM votes GROUP BY match_id,voter_hash HAVING COUNT(*)>1;"
```

첫 쿼리는 0, 마지막 쿼리는 빈 결과여야 한다. 결과를 공유할 때 방문자 해시를 복사하지 않는다. 테스트 DB와 생산 DB의 Wrangler 설정은 별도 폴더/파일로 분리한다.

700 VU의 실제 Workers/D1 부하 시험은 이 작업 환경에서 실행하지 않았다. Python SQLite 700표 시험은 별도 DB 계층 검증이며 이 시험을 대체하지 않는다. E는 응답을 의도적으로 무시하는 테스트로, 실제 무선망 패킷 손실까지 재현하지 않는다.
