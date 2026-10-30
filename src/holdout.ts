/**
 * B2 — Pre-registered holdout stratification.
 *
 * Frozen BEFORE any arm (rule/LLM/greedy) runs on the task set — the split
 * is computed by a deterministic content-hash rule that cannot see model
 * results (WP-B1/B2 discipline: 不能看模型结果后调分档/调划分).
 *
 * Two splits:
 *   A. TEMPLATE HOLDOUT (within distribution): inside each
 *      (parameter × direction × scenario) stratum, whole event TEMPLATES
 *      (event.type) are held out — never used for anything tunable
 *      (envelope calibration review, rule-arm expectations, prompt design).
 *      Selection: templates ordered by sha256(template|stratum), the first
 *      ceil(30%) are held out, always leaving ≥1 template per stratum.
 *   B. SCENARIO TRANSFER (out of distribution): smart-city is the held-out
 *      scenario family — never touched during instrument development
 *      (the G-M gate ran single-room + apartment only); its admitted events
 *      are reported as unseen-scenario transfer.
 *
 * Only physical-tier events participate (everything else is N-A anyway).
 */

import { createHash } from 'node:crypto';
import { SCENARIOS } from './scenario-definitions.js';
import { resolveEventParameter } from './paper-experiment-runner.js';
import { deriveEnvelopeSpec } from './envelope.js';
import { buildTierInventory } from './tier-inventory.js';
import { FROZEN_SCENARIO_IDS } from './tier-inventory.js';

export const HOLDOUT_MANIFEST_VERSION = '1.0.0';
/** pre-registered at instrument-freeze time, before any arm run */
export const HOLDOUT_FROZEN_AT = '2026-10-24T18:10:00Z';
export const TEMPLATE_HOLDOUT_RATIO = 0.3;
export const SCENARIO_TRANSFER_HOLDOUT = 'smart-city';

export interface HoldoutManifest {
  version: string;
  frozenAt: string;
  rule: string;
  templateHoldoutRatio: number;
  scenarioTransferHoldout: string;
  strata: Array<{
    key: string;
    parameter: string;
    direction: string;
    scenarioId: string;
    templatesTotal: number;
    templatesHeldOut: number;
    heldOutTemplates: string[];
  }>;
  holdoutEventIds: string[];
  trainEventIds: string[];
  scenarioTransferEventIds: string[];
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function buildHoldoutManifest(): HoldoutManifest {
  const rows = buildTierInventory().filter(r => r.tier === 'physical');

  // --- Split A: template holdout within (parameter × direction × scenario).
  // smart-city is wholly Split B (scenario transfer) — it does not
  // participate in Split A, so the two splits cannot overlap.
  const strataMap = new Map<string, typeof rows>();
  for (const r of rows.filter(r => r.scenarioId !== SCENARIO_TRANSFER_HOLDOUT)) {
    const key = `${r.parameter}|${r.direction ?? 'none'}|${r.scenarioId}`;
    const list = strataMap.get(key) ?? [];
    list.push(r);
    strataMap.set(key, list);
  }

  const holdoutEventIds = new Set<string>();
  const strata: HoldoutManifest['strata'] = [];
  for (const [key, list] of [...strataMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const templates = [...new Set(list.map(r => r.eventType))];
    const ordered = templates
      .map(t => ({ t, h: sha(`${t}|${key}|${HOLDOUT_MANIFEST_VERSION}`) }))
      .sort((a, b) => a.h.localeCompare(b.h));
    const holdCount = Math.min(Math.ceil(templates.length * TEMPLATE_HOLDOUT_RATIO), Math.max(templates.length - 1, 0));
    const heldOut = ordered.slice(0, holdCount).map(x => x.t);
    for (const r of list) {
      if (heldOut.includes(r.eventType)) holdoutEventIds.add(r.eventId);
    }
    const [parameter, direction, scenarioId] = key.split('|');
    strata.push({
      key, parameter, direction, scenarioId,
      templatesTotal: templates.length, templatesHeldOut: heldOut.length,
      heldOutTemplates: heldOut.sort(),
    });
  }

  // --- Split B: scenario transfer ---
  const scenarioTransferEventIds = rows
    .filter(r => r.scenarioId === SCENARIO_TRANSFER_HOLDOUT)
    .map(r => r.eventId);

  const trainEventIds = rows
    .filter(r => !holdoutEventIds.has(r.eventId) && r.scenarioId !== SCENARIO_TRANSFER_HOLDOUT)
    .map(r => r.eventId);

  return {
    version: HOLDOUT_MANIFEST_VERSION,
    frozenAt: HOLDOUT_FROZEN_AT,
    rule: `within each (parameter × direction × scenario) stratum, event templates ordered by sha256(template|stratum|${HOLDOUT_MANIFEST_VERSION}); first ceil(${TEMPLATE_HOLDOUT_RATIO}×|templates|) held out, ≥1 template always kept; plus scenario ${SCENARIO_TRANSFER_HOLDOUT} entirely transfer-only`,
    templateHoldoutRatio: TEMPLATE_HOLDOUT_RATIO,
    scenarioTransferHoldout: SCENARIO_TRANSFER_HOLDOUT,
    strata,
    holdoutEventIds: [...holdoutEventIds].sort(),
    trainEventIds: trainEventIds.sort(),
    scenarioTransferEventIds: scenarioTransferEventIds.sort(),
  };
}

export function holdoutAssignmentOf(eventId: string): 'train' | 'template-holdout' | 'scenario-transfer' | 'not-physical' {
  const manifest = buildHoldoutManifest();
  if (manifest.scenarioTransferEventIds.includes(eventId)) return 'scenario-transfer';
  if (manifest.holdoutEventIds.includes(eventId)) return 'template-holdout';
  if (manifest.trainEventIds.includes(eventId)) return 'train';
  return 'not-physical';
}

/** Scenario physical-event counts (for the paper's task-set table). */
export function physicalEventCountsByScenario(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const scenarioId of FROZEN_SCENARIO_IDS) {
    const scenario = SCENARIOS[scenarioId as keyof typeof SCENARIOS];
    counts[scenarioId] = scenario.events.filter(e => {
      const spec = deriveEnvelopeSpec(e, scenarioId);
      void resolveEventParameter(e);
      return spec.tier === 'physical';
    }).length;
  }
  return counts;
}
