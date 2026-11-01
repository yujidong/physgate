#!/usr/bin/env node
/**
 * PhysBench build script — copies source files from the embodied-agent-framework
 * monorepo into this standalone repo, rewriting host-relative imports so the
 * standalone suite runs without the monorepo layout.
 *
 * Usage: node build-from-source.mjs [path-to-embodied-agent-framework]
 * Default: ../embodied-agent-framework
 *
 * Import-rewrite contract:
 *   - src files from tests/experiments/infrastructure/outcome/ keep their
 *     same-directory imports ('./x.js') and get host-level ones ('../x.js')
 *     rewritten to local shims/copies (see SRC_REWRITES).
 *   - test files are rewritten './x.js' -> '../src/x.js' and
 *     '../result-persistence.js' -> '../src/result-persistence.js'.
 *   - src/result-persistence.ts and src/paper-experiment-runner.ts are
 *     GENERATED here (shim + extracted function) — edit the host, not these.
 *   - scenario-definitions.ts is copied with the ownership-experiment import
 *     stripped (that chain pulls the whole src/ownership module; the six
 *     hand-crafted PhysBench scenarios are unaffected).
 */

import { copyFileSync, mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK = resolve(process.argv[2] ?? join(REPO, '..', '..', 'embodied-agent-framework'));
const INFRA = join(FRAMEWORK, 'packages', 'core', 'tests', 'experiments', 'infrastructure');
const OUTCOME = join(INFRA, 'outcome');
const CORE_SRC = join(FRAMEWORK, 'packages', 'core', 'src');
const RESULTS = join(FRAMEWORK, 'packages', 'core', 'tests', 'experiment-results', 'outcome-gm');

if (!existsSync(OUTCOME)) {
  console.error(`Source not found: ${OUTCOME}`);
  console.error('Pass the path to embodied-agent-framework as the first argument.');
  process.exit(1);
}

// ---- helpers ---------------------------------------------------------------

function apply(text, rewrites) {
  let out = text;
  for (const [pattern, replacement] of rewrites) out = out.replace(pattern, replacement);
  return out;
}

function copyTransformed(srcPath, destPath, rewrites = [], label = '') {
  if (!existsSync(srcPath)) {
    console.error(`  ! missing source ${srcPath}`);
    process.exit(1);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  const text = readFileSync(srcPath, 'utf8');
  writeFileSync(destPath, rewrites.length ? apply(text, rewrites) : text);
  console.log(`  ✓ ${destPath.replace(REPO + '\\', '').replace(REPO + '/', '')}${label ? ` — ${label}` : ''}`);
}

// host-level imports inside outcome/ src files -> local copies/shims
const SRC_REWRITES = [
  [/from '\.\.\/types\.js'/g, "from './types.js'"],
  [/from '\.\.\/scenario-definitions\.js'/g, "from './scenario-definitions.js'"],
  [/from '\.\.\/result-persistence\.js'/g, "from './result-persistence.js'"],
  [/from '\.\.\/paper-experiment-runner\.js'/g, "from './paper-experiment-runner.js'"],
  [/from '\.\.\/utils\/decisionVocabulary\.js'/g, "from './decisionVocabulary.js'"],
  [/from '\.\.\/utils\/truncate\.js'/g, "from './truncate.js'"],
];
// test files live in tests/, sources in src/
const TEST_REWRITES = [
  [/from '\.\.\/result-persistence\.js'/g, "from '../src/result-persistence.js'"],
  [/from '\.\.\/scenario-definitions\.js'/g, "from '../src/scenario-definitions.js'"],
  [/from '\.\.\/paper-experiment-runner\.js'/g, "from '../src/paper-experiment-runner.js'"],
  [/from '\.\/([A-Za-z0-9_-]+)\.js'/g, "from '../src/$1.js'"],
];

// ---- main copy list (outcome/ instrument) -----------------------------------

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
  ['generate-physbench-scenarios.ts', 'src/generate-physbench-scenarios.ts', 'Programmatic scenario generator'],
  ['physbench-manifest.ts', 'src/physbench-manifest.ts', 'Parameter family + scenario template registry'],
  ['scenario-registry.ts', 'src/scenario-registry.ts', 'Unified scenario lookup'],
  ['time-calibration.ts', 'src/time-calibration.ts', 'Sim-to-real time conversion (596x)'],
  ['stats.ts', 'src/stats.ts', 'Cluster bootstrap, sign test, pass^k, Holm'],
  ['gm-report.ts', 'src/gm-report.ts', 'G-M gate report builder'],
  ['figures.ts', 'src/figures.ts', 'Paper figure generation'],
  ['frozen-queue.ts', 'src/frozen-queue.ts', 'Frozen 67+19 queue loader'],
  ['tier-inventory.ts', 'src/tier-inventory.ts', 'Tier inventory builder'],
  ['holdout.ts', 'src/holdout.ts', 'Holdout split manifest'],
  ['human-audit.ts', 'src/human-audit.ts', 'Human-audit packet builder'],
  ['sensitivity.ts', 'src/sensitivity.ts', '27-grid sensitivity + admission churn'],
  ['full-rules-arm.ts', 'src/full-rules-arm.ts', 'Rules adapter'],
  ['agent-arm.ts', 'src/agent-arm.ts', 'Agent-stack arm runner (open/closed loop)'],
  ['closed-loop-executor.ts', 'src/closed-loop-executor.ts', 'Execution-only feedback executor'],
  ['five-arm-physbench-full.mts', 'src/five-arm-physbench-full.mts', 'Full-cohort CPU arms + decisionAcc + continuous metrics'],
  ['closed-loop-cpu-ablation.mts', 'src/closed-loop-cpu-ablation.mts', 'Open/closed-loop ablation (VCR replay, GPU-free)'],
  ['boptest-fmu-rerun.sh', 'scripts/boptest-fmu-rerun.sh', 'Real-FMU rerun runner (3 arms x 3 reps, pre-registered criterion)'],
  // LLM arm configuration disclosure (paper §IV) — verbatim from the framework
  ['../../../../src/decision/assessor-prompts.ts', 'src/llm-assessor-prompts.ts', 'LLM arm system prompt + sampling policy (verbatim)'],
  ['../../../../src/decision/cognitive-decision.ts', 'src/llm-decision-schema.ts', 'decision-v1 structured-output schema (verbatim)'],
  // Tests
  ['outcome-fixtures.vitest.test.ts', 'tests/fixtures.vitest.test.ts', 'A2: fixture validation'],
  ['outcome-determinism.vitest.test.ts', 'tests/determinism.vitest.test.ts', 'A3: determinism + reset'],
  ['physbench-gm-gate.vitest.test.ts', 'tests/gm-gate.vitest.test.ts', 'G-M admission scan'],
  ['physbench-eval.vitest.test.ts', 'tests/eval.vitest.test.ts', 'Evaluation entry point'],
  ['physbench-scenarios.vitest.test.ts', 'tests/scenarios.vitest.test.ts', 'Scenario generation test'],
  ['new-families-calibration.vitest.test.ts', 'tests/new-families.vitest.test.ts', 'New family calibration'],
  // sensitivity.vitest.test.ts is NOT copied: the host version re-runs the
  // agent-stack arm (needs the full CognitiveAgent framework). The standalone
  // repo owns tests/sensitivity.vitest.test.ts validating the frozen artifact.
  ['boptest-coupling.vitest.test.ts', 'tests/boptest.vitest.test.ts', 'BOPTEST 1R1C surrogate coupling'],
  ['boptest-fmu.vitest.test.ts', 'tests/boptest-fmu.vitest.test.ts', 'BOPTEST real FMU rerun scoring (pre-registered criterion)'],
  ['five-arm-physbench-full.vitest.test.ts', 'tests/five-arm-physbench-full.vitest.test.ts', 'Pinned full-cohort CPU-arm results'],
  ['closed-loop-cpu-ablation.vitest.test.ts', 'tests/closed-loop-cpu-ablation.vitest.test.ts', 'Pinned closed-loop ablation results'],
  ['closed-loop-setpoint-ablation.vitest.test.ts', 'tests/closed-loop-setpoint-ablation.vitest.test.ts', 'Pinned setpoint-recalibration factorial'],
];

let copied = 0;
for (const [src, dest, desc] of copies) {
  const srcPath = join(OUTCOME, src);
  const destPath = join(REPO, dest);
  if (!existsSync(srcPath)) continue;
  const isTest = dest.startsWith('tests/');
  copyTransformed(srcPath, destPath, isTest ? TEST_REWRITES : SRC_REWRITES, desc);
  copied++;
}

// ---- transitive host dependencies -------------------------------------------

const infraCopies = [
  [join(INFRA, 'types.ts'), join(REPO, 'src/types.ts'), 'Scenario/zone/device/event type defs (verbatim)'],
  [join(INFRA, 'zone-device-generator.ts'), join(REPO, 'src/zone-device-generator.ts'), 'Device/agent instantiation for scenarios (verbatim)'],
];
for (const [srcPath, destPath, desc] of infraCopies) {
  copyTransformed(srcPath, destPath, [], desc);
  copied++;
}

const coreCopies = [
  [join(CORE_SRC, 'decision', 'decision-schema.ts'), join(REPO, 'src/decision-schema.ts'), 'decision-v1 JSON-schema validator'],
  [join(CORE_SRC, 'decision', 'schemas', 'decision-v1.json'), join(REPO, 'src/schemas/decision-v1.json'), 'decision-v1 wire schema document'],
  [join(CORE_SRC, 'utils', 'decisionVocabulary.ts'), join(REPO, 'src/decisionVocabulary.ts'), 'Decision vocabulary canonicalizer (verbatim)'],
  [join(CORE_SRC, 'utils', 'truncate.ts'), join(REPO, 'src/truncate.ts'), 'Storage truncation helper (verbatim)'],
];
for (const [srcPath, destPath, desc] of coreCopies) {
  copyTransformed(srcPath, destPath, [], desc);
  copied++;
}

// scenario-definitions.ts with the ownership-experiment chain stripped
copyTransformed(
  join(INFRA, 'scenario-definitions.ts'),
  join(REPO, 'src/scenario-definitions.ts'),
  [
    [/import \{ ownershipExperimentScenarios \} from '\.\/ownership\/adapter\.js';\r?\n/g, ''],
    [/\.\.\.ownershipExperimentScenarios\(\),?\r?\n/g, ''],
  ],
  'Six hand-crafted scenarios (ownership-experiment scenarios stripped — see header)',
);
copied++;

// ---- generated shims ---------------------------------------------------------

// The 36 MB raw ablation records are not copied (SKIP below); make the
// failure-mode pin self-skip gracefully when the file is absent.
const clTestPath = join(REPO, 'tests/closed-loop-cpu-ablation.vitest.test.ts');
if (existsSync(clTestPath)) {
  const t = readFileSync(clTestPath, 'utf8');
  const patched = t.replace(
    "it('failure-mode decomposition",
    "it.skipIf(!existsSync(join(DIR, 'records.jsonl')))('failure-mode decomposition",
  );
  if (patched !== t) writeFileSync(clTestPath, patched);
}

writeFileSync(join(REPO, 'src/result-persistence.ts'), `/**
 * GENERATED by build-from-source.mjs — standalone shim for the host
 * tests/experiments/infrastructure/result-persistence.ts. Artifacts mirror
 * the host layout under <repo>/results/outcome-gm/.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function getResultsBaseDir(): string {
  return join(fileURLToPath(new URL('..', import.meta.url)), 'results');
}
`);
console.log('  ✓ src/result-persistence.ts — generated shim');
copied++;

// extract resolveEventParameter + the BASELINE_PARAMS / NON_PHYSICAL_PARAMETERS
// constants (the drift-guard test mirrors calibration against them) from the
// host runner — all brace-balanced extractions
const perSource = readFileSync(join(INFRA, 'paper-experiment-runner.ts'), 'utf8');
function extractBlock(source, startMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) { console.error(`marker not found: ${startMarker}`); process.exit(1); }
  const bodyOpenMatch = /\{\r?\n/.exec(source.slice(start));
  if (!bodyOpenMatch) { console.error(`body not found for: ${startMarker}`); process.exit(1); }
  const bodyOpen = start + bodyOpenMatch.index;
  let depth = 0;
  for (let i = bodyOpen; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  console.error(`unbalanced braces for: ${startMarker}`); process.exit(1);
}
const fnBody = extractBlock(perSource, 'export function resolveEventParameter');
const baselineBody = extractBlock(perSource, 'export const BASELINE_PARAMS');
const nonPhysicalBody = extractBlock(perSource, 'export const NON_PHYSICAL_PARAMETERS');
writeFileSync(join(REPO, 'src/paper-experiment-runner.ts'), `/**
 * GENERATED by build-from-source.mjs — resolveEventParameter,
 * BASELINE_PARAMS and NON_PHYSICAL_PARAMETERS extracted verbatim from the
 * host paper-experiment-runner.ts (the rest of that file is out of scope for
 * the standalone instrument).
 */
import type { TestEventDef } from './types.js';

${fnBody}

${baselineBody}

${nonPhysicalBody}
`);
console.log('  ✓ src/paper-experiment-runner.ts — generated (extracted function)');
copied++;

// ---- results artifacts --------------------------------------------------------

// Bulky raw record dumps stay in the host repo; the pinned summaries carry
// every number the paper cites.
const SKIP = new Set(['records.jsonl']);

function copyTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const f of readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP.has(f.name)) continue;
    if (f.isDirectory()) copyTree(join(srcDir, f.name), join(destDir, f.name));
    else { try { copyFileSync(join(srcDir, f.name), join(destDir, f.name)); } catch {} }
  }
}

