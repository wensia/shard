#!/usr/bin/env bash
set -euo pipefail
# Explicit opt-in benchmark: all table/Git writes target tempfile vaults owned by the test.
# Usage: scripts/dev/table-performance.sh [absolute-or-relative-output.json]
SHARD_PERF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHARD_PERF_OUTPUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/shard-table-performance-output.XXXXXX")/results.json}"
if [[ "$SHARD_PERF_OUTPUT" != /* ]]; then SHARD_PERF_OUTPUT="$PWD/$SHARD_PERF_OUTPUT"; fi
# Test Git commands must not inherit a caller's alternate repository/index or hooks.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_TEMPLATE_DIR
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export SHARD_TABLE_PERFORMANCE_OUTPUT="$SHARD_PERF_OUTPUT"
cd "$SHARD_PERF_ROOT"
cargo test --release -p shard --lib table::performance::real_vault_read_edit_and_paste -- --ignored --exact --nocapture --test-threads=1
printf 'Raw performance samples: %s\n' "$SHARD_PERF_OUTPUT"
