#!/bin/sh
# Installs (or with --uninstall removes) the Hardware Intelligence Platform's optional privileged
# helpers. Run it yourself:   sudo sh resources/linux/install.sh   [--uninstall]
# The application never runs this script and works without it (monitoring and read-only features).
set -eu
DEST=/usr/local/libexec/hardware-intelligence
POLICY=/usr/share/polkit-1/actions/dev.hardware-intelligence.policy
SRC=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo sh $0 ${1:-}" >&2; exit 1; }
if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$DEST/hip-perf-helper" "$DEST/hip-hid-probe" "$POLICY"
  rmdir "$DEST" 2>/dev/null || true
  echo "Removed the helpers and their polkit policy. Settings already changed stay until reboot."
  exit 0
fi
install -d -o root -g root -m 0755 "$DEST"
install -o root -g root -m 0755 "$SRC/hip-perf-helper" "$DEST/hip-perf-helper"
install -o root -g root -m 0755 "$SRC/hip-hid-probe" "$DEST/hip-hid-probe"
install -o root -g root -m 0644 "$SRC/dev.hardware-intelligence.policy" "$POLICY"
echo "Installed to $DEST and $POLICY."
echo "Remove with: sudo sh $0 --uninstall"
