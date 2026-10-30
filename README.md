# PhysGate

**A physically-grounded evaluation framework for cyber-physical automation systems with intelligent agents.**

PhysGate measures whether embodied agents in CPS actually *achieve physical outcomes* — reach the safe envelope by a deadline and hold it — rather than whether they select correct actions. It pairs Signal-Temporal-Logic-style reach-and-hold verdicts with counterfactual no-op admission gating and restraint scoring on negative events.

## Key numbers (v0.2.1, 2026-10-29)

| Quantity | Value | Cohort |
|---|---|---|
| Scenarios / events | 16 (6 hand-crafted + 10 generated) / 413 | full |
| Admitted (instrument gate) | **206** (185 positive + 21 negative) | full |
| Gate exclusions | 9 unreachable, 25 non-discriminative, 11 negative-inconsistent | full |
| Legacy audit headline | zero-action probe falsely passes **67/143** (46.9%) action-required events | legacy 177 |
| Physical success — no-op / greedy / full-rules | 0.000 / 1.000 / 0.000 | full (CPU arms) |
| Physical success — distributed-LLM / centralized-LLM | 0.000 / 0.000 | frozen 67+19 (pending GPU for full cohort) |
| Decision accuracy (corrective dispatch, right parameter+zone, in time) | 0.108 / 0.299 / 0.358 (full-rules / dist-LLM / cent-LLM) | per-arm cohorts |
| Closed-loop × setpoint-calibration factorial (full-rules) | 0.000 / 0.000 / 0.000 / **0.299** (= decision accuracy exactly) | frozen 2×2 |
| Real-FMU portability (BOPTEST `bestest_hydronic_heat_pump`) | suppressed FAIL / internal controller PASS / hourly greedy FAIL-hold | pre-registered criterion |

Every number above is pinned by a test in `tests/` and traced to an artifact in `results/`; the paper's single source of truth is the numbers contract in the paper workspace.

## Layout

- `src/` — the instrument: envelope/deadline/hold derivation (`envelope.ts`), verdict predicates (`evaluate.ts`), deterministic world (`world.ts`), calibration table (`calibration.ts`), statistics (`stats.ts`), experiment runners (`five-arm-physbench-full.mts`, `closed-loop-cpu-ablation.mts`)
- `src/llm-assessor-prompts.ts`, `src/llm-decision-schema.ts` — the LLM arms' system prompt, sampling policy, and structured-output schema, copied verbatim from the host framework (configuration disclosure)
- `tests/` — instrument tests + pinned-result tests (gate, full-cohort arms, closed-loop ablation, setpoint factorial, real-FMU scoring)
- `results/` — frozen artifacts backing every claim
- `scripts/boptest-fmu-rerun.sh` — real-FMU rerun runner (Docker BOPTEST stack; 3 arms × 3 reps × 120 hourly advances; pre-registered criterion in `results/boptest-fmu/rerun/criterion.json`)
- `build-from-source.mjs` — regenerates this repo from the host framework

## Quick start

```bash
npm install
npx tsx src/physbench-eval.mts --baseline reference   # perfect-information greedy
npx tsx src/physbench-eval.mts --baseline no-op       # counterfactual twin
npm test                                               # instrument + pinned results
```

Regenerating the full-cohort artifacts requires the host framework repository (see `build-from-source.mjs`); the committed artifacts in `results/` are the frozen references.

## Evaluation semantics (summary)

- **Temporal correctness**: enter the safe envelope by deadline `T_d`, hold `T_h` consecutive seconds anchored at first entry (no re-arm), terminal sample inside the envelope (STL diamond-box reach-and-hold + terminal condition).
- **Counterfactual pairing**: every policy run has a no-op twin on the same seed; events whose twin succeeds are excluded (natural-recovery exclusion).
- **Admission gating**: positive events require greedy reachability + no-op discriminability; negative events require that their no-op twin *maintains* the envelope (hardened 2026-10-29 — 11 out-of-envelope "normal" injections were excluded by this check).
- **Restraint**: negative events pass iff the agent performs zero unpermitted actuations.
- **Evaluator–controller separation**: agents see only operational setpoints; envelope/deadline/hold/verdict are evaluator-private (five audited leak channels).

## License

MIT.
