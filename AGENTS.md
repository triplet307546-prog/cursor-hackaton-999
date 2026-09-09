# PainRadar — Agent Rules

## 프로젝트
공개 커뮤니티 언급(YouTube 댓글)을 중복·스레드 반복을 제거한 "독립 관측"으로 바꾸고,
불만이 아니라 우회(workaround)·대안탐색·이탈·결제 같은 행동 신호로 기회 순위를 다시 매기는 도구.
1박 2일 해커톤 MVP. 개발자는 비개발자 1인. 단순함이 최우선.

## 절대 규칙
- 언어는 TypeScript만. Python, 별도 백엔드, DB, vector DB, queue 금지. 저장은 data/ 아래 JSON 파일.
- 스크래핑 금지. 데이터는 공식 API(YouTube Data API v3, Naver 검색 API)와 사용자 CSV만.
  CAPTCHA/Cloudflare 우회, 프록시 회전, 비공개 API, 로그인 우회 코드를 절대 작성하지 않는다.
- 사람을 식별하지 않는다. author id/이름/해시를 저장하거나 비교하지 않는다.
- 숫자는 코드가 센다. LLM은 라벨과 인용문(quote)만 낸다. quote는 공백을 제거한 원문에 포함돼야 하며
  아니면 버린다.
- lib/types.ts의 인터페이스가 계약이다. 필드를 바꾸려면 먼저 이유를 보고하고 승인을 받는다.
- 점수(0~100) 금지. High/Medium/Low 밴드 + 규칙이 만든 이유 문자열만. 임계값은 config/scoring.json.
- LLM 호출은 항상 순차. 병렬 호출 금지. 호출 사이 최소 6초 대기.
- 화면의 모든 숫자는 클릭해서 근거 원문까지 갈 수 있어야 한다.
- API 키는 .env.local 또는 환경변수에서만 읽는다. 코드·프롬프트·로그·보고에 키를 넣지 않는다.

## 파일 지도
lib/types.ts            데이터 계약 (수정 금지)
config/scoring.json     임계값
config/questions.json   Ask 화면 질문 버튼
lib/pipeline/           normalize.ts dedup.ts cluster.ts classify.ts score.ts explain.ts run.ts
lib/llm.ts              LLM 래퍼. LLM_MODE=mock|real. real 은 Anthropic Messages API 하나만
lib/sources/            youtube.ts (naver.ts csv.ts 는 선택)
scripts/                run.ts fetch-youtube.ts
app/page.tsx            Ask 화면
app/run/[id]/page.tsx   결과 화면
components/             Hero.tsx EvidenceDrawer.tsx
data/fixtures/          demo.json answers.json labels.json
data/raw/               소스에서 받은 원본
data/runs/              실행 결과 캐시. demo_cached.json 이 시연용
docs/ENVIRONMENT.md     환경변수·실행 명령

## 작업 방식
- 지정된 파일 범위 밖은 건드리지 않는다. 다른 파일이 필요하면 먼저 말한다.
- pipeline 함수는 순수 함수(입력→출력), 부수효과 없음, 입력을 변경하지 않음, vitest 테스트 동반.
- 끝나면 반드시 npm test 와 npx tsc --noEmit 을 실행하고 출력을 보고에 포함한다.
  app/ 또는 components/ 를 건드렸으면 npm run build 도.
- 보고는 5줄 이내: 만든 파일 / 테스트 결과 / 남은 문제 / 다음 단계 / 질문. 실패가 있으면 첫 줄에 "미완료".
  지시가 표·출력·명령줄 첨부를 요구하면 그 첨부는 5줄 뒤에 붙이고 줄 수에 세지 않는다. 여러 값은 한 줄에
  "항목=값; 항목=값" 으로 합친다.
- 같은 오류가 2번 반복되면 멈추고 현재 상태를 보고한다. 임의로 우회하지 않는다.
- 새 패키지 설치는 지시된 것만. 추가가 필요하면 먼저 묻는다.
- 한국어로 보고한다.
