import { createHash } from "node:crypto";

import type { DedupGroup, Evidence, ScoringConfig } from "../types";

type DedupConfig = Pick<
  ScoringConfig,
  "near_dup_threshold" | "thread_echo_threshold"
>;

class UnionFind {
  private readonly parents: number[];
  private readonly ranks: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
    this.ranks = Array.from({ length: size }, () => 0);
  }

  find(index: number): number {
    if (this.parents[index] !== index) {
      this.parents[index] = this.find(this.parents[index]);
    }

    return this.parents[index];
  }

  union(firstIndex: number, secondIndex: number): boolean {
    const firstRoot = this.find(firstIndex);
    const secondRoot = this.find(secondIndex);

    if (firstRoot === secondRoot) {
      return false;
    }

    if (this.ranks[firstRoot] < this.ranks[secondRoot]) {
      this.parents[firstRoot] = secondRoot;
      return true;
    }

    this.parents[secondRoot] = firstRoot;
    if (this.ranks[firstRoot] === this.ranks[secondRoot]) {
      this.ranks[firstRoot] += 1;
    }

    return true;
  }
}

function withoutWhitespace(text: string): string {
  return text.replace(/\s/gu, "");
}

function createTrigrams(text: string): Set<string> {
  const characters = Array.from(withoutWhitespace(text));
  const trigrams = new Set<string>();

  for (let index = 0; index <= characters.length - 3; index += 1) {
    trigrams.add(characters.slice(index, index + 3).join(""));
  }

  return trigrams;
}

export function trigramJaccard(a: string, b: string): number {
  const compactA = withoutWhitespace(a);
  const compactB = withoutWhitespace(b);

  if (Array.from(compactA).length < 3 || Array.from(compactB).length < 3) {
    return compactA === compactB ? 1 : 0;
  }

  const trigramsA = createTrigrams(compactA);
  const trigramsB = createTrigrams(compactB);
  let intersectionSize = 0;

  for (const trigram of trigramsA) {
    if (trigramsB.has(trigram)) {
      intersectionSize += 1;
    }
  }

  const unionSize = trigramsA.size + trigramsB.size - intersectionSize;
  return unionSize === 0 ? 1 : intersectionSize / unionSize;
}

function exactHash(text: string): string {
  return createHash("sha1").update(withoutWhitespace(text)).digest("hex");
}

function compareRepresentativeCandidates(
  first: Evidence,
  second: Evidence,
): number {
  if (first.published_at === null && second.published_at !== null) {
    return 1;
  }

  if (first.published_at !== null && second.published_at === null) {
    return -1;
  }

  if (
    first.published_at !== null &&
    second.published_at !== null &&
    first.published_at !== second.published_at
  ) {
    return first.published_at.localeCompare(second.published_at);
  }

  return first.evidence_id.localeCompare(second.evidence_id);
}

export function dedup(evidence: Evidence[], cfg: DedupConfig): DedupGroup[] {
  const unionFind = new UnionFind(evidence.length);
  const evidenceIndexById = new Map(
    evidence.map((item, index) => [item.evidence_id, index]),
  );
  const exactBuckets = new Map<string, number[]>();
  const exactMemberIndexes = new Set<number>();
  const echoMemberIndexes = new Set<number>();
  const nearMemberIndexes = new Set<number>();

  // exact를 먼저 고정해야 공백 차이만 있는 글이 near 통계로 섞이지 않는다.
  evidence.forEach((item, index) => {
    const hash = exactHash(item.text_norm);
    const bucket = exactBuckets.get(hash) ?? [];
    bucket.push(index);
    exactBuckets.set(hash, bucket);
  });

  for (const bucket of exactBuckets.values()) {
    if (bucket.length < 2) {
      continue;
    }

    bucket.forEach((index) => exactMemberIndexes.add(index));
    for (let index = 1; index < bucket.length; index += 1) {
      unionFind.union(bucket[0], bucket[index]);
    }
  }

  // 답글은 부모와 충분히 닮았을 때만 부모 관측에 붙이고 near 후보에서 제외한다.
  evidence.forEach((item, index) => {
    if (item.parent_id === null) {
      return;
    }

    const parentIndex = evidenceIndexById.get(item.parent_id);
    if (parentIndex === undefined) {
      return;
    }

    const similarity = trigramJaccard(
      item.text_norm,
      evidence[parentIndex].text_norm,
    );
    if (similarity >= cfg.thread_echo_threshold) {
      unionFind.union(index, parentIndex);
      echoMemberIndexes.add(index);
    }
  });

  for (let firstIndex = 0; firstIndex < evidence.length; firstIndex += 1) {
    if (echoMemberIndexes.has(firstIndex)) {
      continue;
    }

    for (
      let secondIndex = firstIndex + 1;
      secondIndex < evidence.length;
      secondIndex += 1
    ) {
      if (
        echoMemberIndexes.has(secondIndex) ||
        evidence[firstIndex].source_group !== evidence[secondIndex].source_group
      ) {
        continue;
      }

      const similarity = trigramJaccard(
        evidence[firstIndex].text_norm,
        evidence[secondIndex].text_norm,
      );
      if (
        similarity >= cfg.near_dup_threshold &&
        unionFind.union(firstIndex, secondIndex)
      ) {
        nearMemberIndexes.add(firstIndex);
        nearMemberIndexes.add(secondIndex);
      }
    }
  }

  const componentIndexes = new Map<number, number[]>();
  evidence.forEach((_, index) => {
    const root = unionFind.find(index);
    const members = componentIndexes.get(root) ?? [];
    members.push(index);
    componentIndexes.set(root, members);
  });

  const groups = Array.from(componentIndexes.values()).map((memberIndexes) => {
    const members = memberIndexes.map((index) => evidence[index]);
    const representative = [...members].sort(
      compareRepresentativeCandidates,
    )[0];
    const memberIds = members
      .map((item) => item.evidence_id)
      .sort((first, second) => first.localeCompare(second));
    const hasExactBase = memberIndexes.some((index) =>
      exactMemberIndexes.has(index),
    );
    const hasNearBase = memberIndexes.some((index) =>
      nearMemberIndexes.has(index),
    );
    const reason: DedupGroup["reason"] = hasExactBase
      ? "exact"
      : hasNearBase
        ? "near"
        : "single";

    return {
      group_id: `dedup-${createHash("sha1")
        .update(memberIds.join("|"))
        .digest("hex")
        .slice(0, 12)}`,
      representative_id: representative.evidence_id,
      member_ids: memberIds,
      reason,
    };
  });

  return groups.sort((first, second) =>
    first.representative_id.localeCompare(second.representative_id),
  );
}

export function applyDedup(
  evidence: Evidence[],
  groups: DedupGroup[],
): Evidence[] {
  const groupByEvidenceId = new Map<string, DedupGroup>();

  for (const group of groups) {
    for (const memberId of group.member_ids) {
      groupByEvidenceId.set(memberId, group);
    }
  }

  return evidence.map((item) => {
    const group = groupByEvidenceId.get(item.evidence_id);

    return {
      ...item,
      dedup_group_id: group?.group_id ?? "",
      is_group_representative: group?.representative_id === item.evidence_id,
    };
  });
}
