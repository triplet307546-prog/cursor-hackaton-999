import { randomUUID } from "node:crypto";

import { llmMode, setUsageContext, type LlmMode } from "../llm";
import type {
  CounterType,
  Evidence,
  PainCluster,
  ResearchRun,
  RunMode,
  ScoringConfig,
  SignalType,
  SourceStatus,
  Theme,
} from "../types";
import { classifyAll } from "./classify";
import { discoverThemes } from "./cluster";
import { applyDedup, dedup } from "./dedup";
import { explain } from "./explain";
import { applyNormalize } from "./normalize";
import { rank, rungIndex, topRung } from "./score";

export type PipelineStep =
  | "normalize"
  | "dedup"
  | "themes"
  | "classify"
  | "rank"
  | "done";

// 화면의 진행 스테퍼가 이 순서·값에 고정되므로 여기 외의 문자열을 onProgress 로 보내지 않는다.
export const PIPELINE_STEPS: readonly PipelineStep[] = [
  "normalize",
  "dedup",
  "themes",
  "classify",
  "rank",
  "done",
];

export interface PipelineInput {
  question: string;
  evidence: Evidence[];
  sources: SourceStatus[];
  mode: RunMode;
  run_id?: string;
}

export type PipelineProgress = (step: PipelineStep, detail?: string) => void;

const THEME_SAMPLE_LIMIT = 60;

