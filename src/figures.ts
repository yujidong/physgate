/**
 * D1 — paper figures pipeline (dependency-free SVG).
 *
 * Two figures over the FROZEN artifacts (no live simulation; every number
 * traces to a file — the same numbers land in figures-data.json next to the
 * SVGs, D2 rule):
 *
 *   fig1-task-set-audit.svg
 *     A. Task-set audit funnel: 177 events → tier split → admission
 *        (67 positive + 19 negative admitted; 3 edge-excluded with reasons).
 *     B. The §8.5 defect, measured: legacy predicate no-op auto-pass
 *        101/177 (branch anatomy) vs the new instrument 0/67 on admitted
 *        positives.
 *
 *   fig2-arm-outcomes.svg  (authoritative numbers: five-arm-reanalysis-v2)
 *     A. Per-arm physical success (positive / negative events) + pass³.
 *     B. Per-arm live cost (prompt/completion tokens, log scale, calls/evt).
 *
 * If the closed-loop matrix (paper-physical-closedloop workstream) has
 * produced `closed-loop-matrix-v1/arm-summary.json`, its arms are appended
 * to fig2 automatically — re-running this script after their GPU run
 * refreshes the figure without code changes.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResultsBaseDir } from '../result-persistence.js';
import { buildTierInventory, FROZEN_SCENARIO_IDS } from './tier-inventory.js';
import { FROZEN_OUTCOME_COUNTS, FROZEN_OUTCOME_EXCLUDED_EVENT_IDS, frozenOutcomeEventKey, loadFrozenOutcomeQueue, FROZEN_OUTCOME_GATE_REPORT } from './frozen-queue.js';

// palette: colorblind-safe (Okabe–Ito)
const C = {
  pos: '#009E73',      // admitted positive
  neg: '#56B4E9',      // admitted negative
  edge: '#E69F00',     // edge-excluded
  natural: '#CC79A7',  // natural-recovery exclusion
  nophys: '#999999',   // unscorable: non-physical
  noenv: '#CCCCCC',    // unscorable: no validated envelope
  legacy: '#D55E00',   // legacy predicate defect
  modern: '#0072B2',   // new instrument
  ink: '#222222',
  faint: '#888888',
};

export interface FigureData {
  generatedAt: string;
  sources: Record<string, string>;
  audit: {
    total: number;
    physical: number;
    naturalRecovery: number;
    unscorableNonPhysical: number;
    unscorableNoEnvelope: number;
    admittedPositive: number;
    admittedNegative: number;
    edgeExcluded: Array<{ eventId: string; reason: string }>;
    perScenario: Array<{ scenarioId: string; total: number; physical: number }>;
  };
  legacy: {
    totalEvents: number;
    totalNoOpPasses: number;
    actionRequired: { passes: number; total: number };
    negative: { passes: number; total: number };
    branches: Record<string, number>;
  };
  modernNoOpAdmittedPositivePasses: number;
  arms: Array<{
    armId: string;
    passPositive: number | null;
    passNegative: number | null;
    passK: number;
    split?: { train: number | null; templateHoldout: number | null; scenarioTransfer: number | null };
    tokenIn: number;
    tokenOut: number;
    llmCallsPerEvent: number;
    source: string;
    /** #4 restraint metric (negative events): share of runs with NO unpermitted action */
    restraintRate?: number | null;
    unpermittedCount?: number;
    negativeRuns?: number;
  }>;
}

interface SlimRecord {
  armId: string;
  negative: boolean;
  kind: string;
  failureMode: string | null;
}

interface V2Summary {
  armSummary: Array<{
    armId: string;
    positive: { passRate: number | null; train: { passRate: number | null }; templateHoldout: { passRate: number | null }; scenarioTransfer: { passRate: number | null } };
    negative: { passRate: number | null };
    passK: { passK: number };
    costPerEvent: { tokenIn: number; tokenOut: number; llmCalls: number };
  }>;
}

