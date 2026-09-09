import type { Band, PainCluster, ScoringConfig, SignalType } from "../types";

// 사다리 아래(불만)에서 위(결제)로 갈수록 강한 행동 신호다.
export const RUNG_ORDER: SignalType[] = [
  "complaint",
  "workaround",
  "alternative_search",
  "switching",
  "payment",
];

const BAND_RANK: Record<Band, number> = { High: 3, Medium: 2, Low: 1 };

export function rungIndex(t: SignalType): number {
  return RUNG_ORDER.indexOf(t);
}

export function topRung(
  ladder: Record<SignalType, number>,
  minObs: number,
): SignalType {
  for (let index = RUNG_ORDER.length - 1; index >= 0; index--) {
    const signalType = RUNG_ORDER[index];
    if (ladder[signalType] >= minObs) {
      return signalType;
    }
  }
  return "complaint";
}

function stepDown(band: Band): Band {
  if (band === "High") return "Medium";
  if (band === "Medium") return "Low";
  return "Low";
}

function counterRatio(cluster: PainCluster): number {
  const independent = cluster.independent_observations;
  if (independent <= 0) return 0;
  const rebuttal =
    cluster.counter.already_solved + cluster.counter.alternative_sufficient;
  return rebuttal / independent;
}

function notExperiencedRatio(cluster: PainCluster): number {
  const independent = cluster.independent_observations;
  if (independent <= 0) return 0;
  return cluster.counter.not_experienced / independent;
}

export function baseOpportunityBand(cluster: PainCluster, cfg: ScoringConfig): Band {
  const top = topRung(cluster.ladder, cfg.min_rung_obs);
  const topIndex = rungIndex(top);

  if (
    topIndex >= rungIndex(cfg.opp_high.min_rung) &&
    cluster.independent_observations >= cfg.opp_high.min_ind &&
    cluster.source_groups >= cfg.opp_high.min_source_groups
  ) {
    return "High";
  }

  if (
    topIndex >= rungIndex(cfg.opp_medium.min_rung) &&
    cluster.independent_observations >= cfg.opp_medium.min_ind
  ) {
    return "Medium";
  }

  return "Low";
}

export function opportunityBand(c: PainCluster, cfg: ScoringConfig): Band {
  const band = baseOpportunityBand(c, cfg);
  if (counterRatio(c) >= cfg.counter_downgrade_ratio) {
    return stepDown(band);
  }
  return band;
}

function baseConfidenceBand(cluster: PainCluster, cfg: ScoringConfig): Band {
  if (
    cluster.independent_observations >= cfg.conf_high.min_ind &&
    cluster.source_groups >= cfg.conf_high.min_source_groups &&
    cluster.inflation < cfg.conf_high.max_inflation &&
    notExperiencedRatio(cluster) < cfg.conf_high.max_not_experienced
  ) {
    return "High";
  }

  if (cluster.independent_observations >= cfg.conf_medium.min_ind) {
    return "Medium";
  }

  return "Low";
}

export function confidenceBand(c: PainCluster, cfg: ScoringConfig): Band {
  const band = baseConfidenceBand(c, cfg);
  if (c.same_item_ratio >= cfg.same_item_penalty_ratio) {
    return stepDown(band);
  }
  return band;
}

function compareClusterId(left: PainCluster, right: PainCluster): number {
  return left.cluster_id.localeCompare(right.cluster_id);
}

function compareRankBefore(left: PainCluster, right: PainCluster): number {
  if (right.raw_mentions !== left.raw_mentions) {
    return right.raw_mentions - left.raw_mentions;
  }
  return compareClusterId(left, right);
}

function compareRankAfter(left: PainCluster, right: PainCluster): number {
  const opportunityDiff = BAND_RANK[right.opportunity] - BAND_RANK[left.opportunity];
  if (opportunityDiff !== 0) return opportunityDiff;

  const rungDiff = rungIndex(right.top_rung) - rungIndex(left.top_rung);
  if (rungDiff !== 0) return rungDiff;

  if (right.independent_observations !== left.independent_observations) {
    return right.independent_observations - left.independent_observations;
  }

  if (right.source_groups !== left.source_groups) {
    return right.source_groups - left.source_groups;
  }

  return compareClusterId(left, right);
}

export function rank(
  clusters: PainCluster[],
  cfg: ScoringConfig,
): PainCluster[] {
  const scored = clusters.map((cluster) => {
    const top_rung = topRung(cluster.ladder, cfg.min_rung_obs);
    const withTopRung = { ...cluster, top_rung };
    return {
      ...withTopRung,
      opportunity: opportunityBand(withTopRung, cfg),
      confidence: confidenceBand(withTopRung, cfg),
    };
  });

  const beforeOrder = [...scored].sort(compareRankBefore);
  const beforeById = new Map(
    beforeOrder.map((cluster, index) => [cluster.cluster_id, index + 1]),
  );

  return [...scored]
    .sort(compareRankAfter)
    .map((cluster, index) => ({
      ...cluster,
      rank_before: beforeById.get(cluster.cluster_id) ?? index + 1,
      rank_after: index + 1,
    }));
}
