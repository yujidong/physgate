#!/usr/bin/env node
/**
 * PhysBench build script — copies source files from the embodied-agent-framework
 * monorepo into this standalone repo.
 *
 * Usage: node build-from-source.mjs [path-to-embodied-agent-framework]
 * Default: ../embodied-agent-framework
 */

import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FRAMEWORK = resolve(process.argv[2] ?? '../embodied-agent-framework');
const OUTCOME = join(FRAMEWORK, 'packages', 'core', 'tests', 'experiments', 'infrastructure', 'outcome');
const REPO = import.meta.dirname;

if (!existsSync(OUTCOME)) {
  console.error(`Source not found: ${OUTCOME}`);
  console.error('Pass the path to embodied-agent-framework as the first argument.');
  process.exit(1);
}

const copies = [
  // [source, dest, description]
  ['schema.ts', 'src/schema.ts', 'Versioned outcome record types'],
  ['calibration.ts', 'src/calibration.ts', 'Physical family calibration table'],
  ['envelope.ts', 'src/envelope.ts', 'Event → envelope/deadline/hold derivation'],
  ['evaluate.ts', 'src/evaluate.ts', 'Pure predicates → pass/fail/N-A + failure modes'],
  ['runner.ts', 'src/runner.ts', 'Scenario-event-run orchestrator'],
  ['world.ts', 'src/world.ts', 'Deterministic outcome world (SpatialField)'],
  ['policies.ts', 'src/policies.ts', 'Fixture policies (no-op/reference/wrong-way/...)'],
  ['expectations.ts', 'src/expectations.ts', 'Manual expectations table (G-M gate ground truth)'],
  ['new-parameter-families.ts', 'src/new-parameter-families.ts', '8 new PhysBench parameter families'],
  ['generate-physbench-scenarios.ts', 'src/generate-scenarios.ts', 'Programmatic scenario generator'],
  ['physbench-manifest.ts', 'src/manifest.ts', 'Parameter family + scenario template registry'],
  ['scenario-registry.ts', 'src/scenario-registry.ts', 'Unified scenario lookup'],
  ['time-calibration.ts', 'src/time-calibration.ts', 'Sim-to-real time conversion (596x)'],
  ['stats.ts', 'src/stats.ts', 'Cluster bootstrap, sign test, pass^k, Holm'],
  ['gm-report.ts', 'src/gm-report.ts', 'G-M gate report builder'],
  ['figures.ts', 'src/figures.ts', 'Paper figure generation'],
  // Tests
  ['outcome-fixtures.vitest.test.ts', 'tests/fixtures.vitest.test.ts', 'A2: fixture validation'],
  ['outcome-determinism.vitest.test.ts', 'tests/determinism.vitest.test.ts', 'A3: determinism + reset'],
  ['physbench-gm-gate.vitest.test.ts', 'tests/gm-gate.vitest.test.ts', 'G-M admission scan'],
  ['physbench-eval.vitest.test.ts', 'tests/eval.vitest.test.ts', 'Evaluation entry point'],
  ['physbench-scenarios.vitest.test.ts', 'tests/scenarios.vitest.test.ts', 'Scenario generation test'],
  ['new-families-calibration.vitest.test.ts', 'tests/new-families.vitest.test.ts', 'New family calibration'],
  ['sensitivity.vitest.test.ts', 'tests/sensitivity.vitest.test.ts', 'Envelope sensitivity (27 grids)'],
  ['boptest-coupling.vitest.test.ts', 'tests/boptest.vitest.test.ts', 'BOPTEST FMU coupling'],
  ['boptest-fmu.vitest.test.ts', 'tests/boptest-fmu.vitest.test.ts', 'BOPTEST real FMU portability'],
  ['physbench-gm-gate.vitest.test.ts', 'tests/gm-gate.vitest.test.ts', 'G-M gate'],
];

let copied = 0;
for (const [src, dest, desc] of copies) {
  const srcPath = join(OUTCOME, src);
  const destPath = join(REPO, dest);
  if (!existsSync(srcPath)) continue;
  mkdirSync(join(destPath, '..'), { recursive: true });
  copyFileSync(srcPath, destPath);
  console.log(`  ✓ ${dest} — ${desc}`);
  copied++;
}

// Copy results artifacts
const resultsDir = join(FRAMEWORK, 'packages', 'core', 'tests', 'experiment-results', 'outcome-gm');
for (const subdir of ['physbench-gm', 'figures', 'calibration', 'sensitivity', 'five-arm-reanalysis-v2']) {
  const src = join(resultsDir, subdir);
  const dest = join(REPO, 'results', subdir);
  if (existsSync(src)) {
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(src)) {
      try { copyFileSync(join(src, f), join(dest, f)); } catch {}
    }
    console.log(`  ✓ results/${subdir}/`);
    copied++;
  }
}

console.log(`\nDone: ${copied} files copied.`);
console.log('\nNext steps:');
console.log('  npm install');
console.log('  npm test');
