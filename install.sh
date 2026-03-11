#!/usr/bin/env bash
# Build agents-cli and install to ~/.local/bin
set -euo pipefail

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"

echo "Building agents-cli..."
bun build src/cli.ts --compile --outfile "${INSTALL_DIR}/agents-cli"

echo "Installed to ${INSTALL_DIR}/agents-cli"

# Check if ~/.local/bin is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -q "${INSTALL_DIR}"; then
    echo ""
    echo "WARNING: ${INSTALL_DIR} is not in your PATH."
    echo "Add this to your shell profile:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi
