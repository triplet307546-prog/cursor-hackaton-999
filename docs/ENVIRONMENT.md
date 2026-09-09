# 개발 환경

로컬 노트북에서 처음 돌리는 순서는 저장소 루트의 `README.md` 를 보세요. 이 문서는 환경변수와 명령의 자세한 설명입니다.

## 로컬 최소 요구

- Node.js **22.9 이상** (22 LTS)
- Git
- Windows 는 PowerShell 또는 Git Bash

시연(`npm run dev` → `/run/fixture`)은 환경변수 없이 됩니다.

## 환경변수

값은 `.env.local` 또는 Cursor 클라우드 환경의 비밀값(Secret, 외부에 노출하지 않고 저장하는 값)에 둡니다. 실제 키를 이 문서나 코드에 적지 않습니다.

| 이름 | 용도 | 기본값 |
| --- | --- | --- |
| `LLM_API_KEY` | Anthropic API 키 | 없음 |
| `LLM_MODEL` | 사용할 Anthropic 모델 | `claude-haiku-4-5-20251001` |
| `LLM_MODE` | LLM 실행 방식 (`mock` 또는 `real`) | `mock` |
| `YOUTUBE_API_KEY` | YouTube Data API v3 키 | 없음 |
| `NAVER_CLIENT_ID` | 네이버 검색 API 클라이언트 ID | 없음 |
| `NAVER_CLIENT_SECRET` | 네이버 검색 API 클라이언트 비밀값 | 없음 |

`.env.local` 은 Next.js와 아래 npm 스크립트만 읽습니다. Vitest는 읽지 않으므로 테스트는 항상 `mock`입니다.

### `.env.local` 만들기 (필요할 때만)

저장소 루트에 `.env.local` 파일을 만들고 아래 형식으로 채웁니다. 등호 오른쪽에 본인 키만 넣습니다. 따옴표는 없어도 됩니다.

```
LLM_MODE=mock
LLM_API_KEY=
LLM_MODEL=claude-haiku-4-5-20251001
YOUTUBE_API_KEY=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
```

`.env.local` 은 Git에 올라가지 않습니다 (`.gitignore`). 실수로 `git add` 했다면 커밋하지 말고 파일을 목록에서 빼세요.

## 실행 명령

```bash
npm install
npm run dev
npm test
npx tsc --noEmit
npm run build
npm run run:fixture
npm run run:cached -- data/runs/fixture.json
```

개발 서버를 실행한 뒤 브라우저에서 `http://localhost:3000` 과 `http://localhost:3000/run/fixture` 를 엽니다.

Windows PowerShell에서도 같은 명령을 씁니다. `npm run run:cached -- data/runs/fixture.json` 의 `--` 는 빼지 마세요.

## Cursor 클라우드 환경 확인 항목

- Node.js 버전이 22.9 이상인지 확인합니다.
- `npm ci`가 `package-lock.json`을 바꾸지 않고 성공하는지 확인합니다.
- `npm test`, `npx tsc --noEmit`, `npm run build`가 성공하는지 확인합니다.
- 외부 API가 필요한 작업 전에 해당 API 키가 비밀값으로 등록됐는지 확인합니다.
- `.env.local`과 API 키가 Git에 포함되지 않았는지 확인합니다.
