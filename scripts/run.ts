import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dedup } from "../lib/pipeline/dedup";
import { applyNormalize } from "../lib/pipeline/normalize";
import { runPipeline, type PipelineStep } from "../lib/pipeline/run";
import type {
  Evidence,
  PainCluster,
  ResearchRun,
  ScoringConfig,
  SourceStatus,
} from "../lib/types";

const DEFAULT_QUESTION = "네이버 스마트스토어 셀러들이 반복적으로 겪는 운영 문제는?";
const DEFAULT_MAX_EVIDENCE = 600;
const LLM_CALL_WARNING_THRESHOLD = 40;
const CONFIG_PATH = "config/scoring.json";
const FIXTURE_PATH = "data/fixtures/demo.json";
const RAW_DIR = "data/raw";
const RUNS_DIR = "data/runs";
const RAW_FILE_PATTERN = /^(youtube|naver)_.*\.json$/u;

const USAGE = `사용법:
  npm run run:fixture                       fixture 실행 (mock 강제) → data/runs/fixture.json
  npm run run:cached -- <path>              저장된 ResearchRun 을 읽어 표만 출력
  npm run run:raw -- [path...]              raw JSON(Evidence[]) 합쳐 실행 → data/runs/live_<YYYYMMDD_HHmm>.json
옵션:
  --question "<텍스트>"   질문 (기본: ${DEFAULT_QUESTION})
  --max-evidence <n>      raw 실행 시 evidence 상한 (기본: ${DEFAULT_MAX_EVIDENCE})`;

type Command = "fixture" | "cached" | "raw";

export interface CliOptions {
  command: Command | null;
  cachedPath: string | null;
  rawPaths: string[];
  maxEvidence: number;
  question: string;
}

export interface RawFile {
  path: string;
  evidence: Evidence[];
}

export interface MergeResult {
  evidence: Evidence[];
  input: number;
  unique: number;
}

