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

if ! command -v clamd >/dev/null 2>&1 || ! command -v clamdscan >/dev/null 2>&1; then
  echo "ProofFlow startup failed: clamd and clamdscan are required." >&2
  exit 1
fi

mkdir -p /data/evidence/quarantine /data/evidence/clean
if ! chown -R bun:bun /data; then
  echo "ProofFlow startup failed: could not assign /data to bun:bun." >&2
  exit 1
fi

mkdir -p /run/clamav
chown clamav:clamav /run/clamav
cat > /run/clamav/proofflow-clamd.conf <<'EOF'
Foreground yes
User clamav
LocalSocket /run/clamav/clamd.ctl
LocalSocketGroup bun
LocalSocketMode 0660
FixStaleSocket yes
DatabaseDirectory /var/lib/clamav
MaxThreads 1
MaxQueue 2
StreamMaxLength 11M
ReadTimeout 30
CommandReadTimeout 30
SendBufTimeout 30
EOF

clamd --config-file=/run/clamav/proofflow-clamd.conf &
clamd_pid=$!
api_pid=
shutdown_signal=
shutdown() {
  shutdown_signal=$1
  trap - TERM INT
  if [ -n "$api_pid" ]; then
    kill -"$shutdown_signal" "$api_pid" 2>/dev/null || true
  fi
  kill -TERM "$clamd_pid" 2>/dev/null || true
}
trap 'shutdown TERM' TERM
trap 'shutdown INT' INT

attempt=1
while [ "$attempt" -le 60 ]; do
  if ! kill -0 "$clamd_pid" 2>/dev/null; then
    wait "$clamd_pid" || true
    echo "ProofFlow startup failed: clamd exited before becoming ready." >&2
    exit 1
  fi
  if clamdscan --config-file=/run/clamav/proofflow-clamd.conf --ping=1 --wait=1 >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$attempt" -gt 60 ]; then
  echo "ProofFlow startup failed: clamd did not become ready within 60 seconds." >&2
  kill "$clamd_pid" 2>/dev/null || true
  exit 1
fi

readiness_probe=/run/clamav/proofflow-readiness.txt
printf '%s\n' 'ProofFlow clamd readiness check.' > "$readiness_probe"
if ! clamdscan --config-file=/run/clamav/proofflow-clamd.conf --no-summary "$readiness_probe" >/dev/null; then
  rm -f "$readiness_probe"
  echo "ProofFlow startup failed: clamd readiness scan did not return clean." >&2
  kill "$clamd_pid" 2>/dev/null || true
  exit 1
fi
rm -f "$readiness_probe"

(
  exec setpriv --reuid=bun --regid=bun --init-groups -- "$@"
) &
api_pid=$!

set +e
wait "$api_pid"
api_status=$?
if [ -n "$shutdown_signal" ] && kill -0 "$api_pid" 2>/dev/null; then
  wait "$api_pid"
  api_status=$?
fi
kill -TERM "$clamd_pid" 2>/dev/null || true
wait "$clamd_pid" 2>/dev/null || true
rm -f /run/clamav/clamd.ctl
exit "$api_status"
