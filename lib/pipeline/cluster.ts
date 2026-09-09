import { callJson, type LlmMode } from "../llm";
import type { Evidence, Theme } from "../types";

export const THEME_PROMPT = `질문: {question}. 아래 evidence를 읽고 3~6개 pain 주제를 JSON 배열로만 출력.
각 항목 {cluster_id:'c1'.., title: 12자 이내 한국어, description: 한 줄}. JSON 외 텍스트 금지.`;

const THEME_SAMPLE_LIMIT = 60;

export async function discoverThemes(
  sample: Evidence[],
  question: string,
  mode?: LlmMode,
): Promise<Theme[]> {
  // 대표만 보내야 중복 글이 주제를 한쪽으로 기울이지 않는다.
  const representatives = sample
    .filter((item) => item.is_group_representative)
    .slice(0, THEME_SAMPLE_LIMIT);

  const system = THEME_PROMPT.replace("{question}", question);
  const user = representatives
    .map((item) => `${item.evidence_id}: ${item.text_raw}`)
    .join("\n");

  return callJson<Theme[]>({
    system,
    user,
    mockKey: "themes",
    fallback: [],
    mode,
  });
}
