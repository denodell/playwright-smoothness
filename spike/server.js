// Minimal static server for the spike pages.
const http = require('http'), fs = require('fs'), path = require('path');
const types = { '.html': 'text/html', '.js': 'text/javascript' };
http.createServer((req, res) => {
  const file = path.join(__dirname, 'pages', new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
}).listen(4173, () => console.log('listening on 4173'));
