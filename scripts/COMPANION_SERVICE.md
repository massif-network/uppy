# Uppy Companion macOS Startup Service

This directory contains the configuration for running the Uppy Companion server as a macOS startup service using launchd.

## Overview

The Companion server is configured to:
- Start automatically when you log into your Mac
- Run in production mode (stable, no hot-reload)
- Automatically restart if it crashes
- Load environment variables from the project's `.env` file (if it exists)
- Log all output to `~/Library/Logs/`

## Files

- `start-companion-service.sh` - Shell launcher script that handles environment loading and starts the server
- `~/Library/LaunchAgents/com.uppy.companion.plist` - macOS LaunchAgent configuration

## Creating the Service Manually

If you need to set up the service from scratch or recreate it, follow these steps:

### Prerequisites

1. **Build the Companion package**:
   ```bash
   cd ~/code/massif-network/massif-uppy
   yarn workspace @uppy/companion build
   ```

2. **Find your node installation path**:
   ```bash
   which node
   ```

   Example output: `~/.nvm/versions/node/v22.15.1/bin/node`

   Take note of the directory path (everything before `/node`).

### Step 1: Create the Shell Launcher Script

1. Create the scripts directory if it doesn't exist:
   ```bash
   mkdir -p ~/code/massif-network/massif-uppy/scripts
   ```

2. Create the launcher script:
   ```bash
   nano ~/code/massif-network/massif-uppy/scripts/start-companion-service.sh
   ```

3. Add the following content:
   ```bash
   #!/usr/bin/env bash
   cd ~/code/massif-network/massif-uppy

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
   ```

4. Save and exit (`Ctrl+X`, then `Y`, then `Enter`)

5. Make the script executable:
   ```bash
   chmod +x ~/code/massif-network/massif-uppy/scripts/start-companion-service.sh
   ```

### Step 2: Create the LaunchAgent plist

1. Ensure the LaunchAgents directory exists:
   ```bash
   mkdir -p ~/Library/LaunchAgents
   ```

2. Create the plist file:
   ```bash
   nano ~/Library/LaunchAgents/com.uppy.companion.plist
   ```

3. Add the following content, **replacing the PATH value with your node path from the prerequisites**:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
       <key>Label</key>
       <string>com.uppy.companion</string>

       <key>ProgramArguments</key>
       <array>
           <string>/bin/bash</string>
           <string>~/code/massif-network/massif-uppy/scripts/start-companion-service.sh</string>
       </array>

       <key>WorkingDirectory</key>
       <string>~/code/massif-network/massif-uppy</string>

       <key>RunAtLoad</key>
       <true/>

       <key>KeepAlive</key>
       <true/>

       <key>StandardOutPath</key>
       <string>~/Library/Logs/uppy-companion.log</string>

       <key>StandardErrorPath</key>
       <string>~/Library/Logs/uppy-companion.error.log</string>

       <key>EnvironmentVariables</key>
       <dict>
           <key>PATH</key>
           <string>~/.nvm/versions/node/v22.15.1/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
           <key>DOTENV_CONFIG_PATH</key>
           <string>~/code/massif-network/massif-uppy/.env</string>
       </dict>
   </dict>
   </plist>
   ```

   **Important**: Replace `~/.nvm/versions/node/v22.15.1/bin` with your actual node path directory.

4. Save and exit (`Ctrl+X`, then `Y`, then `Enter`)

### Step 3: Load and Start the Service

1. Load the LaunchAgent:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.uppy.companion.plist
   ```

   This will register the service and start it immediately (because `RunAtLoad` is true).

2. Verify the service is running:
   ```bash
   launchctl list | grep com.uppy.companion
   ```

   You should see output like:
   ```
   12345	0	com.uppy.companion
   ```

3. Check the logs:
   ```bash
   tail -20 ~/Library/Logs/uppy-companion.log
   ```

   You should see:
   ```
   Welcome to Companion! v6.2.1
   Listening on http://localhost:3020
   ```

4. Test the server:
   ```bash
   curl http://localhost:3020
   ```

   You should see the Companion welcome message.

### Configuration Notes

- **PATH variable**: The most critical part is the `PATH` in the plist. It must include the directory where your `node` executable lives. LaunchAgents don't inherit your shell's PATH.

- **If using nvm**: Always include your nvm node path first in the PATH string.

- **If using Homebrew node**: Include `/usr/local/bin` or `/opt/homebrew/bin` in the PATH.

- **Absolute paths**: Always use absolute paths (starting with `/` or `~/`) in the plist file.

### Testing Before Deploying

Before loading the LaunchAgent, test the shell script manually:

```bash
cd ~/code/massif-network/massif-uppy
./scripts/start-companion-service.sh
```

If it works (you see "Welcome to Companion"), press `Ctrl+C` and proceed with loading the LaunchAgent.

## Service Management Commands

### Check Service Status
```bash
# Check if service is running
launchctl list | grep com.uppy.companion

# View output logs
tail -f ~/Library/Logs/uppy-companion.log

# View error logs
tail -f ~/Library/Logs/uppy-companion.error.log
```

### Start/Stop Service
```bash
# Stop the service
launchctl stop com.uppy.companion

# Start the service (if stopped)
launchctl start com.uppy.companion

# Restart the service (stop and start)
launchctl stop com.uppy.companion && launchctl start com.uppy.companion
```

### Enable/Disable Auto-Start
```bash
# Disable auto-start on login (but keep service loaded)
launchctl unload ~/Library/LaunchAgents/com.uppy.companion.plist

# Enable auto-start on login
launchctl load ~/Library/LaunchAgents/com.uppy.companion.plist
```

