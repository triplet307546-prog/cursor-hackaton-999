import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("recordUsage", () => {
  const usagePath = join(process.cwd(), "data/runs/_llm_usage.jsonl");
  const existedBefore = existsSync(usagePath);
  let before = "";

  beforeEach(() => {
    delete process.env.LLM_LOG_RAW;
    before = existedBefore ? readFileSync(usagePath, "utf8") : "";
  });

  afterEach(() => {
    delete process.env.LLM_LOG_RAW;
  });

  it("LLM_LOG_RAW 가 없으면 raw 키를 남기지 않는다", async () => {
    const { recordUsage } = await import("../lib/llm");
    recordUsage(1, 2, "should not appear");

    const after = readFileSync(usagePath, "utf8");
    const addedLine = after.slice(before.length).trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(addedLine);
    expect(parsed).not.toHaveProperty("raw");
  });
});
