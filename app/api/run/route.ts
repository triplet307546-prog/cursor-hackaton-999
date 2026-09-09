import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { after, NextResponse } from "next/server";

import { runPipeline, type PipelineStep } from "@/lib/pipeline/run";
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
}

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
  const { question, slug } = body as { question?: unknown; slug?: unknown };
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
  return { question: trimmed, slug: slug as RunRequest["slug"] };
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

async function executeRun(id: string, request: RunRequest): Promise<void> {
  try {
    const now = new Date();
    const cachedPath = findCachedPath(request.slug);
    if (cachedPath !== null) {
      await copyCachedRun(id, request.question, cachedPath, now);
    } else {
      await runFixture(id, request.question);
    }
    writeStatus(id, { step: "done", detail: id, done: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStatus(id, { step: "done", done: true, error: message });
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
      { error: "question(문자열)과 선택적 slug([A-Za-z0-9_-])가 필요합니다." },
      { status: 400 },
    );
  }

  const id = createRunId(new Date());
  writeStatus(id, { step: "queued", done: false });

  after(async () => {
    await executeRun(id, parsed);
  });

  return NextResponse.json({ run_id: id });
}
