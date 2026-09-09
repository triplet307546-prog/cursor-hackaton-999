"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import EvidenceDrawer, { type EvidenceSelection } from "@/components/EvidenceDrawer";
import Hero from "@/components/Hero";
import Stage from "@/components/Stage";
import type { PipelineStep } from "@/lib/pipeline/run";
import type { ResearchRun } from "@/lib/types";

const POLL_INTERVAL_MS = 700;
// cached/fixture 는 실제 계산이 없어도 스테퍼를 이 시간 동안 순서대로 재생한 뒤 결과를 보여준다.
const REPLAY_TOTAL_MS = 1500;

// app/api/run/route.ts 가 쓰는 상태 파일 형태. step 은 PipelineStep 값이고 'queued' 는 시작 전 값이다.
interface RunStatus {
  step: PipelineStep | "queued";
  detail?: string;
  done: boolean;
  error?: string;
}

const STEPPER_LABELS = ["정규화", "중복 제거", "분류", "순위"] as const;

// themes 와 classify 는 화면에서 하나의 "분류" 단계로 묶는다.
const STEP_TO_STEPPER_INDEX: Record<RunStatus["step"], number> = {
  queued: -1,
  normalize: 0,
  dedup: 1,
  themes: 2,
  classify: 2,
  rank: 3,
  done: STEPPER_LABELS.length,
};

type Phase = "polling" | "replay" | "ready" | "error";

function Stepper({ activeIndex, detail }: { activeIndex: number; detail?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-6 py-6">
      <ol className="flex items-center gap-3">
        {STEPPER_LABELS.map((label, index) => {
          const state =
            index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
          const dot =
            state === "done"
              ? "bg-emerald-500 text-white"
              : state === "active"
                ? "bg-zinc-900 text-white animate-pulse"
                : "bg-zinc-200 text-zinc-500";
          const text =
            state === "pending" ? "text-zinc-400" : "text-zinc-900 font-medium";
          return (
            <li key={label} className="flex items-center gap-3">
              {index > 0 && <span className="h-px w-8 bg-zinc-300" />}
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs ${dot}`}
              >
                {state === "done" ? "✓" : index + 1}
              </span>
              <span className={`text-sm ${text}`}>{label}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 h-5 text-xs text-zinc-500">
        {detail ?? (activeIndex < 0 ? "대기 중…" : "\u00a0")}
      </p>
    </div>
  );
}

function ModeBadge({ mode }: { mode: ResearchRun["mode"] }) {
  return (
    <span className="rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600">
      {mode}
    </span>
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `요청 실패 (${response.status})`);
  }
  return (await response.json()) as T;
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const [phase, setPhase] = useState<Phase>("polling");
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  // 스테이지(순위 재계산) 다음에 흰색 상세 분석을 연다. Hero 자체는 그대로다.
  const [showDetails, setShowDetails] = useState(false);
  // 근거 드로어. 스테이지 카드의 숫자와 Hero 의 숫자가 같은 드로어를 연다.
  const [selection, setSelection] = useState<EvidenceSelection | null>(null);
  const detailsRef = useRef<HTMLDivElement>(null);

  // 700ms 간격으로 상태를 읽고, 끝나면 결과 파일을 한 번 읽는다.
  useEffect(() => {
    if (!id) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (message: string) => {
      if (cancelled) return;
      setError(message);
      setPhase("error");
    };

    const loadRun = async () => {
      const loaded = await fetchJson<ResearchRun>(`/api/runs/${id}`);
      if (cancelled) return;
      setRun(loaded);
      setReplayIndex(0);
      setShowDetails(false);
      setSelection(null);
      setPhase(loaded.mode === "live" ? "ready" : "replay");
    };

    const poll = async () => {
      try {
        const next = await fetchJson<RunStatus>(`/api/runs/${id}?status=1`);
        if (cancelled) return;
        setStatus(next);
        if (next.error) {
          fail(next.error);
          return;
        }
        if (next.done) {
          await loadRun();
          return;
        }
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (caught) {
        fail(caught instanceof Error ? caught.message : String(caught));
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [id]);

  // cached/fixture 재생: 단계를 균등 간격으로 넘기고 총 1.5초 뒤 결과를 보여준다.
  useEffect(() => {
    if (phase !== "replay") {
      return;
    }
    const stepMs = REPLAY_TOTAL_MS / STEPPER_LABELS.length;
    const interval = setInterval(() => {
      setReplayIndex((current) => Math.min(current + 1, STEPPER_LABELS.length - 1));
    }, stepMs);
    const finish = setTimeout(() => setPhase("ready"), REPLAY_TOTAL_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(finish);
    };
  }, [phase]);

  useEffect(() => {
    if (showDetails) {
      detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [showDetails]);

  const activeIndex =
    phase === "replay"
      ? replayIndex
      : STEP_TO_STEPPER_INDEX[status?.step ?? "queued"];
  const detail = phase === "replay" ? undefined : status?.detail;

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="flex flex-col gap-1.5 p-1.5">
        {/* 스테이지가 뜨면 이 줄은 접는다. "질문으로" 는 스테이지 머리에 들어 있다. */}
        {phase !== "ready" && (
          <div className="flex items-center gap-3 text-sm">
            <Link href="/" className="text-zinc-500 hover:text-zinc-900">
              ← 질문으로
            </Link>
            {run && run.mode !== "live" && <ModeBadge mode={run.mode} />}
            <span className="ml-auto font-mono text-xs text-zinc-400">{id}</span>
          </div>
        )}

        {phase === "error" && (
          <p className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            오류: {error}
          </p>
        )}

        {(phase === "polling" || phase === "replay") && (
          <Stepper activeIndex={activeIndex} detail={detail} />
        )}

        {phase === "ready" && run && (
          <>
            <Stage
              run={run}
              onOpenDetails={() => setShowDetails(true)}
              onSelect={setSelection}
            />
            {showDetails && (
              <div ref={detailsRef} className="scroll-mt-2 rounded-xl bg-zinc-50 p-4 text-zinc-900">
                <Hero run={run} onSelect={setSelection} />
              </div>
            )}
            <EvidenceDrawer
              run={run}
              selection={selection}
              onClose={() => setSelection(null)}
              onSelect={setSelection}
            />
          </>
        )}
      </div>
    </main>
  );
}
