#!/bin/bash
set -e

# Default the storage paths to the mounted volume when running in the container.
export SESSION_FILE="${SESSION_FILE:-/data/sessions.json}"
export SCHEDULE_FILE="${SCHEDULE_FILE:-/data/schedule.json}"

# /app/data links to /data/data (see Dockerfile). Create it here because the
# volume mount hides anything the image put under /data. Non-fatal: the bot
# still answers without it, only the script caches would not persist.
if mkdir -p /data/data; then
  # Some older deploys wrote caches to the volume root instead. Seed any the
  # data dir lacks, never overwriting a copy already there (that one is newer).
  for f in notion-ids.json google-token.json google-calendar.json; do
    if [ -f "/data/$f" ] && [ ! -e "/data/data/$f" ]; then
      cp -p "/data/$f" "/data/data/$f" || true
    fi
  done
else
  echo "[entrypoint] warning: could not create /data/data; script caches will not persist" >&2
fi

# Start the agent.
exec node dist/index.js
