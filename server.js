const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Route principale → sert prospai.html
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'prospai.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Erreur serveur');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // 404 pour tout le reste
  res.writeHead(404);
  res.end('Page introuvable');
});

server.listen(PORT, () => {
  console.log(`ProspAI démarré sur le port ${PORT}`);
});
