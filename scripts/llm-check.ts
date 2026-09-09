import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { discoverThemes } from "../lib/pipeline/cluster";
import { applyDedup, dedup } from "../lib/pipeline/dedup";
import { applyNormalize } from "../lib/pipeline/normalize";
import { llmCallStats, setUsageContext } from "../lib/llm";
import type { Evidence, ScoringConfig } from "../lib/types";

const QUESTION = "네이버 스마트스토어 셀러들이 반복적으로 겪는 운영 문제는?";
const DEMO_PATH = "data/fixtures/demo.json";
const CONFIG_PATH = "config/scoring.json";
const USAGE_PATH = join(process.cwd(), "data/runs/_llm_usage.jsonl");

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function usageSnapshot(): string {
  if (!existsSync(USAGE_PATH)) {
    return "";
  }
  return readFileSync(USAGE_PATH, "utf8");
}

async function main(): Promise<void> {
  // env 파일이 mock 이어도 이 스크립트는 real 한 번만 검증한다.
  process.env.LLM_MODE = "real";

  const evidence = readJsonFile<Evidence[]>(DEMO_PATH);
  const cfg = readJsonFile<ScoringConfig>(CONFIG_PATH);
  const normalized = applyNormalize(evidence);
  const groups = dedup(normalized, cfg);
  const deduplicated = applyDedup(normalized, groups);
  const sample = deduplicated
    .filter((item) => item.is_group_representative)
    .sort((first, second) => first.evidence_id.localeCompare(second.evidence_id))
    .slice(0, 20);

  const usageBefore = usageSnapshot();
  setUsageContext({ run_id: "llm-check", phase: "themes" });
  const themes = await discoverThemes(sample, QUESTION, "real");

  console.log(
    `논리 호출 ${llmCallStats.logicalCalls}회 / HTTP 시도 ${llmCallStats.httpAttempts}회(최초 1 + 재시도) / 성공 응답 ${llmCallStats.successResponses}회`,
  );
  console.log(JSON.stringify(themes, null, 2));

  const added = usageSnapshot().slice(usageBefore.length).trim();
  if (added !== "") {
    console.log(added);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
