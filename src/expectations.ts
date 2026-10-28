/**
 * MANUAL EXPECTATIONS for the G-M measurement gate (A2).
 *
 * Hand-authored BEFORE the gate runs — this table is what "所有 fixture 的
 * 人工预期 100% 符合" is checked against. Every row states the verdict a
 * correct instrument must produce, with the physical reasoning. If a run
 * disagrees with a row, either the instrument is wrong or the physics
 * understanding is wrong — both are gate failures, never silently accepted.
 *
 * Authored against: single-room/apartment event definitions
 * (scenario-definitions.ts) + measured physics (physics-calibration-latest.json).
 */

export interface FixtureExpectation {
  scenarioId: string;
  eventId: string;
  policyId: string;
  expectedKind: 'pass' | 'fail' | 'unscorable';
  expectedFailureMode?: string;
  note: string;
}

export const MANUAL_EXPECTATIONS: FixtureExpectation[] = [
  // --- 需行动事件：no-op 必须失败（旧谓词 97/177 no-op 通过 = 本仪器要修的头号缺陷）
  {
    scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'no-op',
    expectedKind: 'fail', expectedFailureMode: 'never-entered',
    note: 'temperature 36 injected at room-1; natural relaxation never re-enters [17,25] within the horizon (probe: >1800 s)',
  },
  {
    scenarioId: 'single-room', eventId: 'evt-sr-4', policyId: 'no-op',
    expectedKind: 'fail', expectedFailureMode: 'late',
    note: 'smoke=1 decays naturally into the envelope only at ~120 s > deadline 60 s — no-op is a LATE natural recovery, still a fail',
  },
  {
    scenarioId: 'single-room', eventId: 'evt-sr-7', policyId: 'no-op',
    expectedKind: 'fail', expectedFailureMode: 'never-entered',
    note: 'humidity 78 relaxes toward 45 only after ~417 s; horizon (deadline 120 + ref 24 + hold 60 + 60) truncates before entry',
  },

  // --- 持续恢复（deadline 前进入 + 保持 H 秒 + 终态在包络）必须通过
  {
    scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'reference',
    expectedKind: 'pass',
    note: '3000 W feedback cooling enters ~407 s ≤ 600 s and holds (measured)',
  },
  {
    scenarioId: 'single-room', eventId: 'evt-sr-7', policyId: 'reference',
    expectedKind: 'pass',
    note: '−1.0 %RH/s feedback dehumidification enters ~22 s ≤ 120 s and holds',
  },
  {
    scenarioId: 'single-room', eventId: 'evt-sr-4', policyId: 'reference',
    expectedKind: 'pass',
    note: 'air_flow 0.1 clears smoke into [0,0.3] by ~31 s ≤ 60 s and holds',
  },
  {
    scenarioId: 'apartment', eventId: 'evt-apt-1', policyId: 'reference',
    expectedKind: 'pass',
    note: 'cross-scenario: same temperature family physics at living-room',
  },

  // --- wrong-way：反向执行必须失败并被归因
  {
    scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'wrong-way',
    expectedKind: 'fail', expectedFailureMode: 'wrong-way',
    note: 'heating 3000 W against a hot anomaly drives temperature away (~48 °C)',
  },
  {
    scenarioId: 'single-room', eventId: 'evt-sr-7', policyId: 'wrong-way',
    expectedKind: 'fail', expectedFailureMode: 'wrong-way',
    note: '+1.0 %RH/s humidification against a humid anomaly (~99.8 %RH)',
  },
  // NOTE evt-sr-4 (smoke) has NO wrong-way fixture: air_flow magnitude is
  // sign-insensitive for smoke (measured) — no opposite channel exists. This
  // absence is itself a documented calibration fact, not an omission.

  // --- wrong-zone：邻区执行必须失败并被归因（single-room 只有一个 zone，
  //     结构上不可能 — wrong-zone fixtures 只在多 zone 场景上运行）
  {
    scenarioId: 'apartment', eventId: 'evt-apt-1', policyId: 'wrong-zone',
    expectedKind: 'fail', expectedFailureMode: 'wrong-zone',
    note: 'cooling registered in adjacent zone (bedroom); living-room never recovers and bedroom is driven off baseline',
  },

  // --- 迟到恢复必须失败
  {
    scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'late-recovery',
    expectedKind: 'fail', expectedFailureMode: 'late',
    note: 'actuation starts at the 600 s deadline → entry ~904 s > 600 s',
  },
  {
    scenarioId: 'single-room', eventId: 'evt-sr-7', policyId: 'late-recovery',
    expectedKind: 'fail', expectedFailureMode: 'late',
    note: 'actuation starts at the 120 s deadline → entry ~133 s > 120 s',
  },

  // --- 瞬时恢复必须失败（hold 未满）— 湿度族：穿越包络仅 ~20 s < 60 s
  {
    scenarioId: 'single-room', eventId: 'evt-sr-7', policyId: 'transient-recovery',
    expectedKind: 'fail', expectedFailureMode: 'transient',
    note: 'actuator drives through the envelope [55→35] in ~20 s without stopping → hold window broken',
  },

  // --- 负事件：no-op 必须通过；任何动作 = 未授权动作失败
  {
    scenarioId: 'single-room', eventId: 'evt-sr-3', policyId: 'no-op',
    expectedKind: 'pass',
    note: 'temperature-normal injects 23 (inside [17,25]); no action and envelope maintained',
  },
  {
    scenarioId: 'single-room', eventId: 'evt-sr-3', policyId: 'reference',
    expectedKind: 'pass',
    note: 'feedback policy sees an in-envelope value and correctly never actuates',
  },
  {
    scenarioId: 'single-room', eventId: 'evt-sr-3', policyId: 'wrong-way',
    expectedKind: 'fail', expectedFailureMode: 'unpermitted-action',
    note: 'acting on a negative event is unpermitted regardless of direction',
  },

  // --- 非物理 / 无包络 / 自然恢复主导：诚实 N-A，绝不自动 PASS
  {
    scenarioId: 'single-room', eventId: 'evt-sr-6', policyId: 'no-op',
    expectedKind: 'fail',
    note: 'co2-anomaly: now SCORABLE (was natural-recovery before we added ventilation parameter_rate actuation); no-op fails because CO2 stays above 1000ppm envelope',
  },
  {
    scenarioId: 'single-room', eventId: 'evt-sr-10', policyId: 'no-op',
    expectedKind: 'unscorable',
    note: 'air_quality: no calibrated physics family (custom static key); also the legacy predicate verified a DIFFERENT parameter (aqi) than it injected — invalid predicate instance',
  },

  // --- 诚实物理记录（非六类必需，但锁定语义防止回归漂移）
  {
    scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'transient-recovery',
    expectedKind: 'pass',
    note: 'temperature actuate-through: in-envelope residence ~355 s ≥ hold 60 s, re-enters after far-side exit, final in envelope — HONEST pass (slow family physics), not a transient',
  },
  {
    scenarioId: 'single-room', eventId: 'evt-sr-4', policyId: 'transient-recovery',
    expectedKind: 'fail', expectedFailureMode: 'safety-violation',
    note: 'smoke far side (below 0) is unreachable → ventilator runs the whole horizon and desiccates the room: humidity deviates >12 %RH vs the no-op twin — real actuation side effect, flagged',
  },
];
