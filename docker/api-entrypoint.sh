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

if ! command -v freshclam >/dev/null 2>&1; then
  echo "ProofFlow startup failed: freshclam is unavailable." >&2
  exit 1
fi

echo "[ProofFlow] Preparing ClamAV..."
mkdir -p /var/lib/clamav
chown -R clamav:clamav /var/lib/clamav
chmod 0755 /var/lib/clamav

freshclam_config=/etc/clamav/freshclam.conf
if [ ! -f "$freshclam_config" ]; then
  echo "ProofFlow startup failed: freshclam configuration is unavailable at $freshclam_config." >&2
  exit 1
fi

if grep -Eq '^[[:space:]]*Example([[:space:]]|$)' "$freshclam_config"; then
  echo "ProofFlow startup failed: freshclam configuration is still marked as an example." >&2
  exit 1
fi

if grep -Eq '^[[:space:]]*DatabaseDirectory[[:space:]]+' "$freshclam_config"; then
  configured_database_directory="$(awk '$1 == "DatabaseDirectory" { print $2; exit }' "$freshclam_config")"
  if [ "$configured_database_directory" != "/var/lib/clamav" ]; then
    echo "ProofFlow startup failed: freshclam DatabaseDirectory must be /var/lib/clamav, found $configured_database_directory." >&2
    exit 1
  fi
else
  printf '\nDatabaseDirectory /var/lib/clamav\n' >> "$freshclam_config"
fi

mkdir -p /data/evidence/quarantine /data/evidence/clean
chown bun:bun /data
chown -R bun:bun /data/evidence

for database_file in /data/proofflow.sqlite /data/proofflow.sqlite-wal /data/proofflow.sqlite-shm; do
  if [ -e "$database_file" ]; then
    chown bun:bun "$database_file"
  fi
done

echo "[ProofFlow] Updating ClamAV definitions..."
freshclam_status=1
attempt=1
while [ "$attempt" -le 3 ]; do
  echo "[ProofFlow] freshclam attempt $attempt of 3..."
  set +e
  freshclam --config-file="$freshclam_config" --stdout
  freshclam_status=$?
  set -e
  echo "[ProofFlow] freshclam attempt $attempt exited with status $freshclam_status."
  if [ "$freshclam_status" -eq 0 ]; then
    break
  fi
  if [ "$attempt" -lt 3 ]; then
    sleep_seconds=$((attempt * 5))
    echo "[ProofFlow] Retrying ClamAV definition update in ${sleep_seconds}s..." >&2
    sleep "$sleep_seconds"
  fi
  attempt=$((attempt + 1))
done

if [ "$freshclam_status" -ne 0 ]; then
  echo "ProofFlow startup failed: freshclam could not update ClamAV definitions after 3 attempts (exit $freshclam_status)." >&2
  exit 1
fi

if ! find /var/lib/clamav -maxdepth 1 -type f \( -name '*.cvd' -o -name '*.cld' -o -name '*.cud' \) -print -quit | grep -q .; then
  echo "ProofFlow startup failed: freshclam completed but no supported ClamAV database files were found in /var/lib/clamav." >&2
  exit 1
fi

echo "[ProofFlow] ClamAV definitions ready."

definition_probe="$(mktemp /tmp/proofflow-clamav-readiness.XXXXXX)"
trap 'rm -f "$definition_probe"' EXIT INT TERM
printf '%s\n' 'ProofFlow ClamAV production readiness check.' > "$definition_probe"
echo "[ProofFlow] Running ClamAV readiness scan..."
if ! /usr/bin/clamscan --no-summary --stdout "$definition_probe"; then
  echo "ProofFlow startup failed: ClamAV definitions are unavailable or unusable." >&2
  exit 1
fi
echo "[ProofFlow] ClamAV readiness scan passed."
rm -f "$definition_probe"
trap - EXIT INT TERM

echo "[ProofFlow] Starting API..."
exec gosu bun "$@"
