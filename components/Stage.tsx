"use client";

import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";

import { RUNG_ORDER, baseOpportunityBand } from "@/lib/pipeline/score";
import type { Band, PainCluster, ResearchRun, SignalType } from "@/lib/types";
import { RUNG_LABELS, type ClusterMetric, type EvidenceSelection } from "./EvidenceDrawer";
import s from "./Stage.module.css";

// 질문 화면과 흰색 분석 화면 사이에 끼는 "순위 재계산" 장면.
// 0 언급 → 1 에코 제거 → 2 행동 가중 → 3 반박 하향 → 4 재배열. 숫자는 전부 run JSON 값이고 여기서는 새로 세지 않는다.

type Step = 0 | 1 | 2 | 3 | 4;
const STEPS: Step[] = [0, 1, 2, 3, 4];
const STEP_LABELS = ["언급", "에코 제거", "행동 가중", "반박 하향", "재배열"];
// 자동 재생에서 각 단계가 머무는 시간. 0단계는 짧게, 나머지는 캡션을 읽을 만큼.
const STEP_HOLD_MS = [1200, 2000, 2000, 2000];
const FLIP_MS = 750;

const RUNG_COLORS: Record<SignalType, string> = {
  complaint: "#8b929c",
  workaround: "#4ea6ea",
  alternative_search: "#9e82f0",
  switching: "#f2913e",
  payment: "#159e66",
};
const BEHAVIOR_RUNGS = RUNG_ORDER.filter((type) => type !== "complaint");
// 등장 뒤 자동 재생까지 기다리는 시간. ?step= 이 있으면 자동 재생하지 않는다.
const AUTOPLAY_DELAY_MS = 1000;

function stepParam(): Step | null {
  if (typeof window === "undefined") return null;
  const param = new URLSearchParams(window.location.search).get("step");
  if (param === null) return null; // Number(null) 은 0 이라 먼저 걸러야 한다
  const raw = Number(param);
  return STEPS.includes(raw as Step) ? (raw as Step) : null;
}

interface Row {
  c: PainCluster;
  ratio: number; // 반박 / 독립 관측
  downgraded: boolean;
  bandBefore: Band; // 반박 하향 적용 전 밴드 (score.ts 의 같은 규칙으로 되짚는다)
  recognizedRungs: number; // min_rung_obs 를 넘긴 행동 단 수
}

function buildRows(run: ResearchRun): Row[] {
  const cfg = run.config_snapshot;
  return [...run.clusters]
    .sort((a, b) => a.rank_before - b.rank_before)
    .map((c) => {
      const ratio =
        c.independent_observations > 0 ? c.counter_evidence / c.independent_observations : 0;
      return {
        c,
        ratio,
        downgraded: ratio >= cfg.counter_downgrade_ratio,
        bandBefore: baseOpportunityBand(c, cfg),
        recognizedRungs: BEHAVIOR_RUNGS.filter((type) => c.ladder[type] >= cfg.min_rung_obs)
          .length,
      };
    });
}

const pct = (ratio: number) => Math.round(ratio * 100);

