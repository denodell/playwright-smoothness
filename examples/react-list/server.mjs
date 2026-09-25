// Serves ./public on port 4181.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./public', import.meta.url));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
};
createServer(async (req, res) => {
  let path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  let body;
  try {
    if (!file.startsWith(root)) throw new Error('outside root');
    body = await readFile(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}).listen(4181);
