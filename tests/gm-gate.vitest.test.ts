/**
 * PhysBench G-M Gate — runs the admission scan over ALL scenarios:
 *   - 6 original hand-crafted (single-room → smart-city)
 *   - 10 new program-generated (school, lab, datacenter, etc.)
 *
 * For each event in each scenario:
 *   1. Derive tier (physical / natural-recovery / unscorable)
 *   2. If physical: run no-op probe (must FAIL for admission)
 *   3. If physical: run greedy reference (must PASS for admission)
 *
 * Output: physbench-gm-report.json + physbench-gm-report.md
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import { SCENARIOS } from '../src/scenario-definitions.js';
import { generatePhysBenchScenarios } from '../src/generate-physbench-scenarios.js';
import { deriveEnvelopeSpec } from '../src/envelope.js';
import { resolveEventParameter } from '../src/paper-experiment-runner.js';
import { runOutcomeFixture } from '../src/runner.js';
import type { ScenarioDefinition } from '../types.js';

configureLogger({ level: LoggerLevel.ERROR });

const SEED = 7;
const FROZEN_SCENARIO_IDS = ['single-room', 'apartment', 'campus', 'factory', 'hospital', 'smart-city'];

describe('PhysBench G-M Gate (full admission scan)', () => {
  const allScenarios: ScenarioDefinition[] = [
    ...FROZEN_SCENARIO_IDS.map(id => SCENARIOS[id as keyof typeof SCENARIOS]),
    ...generatePhysBenchScenarios(),
  ];

  interface EventResult {
    scenarioId: string;
    eventId: string;
    eventType: string;
    parameter: string;
    tier: string;
    isNegative: boolean;
    admitted: boolean;
    admissionReason: string;
    reachability: boolean | null;
    discriminability: boolean | null;
  }

  const results: EventResult[] = [];
  let stats = {
    totalEvents: 0,
    physical: 0,
    naturalRecovery: 0,
    unscorable: 0,
    admittedPositive: 0,
    admittedNegative: 0,
    unreachable: 0,
    nonDiscriminative: 0,
    negativeInconsistent: 0,
  };

  beforeAll(() => {
    for (const scenario of allScenarios) {
      for (const event of scenario.events) {
        const spec = deriveEnvelopeSpec(event, scenario.id);
        const { parameter } = resolveEventParameter(event);
        stats.totalEvents++;

        let admitted = false;
        let reason = '';
        let reachability: boolean | null = null;
        let discriminability: boolean | null = null;

        if (spec.tier !== 'physical') {
          stats[spec.tier === 'natural-recovery' ? 'naturalRecovery' : 'unscorable']++;
          reason = spec.naReason ?? `tier=${spec.tier}`;
        } else {
          stats.physical++;
          if (spec.isNegativeEvent) {
            // Negative admission (hardened 2026-10-29): a negative event is
            // admitted only if its no-op twin maintains the envelope — the
            // exact analogue of positive-side discriminability. Events whose
            // injection lands outside the envelope (mislabeled normals) are
            // excluded with an explicit reason; they are not silently
            // reclassified.
            const noop = runOutcomeFixture({
              scenarioId: scenario.id, eventId: event.id,
              policyId: 'no-op', seed: SEED,
            });
            discriminability = noop.verdict.kind === 'pass';
            if (discriminability) {
              admitted = true;
              stats.admittedNegative++;
              reason = 'negative event (no-op twin maintains envelope)';
            } else {
              stats.negativeInconsistent++;
              reason = `negative-labeled but no-op twin fails (${noop.verdict.failureMode ?? 'fail'}) — injection outside envelope`;
            }
          } else {
            // Positive events: check reachability + discriminability
            // Quick check: if the event has an envelope, run greedy
            if (spec.envelope && spec.deadlineSec && spec.holdSec) {
              try {
                const greedy = runOutcomeFixture({
                  scenarioId: scenario.id, eventId: event.id,
                  policyId: 'reference', seed: SEED,
                });
                const noop = runOutcomeFixture({
                  scenarioId: scenario.id, eventId: event.id,
                  policyId: 'no-op', seed: SEED,
                });
                reachability = greedy.verdict.kind === 'pass';
                discriminability = noop.verdict.kind === 'fail';

                if (!reachability) {
                  stats.unreachable++;
                  reason = 'unreachable: greedy fails';
                } else if (!discriminability) {
                  stats.nonDiscriminative++;
                  reason = 'non-discriminative: no-op passes';
                } else {
                  admitted = true;
                  stats.admittedPositive++;
                  reason = 'admitted';
                }
              } catch {
                reason = 'simulation error';
                reachability = false;
                stats.unreachable++;
              }
            } else {
              reason = 'no envelope/deadline';
            }
          }
        }

        results.push({
          scenarioId: scenario.id, eventId: event.id, eventType: event.type,
          parameter, tier: spec.tier, isNegativeEvent: spec.isNegativeEvent,
          admitted, admissionReason: reason, reachability, discriminability,
        });
      }
    }
  }, 30 * 60 * 1000);

  it('covers 16+ scenarios and 350+ events', () => {
    // eslint-disable-next-line no-console
    console.log(`[physbench-gm] ${allScenarios.length} scenarios, ${stats.totalEvents} events`);
    // eslint-disable-next-line no-console
    console.log(`  physical=${stats.physical} natural=${stats.naturalRecovery} unscorable=${stats.unscorable}`);
    // eslint-disable-next-line no-console
    console.log(`  admitted: ${stats.admittedPositive} positive + ${stats.admittedNegative} negative`);
    // eslint-disable-next-line no-console
    console.log(`  excluded: unreachable=${stats.unreachable} nonDisc=${stats.nonDiscriminative} negativeInconsistent=${stats.negativeInconsistent}`);
    expect(allScenarios.length).toBeGreaterThanOrEqual(16);
    expect(stats.totalEvents).toBeGreaterThanOrEqual(350);
  });

  it('admits at least 200 events (positive + negative)', () => {
    expect(stats.admittedPositive + stats.admittedNegative).toBeGreaterThanOrEqual(200);
  });

  it('every admitted positive event has verified reachability and discriminability', () => {
    const admittedPos = results.filter(r => r.admitted && !r.isNegativeEvent);
    expect(admittedPos.length).toBe(stats.admittedPositive);
    for (const r of admittedPos) {
      expect(r.reachability, `${r.scenarioId}/${r.eventId}`).toBe(true);
      expect(r.discriminability, `${r.scenarioId}/${r.eventId}`).toBe(true);
    }
  });

  it('every admitted negative event passes its no-op twin (envelope maintained)', () => {
    const admittedNeg = results.filter(r => r.admitted && r.isNegativeEvent);
    expect(admittedNeg.length).toBe(stats.admittedNegative);
    for (const r of admittedNeg) {
      expect(r.discriminability, `${r.scenarioId}/${r.eventId}`).toBe(true);
    }
    // accounting: physical tier fully partitioned
    expect(
      stats.admittedPositive + stats.admittedNegative + stats.unreachable
      + stats.nonDiscriminative + stats.negativeInconsistent,
    ).toBe(stats.physical);
  });

  it('writes the PhysBench G-M report artifact', () => {
    const dir = join(process.cwd(), 'tests', 'experiment-results', 'outcome-gm', 'physbench-gm');
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, 'physbench-gm-report.json'), JSON.stringify({
      date: new Date().toISOString(),
      seed: SEED,
      scenarios: allScenarios.length,
      stats,
      events: results,
    }, null, 2));

    // Markdown summary
    const lines = [
      '# PhysBench G-M Gate Report',
      '',
      `- ${allScenarios.length} scenarios | ${stats.totalEvents} events`,
      `- Physical: ${stats.physical} | Natural recovery: ${stats.naturalRecovery} | Unscorable: ${stats.unscorable}`,
      `- Admitted: ${stats.admittedPositive} positive + ${stats.admittedNegative} negative`,
      `- Excluded: ${stats.unreachable} unreachable, ${stats.nonDiscriminative} non-discriminative, ${stats.negativeInconsistent} negative-inconsistent (no-op twin fails)`,
      '',
      '| Scenario | Events | Physical | Admitted+ | Admitted- |',
      '|---|---|---|---|---|',
    ];
    for (const sc of allScenarios) {
      const scResults = results.filter(r => r.scenarioId === sc.id);
      const scPhysical = scResults.filter(r => r.tier === 'physical').length;
      const scAdmPos = scResults.filter(r => r.admitted && !r.isNegativeEvent).length;
      const scAdmNeg = scResults.filter(r => r.admitted && r.isNegativeEvent).length;
      lines.push(`| ${sc.id} | ${scResults.length} | ${scPhysical} | ${scAdmPos} | ${scAdmNeg} |`);
    }
    writeFileSync(join(dir, 'physbench-gm-report.md'), lines.join('\n') + '\n');
    // eslint-disable-next-line no-console
    console.log(`[physbench-gm] artifacts → ${dir}`);
  });
});