// ---------- 인자 파싱 ----------

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} 뒤에 값이 필요합니다.`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: null,
    cachedPath: null,
    rawPaths: [],
    maxEvidence: DEFAULT_MAX_EVIDENCE,
    question: DEFAULT_QUESTION,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture") {
      options.command = "fixture";
    } else if (arg === "--cached") {
      options.command = "cached";
      options.cachedPath = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--raw") {
      options.command = "raw";
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        options.rawPaths.push(argv[index + 1]);
        index += 1;
      }
    } else if (arg === "--question") {
      options.question = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--max-evidence") {
      const parsed = Number.parseInt(requireValue(argv, index, arg), 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--max-evidence 는 1 이상의 정수여야 합니다.");
      }
      options.maxEvidence = parsed;
      index += 1;
    } else {
      throw new Error(`알 수 없는 인자: ${arg}`);
    }
  }

  return options;
}

// ---------- 파일 입출력 ----------

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadConfig(): ScoringConfig {
  return readJson<ScoringConfig>(CONFIG_PATH);
}

function readEvidenceFile(path: string): Evidence[] {
  const parsed = readJson<unknown>(path);
  if (Array.isArray(parsed)) {
    return parsed as Evidence[];
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { evidence?: unknown }).evidence)
  ) {
    return (parsed as { evidence: Evidence[] }).evidence;
  }
  throw new Error(`${path} 는 Evidence[] 형식이 아닙니다.`);
}

function saveRun(run: ResearchRun, path: string): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

function discoverRawPaths(): string[] {
  if (!existsSync(RAW_DIR)) {
    return [];
  }
  return readdirSync(RAW_DIR)
    .filter((name) => RAW_FILE_PATTERN.test(name))
    .sort()
    .map((name) => join(RAW_DIR, name));
}

// ---------- 순수 함수 (테스트 대상) ----------

export function mergeRawEvidence(files: RawFile[]): MergeResult {
  const firstSeen = new Map<string, { item: Evidence; path: string }>();
  const merged: Evidence[] = [];
  let input = 0;

  for (const file of files) {
    for (const item of file.evidence) {
      input += 1;
      const seen = firstSeen.get(item.evidence_id);
      if (seen === undefined) {
        firstSeen.set(item.evidence_id, { item, path: file.path });
        merged.push(item);
        continue;
      }
      // 같은 ID 인데 본문이 다르면 수집 단계 오류이므로 조용히 넘기지 않는다.
      if (seen.item.text_raw !== item.text_raw) {
        throw new Error(
          `evidence_id ${item.evidence_id} 의 text_raw 가 ${seen.path} 와 ${file.path} 에서 다릅니다.`,
        );
      }
    }
  }

  return { evidence: merged, input, unique: merged.length };
}

function comparePublishedDesc(first: string | null, second: string | null): number {
  if (first === second) return 0;
  if (first === null) return 1;
  if (second === null) return -1;
  return second.localeCompare(first);
}

function compareForCap(first: Evidence, second: Evidence): number {
  const likesDiff = (second.engagement.likes ?? 0) - (first.engagement.likes ?? 0);
  if (likesDiff !== 0) return likesDiff;
  const publishedDiff = comparePublishedDesc(first.published_at, second.published_at);
  if (publishedDiff !== 0) return publishedDiff;
  return first.evidence_id.localeCompare(second.evidence_id);
}

export function capEvidence(evidence: Evidence[], maxEvidence: number): Evidence[] {
  if (evidence.length <= maxEvidence) {
    return [...evidence];
  }
  return [...evidence].sort(compareForCap).slice(0, maxEvidence);
}

export function estimateLlmCalls(representativeCount: number, batchSize: number): number {
  return Math.ceil(representativeCount / batchSize) + 1;
}

function countRepresentatives(evidence: Evidence[], cfg: ScoringConfig): number {
  return dedup(applyNormalize(evidence), cfg).length;
}

// ---------- sources ----------

function inferSourceGroup(path: string, evidence: Evidence[]): SourceStatus["source_group"] {
  if (evidence.length > 0) {
    return evidence[0].source_group;
  }
  return basename(path).startsWith("naver_") ? "naver_blog" : "youtube";
}

function sourceFromFile(path: string, evidence: Evidence[]): SourceStatus {
  return {
    source_group: inferSourceGroup(path, evidence),
    label: basename(path),
    policy: evidence[0]?.access_policy ?? "official_api",
    fetched: evidence.length,
    note: path,
  };
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

// ---------- 표 출력 ----------

const WIDE_CHARACTER_PATTERN =
  /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

function displayWidth(text: string): number {
  // 한글·한자는 터미널에서 두 칸을 차지하므로 길이 대신 표시 폭으로 맞춘다.
  let width = 0;
  for (const character of text) {
    width += WIDE_CHARACTER_PATTERN.test(character) ? 2 : 1;
  }
  return width;
}

function padDisplay(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function funnelLine(run: ResearchRun): string {
  const funnel = run.funnel;
  return (
    `언급 ${funnel.raw_mentions} → 독립 관측 ${funnel.independent_observations}` +
    ` → 행동 신호 ${funnel.behavior_signals} → 기회 ${funnel.opportunities}` +
    `   (LLM: ${run.llm.mode}, dropped quotes: ${run.llm.dropped_quotes})`
  );
}

function verifiedTail(cluster: PainCluster, maxInflation: number): string {
  let tail =
    `${cluster.raw_mentions}→${cluster.independent_observations}` +
    ` · top: ${cluster.top_rung} · O:${cluster.opportunity} C:${cluster.confidence}`;
  if (cluster.inflation >= maxInflation) {
    tail += `  ⚠ 인플레이션 ${cluster.inflation.toFixed(1)}x`;
  }
  return tail;
}

function rankTableLines(run: ResearchRun): string[] {
  const byBefore = [...run.clusters].sort((a, b) => a.rank_before - b.rank_before);
  const byAfter = [...run.clusters].sort((a, b) => a.rank_after - b.rank_after);
  const maxInflation = run.config_snapshot.conf_high.max_inflation;

  const leftCells = byBefore.map(
    (cluster) => `#${cluster.rank_before} ${cluster.title} (${cluster.raw_mentions})`,
  );
  const rightHeads = byAfter.map((cluster) => `#${cluster.rank_after} ${cluster.title}`);
  const leftWidth = Math.max(displayWidth("RAW RANK"), ...leftCells.map(displayWidth));
  const rightHeadWidth = Math.max(0, ...rightHeads.map(displayWidth));
  const arrow = "   →   ";

  const lines = [`${padDisplay("RAW RANK", leftWidth)}${" ".repeat(arrow.length)}VERIFIED RANK`];
  for (let index = 0; index < byAfter.length; index += 1) {
    lines.push(
      padDisplay(leftCells[index], leftWidth) +
        arrow +
        padDisplay(rightHeads[index], rightHeadWidth) +
        "  " +
        verifiedTail(byAfter[index], maxInflation),
    );
  }
  return lines;
}

function counterTotal(cluster: PainCluster): number {
  return Object.values(cluster.counter).reduce((sum, count) => sum + count, 0);
}

