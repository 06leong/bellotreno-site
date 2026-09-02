#!/usr/bin/env bash

set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$REPOSITORY_ROOT/rfi-proxy/ops/bellotreno-statistics-daily"
TEST_ROOT="$(mktemp -d)"
REVISION="0123456789abcdef0123456789abcdef01234567"

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'test-statistics-daily: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local path=$1 pattern=$2
  grep -F -- "$pattern" "$path" >/dev/null ||
    fail "expected $path to contain: $pattern"
}

assert_not_contains() {
  local path=$1 pattern=$2
  if grep -F -- "$pattern" "$path" >/dev/null; then
    fail "expected $path not to contain: $pattern"
  fi
}

make_scenario() {
  local name=$1
  SCENARIO_ROOT="$TEST_ROOT/$name"
  COMPOSE_ROOT="$SCENARIO_ROOT/compose"
  STATE_ROOT="$SCENARIO_ROOT/state"
  BIN_ROOT="$SCENARIO_ROOT/bin"
  FAKE_LOG="$SCENARIO_ROOT/docker.log"
  mkdir -p \
    "$COMPOSE_ROOT/statistics-archive" \
    "$COMPOSE_ROOT/statistics-analytics" \
    "$COMPOSE_ROOT/statistics-snapshot-handoff" \
    "$STATE_ROOT" \
    "$BIN_ROOT"
  : >"$COMPOSE_ROOT/docker-compose.yml"
  : >"$COMPOSE_ROOT/.env"
  : >"$FAKE_LOG"

  cat >"$BIN_ROOT/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
joined=" $* "
snapshot_id="20260819T125209Z-f56f1d8c5683"
revision="0123456789abcdef0123456789abcdef01234567"

if [[ "$joined" == *" config --format json "* ]]; then
  printf '{"services":{"bellotreno-statistics-analytics":{"mem_limit":"%s","memswap_limit":"%s","environment":{"ANALYTICS_DUCKDB_MEMORY_LIMIT":"%s","ANALYTICS_DUCKDB_THREADS":"1","ANALYTICS_DUCKDB_MAX_TEMP_DIRECTORY_SIZE":"%s","ANALYTICS_WINDOW_BATCH_DAYS":"%s"}}}}\n' \
    "${FAKE_ANALYTICS_MEMORY_LIMIT:-402653184}" \
    "${FAKE_ANALYTICS_MEMORY_SWAP_LIMIT:-2147483648}" \
    "${FAKE_ANALYTICS_DUCKDB_MEMORY_LIMIT:-128MB}" \
    "${FAKE_ANALYTICS_DUCKDB_MAX_TEMP_DIRECTORY_SIZE:-4GB}" \
    "${FAKE_ANALYTICS_WINDOW_BATCH_DAYS:-7}"
elif [[ "$joined" == *" config --images "* ]]; then
  printf '%s\n' \
    "ghcr.io/06leong/bellotreno-statistics-archive:sha-$revision" \
    "ghcr.io/06leong/bellotreno-rfi-proxy:latest" \
    "ghcr.io/06leong/bellotreno-statistics:sha-$revision" \
    "ghcr.io/06leong/bellotreno-statistics-archive:sha-$revision"
elif [[ "$joined" == *" image inspect "* && "$joined" == *"{{.Id}}"* ]]; then
  printf '%s\n' 'sha256:configured-statistics-image'
elif [[ "$joined" == *" image inspect "* ]]; then
  printf '%s\n' "$revision"
elif [[ "$joined" == *" inspect bellotreno-statistics "* ]]; then
  if [[ "${FAKE_RUNNING_IMAGE_MISMATCH:-0}" == "1" ]]; then
    printf '%s\n' 'sha256:different-running-image'
  else
    printf '%s\n' 'sha256:configured-statistics-image'
  fi
elif [[ "$joined" == *"collectorActive"* ]]; then
  if [[ -n "${FAKE_COLLECTOR_STATE_FILE:-}" && -s "$FAKE_COLLECTOR_STATE_FILE" ]]; then
    IFS='|' read -r collector_active collector_status seconds_to_next next_at \
      <"$FAKE_COLLECTOR_STATE_FILE"
    tail -n +2 "$FAKE_COLLECTOR_STATE_FILE" \
      >"$FAKE_COLLECTOR_STATE_FILE.next"
    mv "$FAKE_COLLECTOR_STATE_FILE.next" "$FAKE_COLLECTOR_STATE_FILE"
  else
    collector_active="${FAKE_COLLECTOR_ACTIVE:-0}"
    collector_status="${FAKE_COLLECTOR_STATUS:-success}"
    seconds_to_next="${FAKE_COLLECTOR_SECONDS_TO_NEXT:-3600}"
    next_at="${FAKE_COLLECTOR_NEXT_AT:-2026-08-24T02:05:00Z}"
  fi
  printf '%s\t%s\t%s\t%s\n' \
    "$collector_active" "$collector_status" "$seconds_to_next" "$next_at"
elif [[ "$joined" == *" bellotreno-statistics python -c "* && "$joined" == *"buildId"* ]]; then
  printf '%s\n' "build-1"
elif [[ "$joined" == *" snapshot_statistics.py list "* ]]; then
  if [[ "${FAKE_EXISTING_SNAPSHOT:-0}" == "1" ]]; then
    printf '{"mode":"list","status":"success","snapshots":[{"snapshotId":"%s"}]}\n' "$snapshot_id"
  else
    printf '%s\n' '{"mode":"list","status":"success","snapshots":[]}'
  fi
elif [[ "$joined" == *" snapshot_statistics.py create "* ]]; then
  printf '{"mode":"prepare","status":"success","snapshotId":"%s"}\n' "$snapshot_id"
elif [[ "$joined" == *" snapshot_statistics.py release "* ]]; then
  printf '{"mode":"release","status":"success","snapshotId":"%s"}\n' "$snapshot_id"
elif [[ "$joined" == *" bellotreno-statistics-archive plan "* ]]; then
  printf '{"mode":"plan","snapshotId":"%s","capacityOk":%s,"pendingPartitions":1,"continuityOk":true,"historicalPartitionGapCount":0}\n' \
    "$snapshot_id" "${FAKE_CAPACITY_OK:-true}"
elif [[ "$joined" == *" bellotreno-statistics-archive run "* ]]; then
  printf '{"mode":"run","status":"success","snapshotId":"%s","publishedPartitions":1,"manifest":"manifests/run.complete.json"}\n' "$snapshot_id"
elif [[ "$joined" == *" bellotreno-statistics-archive verify "* ]]; then
  if [[ "${FAKE_VERIFY_FAIL:-0}" == "1" ]]; then
    exit 1
  fi
  printf '%s\n' '{"mode":"verify","status":"success","manifests":[{"manifest":"manifests/run.complete.json"}],"verifiedManifests":1,"verifiedPartitions":1,"verifiedBytes":42}'
elif [[ "$joined" == *" bellotreno-statistics-analytics cleanup "* ]]; then
  printf '%s\n' '{"mode":"cleanup","status":"success","removedWorkRoots":1}'
elif [[ "$joined" == *" bellotreno-statistics-analytics build "* ]]; then
  if [[ "${FAKE_ANALYTICS_FAIL:-0}" == "1" ]]; then
    exit 137
  fi
  printf '%s\n' '{"mode":"build","status":"success","buildId":"build-1"}'
elif [[ "$joined" == *" rm -f bellotreno-statistics-"*"-daily "* ]]; then
  exit 0
else
  printf 'unexpected fake Docker invocation: %s\n' "$*" >&2
  exit 99
fi
FAKE_DOCKER
  chmod 0755 "$BIN_ROOT/docker"

  cat >"$BIN_ROOT/flock" <<'FAKE_FLOCK'
#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == "-n" && "${2:-}" =~ ^[0-9]+$ ]]
[[ "${FAKE_FLOCK_FAIL:-0}" != "1" ]]
FAKE_FLOCK
  chmod 0755 "$BIN_ROOT/flock"

  cat >"$BIN_ROOT/python3" <<'FAKE_PYTHON3'
#!/usr/bin/env bash
set -euo pipefail

exec python "$@"
FAKE_PYTHON3
  chmod 0755 "$BIN_ROOT/python3"

  cat >"$BIN_ROOT/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
set -euo pipefail

printf 'sleep %s\n' "$*" >>"$FAKE_DOCKER_LOG"
FAKE_SLEEP
  chmod 0755 "$BIN_ROOT/sleep"
}

