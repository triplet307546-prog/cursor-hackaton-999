# PainRadar

YouTube 댓글 같은 공개 언급을 중복 없는 **독립 관측**으로 바꾸고, 불만이 아니라 우회·대안 탐색·이탈·결제 같은 **행동 신호**로 기회를 다시 매기는 도구입니다.

시연은 API 키 없이 됩니다. 미리 만들어 둔 `data/runs/fixture.json` 을 읽습니다.

## 로컬에서 시작하기 (Windows + Cursor)

아래는 **한 번만** 하면 됩니다. 이미 폴더가 있으면 [이미 받은 경우](#이미-받은-경우)로 가세요.

### 1. 필요한 프로그램

| 프로그램 | 왜 필요한지 | 받는 곳 |
| --- | --- | --- |
| Git | 코드를 노트북으로 가져옴 | https://git-scm.com/download/win |
| Node.js 22 | 화면을 띄우는 실행기 | https://nodejs.org (LTS, 22.x) |
| Cursor | 이 폴더를 열어 작업 | 이미 쓰고 있는 앱 |

설치가 끝났으면 **새 PowerShell** 을 열고 확인합니다.

```powershell
git --version
node -v
npm -v
```

`node -v` 가 `v22` 로 시작해야 합니다. 21 이하면 Node 22 를 다시 설치하세요.

### 2. 코드를 노트북으로 받기

```powershell
cd $HOME
git clone https://github.com/triplet307546-prog/cursor-hackaton-999.git painradar
cd painradar
git checkout main
git pull origin main
npm install
```

`npm install` 은 처음 한 번이면 됩니다. 몇 분이 걸릴 수 있습니다.

### 3. 화면 띄우기

```powershell
npm run dev
```

브라우저에서 엽니다.

- 질문 화면: http://localhost:3000
- 시연 결과: http://localhost:3000/run/fixture

퍼널이 **언급 80 → 독립 관측 40 → 행동 신호 17 → 기회 3** 이면 정상입니다.

끝내려면 터미널에서 `Ctrl+C` 를 누릅니다.

### 이미 받은 경우

예전에 clone 해 둔 폴더라면 **main 최신**만 받으면 됩니다.

```powershell
cd 그폴더경로
git checkout main
git pull origin main
npm install
npm run dev
```

### Cursor에서 열기

1. Cursor → **File → Open Folder**
2. 방금 받은 `painradar` 폴더를 선택
3. 터미널(`Ctrl+\``)에서 `npm run dev`

### API 키 (지금은 없어도 됨)

키 없이 `npm run dev` 와 `/run/fixture` 가 됩니다. LLM 은 기본값 `mock` 입니다.

나중에 YouTube·Anthropic 을 붙일 때만 `.env.local` 을 만듭니다. 만드는 방법과 변수 이름은 `docs/ENVIRONMENT.md` 에 있습니다. **키를 Git에 넣지 마세요.**

## 자주 쓰는 명령

```powershell
npm run dev              # 화면
npm test                 # 테스트
npx tsc --noEmit         # 타입 검사
npm run build            # 빌드
npm run run:fixture      # 시연 JSON 다시 만들기
npm run run:cached -- data/runs/fixture.json   # 표로 숫자 확인
```

## 문제 생기면

- 화면이 안 뜨면: 터미널에 `Error` 가 있는지 보고, `node -v` 가 22인지 확인
- 숫자가 이상하면: `npm run run:cached -- data/runs/fixture.json` 의 표와 화면을 비교
- 실수로 파일을 고쳤으면: `git checkout -- 파일명` (예: `git checkout -- app/page.tsx`)
- 그래도 안 되면: 이 채팅에 에러 메시지 전체를 붙여 넣기
