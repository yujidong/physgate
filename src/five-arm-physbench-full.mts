#!/usr/bin/env node
/**
 * Five-arm PhysBench FULL cohort — CPU arms only (T1.5, response to review W3/W9).
 *
 * Runs no-op / perfect-info-greedy / full-rules over the FULL physbench-admitted
 * queue (185 positive + 32 negative events from physbench-gm-report.json) with
 * paired seeds [11, 22, 33]. The LLM arms remain on the frozen-legacy queue
 * (67+19) until GPU capacity frees up — the paper must label cohorts per arm.
 *
 * Per record we additionally compute (review W8/W9):
 *   - decisionAcc: dispatched at least one corrective actuation (correct
 *     parameter + correct zone) before the deadline (positive events);
 *     for negative events the analogous quantity is restraint itself.
 *   - continuous metrics: timeOutsideSec, iaeOutside (integral of distance
 *     beyond the envelope), from the recorded trajectory.
 *
 * Deterministic: fixture arms and full-rules declare zero stochastic sources;
 * repeated seeds must produce identical verdicts (asserted in the vitest pin).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import { LLMClient } from '@active-collaboration/llm-integration';
import { runOutcomeFixture } from './runner.js';
import { runAgentStackArm } from './agent-arm.js';
import { getResultsBaseDir } from './result-persistence.js';
import type { OutcomeRecord } from './schema.js';

configureLogger({ level: LoggerLevel.ERROR });

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GM_REPORT = join(getResultsBaseDir(), 'outcome-gm', 'physbench-gm', 'physbench-gm-report.json');
// OUTCOME_FULL_LLM=1 switches to the LIVE LLM expansion run (GPU): the two
// LLM arms on the FULL admitted cohort. Output goes to a separate artifact
// dir so the frozen CPU-arm results are never mixed with live-LLM runs.
const LLM_EXPANSION = process.env.OUTCOME_FULL_LLM === '1';
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'http://127.0.0.1:8121/v1';
const LLM_MODEL = process.env.LLM_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct';
const OUT_DIR = join(
  getResultsBaseDir(), 'outcome-gm',
  LLM_EXPANSION ? 'five-arm-physbench-full-llm' : 'five-arm-physbench-full',
);
const SEEDS = [11, 22, 33] as const;
const ARMS = (LLM_EXPANSION
  ? ['distributed-llm', 'centralized-llm']
  : ['no-op', 'perfect-info-greedy', 'full-rules']) as readonly ArmId[];
type ArmId = 'no-op' | 'perfect-info-greedy' | 'full-rules' | 'distributed-llm' | 'centralized-llm';

interface GmEventRow {
  scenarioId: string;
  eventId: string;
  eventType: string;
  parameter: string;
  tier: string;
  isNegativeEvent: boolean;
  admitted: boolean;
}

function loadAdmittedQueue(): GmEventRow[] {
  const report = JSON.parse(readFileSync(GM_REPORT, 'utf8')) as { events: GmEventRow[] };
  const admitted = report.events.filter(e => e.admitted);
  const positive = admitted.filter(e => !e.isNegativeEvent);
  const negative = admitted.filter(e => e.isNegativeEvent);
  if (positive.length < 150 || negative.length < 15) {
    throw new Error(
      `queue sanity failed: implausible admitted cohort ${positive.length}+${negative.length}`,
    );
  }
  console.log(`queue: ${positive.length} positive + ${negative.length} negative admitted events`);
  return admitted;
}

function continuousMetrics(record: OutcomeRecord): {
  timeOutsideSec: number;
  iaeOutside: number;
} {
  const env = record.envelope.envelope as { lower: number; upper: number } | null;
  const samples = record.trajectory.samples ?? [];
  if (!env || samples.length < 2) return { timeOutsideSec: 0, iaeOutside: 0 };
  const lo = env.lower;
  const hi = env.upper;
  let timeOutside = 0;
  let iae = 0;
  let prev = samples[0];
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i];
    const dt = cur.t - prev.t;
    // trapezoid of outside-distance between consecutive samples
    const dPrev = Math.max(0, lo - prev.v, prev.v - hi);
    const dCur = Math.max(0, lo - cur.v, cur.v - hi);
    iae += ((dPrev + dCur) / 2) * dt;
    if (dCur > 0) timeOutside += dt;
    prev = cur;
  }
  return { timeOutsideSec: timeOutside, iaeOutside: iae };
}

function decisionCorrect(record: OutcomeRecord): boolean | null {
  if (record.envelope.isNegativeEvent) return null; // restraint is the metric
  const deadline = record.envelope.deadlineSec ?? 0;
  const zone = record.injection.zoneId;
  const param = record.injection.parameter;
  const corrective = record.actuations.some(a =>
    a.t <= deadline && a.zoneId === zone && a.parameter === param && a.on !== false,
  );
  return corrective;
}

let liveClient: LLMClient | undefined;
async function runArm(arm: ArmId, ev: GmEventRow, seed: number): Promise<OutcomeRecord> {
  if (arm === 'full-rules') {
    return runAgentStackArm({
      scenarioId: ev.scenarioId,
      eventId: ev.eventId,
      seed,
      mode: 'full-rules',
      executionLoop: 'open-loop',
    });
  }
  if (arm === 'distributed-llm' || arm === 'centralized-llm') {
    if (!liveClient) throw new Error(`${arm} requires OUTCOME_FULL_LLM=1 and a live endpoint`);
    return runAgentStackArm({
      scenarioId: ev.scenarioId,
      eventId: ev.eventId,
      seed,
      mode: arm,
      executionLoop: 'open-loop',
      llmClient: liveClient,
    });
  }
  return runOutcomeFixture({
    scenarioId: ev.scenarioId,
    eventId: ev.eventId,
    policyId: arm === 'no-op' ? 'no-op' : 'reference',
    seed,
    armId: arm,
  });
}

function compact(record: OutcomeRecord, ev: GmEventRow, arm: ArmId) {
  const cont = continuousMetrics(record);
  const dec = decisionCorrect(record);
  return {
    runId: record.runId,
    armId: arm,
    scenarioId: record.scenarioId,
    eventId: record.eventId,
    seed: record.seed,
    eventType: record.eventType,
    parameter: ev.parameter,
    family: ev.parameter,
    tier: record.envelope.tier,
    negative: record.envelope.isNegativeEvent,
    kind: record.verdict.kind,
    failureMode: record.verdict.failureMode ?? null,
    enteredAt: record.verdict.enteredEnvelopeAtSec ?? null,
    heldFor: record.verdict.heldForSec ?? null,
    recoveryTime: record.verdict.recoveryTimeSec ?? null,
    decisionAcc: dec,
    actuations: record.actuations.length,
    actuationLog: record.actuations.map(a => ({ t: a.t, deviceId: a.deviceId, parameter: a.parameter, zoneId: a.zoneId, on: a.on })),
    decisionTrace: record.decisionTrace ?? [],
    timeOutsideSec: cont.timeOutsideSec,
    iaeOutside: cont.iaeOutside,
    cost: record.cost ? {
      wallClockMs: record.cost.wallClockMs ?? null,
      tokenIn: record.cost.tokenIn ?? null,
      tokenOut: record.cost.tokenOut ?? null,
      llmCalls: record.cost.llmCalls ?? null,
    } : null,
    traceHash: record.traceHash,
  };
}

function aggregate(rows: ReturnType<typeof compact>[]) {
  const positive = rows.filter(r => !r.negative);
  const negative = rows.filter(r => r.negative);
  const rate = (arr: typeof rows) => (arr.length ? arr.filter(r => r.kind === 'pass').length / arr.length : null);
  const decRate = positive.length
    ? positive.filter(r => r.decisionAcc === true).length / positive.length
    : null;
  const families = [...new Set(rows.map(r => r.family))].sort();
  const byFamily = Object.fromEntries(families.map(f => {
    const p = positive.filter(r => r.family === f);
    return [f, {
      events: p.length / SEEDS.length,
      passRate: rate(p),
      decisionAcc: p.length ? p.filter(r => r.decisionAcc === true).length / p.length : null,
      meanIae: p.length ? p.reduce((a, r) => a + r.iaeOutside, 0) / p.length : null,
      meanTimeOutsideSec: p.length ? p.reduce((a, r) => a + r.timeOutsideSec, 0) / p.length : null,
    }];
  }));
  const failureModes: Record<string, number> = {};
  for (const r of rows) {
    if (r.kind === 'fail' && r.failureMode) failureModes[r.failureMode] = (failureModes[r.failureMode] ?? 0) + 1;
  }
  return {
    records: rows.length,
    events: rows.length / SEEDS.length,
    positive: { total: positive.length, passRate: rate(positive), decisionAcc: decRate, byFamily },
    negative: { total: negative.length, restraintRate: rate(negative) },
    failureModes,
    costPerEvent: (() => {
      const wc = rows.reduce((a, r) => a + (r.cost?.wallClockMs ?? 0), 0);
      return { wallClockMs: rows.length ? wc / rows.length : null };
    })(),
  };
}

export async function runFullCohortArms() {
  const queue = loadAdmittedQueue();
  mkdirSync(OUT_DIR, { recursive: true });
  if (LLM_EXPANSION) {
    const url = new URL(LLM_BASE_URL);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error('LLM endpoint must be loopback');
    }
    liveClient = new LLMClient('openai-compatible', { baseURL: LLM_BASE_URL, model: LLM_MODEL });
    console.log(`live LLM expansion: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  }
  const startedAt = new Date().toISOString();
  const allRows: ReturnType<typeof compact>[] = [];
  const armRows = new Map<ArmId, ReturnType<typeof compact>[]>();

  // resumable: skip records already on disk for this arm
  const existing = new Map<ArmId, ReturnType<typeof compact>[]>();
  for (const arm of ARMS) {
    const p = join(OUT_DIR, `records-${arm}.json`);
    existing.set(arm, existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : []);
  }

  for (const arm of ARMS) {
    const rows = existing.get(arm)!;
    const doneKey = new Set(rows.map(r => `${r.scenarioId}|${r.eventId}|${r.seed}`));
    let fresh = 0;
    for (const ev of queue) {
      for (const seed of SEEDS) {
        if (doneKey.has(`${ev.scenarioId}|${ev.eventId}|${seed}`)) continue;
        const record = await runArm(arm, ev, seed);
        rows.push(compact(record, ev, arm));
        fresh++;
        if (fresh % 50 === 0) {
          writeFileSync(join(OUT_DIR, `records-${arm}.json`), JSON.stringify(rows, null, 1));
          console.log(`  [${arm}] ${rows.length}/${queue.length * SEEDS.length}`);
        }
      }
    }
    armRows.set(arm, rows);
    allRows.push(...rows);
    writeFileSync(join(OUT_DIR, `records-${arm}.json`), JSON.stringify(rows, null, 1));
    console.log(`[${arm}] wrote ${rows.length} records (${fresh} fresh)`);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    startedAt,
    cohort: `physbench-admitted (${queue.filter(e => !e.isNegativeEvent).length} positive + ${queue.filter(e => e.isNegativeEvent).length} negative)`,
    gateReport: 'physbench-gm/physbench-gm-report.json',
    seeds: [...SEEDS],
    arms: [...ARMS],
    llm: LLM_EXPANSION ? { model: LLM_MODEL, endpoint: LLM_BASE_URL, temperature: 0, maxTokens: 1024 } : null,
    armSummary: Object.fromEntries(ARMS.map(a => [a, aggregate(armRows.get(a)!)])),
  };
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`summary -> ${join(OUT_DIR, 'summary.json')}`);
  for (const arm of ARMS) {
    const s = summary.armSummary[arm];
    console.log(
      `${arm}: positive pass=${s.positive.passRate?.toFixed(3)} decisionAcc=${s.positive.decisionAcc?.toFixed(3)} restraint=${s.negative.restraintRate?.toFixed(3)}`,
    );
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (process.argv[1]?.endsWith('five-arm-physbench-full.mts')) {
  runFullCohortArms().catch(e => { console.error(e); process.exit(1); });
}