run_pipeline() {
  env \
    PATH="$BIN_ROOT:$PATH" \
    FAKE_DOCKER_LOG="$FAKE_LOG" \
    FAKE_EXISTING_SNAPSHOT="${FAKE_EXISTING_SNAPSHOT:-0}" \
    FAKE_COLLECTOR_ACTIVE="${FAKE_COLLECTOR_ACTIVE:-0}" \
    FAKE_COLLECTOR_STATUS="${FAKE_COLLECTOR_STATUS:-success}" \
    FAKE_COLLECTOR_SECONDS_TO_NEXT="${FAKE_COLLECTOR_SECONDS_TO_NEXT:-3600}" \
    FAKE_COLLECTOR_NEXT_AT="${FAKE_COLLECTOR_NEXT_AT:-2026-08-24T02:05:00Z}" \
    FAKE_COLLECTOR_STATE_FILE="${FAKE_COLLECTOR_STATE_FILE:-}" \
    FAKE_CAPACITY_OK="${FAKE_CAPACITY_OK:-true}" \
    FAKE_VERIFY_FAIL="${FAKE_VERIFY_FAIL:-0}" \
    FAKE_ANALYTICS_FAIL="${FAKE_ANALYTICS_FAIL:-0}" \
    FAKE_RUNNING_IMAGE_MISMATCH="${FAKE_RUNNING_IMAGE_MISMATCH:-0}" \
    FAKE_FLOCK_FAIL="${FAKE_FLOCK_FAIL:-0}" \
    FAKE_ANALYTICS_MEMORY_LIMIT="${FAKE_ANALYTICS_MEMORY_LIMIT:-402653184}" \
    FAKE_ANALYTICS_MEMORY_SWAP_LIMIT="${FAKE_ANALYTICS_MEMORY_SWAP_LIMIT:-2147483648}" \
    FAKE_ANALYTICS_DUCKDB_MEMORY_LIMIT="${FAKE_ANALYTICS_DUCKDB_MEMORY_LIMIT:-128MB}" \
    FAKE_ANALYTICS_DUCKDB_MAX_TEMP_DIRECTORY_SIZE="${FAKE_ANALYTICS_DUCKDB_MAX_TEMP_DIRECTORY_SIZE:-4GB}" \
    FAKE_ANALYTICS_WINDOW_BATCH_DAYS="${FAKE_ANALYTICS_WINDOW_BATCH_DAYS:-7}" \
    BELLOTRENO_COMPOSE_DIR="$COMPOSE_ROOT" \
    BELLOTRENO_STATE_DIR="$STATE_ROOT" \
    BELLOTRENO_COLLECTOR_WAIT_SECONDS="${BELLOTRENO_COLLECTOR_WAIT_SECONDS:-1800}" \
    BELLOTRENO_ANALYTICS_SAFE_WINDOW_SECONDS="${BELLOTRENO_ANALYTICS_SAFE_WINDOW_SECONDS:-900}" \
    "$RUNNER" run
}