const RESULT_SUBDIRS = [
  'physbench-gm', 'figures', 'calibration', 'sensitivity', 'five-arm-reanalysis-v2',
  'five-arm-physbench-full', 'closed-loop-cpu-ablation', 'closed-loop-setpoint-ablation', 'boptest-fmu',
];
for (const subdir of RESULT_SUBDIRS) {
  const src = join(RESULTS, subdir);
  if (existsSync(src)) {
    copyTree(src, join(REPO, 'results', 'outcome-gm', subdir));
    console.log(`  ✓ results/outcome-gm/${subdir}/`);
    copied++;
  }
}

// the frozen G-M batch: only the gate report (the per-run JSONs are 25 MB)
const FROZEN_BATCH = '2026-10-24T18-05-32-388Z';
const frozenReport = join(RESULTS, FROZEN_BATCH, 'gm-gate-report.json');
if (existsSync(frozenReport)) {
  mkdirSync(join(REPO, 'results', 'outcome-gm', FROZEN_BATCH), { recursive: true });
  copyFileSync(frozenReport, join(REPO, 'results', 'outcome-gm', FROZEN_BATCH, 'gm-gate-report.json'));
  console.log(`  ✓ results/outcome-gm/${FROZEN_BATCH}/gm-gate-report.json`);
  copied++;
}

console.log(`\nDone: ${copied} files copied.`);
console.log('\nNext steps:');
console.log('  npm install');
console.log('  npm test');
