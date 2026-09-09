import type { Evidence } from "../types";

const API_BASE = "https://www.googleapis.com/youtube/v3";

export const REPLY_NOTE = "답글은 스레드당 상위 5개까지";

export interface Question {
  label: string;
  query: string;
  slug: string;
}

interface CommentResource {
  id: string;
  snippet?: {
    textDisplay?: string;
    publishedAt?: string;
    likeCount?: number;
  };
}

export interface ThreadItem {
  snippet?: { topLevelComment?: CommentResource };
  replies?: { comments?: CommentResource[] };
}

/** 키가 로그·에러·URL 출력에 섞여 나가지 않게 가린다. */
export function redact(text: string): string {
  const key = process.env.YOUTUBE_API_KEY;
  return key ? text.split(key).join("***") : text;
}

export class YouTubeApiError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

function requireApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new Error("YOUTUBE_API_KEY 환경변수가 필요합니다.");
  }
  return key;
}

async function callApi<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set("key", requireApiKey());

  const response = await fetch(url);
  const body = (await response.json()) as {
    error?: { message?: string; errors?: { reason?: string }[] };
  };

  if (!response.ok) {
    const reason = body.error?.errors?.[0]?.reason ?? String(response.status);
    throw new YouTubeApiError(reason, redact(body.error?.message ?? response.statusText));
  }
  return body as T;
}

export async function searchVideos(query: string, videos: number): Promise<string[]> {
  const body = await callApi<{ items?: { id?: { videoId?: string } }[] }>("search", {
    part: "snippet",
    type: "video",
    relevanceLanguage: "ko",
    regionCode: "KR",
    maxResults: String(videos),
    q: query,
  });
  const ids = (body.items ?? [])
    .map((item) => item.id?.videoId)
    .filter((id): id is string => Boolean(id));
  // 같은 영상이 두 번 오면 evidence_id 가 겹치므로 여기서 한 번만 남긴다.
  return [...new Set(ids)];
}

export async function fetchThreads(videoId: string, perVideo: number): Promise<ThreadItem[]> {
  // API 사양상 replies.comments 는 스레드당 최대 5개다. comments.list 로 더 받지 않는다.
  const body = await callApi<{ items?: ThreadItem[] }>("commentThreads", {
    part: "snippet,replies",
    videoId,
    maxResults: String(perVideo),
    textFormat: "plainText",
    order: "relevance",
  });
  return body.items ?? [];
}

function toEvidenceItem(
  videoId: string,
  comment: CommentResource,
  threadId: string,
  parentId: string | null,
): Evidence {
  return {
    evidence_id: `yt:${comment.id}`,
    source: "youtube_comment",
    source_group: "youtube",
    source_item_id: `yt:video:${videoId}`,
    thread_id: threadId,
    parent_id: parentId,
    url: `https://www.youtube.com/watch?v=${videoId}&lc=${comment.id}`,
    published_at: comment.snippet?.publishedAt ?? null,
    // textOriginal 은 작성자 본인에게만 오므로 textDisplay 를 쓴다.
    text_raw: comment.snippet?.textDisplay ?? "",
    text_norm: "",
    engagement: { likes: comment.snippet?.likeCount ?? 0, replies: 0 },
    access_policy: "official_api",
    dedup_group_id: "",
    is_group_representative: false,
    pain_cluster_id: null,
    is_noise: false,
    signals: [],
    counter: [],
  };
}

/** 작성자 필드(authorDisplayName, authorChannelId 등)는 여기서 폐기한다. */
export function toEvidence(videoId: string, item: ThreadItem): Evidence[] {
  const top = item.snippet?.topLevelComment;
  if (!top?.id) {
    return [];
  }
  // dedup 의 thread_echo 는 parent_id 를 evidence_id 로 되짚으므로 접두사를 붙인 형태여야 한다.
  const threadId = `yt:${top.id}`;
  const replies = item.replies?.comments ?? [];
  return [
    toEvidenceItem(videoId, top, threadId, null),
    ...replies
      .filter((reply) => Boolean(reply?.id))
      .map((reply) => toEvidenceItem(videoId, reply, threadId, threadId)),
  ];
}

export function resolveQuery(
  slug: string,
  queryFlag: string | null,
  questions: Question[],
): string {
  const fromConfig = questions.find((question) => question.slug === slug)?.query ?? null;

  if (fromConfig === null) {
    if (queryFlag === null) {
      throw new Error(
        `slug "${slug}" 가 config/questions.json 에 없습니다. --query 로 백업 검색어를 주세요.`,
      );
    }
    return queryFlag;
  }
  if (queryFlag !== null && queryFlag !== fromConfig) {
    throw new Error(
      `--query 가 config/questions.json 의 값과 다릅니다.\n  questions.json: ${fromConfig}\n  --query: ${queryFlag}`,
    );
  }
  return fromConfig;
}

export interface CollectOptions {
  videos: number;
  perVideo: number;
  maxTotal: number;
}

/**
 * 검색 → 영상별 댓글 수집. 웹 라이브 실행이 쓴다.
 * 댓글이 꺼진 영상은 건너뛰고, quota 가 끊기면 거기까지 모은 것으로 끝낸다.
 * 상한(maxTotal)은 스레드 단위로 끊는다. 중간에서 자르면 답글이 부모 없이 남아 스레드 에코 판정이 흔들린다.
 * CLI(scripts/fetch-youtube.ts)는 videos_<slug>.json 재사용과 quota 로그가 붙은 자체 루프를 쓴다.
 */
export async function collectEvidence(
  query: string,
  options: CollectOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<Evidence[]> {
  const videoIds = await searchVideos(query, options.videos);
  const collected: Evidence[] = [];

  for (const [index, videoId] of videoIds.entries()) {
    onProgress?.(index + 1, videoIds.length);
    try {
      for (const item of await fetchThreads(videoId, options.perVideo)) {
        collected.push(...toEvidence(videoId, item));
        // 스레드 단위로 끊는다. 한 스레드 중간에서 자르면 답글이 부모 없이 남는다.
        if (collected.length >= options.maxTotal) {
          break;
        }
      }
    } catch (error) {
      if (error instanceof YouTubeApiError && error.reason === "commentsDisabled") {
        continue;
      }
      if (error instanceof YouTubeApiError && error.reason === "quotaExceeded") {
        break;
      }
      throw error;
    }
    if (collected.length >= options.maxTotal) {
      break;
    }
  }

  return collected;
}
