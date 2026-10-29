#!/usr/bin/env node
/**
 * Closed-loop CPU ablation (T2.3, response to review W4/W5).
 *
 * Runs the open-loop vs closed-loop execution contrast on the frozen legacy
 * queue (67 positive + 19 negative x seeds 11/22/33) with NO GPU:
 *   - full-rules arms: no LLM at all (pure CPU).
 *   - LLM arms: VCR replay from the round-2 SQLite response cache. The
 *     decision lane is byte-identical between open and closed loop (the
 *     ClosedLoopExecutor only wraps device command execution after the
 *     decision), so prompts are identical -> deterministic cache replay.
 *     A cache miss is recorded honestly and the run is skipped; live-GPU
 *     confirmation remains queued separately.
 *
 * The open-loop arms double as a replay-fidelity check: their verdicts must
 * match the round-2 records (asserted by the pin test).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import { LLMClient, LLMCache } from '@active-collaboration/llm-integration';
import { runAgentStackArm, type AgentStackMode } from './agent-arm.js';
import { getResultsBaseDir } from '../result-persistence.js';
import { loadFrozenOutcomeQueue, FROZEN_OUTCOME_GATE_REPORT } from './frozen-queue.js';
import { CLOSED_LOOP_EXECUTOR_VERSION } from './closed-loop-executor.js';
import { OPERATIONAL_SETPOINT_POLICY } from './envelope.js';

configureLogger({ level: LoggerLevel.ERROR });

const SEEDS = [11, 22, 33];
// OUTCOME_ABLATION_VARIANT selects the run: 'main' (legacy setpoints, LLM VCR
// arms included) or 'setpoint-v2' (calibrated setpoints; full-rules only —
// recalibrated operational targets change LLM prompts, so VCR replay would
// miss and live LLM needs GPU).
const VARIANT = process.env.OUTCOME_ABLATION_VARIANT === 'setpoint-v2' ? 'setpoint-v2' : 'main';
const BASE = join(
  getResultsBaseDir(), 'outcome-gm',
  VARIANT === 'setpoint-v2' ? 'closed-loop-setpoint-ablation' : 'closed-loop-cpu-ablation',
);
const CACHE_DB = join(getResultsBaseDir(), 'outcome-gm', 'llm-round2', 'llm-response-cache.db');
const RECORDS = join(BASE, 'records.jsonl');
const LLM_MODEL = 'Qwen/Qwen2.5-7B-Instruct';
const ARMS: Array<{ armId: string; mode: AgentStackMode | 'full-rules'; loop: 'open-loop' | 'closed-loop' }> =
  VARIANT === 'setpoint-v2'
    ? [
      { armId: 'full-rules-open-loop', mode: 'full-rules', loop: 'open-loop' },
      { armId: 'full-rules-closed-loop', mode: 'full-rules', loop: 'closed-loop' },
    ]
    : [
      { armId: 'full-rules-open-loop', mode: 'full-rules', loop: 'open-loop' },
      { armId: 'full-rules-closed-loop', mode: 'full-rules', loop: 'closed-loop' },
      { armId: 'distributed-llm-open-loop', mode: 'distributed-llm', loop: 'open-loop' },
      { armId: 'distributed-llm-closed-loop', mode: 'distributed-llm', loop: 'closed-loop' },
      { armId: 'centralized-llm-open-loop', mode: 'centralized-llm', loop: 'open-loop' },
      { armId: 'centralized-llm-closed-loop', mode: 'centralized-llm', loop: 'closed-loop' },
    ];

const queue = loadFrozenOutcomeQueue(FROZEN_OUTCOME_GATE_REPORT);

interface Stored {
  key: string;
  armId: string;
  replayMiss?: string;
  record: unknown;
}
const done = new Map<string, Stored>();
if (existsSync(RECORDS)) {
  for (const line of readFileSync(RECORDS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Stored;
    done.set(row.key, row);
  }
}

function makeClient(): LLMClient | undefined {
  if (VARIANT === 'setpoint-v2') return undefined; // full-rules only; no LLM calls
  if (!existsSync(CACHE_DB)) throw new Error(`VCR cache missing: ${CACHE_DB}`);
  return new LLMClient('openai-compatible', {
    baseURL: 'http://127.0.0.1:0/v1', // never dialed in replay mode
    model: LLM_MODEL,
    cache: new LLMCache({ persistPath: CACHE_DB, maxSize: 5000 }),
    replay: true,
  });
}

const client = makeClient();

function summarize(rows: Stored[]) {
  const arms = ARMS.map(({ armId }) => {
    const armRows = rows.filter(r => r.armId === armId && !r.replayMiss);
    const records = armRows.map(r => r.record as {
      verdict: { kind: string };
      envelope: { isNegativeEvent: boolean };
      scenarioId: string; eventId: string;
    });
    const pos = records.filter(r => !r.envelope.isNegativeEvent);
    const neg = records.filter(r => r.envelope.isNegativeEvent);
    const rate = (xs: typeof records) => (xs.length ? xs.filter(r => r.verdict.kind === 'pass').length / xs.length : null);
    const misses = rows.filter(r => r.armId === armId && r.replayMiss).length;
    // failure-mode breakdown + continuous metrics (review N2: every decomposition
    // number cited in the paper must be artifact-checkable)
    const failureModes: Record<string, number> = {};
    for (const r of records) {
      const fm = (r as { verdict: { kind: string; failureMode?: string } }).verdict;
      if (fm.kind === 'fail' && fm.failureMode) failureModes[fm.failureMode] = (failureModes[fm.failureMode] ?? 0) + 1;
    }
    let iaeSum = 0; let outsideSum = 0; let iaeN = 0; let decAcc = 0;
    for (const rRaw of armRows) {
      const r = rRaw.record as unknown as {
        envelope: { isNegativeEvent: boolean; envelope: { lower: number; upper: number } | null; deadlineSec?: number | null };
        injection: { zoneId: string; parameter: string };
        trajectory: { samples: Array<{ t: number; v: number }> };
        actuations: Array<{ t: number; zoneId: string; parameter: string; on?: boolean }>;
      } | null;
      if (!r) continue;
      if (!r.envelope.isNegativeEvent) {
        const deadline = r.envelope.deadlineSec ?? 0;
        if (r.actuations.some(a => a.t <= deadline && a.zoneId === r.injection.zoneId && a.parameter === r.injection.parameter && a.on !== false)) decAcc++;
        const e = r.envelope.envelope;
        const samples = r.trajectory.samples;
        if (e && samples.length >= 2) {
          let iae = 0; let outside = 0; let prev = samples[0];
          for (let i = 1; i < samples.length; i++) {
            const cur = samples[i];
            const dt = cur.t - prev.t;
            const dp = Math.max(0, e.lower - prev.v, prev.v - e.upper);
            const dc = Math.max(0, e.lower - cur.v, cur.v - e.upper);
            iae += ((dp + dc) / 2) * dt;
            if (dc > 0) outside += dt;
            prev = cur;
          }
          iaeSum += iae; outsideSum += outside; iaeN++;
        }
      }
    }
    return {
      armId,
      records: records.length,
      replayMisses: misses,
      positiveFailureModes: failureModes,
      positiveDecisionAcc: pos.length ? decAcc / pos.length : null,
      positiveMeanIae: iaeN ? iaeSum / iaeN : null,
      positiveMeanTimeOutsideSec: iaeN ? outsideSum / iaeN : null,
      positiveEvents: new Set(pos.map(r => `${r.scenarioId}:${r.eventId}`)).size,
      positiveRecords: pos.length,
      positivePassRate: rate(pos),
      negativeRecords: neg.length,
      restraintRate: rate(neg),
    };
  });
  return {
    protocol: 'closed-loop-cpu-ablation-v1',
    variant: VARIANT,
    setpointPolicy: OPERATIONAL_SETPOINT_POLICY,
    generatedAt: new Date().toISOString(),
    seeds: SEEDS,
    queue: { positive: queue.filter(e => !e.isNegativeEvent).length, negative: queue.filter(e => e.isNegativeEvent).length, gate: FROZEN_OUTCOME_GATE_REPORT },
    vcr: VARIANT === 'setpoint-v2' ? null : { cache: CACHE_DB, model: LLM_MODEL },
    closedLoopExecutorVersion: CLOSED_LOOP_EXECUTOR_VERSION,
    arms,
  };
}

async function main() {
  mkdirSync(BASE, { recursive: true });
  const started = Date.now();
  for (const { armId, mode, loop } of ARMS) {
    for (const event of queue) {
      for (const seed of SEEDS) {
        const key = `${armId}|${event.scenarioId}|${event.eventId}|${seed}`;
        if (done.has(key)) continue;
        let row: Stored;
        try {
          const record = await runAgentStackArm({
            scenarioId: event.scenarioId,
            eventId: event.eventId,
            seed,
            mode: mode as AgentStackMode,
            executionLoop: loop,
            ...(mode !== 'full-rules' ? { llmClient: client } : {}),
          });
          if (record.armId !== armId) throw new Error(`arm mismatch ${record.armId} != ${armId}`);
          row = { key, armId, record };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/replay/i.test(message)) {
            row = { key, armId, replayMiss: message.slice(0, 300), record: null };
          } else {
            throw error;
          }
        }
        appendFileSync(RECORDS, `${JSON.stringify(row)}\n`);
        done.set(key, row);
        const r = row.record as { verdict?: { kind: string; failureMode?: string } } | null;
        console.log(`[cl-cpu] ${key} ${row.replayMiss ? 'REPLAY-MISS' : `${r?.verdict?.kind}/${r?.verdict?.failureMode ?? '-'}`} done=${done.size} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
      }
    }
  }
  const rows = [...done.values()];
  const summary = summarize(rows);
  writeFileSync(join(BASE, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`[cl-cpu] COMPLETE ${done.size} records -> ${BASE}`);
  for (const a of summary.arms) {
    console.log(`  ${a.armId}: posPass=${a.positivePassRate} restraint=${a.restraintRate} misses=${a.replayMisses}`);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === resolve(fileURLToPath(import.meta.url))) {
  main().catch(e => { console.error(e); process.exit(1); });
}
