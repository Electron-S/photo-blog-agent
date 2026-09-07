require('dotenv').config();

const fs = require('fs');
const http = require('http');
const path = require('path');
const axios = require('axios');
const { errFull } = require('../lib/err-text');

const PORT = Number(process.env.BLOGGER_OAUTH_PORT || 3000);
const REDIRECT_PATH = '/oauth2callback';
const REDIRECT_URI = `http://localhost:${PORT}${REDIRECT_PATH}`;
const SCOPE = 'https://www.googleapis.com/auth/blogger';

const clientId = process.env.BLOGGER_CLIENT_ID;
const clientSecret = process.env.BLOGGER_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('BLOGGER_CLIENT_ID and BLOGGER_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

function updateEnvRefreshToken(refreshToken) {
  const envPath = path.join(process.cwd(), '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const next = content.match(/^BLOGGER_REFRESH_TOKEN=/m)
    ? content.replace(/^BLOGGER_REFRESH_TOKEN=.*$/m, `BLOGGER_REFRESH_TOKEN=${refreshToken}`)
    : `${content.trimEnd()}\nBLOGGER_REFRESH_TOKEN=${refreshToken}\n`;

  fs.writeFileSync(envPath, next);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, REDIRECT_URI);

  if (reqUrl.pathname !== REDIRECT_PATH) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = reqUrl.searchParams.get('code');
  const error = reqUrl.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`OAuth error: ${error}`);
    console.error(`OAuth error: ${error}`);
    server.close(() => process.exit(1));
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Missing OAuth code');
    return;
  }

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const refreshToken = tokenRes.data.refresh_token;
    if (!refreshToken) {
      throw new Error('Google did not return a refresh_token. Re-run with prompt=consent or revoke the old grant.');
    }

    updateEnvRefreshToken(refreshToken);

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Blogger refresh token saved. You can close this tab.');
    console.log('Blogger refresh token saved to .env');
    server.close(() => process.exit(0));
  } catch (err) {
    const details = err.response?.data ? JSON.stringify(err.response.data) : errFull(err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Token exchange failed: ${details}`);
    console.error(`Token exchange failed: ${details}`);
    server.close(() => process.exit(1));
  }
});

server.listen(PORT, () => {
  console.log('Open this URL in your browser to authorize Blogger access:');
  console.log(authUrl.toString());
  console.log(`Waiting on ${REDIRECT_URI}`);
});