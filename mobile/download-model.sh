#!/usr/bin/env bash
set -e

# Model download script for Trawsgrifiwr Byw Mobile
# Sgript lawrlwytho model ar gyfer Trawsgrifiwr Byw Symudol

MODEL_URL="https://huggingface.co/techiaith/kaldi-cy/resolve/main/model_cy.tar.gz"
TARGET_DIR="assets/model-cy"
TEMP_DIR="/tmp/vosk-cy-dl"

echo "================================================="
echo "Lawrlwytho Model Cymraeg Kaldi / Downloading Welsh Kaldi Model"
echo "URL: $MODEL_URL"
echo "Target: $TARGET_DIR"
echo "================================================="

if [ -f "$TARGET_DIR/final.mdl" ] && [ -f "$TARGET_DIR/HCLG.fst" ]; then
    echo "✓ Model is already installed in $TARGET_DIR!"
    exit 0
fi

mkdir -p "$TEMP_DIR"
echo "1. Downloading model archive (approx 115MB)..."
curl -L --progress-bar "$MODEL_URL" -o "$TEMP_DIR/model_cy.tar.gz"

echo "2. Extracting archive..."
mkdir -p "$TEMP_DIR/extracted"
tar -xzf "$TEMP_DIR/model_cy.tar.gz" -C "$TEMP_DIR/extracted"

echo "3. Installing model into $TARGET_DIR..."
mkdir -p "$TARGET_DIR"
cp -r "$TEMP_DIR/extracted/model/"* "$TARGET_DIR/"

echo "4. Cleaning up temporary files..."
rm -rf "$TEMP_DIR"

echo "================================================="
echo "✓ Welsh Kaldi model successfully installed!"
echo "================================================="