make_scenario success
run_pipeline
assert_contains "$FAKE_LOG" "bellotreno-statistics-analytics cleanup"
assert_contains "$FAKE_LOG" "snapshot_statistics.py create"
assert_contains "$FAKE_LOG" "bellotreno-statistics-archive plan"
assert_contains "$FAKE_LOG" "bellotreno-statistics-archive run"
assert_contains "$FAKE_LOG" "bellotreno-statistics-archive verify"
assert_contains "$FAKE_LOG" "snapshot_statistics.py release"
assert_contains "$FAKE_LOG" "bellotreno-statistics-analytics build"
assert_not_contains "$FAKE_LOG" "collector_runs"
[[ -f "$STATE_ROOT/latest-success/summary.json" ]] ||
  fail "success scenario did not publish a summary"

make_scenario resume
FAKE_EXISTING_SNAPSHOT=1 run_pipeline
assert_contains "$FAKE_LOG" "bellotreno-statistics-analytics cleanup"
assert_not_contains "$FAKE_LOG" "snapshot_statistics.py create"
assert_contains "$FAKE_LOG" "snapshot_statistics.py release"
assert_contains "$FAKE_LOG" "bellotreno-statistics-analytics build"

make_scenario capacity_failure
if FAKE_CAPACITY_OK=false run_pipeline; then
  fail "capacity failure scenario unexpectedly succeeded"
fi
assert_contains "$FAKE_LOG" "snapshot_statistics.py create"
assert_contains "$FAKE_LOG" "bellotreno-statistics-analytics cleanup"
assert_contains "$FAKE_LOG" "bellotreno-statistics-archive plan"
assert_not_contains "$FAKE_LOG" "bellotreno-statistics-archive run"
assert_not_contains "$FAKE_LOG" "snapshot_statistics.py release"
assert_not_contains "$FAKE_LOG" "bellotreno-statistics-analytics build"

make_scenario running_image_mismatch
if FAKE_RUNNING_IMAGE_MISMATCH=1 run_pipeline; then
  fail "running image mismatch scenario unexpectedly succeeded"
fi
assert_not_contains "$FAKE_LOG" "snapshot_statistics.py create"
assert_not_contains "$FAKE_LOG" "bellotreno-statistics-analytics cleanup"
assert_not_contains "$FAKE_LOG" "bellotreno-statistics-archive plan"

