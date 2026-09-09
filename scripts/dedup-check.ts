import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { applyDedup, dedup, trigramJaccard } from "../lib/pipeline/dedup";
import { applyNormalize } from "../lib/pipeline/normalize";
import type { DedupGroup, Evidence, ScoringConfig } from "../lib/types";
import { mergeRawEvidence, type RawFile } from "./run";

const RAW_DIR = "data/raw";
const CONFIG_PATH = "config/scoring.json";
const RAW_FILE_PATTERN = /^(youtube|naver)_.*\.json$/u;
const THRESHOLDS = [0.6, 0.5] as const;
const TOP_GROUP_COUNT = 3;
const QUOTE_PREVIEW_LENGTH = 40;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
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

function discoverRawPaths(): string[] {
  if (!existsSync(RAW_DIR)) {
    return [];
  }
  return readdirSync(RAW_DIR)
    .filter((name) => RAW_FILE_PATTERN.test(name))
    .sort()
    .map((name) => join(RAW_DIR, name));
}

function loadMergedEvidence(): Evidence[] {
  const paths = discoverRawPaths();
  if (paths.length === 0) {
    throw new Error(`${RAW_DIR} 에 youtube_*.json / naver_*.json 이 없습니다.`);
  }
  const files: RawFile[] = paths.map((path) => ({
    path,
    evidence: readEvidenceFile(path),
  }));
  const merged = mergeRawEvidence(files);
  console.log(`파일 ${files.length}개 / 입력 ${merged.input} → 고유 ID ${merged.unique}`);
  return merged.evidence;
}

function withoutWhitespace(text: string): string {
  return text.replace(/\s/gu, "");
}

function previewText(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length <= QUOTE_PREVIEW_LENGTH
    ? compact
    : `${compact.slice(0, QUOTE_PREVIEW_LENGTH)}…`;
}

function countGroupSizes(groups: DedupGroup[]): {
  single: number;
  pairs: number;
  large: number;
} {
  let single = 0;
  let pairs = 0;
  let large = 0;
  for (const group of groups) {
    const size = group.member_ids.length;
    if (size <= 1) {
      single += 1;
    } else if (size === 2) {
      pairs += 1;
    } else {
      large += 1;
    }
  }
  return { single, pairs, large };
}

function isEchoChildOf(
  child: Evidence,
  parent: Evidence,
  echoChildIds: Set<string>,
): boolean {
  return (
    echoChildIds.has(child.evidence_id) && child.parent_id === parent.evidence_id
  );
}

function countBoundPairs(
  evidence: Evidence[],
  groups: DedupGroup[],
  nearDupThreshold: number,
  threadEchoThreshold: number,
): { threadEchoPairs: number; nearDupPairs: number } {
  const byId = new Map(evidence.map((item) => [item.evidence_id, item]));
  const groupByMemberId = new Map<string, DedupGroup>();
  for (const group of groups) {
    for (const memberId of group.member_ids) {
      groupByMemberId.set(memberId, group);
    }
  }

  let threadEchoPairs = 0;
  const echoChildIds = new Set<string>();
  for (const item of evidence) {
    if (item.parent_id === null) {
      continue;
    }
    const parent = byId.get(item.parent_id);
    if (parent === undefined) {
      continue;
    }
    if (groupByMemberId.get(item.evidence_id) !== groupByMemberId.get(parent.evidence_id)) {
      continue;
    }
    if (trigramJaccard(item.text_norm, parent.text_norm) >= threadEchoThreshold) {
      threadEchoPairs += 1;
      echoChildIds.add(item.evidence_id);
    }
  }

  let nearDupPairs = 0;
  for (const group of groups) {
    const members = group.member_ids
      .map((memberId) => byId.get(memberId))
      .filter((item): item is Evidence => item !== undefined);
    for (let firstIndex = 0; firstIndex < members.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < members.length; secondIndex += 1) {
        const first = members[firstIndex];
        const second = members[secondIndex];
        if (first.source_group !== second.source_group) {
          continue;
        }
        if (
          isEchoChildOf(first, second, echoChildIds) ||
          isEchoChildOf(second, first, echoChildIds)
        ) {
          continue;
        }
        if (withoutWhitespace(first.text_norm) === withoutWhitespace(second.text_norm)) {
          continue;
        }
        if (trigramJaccard(first.text_norm, second.text_norm) >= nearDupThreshold) {
          nearDupPairs += 1;
        }
      }
    }
  }

  return { threadEchoPairs, nearDupPairs };
}

function largestGroups(
  groups: DedupGroup[],
  evidence: Evidence[],
): { preview: string; size: number }[] {
  const byId = new Map(evidence.map((item) => [item.evidence_id, item]));
  return [...groups]
    .sort((first, second) => {
      const sizeDiff = second.member_ids.length - first.member_ids.length;
      if (sizeDiff !== 0) {
        return sizeDiff;
      }
      return first.representative_id.localeCompare(second.representative_id);
    })
    .slice(0, TOP_GROUP_COUNT)
    .map((group) => {
      const representative = byId.get(group.representative_id);
      return {
        preview: previewText(representative?.text_raw ?? ""),
        size: group.member_ids.length,
      };
    });
}

function inspectThreshold(
  normalized: Evidence[],
  baseConfig: ScoringConfig,
  nearDupThreshold: number,
): { inflation: number } {
  const cfg = { ...baseConfig, near_dup_threshold: nearDupThreshold };
  const groups = dedup(normalized, cfg);
  const applied = applyDedup(normalized, groups);
  const input = applied.length;
  const independent = applied.filter((item) => item.is_group_representative).length;
  const inflation = independent === 0 ? 0 : input / independent;
  const sizes = countGroupSizes(groups);
  const pairs = countBoundPairs(
    applied,
    groups,
    nearDupThreshold,
    baseConfig.thread_echo_threshold,
  );
  const topGroups = largestGroups(groups, applied);

  console.log(`=== near_dup_threshold ${nearDupThreshold} ===`);
  console.log(
    `입력 ${input} / 독립 관측 ${independent} / inflation ${inflation.toFixed(2)}`,
  );
  console.log(
    `묶음: single ${sizes.single} / 2건 ${sizes.pairs} / 3건 이상 ${sizes.large}`,
  );
  console.log(
    `쌍: thread_echo ${pairs.threadEchoPairs} / near_dup ${pairs.nearDupPairs}`,
  );
  console.log("가장 큰 묶음 3개:");
  for (const group of topGroups) {
    console.log(`  ${group.preview}  (${group.size})`);
  }

  return { inflation };
}

function main(): void {
  const baseConfig = readJson<ScoringConfig>(CONFIG_PATH);
  const evidence = loadMergedEvidence();
  const normalized = applyNormalize(evidence);

  const inflations: number[] = [];
  for (const threshold of THRESHOLDS) {
    const result = inspectThreshold(normalized, baseConfig, threshold);
    inflations.push(result.inflation);
  }

  console.log(
    `0.6 inflation ${inflations[0].toFixed(2)} / 0.5 inflation ${inflations[1].toFixed(2)}`,
  );
}

main();
