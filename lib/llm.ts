import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LlmMode = "mock" | "real";

type UsagePhase = "themes" | "classify" | "baseline";

interface UsageContext {
  run_id: string;
  phase: UsagePhase | "";
}

const FIXTURE_PATH = join(process.cwd(), "data/fixtures/labels.json");
const USAGE_PATH = join(process.cwd(), "data/runs/_llm_usage.jsonl");

let usageContext: UsageContext = { run_id: "", phase: "" };

export function llmMode(): LlmMode {
  return process.env.LLM_MODE === "real" ? "real" : "mock";
}

export function setUsageContext(ctx: { run_id: string; phase: UsagePhase }): void {
  usageContext = { run_id: ctx.run_id, phase: ctx.phase };
}

export function recordUsage(input: number, output: number): void {
  // mock 경로에서는 토큰 사용량을 남기지 않는다. 시연·테스트가 실사용 로그와 섞이면 안 된다.
  if (llmMode() !== "real") {
    return;
  }

  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    run_id: usageContext.run_id,
    phase: usageContext.phase,
    input,
    output,
  })}\n`;

  mkdirSync(dirname(USAGE_PATH), { recursive: true });
  appendFileSync(USAGE_PATH, line, "utf8");
}

export async function callJson<T>(opts: {
  system: string;
  user: string;
  mockKey: string;
  fallback: T;
  mode?: LlmMode;
}): Promise<T> {
  const mode = opts.mode ?? llmMode();

  try {
    if (mode === "mock") {
      const raw = await readFile(FIXTURE_PATH, "utf8");
      const fixtures = JSON.parse(raw) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(fixtures, opts.mockKey)) {
        return fixtures[opts.mockKey] as T;
      }
      return opts.fallback;
    }

    // TODO: Anthropic Messages API (LLM_API_KEY, LLM_MODEL). 지금은 파이프라인만 연결한다.
    void opts.system;
    void opts.user;
    throw new Error("real mode not implemented yet");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[llm] ${mode} callJson failed (${opts.mockKey}): ${message}`);
    return opts.fallback;
  }
}
