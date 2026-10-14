#!/usr/bin/env bash
# Keeps a Rust sticky disk bounded (billed per GB): drops incremental caches
# untouched for 7 days (a crate rebuilt since writes a fresh one; one with a new
# hash leaves the old behind), and the whole target directory once the disk
# holds more than <max-gb> or is 80 % full.
#
#   rust-sticky-hygiene.sh <disk> [max-gb]     the disk holds target/, registry/, git/
set -euo pipefail
disk=$1
max_gb=${2:-40}
stale=$(find "$disk/target" -mindepth 3 -maxdepth 3 -path '*/incremental/*' -type d -mtime +7 2>/dev/null | wc -l)
if (( stale > 0 )); then
  find "$disk/target" -mindepth 3 -maxdepth 3 -path '*/incremental/*' -type d -mtime +7 -exec rm -rf {} +
  echo "sticky disk: removed $stale incremental caches untouched for 7 days"
fi
used=$(df --output=pcent "$disk" | tail -1 | tr -dc '0-9')
used_gb=$(( $(df --output=used -B1G "$disk" | tail -1 | tr -dc '0-9') ))
echo "sticky disk: ${used_gb} GB used (${used}%, cap ${max_gb} GB)"
if (( used > 80 || used_gb > max_gb )); then
  echo "::warning::sticky disk holds ${used_gb} GB (cap ${max_gb} GB); target dropped, this build starts cold"
  rm -rf "${disk:?}/target"
  mkdir -p "$disk/target"
fi
