#!/bin/sh
# Builds the Linux packages: a .deb per architecture, and a tarball with an install script
# for other distributions.
#
#   packaging/linux/build-deb.sh <version> [output dir]
#
# The .deb registers the helper system-wide for Chrome, Chromium and Edge, and installs a
# polkit policy so that pkexec's prompt names the A3EM card helper rather than a bare path.
# (Chromium installed as a snap cannot start native helpers at all; that is the snap's rule.)
set -eu
VERSION=${1:?usage: build-deb.sh <version> [output dir]}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=${2:-$ROOT/dist}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
LIB=/usr/lib/a3em-card-helper
BIN=$LIB/a3em-card-helper

for ARCH in amd64 arm64; do
  echo "==> $ARCH"
  PKG="$WORK/deb-$ARCH"
  mkdir -p "$PKG/DEBIAN" "$PKG$LIB" "$PKG/usr/bin" "$PKG/usr/share/polkit-1/actions" "$PKG/usr/share/doc/a3em-card-helper"
  (cd "$ROOT" && CGO_ENABLED=0 GOOS=linux GOARCH=$ARCH go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$PKG$BIN" ./cmd/a3em-card-helper)
  ln -s "$BIN" "$PKG/usr/bin/a3em-card-helper"
  for DIR in /etc/opt/chrome/native-messaging-hosts /etc/chromium/native-messaging-hosts /etc/opt/edge/native-messaging-hosts; do
    mkdir -p "$PKG$DIR"
    sed "s|@PATH@|$BIN|" "$HERE/org.a3em.card_helper.json" > "$PKG$DIR/org.a3em.card_helper.json"
  done
  sed "s|@PATH@|$BIN|" "$HERE/org.a3em.card-helper.policy" > "$PKG/usr/share/polkit-1/actions/org.a3em.card-helper.policy"
  cp "$HERE/copyright" "$PKG/usr/share/doc/a3em-card-helper/copyright"
  SIZE=$(du -sk "$PKG" | cut -f1)
  sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" -e "s/@SIZE@/$SIZE/" "$HERE/control" > "$PKG/DEBIAN/control"
  printf '%s\n' /etc/opt/chrome/native-messaging-hosts/org.a3em.card_helper.json \
    /etc/chromium/native-messaging-hosts/org.a3em.card_helper.json \
    /etc/opt/edge/native-messaging-hosts/org.a3em.card_helper.json > "$PKG/DEBIAN/conffiles"
  dpkg-deb --root-owner-group --build "$PKG" "$OUT/a3em-card-helper_${ARCH}.deb" >/dev/null

  TAR="$WORK/a3em-card-helper"
  rm -rf "$TAR" && mkdir -p "$TAR"
  cp "$PKG$BIN" "$TAR/a3em-card-helper"
  cp "$HERE/org.a3em.card-helper.policy" "$HERE/install.sh" "$TAR/"
  tar -C "$WORK" -czf "$OUT/a3em-card-helper_linux_${ARCH}.tar.gz" a3em-card-helper
done
(cd "$OUT" && sha256sum a3em-card-helper_*.deb a3em-card-helper_linux_*.tar.gz)
