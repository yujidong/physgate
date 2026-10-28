/**
 * G-M measurement gate report (A4).
 *
 * Runs the full fixture matrix over the gate scenarios (single-room +
 * apartment), checks every manual expectation, and validates every admitted
 * event for:
 *   - reachability: the independent reference policy PASSES (the event's
 *     safe state is achievable by actuation within the deadline);
 *   - discriminability: the no-op twin FAILS (an arm that does nothing can
 *     never score — §8.5's headline defect);
 *   - unit: one record per scenario-event-run (by construction; asserted by
 *     the determinism suite).
 *
 * The gate verdict gates PAPER HEADLINE NUMBERS: until gatePass === true, no
 * arm comparison may be reported (AGENT_EXCHANGE §4 WP-A).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from '../scenario-definitions.js';
import { resolveEventParameter } from '../paper-experiment-runner.js';
import { getResultsBaseDir } from '../result-persistence.js';
import { deriveEnvelopeSpec, ENVELOPE_SPEC_VERSION } from './envelope.js';
import { runOutcomeFixture } from './runner.js';
import { hasWrongWayChannel } from './policies.js';
import { MANUAL_EXPECTATIONS } from './expectations.js';
import type { FixtureExpectation } from './expectations.js';
import { CALIBRATION_VERSION } from './calibration.js';
import { OUTCOME_SCHEMA_VERSION, PREDICATE_VERSION } from './schema.js';
import type { OutcomeRecord } from './schema.js';

export const GM_GATE_SCENARIOS = ['single-room', 'apartment'] as const;

export interface EventAdmission {
  scenarioId: string;
  eventId: string;
  eventType: string;
  parameter: string;
  tier: string;
  naReason?: string;
  isNegativeEvent: boolean;
  admitted: boolean;
  admissionReason: string;
  reachability: boolean | null;
  discriminability: boolean | null;
  runs: Array<{ policyId: string; kind: string; failureMode: string | null; runId: string; traceHash: string }>;
}

export interface ExpectationCheck {
  expectation: FixtureExpectation;
  actual: { kind: string; failureMode: string | null };
  match: boolean;
  actualRunId?: string;
}

export interface GmGateReport {
  generatedAt: string;
  schemaVersion: string;
  predicateVersion: string;
  envelopeSpecVersion: string;
  calibrationVersion: string;
  seed: number;
  scenarios: string[];
  gatePass: boolean;
  expectationChecks: ExpectationCheck[];
  events: EventAdmission[];
  summary: {
    totalEvents: number;
    admittedPositive: number;
    admittedNegative: number;
    excludedNaturalRecovery: number;
    excludedNonPhysical: number;
    excludedNoEnvelope: number;
    excludedAlreadySafe: number;
    unreachable: number;
    nonDiscriminative: number;
    expectationMismatches: number;
  };
}

function policiesFor(scenarioId: string, eventId: string): string[] {
  const scenario = SCENARIOS[scenarioId as keyof typeof SCENARIOS];
  const event = scenario.events.find(e => e.id === eventId)!;
  const spec = deriveEnvelopeSpec(event, scenarioId);
  const base = ['no-op', 'reference'];
  if (spec.tier !== 'physical') return spec.isNegativeEvent ? base : ['no-op'];
  if (spec.isNegativeEvent) return [...base, 'wrong-way'];
  const extra: string[] = ['late-recovery', 'transient-recovery'];
  if (hasWrongWayChannel(spec)) extra.push('wrong-way');
  if (scenario.zones.length >= 2) extra.push('wrong-zone');
  return [...base, ...extra];
}

export function buildGmGateReport(
  scenarioIds: readonly string[] = GM_GATE_SCENARIOS,
  seed = 7,
): { report: GmGateReport; records: OutcomeRecord[] } {
  const events: EventAdmission[] = [];
  const allRecords: OutcomeRecord[] = [];

  for (const scenarioId of scenarioIds) {
    const scenario = SCENARIOS[scenarioId as keyof typeof SCENARIOS];
    for (const event of scenario.events) {
      const spec = deriveEnvelopeSpec(event, scenarioId);
      const { parameter } = resolveEventParameter(event);
      const runs: EventAdmission['runs'] = [];
      const records = new Map<string, OutcomeRecord>();

      for (const policyId of policiesFor(scenarioId, event.id)) {
        const record = runOutcomeFixture({ scenarioId, eventId: event.id, policyId, seed });
        records.set(policyId, record);
        allRecords.push(record);
        runs.push({
          policyId,
          kind: record.verdict.kind,
          failureMode: record.verdict.failureMode ?? null,
          runId: record.runId,
          traceHash: record.traceHash,
        });
      }

      const noOp = records.get('no-op');
      const reference = records.get('reference');

      let admitted = false;
      let admissionReason = '';
      let reachability: boolean | null = null;
      let discriminability: boolean | null = null;

      if (spec.tier !== 'physical') {
        admissionReason = spec.naReason ?? `tier=${spec.tier}`;
      } else if (spec.isNegativeEvent) {
        admitted = true;
        admissionReason = 'negative event: scored on no-unpermitted-action + stay-safe';
        discriminability = noOp?.verdict.kind === 'pass';
        if (discriminability === false) admissionReason = 'negative event but no-op FAILS — definition inconsistent';
      } else if (noOp?.verdict.failureMode === 'already-safe') {
        admissionReason = 'already-safe at injection — no intervention value (§3.6)';
      } else {
        reachability = reference?.verdict.kind === 'pass';
        discriminability = noOp?.verdict.kind === 'fail';
        admitted = reachability && discriminability;
        if (!reachability) admissionReason = 'reference policy cannot reach the envelope within the deadline';
        else if (!discriminability) admissionReason = 'no-op twin PASSES — natural recovery dominates, event not discriminative';
        else admissionReason = 'admitted: reference reaches, no-op fails';
      }

      events.push({
        scenarioId, eventId: event.id, eventType: event.type, parameter,
        tier: spec.tier,
        naReason: spec.naReason,
        isNegativeEvent: spec.isNegativeEvent,
        admitted, admissionReason, reachability, discriminability, runs,
      });
    }
  }

  const expectationChecks: ExpectationCheck[] = MANUAL_EXPECTATIONS.map(exp => {
    const record = runOutcomeFixture({
      scenarioId: exp.scenarioId, eventId: exp.eventId, policyId: exp.policyId, seed,
    });
    allRecords.push(record);
    const actual = { kind: record.verdict.kind, failureMode: record.verdict.failureMode ?? null };
    const match = actual.kind === exp.expectedKind
      && (exp.expectedFailureMode === undefined || actual.failureMode === exp.expectedFailureMode);
    return { expectation: exp, actual, match, actualRunId: record.runId };
  });

  const summary = {
    totalEvents: events.length,
    admittedPositive: events.filter(e => e.admitted && !e.isNegativeEvent).length,
    admittedNegative: events.filter(e => e.admitted && e.isNegativeEvent).length,
    excludedNaturalRecovery: events.filter(e => e.tier === 'natural-recovery').length,
    excludedNonPhysical: events.filter(e => e.naReason?.startsWith('non-physical')).length,
    excludedNoEnvelope: events.filter(e => e.naReason?.startsWith('no-validated-envelope')).length,
    excludedAlreadySafe: events.filter(e => e.admissionReason.startsWith('already-safe')).length,
    unreachable: events.filter(e => e.reachability === false).length,
    nonDiscriminative: events.filter(e => e.reachability === true && e.discriminability === false).length,
    expectationMismatches: expectationChecks.filter(c => !c.match).length,
  };

  // Gate semantics: ADMITTED events must all be reachable + discriminative
  // (exclusion of unreachable / non-discriminative events is itself the
  // honest outcome — §3.6 pre-registered exclusion, not a gate failure), the
  // manual expectations must match 100%, negative events must be
  // no-op-consistent, and the admitted set must not collapse to nothing.
  const gatePass = summary.expectationMismatches === 0
    && events.filter(e => e.admitted && !e.isNegativeEvent
      && !(e.reachability === true && e.discriminability === true)).length === 0
    && events.filter(e => e.admitted && e.isNegativeEvent && e.discriminability === false).length === 0
    && summary.admittedPositive >= 10;

  return {
    report: {
      generatedAt: new Date().toISOString(),
      schemaVersion: OUTCOME_SCHEMA_VERSION,
      predicateVersion: PREDICATE_VERSION,
      envelopeSpecVersion: ENVELOPE_SPEC_VERSION,
      calibrationVersion: CALIBRATION_VERSION,
      seed,
      scenarios: [...scenarioIds],
      gatePass,
      expectationChecks,
      events,
      summary,
    },
    records: allRecords,
  };
}

export function renderGmMarkdown(report: GmGateReport): string {
  const lines: string[] = [];
  lines.push('# G-M Measurement Gate Report');
  lines.push('');
  lines.push(`- generated: ${report.generatedAt}`);
  lines.push(`- versions: schema ${report.schemaVersion} / predicate ${report.predicateVersion} / envelope ${report.envelopeSpecVersion} / calibration ${report.calibrationVersion}`);
  lines.push(`- seed: ${report.seed} | scenarios: ${report.scenarios.join(', ')}`);
  lines.push(`- **GATE: ${report.gatePass ? 'PASS ✅' : 'FAIL ❌'}**`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(report.summary)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('## Manual expectation checks');
  lines.push('');
  lines.push('| scenario | event | policy | expected | actual | match |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of report.expectationChecks) {
    const exp = `${c.expectation.expectedKind}${c.expectation.expectedFailureMode ? `/${c.expectation.expectedFailureMode}` : ''}`;
    const act = `${c.actual.kind}${c.actual.failureMode ? `/${c.actual.failureMode}` : ''}`;
    lines.push(`| ${c.expectation.scenarioId} | ${c.expectation.eventId} | ${c.expectation.policyId} | ${exp} | ${act} | ${c.match ? '✅' : '❌'} |`);
  }
  lines.push('');
  lines.push('## Per-event admission');
  lines.push('');
  lines.push('| scenario | event | type | parameter | tier | neg | admitted | reason |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const e of report.events) {
    lines.push(`| ${e.scenarioId} | ${e.eventId} | ${e.eventType} | ${e.parameter} | ${e.tier} | ${e.isNegativeEvent ? 'y' : ''} | ${e.admitted ? '✅' : '—'} | ${e.admissionReason} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeGmArtifacts(report: GmGateReport, records: OutcomeRecord[]): string {
  const dir = join(getResultsBaseDir(), 'outcome-gm', report.generatedAt.replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gm-gate-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, 'gm-gate-report.md'), renderGmMarkdown(report));
  for (const r of records) {
    writeFileSync(join(dir, `${r.runId.replace(/[:]/g, '_')}.json`), JSON.stringify(r, null, 2));
  }
  return dir;
}