export function buildFigureData(): FigureData {
  const base = getResultsBaseDir();
  const v2Path = join(base, 'outcome-gm', 'five-arm-reanalysis-v2', 'five-arm-summary.json');
  const legacyPath = join(base, 'outcome-gm', 'legacy-noop-audit', 'legacy-noop-audit.json');
  const closedPath = join(base, 'outcome-gm', 'closed-loop-matrix-v1', 'arm-summary.json');

  const v2 = JSON.parse(readFileSync(v2Path, 'utf-8')) as V2Summary;
  const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8')) as {
    summary: {
      totalEvents: number; actionRequiredEvents: number; negativeEvents: number;
      actionRequiredNoopPasses: number; negativeNoopPasses: number;
      actionRequiredPassBranches: Record<string, number>;
    };
  };

  const rows = buildTierInventory().filter(r => FROZEN_SCENARIO_IDS.includes(r.scenarioId as never));
  const naturalRecovery = rows.filter(r => r.tier === 'natural-recovery').length;
  const unscorableNonPhysical = rows.filter(r => r.naReason?.startsWith('non-physical')).length;
  const unscorableNoEnvelope = rows.filter(r => r.naReason?.startsWith('no-validated-envelope')).length;
  const physical = rows.filter(r => r.tier === 'physical').length;

  const edgeReasons: Record<string, string> = {
    'evt-factory-3': 'unreachable: extreme injection exceeds the pre-registered deadline',
    'evt-sc-7': 'unreachable: extreme injection exceeds the pre-registered deadline',
    'evt-apt-42': 'non-discriminative: mild injection self-heals inside the deadline',
  };

  const perScenario = FROZEN_SCENARIO_IDS.map(scenarioId => {
    const scRows = rows.filter(r => r.scenarioId === scenarioId);
    return { scenarioId, total: scRows.length, physical: scRows.filter(r => r.tier === 'physical').length };
  });

  const arms: FigureData['arms'] = v2.armSummary.map(a => ({
    armId: a.armId,
    passPositive: a.positive.passRate,
    passNegative: a.negative.passRate,
    passK: a.passK.passK,
    split: {
      train: a.positive.train.passRate,
      templateHoldout: a.positive.templateHoldout.passRate,
      scenarioTransfer: a.positive.scenarioTransfer.passRate,
    },
    tokenIn: a.costPerEvent.tokenIn,
    tokenOut: a.costPerEvent.tokenOut,
    llmCallsPerEvent: a.costPerEvent.llmCalls,
    source: 'five-arm-reanalysis-v2',
  }));

  // closed-loop arms append automatically once the sibling workstream's
  // matrix has produced its summary
  if (existsSync(closedPath)) {
    const closed = JSON.parse(readFileSync(closedPath, 'utf-8')) as V2Summary;
    for (const a of closed.armSummary) {
      arms.push({
        armId: a.armId,
        passPositive: a.positive.passRate,
        passNegative: a.negative.passRate,
        passK: a.passK.passK,
        split: {
          train: a.positive.train?.passRate ?? null,
          templateHoldout: a.positive.templateHoldout?.passRate ?? null,
          scenarioTransfer: a.positive.scenarioTransfer?.passRate ?? null,
        },
        tokenIn: a.costPerEvent.tokenIn,
        tokenOut: a.costPerEvent.tokenOut,
        llmCallsPerEvent: a.costPerEvent.llmCalls,
        source: 'closed-loop-matrix-v1',
      });
    }
  }

  const noopArm = v2.armSummary.find(a => a.armId === 'no-op');

  // #4 restraint metric: per-arm share of NEGATIVE-event runs with no
  // unpermitted action (read from the persisted per-run records — they carry
  // failureMode per run; the summaries only have aggregate pass−).
  const restraintByArm = new Map<string, { unpermitted: number; runs: number }>();
  const matrixDir = join(base, 'outcome-gm', 'five-arm-matrix');
  // queue-filter to the frozen cohort (same selection as five-arm v2) so the
  // figure restraint numbers match the summary the paper cites
  const queueKeys = new Set(loadFrozenOutcomeQueue(FROZEN_OUTCOME_GATE_REPORT).map(frozenOutcomeEventKey));
  if (existsSync(matrixDir)) {
    for (const f of readdirSync(matrixDir)) {
      if (!f.startsWith('records-') || !f.endsWith('.json')) continue;
      const rows = JSON.parse(readFileSync(join(matrixDir, f), 'utf8')) as SlimRecord[];
      for (const r of rows) {
        if (!r.negative) continue;
        if (!queueKeys.has(frozenOutcomeEventKey(r))) continue;
        const e = restraintByArm.get(r.armId) ?? { unpermitted: 0, runs: 0 };
        e.runs++;
        if (r.failureMode === 'unpermitted-action') e.unpermitted++;
        restraintByArm.set(r.armId, e);
      }
    }
  }
  for (const arm of arms) {
    const e = restraintByArm.get(arm.armId);
    if (e && e.runs > 0) {
      arm.restraintRate = Number((1 - e.unpermitted / e.runs).toFixed(4));
      arm.unpermittedCount = e.unpermitted;
      arm.negativeRuns = e.runs;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sources: { v2: v2Path, legacy: legacyPath, closedLoopOptional: closedPath },
    audit: {
      total: rows.length,
      physical,
      naturalRecovery,
      unscorableNonPhysical,
      unscorableNoEnvelope,
      admittedPositive: FROZEN_OUTCOME_COUNTS.positive,
      admittedNegative: FROZEN_OUTCOME_COUNTS.negative,
      edgeExcluded: FROZEN_OUTCOME_EXCLUDED_EVENT_IDS.map(id => ({ eventId: id, reason: edgeReasons[id] ?? 'edge exclusion (see G-M report)' })),
      perScenario,
    },
    legacy: {
      totalEvents: legacy.summary.totalEvents,
      totalNoOpPasses: legacy.summary.actionRequiredNoopPasses + legacy.summary.negativeNoopPasses,
      actionRequired: { passes: legacy.summary.actionRequiredNoopPasses, total: legacy.summary.actionRequiredEvents },
      negative: { passes: legacy.summary.negativeNoopPasses, total: legacy.summary.negativeEvents },
      branches: legacy.summary.actionRequiredPassBranches,
    },
    modernNoOpAdmittedPositivePasses: noopArm ? Math.round((noopArm.positive.passRate ?? 0) * FROZEN_OUTCOME_COUNTS.positive) : 0,
    arms,
  };
}

