import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 1000);
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const ALLOWED_TARGETS = (process.env.ALLOWED_TARGETS || 'https://router.bynara.id,https://apihub.agnes-ai.com')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const DEFAULT_TARGET = process.env.DEFAULT_TARGET || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-ai-proxy-target, x-proxy-token, proxy-token'
};

function json(res, status, obj, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS, ...extra });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (req.url === '/health') {
      return json(res, 200, {
        ok: true,
        targets: ALLOWED_TARGETS,
        defaultConfigured: Boolean(DEFAULT_TARGET)
      });
    }

    const token = req.headers['x-proxy-token'] || req.headers['proxy-token'];
    if (PROXY_TOKEN && String(token) !== PROXY_TOKEN) {
      return json(res, 401, { error: 'invalid proxy token' });
    }

    let base = req.headers['x-ai-proxy-target'] || DEFAULT_TARGET;
    let path = req.url || '/';

    if (path.startsWith('http://') || path.startsWith('https://')) {
      base = path;
      path = '/';
    }

    if (!base) {
      return json(res, 400, {
        error: 'missing target; set DEFAULT_TARGET or send X-AI-Proxy-Target header'
      });
    }

    const target = new URL(base + (path === '/' ? '' : path));
    if (!ALLOWED_TARGETS.includes(target.origin)) {
      return json(res, 403, { error: 'target not allowed', origin: target.origin });
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'accept-encoding', 'x-proxy-token', 'proxy-token'].includes(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers['accept-encoding'] = 'identity';

    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const upstream = await fetch(target.href, {
      method: req.method,
      headers,
      body,
      redirect: 'follow'
    });

    res.writeHead(upstream.status, { ...CORS, ...Object.fromEntries(upstream.headers) });

    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }

    res.end();
  } catch (err) {
    console.error('proxy error', err);
    if (!res.headersSent) {
      return json(res, 502, { error: 'proxy error', detail: String(err?.message || err) });
    }
    res.end();
  }
});

server.listen(PORT, () => console.log(`AI proxy listening on ${PORT}`));
