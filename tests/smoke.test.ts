import { describe, expect, it } from "vitest";

describe("프로젝트 스모크 테스트", () => {
  it("기본 산술 연산이 동작한다", () => {
    expect(1 + 1).toBe(2);
  });
});
