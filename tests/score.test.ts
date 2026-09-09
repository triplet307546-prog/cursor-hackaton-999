import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { explain } from "../lib/pipeline/explain";
import {
  confidenceBand,
  opportunityBand,
  rank,
  rungIndex,
  topRung,
} from "../lib/pipeline/score";
import type {
  CounterType,
  PainCluster,
  ScoringConfig,
  SignalType,
} from "../lib/types";

const cfg = JSON.parse(
  readFileSync(resolve(process.cwd(), "config/scoring.json"), "utf8"),
) as ScoringConfig;

const EMPTY_LADDER: Record<SignalType, number> = {
  complaint: 0,
  workaround: 0,
  alternative_search: 0,
  switching: 0,
  payment: 0,
};

const EMPTY_COUNTER: Record<CounterType, number> = {
  already_solved: 0,
  alternative_sufficient: 0,
  not_experienced: 0,
};

function makeCluster(
  partial: Omit<Partial<PainCluster>, "ladder" | "counter"> &
    Pick<PainCluster, "cluster_id"> & {
      ladder?: Partial<Record<SignalType, number>>;
      counter?: Partial<Record<CounterType, number>>;
    },
): PainCluster {
  const { ladder, counter, cluster_id, ...rest } = partial;
  return {
    cluster_id,
    title: cluster_id,
    description: "",
    raw_mentions: 0,
    independent_observations: 0,
    source_groups: 1,
    source_items: 1,
    same_item_ratio: 0,
    inflation: 1,
    top_rung: "complaint",
    supporting_evidence: 0,
    counter_evidence: 0,
    opportunity: "Low",
    confidence: "Low",
    rank_before: 0,
    rank_after: 0,
    ranking_reasons: [],
    representative_ids: [],
    ...rest,
    ladder: { ...EMPTY_LADDER, ...ladder },
    counter: { ...EMPTY_COUNTER, ...counter },
  };
}

const clusterA = makeCluster({
  cluster_id: "a",
  raw_mentions: 148,
  independent_observations: 11,
  inflation: 13.45,
  ladder: { complaint: 11 },
  source_groups: 1,
  source_items: 11,
  same_item_ratio: 0.8,
});

const clusterB = makeCluster({
  cluster_id: "b",
  raw_mentions: 47,
  independent_observations: 34,
  inflation: 1.38,
  ladder: {
    workaround: 16,
    alternative_search: 6,
    switching: 4,
    payment: 2,
  },
  counter: {
    already_solved: 3,
    alternative_sufficient: 0,
    not_experienced: 8,
  },
  source_groups: 2,
  source_items: 19,
  same_item_ratio: 0.3,
});

const clusterC = makeCluster({
  cluster_id: "c",
  raw_mentions: 20,
  independent_observations: 5,
  inflation: 4,
  ladder: { complaint: 5 },
  source_groups: 1,
  source_items: 5,
  same_item_ratio: 0.2,
});

function byId(clusters: PainCluster[], clusterId: string): PainCluster {
  const found = clusters.find((cluster) => cluster.cluster_id === clusterId);
  if (!found) throw new Error(`cluster ${clusterId} not found`);
  return found;
}

describe("rungIndex / topRung", () => {
  it("사다리 순서를 인덱스로 돌려준다", () => {
    expect(rungIndex("complaint")).toBe(0);
    expect(rungIndex("workaround")).toBe(1);
    expect(rungIndex("alternative_search")).toBe(2);
    expect(rungIndex("switching")).toBe(3);
    expect(rungIndex("payment")).toBe(4);
  });

  it("minObs 이상인 가장 높은 단을 고르고, 없으면 complaint", () => {
    expect(topRung(clusterB.ladder, cfg.min_rung_obs)).toBe("switching");
    expect(topRung(clusterA.ladder, cfg.min_rung_obs)).toBe("complaint");
    expect(topRung(EMPTY_LADDER, cfg.min_rung_obs)).toBe("complaint");
  });
});

describe("opportunityBand / confidenceBand", () => {
  it("(a) Opportunity Low, Confidence Low — 편중 하향", () => {
    expect(opportunityBand(clusterA, cfg)).toBe("Low");
    expect(confidenceBand(clusterA, cfg)).toBe("Low");
  });

  it("(b) Opportunity High, Confidence Medium — not_experienced 때문에 High 탈락", () => {
    expect(opportunityBand(clusterB, cfg)).toBe("High");
    expect(confidenceBand(clusterB, cfg)).toBe("Medium");
  });

  it("(c) Opportunity Low, Confidence Low", () => {
    expect(opportunityBand(clusterC, cfg)).toBe("Low");
    expect(confidenceBand(clusterC, cfg)).toBe("Low");
  });

  it("(d) opp_high.min_ind 를 바꾸면 (b)가 Medium 이 된다", () => {
    const raisedHigh: ScoringConfig = {
      ...cfg,
      opp_high: { ...cfg.opp_high, min_ind: 50 },
    };
    expect(opportunityBand(clusterB, raisedHigh)).toBe("Medium");
  });

  it("(e) 반박 비율이 넘으면 Opportunity 한 단계 하향", () => {
    const rebuttedB = makeCluster({
      ...clusterB,
      counter: {
        ...clusterB.counter,
        already_solved: 12,
      },
    });
    expect(opportunityBand(rebuttedB, cfg)).toBe("Medium");
  });
});

describe("rank", () => {
  it("입력을 변경하지 않고 before/after 순위를 채운다", () => {
    const input = [clusterA, clusterB, clusterC];
    const snapshot = structuredClone(input);

    const ranked = rank(input, cfg);

    expect(input).toEqual(snapshot);
    expect(byId(ranked, "a").rank_before).toBe(1);
    expect(byId(ranked, "b").rank_before).toBe(2);
    expect(byId(ranked, "c").rank_before).toBe(3);
    expect(byId(ranked, "b").rank_after).toBe(1);
    expect(byId(ranked, "a").rank_after).toBe(2);
    expect(byId(ranked, "c").rank_after).toBe(3);
    expect(ranked.map((cluster) => cluster.cluster_id)).toEqual(["b", "a", "c"]);
    expect(byId(ranked, "b").top_rung).toBe("switching");
    expect(byId(ranked, "b").opportunity).toBe("High");
    expect(byId(ranked, "b").confidence).toBe("Medium");
  });
});

describe("explain", () => {
  it("(b) 설명은 한국어 5줄이다", () => {
    const lines = explain(clusterB, cfg);
    expect(lines).toEqual([
      "독립 관측 34건 (언급 47건, 인플레이션 1.4x)",
      "workaround 16 / alternative_search 6 / switching 4 / payment 2 — 최고단: switching",
      "소스 그룹 2개, 소스 아이템 19개",
      "반박 3건 (9%) — 하향 조정 없음",
      "→ Opportunity High / Confidence Medium",
    ]);
  });

  it("반박 하향과 이미 Low 문구를 구분한다", () => {
    const rebuttedB = makeCluster({
      ...clusterB,
      counter: { ...clusterB.counter, already_solved: 12 },
    });
    expect(explain(rebuttedB, cfg)[3]).toBe(
      "반박 12건 (35%) — Opportunity 한 단계 하향",
    );
    expect(explain(clusterC, cfg)[2]).toBe(
      "소스 그룹 1개, 소스 아이템 5개 — 단일 출처 데이터",
    );
    const alreadyLow = makeCluster({
      ...clusterC,
      counter: { already_solved: 2 },
    });
    expect(explain(alreadyLow, cfg)[3]).toBe(
      "반박 2건 (40%) — 하향 대상이나 이미 Low",
    );
  });
});
