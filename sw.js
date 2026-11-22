// 流式解密：按 Range 请求把分块解密后返回，避免整文件进内存
const streams = new Map();
const cache = new Map();
const MAX_CACHE = 3;

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.claim(); });

self.addEventListener('message', function (e) {
  const d = e.data;
  if (d && d.type === 'config') streams.set(d.id, d);
});

self.addEventListener('fetch', function (e) {
  const u = new URL(e.request.url);
  if (u.pathname.indexOf('__vlt_stream') < 0) return;
  e.respondWith(handle(e.request, u));
});

function b64(s) {
  const bin = atob(s.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function chunkBytes(cfg, i) {
  const key = cfg.id + ':' + i;
  if (cache.has(key)) return cache.get(key);
  const meta = cfg.chunks[i - 1];
  const r = await fetch('https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/git/blobs/' + meta.sha, {
    headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json' }
  });
  if (!r.ok) throw new Error('blob ' + r.status);
  const j = await r.json();
  const raw = b64(j.content);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const k = await crypto.subtle.importKey('raw', b64(cfg.key), 'AES-GCM', false, ['decrypt']);
  const aad = new TextEncoder().encode('vltc1|' + cfg.rel + '|' + i);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv, tagLength: 128, additionalData: aad }, k, ct));
  cache.set(key, pt);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return pt;
}

async function handle(req, u) {
  const id = u.searchParams.get('id');
  const cfg = streams.get(id);
  if (!cfg) return new Response('no config', { status: 404 });
  const total = cfg.total;
  const range = req.headers.get('range');
  let start = 0, end = total - 1;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    }
  }
  const CH = cfg.chunkSize;
  const first = Math.floor(start / CH) + 1;
  const last = Math.floor(end / CH) + 1;
  const parts = [];
  for (let i = first; i <= last; i++) {
    const data = await chunkBytes(cfg, i);
    const s = i === first ? start - (i - 1) * CH : 0;
    const e = i === last ? end - (i - 1) * CH + 1 : data.length;
    parts.push(data.slice(s, e));
  }
  const body = new Blob(parts);
  const headers = {
    'Content-Type': cfg.mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(body.size),
    'Cache-Control': 'no-store'
  };
  if (range) {
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
    return new Response(body, { status: 206, headers: headers });
  }
  return new Response(body, { status: 200, headers: headers });
}
