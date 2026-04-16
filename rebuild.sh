#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Building UI..."
npm run build:ui

echo "Compiling backend..."
npx tsc --project tsconfig.build.json

echo "Build complete."
