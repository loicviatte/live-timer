#!/bin/zsh
# Double-click to start the live stream timer. Works from wherever this folder is.
cd "$(dirname "$0")/app" || exit 1
printf '\e]0;Live timer\a'   # Terminal window title
clear

# Find Node.js (Homebrew, official installer, or anything already on the PATH).
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "\n  ⚠️  Node.js is not installed on this Mac."
  echo "  Install the LTS version from https://nodejs.org (opening it now),"
  echo "  then double-click \"Start Timer\" again.\n"
  open "https://nodejs.org/en/download"
  echo "Press any key to close."; read -k1; exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if (( NODE_MAJOR < 18 )); then
  echo "\n  ⚠️  Node.js $(node -v) is too old: version 18 or newer is required."
  echo "  Install the LTS version from https://nodejs.org, then double-click this file again.\n"
  open "https://nodejs.org/en/download"
  echo "Press any key to close."; read -k1; exit 1
fi

# caffeinate: the Mac (and its screen, e.g. the TV plugged into it) never sleeps while the timer runs.
# The loop restarts the server after an update installed from the admin (exit code 75).
export TIMER_SUPERVISED=1
while true; do
  caffeinate -dims node server.js
  [[ $? -eq 75 ]] || break
  echo "\n  ↻ Restarting with the new version…\n"
done
echo "\nPress any key to close."
read -k1
