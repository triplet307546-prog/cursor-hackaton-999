export type SourceGroup = 'youtube' | 'naver_blog' | 'naver_kin' | 'csv';
export type AccessPolicy = 'official_api' | 'user_provided' | 'not_collected';
export type SignalType = 'complaint' | 'workaround' | 'alternative_search' | 'switching' | 'payment';
export type CounterType = 'already_solved' | 'alternative_sufficient' | 'not_experienced';
export type Band = 'High' | 'Medium' | 'Low';
export type RunMode = 'live' | 'cached' | 'fixture';

export interface Signal {
  type: SignalType;
  quote: string;
  confidence: number;
  used_in_ranking: boolean;
}

export interface CounterSignal {
  type: CounterType;
  quote: string;
  confidence: number;
}

export interface Evidence {
  evidence_id: string;
  source: string;
  source_group: SourceGroup;
  source_item_id: string;
  thread_id: string;
  parent_id: string | null;
  url: string;
  published_at: string | null;
  text_raw: string;
  text_norm: string;
  engagement: { likes?: number; replies?: number };
  access_policy: AccessPolicy;
  dedup_group_id: string;
  is_group_representative: boolean;
  pain_cluster_id: string | null;
  is_noise: boolean;
  signals: Signal[];
  counter: CounterSignal[];
}

export interface DedupGroup {
  group_id: string;
  representative_id: string;
  member_ids: string[];
  reason: 'exact' | 'near' | 'thread_echo' | 'single';
  similarity?: number;
}

export interface Theme {
  cluster_id: string;
  title: string;
  description: string;
}

export interface PainCluster {
  cluster_id: string;
  title: string;
  description: string;
  raw_mentions: number;
  independent_observations: number;
  source_groups: number;
  source_items: number;
  same_item_ratio: number;
  inflation: number;
  ladder: Record<SignalType, number>;
  top_rung: SignalType;
  counter: Record<CounterType, number>;
  supporting_evidence: number;
  counter_evidence: number;
  opportunity: Band;
  confidence: Band;
  rank_before: number;
  rank_after: number;
  ranking_reasons: string[];
  representative_ids: string[];
}

export interface SourceStatus {
  source_group: SourceGroup | 'naver_cafe' | 'blind';
  label: string;
  policy: AccessPolicy;
  fetched: number;
  note?: string;
}

export interface ScoringConfig {
  min_rung_obs: number;
  opp_high: { min_ind: number; min_source_groups: number; min_rung: SignalType };
  opp_medium: { min_ind: number; min_rung: SignalType };
  counter_downgrade_ratio: number;
  conf_high: { min_ind: number; min_source_groups: number; max_inflation: number; max_not_experienced: number };
  conf_medium: { min_ind: number };
  same_item_penalty_ratio: number;
  near_dup_threshold: number;
  thread_echo_threshold: number;
  signal_min_confidence: number;
  batch_size: number;
}

export interface BaselineResult {
  computed_at: string;
  method: 'llm_whole_dump';
  runs: { ranking: string[]; claimed_counts: Record<string, number> }[];
  input_tokens: number[];
  painradar_input_tokens: number;
}

export interface ResearchRun {
  run_id: string;
  question: string;
  created_at: string;
  mode: RunMode;
  sources: SourceStatus[];
  funnel: {
    raw_mentions: number;
    independent_observations: number;
    behavior_signals: number;
    opportunities: number;
  };
  clusters: PainCluster[];
  evidence: Evidence[];
  dedup_groups: DedupGroup[];
  config_snapshot: ScoringConfig;
  // promo/contentless 는 퍼널 첫 숫자(527)와 클러스터 합계의 차이를 화면이 설명하기 위한 값이다. 예전 run JSON 에는 없다.
  llm: { mode: 'mock' | 'real'; dropped_quotes: number; promo_dropped?: number; contentless_dropped?: number };
  baseline?: BaselineResult;
}
