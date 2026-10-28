/**
 * #8 — envelope sensitivity: the headline arm separation must survive every
 * perturbation of the evaluator's design constants (deadline/hold/envelope
 * width). Rank instability or full-rules recovery under any grid point is a
 * RED result — report it, never tune it away.
 */

import { describe, it, expect } from 'vitest';
import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import { runSensitivityAsync, SENSITIVITY_GRID, writeSensitivityArtifact } from './sensitivity.js';

configureLogger({ level: LoggerLevel.ERROR });

describe('envelope sensitivity analysis', () => {
  it('grid is the full 27-point cross product', () => {
    expect(SENSITIVITY_GRID).toHaveLength(27);
  });

  it('headline separation is rank-stable across the entire grid (frozen 67-event queue × 3 seeds)', { timeout: 25 * 60 * 1000 }, async () => {
    const report = await runSensitivityAsync();
    const dir = writeSensitivityArtifact(report);
    // eslint-disable-next-line no-console
    console.log(
      `[sensitivity] ${SENSITIVITY_GRID.length} grid points → ${dir} | rankStable=${report.rankStableAllGrids} | ` +
      `Δgreedy−noOp range [${Math.min(...Object.values(report.greedyMinusNoOpByGrid)).toFixed(3)}, ` +
      `${Math.max(...Object.values(report.greedyMinusNoOpByGrid)).toFixed(3)}]`,
    );
    const greedy = report.arms.find(a => a.armId === 'perfect-info-greedy')!.passPositiveByGrid;
    const rules = report.arms.find(a => a.armId === 'full-rules')!.passPositiveByGrid;
    // eslint-disable-next-line no-console
    console.log(`[sensitivity] greedy pass+ range [${Math.min(...Object.values(greedy)).toFixed(3)}, ${Math.max(...Object.values(greedy)).toFixed(3)}] · full-rules max ${Math.max(...Object.values(rules)).toFixed(3)}`);
    const worstFlips = Math.max(...Object.values(report.alreadySafeFlipsByGrid).map(v => v.length));
    // eslint-disable-next-line no-console
    console.log(`[sensitivity] worst already-safe flips at one grid point: ${worstFlips} events`);

    expect(report.rankStableAllGrids).toBe(true);
    expect(Math.min(...Object.values(report.greedyMinusNoOpByGrid))).toBeGreaterThan(0.2);
    expect(Math.max(...Object.values(rules))).toBeLessThanOrEqual(0.05);
  }, 26 * 60 * 1000);
});
