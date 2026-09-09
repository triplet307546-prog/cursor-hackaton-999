import { callJson, llmMode, type LlmMode } from "../llm";
import { RUNG_ORDER } from "./score";
import type {
  CounterSignal,
  CounterType,
  Evidence,
  ScoringConfig,
  Signal,
  SignalType,
  Theme,
} from "../types";

const PROMO_LINK =
  /(https?:\/\/|open\.kakao|bit\.ly|blog\.naver|cafe\.naver|smartstore\.naver)/i;
const PROMO_CONTACT =
  /(문의\s*주세요|문의\s*환영|문의\s*드립|디엠|\bDM\b|카톡\s*아이디|오픈\s*채팅|프로필\s*링크|상담\s*신청|연락\s*주세요|댓글\s*남겨\s*주)/;
const PROMO_SALES =
  /(무료\s*체험|무료\s*상담|할인\s*중|이벤트\s*중|제작\s*해\s*드|설치\s*해\s*드|대행\s*해\s*드|저렴하게\s*해\s*드|수수료\s*없이)/;

// 링크+연락/판매, 또는 연락+판매가 겹칠 때만 홍보다. '문의' 단독은 셀러 원문일 수 있다.
export function isPromo(textRaw: string): boolean {
  const hasLink = PROMO_LINK.test(textRaw);
  const hasContact = PROMO_CONTACT.test(textRaw);
  const hasSales = PROMO_SALES.test(textRaw);
  return (hasLink && (hasContact || hasSales)) || (hasContact && hasSales);
}

const THANKS =
  /(감사|고맙|잘\s*봤|잘\s*보고|유익|도움\s*(이\s*)?(됐|되었|됩)|최고|화이팅|파이팅|응원|구독|좋아요\s*누르)/;
const NO_CONTENT = /^[\sㄱ-ㅎㅏ-ㅣ0-9!?.,~♡♥❤👍🙏😂🥲ㅋㅎㅠㅜ]*$/;
const BEHAVIOR =
  /엑셀|따로\s*정리|수기로|일일이|직접\s*만들|매크로|노션|갈아탔|옮겼|해지|넘어갔|접었|유료|결제|월\s*[0-9]/;

export function isContentless(textRaw: string): boolean {
  const len = textRaw.replace(/\s/g, "").length;
  // 행동 표현이 있는 원문은 어떤 경우에도 버리지 않는다.
  if (BEHAVIOR.test(textRaw)) {
    return false;
  }
  if (NO_CONTENT.test(textRaw)) {
    return true;
  }
  if (len < 20 && THANKS.test(textRaw)) {
    return true;
  }
  return false;
}

export const CLASSIFY_PROMPT = `아래 pain 주제 목록에 각 evidence를 분류하라.

주제:
{themes}

signal 정의:
- complaint: 불편·항의·불만을 직접 말하는 표현
- workaround: 원래 기능 대신 손으로 우회하거나 임시로 때우는 행동
- alternative_search: 다른 도구·서비스를 찾거나 물어보는 표현
- switching: 다른 도구·서비스로 갈아탔거나 옮긴 행동
- payment: 돈(월 요금·결제)을 내고 쓰는 행동

counter 정의:
- already_solved: 이미 해결됨/업데이트로 됨
- alternative_sufficient: 무료·기존 대안으로 충분
- not_experienced: 그런 적 없음/현재 방식에 만족

출력 스키마 예시:
[{"evidence_id":"e1","pain_cluster_id":"c1","is_noise":false,"signals":[{"type":"complaint","quote":"원문 연속 구간","confidence":0.8}],"counter":[]}]

입력 evidence 마다 정확히 한 항목을 반환한다. 항목 수와 evidence 수는 같아야 한다.
주제가 여러 개로 보여도 가장 맞는 것 하나만 고르고, 해당 없으면 is_noise:true 로 표시한다.

quote 는 원문에서 20~60자 연속 구간을 한 글자도 바꾸지 말고 복사한다.
이모지·ㅋㅋ·오타도 그대로.
JSON 외 텍스트 금지.`;

export type RawLabel = {
  evidence_id: string;
  pain_cluster_id: string | null;
  is_noise: boolean;
  signals: { type: SignalType; quote: string; confidence: number }[];
  counter: { type: CounterType; quote: string; confidence: number }[];
};

