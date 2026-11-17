#!/bin/sh
# Refuses to start without a token: `serve` on 0.0.0.0 without one would expose the repository.
set -eu
if [ -z "${SNAPSHOT_TOKEN:-}" ]; then
  echo "SNAPSHOT_TOKEN is required: it is the bearer token clients must send." >&2
  exit 1
fi
exec node dist/bin.js serve --host 0.0.0.0 --port "${PORT:-4788}" --token "$SNAPSHOT_TOKEN"
