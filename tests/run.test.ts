import { describe, expect, it } from "vitest";

import scoringConfig from "../config/scoring.json";
import demoJson from "../data/fixtures/demo.json";
import {
  PIPELINE_STEPS,
  runPipeline,
  selectThemeSample,
  type PipelineStep,
} from "../lib/pipeline/run";
import type { Evidence, ResearchRun, ScoringConfig } from "../lib/types";
import {
  capEvidence,
  estimateLlmCalls,
  formatRunTable,
  mergeRawEvidence,
  parseArgs,
} from "../scripts/run";

const cfg = scoringConfig as ScoringConfig;
const fixtureEvidence = demoJson as Evidence[];

async function runFixture(
  steps: PipelineStep[] = [],
  runId?: string,
): Promise<ResearchRun> {
  return runPipeline(
    {
      question: "테스트 질문",
      evidence: fixtureEvidence,
      sources: [],
      mode: "fixture",
      run_id: runId,
    },
    cfg,
    (step) => {
      steps.push(step);
    },
  );
}

function withText(item: Evidence, textRaw: string): Evidence {
  return { ...item, text_raw: textRaw };
}

describe("runPipeline (fixture)", () => {
  it("rank_before ≠ rank_after 인 클러스터가 1개 이상이다", async () => {
    const run = await runFixture();
    const moved = run.clusters.filter(
      (cluster) => cluster.rank_before !== cluster.rank_after,
    );
    expect(moved.length).toBeGreaterThanOrEqual(1);
  });

  it("funnel.raw_mentions === 80, 독립 관측 40, 기회 = clusters.length", async () => {
    const run = await runFixture();
    expect(run.funnel.raw_mentions).toBe(80);
    expect(run.funnel.independent_observations).toBe(40);
    expect(run.funnel.opportunities).toBe(run.clusters.length);
    expect(run.funnel.behavior_signals).toBeGreaterThan(0);
  });

  it("모든 ranking_reasons 는 5줄이고 dropped_quotes 는 0이다", async () => {
    const run = await runFixture();
    expect(run.clusters.length).toBeGreaterThan(0);
    for (const cluster of run.clusters) {
      expect(cluster.ranking_reasons).toHaveLength(5);
    }
    expect(run.llm.dropped_quotes).toBe(0);
    expect(run.llm.mode).toBe("mock");
  });

  it("onProgress step 목록이 정확히 normalize→dedup→themes→classify→rank→done 이다", async () => {
    const steps: PipelineStep[] = [];
    await runFixture(steps);
    expect(steps).toEqual([
      "normalize",
      "dedup",
      "themes",
      "classify",
      "rank",
      "done",
    ]);
    expect(steps).toEqual([...PIPELINE_STEPS]);
  });

  it("run_id 는 입력값을 쓰고, 없으면 새로 만든다", async () => {
    const withId = await runFixture([], "fixture");
    expect(withId.run_id).toBe("fixture");
    expect(withId.mode).toBe("fixture");

    const generated = await runFixture([]);
    expect(generated.run_id.length).toBeGreaterThan(0);
    expect(generated.run_id).not.toBe("fixture");
  });

  it("fixture 모드는 LLM_MODE=real 이어도 mock 으로 돈다", async () => {
    const previous = process.env.LLM_MODE;
    process.env.LLM_MODE = "real";
    try {
      const run = await runFixture();
      expect(run.llm.mode).toBe("mock");
      expect(run.llm.dropped_quotes).toBe(0);
      expect(run.clusters.length).toBe(3);
    } finally {
      if (previous === undefined) {
        delete process.env.LLM_MODE;
      } else {
        process.env.LLM_MODE = previous;
      }
    }
  });

  it("입력 evidence 를 변경하지 않고, 집계는 대표 단위로 센다", async () => {
    const snapshot = structuredClone(fixtureEvidence);
    const run = await runFixture();
    expect(fixtureEvidence).toEqual(snapshot);

    const representatives = run.evidence.filter(
      (item) => item.is_group_representative,
    );
    const totalIndependent = run.clusters.reduce(
      (sum, cluster) => sum + cluster.independent_observations,
      0,
    );
    const totalRaw = run.clusters.reduce(
      (sum, cluster) => sum + cluster.raw_mentions,
      0,
    );
    expect(totalIndependent).toBe(representatives.length);
    expect(totalRaw).toBe(80);

    for (const cluster of run.clusters) {
      expect(cluster.representative_ids).toHaveLength(
        cluster.independent_observations,
      );
      expect(cluster.inflation).toBeCloseTo(
        cluster.raw_mentions / cluster.independent_observations,
      );
      expect(cluster.same_item_ratio).toBeGreaterThan(0);
      expect(cluster.same_item_ratio).toBeLessThanOrEqual(1);
    }
  });
});

