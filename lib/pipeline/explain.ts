import type { PainCluster, ScoringConfig } from "../types";
import {
  RUNG_ORDER,
  confidenceBand,
  opportunityBand,
  topRung,
} from "./score";

function inflationLabel(inflation: number): string {
  return `${inflation.toFixed(1)}x`;
}

function ladderLine(cluster: PainCluster, cfg: ScoringConfig): string {
  const parts = RUNG_ORDER.filter((signalType) => cluster.ladder[signalType] > 0).map(
    (signalType) => `${signalType} ${cluster.ladder[signalType]}`,
  );
  const highest = topRung(cluster.ladder, cfg.min_rung_obs);
  return `${parts.join(" / ")} — 최고단: ${highest}`;
}

function sourceLine(cluster: PainCluster, cfg: ScoringConfig): string {
  let line = `소스 그룹 ${cluster.source_groups}개, 소스 아이템 ${cluster.source_items}개`;
  if (cluster.same_item_ratio >= cfg.same_item_penalty_ratio) {
    line += " — 단일 소스 편중";
  }
  if (cluster.source_groups === 1) {
    line += " — 단일 출처 데이터";
  }
  return line;
}

function rebuttalCount(cluster: PainCluster): number {
  return cluster.counter.already_solved + cluster.counter.alternative_sufficient;
}

function rebuttalSuffix(cluster: PainCluster, cfg: ScoringConfig): string {
  const independent = cluster.independent_observations;
  const ratio = independent > 0 ? rebuttalCount(cluster) / independent : 0;
  if (ratio < cfg.counter_downgrade_ratio) {
    return "하향 조정 없음";
  }

  // 반박만 걷어 본 밴드로, Low에서 더 내려갈 곳이 없는지 가린다.
  const withoutRebuttal: PainCluster = {
    ...cluster,
    counter: {
      ...cluster.counter,
      already_solved: 0,
      alternative_sufficient: 0,
    },
  };
  if (opportunityBand(withoutRebuttal, cfg) === "Low") {
    return "하향 대상이나 이미 Low";
  }
  return "Opportunity 한 단계 하향";
}

function rebuttalLine(cluster: PainCluster, cfg: ScoringConfig): string {
  const count = rebuttalCount(cluster);
  const independent = cluster.independent_observations;
  const percent =
    independent > 0 ? Math.round((count / independent) * 100) : 0;
  return `반박 ${count}건 (${percent}%) — ${rebuttalSuffix(cluster, cfg)}`;
}

export function explain(c: PainCluster, cfg: ScoringConfig): string[] {
  const opportunity = opportunityBand(c, cfg);
  const confidence = confidenceBand(c, cfg);

  return [
    `독립 관측 ${c.independent_observations}건 (언급 ${c.raw_mentions}건, 인플레이션 ${inflationLabel(c.inflation)})`,
    ladderLine(c, cfg),
    sourceLine(c, cfg),
    rebuttalLine(c, cfg),
    `→ Opportunity ${opportunity} / Confidence ${confidence}`,
  ];
}
