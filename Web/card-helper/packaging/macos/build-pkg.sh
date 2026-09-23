#!/bin/sh
# Builds the macOS installer: a universal binary, signed with the hardened runtime, in a signed
# and notarized .pkg that registers the helper with every Chromium browser.
#
#   packaging/macos/build-pkg.sh <version> [output dir]
#
# Signing and notarization happen when their credentials are present and are skipped, with a
# warning, when not — so the same script makes a local test build and the release build.
#
#   Signing: identities in a keychain on the search list. Found automatically by team, or named
#     by MACOS_APP_IDENTITY / MACOS_INSTALLER_IDENTITY.
#   Notarization, first match wins:
#     NOTARY_KEYCHAIN_PROFILE   a profile made by `xcrun notarytool store-credentials`
#                               (packaging/setup-signing.sh makes one called a3em-notary)
#     APPLE_API_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER   an App Store Connect team API
#                               key with the Developer role (the .p8 file, its ID, the issuer)
#     APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID   an Apple ID and app-specific password
set -eu
VERSION=${1:?usage: build-pkg.sh <version> [output dir]}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=${2:-$ROOT/dist}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
TEAM=${APPLE_TEAM_ID:-D3TVN67UY9}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "==> Building a3em-card-helper $VERSION (arm64 + x86_64)"
cd "$ROOT"
for ARCH in arm64 amd64; do
  CGO_ENABLED=0 GOOS=darwin GOARCH=$ARCH go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
    -o "$WORK/a3em-card-helper-$ARCH" ./cmd/a3em-card-helper
done
lipo -create -output "$WORK/a3em-card-helper" "$WORK/a3em-card-helper-arm64" "$WORK/a3em-card-helper-amd64"

identity() {
  security find-identity -v -p basic 2>/dev/null | grep "\"$1: .*($TEAM)\"" | head -1 | sed 's/.*"\(.*\)"/\1/'
}
APP_IDENTITY=${MACOS_APP_IDENTITY:-$(identity "Developer ID Application")}
INSTALLER_IDENTITY=${MACOS_INSTALLER_IDENTITY:-$(identity "Developer ID Installer")}

if [ -n "$APP_IDENTITY" ]; then
  echo "==> Signing with $APP_IDENTITY"
  codesign --force --options runtime --timestamp --identifier org.a3em.card-helper \
    --sign "$APP_IDENTITY" "$WORK/a3em-card-helper"
  codesign --verify --strict --verbose=2 "$WORK/a3em-card-helper"
else
  echo "warning: no Developer ID Application identity for team $TEAM; the helper is unsigned" >&2
fi

echo "==> Packaging"
PAYLOAD="$WORK/root/Library/Application Support/A3EM"
mkdir -p "$PAYLOAD"
cp "$WORK/a3em-card-helper" "$PAYLOAD/a3em-card-helper"
chmod 755 "$PAYLOAD/a3em-card-helper"
pkgbuild --root "$WORK/root" --identifier org.a3em.card-helper --version "$VERSION" \
  --scripts "$HERE/scripts" --install-location / "$WORK/component.pkg" >/dev/null
sed "s/@VERSION@/$VERSION/g" "$HERE/distribution.xml" > "$WORK/distribution.xml"
PKG="$OUT/A3EM-Card-Helper-macOS.pkg"
if [ -n "$INSTALLER_IDENTITY" ]; then
  echo "==> Signing the installer with $INSTALLER_IDENTITY"
  productbuild --distribution "$WORK/distribution.xml" --resources "$HERE/resources" --package-path "$WORK" \
    --sign "$INSTALLER_IDENTITY" --timestamp "$PKG" >/dev/null
  pkgutil --check-signature "$PKG" | head -3
else
  echo "warning: no Developer ID Installer identity for team $TEAM; the installer is unsigned" >&2
  productbuild --distribution "$WORK/distribution.xml" --resources "$HERE/resources" --package-path "$WORK" "$PKG" >/dev/null
fi

if [ -n "$INSTALLER_IDENTITY" ]; then
  if [ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]; then
    set -- --keychain-profile "$NOTARY_KEYCHAIN_PROFILE"
  elif [ -n "${APPLE_API_KEY_PATH:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    set -- --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    set -- --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$TEAM"
  else
    set --
  fi
  if [ $# -gt 0 ]; then
    echo "==> Notarizing (this usually takes a few minutes)"
    xcrun notarytool submit "$PKG" "$@" --wait --timeout 30m | tee "$WORK/notary.log"
    if ! grep -q "status: Accepted" "$WORK/notary.log"; then
      ID=$(awk '/^  id:/{print $2; exit}' "$WORK/notary.log")
      [ -n "$ID" ] && xcrun notarytool log "$ID" "$@" || true
      echo "error: notarization was not accepted" >&2
      exit 1
    fi
    xcrun stapler staple "$PKG"
    xcrun stapler validate "$PKG"
  else
    echo "warning: no notarization credentials; the installer is signed but not notarized" >&2
  fi
fi
shasum -a 256 "$PKG"
echo "==> $PKG"