function emptyRawLabel(evidenceId: string): RawLabel {
  return {
    evidence_id: evidenceId,
    pain_cluster_id: null,
    is_noise: false,
    signals: [],
    counter: [],
  };
}

function compactForQuote(text: string): string {
  // NFKC 후 공백·줄바꿈을 없애야 띄어쓰기만 다른 인용도 같은 원문으로 본다.
  return text.normalize("NFKC").replace(/\s/gu, "");
}

const SIGNAL_TYPES: ReadonlySet<string> = new Set(RUNG_ORDER);
const COUNTER_TYPES: ReadonlySet<string> = new Set<CounterType>([
  "already_solved",
  "alternative_sufficient",
  "not_experienced",
]);

function quoteMatchesSource(quote: string, textRaw: string): boolean {
  // LLM 이 quote 키를 빼고 돌려주는 경우가 있어 문자열이 아니면 불일치로 센다.
  if (typeof quote !== "string" || quote.length < 4) {
    return false;
  }
  const compactQuote = compactForQuote(quote);
  if (compactQuote.length < 4) {
    return false;
  }
  return compactForQuote(textRaw).includes(compactQuote);
}

function formatThemes(themes: Theme[]): string {
  return themes
    .map((theme) => `- ${theme.cluster_id}: ${theme.title} (${theme.description})`)
    .join("\n");
}

export function buildClassifyUser(batch: Evidence[]): string {
  const evidenceBlock = batch
    .map((item) => `${item.evidence_id}: ${item.text_raw}`)
    .join("\n");
  // 주제·정의는 system 에 있다. 여기서 되풀이하면 배치마다 토큰만 늘고 항목 수 규칙이 묻힌다.
  return `evidence ${batch.length}건을 분류해 항목 ${batch.length}개짜리 JSON 배열로 반환하라.\n\nevidence:\n${evidenceBlock}`;
}

export async function classifyBatch(
  batch: Evidence[],
  themes: Theme[],
  mode?: LlmMode,
): Promise<RawLabel[]> {
  const resolvedMode = mode ?? llmMode();
  const system = CLASSIFY_PROMPT.replace("{themes}", formatThemes(themes));
  const user = buildClassifyUser(batch);

  if (resolvedMode === "real") {
    const labels = await callJson<RawLabel[]>({
      system,
      user,
      mockKey: "labels",
      fallback: [],
      mode: "real",
    });
    if (!Array.isArray(labels) || (batch.length > 0 && labels.length === 0)) {
      console.warn(
        `[classify] unexpected labels response for ${batch[0]?.evidence_id}: ${
          Array.isArray(labels) ? `array(${labels.length})` : typeof labels
        }`,
      );
    }
    const byId = new Map(
      (Array.isArray(labels) ? labels : []).map((label) => [
        label.evidence_id,
        label,
      ]),
    );
    return batch.map(
      (item) => byId.get(item.evidence_id) ?? emptyRawLabel(item.evidence_id),
    );
  }

  // mock 은 전체 맵을 한 번에 읽고 id 로 찾는다. 배치 크기·순서에 결과가 달라지면 안 된다.
  const map = await callJson<Record<string, RawLabel>>({
    system,
    user,
    mockKey: "labels",
    fallback: {},
    mode: "mock",
  });

  return batch.map((item) => {
    const found = map[item.evidence_id];
    if (!found) {
      return emptyRawLabel(item.evidence_id);
    }
    return found;
  });
}

