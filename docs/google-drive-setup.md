# Google Drive Integration Setup Guide

This guide walks you through setting up Google Drive integration with Uppy Companion, including OAuth configuration, API enablement, and metadata extraction.

## Prerequisites

- Google Cloud Console account
- A project in Google Cloud Console
- Uppy Companion server

## Step 1: Create OAuth 2.0 Credentials

### 1.1 Access Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project or create a new one
3. Navigate to **APIs & Services** → **Credentials**

### 1.2 Create OAuth Client ID

1. Click **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**
2. If prompted, configure the OAuth consent screen first:
   - Choose **External** for user type (unless using Google Workspace)
   - Fill in required fields (App name, User support email, Developer email)
   - Add your domain to **Authorized domains** if applicable
   - Save and continue

3. For the OAuth client ID:
   - **Application type**: Select **"Web application"**
   - **Name**: Enter a descriptive name (e.g., "Uppy Companion")

### 1.3 Configure JavaScript Origins

Add all URLs where your frontend application will run:

**Development:**
```
http://localhost:3000
http://localhost:3001
http://localhost:5173
```

**Production:**
```
https://yourdomain.com
https://app.yourdomain.com
```

### 1.4 Configure Redirect URIs

Add the Companion OAuth callback URL:

**Development:**
```
http://localhost:3020/drive/redirect
```

**Staging:**
```
https://companion-staging.yourdomain.com/drive/redirect
```

**Production:**
```
https://companion.yourdomain.com/drive/redirect
```

### 1.5 Save and Retrieve Credentials

1. Click **"CREATE"**
2. A popup will show your credentials:
   - **Client ID**: `YOUR_CLIENT_ID` (e.g., `982462757186-xxxxx.apps.googleusercontent.com`)
   - **Client Secret**: `YOUR_CLIENT_SECRET` (e.g., `GOCSPX-xxxxxxxxxxxxx`)
3. **Save these credentials securely** - you'll need them for Companion configuration

## Step 2: Enable Google Drive API

### 2.1 Navigate to API Library

1. In Google Cloud Console, go to **APIs & Services** → **Library**
2. Search for **"Google Drive API"**
3. Click on the Google Drive API result

### 2.2 Enable the API

1. Click the **"ENABLE"** button
2. Wait for the API to be enabled (may take 1-2 minutes)

**Alternative:** Use the direct link with your project ID:
```
https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=YOUR_PROJECT_ID
```

## Step 3: Configure Companion Server

### 3.1 Environment Variables

Add these environment variables to your Companion server:

```bash
# Google Drive OAuth Credentials
COMPANION_GOOGLE_KEY=YOUR_CLIENT_ID
COMPANION_GOOGLE_SECRET=YOUR_CLIENT_SECRET

# Server Configuration (example for development)
COMPANION_DOMAIN=localhost:3020
COMPANION_PROTOCOL=http
COMPANION_PORT=3020

# CORS Configuration
COMPANION_CLIENT_ORIGINS=http://localhost:3000,http://localhost:3001

# Security (generate strong secrets for production)
COMPANION_SECRET=your-secret-key
COMPANION_PREAUTH_SECRET=your-preauth-secret
```

### 3.2 Using .env File

Create a `.env` file in your Companion directory:

```bash
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
COMPANION_CLIENT_ORIGINS=http://localhost:3000,http://localhost:3001

# Google Drive Credentials
COMPANION_GOOGLE_KEY=982462757186-xxxxx.apps.googleusercontent.com
COMPANION_GOOGLE_SECRET=GOCSPX-xxxxxxxxxxxxx

# Development mode
NODE_ENV=development
```

### 3.3 Production Configuration

For production, ensure:

1. Use HTTPS protocol (`COMPANION_PROTOCOL=https`)
2. Set proper domain with HTTPS (`COMPANION_DOMAIN=companion.yourdomain.com`)
3. Generate strong secrets for `COMPANION_SECRET` and `COMPANION_PREAUTH_SECRET`
4. Store credentials securely (use environment variables or secrets management)
5. Set `NODE_ENV=production`

## Step 4: Frontend Configuration

### 4.1 Uppy Configuration

Configure Uppy in your frontend application:

```javascript
import Uppy from '@uppy/core'
import GoogleDrive from '@uppy/google-drive'
import Dashboard from '@uppy/dashboard'

const uppy = new Uppy()
  .use(Dashboard, {
    inline: true,
    target: '#uppy-dashboard'
  })
  .use(GoogleDrive, {
    companionUrl: 'http://localhost:3020', // Your Companion URL
    companionAllowedHosts: ['localhost:3020']
  })
```

### 4.2 Production Frontend

```javascript
.use(GoogleDrive, {
  companionUrl: 'https://companion.yourdomain.com',
  companionAllowedHosts: ['companion.yourdomain.com']
})
```

## Step 5: Metadata Extraction

The Google Drive provider automatically extracts rich metadata from files:

### 5.1 Image Metadata

For image files, the following metadata is extracted:

```javascript
{
  imageMediaMetadata: {
    width: 3840,
    height: 2160,
    rotation: 0,
    location: {
      latitude: 37.7749,
      longitude: -122.4194,
      altitude: 10.0
    },
    time: '2023-12-25T10:30:00.000Z',
    cameraMake: 'Canon',
    cameraModel: 'EOS R5',
    exposureTime: 0.005,
    aperture: 2.8,
    flashUsed: false,
    focalLength: 50.0,
    isoSpeed: 400,
    // ... and more EXIF data
  }
}
```

### 5.2 Video Metadata

For video files:

```javascript
{
  videoMediaMetadata: {
    width: 1920,
    height: 1080,
    durationMillis: '120000' // Duration in milliseconds
  }
}
```

## Step 6: Testing

### 6.1 Local Development Testing

1. Start Companion server:
   ```bash
   cd packages/@uppy/companion
   node src/standalone/start-server.js
   ```

2. Verify server is running:
   ```bash
   curl http://localhost:3020/
   ```

3. Test OAuth flow:
   - Open your application
   - Click on Google Drive option
   - Authenticate with Google
   - Verify files are listed
   - Select a file and check metadata extraction

### 6.2 Troubleshooting

Common issues and solutions:

1. **"Google Drive API has not been used in project..."**
   - Solution: Enable Google Drive API in Google Cloud Console

2. **OAuth redirect URL mismatch**
   - Solution: Ensure redirect URI in Google Console matches exactly (including port)
   - Check `COMPANION_DOMAIN` includes port for localhost (e.g., `localhost:3020`)

3. **CORS errors**
   - Solution: Add your frontend URL to `COMPANION_CLIENT_ORIGINS`

4. **No files showing after authentication**
   - Check browser console for errors
   - Verify Google Drive API is enabled
   - Check Companion server logs

## Step 7: Security Best Practices

1. **Never commit credentials** to version control
2. Use **environment variables** or secrets management
3. **Rotate secrets** regularly
4. Use **HTTPS in production**
5. Implement **rate limiting** for production
6. **Restrict OAuth scopes** to minimum required
7. **Monitor API usage** in Google Cloud Console

## Common Configuration Pitfalls

### Domain Configuration
- ❌ Wrong: `COMPANION_DOMAIN=localhost` (missing port)
- ✅ Correct: `COMPANION_DOMAIN=localhost:3020`

### CORS Origins
- ❌ Wrong: `COMPANION_CLIENT_ORIGINS=true` (too permissive for production)
- ✅ Correct: `COMPANION_CLIENT_ORIGINS=https://app.yourdomain.com`

### Redirect URIs
- Must match exactly, including protocol and port
- No trailing slashes
- Case-sensitive

## API Quotas and Limits

Google Drive API has usage quotas:
- **Queries per day**: 1,000,000,000
- **Queries per 100 seconds per user**: 1,000
- **Queries per 100 seconds**: 10,000

Monitor usage in Google Cloud Console → APIs & Services → Google Drive API → Quotas

## Additional Resources

- [Google Drive API Documentation](https://developers.google.com/drive/api/v3/about-sdk)
- [Uppy Google Drive Documentation](https://uppy.io/docs/google-drive/)
- [OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Cloud Console](https://console.cloud.google.com/)

## Support

For issues related to:
- **Uppy/Companion**: [GitHub Issues](https://github.com/transloadit/uppy/issues)
- **Google Drive API**: [Google Drive API Support](https://developers.google.com/drive/api/v3/support)
- **OAuth Issues**: Check [OAuth 2.0 Troubleshooting](https://developers.google.com/identity/protocols/oauth2/troubleshooting)