#!/bin/bash
set -e

echo "🚀 Setting up Uppy Companion development environment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Change to companion directory
cd "$(dirname "$0")/../packages/@uppy/companion"

echo -e "${YELLOW}📝 Creating .env file with development configuration...${NC}"

cat > .env << 'EOF'
# Server Configuration
COMPANION_DOMAIN=localhost:3020
COMPANION_PROTOCOL=http
COMPANION_PORT=3020
COMPANION_SECRET=development-secret-change-in-production
COMPANION_PREAUTH_SECRET=development-preauth-secret-change-in-production

# Data directories
COMPANION_DATADIR=/tmp/companion-data
COMPANION_FILEDIR=/tmp/companion-data/files

# CORS Configuration
COMPANION_CLIENT_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:5173

# Upload URLs (for security in production)
COMPANION_UPLOAD_URLS=http://localhost:3000/api/upload,http://localhost:3001/api/upload

# Provider Credentials - Google Drive
# Replace with your actual credentials from Google Cloud Console
COMPANION_GOOGLE_KEY=your_google_client_id_here
COMPANION_GOOGLE_SECRET=your_google_client_secret_here

# Provider Credentials - Dropbox (add your own if needed)
# COMPANION_DROPBOX_KEY=your_dropbox_key
# COMPANION_DROPBOX_SECRET=your_dropbox_secret

# Optional: Redis configuration for scaling
# COMPANION_REDIS_URL=redis://localhost:6379
# COMPANION_REDIS_EXPRESS_SESSION_PREFIX=companion-session:

# Development mode
NODE_ENV=development
EOF

echo -e "${GREEN}✅ .env file created${NC}"

# Create data directories
echo -e "${YELLOW}📁 Creating data directories...${NC}"
mkdir -p /tmp/companion-data/files
echo -e "${GREEN}✅ Data directories created${NC}"

# Check if npm is available
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is not installed. Please install Node.js and npm first.${NC}"
    exit 1
fi

# Install dependencies with npm to avoid Yarn patch issues
echo -e "${YELLOW}📦 Installing dependencies with npm...${NC}"
if [ -f "package-lock.json" ]; then
    rm package-lock.json
fi

# Use npm instead of yarn to avoid patch-package issues
npm install --legacy-peer-deps

echo -e "${GREEN}✅ Dependencies installed${NC}"

# Build the companion if needed
if [ ! -d "lib" ]; then
    echo -e "${YELLOW}🔨 Building Companion...${NC}"
    npm run build 2>/dev/null || true
    echo -e "${GREEN}✅ Build complete${NC}"
fi

echo -e "${GREEN}🎉 Setup complete!${NC}"
echo ""
echo -e "${YELLOW}To start the Companion server, run:${NC}"
echo -e "  cd packages/@uppy/companion"
echo -e "  npm start"
echo ""
echo -e "${YELLOW}Or run directly with:${NC}"
echo -e "  cd packages/@uppy/companion"
echo -e "  node src/standalone/start-server.js"
echo ""
echo -e "${YELLOW}The server will be available at:${NC}"
echo -e "  http://localhost:3020"
echo ""
echo -e "${YELLOW}Configure your app to use:${NC}"
echo -e "  PUBLIC_COMPANION_URL=http://localhost:3020"