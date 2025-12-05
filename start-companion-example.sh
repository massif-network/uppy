#!/bin/bash

echo "🚀 Starting Uppy Companion Server with Cloud Storage Providers..."

cd packages/@uppy/companion

# Export all necessary environment variables
export COMPANION_DOMAIN=localhost:3020
export COMPANION_PROTOCOL=http
export COMPANION_PORT=3020
export COMPANION_SECRET=development-secret-change-in-production
export COMPANION_CLIENT_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:5173
export COMPANION_DATADIR=/tmp/companion-data

# OneDrive OAuth Configuration
export COMPANION_ONEDRIVE_KEY=[YOUR-ONEDRIVE-CLIENT-ID]
export COMPANION_ONEDRIVE_SECRET='[YOUR-ONEDRIVE-CLIENT-SECRET]'

# Dropbox OAuth Configuration
export COMPANION_DROPBOX_KEY=[YOUR-DROPBOX-APP-KEY]
export COMPANION_DROPBOX_SECRET=[YOUR-DROPBOX-APP-SECRET]

# Google Drive OAuth Configuration
export COMPANION_GOOGLE_KEY=[YOUR-GOOGLE-CLIENT-ID]
export COMPANION_GOOGLE_SECRET=[YOUR-GOOGLE-CLIENT-SECRET]

# Create data directory if it doesn't exist
mkdir -p /tmp/companion-data

echo "📋 Configuration:"
echo "   Server URL: http://localhost:3020"
echo "   OneDrive: ✅ Configured"
echo "   Dropbox: ✅ Configured"
echo "   Google Drive: ✅ Configured"
echo ""
echo "📌 OAuth Redirect URIs:"
echo "   OneDrive: http://localhost:3020/onedrive/redirect"
echo "   Dropbox: http://localhost:3020/dropbox/redirect"
echo "   Google Drive: http://localhost:3020/drive/redirect"
echo ""

# Start the server
node src/standalone/start-server.js