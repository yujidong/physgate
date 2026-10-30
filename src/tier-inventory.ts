/**
 * B1 — Structural event-tier inventory over ALL six scenarios (177 events).
 *
 * Pure derivation from event definitions + the calibration table — no
 * simulation, no model results. This is the "逐事件分档" deliverable: every
 * event gets a tier (physical / natural-recovery / unscorable) with the
 * structural reason, BEFORE any arm ever runs on it (the WP-B1 rule: tiering
 * may not be tuned after seeing model results).
 *
 * The per-event admission (reachability / discriminability) scan is a
 * separate, simulation-backed pass (buildGmGateReport extended to all six
 * scenarios) — see outcome-inventory.vitest.test.ts.
 */

import { SCENARIOS } from './scenario-definitions.js';
import { resolveEventParameter } from './paper-experiment-runner.js';
import { deriveEnvelopeSpec } from './envelope.js';

/**
 * The scenario set the frozen artifacts (B1 tier inventory, B2 holdout
 * manifest, G-M gate) were built on. SCENARIOS may GROW (parallel workstreams
 * add scenarios, e.g. ownership worlds) — the frozen instruments do not
 * silently follow; admitting a new scenario is a deliberate version bump.
 */
export const FROZEN_SCENARIO_IDS = [
  'single-room', 'apartment', 'campus', 'factory', 'hospital', 'smart-city',
] as const;

export interface TierRow {
  scenarioId: string;
  eventId: string;
  eventType: string;
  zoneId: string;
  parameter: string;
  tier: 'physical' | 'natural-recovery' | 'unscorable';
  isNegativeEvent: boolean;
  direction: 'above' | 'below' | null;
  envelope: string | null;
  deadlineSec: number | null;
  holdSec: number | null;
  naReason: string | null;
}

export function buildTierInventory(): TierRow[] {
  const rows: TierRow[] = [];
  for (const scenarioId of FROZEN_SCENARIO_IDS) {
    const scenario = SCENARIOS[scenarioId as keyof typeof SCENARIOS];
    for (const event of scenario.events) {
      const spec = deriveEnvelopeSpec(event, scenarioId);
      const { parameter } = resolveEventParameter(event);
      rows.push({
        scenarioId,
        eventId: event.id,
        eventType: event.type,
        zoneId: event.zoneId,
        parameter,
        tier: spec.tier,
        isNegativeEvent: spec.isNegativeEvent,
        direction: spec.direction ?? null,
        envelope: spec.envelope ? `[${spec.envelope.lower},${spec.envelope.upper}]` : null,
        deadlineSec: spec.deadlineSec,
        holdSec: spec.holdSec,
        naReason: spec.naReason ?? null,
      });
    }
  }
  return rows;
}

export function tierSummary(rows: TierRow[]): Record<string, number> {
  const by = (fn: (r: TierRow) => string) =>
    rows.reduce<Record<string, number>>((acc, r) => {
      const k = fn(r);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const tiers = by(r => r.tier);
  const params = by(r => r.parameter);
  return {
    total: rows.length,
    physical: tiers.physical ?? 0,
    naturalRecovery: tiers['natural-recovery'] ?? 0,
    unscorable: tiers.unscorable ?? 0,
    negativeAmongPhysical: rows.filter(r => r.tier === 'physical' && r.isNegativeEvent).length,
    // per-parameter detail kept flat for the artifact
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param:${k}`, v])),
  };
}

export function renderTierMarkdown(rows: TierRow[]): string {
  const lines: string[] = [];
  lines.push('# B1: Structural Event-Tier Inventory (six scenarios, 177 events)');
  lines.push('');
  lines.push('Derived from event definitions + calibration v1.0.0 BEFORE any model run. Tiers:');
  lines.push('- `physical` — calibrated envelope/deadline/hold exist; scored on the physical success metric');
  lines.push('- `natural-recovery` — physics self-heals as fast as any actuator; pre-registered exclusion (§3.6)');
  lines.push('- `unscorable` — no honest physics/measure channel (non-physical or no calibrated envelope); N-A');
  lines.push('');
  const s = tierSummary(rows);
  lines.push(`**Total ${s.total}** — physical ${s.physical} (incl. ${s.negativeAmongPhysical} negative) · natural-recovery ${s.naturalRecovery} · unscorable ${s.unscorable}`);
  lines.push('');
  for (const scenarioId of FROZEN_SCENARIO_IDS) {
    const scRows = rows.filter(r => r.scenarioId === scenarioId);
    lines.push(`## ${scenarioId} (${scRows.length} events)`);
    lines.push('');
    lines.push('| event | type | zone | parameter | tier | neg | dir | envelope | deadline | hold | N-A reason |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of scRows) {
      lines.push(
        `| ${r.eventId} | ${r.eventType} | ${r.zoneId} | ${r.parameter} | ${r.tier} | ${r.isNegativeEvent ? 'y' : ''} | ` +
        `${r.direction ?? ''} | ${r.envelope ?? ''} | ${r.deadlineSec ?? ''} | ${r.holdSec ?? ''} | ${r.naReason ?? ''} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
