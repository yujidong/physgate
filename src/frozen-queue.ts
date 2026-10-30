/**
 * Frozen G-M-admitted outcome queue.
 *
 * The five-arm runner and all reanalyses must select events from the complete
 * gate artifact, not from the physical-event inventory or an old arm summary.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResultsBaseDir } from './result-persistence.js';

export const FROZEN_OUTCOME_QUEUE_VERSION = 'gm-admitted-2026-10-24-v1';
export const FROZEN_OUTCOME_GATE_REPORT = join(
  getResultsBaseDir(),
  'outcome-gm',
  '2026-10-24T18-05-32-388Z',
  'gm-gate-report.json',
);
export const FROZEN_OUTCOME_EXCLUDED_EVENT_IDS = [
  'evt-factory-3',
  'evt-sc-7',
  'evt-apt-42',
] as const;
export const FROZEN_OUTCOME_COUNTS = { positive: 67, negative: 19, total: 86 } as const;

export interface FrozenOutcomeEvent {
  scenarioId: string;
  eventId: string;
  eventType: string;
  parameter: string;
  tier: string;
  isNegativeEvent: boolean;
  admissionReason: string;
}

interface GateReport {
  gatePass: boolean;
  events: Array<FrozenOutcomeEvent & { admitted: boolean }>;
}

export function frozenOutcomeEventKey(event: Pick<FrozenOutcomeEvent, 'scenarioId' | 'eventId'>): string {
  return `${event.scenarioId}|${event.eventId}`;
}

/** Read and validate the exact 67-positive + 19-negative admitted queue. */
export function loadFrozenOutcomeQueue(reportPath = FROZEN_OUTCOME_GATE_REPORT): FrozenOutcomeEvent[] {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as GateReport;
  if (!report.gatePass || !Array.isArray(report.events)) {
    throw new Error(`Frozen G-M gate report is not a complete passing artifact: ${reportPath}`);
  }

  const excluded = new Set<string>(FROZEN_OUTCOME_EXCLUDED_EVENT_IDS);
  for (const event of report.events) {
    if (excluded.has(event.eventId) && event.admitted) {
      throw new Error(`Excluded event is admitted in the frozen G-M artifact: ${event.eventId}`);
    }
  }
  const admitted = report.events.filter(event => event.admitted);
  const positive = admitted.filter(event => !event.isNegativeEvent).length;
  const negative = admitted.filter(event => event.isNegativeEvent).length;
  if (positive !== FROZEN_OUTCOME_COUNTS.positive || negative !== FROZEN_OUTCOME_COUNTS.negative) {
    throw new Error(
      `Frozen outcome queue mismatch: expected ${FROZEN_OUTCOME_COUNTS.positive} positive + ` +
      `${FROZEN_OUTCOME_COUNTS.negative} negative, got ${positive} + ${negative}`,
    );
  }

  const keys = new Set<string>();
  for (const event of admitted) {
    const key = frozenOutcomeEventKey(event);
    if (keys.has(key)) throw new Error(`Duplicate event in frozen outcome queue: ${key}`);
    keys.add(key);
  }

  return admitted.map(event => ({
    scenarioId: event.scenarioId,
    eventId: event.eventId,
    eventType: event.eventType,
    parameter: event.parameter,
    tier: event.tier,
    isNegativeEvent: event.isNegativeEvent,
    admissionReason: event.admissionReason,
  }));
}
