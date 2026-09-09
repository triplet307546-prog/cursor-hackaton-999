"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import questions from "@/config/questions.json";

interface QuestionItem {
  label: string;
  query: string;
  slug: string;
}

interface RunRequest {
  question: string;
  slug?: string;
}

const QUESTIONS: QuestionItem[] = questions;

export default function AskPage() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customQuestion, setCustomQuestion] = useState("");

  // 질문을 보내고 run_id 를 받으면 바로 결과 화면으로 이동한다. 파이프라인은 서버가 뒤에서 돌린다.
  const startRun = async (body: RunRequest) => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { run_id?: string; error?: string };
      if (!response.ok || !payload.run_id) {
        throw new Error(payload.error ?? `요청 실패 (${response.status})`);
      }
      router.push(`/run/${payload.run_id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPending(false);
    }
  };

  const submitCustom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = customQuestion.trim();
    if (question === "") {
      setError("질문을 입력해 주세요.");
      return;
    }
    void startRun({ question });
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 py-12 text-zinc-900">
      <div className="w-full max-w-2xl">
        <header className="mb-8 text-center">
          <p className="text-sm font-medium uppercase tracking-widest text-zinc-500">PainRadar</p>
          <h1 className="mt-2 text-3xl font-semibold">무엇을 알아볼까요?</h1>
          <p className="mt-2 text-sm text-zinc-600">
            공개 댓글을 중복 없는 독립 관측으로 바꾸고, 불만이 아니라 행동 신호로 기회를 다시 매깁니다.
          </p>
        </header>

        <div className="flex flex-col gap-3">
          {QUESTIONS.map((item) => (
            <button
              key={item.slug}
              type="button"
              disabled={pending}
              onClick={() => void startRun({ question: item.label, slug: item.slug })}
              className="rounded-2xl border border-zinc-200 bg-white px-6 py-6 text-left text-lg font-medium shadow-sm transition hover:border-zinc-400 hover:shadow disabled:cursor-wait disabled:opacity-60"
            >
              {item.label}
            </button>
          ))}
        </div>

        <p className="mt-4 text-center text-xs text-zinc-500">출처: YouTube 댓글 (공식 API)</p>

        <details className="mt-6 rounded-xl border border-zinc-200 bg-white px-5 py-4">
          <summary className="cursor-pointer text-sm font-medium text-zinc-700">직접 입력</summary>
          <form onSubmit={submitCustom} className="mt-3 flex gap-2">
            <input
              type="text"
              value={customQuestion}
              onChange={(event) => setCustomQuestion(event.target.value)}
              placeholder="예: 셀러들이 광고비 때문에 겪는 문제는?"
              maxLength={300}
              disabled={pending}
              className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            />
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-60"
            >
              실행
            </button>
          </form>
        </details>

        {error && (
          <p className="mt-4 rounded-lg border border-rose-300 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            오류: {error}
          </p>
        )}
        {pending && <p className="mt-4 text-center text-sm text-zinc-500">실행을 준비하고 있습니다…</p>}
      </div>
    </main>
  );
}
