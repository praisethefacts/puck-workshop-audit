#!/usr/bin/env bash
# Tools used by the local / Codespace audit: node 20+, .NET SDK, ILSpy CLI,
# steamcmd (anonymous Workshop downloads) and the usual PE/archive helpers.
set -euo pipefail

echo "== apt packages"
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends \
  curl ca-certificates tar gzip unzip file binutils python3 xz-utils

echo "== steamcmd (anonymous Workshop downloads)"
if [ ! -x "$HOME/steamcmd/steamcmd.sh" ]; then
  mkdir -p "$HOME/steamcmd"
  curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
    | tar -xz -C "$HOME/steamcmd"
  # first run bootstraps the client; it can time out on a slow box, so ignore the status
  "$HOME/steamcmd/steamcmd.sh" +quit >/dev/null 2>&1 || true
fi
grep -q 'steamcmd' "$HOME/.bashrc" 2>/dev/null || cat >> "$HOME/.bashrc" <<'EOF'

# steamcmd / ILSpy for the Puck audit
export PATH="$HOME/steamcmd:$HOME/.dotnet/tools:$PATH"
export STEAMCMD="$HOME/steamcmd/steamcmd.sh"
EOF

echo "== ILSpy CLI (the engine behind ILSpy, used for decompilation)"
if ! command -v ilspycmd >/dev/null 2>&1; then
  if command -v dotnet >/dev/null 2>&1; then
    dotnet tool install --global ilspycmd
  else
    echo "!! dotnet not found - install the .NET SDK feature in the devcontainer" >&2
  fi
fi

echo "== versions"
node --version 2>/dev/null || true
dotnet --version 2>/dev/null || true
(grep -o 'ilspycmd [0-9.]*' <<< "$(ilspycmd --version 2>&1 || true)" | head -1) || true
[ -x "$HOME/steamcmd/steamcmd.sh" ] && echo "steamcmd: $HOME/steamcmd/steamcmd.sh"

echo "== done. Try:"
echo "   node scripts/audit-box.mjs --id 3776968217"