// 단계 캡션. 문장의 숫자는 rows 에서 읽고, 데이터가 조용하면(인플레이션 없음, 하향 없음, 순위 일치) 그렇다고 말한다.
function captions(run: ResearchRun, rows: Row[]): [string, string][] {
  const threshold = pct(run.config_snapshot.counter_downgrade_ratio);
  const mostInflated = [...rows].sort((a, b) => b.c.inflation - a.c.inflation)[0];
  const downgraded = rows.filter((row) => row.downgraded);
  const moved = rows.filter((row) => row.c.rank_before !== row.c.rank_after);
  const riser = [...rows].sort(
    (a, b) => b.c.rank_before - b.c.rank_after - (a.c.rank_before - a.c.rank_after),
  )[0];
  const faller = [...rows].sort(
    (a, b) => b.c.rank_after - b.c.rank_before - (a.c.rank_after - a.c.rank_before),
  )[0];

  const echo: [string, string] =
    mostInflated && mostInflated.c.inflation >= 1.5
      ? [
          `에코 제거. ${mostInflated.c.title} ${mostInflated.c.raw_mentions} → ${mostInflated.c.independent_observations}, 인플레이션 ×${mostInflated.c.inflation.toFixed(1)}.`,
          "완전 동일 · 어미 변형 · 스레드 답글을 대표 1건으로 묶었습니다. 같은 말은 한 번만 셉니다.",
        ]
      : [
          "에코 제거. 이번 수집은 같은 말 반복이 거의 없었습니다.",
          `언급 ${run.funnel.raw_mentions} → 독립 관측 ${run.funnel.independent_observations}. 걸러진 건 같은 말이 아니라 내용 없는 말이었습니다.`,
        ];

  const counter: [string, string] =
    downgraded.length > 0
      ? [
          `반박 하향. ${downgraded.map((row) => `${row.c.title} ${pct(row.ratio)}%`).join(", ")} ≥ ${threshold}%.`,
          `"이미 해결됨 / 대안으로 충분 / 경험 없음"이 독립 관측의 ${threshold}%를 넘으면 Opportunity를 한 단계 내립니다.`,
        ]
      : [
          `반박 하향. 이번엔 ${threshold}%를 넘은 주제가 없습니다.`,
          "반박 근거는 따로 셌지만 하향된 주제는 없습니다. 기준은 고정값입니다.",
        ];

  const final: [string, string] =
    moved.length === 0
      ? [
          "검증 순위. 언급 순위와 행동 순위가 일치합니다.",
          "시끄러운 문제가 실제 행동 문제였습니다. 뒤집는 게 목적이 아니라 순위에 근거를 붙이는 게 목적입니다.",
        ]
      : [
          `검증 순위. ${riser.c.title}: 언급 ${riser.c.rank_before}위 → 기회 ${riser.c.rank_after}위.`,
          `${faller.c.title}: 언급 ${faller.c.rank_before}위 → ${faller.c.rank_after}위. 뒤집힘 ${moved.length}건. 시끄러운 것과 사람들이 움직인 것은 다른 문제였습니다.`,
        ];

  return [
    ["언급 순위. 크롤링 도구가 보여주는 화면입니다.", "많이 말한 순서. 점선 막대가 호가창에 쌓인 주문입니다."],
    echo,
    [
      "행동 가중. 불만은 맨 아랫단, 순위에 안 셉니다.",
      `우회 → 대안 탐색 → 이탈 → 결제만 남깁니다. 행동 신호 ${run.funnel.behavior_signals}건. 색이 있는 부분이 실제로 움직인 사람입니다.`,
    ],
    counter,
    final,
  ];
}

