import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { ResearchRun } from "../lib/types";

const ALLOWED_SLUGS = ["q1", "q2", "q3"] as const;
type CacheSlug = (typeof ALLOWED_SLUGS)[number];

function isAllowedSlug(value: string): value is CacheSlug {
  return (ALLOWED_SLUGS as readonly string[]).includes(value);
}

function parseArgs(argv: string[]): {
  sourcePath: string | undefined;
  slug: CacheSlug | undefined;
} {
  let sourcePath: string | undefined;
  let slug: CacheSlug | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--slug") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--slug 뒤에는 q1, q2, q3 중 하나가 필요합니다.");
      }
      if (!isAllowedSlug(value)) {
        throw new Error(`--slug 는 q1, q2, q3 만 허용합니다. 받은 값: ${value}`);
      }
      slug = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--slug=")) {
      const value = argument.slice("--slug=".length);
      if (!isAllowedSlug(value)) {
        throw new Error(`--slug 는 q1, q2, q3 만 허용합니다. 받은 값: ${value}`);
      }
      slug = value;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`알 수 없는 인자: ${argument}`);
    }
    if (sourcePath !== undefined) {
      throw new Error(`run JSON 경로는 하나만 받습니다. 추가 인자: ${argument}`);
    }
    sourcePath = argument;
  }

  return { sourcePath, slug };
}

function destinationPath(slug: CacheSlug | undefined): string {
  if (slug === undefined) {
    return "data/runs/demo_cached.json";
  }
  return `data/runs/demo_cached_${slug}.json`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function main(): void {
  let parsedArgs: { sourcePath: string | undefined; slug: CacheSlug | undefined };
  try {
    parsedArgs = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const { sourcePath, slug } = parsedArgs;
  if (sourcePath === undefined || sourcePath === "") {
    fail("run JSON 경로가 필요합니다. 예: npm run cache:demo -- data/runs/live_....json");
  }
  if (!existsSync(sourcePath)) {
    fail(`파일이 없습니다: ${sourcePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
  } catch {
    fail(`JSON을 읽을 수 없습니다: ${sourcePath}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("run JSON 객체 형식이 아닙니다.");
  }

  const run = parsed as ResearchRun;
  // run_id 는 원본을 유지하고, 시연 캐시라는 뜻만 mode 에 남긴다.
  const cached: ResearchRun = { ...run, mode: "cached" };
  const dest = destinationPath(slug);
  writeFileSync(dest, `${JSON.stringify(cached, null, 2)}\n`, "utf8");
  console.log(`${sourcePath} → ${dest} (mode=cached, run_id=${cached.run_id})`);
}

main();
