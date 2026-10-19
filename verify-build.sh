#!/bin/bash

set -e

echo "========================================="
echo "Pi Workbench Build Verification"
echo "========================================="
echo ""

# Check Node.js
echo "✓ Checking Node.js..."
node --version
npm --version
echo ""

# Check dependencies
echo "✓ Checking dependencies..."
npm list 2>&1 | head -20
echo ""

# Type checking
echo "✓ Running TypeScript type check..."
npx tsc --noEmit
echo "  ✓ TypeScript OK"
echo ""

# Build Pi Bridge
echo "✓ Building Pi Bridge..."
npm run build:bridge
echo "  ✓ Pi Bridge OK"
echo ""

# Build frontend
echo "✓ Building frontend..."
npm run build 2>&1 | tail -5
echo "  ✓ Frontend OK"
echo ""

# Check output
echo "✓ Verifying build output..."
if [ -f "dist/index.html" ]; then
  echo "  ✓ dist/index.html exists"
else
  echo "  ✗ dist/index.html missing!"
  exit 1
fi

if [ -f "dist/assets/index.css" ] || [ -f "dist/assets/"*.css ]; then
  echo "  ✓ CSS bundled"
else
  echo "  ✗ CSS not found!"
  exit 1
fi

if [ -f "dist/assets/index.js" ] || [ -f "dist/assets/"*.js ]; then
  echo "  ✓ JavaScript bundled"
else
  echo "  ✗ JavaScript not found!"
  exit 1
fi

echo ""
echo "========================================="
echo "✓ All checks passed!"
echo "========================================="
echo ""
echo "To start development:"
echo "  npm run web:dev      # Frontend dev server on port 5173"
echo "  npm run dev          # Full app with Tauri (requires Rust)"
echo ""
