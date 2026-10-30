/**
 * #9 / WP-B3 — human spot-check instrument.
 *
 * Builds a stratified review packet for predicate-validity spot checks:
 * per event, a human reviewer sees the scenario context, the evaluator's
 * envelope WITH its measured rationale, a trajectory summary and the
 * instrument's verdict, then answers three questions (envelope reasonable?
 * verdict correct? task physically meaningful?). Agreement with the
 * instrument is scored by Cohen's κ on the verdict question.
 *
 * Scope discipline (frozen contract): human ratings validate PREDICATE
 * plausibility — they never legitimize physical ground truth, and the κ
 * number is reported as instrument evidence, not as a replacement for the
 * physics. Selection is deterministic (content-hash order) so the packet is
 * reproducible and cannot be cherry-picked after seeing results.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from './scenario-definitions.js';
import { resolveEventParameter } from './paper-experiment-runner.js';
import { deriveEnvelopeSpec } from './envelope.js';
import { loadFrozenOutcomeQueue, FROZEN_OUTCOME_EXCLUDED_EVENT_IDS } from './frozen-queue.js';
import { buildHoldoutManifest } from './holdout.js';
import { runOutcomeFixture } from './runner.js';
import { getResultsBaseDir } from './result-persistence.js';
import type { TestEventDef } from './types.js';

export const HUMAN_AUDIT_VERSION = '1.0.0';
/** pre-registered at tool build time, before any rater sees the packet */
export const AUDIT_SAMPLE_FROZEN_AT = '2026-10-25T14:30:00Z';

