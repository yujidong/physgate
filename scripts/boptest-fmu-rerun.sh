#!/usr/bin/env bash
# BOPTEST REAL FMU rerun — 2026-10-29, response to TASE review W6.
#
# PRE-REGISTERED CRITERION (fixed BEFORE running; do not tune to results):
#   Envelope : [21.0, 24.0] degC  (published BOPTEST comfort band for
#              bestest_hydronic_heat_pump — same constants as the 1R1C surrogate)
#   Deadline : 100 h   (= 600 s framework temperature deadline x 596 calibration
#              factor = 99.33 h, rounded to the hourly advance grid)
#   Hold     : 10 h    (= 60 s framework hold x 596 = 9.93 h, rounded)
#   Horizon  : 120 hourly advances (deadline + hold + 10 h margin)
#   Verdict  : enter-by-deadline + consecutive hold >= 10 steps (re-arming),
#              identical predicate family to evaluate.ts
#
# ARMS (3 reps each, fresh select per rep — reps must be identical: determinism):
#   no-op-suppressed : oveHeaPumY_u=0 every step (plant suppressed; true twin)
#   no-op-baseline   : no overrides (FMU's internal legacy controller runs)
#   greedy           : hourly feedback — T < 21.0 -> heat ON (TSet 294.15 K);
#                      in-band -> override 0 (OFF). Step 1 is observation-only.
#
# Artifacts -> experiment-results/outcome-gm/boptest-fmu/rerun/
set -euo pipefail

BASE="http://127.0.0.1:8000"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTDIR="$(cd "$SCRIPT_DIR/../../../experiment-results/outcome-gm/boptest-fmu" && pwd)/rerun"
mkdir -p "$OUTDIR"

PY=python; command -v python >/dev/null 2>&1 || PY=python3

cat > "$OUTDIR/criterion.json" <<'EOF'
{
  "preregisteredAt": "2026-10-29 (before rerun)",
  "revision": "v2 (2026-10-29, same day): added terminal-sample condition to match evaluate.ts Definition 3 (temporal correctness) exactly. Motivation: the greedy arm's first execution leaked a persistent BOPTEST override (heat never released; terminal state 32.1 C outside the band) which enter+hold alone scored as PASS — the terminal condition is what catches it. Enter/hold thresholds unchanged from v1.",
  "envelopeC": [21.0, 24.0],
  "deadlineSteps": 100,
  "holdSteps": 10,
  "horizonSteps": 120,
  "derivation": "deadline 100h = 600s x 596 calibration factor (99.33h rounded); hold 10h = 60s x 596 (9.93h rounded); envelope = published BOPTEST comfort band for bestest_hydronic_heat_pump",
  "verdict": "enter-by-deadline AND consecutive in-envelope hold >= 10 steps from first entry (no re-arm) AND terminal sample in envelope — same predicate family as evaluate.ts"
}
EOF

select_test() {
  local resp tid attempt
  for attempt in 1 2 3 4 5; do
    # select-async returns immediately with the testid; the run_test job is
    # queued and the (single) worker picks it up when free. The synchronous
    # variant hangs on this deployment (web response path), so never use it.
    resp=$(curl -s -m 30 -X POST "$BASE/testcases/bestest_hydronic_heat_pump/select-async" \
      -H 'Content-Type: application/json' -d '{}')
    tid=$(echo "$resp" | "$PY" -c "import json,sys; d=json.load(sys.stdin); print(d.get('testid','') or d.get('payload',{}).get('testid',''))" 2>/dev/null)
    if [[ -n "$tid" ]]; then echo "$tid"; return 0; fi
    echo "  select attempt $attempt failed: $(echo "$resp" | head -c 120) — waiting 20s" >&2
    sleep 20
  done
  return 1
}

stop_test() {
  local tid="$1"
  curl -s -m 60 -X PUT "$BASE/stop/$tid" >/dev/null 2>&1 || true
  sleep 5
}

advance() {
  local tid="$1" body="$2" resp attempt
  # The worker may still be subscribing to the per-test channel right after
  # select-async; a request published in that window is lost and the web hangs.
  # Retry on timeout covers the race.
  for attempt in 1 2 3; do
    resp=$(curl -s -m 90 -X POST "$BASE/advance/$tid" -H 'Content-Type: application/json' -d "$body" || true)
    if [[ -n "$resp" && "$resp" != *"<html"* ]]; then echo "$resp"; return 0; fi
    echo "  advance attempt $attempt empty/timed out — retrying in 10s" >&2
    sleep 10
  done
  echo ""
}

