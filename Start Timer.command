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
crashes=0; window_start=$SECONDS
while true; do
  caffeinate -dims node server.js
  code=$?
  if [[ $code -eq 75 ]]; then
    echo "\n  ↻ Restarting with the new version…\n"
  elif [[ -f .update-pending && -d .backup ]]; then
    # The server died right after an update: put the previous version back and restart it.
    echo "\n  ⚠️  The new version stopped unexpectedly — going back to the previous version…\n"
    ditto .backup . && rm -rf .backup .update-pending
  elif [[ $code -ne 0 ]]; then
    # Unexpected stop: restart right away (the countdown resumes where it was).
    (( SECONDS - window_start > 60 )) && { crashes=0; window_start=$SECONDS; }
    (( crashes++ ))
    if (( crashes > 5 )); then
      echo "\n  ⚠️  The timer keeps stopping (5 times in a minute). Check the messages above.\n"
      break
    fi
    echo "\n  ↻ The timer stopped unexpectedly — restarting it…\n"
    sleep 1
  else
    break
  fi
done
echo "\nPress any key to close."
read -k1
