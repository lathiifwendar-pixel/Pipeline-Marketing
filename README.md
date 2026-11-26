# EasyGo Pipeline

Aplikasi monitoring pipeline aktivitas marketing (TMS Enterprise, TMS Lite, Kompetitor).
Halaman + login dihosting di Cloudflare Pages, data disimpan di Google Sheet lewat Apps Script.

```
public/        -> yang dipublikasikan Cloudflare (index.html, _worker.js, manifest, ikon)
apps-script/   -> Code.template.gs (isi token & ID Sheet sebelum dipakai) + appsscript.json
```

Rahasia (kata sandi, token) TIDAK disimpan di repo ini. Semuanya diisi di Cloudflare
(Settings > Variables and Secrets). Jangan pernah commit `Code.gs` yang sudah berisi token.

Panduan lengkap: lihat `Panduan_GitHub_Cloudflare.md` yang dikirim bersama repo ini.
