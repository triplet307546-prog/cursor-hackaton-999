"use client";

import { Fragment, useState, type MouseEvent, type ReactNode } from "react";

import { RUNG_ORDER } from "@/lib/pipeline/score";
import type {
  Band,
  CounterType,
  PainCluster,
  ResearchRun,
  ScoringConfig,
} from "@/lib/types";
import EvidenceDrawer, {
  COUNTER_LABELS,
  RUNG_LABELS,
  SIGNAL_STYLES,
  type ClusterMetric,
  type EvidenceSelection,
  type FunnelKey,
} from "./EvidenceDrawer";

type RankView = "raw" | "verified";

const BAND_STYLES: Record<Band, string> = {
  High: "border-emerald-300 bg-emerald-100 text-emerald-800",
  Medium: "border-amber-300 bg-amber-100 text-amber-800",
  Low: "border-zinc-300 bg-zinc-100 text-zinc-700",
};

const FUNNEL_STEPS: { key: FunnelKey; label: string }[] = [
  { key: "raw_mentions", label: "언급" },
  { key: "independent_observations", label: "독립 관측" },
  { key: "behavior_signals", label: "행동 신호" },
  { key: "opportunities", label: "기회" },
];

const COUNTER_TYPES: CounterType[] = [
  "already_solved",
  "alternative_sufficient",
  "not_experienced",
];

type SelectHandler = (selection: EvidenceSelection) => void;

// 카드 안의 숫자 버튼은 카드 펼침(onClick)과 분리되어야 하므로 이벤트 전파를 막는다.
function NumberButton({
  onSelect,
  className = "",
  children,
}: {
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onSelect();
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      className={`rounded px-1 font-semibold tabular-nums underline decoration-dotted underline-offset-4 hover:bg-zinc-100 ${className}`}
    >
      {children}
    </button>
  );
}

