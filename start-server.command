#!/bin/bash
# Double-click this file in Finder to start Expense Splitter.
# Keep the window that opens. Close it (or press Ctrl+C) to stop the server.

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed yet. Install the LTS version from https://nodejs.org, then double-click this file again."
  read -r -p "Press Enter to close."
  exit 1
fi

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)

echo ""
echo "=========================================="
echo "  Expense Splitter"
echo "=========================================="
if [ -n "$IP" ]; then
  echo "  Open this on your Mac AND on phones (same Wi-Fi):"
  echo "      http://$IP:3000"
else
  echo "  Couldn't find your Wi-Fi address. Is Wi-Fi on?"
  echo "  On this Mac only: http://localhost:3000"
fi
echo ""
echo "  Your Mac will stay awake while this window is open."
echo "  To stop: close this window or press Ctrl+C."
echo "=========================================="
echo ""

caffeinate -i node server.js
