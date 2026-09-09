import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { after, NextResponse } from "next/server";

import { runPipeline, type PipelineStep } from "@/lib/pipeline/run";
import { collectEvidence, redact } from "@/lib/sources/youtube";
import type {
  Evidence,
  ResearchRun,
  ScoringConfig,
  SourceStatus,
} from "@/lib/types";

export const runtime = "nodejs";

const RUNS_DIR = join(process.cwd(), "data", "runs");
const CONFIG_PATH = join(process.cwd(), "config", "scoring.json");
const FIXTURE_PATH = join(process.cwd(), "data", "fixtures", "demo.json");
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;
const MAX_QUESTION_LENGTH = 300;

interface RunRequest {
  question: string;
  slug?: "q1" | "q2" | "q3";
  // YouTube 검색어. 질문 문장은 검색어로 나쁘므로 따로 받는다(config/questions.json 의 label/query 와 같은 구분).
  query?: string;
}

// LLM 호출 간격(6초)이 프로세스 전역 변수라 라이브 실행이 겹치면 병렬 호출이 된다. 한 번에 하나만 돈다.
let liveRunning = false;

// 화면 스테퍼가 읽는 상태 파일. step 은 PipelineStep 값이고 'queued' 는 시작 전 한 번만 쓴다.
interface RunStatus {
  step: PipelineStep | "queued";
  detail?: string;
  done: boolean;
  error?: string;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function createRunId(now: Date): string {
  const date = `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`;
  const time = `${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;
  return `run_${date}_${time}_${randomUUID().slice(0, 8)}`;
}

function runPath(id: string): string {
  return join(RUNS_DIR, `${id}.json`);
}

function statusPath(id: string): string {
  return join(RUNS_DIR, `${id}.status.json`);
}

// 상태 파일은 아주 작고 순서가 중요해서(진행 단계가 뒤바뀌면 안 됨) 동기 쓰기로 고정한다.
function writeStatus(id: string, status: RunStatus): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(statusPath(id), `${JSON.stringify(status)}\n`, "utf8");
}

function writeRun(id: string, run: ResearchRun): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(runPath(id), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function parseRequest(body: unknown): RunRequest | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const { question, slug, query } = body as {
    question?: unknown;
    slug?: unknown;
    query?: unknown;
  };
  if (typeof question !== "string") {
    return null;
  }
  const trimmed = question.trim();
  if (trimmed === "" || trimmed.length > MAX_QUESTION_LENGTH) {
    return null;
  }
  if (slug !== undefined && (typeof slug !== "string" || !SLUG_PATTERN.test(slug))) {
    return null;
  }
  // slug 는 캐시 경로라 query 가 조용히 무시된다. 둘 다 오면 잘못된 호출이므로 거절한다.
  if (slug !== undefined && query !== undefined) {
    return null;
  }
  // 검색어는 그대로 API URL 의 q 로 나가므로 질문과 같은 기준으로 검사한다.
  if (
    query !== undefined &&
    (typeof query !== "string" ||
      query.trim() === "" ||
      query.trim().length > MAX_QUESTION_LENGTH)
  ) {
    return null;
  }
  return {
    question: trimmed,
    slug: slug as RunRequest["slug"],
    query: typeof query === "string" ? query.trim() : undefined,
  };
}

// slug 별 캐시 → 공용 캐시 순으로 찾는다. 둘 다 없으면 null (fixture 로 돈다).
function findCachedPath(slug: string | undefined): string | null {
  if (slug !== undefined) {
    const bySlug = join(RUNS_DIR, `demo_cached_${slug}.json`);
    if (existsSync(bySlug)) {
      return bySlug;
    }
  }
  const shared = join(RUNS_DIR, "demo_cached.json");
  return existsSync(shared) ? shared : null;
}

async function copyCachedRun(
  id: string,
  question: string,
  cachedPath: string,
  now: Date,
): Promise<void> {
  const cached = await readJson<ResearchRun>(cachedPath);
  const copied: ResearchRun = {
    ...cached,
    run_id: id,
    question,
    mode: "cached",
    created_at: now.toISOString(),
  };
  writeRun(id, copied);
}

function sourcesFromEvidence(evidence: Evidence[]): SourceStatus[] {
  const byGroup = new Map<string, SourceStatus>();
  for (const item of evidence) {
    const existing = byGroup.get(item.source_group);
    if (existing) {
      existing.fetched += 1;
      continue;
    }
    byGroup.set(item.source_group, {
      source_group: item.source_group,
      label: item.source,
      policy: item.access_policy,
      fetched: 1,
    });
  }
  return [...byGroup.values()];
}

async function runFixture(id: string, question: string): Promise<void> {
  const cfg = await readJson<ScoringConfig>(CONFIG_PATH);
  const evidence = await readJson<Evidence[]>(FIXTURE_PATH);

  const run = await runPipeline(
    {
      question,
      evidence,
      sources: sourcesFromEvidence(evidence),
      mode: "fixture",
      run_id: id,
    },
    cfg,
    (step, detail) => {
      // done 은 결과 파일이 실제로 저장된 뒤에만 true 로 쓴다. 안 그러면 화면이 빈 결과를 읽을 수 있다.
      writeStatus(id, { step, detail, done: false });
    },
  );

  writeRun(id, run);
}

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// slug 가 붙은 시연 질문 3개는 캐시 그대로다. 라이브는 직접 입력(slug 없음) + 키가 있을 때만.
function wantsLive(request: RunRequest): boolean {
  return request.slug === undefined && Boolean(process.env.YOUTUBE_API_KEY);
}

async function runLive(id: string, request: RunRequest): Promise<void> {
  const cfg = await readJson<ScoringConfig>(CONFIG_PATH);
  const query = request.query ?? request.question;

  writeStatus(id, { step: "queued", detail: `YouTube 검색: ${query}`, done: false });
  const evidence = await collectEvidence(
    query,
    {
      // 기본값은 fetch:youtube CLI 와 같다. 줄여서 돌리려면 LIVE_* 환경변수로 덮는다.
      videos: positiveEnv("LIVE_VIDEOS", 6),
      perVideo: positiveEnv("LIVE_PER_VIDEO", 40),
      maxTotal: positiveEnv("LIVE_MAX_TOTAL", 400),
    },
    (done, total) => {
      writeStatus(id, {
        step: "queued",
        detail: `댓글 수집 ${done}/${total}편`,
        done: false,
      });
    },
  );

  if (evidence.length === 0) {
    throw new Error(`"${query}" 로 모은 댓글이 0건입니다. 검색어를 바꿔 보세요.`);
  }

  const run = await runPipeline(
    {
      question: request.question,
      evidence,
      sources: sourcesFromEvidence(evidence),
      mode: "live",
      run_id: id,
    },
    cfg,
    (step, detail) => {
      writeStatus(id, { step, detail, done: false });
    },
  );

  writeRun(id, run);
}

async function executeRun(id: string, request: RunRequest, live: boolean): Promise<void> {
  try {
    if (live) {
      await runLive(id, request);
    } else {
      const now = new Date();
      const cachedPath = findCachedPath(request.slug);
      if (cachedPath !== null) {
        await copyCachedRun(id, request.question, cachedPath, now);
      } else {
        await runFixture(id, request.question);
      }
    }
    writeStatus(id, { step: "done", detail: id, done: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 오류 메시지에 API 키가 섞여 화면·파일로 나가지 않게 가린다.
    writeStatus(id, { step: "done", done: true, error: redact(message) });
  } finally {
    if (live) {
      liveRunning = false;
    }
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 });
  }

  const parsed = parseRequest(body);
  if (parsed === null) {
    return NextResponse.json(
      { error: "question(문자열)과 slug([A-Za-z0-9_-]) 또는 query 중 하나만 보낼 수 있습니다." },
      { status: 400 },
    );
  }

  const live = wantsLive(parsed);
  if (live && liveRunning) {
    return NextResponse.json(
      { error: "라이브 수집이 이미 돌고 있습니다. 끝난 뒤에 다시 실행해 주세요." },
      { status: 409 },
    );
  }
  const id = createRunId(new Date());
  writeStatus(id, { step: "queued", done: false });
  // after() 는 응답 뒤에 돌므로 플래그는 동기로 세운다. 위 준비 단계가 예외를 내도 플래그가 남지 않게 after() 직전이다.
  liveRunning = liveRunning || live;

  after(async () => {
    await executeRun(id, parsed, live);
  });

  return NextResponse.json({ run_id: id });
}
