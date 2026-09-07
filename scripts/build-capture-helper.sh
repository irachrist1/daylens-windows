#!/usr/bin/env bash
# Builds platform native helpers into build/.
# macOS: Swift capture-helper + EventKit calendar-helper.app
# Windows: .NET UIA windows-capture-helper.exe
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build"

if [[ "$(uname)" == "Darwin" ]]; then
  SRC="$ROOT/src/native/capture-helper/main.swift"
  OUT="$ROOT/build/capture-helper"
  swiftc -O -o "$OUT" "$SRC"
  echo "[build-capture-helper] built $OUT"

  CAL_SRC="$ROOT/src/native/calendar-helper/main.swift"
  CAL_PLIST="$ROOT/src/native/calendar-helper/Info.plist"
  CAL_APP="$ROOT/build/calendar-helper.app"
  mkdir -p "$CAL_APP/Contents/MacOS"
  cp "$CAL_PLIST" "$CAL_APP/Contents/Info.plist"
  swiftc -O -o "$CAL_APP/Contents/MacOS/calendar-helper" "$CAL_SRC"
  echo "[build-capture-helper] built $CAL_APP"
  exit 0
fi

if [[ "$(uname -s)" == MINGW* ]] || [[ "$(uname -s)" == MSYS* ]] || [[ "${OS:-}" == "Windows_NT" ]]; then
  dotnet publish "$ROOT/src/native/windows-capture-helper/WindowsCaptureHelper.csproj" \
    -c Release \
    -r win-x64 \
    --self-contained true \
    -p:PublishSingleFile=true \
    -o "$ROOT/build"
  echo "[build-capture-helper] built $ROOT/build/windows-capture-helper.exe"
  exit 0
fi

echo "[build-capture-helper] skipping on $(uname); helpers are platform-specific"
exit 0
