import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPLY_NOTE,
  YouTubeApiError,
  fetchThreads,
  redact,
  resolveQuery,
  searchVideos,
  toEvidence,
  type Question,
} from "../lib/sources/youtube";
import type { Evidence } from "../lib/types";
import { capEvidence } from "./run";

const QUESTIONS_PATH = "config/questions.json";
const RAW_DIR = "data/raw";
const DEFAULT_VIDEOS = 6;
const DEFAULT_PER_VIDEO = 40;
const DEFAULT_MAX_TOTAL = 400;
const SEARCH_QUOTA = 100;
const THREADS_QUOTA = 1;

const USAGE = `사용법:
  npm run fetch:youtube -- --slug q1|q2|q3|<이름> [--query "<검색어>"] --videos ${DEFAULT_VIDEOS} --per-video ${DEFAULT_PER_VIDEO} --max-total ${DEFAULT_MAX_TOTAL}
  --query 를 생략하면 ${QUESTIONS_PATH} 에서 같은 slug 의 query 를 읽는다.
  YOUTUBE_API_KEY 는 환경변수(.env.local)에서만 읽는다.`;

interface CliOptions {
  slug: string | null;
  query: string | null;
  videos: number;
  perVideo: number;
  maxTotal: number;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} 뒤에 값이 필요합니다.`);
  }
  return value;
}

function requirePositiveInt(argv: string[], index: number, flag: string): number {
  const parsed = Number.parseInt(requireValue(argv, index, flag), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} 은 1 이상의 정수여야 합니다.`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    slug: null,
    query: null,
    videos: DEFAULT_VIDEOS,
    perVideo: DEFAULT_PER_VIDEO,
    maxTotal: DEFAULT_MAX_TOTAL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--slug") {
      options.slug = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--query") {
      options.query = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--videos") {
      options.videos = requirePositiveInt(argv, index, arg);
      index += 1;
    } else if (arg === "--per-video") {
      options.perVideo = requirePositiveInt(argv, index, arg);
      index += 1;
    } else if (arg === "--max-total") {
      options.maxTotal = requirePositiveInt(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`알 수 없는 인자: ${arg}`);
    }
  }
  return options;
}

function readQuestions(): Question[] {
  if (!existsSync(QUESTIONS_PATH)) {
    return [];
  }
  return JSON.parse(readFileSync(QUESTIONS_PATH, "utf8")) as Question[];
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (!options.slug) {
    console.error(USAGE);
    return 1;
  }

  const query = resolveQuery(options.slug, options.query, readQuestions());
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error("YOUTUBE_API_KEY 환경변수가 필요합니다.");
  }

  const videosPath = join(RAW_DIR, `videos_${options.slug}.json`);
  let searchCalls = 0;
  let videoIds: string[];

  if (existsSync(videosPath)) {
    videoIds = JSON.parse(readFileSync(videosPath, "utf8")) as string[];
    console.log(`${videosPath} 재사용 — 검색 건너뜀 (quota 절약), 영상 ${videoIds.length}개`);
  } else {
    videoIds = await searchVideos(query, options.videos);
    searchCalls = 1;
    if (videoIds.length === 0) {
      // 빈 결과를 캐시하면 재검색이 영영 막힌다. 실패는 저장하지 않는다.
      console.error(`검색 "${query}" → 영상 0개. ${videosPath} 를 만들지 않습니다 (검색어를 바꿔 다시 시도).`);
      return 1;
    }
    writeJson(videosPath, videoIds);
    console.log(`검색 "${query}" → 영상 ${videoIds.length}개, ${videosPath} 저장`);
  }

  const collected: Evidence[] = [];
  let threadCalls = 0;
  let commentsDisabled = 0;
  let quotaExceeded = false;

  for (const videoId of videoIds) {
    threadCalls += 1; // 403 도 quota 를 쓴다.
    try {
      for (const item of await fetchThreads(videoId, options.perVideo)) {
        collected.push(...toEvidence(videoId, item));
      }
    } catch (error) {
      if (error instanceof YouTubeApiError && error.reason === "commentsDisabled") {
        commentsDisabled += 1;
        continue;
      }
      if (error instanceof YouTubeApiError && error.reason === "quotaExceeded") {
        quotaExceeded = true;
        break;
      }
      throw error;
    }
  }

  const evidence = capEvidence(collected, options.maxTotal);
  const outPath = join(RAW_DIR, `youtube_${options.slug}.json`);
  writeJson(outPath, {
    meta: {
      slug: options.slug,
      query,
      fetched_at: new Date().toISOString(),
      videos: videoIds.length,
      note: REPLY_NOTE,
    },
    evidence,
  });

  const replies = evidence.filter((item) => item.parent_id !== null).length;
  const quota = searchCalls * SEARCH_QUOTA + threadCalls * THREADS_QUOTA;

  console.log(`${outPath} 저장`);
  if (evidence.length < collected.length) {
    console.log(`수집 ${collected.length} → 저장 ${evidence.length} (상한)`);
  }
  console.log(`영상 ${videoIds.length} / 댓글 ${evidence.length - replies} / 답글 ${replies}`);
  if (commentsDisabled > 0) {
    console.log(`댓글 사용 중지 영상 ${commentsDisabled}개 건너뜀`);
  }
  console.log(
    `quota 추정: search ${SEARCH_QUOTA}×${searchCalls} + commentThreads ${THREADS_QUOTA}×${threadCalls} = ${quota}`,
  );

  if (quotaExceeded) {
    console.error("quotaExceeded — 여기까지 저장하고 종료합니다.");
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
      console.error(`오류: ${redact(error instanceof Error ? error.message : String(error))}`);
      process.exitCode = 1;
    });
}