// 사다리에서 workaround 이상이면 "불만"이 아닌 "행동"으로 본다.
const BEHAVIOR_MIN_RUNG: SignalType = "workaround";

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

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function createRunId(now: Date): string {
  const date = `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`;
  const time = `${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;
  return `run_${date}_${time}_${randomUUID().slice(0, 8)}`;
}

function resolveLlmMode(mode: RunMode): LlmMode {
  // fixture 는 시연·테스트용이므로 환경변수와 무관하게 항상 mock 으로 돈다.
  return mode === "fixture" ? "mock" : llmMode();
}

function compareThemeSampleOrder(first: Evidence, second: Evidence): number {
  const likesDiff =
    (second.engagement.likes ?? 0) - (first.engagement.likes ?? 0);
  if (likesDiff !== 0) {
    return likesDiff;
  }
  return first.evidence_id.localeCompare(second.evidence_id);
}

export function selectThemeSample(
  evidence: Evidence[],
  limit: number = THEME_SAMPLE_LIMIT,
): Evidence[] {
  // 무작위 표본은 실행마다 주제가 달라져 결과를 재현할 수 없으므로 정렬로 고정한다.
  return evidence
    .filter((item) => item.is_group_representative)
    .sort(compareThemeSampleOrder)
    .slice(0, limit);
}

function isBehaviorRung(type: SignalType): boolean {
  return rungIndex(type) >= rungIndex(BEHAVIOR_MIN_RUNG);
}

// 퍼널의 "행동 신호"는 원문 검증을 통과한 신호면 모두 센다. confidence 문턱은 순위(ladder)에만 적용한다.
function hasAnyBehaviorSignal(item: Evidence): boolean {
  return item.signals.some((signal) => isBehaviorRung(signal.type));
}

function hasRankingBehaviorSignal(item: Evidence): boolean {
  return item.signals.some(
    (signal) => signal.used_in_ranking && isBehaviorRung(signal.type),
  );
}

function countDistinct(values: string[]): number {
  return new Set(values).size;
}

function sameItemRatio(representatives: Evidence[]): number {
  if (representatives.length === 0) {
    return 0;
  }

  const countByItem = new Map<string, number>();
  for (const item of representatives) {
    countByItem.set(
      item.source_item_id,
      (countByItem.get(item.source_item_id) ?? 0) + 1,
    );
  }

  return Math.max(...countByItem.values()) / representatives.length;
}

function buildLadder(representatives: Evidence[]): Record<SignalType, number> {
  const ladder = { ...EMPTY_LADDER };

  for (const item of representatives) {
    // 한 대표가 같은 type 신호를 여러 개 가져도 대표 수로만 센다.
    const types = new Set(
      item.signals
        .filter((signal) => signal.used_in_ranking)
        .map((signal) => signal.type),
    );
    for (const type of types) {
      ladder[type] += 1;
    }
  }

  return ladder;
}

function buildCounter(representatives: Evidence[]): Record<CounterType, number> {
  const counter = { ...EMPTY_COUNTER };

  for (const item of representatives) {
    const types = new Set(item.counter.map((entry) => entry.type));
    for (const type of types) {
      counter[type] += 1;
    }
  }

  return counter;
}

export function aggregateCluster(
  theme: Theme,
  members: Evidence[],
  cfg: ScoringConfig,
): PainCluster {
  const representatives = members.filter((item) => item.is_group_representative);
  const rawMentions = members.length;
  const independentObservations = representatives.length;
  const ladder = buildLadder(representatives);

  return {
    cluster_id: theme.cluster_id,
    title: theme.title,
    description: theme.description,
    raw_mentions: rawMentions,
    independent_observations: independentObservations,
    source_groups: countDistinct(
      representatives.map((item) => item.source_group),
    ),
    source_items: countDistinct(
      representatives.map((item) => item.source_item_id),
    ),
    same_item_ratio: sameItemRatio(representatives),
    inflation:
      independentObservations > 0 ? rawMentions / independentObservations : 0,
    ladder,
    top_rung: topRung(ladder, cfg.min_rung_obs),
    counter: buildCounter(representatives),
    supporting_evidence: representatives.filter(hasRankingBehaviorSignal).length,
    counter_evidence: representatives.filter((item) => item.counter.length > 0)
      .length,
    // 밴드·순위·이유는 rank / explain 이 채운다.
    opportunity: "Low",
    confidence: "Low",
    rank_before: 0,
    rank_after: 0,
    ranking_reasons: [],
    representative_ids: representatives.map((item) => item.evidence_id),
  };
}

export function aggregateClusters(
  evidence: Evidence[],
  themes: Theme[],
  cfg: ScoringConfig,
): PainCluster[] {
  return themes
    .map((theme) =>
      aggregateCluster(
        theme,
        evidence.filter(
          (item) => !item.is_noise && item.pain_cluster_id === theme.cluster_id,
        ),
        cfg,
      ),
    )
    // 대표가 하나도 없는 주제는 근거 원문으로 갈 수 없으므로 기회로 세지 않는다.
    .filter((cluster) => cluster.independent_observations > 0);
}

export function buildFunnel(
  evidence: Evidence[],
  clusters: PainCluster[],
): ResearchRun["funnel"] {
  const representatives = evidence.filter((item) => item.is_group_representative);

  return {
    raw_mentions: evidence.length,
    independent_observations: representatives.length,
    behavior_signals: representatives.filter(hasAnyBehaviorSignal).length,
    opportunities: clusters.length,
  };
}

export async function runPipeline(
  input: PipelineInput,
  cfg: ScoringConfig,
  onProgress?: PipelineProgress,
): Promise<ResearchRun> {
  const startedAt = new Date();
  const runId =
    input.run_id && input.run_id.trim() !== ""
      ? input.run_id
      : createRunId(startedAt);
  const mode = resolveLlmMode(input.mode);
  const report = (step: PipelineStep, detail?: string) => {
    onProgress?.(step, detail);
  };

  report("normalize", `${input.evidence.length}건`);
  const normalized = applyNormalize(input.evidence);

  report("dedup");
  const groups = dedup(normalized, cfg);
  const deduplicated = applyDedup(normalized, groups);

  report("themes", `대표 ${groups.length}건 중 표본 ${Math.min(groups.length, THEME_SAMPLE_LIMIT)}건`);
  setUsageContext({ run_id: runId, phase: "themes" });
  const sample = selectThemeSample(deduplicated);
  const themes = await discoverThemes(sample, input.question, mode);

  report(
    "classify",
    `주제 ${themes.length}개 · 배치 ${Math.ceil(groups.length / cfg.batch_size)}회`,
  );
  setUsageContext({ run_id: runId, phase: "classify" });
  const classified = await classifyAll(deduplicated, themes, cfg, mode);

  // 집계는 PipelineStep 에 없는 단계라 'rank' 알림은 실제 rank() 직전에 보낸다.
  const aggregated = aggregateClusters(classified.evidence, themes, cfg);
  report("rank", `클러스터 ${aggregated.length}개`);
  const clusters = rank(aggregated, cfg).map((cluster) => ({
    ...cluster,
    ranking_reasons: explain(cluster, cfg),
  }));
  const funnel = buildFunnel(classified.evidence, clusters);

  report("done", runId);

  return {
    run_id: runId,
    question: input.question,
    created_at: startedAt.toISOString(),
    mode: input.mode,
    sources: input.sources.map((source) => ({ ...source })),
    funnel,
    clusters,
    evidence: classified.evidence,
    dedup_groups: groups,
    config_snapshot: structuredClone(cfg),
    llm: {
      mode,
      dropped_quotes: classified.dropped,
      promo_dropped: classified.promo_dropped,
      contentless_dropped: classified.contentless_dropped,
    },
  };
}
