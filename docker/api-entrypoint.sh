#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "ProofFlow production entrypoint must start as root to prepare /data." >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "ProofFlow production entrypoint requires an API command." >&2
  exit 1
fi

if ! command -v setpriv >/dev/null 2>&1; then
  echo "ProofFlow startup failed: setpriv is unavailable." >&2
  exit 1
fi

mkdir -p /data/evidence/quarantine /data/evidence/clean
if ! chown -R bun:bun /data; then
  echo "ProofFlow startup failed: could not assign /data to bun:bun." >&2
  exit 1
fi

exec setpriv --reuid=bun --regid=bun --init-groups -- "$@"