export interface AuditItem {
  eventId: string;
  scenarioId: string;
  stratum: string;
  event: TestEventDef;
  spec: ReturnType<typeof deriveEnvelopeSpec>;
  instrumentVerdict: string;
  verdictExplanation: string;
  trajectorySummary: { enteredAt: number | null; heldFor: number | null; finalValue: number | null; horizonSec: number };
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function holdoutSplitOf(scenarioId: string, eventId: string): string {
  const m = buildHoldoutManifest();
  if (scenarioId === m.scenarioTransferHoldout) return 'scenario-transfer';
  if (m.holdoutEventIds.includes(eventId)) return 'template-holdout';
  return 'train';
}

/** Deterministic stratified sample: positives by (scenario × family), negatives, plus the 3 edge-excluded boundary cases. */
export function buildAuditSample(opts: { positives?: number; negatives?: number } = {}): AuditItem[] {
  const wantPos = opts.positives ?? 25;
  const wantNeg = opts.negatives ?? 10;
  const queue = loadFrozenOutcomeQueue();
  const items: AuditItem[] = [];

  const makeItem = (scenarioId: string, eventId: string, stratum: string): AuditItem => {
    const scenario = SCENARIOS[scenarioId as keyof typeof SCENARIOS];
    const event = scenario.events.find(e => e.id === eventId)!;
    const spec = deriveEnvelopeSpec(event, scenarioId);
    let verdict = 'n/a (tier not simulated)';
    let explanation = spec.naReason ?? '';
    let traj = { enteredAt: null, heldFor: null, finalValue: null, horizonSec: 0 };
    if (spec.tier === 'physical') {
      const r = runOutcomeFixture({ scenarioId, eventId, policyId: 'no-op', seed: 11 });
      verdict = `${r.verdict.kind}${r.verdict.failureMode ? `/${r.verdict.failureMode}` : ''}`;
      explanation = r.verdict.explanation;
      traj = {
        enteredAt: r.verdict.enteredEnvelopeAtSec ?? null,
        heldFor: r.verdict.heldForSec ?? null,
        finalValue: r.trajectory.samples.at(-1)?.v ?? null,
        horizonSec: r.trajectory.horizonSec,
      };
    }
    return { eventId, scenarioId, stratum, event, spec, instrumentVerdict: verdict, verdictExplanation: explanation, trajectorySummary: traj };
  };

  // positives: stratify by scenario, deterministic hash order within stratum
  const positives = queue.filter(q => !q.isNegativeEvent);
  const byScenario = new Map<string, typeof positives>();
  for (const q of positives) {
    const list = byScenario.get(q.scenarioId) ?? [];
    list.push(q);
    byScenario.set(q.scenarioId, list);
  }
  const perScenario = Math.max(2, Math.floor(wantPos / byScenario.size));
  for (const [scenarioId, list] of [...byScenario.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...list].sort((a, b) =>
      sha(`${a.eventId}|audit|${HUMAN_AUDIT_VERSION}`).localeCompare(sha(`${b.eventId}|audit|${HUMAN_AUDIT_VERSION}`)));
    for (const q of ordered.slice(0, perScenario)) {
      items.push(makeItem(scenarioId, q.eventId, `positive/${holdoutSplitOf(scenarioId, q.eventId)}`));
    }
  }

  // negatives: deterministic top-N
  const negatives = queue.filter(q => q.isNegativeEvent)
    .sort((a, b) => sha(`${a.eventId}|audit|${HUMAN_AUDIT_VERSION}`).localeCompare(sha(`${b.eventId}|audit|${HUMAN_AUDIT_VERSION}`)));
  for (const q of negatives.slice(0, wantNeg)) {
    items.push(makeItem(q.scenarioId, q.eventId, 'negative'));
  }

  // boundary cases: the 3 edge-excluded events (predicate-validity pressure points)
  for (const eventId of FROZEN_OUTCOME_EXCLUDED_EVENT_IDS) {
    const scenarioId = Object.keys(SCENARIOS).find(sid =>
      (SCENARIOS[sid as keyof typeof SCENARIOS].events ?? []).some(e => e.id === eventId)
      && ['single-room', 'apartment', 'campus', 'factory', 'hospital', 'smart-city'].includes(sid));
    if (scenarioId) items.push(makeItem(scenarioId, eventId, 'edge-excluded'));
  }

  return items;
}

export function renderAuditPacket(items: AuditItem[]): string {
  const lines: string[] = [];
  lines.push('# B3 Human Audit Packet — physical-outcome predicate validity');
  lines.push('');
  lines.push(`version ${HUMAN_AUDIT_VERSION} · sample frozen ${AUDIT_SAMPLE_FROZEN_AT} · ${items.length} items`);
  lines.push('');
  lines.push('For each item answer THREE questions (yes/no/unsure):');
  lines.push('- **Q1 envelope**: Is the safe envelope (and its deadline/hold) a reasonable operational definition of "physical goal restored" for this event?');
  lines.push('- **Q2 verdict**: Is the instrument verdict correct for the described behavior?');
  lines.push('- **Q3 admission**: Is this event physically meaningful for evaluating embodied agents (vs. noise / unmeasurable)?');
  lines.push('');
  lines.push('Record answers in `audit-ratings.json` (array of {eventId, rater, q1, q2, q3} with "agree"/"disagree"/"unsure") and run the κ scaffold in human-audit.vitest.test.ts.');
  lines.push('');
  for (const [i, it] of items.entries()) {
    const { parameter, value } = resolveEventParameter(it.event);
    const e = it.spec.envelope;
    lines.push(`---`);
    lines.push(`## ${i + 1}. ${it.eventId} [${it.stratum}]`);
    lines.push('');
    lines.push(`- scenario: **${it.scenarioId}** · zone \`${it.event.zoneId}\` · type \`${it.event.type}\` · severity ${it.event.severity}`);
    lines.push(`- injection: \`${parameter} = ${JSON.stringify(value)}\` (spatial field write at event zone)`);
    lines.push(`- evaluator envelope: ${e ? `\`${parameter} ∈ [${e.lower}, ${e.upper}]\` at \`${e.zoneId}\`, deadline ${it.spec.deadlineSec}s, hold ${it.spec.holdSec}s` : 'none (tier not physically scored)'}`);
    lines.push(`- rationale: ${it.spec.derivation.note} (calibration ${it.spec.calibrationVersion})`);
    lines.push(`- no-op behavior: entered envelope at ${it.trajectorySummary.enteredAt ?? '—'}s, held ${it.trajectorySummary.heldFor ?? '—'}s, final value ${it.trajectorySummary.finalValue ?? '—'} over ${it.trajectorySummary.horizonSec}s`);
    lines.push(`- instrument verdict (no-op): **${it.instrumentVerdict}** — ${it.verdictExplanation}`);
    lines.push('');
    lines.push(`- Q1 envelope reasonable? ____ · Q2 verdict correct? ____ · Q3 admit? ____`);
    lines.push('');
  }
  return lines.join('\n');
}

export interface Rating { eventId: string; rater: string; q1: string; q2: string; q3: string }

/** Cohen's κ between a rater and the instrument on Q2 (agree/disagree). */
export function cohensKappaVsInstrument(
  ratings: Rating[],
  instrumentPositiveByEvent: Record<string, boolean>,
  rater: string,
): { kappa: number; n: number; observed: number } {
  const rows = ratings.filter(r => r.rater === rater && r.q2 !== 'unsure');
  const n = rows.length;
  if (n === 0) return { kappa: NaN, n: 0, observed: NaN };
  let bothAgreeCorrect = 0; // rater says verdict correct AND instrument verdict "pass-like"
  let raterCorrect = 0;
  let instrPositive = 0;
  let observedAgree = 0;
  for (const r of rows) {
    const instrPass = instrumentPositiveByEvent[r.eventId] ?? false;
    const raterSaysCorrect = r.q2 === 'agree';
    if (raterSaysCorrect) raterCorrect++;
    if (instrPass) instrPositive++;
    if ((raterSaysCorrect && instrPass) || (!raterSaysCorrect && !instrPass)) {
      observedAgree++;
      if (raterSaysCorrect && instrPass) bothAgreeCorrect++;
    }
  }
  const pO = observedAgree / n;
  const pRaterYes = raterCorrect / n;
  const pInstrYes = instrPositive / n;
  const pE = pRaterYes * pInstrYes + (1 - pRaterYes) * (1 - pInstrYes);
  const kappa = pE === 1 ? 1 : (pO - pE) / (1 - pE);
  void bothAgreeCorrect;
  return { kappa: Number(kappa.toFixed(4)), n, observed: Number(pO.toFixed(4)) };
}

export function writeAuditArtifacts(items: AuditItem[]): string {
  const dir = join(getResultsBaseDir(), 'outcome-gm', 'human-audit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'audit-packet.md'), renderAuditPacket(items));
  writeFileSync(join(dir, 'audit-sample.json'), JSON.stringify({
    version: HUMAN_AUDIT_VERSION,
    frozenAt: AUDIT_SAMPLE_FROZEN_AT,
    items: items.map(i => ({
      eventId: i.eventId, scenarioId: i.scenarioId, stratum: i.stratum,
      instrumentVerdict: i.instrumentVerdict,
    })),
  }, null, 2));
  if (!existsSync(join(dir, 'audit-ratings.json'))) {
    writeFileSync(join(dir, 'audit-ratings.json'), JSON.stringify({ note: 'fill per rater: [{eventId, rater, q1, q2, q3}]', ratings: [] as Rating[] }, null, 2));
  }
  return dir;
}

export function readRatings(dir: string): Rating[] {
  const raw = JSON.parse(readFileSync(join(dir, 'audit-ratings.json'), 'utf-8')) as { ratings?: Rating[] };
  return raw.ratings ?? [];
}
