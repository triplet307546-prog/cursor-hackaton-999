import { describe, expect, it } from "vitest";

import scoringConfig from "../config/scoring.json";
import answersJson from "../data/fixtures/answers.json";
import demoJson from "../data/fixtures/demo.json";
import { applyDedup, dedup, trigramJaccard } from "../lib/pipeline/dedup";
import { applyNormalize, normalize } from "../lib/pipeline/normalize";
import type { DedupGroup, Evidence } from "../lib/types";

type Topic = "delivery" | "cs" | "csv";

interface FixtureAnswers {
  expected_groups: {
    member_ids: string[];
    reason: "exact" | "near";
  }[];
  expected_echo: Record<string, string>;
  expected_representatives: Record<string, string>;
  expected_independent_by_topic: Record<Topic, number>;
  topic_of: Record<string, Topic>;
}

const fixtureEvidence = demoJson as Evidence[];
const answers = answersJson as FixtureAnswers;
const normalizedEvidence = applyNormalize(fixtureEvidence);
const groups = dedup(normalizedEvidence, scoringConfig);
const deduplicatedEvidence = applyDedup(normalizedEvidence, groups);

function findGroupForMember(memberId: string): DedupGroup {
  const group = groups.find((candidate) =>
    candidate.member_ids.includes(memberId),
  );

  if (!group) {
    throw new Error(`${memberId}의 중복 그룹을 찾을 수 없습니다.`);
  }

  return group;
}

function representativeCountByTopic(topic: Topic): number {
  return deduplicatedEvidence.filter(
    (item) =>
      item.is_group_representative &&
      answers.topic_of[item.evidence_id] === topic,
  ).length;
}

function maximumRepresentativesFromSameItem(topic: Topic): number {
  const counts = new Map<string, number>();

  deduplicatedEvidence
    .filter(
      (item) =>
        item.is_group_representative &&
        answers.topic_of[item.evidence_id] === topic,
    )
    .forEach((item) => {
      counts.set(
        item.source_item_id,
        (counts.get(item.source_item_id) ?? 0) + 1,
      );
    });

  return Math.max(...counts.values());
}

describe("문장 정규화", () => {
  it("표기 통일과 노이즈 제거를 입력 변경 없이 수행한다", () => {
    const original = fixtureEvidence[0];

    expect(
      normalize(
        "  ABCＤ https://seller.invalid/a @판매자 #배송 ㅋㅋㅋㅋ !!!! 😀😀  ",
      ),
    ).toBe("abcd ㅋㅋ ! 😀");
    expect(normalizedEvidence[0]).not.toBe(original);
    expect(original.text_norm).toBe("");
    expect(normalizedEvidence[0].text_norm.length).toBeGreaterThan(0);
  });

  it("세 글자 미만은 완전 일치할 때만 같은 문장으로 본다", () => {
    expect(trigramJaccard("가 나", "가나")).toBe(1);
    expect(trigramJaccard("가나", "가다")).toBe(0);
  });
});

describe("데모 Evidence 구성", () => {
  it("80건과 소스 분포 및 초기 파이프라인 값을 지킨다", () => {
    const sourceCounts = fixtureEvidence.reduce<Record<string, number>>(
      (counts, item) => {
        counts[item.source_group] = (counts[item.source_group] ?? 0) + 1;
        return counts;
      },
      {},
    );

    expect(fixtureEvidence).toHaveLength(80);
    expect(sourceCounts).toEqual({ youtube: 60, naver_blog: 20 });
    expect(
      new Set(
        fixtureEvidence
          .filter((item) => item.source_group === "youtube")
          .map((item) => item.source_item_id),
      ).size,
    ).toBe(5);
    expect(
      fixtureEvidence.every(
        (item) =>
          item.pain_cluster_id === null &&
          item.signals.length === 0 &&
          item.counter.length === 0 &&
          item.dedup_group_id === "" &&
          item.is_group_representative === false &&
          item.is_noise === false &&
          item.text_norm === "",
      ),
    ).toBe(true);
  });
});

describe("중복 제거", () => {
  it("정답에 명시한 exact와 near 멤버를 각각 한 그룹으로 묶는다", () => {
    for (const expectedGroup of answers.expected_groups) {
      const actualGroup = findGroupForMember(expectedGroup.member_ids[0]);

      expect(actualGroup.reason).toBe(expectedGroup.reason);
      expect(new Set(actualGroup.member_ids)).toEqual(
        new Set(expectedGroup.member_ids),
      );
    }
  });

  it("서로 다른 주제를 같은 그룹으로 합치지 않는다", () => {
    const mixedTopicGroups = groups.filter((group) => {
      const topics = new Set(
        group.member_ids.map((memberId) => answers.topic_of[memberId]),
      );
      return topics.size > 1;
    });

    expect(mixedTopicGroups).toHaveLength(0);
  });

  it("주제별 대표 수를 기대 독립 관측 수의 오차 1 이내로 만든다", () => {
    (["delivery", "cs", "csv"] as const).forEach((topic) => {
      const actualCount = representativeCountByTopic(topic);
      const expectedCount = answers.expected_independent_by_topic[topic];

      expect(Math.abs(actualCount - expectedCount)).toBeLessThanOrEqual(1);
    });
  });

  it("총 그룹 수, reason별 수, echo 흡수와 대표를 고정한다", () => {
    const reasonCounts = groups.reduce<Record<string, number>>(
      (counts, group) => {
        counts[group.reason] = (counts[group.reason] ?? 0) + 1;
        return counts;
      },
      {},
    );
    const echoCount = deduplicatedEvidence.filter((item) => {
      if (item.parent_id === null) {
        return false;
      }

      const parent = deduplicatedEvidence.find(
        (candidate) => candidate.evidence_id === item.parent_id,
      );
      return parent?.dedup_group_id === item.dedup_group_id;
    }).length;

    expect(groups).toHaveLength(40);
    expect(reasonCounts).toEqual({ exact: 4, near: 6, single: 30 });
    expect(Math.abs(echoCount - 10)).toBeLessThanOrEqual(2);

    for (const [description, representativeId] of Object.entries(
      answers.expected_representatives,
    )) {
      const representative = deduplicatedEvidence.find(
        (item) => item.evidence_id === representativeId,
      );

      expect(
        representative?.is_group_representative,
        `${description} 대표가 ${representativeId}여야 합니다.`,
      ).toBe(true);
    }

    for (const [echoId, parentId] of Object.entries(answers.expected_echo)) {
      expect(findGroupForMember(echoId).group_id).toBe(
        findGroupForMember(parentId).group_id,
      );
    }
  });

  it("대표의 단일 source_item 편중 상한과 CSV 소스 다양성을 지킨다", () => {
    const csvSourceGroups = new Set(
      deduplicatedEvidence
        .filter(
          (item) =>
            item.is_group_representative &&
            answers.topic_of[item.evidence_id] === "csv",
        )
        .map((item) => item.source_group),
    );

    expect(maximumRepresentativesFromSameItem("cs")).toBeLessThanOrEqual(11);
    expect(maximumRepresentativesFromSameItem("csv")).toBeLessThanOrEqual(9);
    expect(maximumRepresentativesFromSameItem("delivery")).toBeGreaterThanOrEqual(
      8,
    );
    expect(csvSourceGroups).toEqual(new Set(["youtube", "naver_blog"]));
  });
});
