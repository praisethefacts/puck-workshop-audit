#!/usr/bin/env bash
# Container entrypoint. Two modes:
#   MODE=full  (default) full PC-style audit -> audit-out/<id>_<name>/ (REPORT.md,
#              evidence/, sources/) - mount ./audit-out to keep it.
#   MODE=site  publishable automated triage -> reports/ + data/ (mount those too).
#
#   docker run --rm -e ID=3765045334 -v "$PWD/audit-out:/work/audit-out" puck-audit
#   docker run --rm -e ID=3765045334 -e MODE=site \
#     -v "$PWD/reports:/work/reports" -v "$PWD/data:/work/data" puck-audit
set -euo pipefail
cd /work

MODE="${MODE:-full}"
ID="${ID:-${1:-}}"
OUT="${OUT:-audit-out}"

if [ -z "$ID" ]; then
  echo "usage: docker run --rm -e ID=<workshop id> puck-audit            # full audit" >&2
  echo "       docker run --rm -e ID=<id> -e MODE=site puck-audit       # site triage" >&2
  exit 2
fi

# accept a link or a bare id, exactly like audit.bat does
ID="$(node -e 'const s=process.argv[1]||""; const m=s.match(/id=(\d{4,})/)||s.match(/(\d{6,})/); process.stdout.write(m?m[1]:s)' "$ID")"

echo "== Puck audit  id=$ID  mode=$MODE"
echo "== node $(node --version), $(ilspycmd --version 2>&1 | head -1)"

case "$MODE" in
  full)
    mkdir -p "$OUT"
    exec node scripts/audit-box.mjs --id "$ID" --out "$OUT"
    ;;
  site)
    mkdir -p reports data
    exec node scripts/audit-mod.mjs --id "$ID" --no-deploy
    ;;
  *)
    echo "MODE must be 'full' or 'site' (got '$MODE')" >&2
    exit 2
    ;;
esac