export function validateLabels(
  batch: Evidence[],
  labels: RawLabel[],
  themes: Theme[],
  cfg: ScoringConfig,
): {
  evidence: Evidence[];
  dropped: number;
  promo_dropped: number;
  contentless_dropped: number;
} {
  const labelsById = new Map(labels.map((label) => [label.evidence_id, label]));
  const themeIds = new Set(themes.map((theme) => theme.cluster_id));
  let dropped = 0;
  let promoDropped = 0;
  let contentlessDropped = 0;

  const evidence = batch.map((item) => {
    const raw = labelsById.get(item.evidence_id) ?? emptyRawLabel(item.evidence_id);

    let signals: Signal[] = [];
    for (const signal of raw.signals) {
      // type 이 목록 밖이면 ladder/counter 집계에서 NaN 이 되므로 quote 불일치와 같이 버린다.
      if (
        !SIGNAL_TYPES.has(signal?.type) ||
        !quoteMatchesSource(signal.quote, item.text_raw)
      ) {
        dropped += 1;
        continue;
      }
      signals.push({
        type: signal.type,
        quote: signal.quote,
        confidence: signal.confidence,
        used_in_ranking: signal.confidence >= cfg.signal_min_confidence,
      });
    }

    const counter: CounterSignal[] = [];
    for (const itemCounter of raw.counter) {
      if (
        !COUNTER_TYPES.has(itemCounter?.type) ||
        !quoteMatchesSource(itemCounter.quote, item.text_raw)
      ) {
        dropped += 1;
        continue;
      }
      counter.push({
        type: itemCounter.type,
        quote: itemCounter.quote,
        confidence: itemCounter.confidence,
      });
    }

    let painClusterId = raw.pain_cluster_id;
    let isNoise = raw.is_noise;
    if (painClusterId !== null && !themeIds.has(painClusterId)) {
      painClusterId = null;
      isNoise = true;
    }

    if (isPromo(item.text_raw)) {
      promoDropped += signals.length;
      signals = [];
      isNoise = true;
    }

    if (isContentless(item.text_raw)) {
      signals = [];
      isNoise = true;
      contentlessDropped += 1;
    }

    return {
      ...item,
      pain_cluster_id: painClusterId,
      is_noise: isNoise,
      signals,
      counter,
    };
  });

  return {
    evidence,
    dropped,
    promo_dropped: promoDropped,
    contentless_dropped: contentlessDropped,
  };
}

export async function classifyAll(
  evidence: Evidence[],
  themes: Theme[],
  cfg: ScoringConfig,
  mode?: LlmMode,
): Promise<{
  evidence: Evidence[];
  dropped: number;
  promo_dropped: number;
  contentless_dropped: number;
}> {
  const representatives = evidence.filter((item) => item.is_group_representative);
  const labeledRepresentatives: Evidence[] = [];
  let dropped = 0;
  let promoDropped = 0;
  let contentlessDropped = 0;
  let totalSignals = 0;

  // LLM 호출은 항상 순차. 배치를 동시에 보내면 할당량·로그가 꼬인다.
  for (let start = 0; start < representatives.length; start += cfg.batch_size) {
    const batch = representatives.slice(start, start + cfg.batch_size);
    const rawLabels = await classifyBatch(batch, themes, mode);
    totalSignals += rawLabels.reduce(
      (count, label) => count + label.signals.length,
      0,
    );
    const validated = validateLabels(batch, rawLabels, themes, cfg);
    labeledRepresentatives.push(...validated.evidence);
    dropped += validated.dropped;
    promoDropped += validated.promo_dropped;
    contentlessDropped += validated.contentless_dropped;
  }

  if (totalSignals > 0 && dropped / totalSignals > 0.3) {
    console.warn(
      `[classify] dropped quotes ${dropped}/${totalSignals} exceed 0.3`,
    );
  }

  const representativeById = new Map(
    labeledRepresentatives.map((item) => [item.evidence_id, item]),
  );
  const representativeByGroup = new Map<string, Evidence>();
  for (const item of labeledRepresentatives) {
    representativeByGroup.set(item.dedup_group_id, item);
  }

  const labeledEvidence = evidence.map((item) => {
    if (item.is_group_representative) {
      return representativeById.get(item.evidence_id) ?? item;
    }

    const representative = representativeByGroup.get(item.dedup_group_id);
    return {
      ...item,
      pain_cluster_id: representative?.pain_cluster_id ?? null,
      is_noise: representative?.is_noise ?? false,
      // 멤버 원문에는 대표 quote 가 없을 수 있어 신호는 비운다.
      signals: [],
      counter: [],
    };
  });

  console.log(
    `[classify] promo 제외 ${promoDropped}건 / 무내용 제외 ${contentlessDropped}건 / quote 불일치 ${dropped}건`,
  );

  return {
    evidence: labeledEvidence,
    dropped,
    promo_dropped: promoDropped,
    contentless_dropped: contentlessDropped,
  };
}
