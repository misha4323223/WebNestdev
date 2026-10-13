/**
 * WebNestDev AI Reverse Proxy
 * 
 * Проксирует запросы от WebNestDev (ВМ в РФ) к зарубежным AI-провайдерам.
 * Рендер-сервис видит зарубежный IP → ключи принимаются → нет 401.
 * 
 * Env vars (задаются в Render):
 *   TARGET_HOST — домен провайдера (например, router.bynara.id)
 *   TARGET_PORT — порт (443)
 * 
 * Поддерживает:
 *   - SSE-стриминг (AI-чат)
 *   - Проксирование Authorization-заголовков
 *   - CORS для фронтенда
 *   - Health check
 */
const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 10000;
const TARGET_HOST = process.env.TARGET_HOST || 'router.bynara.id';
const TARGET_PORT = process.env.TARGET_PORT || '443';

// Health endpoint
http.createServer((req, res) => {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      target: TARGET_HOST,
      port: TARGET_PORT,
      ts: new Date().toISOString()
    }));
    return;
  }

  // Proxy request
  const headers = { ...req.headers };
  headers.host = TARGET_HOST;
  delete headers.connection;
  delete headers['transfer-encoding'];

  const proxyReq = https.request({
    hostname: TARGET_HOST,
    port: parseInt(TARGET_PORT),
    path: req.url,
    method: req.method,
    headers: headers
  }, (proxyRes) => {
    // Forward all response headers (including content-type for SSE)
    const resHeaders = { ...proxyRes.headers };
    res.writeHead(proxyRes.statusCode, resHeaders);
    // Pipe response — works for both JSON and SSE streams
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy upstream error', detail: err.message }));
  });

  // Pipe request body to proxy
  req.pipe(proxyReq);
}).listen(PORT, () => {
  console.log(`AI Proxy started`);
  console.log(`  PORT: ${PORT}`);
  console.log(`  TARGET: ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`  Mode: reverse-proxy (SSE-compatible)`);
});