function aggregateLine(cluster: PainCluster): string {
  return (
    `${cluster.cluster_id} · 독립 관측 ${cluster.independent_observations}` +
    ` · 소스 그룹 ${cluster.source_groups}` +
    ` · same_item_ratio ${cluster.same_item_ratio.toFixed(2)}` +
    ` · 인플레이션 ${cluster.inflation.toFixed(1)}x` +
    ` · top_rung ${cluster.top_rung}` +
    ` · counter 합계 ${counterTotal(cluster)}`
  );
}

export function formatRunTable(run: ResearchRun): string[] {
  const winner = run.clusters.find((cluster) => cluster.rank_after === 1);
  const byAfter = [...run.clusters].sort((a, b) => a.rank_after - b.rank_after);

  return [
    `질문: ${run.question}`,
    funnelLine(run),
    ...(run.clusters.length > 0 ? rankTableLines(run) : ["(클러스터 없음)"]),
    "--- 1위 이유 ---",
    ...(winner ? winner.ranking_reasons : ["(없음)"]),
    "--- 집계 ---",
    ...byAfter.map(aggregateLine),
  ];
}

function printTable(run: ResearchRun): void {
  for (const line of formatRunTable(run)) {
    console.log(line);
  }
}

function reportProgress(step: PipelineStep, detail?: string): void {
  console.error(`· ${step}${detail ? ` ${detail}` : ""}`);
}

function liveRunId(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `live_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

// ---------- 명령 ----------

async function runFixture(options: CliOptions): Promise<void> {
  const cfg = loadConfig();
  const evidence = readEvidenceFile(FIXTURE_PATH);
  const run = await runPipeline(
    {
      question: options.question,
      evidence,
      sources: sourcesFromEvidence(evidence),
      mode: "fixture",
      run_id: "fixture",
    },
    cfg,
    reportProgress,
  );
  const outputPath = join(RUNS_DIR, "fixture.json");
  saveRun(run, outputPath);
  console.log(`저장: ${outputPath}`);
  printTable(run);
}

function runCached(options: CliOptions): void {
  if (options.cachedPath === null) {
    throw new Error("--cached <path> 가 필요합니다.");
  }
  printTable(readJson<ResearchRun>(options.cachedPath));
}

function loadRawFiles(paths: string[]): RawFile[] {
  const resolvedPaths = paths.length > 0 ? paths : discoverRawPaths();
  if (resolvedPaths.length === 0) {
    throw new Error(`${RAW_DIR} 에 youtube_*.json 이 없습니다. 경로를 직접 지정하세요.`);
  }
  return resolvedPaths.map((path) => ({ path, evidence: readEvidenceFile(path) }));
}

function prepareRawEvidence(files: RawFile[], maxEvidence: number): Evidence[] {
  const merged = mergeRawEvidence(files);
  console.log(`입력 ${merged.input} → 고유 ID ${merged.unique}`);

  const capped = capEvidence(merged.evidence, maxEvidence);
  if (capped.length < merged.unique) {
    console.log(`고유 ${merged.unique} → 사용 ${capped.length} (상한)`);
  }
  return capped;
}

function printLlmEstimate(evidence: Evidence[], cfg: ScoringConfig): void {
  const representatives = countRepresentatives(evidence, cfg);
  const calls = estimateLlmCalls(representatives, cfg.batch_size);
  console.log(
    `예상 LLM 호출 수 = ${calls} (ceil(대표 ${representatives} / batch_size ${cfg.batch_size}) + 1)`,
  );
  if (calls > LLM_CALL_WARNING_THRESHOLD) {
    console.log(
      `⚠ 경고: 예상 LLM 호출 수가 ${LLM_CALL_WARNING_THRESHOLD} 을 넘습니다. --max-evidence 로 줄이는 것을 권합니다.`,
    );
  }
}

async function runRaw(options: CliOptions): Promise<void> {
  const cfg = loadConfig();
  const files = loadRawFiles(options.rawPaths);
  const evidence = prepareRawEvidence(files, options.maxEvidence);
  printLlmEstimate(evidence, cfg);

  const runId = liveRunId(new Date());
  const run = await runPipeline(
    {
      question: options.question,
      evidence,
      sources: files.map((file) => sourceFromFile(file.path, file.evidence)),
      mode: "live",
      run_id: runId,
    },
    cfg,
    reportProgress,
  );
  const outputPath = join(RUNS_DIR, `${runId}.json`);
  saveRun(run, outputPath);
  console.log(`저장: ${outputPath}`);
  printTable(run);
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.command === "fixture") {
    await runFixture(options);
  } else if (options.command === "cached") {
    runCached(options);
  } else if (options.command === "raw") {
    await runRaw(options);
  } else {
    console.error(USAGE);
    return 1;
  }
  return 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const normalize = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  return normalize(resolve(entry)) === normalize(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`오류: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
