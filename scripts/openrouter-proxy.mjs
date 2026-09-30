// Local OpenRouter proxy for the heatmap agent, so an API key kept in .env
// never has to be typed into the page or stored in the browser.
//
//   node scripts/openrouter-proxy.mjs        (listens on 127.0.0.1:8787)
//
// Then set the agent's API base URL to http://localhost:8787/api/v1 and leave
// the key empty. The proxy only forwards OpenRouter API paths, only accepts
// pages served from localhost, and adds `Authorization: Bearer
// $OPENROUTER_API_KEY` on the way out. It never logs or returns the key.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PROXY_PORT) || 8787;
const UPSTREAM = 'https://openrouter.ai';
const ALLOWED_PATHS = /^\/api\/(v1|alpha)\//;
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = /^\s*OPENROUTER_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(env);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const KEY = readKey();
if (!KEY) {
  console.error('No OPENROUTER_API_KEY in the environment or in .env.');
  process.exit(1);
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  // Only pages served from localhost may use the key. "null" is refused: any
  // website can send it from a sandboxed iframe. (Serve the app with
  // `npm run serve` rather than opening it from disk.) Requests without an
  // Origin come from local programs, not web pages.
  const originOk = !origin || ALLOWED_ORIGIN.test(origin);
  if (originOk && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (!originOk) return end(res, 403, 'Origin not allowed.');
  // A site that points its own domain at 127.0.0.1 (DNS rebinding) sends its
  // domain as Host; only localhost names reach the key.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return end(res, 403, 'Host not allowed.');
  if (req.method === 'OPTIONS') return end(res, 204);
  const path = new URL(req.url, 'http://x').pathname;
  if (!ALLOWED_PATHS.test(path)) return end(res, 404, 'Only /api/v1/ and /api/alpha/ are forwarded.');
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const headers = { authorization: `Bearer ${KEY}`, 'content-type': req.headers['content-type'] || 'application/json' };
    for (const h of ['http-referer', 'x-title', 'x-openrouter-title', 'accept']) if (req.headers[h]) headers[h] = req.headers[h];
    const up = await fetch(UPSTREAM + req.url, { method: req.method, headers, body });
    res.statusCode = up.status;
    res.setHeader('content-type', up.headers.get('content-type') || 'application/json');
    res.end(Buffer.from(await up.arrayBuffer()));
    console.log(`${req.method} ${path} → ${up.status}`);
  } catch (err) {
    console.error(`${req.method} ${path} failed: ${err.message}`);
    end(res, 502, 'Upstream request failed.');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`OpenRouter proxy on http://localhost:${PORT}/api/v1 (key from ${process.env.OPENROUTER_API_KEY ? 'environment' : '.env'})`));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function end(res, status, message) {
  res.statusCode = status;
  if (message) res.setHeader('content-type', 'application/json');
  res.end(message ? JSON.stringify({ error: { message, code: status } }) : undefined);
}