// ---------------------------------------------------------------------------
// Minimal SVG helpers (hand-rolled, deterministic, no dependencies)
// ---------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svgOpen(w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Helvetica,Arial,sans-serif">`;
}
function text(x: number, y: number, s: string, size = 12, fill = C.ink, anchor = 'start', weight = 'normal'): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}">${esc(s)}</text>`;
}
function rect(x: number, y: number, w: number, h: number, fill: string, extra = ''): string {
  return `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${h}" fill="${fill}" ${extra}/>`;
}

// ---------------------------------------------------------------------------
// Figure 1 — task-set audit + the measured §8.5 defect
// ---------------------------------------------------------------------------

export function renderFig1(d: FigureData): string {
  const W = 940, H = 460;
  const parts: string[] = [svgOpen(W, H)];

  parts.push(text(30, 34, 'Task-set validity audit — 177 events, six frozen scenarios', 17, C.ink, 'start', 'bold'));

  // ---- Panel A: tier funnel (horizontal stacked bar) ----
  const barY = 70, barH = 34, barX = 40, barW = 780;
  const total = d.audit.total;
  const seg = [
    { n: d.audit.admittedPositive, c: C.pos, label: `admitted positive ${d.audit.admittedPositive}` },
    { n: d.audit.admittedNegative, c: C.neg, label: `admitted negative ${d.audit.admittedNegative}` },
    { n: 3, c: C.edge, label: 'edge-excluded 3' },
    { n: d.audit.naturalRecovery, c: C.natural, label: `natural-recovery ${d.audit.naturalRecovery}` },
    { n: d.audit.unscorableNonPhysical, c: C.nophys, label: `unscorable: non-physical ${d.audit.unscorableNonPhysical}` },
    { n: d.audit.unscorableNoEnvelope, c: C.noenv, label: `unscorable: no envelope ${d.audit.unscorableNoEnvelope}` },
  ];
  let x = barX;
  parts.push(text(30, 62, `A. Structural tiering (before any model result)`, 13, C.ink, 'start', 'bold'));
  for (const s of seg) {
    const w = (s.n / total) * barW;
    parts.push(rect(x, barY, w, barH, s.c));
    if (w > 26) parts.push(text(x + w / 2, barY + 21, String(s.n), 12, '#ffffff', 'middle', 'bold'));
    x += w;
  }
  // legend (two columns)
  const legend = seg.map(s => ({ c: s.c, t: s.label }));
  legend.forEach((l, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const lx = 40 + col * 400, ly = barY + barH + 26 + row * 20;
    parts.push(rect(lx, ly - 10, 12, 12, l.c));
    parts.push(text(lx + 18, ly, l.t, 11.5, C.ink));
  });
  // edge-excluded reasons
  let ry = barY + barH + 26 + 3 * 20 + 8;
  parts.push(text(40, ry, 'Edge exclusions (honest, pre-registered deadlines not re-tuned):', 11.5, C.ink, 'start', 'bold'));
  ry += 16;
  for (const e of d.audit.edgeExcluded) {
    parts.push(text(48, ry, `• ${e.eventId} — ${e.reason}`, 11, C.faint));
    ry += 15;
  }

  // ---- Panel B: legacy defect vs new instrument ----
  const pBY = 300;
  parts.push(text(30, pBY - 12, `B. No-op auto-pass: legacy predicate vs this instrument`, 13, C.ink, 'start', 'bold'));
  const rowsB = [
    { label: 'legacy predicate (§8.5, reproduced)', rate: d.legacy.totalNoOpPasses / d.legacy.totalEvents, n: `${d.legacy.totalNoOpPasses}/${d.legacy.totalEvents}`, c: C.legacy },
    { label: 'this instrument (admitted positives)', rate: d.modernNoOpAdmittedPositivePasses / d.audit.admittedPositive, n: `${d.modernNoOpAdmittedPositivePasses}/${d.audit.admittedPositive}`, c: C.modern },
  ];
  rowsB.forEach((r, i) => {
    const by = pBY + i * 44;
    parts.push(text(40, by + 14, r.label, 11.5));
    parts.push(rect(330, by, 420, 24, '#F2F2F2'));
    parts.push(rect(330, by, 420 * r.rate, 24, r.c));
    parts.push(text(760, by + 16, `${r.n}  (${(r.rate * 100).toFixed(1)}%)`, 12, C.ink, 'start', 'bold'));
  });
  const b = d.legacy.branches;
  parts.push(text(40, pBY + 2 * 44 + 18,
    `legacy auto-pass anatomy: ${b.targetValue ?? 0} target±tolerance already inside · ${b['non-physical'] ?? 0} non-physical auto-PASS · ${b.shouldChange ?? 0} shouldChange self-satisfied`, 11, C.faint));

  parts.push(`</svg>`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Figure 2 — arm outcomes + cost (authoritative: five-arm-reanalysis-v2)
// ---------------------------------------------------------------------------

export function renderFig2(d: FigureData): string {
  const W = 940, H = 470;
  const parts: string[] = [svgOpen(W, H)];
  const arms = d.arms;

  parts.push(text(30, 34, `Physical success vs cost — ${arms.length} arms × frozen queue (67 positive + 19 negative events × 3 paired seeds)`, 16, C.ink, 'start', 'bold'));

  // ---- Panel A: success rates ----
  const ax = 60, ayTop = 70, aw = 420, ah = 280;
  parts.push(text(30, 62, `A. Physical success rate`, 13, C.ink, 'start', 'bold'));
  parts.push(rect(ax, ayTop, aw, ah, '#FAFAFA'));
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const y = ayTop + ah - t * ah;
    parts.push(`<line x1="${ax}" y1="${y}" x2="${ax + aw}" y2="${y}" stroke="#E0E0E0" stroke-width="1"/>`);
    parts.push(text(ax - 8, y + 4, t.toFixed(2), 10, C.faint, 'end'));
  }
  const n = arms.length;
  const slot = aw / n;
  arms.forEach((a, i) => {
    const cx = ax + slot * i + slot / 2;
    const bw = Math.min(30, slot * 0.42);
    const hp = (a.passPositive ?? 0) * ah;
    const hn = (a.passNegative ?? 0) * ah;
    parts.push(rect(cx - bw - 2, ayTop + ah - hp, bw, hp, C.modern));
    parts.push(rect(cx + 2, ayTop + ah - hn, bw, hn, C.neg));
    // pass^k under the arm label
    const short = a.armId.replace('-llm', '\nllm');
    const lines = short.split('\n');
    lines.forEach((ln, li) => parts.push(text(cx, ayTop + ah + 16 + li * 12, ln, 10.5, C.ink, 'middle')));
    parts.push(text(cx, ayTop + ah + 16 + lines.length * 12 + 2, `pass³=${a.passK.toFixed(2)}`, 9.5, C.faint, 'middle'));
  });
  parts.push(rect(ax + aw - 150, ayTop + 8, 12, 12, C.modern));
  parts.push(text(ax + aw - 132, ayTop + 18, 'positive events', 11));
  parts.push(rect(ax + aw - 150, ayTop + 26, 12, 12, C.neg));
  parts.push(text(ax + aw - 132, ayTop + 36, 'negative events', 11));

  // #4 restraint metric: share of negative-event runs with NO unpermitted action
  const restrained = arms.filter(a => a.restraintRate !== undefined && a.restraintRate !== null);
  if (restrained.length > 0) {
    parts.push(text(ax, ayTop + ah - 12,
      'restraint (no unpermitted action): ' + restrained.map(a => `${a.armId.replace('-llm', '-llm')} ${a.restraintRate!.toFixed(2)}`).join(' · '),
      10, C.ink));
  }

  // ---- Panel B: cost per event (log scale) ----
  const bx = 540, bw2 = 340;
  parts.push(text(510, 62, `B. Live cost per event (tokens, log scale)`, 13, C.ink, 'start', 'bold'));
  const maxTok = Math.max(1, ...arms.map(a => a.tokenIn + a.tokenOut));
  const logMax = Math.log10(maxTok * 1.3);
  const decades = Math.max(1, Math.ceil(logMax));
  const barAreaW = bw2 - 70;
  arms.forEach((a, i) => {
    const by = 80 + i * 40;
    const wIn = a.tokenIn > 0 ? (Math.log10(a.tokenIn * 1.02) / decades) * barAreaW : 0;
    const wOut = a.tokenOut > 0 ? (Math.log10(a.tokenOut * 1.02) / decades) * barAreaW : 0;
    parts.push(rect(bx, by, wIn, 14, C.legacy));
    parts.push(rect(bx + wIn, by, wOut, 14, C.natural));
    const totalTok = a.tokenIn + a.tokenOut;
    parts.push(text(bx + barAreaW + 8, by + 11,
      totalTok > 0 ? `${Math.round(a.tokenIn)}+${Math.round(a.tokenOut)} · ${a.llmCallsPerEvent.toFixed(1)} calls` : '— (no LLM)',
      10.5, C.ink));
    parts.push(text(bx - 8, by + 11, a.armId, 11, C.ink, 'end'));
  });
  // log axis ticks
  for (let dec = 0; dec <= decades; dec++) {
    const tx = bx + (dec / decades) * barAreaW;
    parts.push(`<line x1="${tx}" y1="${80 + arms.length * 40 + 4}" x2="${tx}" y2="${80 + arms.length * 40 + 10}" stroke="#999"/>`);
    parts.push(text(tx, 80 + arms.length * 40 + 24, `1e${dec}`, 10, C.faint, 'middle'));
  }
  const legY = 80 + arms.length * 40 + 44;
  parts.push(rect(bx, legY - 10, 12, 12, C.legacy)); parts.push(text(bx + 18, legY, 'prompt tokens', 11));
  parts.push(rect(bx + 110, legY - 10, 12, 12, C.natural)); parts.push(text(bx + 128, legY, 'completion tokens', 11));

  parts.push(text(30, H - 14, `source: ${esc('five-arm-reanalysis-v2/five-arm-summary.json')} · closed-loop arms auto-include when their matrix lands`, 10, C.faint));
  parts.push(`</svg>`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------

export function writeFigures(): { dir: string; files: string[] } {
  const dir = join(getResultsBaseDir(), 'outcome-gm', 'figures');
  mkdirSync(dir, { recursive: true });
  const data = buildFigureData();
  writeFileSync(join(dir, 'figures-data.json'), JSON.stringify(data, null, 2));
  writeFileSync(join(dir, 'fig1-task-set-audit.svg'), renderFig1(data));
  writeFileSync(join(dir, 'fig2-arm-outcomes.svg'), renderFig2(data));
  return { dir, files: ['figures-data.json', 'fig1-task-set-audit.svg', 'fig2-arm-outcomes.svg'] };
}
