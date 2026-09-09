"use client";

import { useEffect, useMemo, type ReactNode } from "react";

import { rungIndex } from "@/lib/pipeline/score";
import type {
  CounterType,
  DedupGroup,
  Evidence,
  PainCluster,
  ResearchRun,
  SignalType,
} from "@/lib/types";

// ---------- 화면 공용 라벨 (Hero 도 같은 표기를 쓴다) ----------

export const RUNG_LABELS: Record<SignalType, string> = {
  complaint: "불만",
  workaround: "우회",
  alternative_search: "대안 탐색",
  switching: "이탈",
  payment: "결제",
};

export const COUNTER_LABELS: Record<CounterType, string> = {
  already_solved: "이미 해결",
  alternative_sufficient: "대안으로 충분",
  not_experienced: "경험 없음",
};

export const SIGNAL_STYLES: Record<SignalType, string> = {
  complaint: "border-zinc-300 bg-zinc-100 text-zinc-700",
  workaround: "border-sky-300 bg-sky-100 text-sky-800",
  alternative_search: "border-violet-300 bg-violet-100 text-violet-800",
  switching: "border-orange-300 bg-orange-100 text-orange-800",
  payment: "border-emerald-300 bg-emerald-100 text-emerald-800",
};

const COUNTER_STYLE = "border-rose-300 bg-rose-100 text-rose-800";

const REASON_LABELS: Record<DedupGroup["reason"], string> = {
  exact: "완전 중복",
  near: "유사 중복",
  thread_echo: "스레드 반복",
  single: "단독",
};

// ---------- 숫자 → 근거 원문 선택 규칙 ----------

export type FunnelKey = keyof ResearchRun["funnel"];

export type ClusterMetric =
  | { kind: "raw_mentions" }
  | { kind: "independent_observations" }
  | { kind: "supporting_evidence" }
  | { kind: "counter_evidence" }
  | { kind: "ladder"; type: SignalType }
  | { kind: "counter"; type: CounterType };

export type EvidenceSelection =
  | { scope: "funnel"; key: FunnelKey }
  | { scope: "cluster"; clusterId: string; metric: ClusterMetric };

const FUNNEL_LABELS: Record<FunnelKey, string> = {
  raw_mentions: "언급",
  independent_observations: "독립 관측",
  behavior_signals: "행동 신호",
  opportunities: "기회",
};

// 사다리에서 workaround 이상이면 "불만"이 아닌 "행동"으로 본다 (lib/pipeline/run.ts 와 같은 기준).
const BEHAVIOR_MIN_RUNG: SignalType = "workaround";

function isBehaviorRung(type: SignalType): boolean {
  return rungIndex(type) >= rungIndex(BEHAVIOR_MIN_RUNG);
}

function findCluster(run: ResearchRun, clusterId: string): PainCluster | null {
  return run.clusters.find((cluster) => cluster.cluster_id === clusterId) ?? null;
}

function representativesOf(run: ResearchRun, cluster: PainCluster): Evidence[] {
  const ids = new Set(cluster.representative_ids);
  return run.evidence.filter((item) => ids.has(item.evidence_id));
}

function selectFunnelEvidence(run: ResearchRun, key: FunnelKey): Evidence[] {
  switch (key) {
    case "raw_mentions":
      return run.evidence;
    case "independent_observations":
      return run.evidence.filter((item) => item.is_group_representative);
    case "behavior_signals":
      // 퍼널의 행동 신호는 confidence 와 무관하게 센다 (순위용 supporting_evidence 와 기준이 다르다).
      return run.evidence.filter(
        (item) =>
          item.is_group_representative &&
          item.signals.some((signal) => isBehaviorRung(signal.type)),
      );
    case "opportunities":
      // 기회는 클러스터 목록이므로 evidence 가 아니다. 드로어가 클러스터 목록을 따로 그린다.
      return [];
  }
}

function selectClusterEvidence(
  run: ResearchRun,
  cluster: PainCluster,
  metric: ClusterMetric,
): Evidence[] {
  const representatives = representativesOf(run, cluster);
  switch (metric.kind) {
    case "raw_mentions":
      return run.evidence.filter(
        (item) => item.pain_cluster_id === cluster.cluster_id && !item.is_noise,
      );
    case "independent_observations":
      return representatives;
    case "supporting_evidence":
      return representatives.filter((item) =>
        item.signals.some(
          (signal) => signal.used_in_ranking && isBehaviorRung(signal.type),
        ),
      );
    case "counter_evidence":
      return representatives.filter((item) => item.counter.length > 0);
    case "ladder":
      return representatives.filter((item) =>
        item.signals.some(
          (signal) => signal.used_in_ranking && signal.type === metric.type,
        ),
      );
    case "counter":
      return representatives.filter((item) =>
        item.counter.some((entry) => entry.type === metric.type),
      );
  }
}

export function selectEvidence(
  run: ResearchRun,
  selection: EvidenceSelection,
): Evidence[] {
  if (selection.scope === "funnel") {
    return selectFunnelEvidence(run, selection.key);
  }
  const cluster = findCluster(run, selection.clusterId);
  return cluster ? selectClusterEvidence(run, cluster, selection.metric) : [];
}

