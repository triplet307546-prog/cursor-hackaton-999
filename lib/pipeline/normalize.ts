import type { Evidence } from "../types";

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/giu;
const MENTION_OR_HASHTAG_PATTERN = /[@#][^\s@#]+/gu;
const REPEATED_KOREAN_REACTION_PATTERN = /([ᄏ휴ᅮ])\1{2,}/gu;
const REPEATED_EMOJI_PATTERN =
  /(\p{Extended_Pictographic})(?:\uFE0F)?(?:\1(?:\uFE0F)?)+/gu;
const REPEATED_SYMBOL_PATTERN = /([^\p{L}\p{N}\s])\1+/gu;
const REACTION_DISPLAY_CHARACTER: Record<string, string> = {
  ᄏ: "ㅋ",
  ᄒ: "ㅎ",
  ᅲ: "ㅠ",
  ᅮ: "ㅜ",
};

export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(URL_PATTERN, " ")
    .replace(MENTION_OR_HASHTAG_PATTERN, " ")
    // 반응의 뉘앙스는 남기되 길이만으로 유사도가 부풀지 않게 두 글자로 줄인다.
    .replace(REPEATED_KOREAN_REACTION_PATTERN, (_, character: string) =>
      (REACTION_DISPLAY_CHARACTER[character] ?? character).repeat(2),
    )
    .replace(REPEATED_EMOJI_PATTERN, "$1")
    // 문장부호와 연속 이모지는 의미가 같으므로 한 번만 남긴다.
    .replace(REPEATED_SYMBOL_PATTERN, "$1")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function applyNormalize(evidence: Evidence[]): Evidence[] {
  return evidence.map((item) => ({
    ...item,
    text_norm: normalize(item.text_raw),
  }));
}
