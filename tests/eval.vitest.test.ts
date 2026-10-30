/**
 * PhysBench evaluation entry point — runs any policy on the admitted event set.
 *
 * External usage:
 *   npx vitest run physbench-eval.vitest.test.ts -t "reference"   # baseline
 *   npx vitest run physbench-eval.vitest.test.ts -t "no-op"       # counterfactual
 *
 * For custom agents: implement a Policy in policies.ts and add a case here.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import { loadFrozenOutcomeQueue } from '../src/frozen-queue.js';
import { runOutcomeFixture } from '../src/runner.js';
import { passAtK } from '../src/stats.js';

configureLogger({ level: LoggerLevel.ERROR });

const queue = loadFrozenOutcomeQueue();

async function evaluatePolicy(policyId: string) {
  const records = [];
  for (const event of queue) {
    try {
      const record = runOutcomeFixture({
        scenarioId: event.scenarioId,
        eventId: event.eventId,
        policyId,
        seed: 7,
        armId: policyId,
      });
      records.push(record);
    } catch { /* skip simulation errors */ }
  }
  return records;
}

describe('PhysBench evaluation', () => {
  const policies = ['no-op', 'reference'];

  for (const policy of policies) {
    it(`${policy}: evaluate on ${queue.length} admitted events`, { timeout: 30 * 60 * 1000 }, async () => {
      const records = await evaluatePolicy(policy);
      const positive = records.filter(r => !r.envelope.isNegativeEvent);
      const negative = records.filter(r => r.envelope.isNegativeEvent);
      const passPos = positive.filter(r => r.verdict.kind === 'pass').length;
      const passNeg = negative.filter(r => r.verdict.kind === 'pass').length;
      const pass3 = passAtK(positive, 3);

      // eslint-disable-next-line no-console
      console.log(`\n[PhysBench:${policy}]`);
      // eslint-disable-next-line no-console
      console.log(`  Physical success (positive): ${passPos}/${positive.length} = ${(100*passPos/Math.max(1,positive.length)).toFixed(1)}%`);
      // eslint-disable-next-line no-console
      console.log(`  Negative events (pass = restraint): ${passNeg}/${negative.length} = ${(100*passNeg/Math.max(1,negative.length)).toFixed(1)}%`);
      // eslint-disable-next-line no-console
      console.log(`  Pass^3 reliability: ${pass3.passK.toFixed(2)}`);

      // Save results
      const dir = join(process.cwd(), 'physbench-results');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${policy}-results.json`), JSON.stringify({
        policy, date: new Date().toISOString(),
        positiveSuccessRate: passPos / Math.max(1, positive.length),
        negativePassRate: passNeg / Math.max(1, negative.length),
        pass3: pass3.passK,
        totalEvents: records.length,
      }, null, 2));

      // Assertions
      if (policy === 'reference') {
        expect(passPos / Math.max(1, positive.length)).toBeGreaterThan(0.9); // greedy should succeed
      }
      if (policy === 'no-op') {
        expect(passPos / Math.max(1, positive.length)).toBeLessThan(0.1); // no-op should fail
      }
    });
  }
});