function Badge({ label, band }: { label: string; band: Band }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${BAND_STYLES[band]}`}
    >
      <span className="opacity-70">{label}</span>
      <b>{band}</b>
    </span>
  );
}

function Funnel({ run, onSelect }: { run: ResearchRun; onSelect: SelectHandler }) {
  return (
    <section className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-5 py-3">
      {FUNNEL_STEPS.map((step, index) => (
        <Fragment key={step.key}>
          {index > 0 && <span className="px-2 text-2xl text-zinc-300">→</span>}
          <button
            type="button"
            onClick={() => onSelect({ scope: "funnel", key: step.key })}
            className="flex flex-col items-start rounded-lg px-3 py-1 text-left hover:bg-zinc-100"
          >
            <span className="text-xs text-zinc-500">{step.label}</span>
            <span className="text-[32px] font-bold leading-none tabular-nums text-zinc-900">
              {run.funnel[step.key]}
            </span>
          </button>
        </Fragment>
      ))}
      <span className="ml-auto text-xs text-zinc-400">숫자를 누르면 근거 원문이 열립니다</span>
    </section>
  );
}

function RankMove({ cluster }: { cluster: PainCluster }) {
  const delta = cluster.rank_before - cluster.rank_after;
  const arrow = delta > 0 ? `▲${delta}` : delta < 0 ? `▼${-delta}` : "＝";
  const color =
    delta > 0 ? "text-emerald-700" : delta < 0 ? "text-rose-700" : "text-zinc-500";
  return (
    <span className={`shrink-0 text-xs tabular-nums ${color}`}>
      #{cluster.rank_before} → #{cluster.rank_after} {arrow}
    </span>
  );
}

function WarningTags({
  cluster,
  cfg,
  onSelect,
}: {
  cluster: PainCluster;
  cfg: ScoringConfig;
  onSelect: SelectHandler;
}) {
  const inflated = cluster.inflation >= cfg.conf_high.max_inflation;
  const singleSource = cluster.same_item_ratio >= cfg.same_item_penalty_ratio;
  if (!inflated && !singleSource) {
    return null;
  }
  return (
    <>
      {inflated && (
        <NumberButton
          className="rounded-full border border-rose-300 bg-rose-50 px-2.5 text-xs font-medium text-rose-700 no-underline"
          onSelect={() =>
            onSelect({
              scope: "cluster",
              clusterId: cluster.cluster_id,
              metric: { kind: "raw_mentions" },
            })
          }
        >
          ⚠ 인플레이션 {cluster.inflation.toFixed(1)}x
        </NumberButton>
      )}
      {singleSource && (
        <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-600">
          단일 소스 편중
        </span>
      )}
    </>
  );
}

function ExpandedDetails({
  cluster,
  onSelect,
}: {
  cluster: PainCluster;
  onSelect: SelectHandler;
}) {
  const select = (metric: ClusterMetric) =>
    onSelect({ scope: "cluster", clusterId: cluster.cluster_id, metric });

  return (
    <div className="mt-3 border-t border-zinc-200 pt-3">
      <ol className="space-y-1 text-sm leading-6 text-zinc-800">
        {cluster.ranking_reasons.map((reason, index) => (
          <li key={index} className="flex gap-2">
            <span className="w-4 shrink-0 text-zinc-400">{index + 1}</span>
            <span>{reason}</span>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
        {RUNG_ORDER.filter((type) => cluster.ladder[type] > 0).map((type) => (
          <NumberButton
            key={type}
            className={`border no-underline ${SIGNAL_STYLES[type]}`}
            onSelect={() => select({ kind: "ladder", type })}
          >
            {RUNG_LABELS[type]} {cluster.ladder[type]}
          </NumberButton>
        ))}
        <NumberButton
          className="border border-emerald-300 bg-white text-emerald-800 no-underline"
          onSelect={() => select({ kind: "supporting_evidence" })}
        >
          지지 {cluster.supporting_evidence}
        </NumberButton>
        <NumberButton
          className="border border-rose-300 bg-white text-rose-800 no-underline"
          onSelect={() => select({ kind: "counter_evidence" })}
        >
          반박 {cluster.counter_evidence}
        </NumberButton>
        {COUNTER_TYPES.filter((type) => cluster.counter[type] > 0).map((type) => (
          <NumberButton
            key={type}
            className="border border-rose-200 bg-rose-50 text-rose-700 no-underline"
            onSelect={() => select({ kind: "counter", type })}
          >
            {COUNTER_LABELS[type]} {cluster.counter[type]}
          </NumberButton>
        ))}
      </div>
    </div>
  );
}

interface ClusterCardProps {
  cluster: PainCluster;
  cfg: ScoringConfig;
  rank: number;
  highlighted: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: SelectHandler;
}

function ClusterCard({
  cluster,
  cfg,
  rank,
  highlighted,
  expanded,
  onToggle,
  onSelect,
}: ClusterCardProps) {
  const ring = highlighted
    ? "border-emerald-500 ring-2 ring-emerald-500/60"
    : "border-zinc-200";
  const selectCluster = (kind: "raw_mentions" | "independent_observations") =>
    onSelect({ scope: "cluster", clusterId: cluster.cluster_id, metric: { kind } });

  return (
    <article
      onClick={onToggle}
      data-expanded={expanded}
      className={`cursor-pointer rounded-xl border bg-white p-4 shadow-sm transition hover:shadow ${ring}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-xl font-semibold leading-tight text-zinc-900">
          <span className="mr-1 text-zinc-400">#{rank}</span>
          {cluster.title}
        </h3>
        <RankMove cluster={cluster} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-700">
        <span>
          언급{" "}
          <NumberButton onSelect={() => selectCluster("raw_mentions")}>
            {cluster.raw_mentions}
          </NumberButton>
          {" → "}관측{" "}
          <NumberButton onSelect={() => selectCluster("independent_observations")}>
            {cluster.independent_observations}
          </NumberButton>
        </span>
        <span className="text-zinc-300">·</span>
        <span>
          최고단 <b className="text-zinc-900">{RUNG_LABELS[cluster.top_rung]}</b>
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge label="Opportunity" band={cluster.opportunity} />
        <Badge label="Confidence" band={cluster.confidence} />
        <WarningTags cluster={cluster} cfg={cfg} onSelect={onSelect} />
      </div>

      <p className="mt-2 truncate text-sm text-zinc-600" title={cluster.ranking_reasons[1]}>
        {cluster.ranking_reasons[1]}
      </p>

      {expanded && <ExpandedDetails cluster={cluster} onSelect={onSelect} />}
    </article>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: RankView;
  onChange: (view: RankView) => void;
}) {
  const options: { value: RankView; label: string }[] = [
    { value: "raw", label: "언급 순위" },
    { value: "verified", label: "검증 순위" },
  ];
  return (
    <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5 text-sm">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={view === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1.5 font-medium transition ${
            view === option.value
              ? "bg-white text-zinc-900 shadow"
              : "text-zinc-500 hover:text-zinc-800"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface RankColumnProps {
  title: string;
  caption: string;
  clusters: PainCluster[];
  rankOf: (cluster: PainCluster) => number;
  cfg: ScoringConfig;
  active: boolean;
  highlightTop: boolean;
  expandedId: string | null;
  onToggle: (clusterId: string) => void;
  onSelect: SelectHandler;
}

function RankColumn({
  title,
  caption,
  clusters,
  rankOf,
  cfg,
  active,
  highlightTop,
  expandedId,
  onToggle,
  onSelect,
}: RankColumnProps) {
  return (
    <section
      className={`flex min-w-0 flex-col gap-3 transition-opacity ${
        active ? "opacity-100" : "opacity-50"
      }`}
    >
      <header className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-700">
          {title}
        </h2>
        <span className="text-xs text-zinc-500">{caption}</span>
      </header>
      {clusters.map((cluster) => (
        <ClusterCard
          key={cluster.cluster_id}
          cluster={cluster}
          cfg={cfg}
          rank={rankOf(cluster)}
          highlighted={highlightTop && rankOf(cluster) === 1}
          expanded={expandedId === cluster.cluster_id}
          onToggle={() => onToggle(cluster.cluster_id)}
          onSelect={onSelect}
        />
      ))}
    </section>
  );
}

export default function Hero({ run }: { run: ResearchRun }) {
  const [view, setView] = useState<RankView>("raw");
  const [expanded, setExpanded] = useState<{ column: RankView; id: string } | null>(null);
  const [selection, setSelection] = useState<EvidenceSelection | null>(null);

  const cfg = run.config_snapshot;
  // RAW RANK 는 rank_before(언급 많은 순), VERIFIED RANK 는 rank_after 순. 둘 다 JSON 값만 쓴다.
  const byBefore = [...run.clusters].sort((a, b) => a.rank_before - b.rank_before);
  const byAfter = [...run.clusters].sort((a, b) => a.rank_after - b.rank_after);

  const toggleExpanded = (column: RankView) => (id: string) => {
    setExpanded((current) =>
      current && current.column === column && current.id === id ? null : { column, id },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-zinc-900">{run.question}</h1>
        <ViewToggle view={view} onChange={setView} />
      </header>

      <Funnel run={run} onSelect={setSelection} />

      <div className="grid grid-cols-2 gap-6">
        <RankColumn
          title="언급 순위"
          caption="RAW RANK · 언급 많은 순"
          clusters={byBefore}
          rankOf={(cluster) => cluster.rank_before}
          cfg={cfg}
          active={view === "raw"}
          highlightTop={false}
          expandedId={expanded?.column === "raw" ? expanded.id : null}
          onToggle={toggleExpanded("raw")}
          onSelect={setSelection}
        />
        <RankColumn
          title="검증 순위"
          caption="VERIFIED RANK · 독립 관측 · 행동 신호 기준"
          clusters={byAfter}
          rankOf={(cluster) => cluster.rank_after}
          cfg={cfg}
          active={view === "verified"}
          highlightTop
          expandedId={expanded?.column === "verified" ? expanded.id : null}
          onToggle={toggleExpanded("verified")}
          onSelect={setSelection}
        />
      </div>

      <EvidenceDrawer
        run={run}
        selection={selection}
        onClose={() => setSelection(null)}
        onSelect={setSelection}
      />
    </div>
  );
}
