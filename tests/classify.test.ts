process.env.LLM_MODE = "mock";

import { describe, expect, it } from "vitest";

import scoringConfig from "../config/scoring.json";
import demoJson from "../data/fixtures/demo.json";
import labelsJson from "../data/fixtures/labels.json";
import {
  classifyAll,
  isContentless,
  isPromo,
  validateLabels,
  type RawLabel,
} from "../lib/pipeline/classify";
import { applyDedup, dedup } from "../lib/pipeline/dedup";
import { applyNormalize } from "../lib/pipeline/normalize";
import type { Evidence, ScoringConfig, Theme } from "../lib/types";

const cfg = scoringConfig as ScoringConfig;
const fixtureEvidence = demoJson as Evidence[];
const themes = labelsJson.themes as Theme[];
const fixtureLabels = labelsJson.labels as Record<string, RawLabel>;

const normalizedEvidence = applyNormalize(fixtureEvidence);
const groups = dedup(normalizedEvidence, cfg);
const deduplicatedEvidence = applyDedup(normalizedEvidence, groups);
const representatives = deduplicatedEvidence.filter(
  (item) => item.is_group_representative,
);

function rankingSignals(items: Evidence[]) {
  return items.flatMap((item) =>
    item.signals.filter((signal) => signal.used_in_ranking),
  );
}

