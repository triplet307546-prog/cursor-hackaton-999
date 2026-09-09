# 개발 환경

## 환경변수

환경변수 값은 `.env.local` 또는 Cursor 클라우드 환경의 비밀값(Secret, 외부에 노출하지 않고 저장하는 값)에 설정합니다. 실제 값은 문서나 코드에 기록하지 않습니다.

| 이름 | 용도 | 기본값 |
| --- | --- | --- |
| `LLM_API_KEY` | Anthropic API 키 | 없음 |
| `LLM_MODEL` | 사용할 Anthropic 모델 | `claude-haiku-4-5-20251001` |
| `LLM_MODE` | LLM 실행 방식 (`mock` 또는 `real`) | `mock` |
| `YOUTUBE_API_KEY` | YouTube Data API v3 키 | 없음 |
| `NAVER_CLIENT_ID` | 네이버 검색 API 클라이언트 ID | 없음 |
| `NAVER_CLIENT_SECRET` | 네이버 검색 API 클라이언트 비밀값 | 없음 |

`.env.local`은 Next.js와 아래 npm 스크립트만 읽습니다. Vitest는 읽지 않으므로 테스트는 항상 `mock`입니다.

## 실행 명령

```bash
npm test
npx tsc --noEmit
npm run build
npm run dev
```

개발 서버를 실행한 뒤 브라우저에서 `http://localhost:3000`을 엽니다.

## Cursor 클라우드 환경 확인 항목

- Node.js 버전이 22.9 이상인지 확인합니다.
- `npm ci`가 `package-lock.json`을 바꾸지 않고 성공하는지 확인합니다.
- `npm test`, `npx tsc --noEmit`, `npm run build`가 성공하는지 확인합니다.
- 외부 API가 필요한 작업 전에 해당 API 키가 비밀값으로 등록됐는지 확인합니다.
- `.env.local`과 API 키가 Git에 포함되지 않았는지 확인합니다.
