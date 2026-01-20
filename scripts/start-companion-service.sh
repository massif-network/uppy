#!/usr/bin/env bash
cd /Users/gummis/code/massif-network/massif-uppy

# Check if .env exists at project root
if [ -f .env ]; then
  # Load .env and run with dotenv
  exec node -r dotenv/config packages/@uppy/companion/lib/standalone/start-server.js
else
  # Use development defaults
  exec env \
    COMPANION_DATADIR="./packages/@uppy/companion/output" \
    COMPANION_DOMAIN="localhost:3020" \
    COMPANION_PROTOCOL="http" \
    COMPANION_PORT=3020 \
    COMPANION_CLIENT_ORIGINS="" \
    COMPANION_SECRET="development" \
    COMPANION_PREAUTH_SECRET="development2" \
    COMPANION_ALLOW_LOCAL_URLS="true" \
    node packages/@uppy/companion/lib/standalone/start-server.js
fi
