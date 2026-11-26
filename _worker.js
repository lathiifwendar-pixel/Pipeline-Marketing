/**
 * EasyGo Pipeline - Cloudflare Pages (_worker.js)
 *
 * Tugas file ini:
 *  1. Menyajikan halaman (index.html) lewat env.ASSETS.
 *  2. Login nama pengguna + kata sandi, sesi lewat cookie bertanda tangan.
 *  3. Meneruskan permintaan data ke Apps Script (Google Sheet) dengan kunci rahasia
 *     yang hanya ada di server, tidak pernah dikirim ke browser.
 *
 * Variabel yang harus diisi di Cloudflare (Settings > Variables and Secrets):
 *   APPS_SCRIPT_URL  alamat Web app Apps Script (berakhiran /exec)
 *   API_TOKEN        kunci rahasia, sama persis dengan API_TOKEN di Code.gs
 *   SESSION_SECRET   teks acak panjang untuk menandatangani sesi login
 *   USERS            daftar pengguna (JSON), contoh di panduan
 */

const SESSION_COOKIE = 'egsid';
const SESSION_DAYS = 30;
const ALLOWED_FN = ['bootstrap', 'getData', 'saveRecord', 'deleteRecords', 'saveProfile'];
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      return await serveAsset(request, env, url);
    } catch (err) {
      return json({ ok: false, message: 'Terjadi kesalahan di server.' }, 500);
    }
  }
};

/* ---------- halaman statis ---------- */

async function serveAsset(request, env, url) {
  const res = await env.ASSETS.fetch(request);
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  if (url.pathname.endsWith('.webmanifest')) h.set('Content-Type', 'application/manifest+json');
  const type = h.get('Content-Type') || '';
  if (type.indexOf('text/html') === 0) {
    h.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
    h.set('X-Frame-Options', 'DENY');
    h.set('Cache-Control', 'no-cache');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/* ---------- util ---------- */

function json(obj, status, extra) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  if (extra) Object.keys(extra).forEach(k => h.append(k, extra[k]));
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}

function b64u(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getUsers(env) {
  if (!env.USERS) return null;
  try {
    const list = JSON.parse(env.USERS);
    if (!Array.isArray(list) || !list.length) return null;
    return list.filter(u => u && u.u && u.p).map(u => ({
      u: String(u.u).trim().toLowerCase(), p: String(u.p),
      name: String(u.name || u.u).slice(0, 40), role: String(u.role || 'Account Manager').slice(0, 40)
    }));
  } catch (e) { return null; }
}
function configProblem(env) {
  const miss = [];
  if (!env.APPS_SCRIPT_URL) miss.push('APPS_SCRIPT_URL');
  if (!env.API_TOKEN) miss.push('API_TOKEN');
  if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 16) miss.push('SESSION_SECRET (minimal 16 karakter)');
  if (!getUsers(env)) miss.push('USERS (format JSON tidak valid atau kosong)');
  return miss.length ? 'Variabel belum benar di Cloudflare: ' + miss.join(', ') + '.' : '';
}

/* ---------- sesi ---------- */

async function pwFingerprint(env, user) {
  return (await hmac(env.SESSION_SECRET, 'pw:' + user.u + ':' + user.p)).slice(0, 12);
}
async function makeCookie(env, user) {
  const payload = b64u(enc.encode(JSON.stringify({
    u: user.u, v: await pwFingerprint(env, user),
    exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400
  })));
  const sig = await hmac(env.SESSION_SECRET, payload);
  return SESSION_COOKIE + '=' + payload + '.' + sig + '; Max-Age=' + SESSION_DAYS * 86400 + '; Path=/; HttpOnly; Secure; SameSite=Lax';
}
function clearCookie() {
  return SESSION_COOKIE + '=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax';
}
async function getSession(request, env) {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 2) return null;
  const expect = await hmac(env.SESSION_SECRET, parts[0]);
  if (!safeEq(expect, parts[1])) return null;
  let p;
  try { p = JSON.parse(fromB64u(parts[0])); } catch (e) { return null; }
  if (!p || !p.u || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
  const users = getUsers(env) || [];
  const user = users.find(x => x.u === p.u);
  if (!user) return null;
  if (!safeEq(await pwFingerprint(env, user), String(p.v || ''))) return null;
  return user;
}

/* ---------- API ---------- */

async function handleApi(request, env, url) {
  const path = url.pathname;
  const problem = configProblem(env);

  if (path === '/api/session' && request.method === 'GET') {
    if (problem) return json({ configured: false, message: problem });
    const user = await getSession(request, env);
    return json({ configured: true, user: user ? { id: user.u, name: user.name, role: user.role } : null });
  }

  if (request.method !== 'POST') return json({ ok: false, message: 'Metode tidak didukung.' }, 405);

  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ ok: false, message: 'Asal permintaan ditolak.' }, 403);
  if ((request.headers.get('Content-Type') || '').indexOf('application/json') !== 0) {
    return json({ ok: false, message: 'Format permintaan tidak valid.' }, 415);
  }
  if (Number(request.headers.get('Content-Length') || 0) > 1000000) {
    return json({ ok: false, message: 'Permintaan terlalu besar.' }, 413);
  }
  if (problem) return json({ ok: false, message: problem }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, message: 'Isi permintaan rusak.' }, 400); }

  if (path === '/api/login') {
    const users = getUsers(env);
    const name = String((body && body.user) || '').trim().toLowerCase();
    const pass = String((body && body.pass) || '');
    const user = users.find(x => x.u === name);
    // bandingkan lewat HMAC agar waktu proses tidak membocorkan panjang kata sandi
    const a = await hmac(env.SESSION_SECRET, 'login:' + pass);
    const b = await hmac(env.SESSION_SECRET, 'login:' + (user ? user.p : ''));
    if (!user || !safeEq(a, b)) {
      await sleep(700);
      return json({ ok: false, message: 'Nama pengguna atau kata sandi salah.' }, 401);
    }
    return json({ ok: true }, 200, { 'Set-Cookie': await makeCookie(env, user) });
  }

  if (path === '/api/logout') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  if (path === '/api/call') {
    const user = await getSession(request, env);
    if (!user) return json({ ok: false, message: 'Belum masuk.' }, 401);
    const fn = body && body.fn;
    if (ALLOWED_FN.indexOf(fn) < 0) return json({ ok: false, message: 'Fungsi tidak dikenal.' }, 400);
    const args = Array.isArray(body.args) ? body.args : [];
    let res;
    try {
      res = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: env.API_TOKEN, fn: fn, args: args, user: { id: user.u, name: user.name, role: user.role } }),
        redirect: 'follow'
      });
    } catch (e) {
      return json({ ok: false, message: 'Server data (Apps Script) tidak terjangkau.' }, 502);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      return json({ ok: false, message: 'Apps Script memberi jawaban yang tidak dikenal. Periksa pengaturan deployment (Execute as: Me, akses: Anyone).' }, 502);
    }
    if (!data.ok) {
      const msg = data.error === 'unauthorized'
        ? 'Kunci API tidak cocok antara Cloudflare dan Apps Script.'
        : (data.message || 'Permintaan gagal di Apps Script.');
      return json({ ok: false, message: msg }, 502);
    }
    return json({ ok: true, result: data.result });
  }

  return json({ ok: false, message: 'Alamat tidak ditemukan.' }, 404);
}