// 화면에 표시하는 숫자는 항상 JSON 값이다. 드로어 목록 길이와 다르면 파이프라인 버그로 본다.
export function expectedCount(
  run: ResearchRun,
  selection: EvidenceSelection,
): number {
  if (selection.scope === "funnel") {
    return run.funnel[selection.key];
  }
  const cluster = findCluster(run, selection.clusterId);
  if (!cluster) {
    return 0;
  }
  const metric = selection.metric;
  switch (metric.kind) {
    case "ladder":
      return cluster.ladder[metric.type];
    case "counter":
      return cluster.counter[metric.type];
    default:
      return cluster[metric.kind];
  }
}

function metricLabel(metric: ClusterMetric): string {
  switch (metric.kind) {
    case "raw_mentions":
      return "언급";
    case "independent_observations":
      return "독립 관측";
    case "supporting_evidence":
      return "지지 근거 (행동 신호)";
    case "counter_evidence":
      return "반박 근거";
    case "ladder":
      return `사다리 · ${RUNG_LABELS[metric.type]}`;
    case "counter":
      return `반박 · ${COUNTER_LABELS[metric.type]}`;
  }
}

export function selectionTitle(
  run: ResearchRun,
  selection: EvidenceSelection,
): string {
  if (selection.scope === "funnel") {
    return `퍼널 · ${FUNNEL_LABELS[selection.key]}`;
  }
  const cluster = findCluster(run, selection.clusterId);
  return `${cluster?.title ?? selection.clusterId} · ${metricLabel(selection.metric)}`;
}

// ---------- quote 하이라이트 ----------

// quote 는 "공백을 제거한 원문" 기준으로 검증됐으므로 공백을 무시하고 위치를 찾아 원문 범위로 되돌린다.
function findQuoteRange(text: string, quote: string): [number, number] | null {
  const target = quote.replace(/\s+/gu, "");
  if (target === "") {
    return null;
  }

  const originalIndexOf: number[] = [];
  let stripped = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (/\s/u.test(character)) {
      continue;
    }
    originalIndexOf.push(index);
    stripped += character;
  }

  const start = stripped.indexOf(target);
  if (start < 0) {
    return null;
  }
  const lastIndex = start + target.length - 1;
  return [originalIndexOf[start], originalIndexOf[lastIndex] + 1];
}