describe("selectThemeSample", () => {
  it("대표만 likes 내림차순·evidence_id 순으로 고르고 60건까지만 남긴다", () => {
    const items: Evidence[] = [
      { ...fixtureEvidence[0], evidence_id: "b", is_group_representative: true, engagement: { likes: 5 } },
      { ...fixtureEvidence[0], evidence_id: "a", is_group_representative: true, engagement: { likes: 5 } },
      { ...fixtureEvidence[0], evidence_id: "c", is_group_representative: true, engagement: { likes: 9 } },
      { ...fixtureEvidence[0], evidence_id: "member", is_group_representative: false, engagement: { likes: 99 } },
      { ...fixtureEvidence[0], evidence_id: "d", is_group_representative: true, engagement: {} },
    ];
    expect(selectThemeSample(items).map((item) => item.evidence_id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(selectThemeSample(items, 2).map((item) => item.evidence_id)).toEqual([
      "c",
      "a",
    ]);
  });
});

describe("mergeRawEvidence (--raw 1차 중복 제거)", () => {
  const first = fixtureEvidence[0];
  const second = fixtureEvidence[1];

  it("같은 evidence_id 의 text_raw 가 같으면 먼저 읽힌 파일 것 하나만 남긴다", () => {
    const fromFileA = { ...first, url: "https://a.invalid" };
    const fromFileB = { ...first, url: "https://b.invalid" };
    const result = mergeRawEvidence([
      { path: "a.json", evidence: [fromFileA, second] },
      { path: "b.json", evidence: [fromFileB] },
    ]);

    expect(result.input).toBe(3);
    expect(result.unique).toBe(2);
    expect(result.evidence).toHaveLength(2);
    expect(
      result.evidence.filter((item) => item.evidence_id === first.evidence_id),
    ).toHaveLength(1);
    expect(result.evidence[0].url).toBe("https://a.invalid");
  });

  it("같은 evidence_id 의 text_raw 가 다르면 오류를 낸다", () => {
    expect(() =>
      mergeRawEvidence([
        { path: "a.json", evidence: [first] },
        { path: "b.json", evidence: [withText(first, `${first.text_raw} 수정됨`)] },
      ]),
    ).toThrow(/text_raw/u);
  });
});

describe("capEvidence / estimateLlmCalls", () => {
  it("상한을 넘으면 likes 내림차순, 같으면 published_at 내림차순으로 자른다", () => {
    const base = fixtureEvidence[0];
    const items: Evidence[] = [
      { ...base, evidence_id: "old-high", engagement: { likes: 3 }, published_at: "2026-01-01T00:00:00Z" },
      { ...base, evidence_id: "new-high", engagement: { likes: 3 }, published_at: "2026-02-01T00:00:00Z" },
      { ...base, evidence_id: "low", engagement: { likes: 1 }, published_at: "2026-03-01T00:00:00Z" },
      { ...base, evidence_id: "none", engagement: {}, published_at: null },
    ];

    expect(capEvidence(items, 2).map((item) => item.evidence_id)).toEqual([
      "new-high",
      "old-high",
    ]);
    expect(capEvidence(items, 10)).toHaveLength(4);
  });

  it("예상 LLM 호출 수 = ceil(대표 수 / batch_size) + 1", () => {
    expect(estimateLlmCalls(40, 20)).toBe(3);
    expect(estimateLlmCalls(41, 20)).toBe(4);
    expect(estimateLlmCalls(0, 20)).toBe(1);
  });
});

describe("parseArgs / formatRunTable", () => {
  it("--raw 뒤의 경로와 옵션을 읽는다", () => {
    const options = parseArgs([
      "--raw",
      "a.json",
      "b.json",
      "--max-evidence",
      "100",
      "--question",
      "질문?",
    ]);
    expect(options.command).toBe("raw");
    expect(options.rawPaths).toEqual(["a.json", "b.json"]);
    expect(options.maxEvidence).toBe(100);
    expect(options.question).toBe("질문?");
    expect(parseArgs(["--cached", "x.json"]).cachedPath).toBe("x.json");
    expect(() => parseArgs(["--bogus"])).toThrow();
  });

  it("표는 질문·퍼널·RAW/VERIFIED 순위·1위 이유·집계를 담는다", async () => {
    const run = await runFixture([], "fixture");
    const lines = formatRunTable(run);
    expect(lines[0]).toBe("질문: 테스트 질문");
    expect(lines[1]).toContain("언급 80 → 독립 관측 40");
    expect(lines[2]).toContain("RAW RANK");
    expect(lines[2]).toContain("VERIFIED RANK");
    expect(lines).toContain("--- 1위 이유 ---");
    expect(lines).toContain("--- 집계 ---");
    expect(lines.filter((line) => line.includes(" · top: ")).length).toBe(
      run.clusters.length,
    );
  });
});
