#!/bin/bash
set -e

# Default the storage paths to the mounted volume when running in the container.
export SESSION_FILE="${SESSION_FILE:-/data/sessions.json}"
export SCHEDULE_FILE="${SCHEDULE_FILE:-/data/schedule.json}"

# Start the agent.
exec node dist/index.js
