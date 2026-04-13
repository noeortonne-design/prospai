const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const server = http.createServer((req, res) => {

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // PROXY → Anthropic API
  if (req.url === '/api/claude' && req.method === 'POST') {
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

  // Sert prospai.html
  if (req.url === '/' || req.url === '/index.html') {
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
