/**
 * Unified scenario registry — combines the original hand-crafted SCENARIOS
 * with the PhysBench program-generated scenarios into a single lookup.
 *
 * The generated scenarios are memoized on first access so that repeated
 * calls are cheap and deterministic.
 */

import { SCENARIOS } from './scenario-definitions.js';
import { generatePhysBenchScenarios } from './generate-physbench-scenarios.js';
import type { ScenarioDefinition } from './types.js';

let cachedAll: Map<string, ScenarioDefinition> | null = null;

/**
 * Returns a unified Map of ALL scenarios (original + generated) keyed by id.
 * Generated scenarios have ids prefixed with 'physbench-'.
 */
export function getAllScenarios(): Map<string, ScenarioDefinition> {
  if (cachedAll) return cachedAll;

  cachedAll = new Map();
  // Original hand-crafted scenarios
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    cachedAll.set(id, sc);
  }
  // PhysBench generated scenarios
  for (const sc of generatePhysBenchScenarios()) {
    cachedAll.set(sc.id, sc);
  }
  return cachedAll;
}

/**
 * Look up a single scenario by id (works for both original and generated).
 */
export function findScenario(id: string): ScenarioDefinition | undefined {
  return getAllScenarios().get(id);
}

/**
 * List all scenario ids.
 */
export function listScenarioIds(): string[] {
  return [...getAllScenarios().keys()];
}
