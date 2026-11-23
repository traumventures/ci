#!/usr/bin/env bash
# rust-cache on a self-hosted runner: takes a lane (an exclusively locked
# target directory in the runner's persistent cache), links
# <workspace>/<target> to it and keeps the cache bounded. See action.yml.
#
#   env: KEY TARGET INCREMENTAL MAX_GB LANES SCCACHE (from action.yml)
#   cache root: $CI_CACHE_DIR, else ${XDG_CACHE_HOME:-~/.cache}/traumventures-ci
set -euo pipefail

root=${CI_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/traumventures-ci}
safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '_'; }
base="$root/rust/$(safe "$GITHUB_REPOSITORY")/$(safe "$KEY")"
mkdir -p "$base"

# A lane is held by a background flock that lives until the job ends: the
# runner stops a job's leftover processes after its post steps (source-mtimes
# records the manifest in its post step, still under the lock), and our
# runners' container is removed with the job.
acquire() {
  local lane=$1 held
  held="$RUNNER_TEMP/rust-cache-held-$(safe "$KEY")-${lane##*-}"
  mkdir -p "$lane"
  rm -f "$held"
  flock -n "$lane/.lock" sh -c ': > "$1"; exec sleep 86400' sh "$held" </dev/null >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 100); do
    [ -e "$held" ] && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.1
  done
  kill "$pid" 2>/dev/null || true
  return 1
}

lane=""
for attempt in $(seq 120); do                      # up to 20 minutes
  for n in $(seq 1 "${LANES:-2}"); do
    if acquire "$base/lane-$n"; then lane="$base/lane-$n"; break 2; fi
  done
  (( attempt == 1 )) && echo "rust-cache: all ${LANES:-2} lanes of $KEY are in use, waiting"
  sleep 10
done

persistent=true
if [ -z "$lane" ]; then
  echo "::warning::rust-cache: no free lane for $KEY after 20 minutes; this build starts cold"
  lane="$RUNNER_TEMP/rust-cache-cold-$(safe "$KEY")"
  persistent=false
  mkdir -p "$lane"
fi
echo "rust-cache: $lane"
touch "$lane/.last-used"
mkdir -p "$lane/target"

rm -rf "$TARGET"
mkdir -p "$(dirname "$TARGET")"
ln -s "$lane/target" "$TARGET"
# A link is not a directory, so `target/` in .gitignore does not hide it:
# exclude it, or "is the checkout clean?" checks (git status --porcelain) see
# an untracked file.
if top="$(git -C "$(dirname "$TARGET")" rev-parse --show-toplevel 2>/dev/null)"; then
  exclude="$(git -C "$top" rev-parse --absolute-git-dir)/info/exclude"
  mkdir -p "$(dirname "$exclude")"
  echo "/$(realpath -s --relative-to="$top" "$TARGET")" >> "$exclude"
fi
# "true": cargo's profile default (the dev and test profiles build workspace
# members and path dependencies incrementally, registry crates not), left
# unset because sccache refuses to run under CARGO_INCREMENTAL=1.
[ "$INCREMENTAL" = true ] || echo "CARGO_INCREMENTAL=0" >> "$GITHUB_ENV"
{ echo "dir=$lane"; echo "persistent=$persistent"; } >> "$GITHUB_OUTPUT"

# sccache (in the runner image) as a second layer below the lanes: it caches
# the non-incremental crates (registry dependencies, everything when
# incremental is "false"), so a cold lane, a new key or another repository
# with the same dependencies does not compile them again; it passes
# incremental crates through to rustc uncached. Local disk storage
# allows one server per directory, so each runner has its own (one job at a
# time); the server listens on a socket of this job, not on localhost:4226,
# which all our runners would share.
if [ "${CARGO_INCREMENTAL:-}" = 1 ]; then
  echo "rust-cache: CARGO_INCREMENTAL=1 in the job's environment, sccache off (it refuses to run under it)"
elif [ "${SCCACHE:-true}" = true ] && command -v sccache >/dev/null; then
  sccache_dir="$root/sccache/$(safe "${RUNNER_NAME:-runner}")"
  mkdir -p "$sccache_dir"
  {
    echo "RUSTC_WRAPPER=$(command -v sccache)"
    echo "SCCACHE_DIR=$sccache_dir"
    echo "SCCACHE_CACHE_SIZE=${SCCACHE_CACHE_SIZE:-20G}"
    echo "SCCACHE_SERVER_UDS=$RUNNER_TEMP/sccache.sock"
    echo "SCCACHE_IDLE_TIMEOUT=0"
  } >> "$GITHUB_ENV"
  echo "rust-cache: sccache $(sccache --version | cut -d" " -f2) in $sccache_dir"
fi

[ "$persistent" = true ] || exit 0

# Hygiene. Incremental caches untouched for 7 days (a crate rebuilt since
# writes a fresh one; one with a new hash leaves the old behind).
stale=$(find "$lane/target" -mindepth 3 -maxdepth 3 -path '*/incremental/*' -type d -mtime +7 2>/dev/null | wc -l)
if (( stale > 0 )); then
  find "$lane/target" -mindepth 3 -maxdepth 3 -path '*/incremental/*' -type d -mtime +7 -exec rm -rf {} +
  echo "rust-cache: removed $stale incremental caches untouched for 7 days"
fi
# The whole target directory once it holds more than max-gb, or the disk is
# 85 % full.
used_gb=$(du -sx -BG "$lane/target" 2>/dev/null | cut -f1 | tr -dc '0-9')
disk=$(df --output=pcent "$lane" | tail -1 | tr -dc '0-9')
echo "rust-cache: ${used_gb:-0} GB in this lane (cap ${MAX_GB} GB), disk ${disk}% full"
if (( ${used_gb:-0} > MAX_GB || disk > 85 )); then
  echo "::warning::rust-cache: lane holds ${used_gb} GB (cap ${MAX_GB} GB, disk ${disk}%); target dropped, this build starts cold"
  rm -rf "${lane:?}/target" "$lane/source-mtimes"
  mkdir -p "$lane/target"
fi
# Lanes of any repository unused for 14 days (locked lanes are in use, skipped).
find "$root/rust" -mindepth 3 -maxdepth 3 -type d -name 'lane-*' 2>/dev/null | while read -r other; do
  [ "$other" = "$lane" ] || [ ! -d "$other/target" ] && continue
  [ -n "$(find "$other" -maxdepth 1 -name .last-used -mtime -14 2>/dev/null)" ] && continue
  if flock -n "$other/.lock" rm -rf -- "$other/target" "$other/source-mtimes" 2>/dev/null; then
    echo "rust-cache: dropped $other (unused for 14 days)"
  fi
done
exit 0