// ---------- 숫자 롤링 ----------

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeReduced(onChange: () => void) {
  const query = window.matchMedia(REDUCED_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

function Num({ value, ms = 700 }: { value: number; ms?: number }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    const from = fromRef.current;
    if (reduced || from === value) {
      fromRef.current = value;
      setShown(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.max(0, Math.min(1, (now - start) / ms));
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(from + (value - from) * eased));
      if (p < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, ms, reduced]);
  return <>{shown}</>;
}

// 카드 안의 숫자 버튼. 카드 펼침(onClick)과 분리되어야 하므로 전파를 막는다. Hero 의 NumberButton 과 같은 규칙.
function NumBtn({
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
    <button type="button" className={`${s.numBtn} ${className}`} onClick={handleClick}>
      {children}
    </button>
  );
}

// ---------- 카드 ----------

function Card({
  row,
  step,
  max,
  threshold,
  open,
  onToggle,
  onSelect,
}: {
  row: Row;
  step: Step;
  max: number;
  threshold: number;
  open: boolean;
  onToggle: () => void;
  onSelect: (selection: EvidenceSelection) => void;
}) {
  const { c } = row;
  const select = (metric: ClusterMetric) =>
    onSelect({ scope: "cluster", clusterId: c.cluster_id, metric });
  const delta = c.rank_before - c.rank_after;
  const rawPct = (c.raw_mentions / max) * 100;
  const indPct = (c.independent_observations / max) * 100;
  const band = step >= 3 ? c.opportunity : row.bandBefore;
  const bandChanged = step >= 3 && row.downgraded;

  let big: number;
  let bigMetric: ClusterMetric;
  let strike: ReactNode = null;
  let sub: string;
  if (step === 0) {
    big = c.raw_mentions;
    bigMetric = { kind: "raw_mentions" };
    sub = "언급";
  } else if (step === 1) {
    big = c.independent_observations;
    bigMetric = { kind: "independent_observations" };
    strike = <s>{c.raw_mentions}</s>;
    sub = "독립 관측";
  } else {
    big = c.supporting_evidence;
    bigMetric = { kind: "supporting_evidence" };
    sub = `행동 신호 (${row.recognizedRungs}단 인정)`;
  }

  const classes = [
    s.card,
    step === 4 && c.rank_after === 1 ? s.hot : "",
    step >= 3 && row.downgraded ? s.cold : "",
    open ? s.open : "",
  ].join(" ");

  return (
    <li
      data-id={c.cluster_id}
      className={classes}
      style={{ order: step === 4 ? c.rank_after : c.rank_before }}
      onClick={() => step === 4 && onToggle()}
    >
      <div className={s.rank}>
        <div className={s.rankNum}>
          <span className={s.old}>{c.rank_before}</span>
          <span className={s.new}>{c.rank_after}</span>
        </div>
        <span className={`${s.delta} ${delta > 0 ? s.up : delta < 0 ? s.down : s.same}`}>
          {delta > 0 ? `▲${delta}` : delta < 0 ? `▼${-delta}` : "＝"}
        </span>
      </div>

      <div className={s.main}>
        <div className={s.row1}>
          <span className={s.title} title={c.title}>
            {c.title}
          </span>
          <span className={`${s.chip} ${s.infl} ${step >= 1 && c.inflation >= 3 ? s.show : ""}`}>
            ×{c.inflation.toFixed(1)} 인플레이션
          </span>
          <NumBtn
            className={`${s.chip} ${s.ctr} ${step >= 3 && row.downgraded ? s.show : ""}`}
            onSelect={() => select({ kind: "counter_evidence" })}
          >
            반박 {pct(row.ratio)}% ▼ 하향
          </NumBtn>
          <span
            key={band}
            className={`${s.band} ${s[band]} ${step >= 2 ? s.show : ""} ${bandChanged ? s.stamp : ""}`}
          >
            {band}
          </span>
        </div>

        <div
          className={s.track}
          style={{ "--raw": `${rawPct}%`, "--ind": `${indPct}%` } as React.CSSProperties}
        >
          <div className={s.barRaw} />
          <div className={s.echo} />
          <div className={s.barInd}>
            {RUNG_ORDER.map((type) => (
              <span
                key={type}
                className={`${s.segm} ${type === "complaint" ? s.complaint : ""}`}
                style={{ "--n": c.ladder[type], "--c": RUNG_COLORS[type] } as React.CSSProperties}
              />
            ))}
          </div>
        </div>

        <div
          className={s.meter}
          style={{ "--ctr": `${pct(row.ratio)}%`, "--th": `${threshold}%` } as React.CSSProperties}
        >
          <div className={s.meterBg} />
          <div className={s.meterFg} />
          <div className={s.meterTh} data-label={`${threshold}%`} />
          <NumBtn className={s.meterLab} onSelect={() => select({ kind: "counter_evidence" })}>
            {pct(row.ratio)}%
          </NumBtn>
        </div>
      </div>

      <div className={s.nums}>
        <div className={s.big}>
          {strike}
          <NumBtn onSelect={() => select(bigMetric)}>
            <Num value={big} />
          </NumBtn>
        </div>
        <div className={s.sub}>{sub}</div>
        <div className={s.lad}>
          {BEHAVIOR_RUNGS.filter((type) => c.ladder[type] > 0).map((type) => (
            <NumBtn key={type} onSelect={() => select({ kind: "ladder", type })}>
              <i style={{ "--c": RUNG_COLORS[type] } as React.CSSProperties}>
                {RUNG_LABELS[type]} {c.ladder[type]}
              </i>
            </NumBtn>
          ))}
        </div>
      </div>

      <div className={s.reasons}>
        <ol>
          {c.ranking_reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ol>
      </div>
    </li>
  );
}

// ---------- 슬로프 차트 ----------

function Slope({
  rows,
  slotY,
  height,
  progress,
}: {
  rows: Row[];
  slotY: number[];
  height: number;
  progress: number; // 0 = 언급 순위 그대로, 1 = 검증 순위로 이동 완료
}) {
  if (slotY.length === 0 || height === 0) {
    return <svg viewBox="0 0 240 10" />;
  }
  const yAt = (rank: number) => {
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    const yLo = slotY[lo] ?? 0;
    const yHi = slotY[hi] ?? yLo;
    return yLo + (yHi - yLo) * (rank - lo);
  };
  return (
    <svg viewBox={`0 0 240 ${height}`} style={{ height }}>
      {rows.map((row) => {
        const { c } = row;
        const y0 = yAt(c.rank_before);
        const y1 = yAt(c.rank_before + (c.rank_after - c.rank_before) * progress);
        const moved = c.rank_before !== c.rank_after;
        const color =
          c.rank_after === 1
            ? "#159e66"
            : row.downgraded
              ? "#e0405c"
              : moved
                ? "rgba(23,25,29,.6)"
                : "rgba(107,114,128,.35)";
        const width = moved ? (c.rank_after === 1 ? 3 : 2) : 1.2;
        return (
          <g key={c.cluster_id}>
            <path
              d={`M14 ${y0} C 105 ${y0}, 135 ${y1}, 226 ${y1}`}
              stroke={color}
              strokeWidth={width}
            />
            <circle cx={14} cy={y0} r={3} fill={color} />
            <circle cx={226} cy={y1} r={3} fill={color} />
            <text x={0} y={y0 + 3.5}>
              {c.rank_before}
            </text>
            <text x={233} y={y1 + 3.5}>
              {progress > 0.5 ? c.rank_after : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------- 스테이지 ----------

export default function Stage({
  run,
  onOpenDetails,
  onSelect,
}: {
  run: ResearchRun;
  onOpenDetails: () => void;
  onSelect: (selection: EvidenceSelection) => void;
}) {
  const rows = buildRows(run);
  const max = Math.max(1, ...rows.map((row) => row.c.raw_mentions));
  const threshold = pct(run.config_snapshot.counter_downgrade_ratio);
  const caps = captions(run, rows);
  const reduced = useReducedMotion();

  // ?step=N 으로 특정 단계에서 시작한다 (발표 리허설용). 스테이지는 데이터 로드 뒤 클라이언트에서만 마운트되므로 location 을 읽어도 된다.
  const [step, setStep] = useState<Step>(() => stepParam() ?? 0);
  const [playing, setPlaying] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [slotY, setSlotY] = useState<number[]>([]);
  const [listHeight, setListHeight] = useState(0);

  const listRef = useRef<HTMLOListElement>(null);
  const topsRef = useRef<Map<string, number>>(new Map());
  const timersRef = useRef<number[]>([]);

  // 순위 슬롯(1..n)의 세로 중심. 4단계에서는 카드가 rank_after 자리에 있으므로 그 키로 읽는다. 슬로프 차트가 이 좌표에 선을 긋는다.
  const measure = () => {
    const list = listRef.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    const ys: number[] = [];
    list.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
      const row = rows.find((r) => r.c.cluster_id === el.dataset.id);
      if (!row) return;
      const rect = el.getBoundingClientRect();
      const slot = step === 4 ? row.c.rank_after : row.c.rank_before;
      ys[slot] = rect.top - top + rect.height / 2;
    });
    setSlotY(ys);
    setListHeight(list.getBoundingClientRect().height);
  };

  useLayoutEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, openId, run.run_id]);

  // FLIP: order 가 바뀌어 카드가 점프한 만큼 되돌린 뒤 제자리로 미끄러지게 한다. DOM 순서는 그대로다.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const prev = topsRef.current;
    const next = new Map<string, number>();
    list.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
      const id = el.dataset.id ?? "";
      const top = el.getBoundingClientRect().top;
      next.set(id, top);
      const before = prev.get(id);
      if (before !== undefined && before !== top && !reduced) {
        el.animate(
          [{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }],
          { duration: FLIP_MS, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
      }
    });
    topsRef.current = next;
  }, [step, reduced]);

  // 슬로프 선을 언급 → 검증 위치로 보간한다.
  useEffect(() => {
    const target = step === 4 ? 1 : 0;
    let frame = 0;
    const from = progress;
    const start = performance.now();
    const tick = (now: number) => {
      const p = reduced ? 1 : Math.max(0, Math.min(1, (now - start) / FLIP_MS));
      const eased = 1 - Math.pow(1 - p, 3);
      setProgress(from + (target - from) * eased);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, reduced]);

  const clearTimers = () => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  };
  useEffect(() => clearTimers, []);

  const go = (next: Step) => {
    setStep(next);
    if (next < 4) setOpenId(null);
  };

  // 단계별 자동 재생. "검증 순위" 토글 한 번이 이 시퀀스다.
  const play = (from: Step) => {
    if (playing) return;
    setPlaying(true);
    clearTimers();
    let at = 0;
    for (let i = from; i <= 4; i += 1) {
      const target = i as Step;
      timersRef.current.push(
        window.setTimeout(() => {
          go(target);
          if (target === 4) setPlaying(false);
        }, at),
      );
      at += STEP_HOLD_MS[i] ?? 0;
    }
  };

  // 마운트 1초 뒤 1단계부터 자동 재생. ?step= 으로 들어왔으면 그 단계에 멈춰 둔다.
  useEffect(() => {
    if (stepParam() !== null) return;
    const id = window.setTimeout(() => play(1), AUTOPLAY_DELAY_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onToggleView = (view: "raw" | "verified") => {
    if (playing) return;
    if (view === "raw") {
      go(0);
    } else if (step === 0) {
      play(1);
    } else {
      go(4);
    }
  };

  return (
    <section className={s.stage} data-step={step} aria-label="순위 재계산">
      <div className={s.head}>
        <span className={s.kicker}>rank recount</span>
        <Link href="/" className={s.ghost}>
          ← 질문으로
        </Link>
        <div className={`${s.seg} ${step === 4 ? s.right : ""}`}>
          <span className={s.thumb} />
          <button
            type="button"
            className={step !== 4 ? s.on : ""}
            aria-pressed={step !== 4}
            onClick={() => onToggleView("raw")}
          >
            언급 순위
          </button>
          <button
            type="button"
            className={step === 4 ? s.on : ""}
            aria-pressed={step === 4}
            onClick={() => onToggleView("verified")}
          >
            검증 순위
          </button>
        </div>
        <button
          type="button"
          className={s.ghost}
          disabled={playing}
          onClick={() => {
            go(0);
            timersRef.current.push(window.setTimeout(() => play(1), 300));
          }}
        >
          ▶ 단계별 재생
        </button>
        <div className={s.steps}>
          {STEPS.map((value) => (
            <button
              key={value}
              type="button"
              className={value === step ? s.now : value < step ? s.done : ""}
              disabled={playing}
              onClick={() => go(value)}
            >
              {value} {STEP_LABELS[value]}
            </button>
          ))}
        </div>
        <button type="button" className={`${s.ghost} ${s.cta}`} onClick={onOpenDetails}>
          근거와 원문 보기 ↓
        </button>
      </div>

      <div className={s.caption} aria-live="polite">
        <div key={step} className={s.swap}>
          {caps[step][0]}
          <small>{caps[step][1]}</small>
        </div>
      </div>

      <div className={s.body}>
        <div>
          <div className={s.legend}>
            <span>
              <i className={s.hollow} />
              언급 (호가)
            </span>
            <span>
              <i className={s.ind} />
              독립 관측
            </span>
            {RUNG_ORDER.map((type) => (
              <span key={type} className={s.lad}>
                <i className={s.sw} style={{ background: RUNG_COLORS[type] }} />
                {RUNG_LABELS[type]}
              </span>
            ))}
          </div>
          <ol ref={listRef} className={s.cards}>
            {rows.map((row) => (
              <Card
                key={row.c.cluster_id}
                row={row}
                step={step}
                max={max}
                threshold={threshold}
                open={openId === row.c.cluster_id}
                onToggle={() =>
                  setOpenId((current) => (current === row.c.cluster_id ? null : row.c.cluster_id))
                }
                onSelect={onSelect}
              />
            ))}
          </ol>
          <p className={s.hint}>
            {step === 4
              ? "카드를 누르면 코드가 쓴 순위 이유가 펼쳐집니다. 숫자를 누르면 그 숫자의 근거 원문이 열립니다."
              : "검증 순위를 누르면 네 단계가 차례로 재생됩니다."}
          </p>
        </div>
        <aside className={s.slope} aria-hidden="true">
          <div className={s.axes}>
            <span>언급 순위</span>
            <span>검증 순위</span>
          </div>
          <Slope rows={rows} slotY={slotY} height={listHeight} progress={progress} />
          <p className={s.note}>선이 교차하는 만큼 시끄러운 것과 움직인 것이 다릅니다.</p>
        </aside>
      </div>
    </section>
  );
}
