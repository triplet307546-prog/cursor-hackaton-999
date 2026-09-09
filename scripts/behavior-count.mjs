import { readdirSync, readFileSync } from 'node:fs';

const P = {
  '우회':     /엑셀|따로 정리|수기로|일일이|직접 만들|매크로|노션/,
  '대안탐색': /없나요|없을까요|추천 좀|방법 있나|뭐 쓰시/,
  '이탈':     /갈아탔|옮겼|바꿨|해지|넘어갔|접었/,
  '결제':     /월 ?[0-9]|유료|결제해서|돈 내고|비용 내/,
};

const files = readdirSync('data/raw').filter(f => /^(youtube|naver)_.+\.json$/.test(f));
if (files.length === 0) { console.error('data/raw 에 대상 파일이 없다'); process.exit(1); }

const docs = new Map();   // 카테고리 -> 원문 건수
const hits = new Map();   // 카테고리 -> 매치 수
let total = 0;
const behaved = new Set();

for (const f of files) {
  const j = JSON.parse(readFileSync(`data/raw/${f}`, 'utf8'));
  const list = Array.isArray(j) ? j : (j.evidence ?? j.items ?? j.comments ?? []);
  if (!Array.isArray(list) || list.length === 0) {
    console.error(`${f}: evidence 배열을 못 찾았다. 파일 최상위 키를 확인하고 위 ?? 목록에 추가해라`);
    continue;
  }
  for (const e of list) {
    const t = e.text_raw ?? '';
    if (!t) continue;
    total++;
    for (const [k, re] of Object.entries(P)) {
      const m = t.match(new RegExp(re.source, 'g'));
      if (m) {
        docs.set(k, (docs.get(k) ?? 0) + 1);
        hits.set(k, (hits.get(k) ?? 0) + m.length);
        behaved.add(e.evidence_id ?? `${f}:${total}`);
      }
    }
  }
}

console.log('카테고리   원문건수   매치수');
for (const k of Object.keys(P)) {
  console.log(k.padEnd(9), String(docs.get(k) ?? 0).padStart(6), String(hits.get(k) ?? 0).padStart(8));
}
console.log('---');
console.log(`행동 원문 (중복 제외) ${behaved.size} / 전체 ${total} = ${(behaved.size / total * 100).toFixed(1)}%`);
