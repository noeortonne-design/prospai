const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'https://prospai-production.up.railway.app/auth/callback';

// Stockage temporaire des tokens (en mémoire — à remplacer par DB en prod)
const userTokens = {};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── 1. PROXY ANTHROPIC ──────────────────────────────────────────────
  if (pathname === '/api/claude' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const data = JSON.stringify(payload);
        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          }
        };
        const proxyReq = https.request(options, (proxyRes) => {
          let responseData = '';
          proxyRes.on('data', chunk => responseData += chunk.toString());
          proxyRes.on('end', () => {
            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(responseData);
          });
        });
        proxyReq.on('error', (e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        proxyReq.write(data);
        proxyReq.end();
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ── 2. DÉMARRER OAUTH GOOGLE ────────────────────────────────────────
  if (pathname === '/auth/gmail') {
    const params = querystring.stringify({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',
      access_type: 'offline',
      prompt: 'consent'
    });
    res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    res.end();
    return;
  }

  // ── 3. CALLBACK OAUTH GOOGLE ────────────────────────────────────────
  if (pathname === '/auth/callback') {
    const code = parsedUrl.query.code;
    if (!code) {
      res.writeHead(400);
      res.end('Code manquant');
      return;
    }

    // Échanger le code contre un token
    const tokenData = querystring.stringify({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });

    const tokenReq = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(tokenData)
      }
    }, (tokenRes) => {
      let data = '';
      tokenRes.on('data', chunk => data += chunk.toString());
      tokenRes.on('end', () => {
        try {
          const tokens = JSON.parse(data);

          // Récupérer l'email de l'utilisateur
          const infoReq = https.request({
            hostname: 'www.googleapis.com',
            path: '/oauth2/v2/userinfo',
            method: 'GET',
            headers: { 'Authorization': `Bearer ${tokens.access_token}` }
          }, (infoRes) => {
            let infoData = '';
            infoRes.on('data', chunk => infoData += chunk.toString());
            infoRes.on('end', () => {
              try {
                const userInfo = JSON.parse(infoData);
                const email = userInfo.email;
                userTokens[email] = tokens;

                // Rediriger vers l'app avec l'email en paramètre
                res.writeHead(302, {
                  Location: `/?gmail_connected=true&email=${encodeURIComponent(email)}`
                });
                res.end();
              } catch(e) {
                res.writeHead(500);
                res.end('Erreur récupération profil');
              }
            });
          });
          infoReq.on('error', (e) => { res.writeHead(500); res.end(e.message); });
          infoReq.end();

        } catch(e) {
          res.writeHead(500);
          res.end('Erreur échange token');
        }
      });
    });
    tokenReq.on('error', (e) => { res.writeHead(500); res.end(e.message); });
    tokenReq.write(tokenData);
    tokenReq.end();
    return;
  }

  // ── 4. ENVOYER EMAIL VIA GMAIL API ──────────────────────────────────
  if (pathname === '/api/send-email' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { from, to, subject, text } = JSON.parse(body);
        const tokens = userTokens[from];

        if (!tokens) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Gmail non connecté pour cet email' }));
          return;
        }

        // Construire le message RFC 2822
        const message = [
          `From: ${from}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          text
        ].join('\n');

        const encoded = Buffer.from(message).toString('base64')
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        const emailData = JSON.stringify({ raw: encoded });

        const gmailReq = https.request({
          hostname: 'gmail.googleapis.com',
          path: '/gmail/v1/users/me/messages/send',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tokens.access_token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(emailData)
          }
        }, (gmailRes) => {
          let data = '';
          gmailRes.on('data', chunk => data += chunk.toString());
          gmailRes.on('end', () => {
            res.writeHead(gmailRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        gmailReq.on('error', (e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        gmailReq.write(emailData);
        gmailReq.end();

      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 5. LIRE GMAIL (détection réponses) ──────────────────────────────
  if (pathname === '/api/check-replies' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const { from, query } = JSON.parse(body);
        const tokens = userTokens[from];
        if (!tokens) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Gmail non connecté' }));
          return;
        }

        const searchPath = `/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`;
        const searchReq = https.request({
          hostname: 'gmail.googleapis.com',
          path: searchPath,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${tokens.access_token}` }
        }, (searchRes) => {
          let data = '';
          searchRes.on('data', chunk => data += chunk.toString());
          searchRes.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        searchReq.on('error', (e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        searchReq.end();
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 6. POLITIQUE DE CONFIDENTIALITÉ ────────────────────────────────
  if (pathname === '/privacy') {
    const filePath = path.join(__dirname, 'privacy.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Erreur serveur'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── 7. PAGE PRINCIPALE ──────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    const filePath = path.join(__dirname, 'prospai.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Erreur serveur'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`ProspAI démarré sur le port ${PORT}`);
});
