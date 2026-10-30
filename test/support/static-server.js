// Serves a built site (dist/) over http on 127.0.0.1. The panel is a module bundle, which Chromium
// will not load from file://, so the UI tests open it through this server instead.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png'
};

/** serveDir(dir) -> Promise<{ url, close }>: static files, index.html for any unknown path. */
function serveDir(dirArg) {
  const dir = path.resolve(dirArg);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    let file = path.join(dir, rel);
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: 'http://127.0.0.1:' + server.address().port + '/', close: () => new Promise(r => server.close(r)) });
    });
  });
}

module.exports = { serveDir };