run_arm() {
  local policy="$1" rep="$2" tid temp samples body started
  tid=$(select_test)
  if [[ -z "$tid" ]]; then echo "ERROR: select failed for $policy rep$rep" >&2; return 1; fi
  # let the worker pick up the run_test job and finish initialization before
  # the first advance (see advance() note on the subscribe race)
  sleep 15
  started=$("$PY" -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat())")
  echo "[$policy rep$rep] testid=$tid" >&2

  samples="["; local heat_on=false ever_on=false
  for ((step=1; step<=120; step++)); do
    body='{}'
    if [[ "$policy" == "no-op-suppressed" ]]; then
      body='{"oveHeaPumY_u":0,"oveHeaPumY_activate":true}'
    elif [[ "$policy" == "greedy" ]]; then
      if [[ "$heat_on" == "true" ]]; then
        # heat ON: full modulation toward 21 C setpoint
        body='{"oveHeaPumY_u":1,"oveHeaPumY_activate":true,"oveTSet_u":294.15,"oveTSet_activate":true}'
      elif [[ "$ever_on" == "true" ]]; then
        # heat OFF: BOPTEST overrides PERSIST until deactivated — release both
        # points explicitly (first execution leaked a stuck full-power override)
        body='{"oveHeaPumY_u":0,"oveHeaPumY_activate":true,"oveTSet_activate":false}'
      fi
    fi

    local resp temp
    resp=$(advance "$tid" "$body")
    temp=$(echo "$resp" | "$PY" -c "
import json,sys
try:
  d=json.load(sys.stdin)['payload']
  print(f\"{d['reaTZon_y']-273.15:.3f}\")
except: print('')" 2>/dev/null)
    if [[ -z "$temp" ]]; then echo "  step $step: bad response" >&2; samples="${samples%,}"; break; fi

    samples+="{\"t\":$step,\"T\":$temp},"
    if (( step % 10 == 0 )); then echo "  ${policy} rep${rep} ${step}h: ${temp}C" >&2; fi

    if [[ "$policy" == "greedy" ]]; then
      if [[ "$heat_on" == "false" ]] && "$PY" -c "exit(0 if $temp < 21.0 else 1)" 2>/dev/null; then
        heat_on=true; ever_on=true
      elif [[ "$heat_on" == "true" ]] && "$PY" -c "exit(0 if $temp >= 21.0 else 1)" 2>/dev/null; then
        heat_on=false
      fi
    fi
  done
  samples="${samples%,}]"

  cat > "$OUTDIR/${policy}-rep${rep}.json" <<EOF
{"policy":"$policy","rep":$rep,"testid":"$tid","startedAtUtc":"$started","samples":$samples}
EOF
  stop_test "$tid"
  echo "[$policy rep$rep] saved ($OUTDIR/${policy}-rep${rep}.json)" >&2
}

echo "=== BOPTEST REAL FMU rerun (pre-registered criterion in criterion.json) ===" >&2
ARMS_TO_RUN="${BOP_ARMS:-no-op-suppressed no-op-baseline greedy}"
for rep in 1 2 3; do
  for policy in $ARMS_TO_RUN; do
    run_arm "$policy" "$rep"
  done
done

"$PY" - "$OUTDIR" <<'EOF'
import json, sys, glob, os, hashlib
out = sys.argv[1]
runs = []
for f in sorted(glob.glob(os.path.join(out, "*-rep*.json"))):
    with open(f) as fh: runs.append(json.load(fh))
crit = json.load(open(os.path.join(out, "criterion.json")))
lo, hi = crit["envelopeC"]
merged = {"source": "REAL BOPTEST bestest_hydronic_heat_pump FMU (linux64) via Docker REST API — rerun 2026-10-29",
          "criterion": crit, "results": []}
for r in runs:
    s = r["samples"]
    entry = {"policy": r["policy"], "rep": r["rep"], "testid": r["testid"],
             "startedAtUtc": r["startedAtUtc"], "samples": s}
    entry["enterStep"] = next((x["t"] for x in s if lo <= x["T"] <= hi), None)
    if entry["enterStep"] is not None and entry["enterStep"] <= crit["deadlineSteps"]:
        run = best = 0
        for x in s:
            run = run + 1 if lo <= x["T"] <= hi else 0
            best = max(best, run)
        entry["maxConsecutiveHoldSteps"] = best
        entry["pass"] = best >= crit["holdSteps"]
    else:
        entry["maxConsecutiveHoldSteps"] = 0
        entry["pass"] = False
    merged["results"].append(entry)
merged_sha = hashlib.sha256(json.dumps(merged, sort_keys=True).encode()).hexdigest()
merged["rerunSha256"] = merged_sha
with open(os.path.join(out, "fmu-rerun.json"), "w") as fh:
    json.dump(merged, fh, indent=1)
print("merged ->", os.path.join(out, "fmu-rerun.json"))
for e in merged["results"]:
    print(f"  {e['policy']} rep{e['rep']}: enter={e['enterStep']} hold={e['maxConsecutiveHoldSteps']} pass={e['pass']}")
EOF

docker logs project1-boptest-worker-1 > "$OUTDIR/worker-log.txt" 2>&1 || echo "(docker logs unavailable)" >&2
echo "=== done ===" >&2
