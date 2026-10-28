/**
 * WP-C3 statistics scaffold — paired-seed arm comparison.
 *
 * Design (frozen before any LLM arm runs):
 *   - PRIMARY per-event statistic: the paired difference vs the same-seed
 *     no-op twin (already in every OutcomeRecord as pairedNoOpDelta ∈ {−1,0,1});
 *     raw pass rate is reported alongside, never folded together.
 *   - ≥3 paired seeds per (arm, event); seeds are PAIRED across arms (same
 *     seed ⇒ same counterfactual twin).
 *   - UNCERTAINTY: cluster bootstrap over SCENARIOS (the exchangeable unit
 *     for generalization; events within a scenario are not independent).
 *     Percentile CIs, B = 10_000 resamples by default, seeded RNG so a
 *     published CI is byte-reproducible.
 *   - EFFECT SIZES: per-scenario-family raw success-rate difference vs no-op
 *     and vs the greedy arm; mean paired delta with cluster-bootstrap CI.
 *   - pass^k (τ-bench reliability secondary): probability that an arm passes
 *     the SAME event on ALL k paired seeds.
 *   - MULTIPLE COMPARISONS: Holm–Bonferroni across the arm-pair contrasts
 *     reported in the matrix (applied by the caller on the returned p-values;
 *     kept explicit so the paper can state exactly what was corrected).
 *
 * Everything here is pure functions over OutcomeRecords — no I/O — so the
 * statistics are unit-testable against synthetic records with known answers.
 */

import { createSeededRng } from '@active-collaboration/simulation';
import type { OutcomeRecord } from './schema.js';

// ---------------------------------------------------------------------------
// Cluster bootstrap (resampling scenarios with replacement)
// ---------------------------------------------------------------------------

export interface ClusterSpec {
  /** assignment of each observation index to a cluster id */
  clusters: string[];
}

/** Mean of x within each cluster, then the unweighted mean over clusters. */
export function clusterMean(x: number[], clusters: string[]): number {
  const byCluster = new Map<string, { sum: number; n: number }>();
  x.forEach((v, i) => {
    const c = clusters[i];
    const e = byCluster.get(c) ?? { sum: 0, n: 0 };
    e.sum += v; e.n += 1;
    byCluster.set(c, e);
  });
  let s = 0;
  for (const e of byCluster.values()) s += e.sum / e.n;
  return s / byCluster.size;
}

export interface BootstrapCI {
  estimate: number;
  lower: number;
  upper: number;
  resamples: number;
  seed: number;
}

/**
 * Percentile cluster-bootstrap CI for the cluster-level mean of `x`
 * (or of mean(x) − mean(y) when y is provided — paired by index).
 */
export function clusterBootstrapCI(
  x: number[],
  clusters: string[],
  opts: { resamples?: number; seed?: number; y?: number[] } = {},
): BootstrapCI {
  const B = opts.resamples ?? 10_000;
  const seed = opts.seed ?? 20261024;
  const rng = createSeededRng(seed);

  const uniqueClusters = [...new Set(clusters)];
  const idxByCluster = new Map<string, number[]>();
  clusters.forEach((c, i) => {
    const list = idxByCluster.get(c) ?? [];
    list.push(i);
    idxByCluster.set(c, list);
  });

  const means = uniqueClusters.map(c => {
    const indices = idxByCluster.get(c) ?? [];
    return indices.reduce((sum, i) => sum + x[i], 0) / indices.length;
  });

  const estimate = clusterMean(x, clusters);
  const stats: number[] = [];
  for (let b = 0; b < B; b++) {
    // Every draw is a separate bootstrap cluster, even when its id was already
    // drawn. Averaging the original observation labels would merge those draws
    // and lose their multiplicity (e.g. A,A,B must have mean (2A+B)/3).
    let sum = 0;
    for (let c = 0; c < uniqueClusters.length; c++) {
      sum += means[Math.floor(rng() * uniqueClusters.length)];
    }
    stats.push(sum / uniqueClusters.length);
  }
  stats.sort((a, b) => a - b);
  return {
    estimate,
    lower: stats[Math.floor(0.025 * B)],
    upper: stats[Math.floor(0.975 * B)],
    resamples: B,
    seed,
  };
}

/** Cluster-bootstrap CI for mean(x) − mean(y) (paired indices). */
export function pairedClusterBootstrapCI(
  x: number[],
  y: number[],
  clusters: string[],
  opts: { resamples?: number; seed?: number } = {},
): BootstrapCI {
  const diff = x.map((v, i) => v - y[i]);
  return clusterBootstrapCI(diff, clusters, opts);
}

// ---------------------------------------------------------------------------
// pass^k
// ---------------------------------------------------------------------------

/**
 * τ-bench-style pass^k: fraction of events where the arm passed on ALL k
 * paired repetitions. Records must be grouped per event with the same k.
 */
export function passAtK(records: OutcomeRecord[], k: number): { passK: number; eventsConsidered: number } {
  const byEvent = new Map<string, OutcomeRecord[]>();
  for (const r of records) {
    if (r.verdict.kind === 'unscorable') continue;
    const list = byEvent.get(`${r.scenarioId}:${r.eventId}`) ?? [];
    list.push(r);
    byEvent.set(`${r.scenarioId}:${r.eventId}`, list);
  }
  let events = 0;
  let passed = 0;
  for (const list of byEvent.values()) {
    if (list.length !== k) continue;
    events++;
    if (list.every(r => r.verdict.kind === 'pass')) passed++;
  }
  return { passK: events > 0 ? passed / events : 0, eventsConsidered: events };
}