make_scenario skipped_but_active
if BELLOTRENO_COLLECTOR_WAIT_SECONDS=0 \
  FAKE_COLLECTOR_ACTIVE=1 \
  FAKE_COLLECTOR_STATUS=skipped \
  run_pipeline; then
  fail "active collector with a skipped latest row unexpectedly succeeded"
fi
assert_not_contains "$FAKE_LOG" "snapshot_statistics.py create"

make_scenario latest_stale_running_status
if FAKE_COLLECTOR_ACTIVE=0 \
  FAKE_COLLECTOR_STATUS=running \
  run_pipeline; then
  fail "latest stale running status with an idle live lock unexpectedly succeeded"
fi
assert_not_contains "$FAKE_LOG" "snapshot_statistics.py create"

make_scenario analytics_safe_window_retry
COLLECTOR_STATES="$SCENARIO_ROOT/collector-states"
printf '%s\n' \
  '0|success|3600|2026-08-24T02:05:00Z' \
  '0|success|120|2026-08-24T01:35:00Z' \
  '1|running|1500|2026-08-24T02:05:00Z' \
  '0|success|1200|2026-08-24T02:05:00Z' \
  >"$COLLECTOR_STATES"
FAKE_COLLECTOR_STATE_FILE="$COLLECTOR_STATES" run_pipeline
assert_contains "$FAKE_LOG" "sleep 60"
assert_contains "$FAKE_LOG" "bellotreno-statistics-analytics build"

make_scenario analytics_safe_window_timeout
COLLECTOR_STATES="$SCENARIO_ROOT/collector-states"
printf '%s\n' \
  '0|success|3600|2026-08-24T02:05:00Z' \
  '0|success|120|2026-08-24T01:35:00Z' \
  >"$COLLECTOR_STATES"
if BELLOTRENO_COLLECTOR_WAIT_SECONDS=0 \
  FAKE_COLLECTOR_STATE_FILE="$COLLECTOR_STATES" \
  run_pipeline; then
  fail "analytics started without its configured collector safety window"
fi
assert_contains "$FAKE_LOG" "snapshot_statistics.py release"
assert_not_contains "$FAKE_LOG" "bellotreno-statistics-analytics build"

make_scenario unsafe_analytics_memory
if FAKE_ANALYTICS_MEMORY_LIMIT=536870912 run_pipeline; then
  fail "unsafe analytics memory scenario unexpectedly succeeded"
fi
assert_not_contains "$FAKE_LOG" "snapshot_statistics.py create"

make_scenario unsafe_analytics_duckdb_memory
if FAKE_ANALYTICS_DUCKDB_MEMORY_LIMIT=256MB run_pipeline; then
  fail "unsafe analytics DuckDB memory scenario unexpectedly succeeded"
fi
assert_not_contains "$FAKE_LOG" "snapshot_statistics.py create"

make_scenario unsafe_analytics_window_batch
if FAKE_ANALYTICS_WINDOW_BATCH_DAYS=14 run_pipeline; then
  fail "unsafe Analytics rolling-window batch scenario unexpectedly succeeded"
fi
assert_not_contains "$FAKE_LOG" "snapshot_statistics.py create"

make_scenario unsafe_analytics_temp_directory
if FAKE_ANALYTICS_DUCKDB_MAX_TEMP_DIRECTORY_SIZE=8GB run_pipeline; then
  fail "unsafe Analytics temporary-directory limit scenario unexpectedly succeeded"
fi
assert_not_contains "$FAKE_LOG" "snapshot_statistics.py create"

make_scenario lock_contention
if FAKE_FLOCK_FAIL=1 run_pipeline; then
  fail "lock contention scenario unexpectedly reported success"
fi
assert_not_contains "$FAKE_LOG" "config --images"

make_scenario verify_failure
if FAKE_VERIFY_FAIL=1 run_pipeline; then
  fail "verify failure scenario unexpectedly succeeded"
fi
assert_contains "$FAKE_LOG" "bellotreno-statistics-archive run"
assert_contains "$FAKE_LOG" "bellotreno-statistics-archive verify"
assert_not_contains "$FAKE_LOG" "snapshot_statistics.py release"
assert_not_contains "$FAKE_LOG" "bellotreno-statistics-analytics build"

make_scenario analytics_failure
if FAKE_ANALYTICS_FAIL=1 run_pipeline; then
  fail "analytics failure scenario unexpectedly succeeded"
fi
assert_contains "$FAKE_LOG" "snapshot_statistics.py release"
assert_contains "$FAKE_LOG" "bellotreno-statistics-analytics build"
[[ ! -e "$STATE_ROOT/latest-success" ]] ||
  fail "analytics failure scenario published a success marker"

printf '%s\n' 'test-statistics-daily: all scenarios passed'
