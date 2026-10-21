// A very small web framework on top of node:http, so the project has almost
// no dependencies. Supports: GET/POST routes with :params, JSON bodies,
// raw body (for WhatsApp signature checks), and static folders.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY = 15 * 1024 * 1024;

function decorate(res) {
  res.json = (obj, status = 200) => {
    res.writeHead(status, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify(obj));
  };
  res.send = (body, status = 200, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  };
  res.sendStatus = (status) => res.send(String(status), status);
  res.sendFile = (file) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return res.sendStatus(404);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp() {
  const routes = [];
  const statics = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:[A-Za-z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
  };

  async function handle(req, res) {
    decorate(res);
    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams);
    req.get = (h) => req.headers[h.toLowerCase()];
    try {
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (route) {
        const m = url.pathname.match(route.re);
        req.params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        if (req.method === 'POST') {
          req.rawBody = await readBody(req);
          const type = req.headers['content-type'] || '';
          req.body = type.includes('application/json') && req.rawBody.length ? JSON.parse(req.rawBody.toString('utf8')) : {};
        }
        return await route.handler(req, res);
      }
      if (req.method === 'GET') {
        for (const s of statics) {
          if (!url.pathname.startsWith(s.prefix)) continue;
          let rel = decodeURIComponent(url.pathname.slice(s.prefix.length)) || 'index.html';
          if (rel.endsWith('/')) rel += 'index.html';
          const file = path.resolve(s.dir, '.' + path.sep + rel);
          if (!file.startsWith(path.resolve(s.dir))) return res.sendStatus(403);
          if (fs.existsSync(file) && fs.statSync(file).isFile()) return res.sendFile(file);
        }
      }
      res.json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('[http]', err);
      if (!res.headersSent) res.json({ error: err.message }, err.status || (err instanceof SyntaxError ? 400 : 500));
    }
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    static: (prefix, dir) => statics.push({ prefix: prefix.endsWith('/') ? prefix : prefix + '/', dir }),
    handle,
    listen: (port, cb) => http.createServer(handle).listen(port, cb),
  };
}