// ---------------------------------------------------------------------------
// Arm comparison over a record matrix
// ---------------------------------------------------------------------------

export interface ArmEventStat {
  scenarioId: string;
  eventId: string;
  armId: string;
  seeds: number[];
  passRate: number;          // raw physical success rate over seeds
  meanPairedDelta: number;   // mean vs same-seed no-op twin
}

export interface ArmContrast {
  armA: string;
  armB: string;
  /** per-event paired difference of pass rates (A − B), same events/seeds */
  perEventDiff: Array<{ scenarioId: string; eventId: string; diff: number }>;
  ci: BootstrapCI;
  /** two-sided sign-test p-value across events (nonparametric, no exchangeability drama) */
  signTestP: number;
}

/** Aggregate an arm's records to per-event pass rates + paired deltas. */
export function armEventStats(records: OutcomeRecord[]): ArmEventStat[] {
  const byEvent = new Map<string, OutcomeRecord[]>();
  for (const r of records) {
    if (r.verdict.kind === 'unscorable') continue;
    const key = `${r.armId}|${r.scenarioId}|${r.eventId}`;
    const list = byEvent.get(key) ?? [];
    list.push(r);
    byEvent.set(key, list);
  }
  const out: ArmEventStat[] = [];
  for (const [key, list] of byEvent) {
    const [armId, scenarioId, eventId] = key.split('|');
    const passes = list.filter(r => r.verdict.kind === 'pass').length;
    const deltas = list.map(r => r.pairedNoOpDelta ?? 0);
    out.push({
      scenarioId, eventId, armId,
      seeds: [...new Set(list.map(r => r.seed))],
      passRate: passes / list.length,
      meanPairedDelta: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    });
  }
  return out.sort((a, b) => a.eventId.localeCompare(b.eventId));
}

/** Two-sided exact sign test p-value over per-event differences. */
function signTestPValue(diffs: number[]): number {
  const nonZero = diffs.filter(d => d !== 0);
  const n = nonZero.length;
  const plus = nonZero.filter(d => d > 0).length;
  if (n === 0) return 1;
  // exact binomial two-sided
  const binom = (nn: number, kk: number): number => {
    let c = 1;
    for (let i = 0; i < kk; i++) c = c * (nn - i) / (i + 1);
    return c;
  };
  let pTail = 0;
  const kMin = Math.min(plus, n - plus);
  for (let k = 0; k <= kMin; k++) pTail += binom(n, k);
  return Math.min(1, 2 * pTail / 2 ** n);
}

/** Contrast two arms over their common (event, seed) pairs. */
export function contrastArms(
  recordsA: OutcomeRecord[],
  recordsB: OutcomeRecord[],
  armA: string,
  armB: string,
  opts: { resamples?: number; seed?: number } = {},
): ArmContrast {
  const keyOf = (r: OutcomeRecord) => `${r.scenarioId}|${r.eventId}|${r.seed}`;
  const bBy = new Map(recordsB.filter(r => r.verdict.kind !== 'unscorable').map(r => [keyOf(r), r]));
  const pairs: Array<{ r: OutcomeRecord; s: OutcomeRecord }> = [];
  for (const r of recordsA) {
    if (r.verdict.kind === 'unscorable') continue;
    const s = bBy.get(keyOf(r));
    if (s) pairs.push({ r, s });
  }
  const perEventMap = new Map<string, { scenarioId: string; eventId: string; diffSum: number; n: number }>();
  const xs: number[] = [];
  const clusters: string[] = [];
  for (const { r, s } of pairs) {
    const passA = r.verdict.kind === 'pass' ? 1 : 0;
    const passB = s.verdict.kind === 'pass' ? 1 : 0;
    xs.push(passA - passB);
    clusters.push(r.scenarioId);
    const k = `${r.scenarioId}|${r.eventId}`;
    const e = perEventMap.get(k) ?? { scenarioId: r.scenarioId, eventId: r.eventId, diffSum: 0, n: 0 };
    e.diffSum += passA - passB; e.n += 1;
    perEventMap.set(k, e);
  }
  const perEventDiff = [...perEventMap.values()]
    .map(e => ({ scenarioId: e.scenarioId, eventId: e.eventId, diff: e.diffSum / e.n }))
    .sort((a, b) => a.eventId.localeCompare(b.eventId));
  return {
    armA, armB, perEventDiff,
    ci: clusterBootstrapCI(xs, clusters, opts),
    signTestP: signTestPValue(perEventDiff.map(e => e.diff)),
  };
}

// ---------------------------------------------------------------------------
// Holm–Bonferroni
// ---------------------------------------------------------------------------

export interface AdjustedP { p: number; adjusted: number; reject: boolean; rank: number }

/** Holm–Bonferroni step-down adjustment over a family of p-values. */
export function holmBonferroni(pValues: number[], alpha = 0.05): AdjustedP[] {
  const indexed = pValues.map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p);
  const m = pValues.length;
  const out: AdjustedP[] = new Array(m);
  let maxAdj = 0;
  indexed.forEach((e, rank) => {
    const adj = Math.min(1, (m - rank) * e.p);
    maxAdj = Math.max(maxAdj, adj);
    out[e.i] = { p: e.p, adjusted: maxAdj, reject: maxAdj <= alpha, rank };
  });
  return out;
}
