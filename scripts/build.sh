#!/usr/bin/env bash
# Usage: build.sh <stage> [<stage> ...] | all | shell
# Stages live in scripts/stages/NN-name.sh and are matched by name or number prefix.
source /work/scripts/env.sh
set -o pipefail
# The build volume belongs to one SlicerWeb checkout (build.py passes which): its trees are built from
# the sources that checkout pins, so another checkout would rebuild over them
if [ -n "${SW_CHECKOUT:-}" ]; then
  owner_file=$SW_BUILD/.slicerweb-checkout
  if [ -f "$owner_file" ] && [ "$(cat "$owner_file")" != "$SW_CHECKOUT" ]; then
    echo "The build volume ${SW_BUILD_VOLUME:-} has the build of another SlicerWeb checkout, $(cat "$owner_file"):"
    echo "give $SW_CHECKOUT a volume of its own (SW_BUILD_VOLUME in .env)"
    exit 2
  fi
  printf '%s' "$SW_CHECKOUT" > "$owner_file"
fi
stages_dir=/work/scripts/stages
run_stage() {
  local match; match=$(ls "$stages_dir" | grep -E "^($1|[0-9]+-$1)(\.sh)?$|^$1-" | head -1 || true)
  [ -n "$match" ] || { echo "unknown stage: $1"; ls "$stages_dir"; exit 2; }
  log "stage $match"
  local t0=$SECONDS logdir=$SW_DIST_ROOT/logs
  mkdir -p "$logdir"
  bash -euo pipefail "$stages_dir/$match" 2>&1 | tee "$logdir/${match%.sh}.log"
  log "stage $match done in $((SECONDS - t0)) s"
}
[ $# -gt 0 ] || set -- all
for s in "$@"; do
  case "$s" in
    all) for f in $(ls "$stages_dir" | sort); do run_stage "${f%.sh}"; done ;;
    shell) exec bash ;;
    *) run_stage "$s" ;;
  esac
done
