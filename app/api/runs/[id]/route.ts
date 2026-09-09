import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

const RUNS_DIR = join(process.cwd(), "data", "runs");
// 경로 탈출(../ 등)을 막기 위해 파일명에 쓸 수 있는 문자만 허용한다.
const ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

const NO_STORE = { "Cache-Control": "no-store" };

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

async function readStatus(id: string): Promise<unknown | null> {
  const status = await readJsonFile(join(RUNS_DIR, `${id}.status.json`));
  if (status !== null) {
    return status;
  }
  // CLI 가 만든 결과(fixture.json 등)는 상태 파일이 없다. 결과가 있으면 끝난 것으로 본다.
  const run = await readJsonFile(join(RUNS_DIR, `${id}.json`));
  if (run !== null) {
    return { step: "done", done: true };
  }
  return null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "잘못된 id 입니다." }, { status: 400 });
  }

  const wantsStatus = request.nextUrl.searchParams.get("status") === "1";
  const payload = wantsStatus
    ? await readStatus(id)
    : await readJsonFile(join(RUNS_DIR, `${id}.json`));

  if (payload === null) {
    return NextResponse.json(
      { error: "실행 결과를 찾을 수 없습니다." },
      { status: 404, headers: NO_STORE },
    );
  }

  return NextResponse.json(payload, { headers: NO_STORE });
}