describe("classifyAll / validateLabels", () => {
  it("(a) fixture 분류 후 dropped 는 0이다", async () => {
    const result = await classifyAll(deduplicatedEvidence, themes, cfg);
    expect(result.dropped).toBe(0);
  });

  it("(b) 원문에 없는 quote 는 dropped 1이다", () => {
    const batch = [representatives[0]];
    const labels: RawLabel[] = [
      {
        evidence_id: batch[0].evidence_id,
        pain_cluster_id: "c1",
        is_noise: false,
        signals: [
          {
            type: "complaint",
            quote: "원문에없는인용문구XYZ12345",
            confidence: 0.9,
          },
        ],
        counter: [],
      },
    ];

    expect(validateLabels(batch, labels, themes, cfg).dropped).toBe(1);
  });

  it("(b2) 공백만 다른 quote 는 통과한다", () => {
    const batch = [representatives[0]];
    const snippet = batch[0].text_raw.slice(0, 16);
    const spacedQuote = Array.from(snippet).join(" ");
    const labels: RawLabel[] = [
      {
        evidence_id: batch[0].evidence_id,
        pain_cluster_id: "c1",
        is_noise: false,
        signals: [{ type: "complaint", quote: spacedQuote, confidence: 0.8 }],
        counter: [],
      },
    ];

    const result = validateLabels(batch, labels, themes, cfg);
    expect(result.dropped).toBe(0);
    expect(result.evidence[0].signals[0].quote).toBe(spacedQuote);
  });

  it("(c) 같은 dedup 그룹 멤버는 대표 cluster 만 복사하고 quote 는 비운다", async () => {
    const result = await classifyAll(deduplicatedEvidence, themes, cfg);
    const members = result.evidence.filter(
      (item) => !item.is_group_representative,
    );
    expect(members.length).toBeGreaterThan(0);

    for (const member of members) {
      const representative = result.evidence.find(
        (item) =>
          item.is_group_representative &&
          item.dedup_group_id === member.dedup_group_id,
      );

      expect(representative).toBeDefined();
      expect(member.pain_cluster_id).toBe(representative?.pain_cluster_id);
      expect(member.is_noise).toBe(representative?.is_noise);
      expect(member.signals).toEqual([]);
      expect(member.counter).toEqual([]);
    }
  });

  it("(d) c3 switching/payment 과 c2 허용 타입을 지킨다", async () => {
    const result = await classifyAll(deduplicatedEvidence, themes, cfg);
    const c3Signals = rankingSignals(
      result.evidence.filter(
        (item) => item.is_group_representative && item.pain_cluster_id === "c3",
      ),
    );
    const c2Signals = result.evidence
      .filter(
        (item) => item.is_group_representative && item.pain_cluster_id === "c2",
      )
      .flatMap((item) => item.signals);

    expect(
      c3Signals.filter((signal) => signal.type === "switching").length,
    ).toBeGreaterThanOrEqual(4);
    expect(c3Signals.filter((signal) => signal.type === "payment")).toHaveLength(
      2,
    );
    expect(new Set(c2Signals.map((signal) => signal.type))).toEqual(
      new Set(["complaint", "workaround"]),
    );
  });

  it("(e) applyDedup 대표 id 가 labels.json 에 모두 있다", () => {
    const missing = representatives.filter(
      (item) => fixtureLabels[item.evidence_id] === undefined,
    );
    expect(missing.map((item) => item.evidence_id)).toEqual([]);
  });

  it("(f) used_in_ranking signal 총수는 20 이상이다", async () => {
    const result = await classifyAll(deduplicatedEvidence, themes, cfg);
    expect(rankingSignals(result.evidence).length).toBeGreaterThanOrEqual(20);
  });

  it("(g) 판매·홍보 댓글은 signal 을 비우고 is_noise 로 만든다", () => {
    const textRaw =
      "이거 저희가 해결해드려요 카톡 아이디 남겨주시면 무료 상담 https://example.com";
    const batch: Evidence[] = [
      {
        ...representatives[0],
        evidence_id: "promo-g",
        text_raw: textRaw,
      },
    ];
    const labels: RawLabel[] = [
      {
        evidence_id: "promo-g",
        pain_cluster_id: "c1",
        is_noise: false,
        signals: [
          {
            type: "switching",
            quote: "해결해드려요",
            confidence: 0.9,
          },
        ],
        counter: [],
      },
    ];

    const result = validateLabels(batch, labels, themes, cfg);
    expect(result.evidence[0].signals.length).toBe(0);
    expect(result.evidence[0].is_noise).toBe(true);
    expect(result.promo_dropped).toBe(1);
  });

  it("(h) 단독 '문의' 는 홍보로 보지 않고 signal 을 남긴다", () => {
    const textRaw =
      "저희 스토어도 정산 문의가 많아서 그냥 엑셀로 따로 정리해서 씁니다";
    expect(isPromo(textRaw)).toBe(false);

    const batch: Evidence[] = [
      {
        ...representatives[0],
        evidence_id: "promo-h",
        text_raw: textRaw,
      },
    ];
    const labels: RawLabel[] = [
      {
        evidence_id: "promo-h",
        pain_cluster_id: "c1",
        is_noise: false,
        signals: [
          {
            type: "workaround",
            quote: "엑셀로 따로 정리해서",
            confidence: 0.9,
          },
        ],
        counter: [],
      },
    ];

    const result = validateLabels(batch, labels, themes, cfg);
    expect(result.evidence[0].signals).toHaveLength(1);
    expect(result.evidence[0].signals[0].type).toBe("workaround");
    expect(result.promo_dropped).toBe(0);
  });
});

describe("isContentless", () => {
  it('(i) "감사합니다 잘 봤어요" 는 무내용이다', () => {
    expect(isContentless("감사합니다 잘 봤어요")).toBe(true);
  });

  it('(j) "ㅋㅋㅋㅋㅋ 👍" 는 무내용이다', () => {
    expect(isContentless("ㅋㅋㅋㅋㅋ 👍")).toBe(true);
  });

  it('(k) 감사+행동 표현은 버리지 않는다', () => {
    expect(
      isContentless("감사합니다 저는 그냥 엑셀로 따로 정리해서 씁니다"),
    ).toBe(false);
  });

  it('(l) 긴 고민 원문은 무내용이 아니다', () => {
    expect(
      isContentless(
        "핸드메이드 제품은 인건비 생각하면 공장제품과 싸워야 해서 도저히 답이 안 나오더라고요",
      ),
    ).toBe(false);
  });
});
