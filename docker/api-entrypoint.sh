#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "ProofFlow production entrypoint must start as root to prepare ClamAV and the Railway volume." >&2
  exit 1
fi

if [ ! -x /usr/bin/clamscan ]; then
  echo "ProofFlow startup failed: /usr/bin/clamscan is unavailable." >&2
  exit 1
fi

mkdir -p /data/evidence/quarantine /data/evidence/clean
chown bun:bun /data
chown -R bun:bun /data/evidence

for database_file in /data/proofflow.sqlite /data/proofflow.sqlite-wal /data/proofflow.sqlite-shm; do
  if [ -e "$database_file" ]; then
    chown bun:bun "$database_file"
  fi
done

if ! freshclam --stdout; then
  echo "ClamAV definition refresh did not complete; validating the installed definitions before startup." >&2
fi

definition_probe="$(mktemp /tmp/proofflow-clamav-readiness.XXXXXX)"
trap 'rm -f "$definition_probe"' EXIT INT TERM
printf '%s\n' 'ProofFlow ClamAV production readiness check.' > "$definition_probe"
if ! /usr/bin/clamscan --no-summary --stdout "$definition_probe"; then
  echo "ProofFlow startup failed: ClamAV definitions are unavailable or unusable." >&2
  exit 1
fi
rm -f "$definition_probe"
trap - EXIT INT TERM

exec gosu bun "$@"