### Reload After Configuration Changes
```bash
# If you modify the plist file, reload it
launchctl unload ~/Library/LaunchAgents/com.uppy.companion.plist
launchctl load ~/Library/LaunchAgents/com.uppy.companion.plist
```

### Completely Remove Service
```bash
# Stop and unload the service
launchctl stop com.uppy.companion
launchctl unload ~/Library/LaunchAgents/com.uppy.companion.plist

# Optionally delete the plist file
rm ~/Library/LaunchAgents/com.uppy.companion.plist
```

## Configuration

### Environment Variables

The service loads environment variables in this order:

1. **From `.env` file** (if exists at project root):
   ```
   ~/code/massif-network/massif-uppy/.env
   ```

2. **Fallback to hardcoded defaults** (if no `.env` file):
   - `COMPANION_DATADIR`: "./packages/@uppy/companion/output"
   - `COMPANION_DOMAIN`: "localhost:3020"
   - `COMPANION_PROTOCOL`: "http"
   - `COMPANION_PORT`: 3020
   - `COMPANION_CLIENT_ORIGINS`: ""
   - `COMPANION_SECRET`: "development"
   - `COMPANION_PREAUTH_SECRET`: "development2"
   - `COMPANION_ALLOW_LOCAL_URLS`: "true"

### Modifying Configuration

To change environment variables:

1. Create or edit `.env` file at project root:
   ```bash
   cd ~/code/massif-network/massif-uppy
   nano .env
   ```

2. Add your configuration:
   ```env
   COMPANION_PORT=3021
   COMPANION_SECRET=your-secret-here
   COMPANION_PREAUTH_SECRET=your-preauth-secret
   ```

3. Restart the service:
   ```bash
   launchctl stop com.uppy.companion
   launchctl start com.uppy.companion
   ```

Alternatively, you can edit the hardcoded defaults in `start-companion-service.sh`.

## Accessing the Companion Server

Once running, the server is accessible at:
```
http://localhost:3020
```

Or whatever port you configured in `COMPANION_PORT`.

## Troubleshooting

### Service Won't Start

1. **Check logs for errors**:
   ```bash
   tail -50 ~/Library/Logs/uppy-companion.error.log
   ```

2. **Verify node is in PATH**:
   The service needs to find `node`. If you change node versions (e.g., with nvm), update the PATH in the plist:
   ```bash
   # Find current node location
   which node

   # Edit plist and update PATH to include the node directory
   nano ~/Library/LaunchAgents/com.uppy.companion.plist

   # Reload
   launchctl unload ~/Library/LaunchAgents/com.uppy.companion.plist
   launchctl load ~/Library/LaunchAgents/com.uppy.companion.plist
   ```

3. **Ensure companion is built**:
   ```bash
   cd ~/code/massif-network/massif-uppy
   yarn workspace @uppy/companion build
   ```

### Port Already in Use

If port 3020 is already in use:

1. Change the port in your `.env` file:
   ```env
   COMPANION_PORT=3021
   ```

2. Restart the service

### Service Crashes Immediately

Check error logs:
```bash
tail -100 ~/Library/Logs/uppy-companion.error.log
```

Common issues:
- Missing dependencies: Run `yarn install`
- Missing build files: Run `yarn workspace @uppy/companion build`
- Invalid environment variables: Check your `.env` file

### Can't Find Service

Verify the plist file exists:
```bash
ls -la ~/Library/LaunchAgents/com.uppy.companion.plist
```

If it doesn't exist, you need to recreate it.

### After Updating Node Version (nvm)

If you update your node version via nvm, you need to update the PATH in the LaunchAgent:

1. Find new node location:
   ```bash
   which node
   ```

2. Edit the plist file:
   ```bash
   nano ~/Library/LaunchAgents/com.uppy.companion.plist
   ```

3. Update the PATH key under EnvironmentVariables to include your new node path

4. Reload the service:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.uppy.companion.plist
   launchctl load ~/Library/LaunchAgents/com.uppy.companion.plist
   ```

## Testing Manually

To test the script manually before using the service:

```bash
cd ~/code/massif-network/massif-uppy
./scripts/start-companion-service.sh
```

Press `Ctrl+C` to stop.

## Log Files

Logs are stored in:
- **Output**: `~/Library/Logs/uppy-companion.log`
- **Errors**: `~/Library/Logs/uppy-companion.error.log`

View logs in real-time:
```bash
# Both logs
tail -f ~/Library/Logs/uppy-companion.log ~/Library/Logs/uppy-companion.error.log

# Just output
tail -f ~/Library/Logs/uppy-companion.log

# Just errors
tail -f ~/Library/Logs/uppy-companion.error.log
```

## Advanced Configuration

### Changing Working Directory

If you move the project, update these locations in the plist file:

- `ProgramArguments` - path to the shell script
- `WorkingDirectory` - project root directory
- `DOTENV_CONFIG_PATH` - path to .env file

### Disabling Auto-Restart

If you don't want the service to auto-restart on crash, edit the plist:

```bash
nano ~/Library/LaunchAgents/com.uppy.companion.plist
```

Change:
```xml
<key>KeepAlive</key>
<true/>
```

To:
```xml
<key>KeepAlive</key>
<false/>
```

Then reload the service.

### Manual Start Only (No Auto-Start on Login)

Edit the plist:
```bash
nano ~/Library/LaunchAgents/com.uppy.companion.plist
```

Change:
```xml
<key>RunAtLoad</key>
<true/>
```

To:
```xml
<key>RunAtLoad</key>
<false/>
```

Then reload the service. You'll need to manually start it with:
```bash
launchctl start com.uppy.companion
```

## See Also

- [Companion Documentation](https://uppy.io/docs/companion/)
- [launchd Documentation](https://www.launchd.info/)
- [Project README](../CLAUDE.md)
