import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LlmMode = "mock" | "real";

type UsagePhase = "themes" | "classify" | "baseline";

interface UsageContext {
  run_id: string;
  phase: UsagePhase | "";
}

interface AnthropicTextBlock {
  type: string;
  text?: string;
}

interface AnthropicMessageResponse {
  content?: AnthropicTextBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface AnthropicHttpResult {
  status: number;
  ok: boolean;
  text: string | null;
  inputTokens: number;
  outputTokens: number;
}

const FIXTURE_PATH = join(process.cwd(), "data/fixtures/labels.json");
const USAGE_PATH = join(process.cwd(), "data/runs/_llm_usage.jsonl");
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MIN_CALL_INTERVAL_MS = 6_000;
const RATE_LIMIT_DELAYS_MS = [20_000, 40_000] as const;
const JSON_RETRY_SUFFIX = "JSON만 출력";

let usageContext: UsageContext = { run_id: "", phase: "" };
let lastCallEndedAt = 0;

export const llmCallStats = {
  logicalCalls: 0,
  httpAttempts: 0,
  successResponses: 0,
};

export function llmMode(): LlmMode {
  return process.env.LLM_MODE === "real" ? "real" : "mock";
}

export function setUsageContext(ctx: { run_id: string; phase: UsagePhase }): void {
  usageContext = { run_id: ctx.run_id, phase: ctx.phase };
}

export function recordUsage(input: number, output: number, raw?: string | null): void {
  // mock 경로는 여기 오지 않는다. mode:'real' 오버라이드여도 토큰을 남겨야 한다.
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    run_id: usageContext.run_id,
    phase: usageContext.phase,
    input,
    output,
    ...(process.env.LLM_LOG_RAW === "1" ? { raw } : {}),
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

  if (mode === "real") {
    return callJsonReal(opts);
  }

  try {
    const raw = await readFile(FIXTURE_PATH, "utf8");
    const fixtures = JSON.parse(raw) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(fixtures, opts.mockKey)) {
      return fixtures[opts.mockKey] as T;
    }
    return opts.fallback;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[llm] ${mode} callJson failed (${opts.mockKey}): ${message}`);
    return opts.fallback;
  }
}

async function callJsonReal<T>(opts: {
  system: string;
  user: string;
  fallback: T;
}): Promise<T> {
  llmCallStats.logicalCalls += 1;

  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  assertHaikuModel(model);

  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  if (apiKey === "") {
    console.warn("[llm] LLM_API_KEY missing");
    return opts.fallback;
  }

  let userPrompt = opts.user;
  for (let parseAttempt = 0; parseAttempt < 2; parseAttempt += 1) {
    if (parseAttempt === 1) {
      userPrompt = `${opts.user}\n${JSON_RETRY_SUFFIX}`;
    }

    const result = await callAnthropicWithRateLimit(
      apiKey,
      model,
      opts.system,
      userPrompt,
    );
    if (!result.ok) {
      return opts.fallback;
    }

    recordUsage(result.inputTokens, result.outputTokens, result.text);
    const parsed = parseModelJson<T>(result.text ?? "");
    if (parsed.ok) {
      return parsed.value;
    }
  }

  console.warn("[llm] JSON parse failed");
  return opts.fallback;
}

function assertHaikuModel(model: string): void {
  // Haiku가 아니면 토큰 비용이 급증하므로 호출 전에 프로세스를 멈춘다.
  if (!model.startsWith("claude-haiku")) {
    console.warn("[llm] cost guard: LLM_MODEL must start with claude-haiku");
    process.exit(1);
  }
}

async function callAnthropicWithRateLimit(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<AnthropicHttpResult> {
  const maxAttempts = RATE_LIMIT_DELAYS_MS.length + 1;
  let last = emptyHttpResult();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    last = await callAnthropicOnce(apiKey, model, system, user);
    if (last.ok) {
      llmCallStats.successResponses += 1;
      return last;
    }

    const canRetry =
      isRetryableStatus(last.status) && attempt < RATE_LIMIT_DELAYS_MS.length;
    if (!canRetry) {
      if (last.status > 0) {
        console.warn(`[llm] ${last.status}`);
      }
      return last;
    }

    await sleep(RATE_LIMIT_DELAYS_MS[attempt]);
  }

  return last;
}

async function callAnthropicOnce(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<AnthropicHttpResult> {
  await waitForMinCallInterval();
  llmCallStats.httpAttempts += 1;

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        // 배치 20건 응답이 3천 토큰을 넘긴 적이 있어 잘림 여유를 둔다. 잘리면 파싱 실패로 배치 전체가 비워진다.
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
  } catch {
    lastCallEndedAt = Date.now();
    console.warn("[llm] network error");
    return emptyHttpResult();
  }

  lastCallEndedAt = Date.now();
  return readAnthropicResult(response);
}

async function readAnthropicResult(
  response: Response,
): Promise<AnthropicHttpResult> {
  const status = response.status;
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return { status, ok: false, text: null, inputTokens: 0, outputTokens: 0 };
  }

  if (!response.ok) {
    return { status, ok: false, text: null, inputTokens: 0, outputTokens: 0 };
  }

  const body = payload as AnthropicMessageResponse;
  const textBlock = (body.content ?? []).find((block) => block.type === "text");

  return {
    status,
    ok: true,
    text: textBlock?.text ?? null,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  };
}

function parseModelJson<T>(
  raw: string,
): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(extractJsonPayload(raw)) as T };
  } catch {
    return { ok: false };
  }
}

function extractJsonPayload(raw: string): string {
  const withoutFence = raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();

  const objectStart = withoutFence.indexOf("{");
  const arrayStart = withoutFence.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length === 0) {
    return withoutFence;
  }

  const start = Math.min(...starts);
  const end = Math.max(
    withoutFence.lastIndexOf("}"),
    withoutFence.lastIndexOf("]"),
  );
  if (end < start) {
    return withoutFence.slice(start);
  }
  return withoutFence.slice(start, end + 1);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529;
}

function emptyHttpResult(): AnthropicHttpResult {
  return { status: 0, ok: false, text: null, inputTokens: 0, outputTokens: 0 };
}

async function waitForMinCallInterval(): Promise<void> {
  if (lastCallEndedAt === 0) {
    return;
  }

  const elapsed = Date.now() - lastCallEndedAt;
  if (elapsed < MIN_CALL_INTERVAL_MS) {
    await sleep(MIN_CALL_INTERVAL_MS - elapsed);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
