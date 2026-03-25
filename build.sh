#!/bin/bash

# Build script for Chrome Store submission
# Creates a zip file of the extension

set -e

EXTENSION_NAME="Playwright Trace Recorder"
VERSION=$(grep -o '"version": *"[^"]*"' manifest.json | cut -d'"' -f4)
BUILD_DIR="build"
ZIP_FILE="${BUILD_DIR}/PlaywrightTraceRecorder_${VERSION}.zip"

echo "Building extension: ${EXTENSION_NAME} v${VERSION}"
echo "Creating zip file: ${ZIP_FILE}"

# Clean up previous build
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# Copy all extension files to build directory
cp manifest.json "${BUILD_DIR}/"
cp -r icons "${BUILD_DIR}/"
cp -r src "${BUILD_DIR}/"

# Create zip file (excluding .DS_Store and other hidden files)
cd "${BUILD_DIR}"
zip -r "../${ZIP_FILE}" . -x "*.DS_Store" -x "__MACOSX/*"

echo "Build complete: ${ZIP_FILE}"
echo "Upload this file to Chrome Web Store Developer Dashboard"