function renderHighlighted(text: string, quote: string | null): ReactNode {
  const range = quote === null ? null : findQuoteRange(text, quote);
  if (range === null) {
    return text;
  }
  const [start, end] = range;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded bg-yellow-200 px-0.5 text-zinc-900">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

// ---------- 행 컴포넌트 ----------

function Tag({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${className}`}
    >
      {children}
    </span>
  );
}

function SourceLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="ml-auto text-xs text-sky-700 underline underline-offset-2 hover:text-sky-900"
    >
      원문 ↗
    </a>
  );
}

function SignalTags({
  item,
  highlight,
}: {
  item: Evidence;
  highlight: SignalType | null;
}) {
  if (item.signals.length === 0 && item.counter.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {item.signals.map((signal, index) => (
        <Tag
          key={`signal-${index}`}
          className={`${SIGNAL_STYLES[signal.type]} ${
            signal.used_in_ranking ? "" : "opacity-60"
          } ${highlight === signal.type ? "ring-2 ring-yellow-400" : ""}`}
        >
          <b>{RUNG_LABELS[signal.type]}</b>
          <span className="text-zinc-600">“{signal.quote.trim()}”</span>
          {!signal.used_in_ranking && <span className="text-zinc-500">순위 제외</span>}
        </Tag>
      ))}
      {item.counter.map((entry, index) => (
        <Tag key={`counter-${index}`} className={COUNTER_STYLE}>
          <b>반박 · {COUNTER_LABELS[entry.type]}</b>
          <span className="text-rose-700">“{entry.quote.trim()}”</span>
        </Tag>
      ))}
    </div>
  );
}

function MemberList({ members }: { members: Evidence[] }) {
  return (
    <ul className="mt-2 space-y-2 border-l-2 border-zinc-200 pl-3">
      {members.map((member) => (
        <li key={member.evidence_id} className="text-sm">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span>{member.source}</span>
            <SourceLink url={member.url} />
          </div>
          <p className="mt-0.5 leading-6 text-zinc-700">{member.text_raw}</p>
        </li>
      ))}
    </ul>
  );
}

interface EvidenceRowProps {
  item: Evidence;
  group: DedupGroup | undefined;
  evidenceById: Map<string, Evidence>;
  highlight: SignalType | null;
}

function EvidenceRow({ item, group, evidenceById, highlight }: EvidenceRowProps) {
  const isRepresentative = item.is_group_representative;
  const groupSize = group?.member_ids.length ?? 1;
  const members = (group?.member_ids ?? [])
    .filter((memberId) => memberId !== item.evidence_id)
    .map((memberId) => evidenceById.get(memberId))
    .filter((member): member is Evidence => member !== undefined);
  const highlightQuote =
    highlight === null
      ? null
      : (item.signals.find(
          (signal) => signal.used_in_ranking && signal.type === highlight,
        )?.quote ?? null);

  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-700">{item.source}</span>
        {group && (
          <Tag className="border-zinc-200 bg-zinc-50 text-zinc-600">
            {REASON_LABELS[group.reason]}
          </Tag>
        )}
        {isRepresentative ? (
          <Tag className="border-zinc-200 bg-zinc-50 text-zinc-600">
            언급 {groupSize}건 대표
          </Tag>
        ) : (
          <Tag className="border-zinc-200 bg-zinc-50 text-zinc-500">중복 멤버</Tag>
        )}
        <SourceLink url={item.url} />
      </div>
      <p className="mt-2 text-sm leading-6 text-zinc-900">
        {renderHighlighted(item.text_raw, highlightQuote)}
      </p>
      {isRepresentative && <SignalTags item={item} highlight={highlight} />}
      {isRepresentative && members.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-zinc-600 hover:text-zinc-900">
            이 관측은 언급 {groupSize}건을 대표 · 멤버 원문 {members.length}건 보기
          </summary>
          <MemberList members={members} />
        </details>
      )}
    </li>
  );
}

function ClusterList({
  run,
  onSelect,
}: {
  run: ResearchRun;
  onSelect: (selection: EvidenceSelection) => void;
}) {
  const byAfter = [...run.clusters].sort((a, b) => a.rank_after - b.rank_after);
  return (
    <ul className="space-y-2">
      {byAfter.map((cluster) => (
        <li key={cluster.cluster_id}>
          <button
            type="button"
            onClick={() =>
              onSelect({
                scope: "cluster",
                clusterId: cluster.cluster_id,
                metric: { kind: "independent_observations" },
              })
            }
            className="w-full rounded-lg border border-zinc-200 bg-white p-3 text-left hover:bg-zinc-50"
          >
            <div className="text-base font-semibold text-zinc-900">
              <span className="text-zinc-400">#{cluster.rank_after}</span> {cluster.title}
            </div>
            <div className="mt-1 text-xs text-zinc-600">
              언급 {cluster.raw_mentions} → 관측 {cluster.independent_observations} ·
              Opportunity {cluster.opportunity} / Confidence {cluster.confidence}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------- 드로어 ----------

interface EvidenceDrawerProps {
  run: ResearchRun;
  selection: EvidenceSelection | null;
  onClose: () => void;
  onSelect: (selection: EvidenceSelection) => void;
}

export default function EvidenceDrawer({
  run,
  selection,
  onClose,
  onSelect,
}: EvidenceDrawerProps) {
  const groupsById = useMemo(
    () => new Map(run.dedup_groups.map((group) => [group.group_id, group])),
    [run],
  );
  const evidenceById = useMemo(
    () => new Map(run.evidence.map((item) => [item.evidence_id, item])),
    [run],
  );

  useEffect(() => {
    if (selection === null) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selection, onClose]);

  if (selection === null) {
    return null;
  }

  const showClusters =
    selection.scope === "funnel" && selection.key === "opportunities";
  const items = selectEvidence(run, selection);
  const expected = expectedCount(run, selection);
  const cluster =
    selection.scope === "cluster" ? findCluster(run, selection.clusterId) : null;
  const highlight =
    selection.scope === "cluster" && selection.metric.kind === "ladder"
      ? selection.metric.type
      : null;
  const mismatch = !showClusters && items.length !== expected;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="닫기"
        onClick={onClose}
        className="absolute inset-0 bg-zinc-900/40"
      />
      <aside className="absolute right-0 top-0 flex h-full w-[480px] max-w-full flex-col bg-zinc-50 shadow-2xl">
        <header className="border-b border-zinc-200 bg-white px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs text-zinc-500">근거 원문</div>
              <h2 className="text-base font-semibold text-zinc-900">
                {selectionTitle(run, selection)}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            >
              닫기 ✕
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-2xl font-bold tabular-nums text-zinc-900">
              {expected}
              <span className="ml-1 text-sm font-normal text-zinc-500">
                {showClusters ? "개" : "건"}
              </span>
            </span>
            {mismatch && (
              <span className="rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs text-rose-700">
                불일치: 목록 {items.length}건
              </span>
            )}
            {cluster && (
              <button
                type="button"
                onClick={() =>
                  onSelect({
                    scope: "cluster",
                    clusterId: cluster.cluster_id,
                    metric: { kind: "counter_evidence" },
                  })
                }
                className={`ml-auto rounded border px-2 py-0.5 text-xs ${COUNTER_STYLE} hover:opacity-80`}
              >
                반박 {cluster.counter_evidence}건
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {showClusters ? (
            <ClusterList run={run} onSelect={onSelect} />
          ) : items.length === 0 ? (
            <p className="text-sm text-zinc-500">해당하는 근거가 없습니다.</p>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => (
                <EvidenceRow
                  key={item.evidence_id}
                  item={item}
                  group={groupsById.get(item.dedup_group_id)}
                  evidenceById={evidenceById}
                  highlight={highlight}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
