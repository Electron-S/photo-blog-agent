require('dotenv').config();

const fs = require('fs');
const http = require('http');
const path = require('path');
const axios = require('axios');
const { errCode, errFull, errResponseData } = require('../lib/err-text');

// 포트를 **REDIRECT_URI를 만들기 전에** 검증한다. 예전에는 `Number('abc')`가 NaN이
// 되어도 그대로 `http://localhost:NaN/oauth2callback`을 만들어 authUrl에 실었고,
// 실패는 한참 뒤 `server.listen`에서 ERR_SOCKET_BAD_PORT raw 스택으로 나왔다.
function resolvePort(raw) {
  if (raw === undefined || raw === '') return 3000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`BLOGGER_OAUTH_PORT가 올바른 포트가 아닙니다 (받음: ${JSON.stringify(raw)}).`);
    console.error('  1~65535 사이의 정수를 지정하세요 (예: BLOGGER_OAUTH_PORT=3001).');
    process.exit(1);
  }
  return n;
}

const PORT = resolvePort(process.env.BLOGGER_OAUTH_PORT);
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
    // 예전에는 여기서 아무것도 찍지 않았다. 사용자 터미널은 `Waiting on ...`에서 멈춘
    // 그대로라, 브라우저를 보고 있지 않으면 무슨 일이 일어났는지 알 방법이 없었다.
    // 서버는 계속 대기한다 (사용자가 링크를 다시 열면 되고, 프로브 요청 하나로
    // 죽어서는 안 된다).
    console.error(`요청에 OAuth code가 없습니다 (${req.url}). 위 인증 URL을 다시 열어 주세요.`);
    return;
  }

  let tokenForSave;
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

    tokenForSave = refreshToken;
  } catch (err) {
    const details = errResponseData(err) || errFull(err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Token exchange failed: ${details}`);
    console.error(`Token exchange failed: ${details}`);
    server.close(() => process.exit(1));
    return;
  }

  // **저장을 교환 try 밖으로 뺀다.** 예전에는 `.env` 쓰기 실패(ENOENT/EACCES)가
  // 교환 catch에 걸려 `Token exchange failed: ENOENT ...`로 보고됐다 — 교환은
  // 성공했는데 진단이 엉뚱한 하위 시스템을 가리켰고, 사용자는 OAuth를 다시 돌려
  // 똑같이 실패했다. 더 나쁜 것은 **방금 발급받은 refresh_token이 어디에도 출력되지
  // 않고 사라져** 손으로 복구할 방법이 없었다는 점이다 (실측 확인).
  //
  // CLIENT_ID/SECRET을 셸 환경변수로 주면 dotenv는 `.env` 없이도 통과하므로,
  // `.env`가 없거나 읽기 전용인 상태로 여기까지 오는 것은 실제로 도달 가능한 경로다.
  try {
    updateEnvRefreshToken(tokenForSave);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Token obtained but saving to .env failed. Check the terminal.');
    console.error(`토큰은 정상 발급됐지만 .env 저장에 실패했습니다: ${errFull(err)}`);
    console.error('  아래 값을 .env의 BLOGGER_REFRESH_TOKEN= 에 직접 넣으세요 (재발급 불필요):');
    console.error('');
    console.error(`BLOGGER_REFRESH_TOKEN=${tokenForSave}`);
    console.error('');
    // exit 2 = "결과는 나왔는데 저장이 실패했다" (README 종료 코드 표의 일관된 의미).
    server.close(() => process.exit(2));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Blogger refresh token saved. You can close this tab.');
  console.log('Blogger refresh token saved to .env');
  server.close(() => process.exit(0));
});

// 포트 문제를 raw 스택으로 죽지 않게 한다. 3000은 개발 기본 포트라 EADDRINUSE는
// 첫 실행 실패로 매우 흔한데, 예전에는 `BLOGGER_OAUTH_PORT`의 존재조차 알려주지 않았다.
server.on('error', (err) => {
  if (errCode(err) === 'EADDRINUSE') {
    console.error(`포트 ${PORT}이 이미 사용 중입니다.`);
    console.error(`  다른 포트로 실행하세요: BLOGGER_OAUTH_PORT=3001 npm run blogger:auth`);
    console.error('  Google Cloud Console의 승인된 리디렉션 URI에도 같은 포트를 등록해야 합니다.');
  } else if (errCode(err) === 'EACCES') {
    console.error(`포트 ${PORT}에 바인딩할 권한이 없습니다 (1024 미만 포트는 권한이 필요합니다).`);
    console.error('  BLOGGER_OAUTH_PORT=3001 처럼 1024 이상을 지정하세요.');
  } else {
    console.error(`OAuth 콜백 서버를 열 수 없습니다: ${errFull(err)}`);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('Open this URL in your browser to authorize Blogger access:');
  console.log(authUrl.toString());
  console.log(`Waiting on ${REDIRECT_URI}`);
});