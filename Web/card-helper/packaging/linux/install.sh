#!/bin/sh
# Installs the helper from this tarball, for distributions without dpkg.
#   sudo ./install.sh          system-wide: Chrome, Chromium and Edge, for every user
#   ./install.sh --user        just you, in ~/.local: also Brave and Vivaldi, no root
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = "--user" ]; then
  DEST="$HOME/.local/lib/a3em-card-helper"
  mkdir -p "$DEST"
  install -m 755 "$HERE/a3em-card-helper" "$DEST/a3em-card-helper"
  "$DEST/a3em-card-helper" install
  echo "Installed for $(id -un). Writing to cards will ask for your password through pkexec."
  exit 0
fi
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo, or with --user to install just for yourself." >&2; exit 1; }
BIN=/usr/lib/a3em-card-helper/a3em-card-helper
install -D -m 755 "$HERE/a3em-card-helper" "$BIN"
ln -sf "$BIN" /usr/bin/a3em-card-helper
sed "s|@PATH@|$BIN|" "$HERE/org.a3em.card-helper.policy" > /usr/share/polkit-1/actions/org.a3em.card-helper.policy
"$BIN" install --system
echo "Installed. Check it with: a3em-card-helper doctor"
