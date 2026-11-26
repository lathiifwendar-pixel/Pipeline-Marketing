/**
 * EasyGo Pipeline - API Google Apps Script (untuk versi Cloudflare)
 * Skrip ini TIDAK menampilkan halaman. Ia hanya menjadi "API" yang dipanggil oleh Cloudflare
 * dan menyimpan data ke Google Sheet (tab Leads, Aktivitas, Pengguna).
 *
 * Setiap permintaan wajib membawa API_TOKEN yang sama dengan variabel API_TOKEN di Cloudflare.
 * Deploy sebagai Web app: Execute as = Me, Who has access = Anyone.
 */

var CONFIG = {
  // Kunci rahasia: harus SAMA PERSIS dengan variabel API_TOKEN di Cloudflare.
  API_TOKEN: '__API_TOKEN__',
  // true = isi data contoh saat pertama kali. Tidak berpengaruh jika data sudah pernah diisi.
  SEED_SAMPLE: true,
  // ID Google Sheet (bagian antara /d/ dan /edit pada alamat Sheet). Bukan seluruh link.
  SPREADSHEET_ID: '__SPREADSHEET_ID__'
};

var LEAD_COLS = ['id', 'company', 'produk', 'kompetitor', 'sector', 'pic', 'role', 'wa', 'units', 'value', 'source', 'enteredAt', 'stage', 'channel', 'lastDate', 'ts', 'by'];
var ACT_COLS = ['id', 'date', 'company', 'leadId', 'type', 'produk', 'stage', 'note', 'ts', 'by'];
var USER_COLS = ['user', 'name', 'role', 'updatedAt'];
var NUM_COLS = { units: 1, value: 1, ts: 1 };
var SHEETS = {
  leads: { name: 'Leads', cols: LEAD_COLS },
  activities: { name: 'Aktivitas', cols: ACT_COLS }
};
var USERS = { name: 'Pengguna', cols: USER_COLS };

var SEED = __SEED__;

/* ------------------------------------------------------------------ */
/* Pintu masuk                                                         */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, service: 'easygo-pipeline-api', note: 'API aktif. Halaman aplikasi ada di alamat Cloudflare Anda.' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: 'Isi permintaan rusak.' });
  }
  if (!CONFIG.API_TOKEN || CONFIG.API_TOKEN.indexOf('__') === 0 || !same_(String(req.token || ''), CONFIG.API_TOKEN)) {
    return json_({ ok: false, error: 'unauthorized', message: 'Kunci API tidak cocok.' });
  }
  var user = req.user || {};
  var args = req.args || [];
  try {
    var result;
    switch (req.fn) {
      case 'bootstrap': result = bootstrap(user); break;
      case 'getData': result = getData(); break;
      case 'saveRecord': result = saveRecord(args[0], args[1], user); break;
      case 'deleteRecords': result = deleteRecords(args[0], args[1]); break;
      case 'saveProfile': result = saveProfile(user, args[0]); break;
      default: return json_({ ok: false, error: 'unknown_fn', message: 'Fungsi tidak dikenal.' });
    }
    return json_({ ok: true, result: result });
  } catch (err) {
    return json_({ ok: false, error: 'server_error', message: String(err && err.message || err).slice(0, 300) });
  }
}

/** Jalankan SEKALI dari editor setelah menempel kode (memberi izin akses ke Sheet). */
function setup() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  PropertiesService.getScriptProperties().setProperty('SS_ID', ss.getId());
  ensure_(ss);
  seed_(ss);
  Logger.log('Siap. Spreadsheet: ' + ss.getUrl());
}

/* ------------------------------------------------------------------ */
/* Fungsi data                                                         */
/* ------------------------------------------------------------------ */

function bootstrap(user) {
  var ss = ss_();
  ensure_(ss);
  seed_(ss);
  var d = data_(ss);
  return { me: me_(ss, user), leads: d.leads, activities: d.activities, sheetUrl: ss.getUrl() };
}

function getData() {
  return data_(ss_());
}

function saveRecord(kind, rec, user) {
  var cfg = SHEETS[kind];
  if (!cfg) throw new Error('Jenis data tidak dikenal.');
  if (!rec || !rec.id) throw new Error('Data tidak punya id.');
  var row = cfg.cols.map(function (c) {
    var v = rec[c];
    if (NUM_COLS[c]) return Number(v) || 0;
    return v == null ? '' : String(v).slice(0, 2000);
  });
  withLock_(function () {
    var sh = ss_().getSheetByName(cfg.name);
    var n = sh.getLastRow();
    var ids = n > 1 ? sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    var i = ids.indexOf(String(rec.id));
    var target = i >= 0 ? i + 2 : Math.max(n, 1) + 1;
    sh.getRange(target, 1, 1, cfg.cols.length).setValues([row]);
  });
  return { ok: true };
}

function deleteRecords(kind, ids) {
  var cfg = SHEETS[kind];
  if (!cfg) throw new Error('Jenis data tidak dikenal.');
  var set = {};
  (ids || []).forEach(function (i) { set[String(i)] = 1; });
  withLock_(function () {
    var sh = ss_().getSheetByName(cfg.name);
    var n = sh.getLastRow();
    if (n < 2) return;
    var col = sh.getRange(2, 1, n - 1, 1).getValues();
    for (var r = col.length - 1; r >= 0; r--) {
      if (set[String(col[r][0])]) sh.deleteRow(r + 2);
    }
  });
  return { ok: true };
}

function saveProfile(user, p) {
  var uid = String((user && user.id) || '').slice(0, 60);
  if (!uid) throw new Error('Pengguna tidak dikenal.');
  var name = String((p && p.name) || '').trim().slice(0, 40);
  var role = String((p && p.role) || '').trim().slice(0, 40) || 'Account Manager';
  if (!name) throw new Error('Nama wajib diisi.');
  withLock_(function () {
    var sh = ss_().getSheetByName(USERS.name);
    var n = sh.getLastRow();
    var ids = n > 1 ? sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return String(r[0]).toLowerCase(); }) : [];
    var i = ids.indexOf(uid.toLowerCase());
    var row = [uid, name, role, new Date().toISOString()];
    var target = i >= 0 ? i + 2 : Math.max(n, 1) + 1;
    sh.getRange(target, 1, 1, USER_COLS.length).setValues([row]);
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Internal                                                            */
/* ------------------------------------------------------------------ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function same_(a, b) {
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function me_(ss, user) {
  var uid = String((user && user.id) || '').slice(0, 60);
  var fallbackName = String((user && user.name) || uid || 'Pengguna').slice(0, 40);
  var fallbackRole = String((user && user.role) || 'Account Manager').slice(0, 40);
  var sh = ss.getSheetByName(USERS.name);
  var n = sh.getLastRow();
  var rows = n > 1 ? sh.getRange(2, 1, n - 1, USER_COLS.length).getValues() : [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === uid.toLowerCase()) {
      return { email: uid, name: String(rows[i][1] || fallbackName), role: String(rows[i][2] || fallbackRole), first: false };
    }
  }
  withLock_(function () {
    var last = Math.max(sh.getLastRow(), 1);
    sh.getRange(last + 1, 1, 1, USER_COLS.length).setValues([[uid, fallbackName, fallbackRole, new Date().toISOString()]]);
  });
  return { email: uid, name: fallbackName, role: fallbackRole, first: false };
}

function ss_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SS_ID');
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) { props.setProperty('SS_ID', active.getId()); return active; }
  if (CONFIG.SPREADSHEET_ID) { props.setProperty('SS_ID', CONFIG.SPREADSHEET_ID); return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID); }
  throw new Error('Spreadsheet belum diatur. Jalankan fungsi setup() dari editor Apps Script.');
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function ensureSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#FFE9DC');
    sh.setFrozenRows(1);
    cols.forEach(function (c, i) {
      sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat(NUM_COLS[c] ? '0.##' : '@');
    });
    sh.getRange(1, 1, 1, cols.length).setNumberFormat('@');
  }
  return sh;
}

function ensure_(ss) {
  withLock_(function () {
    ensureSheet_(ss, SHEETS.leads.name, LEAD_COLS);
    ensureSheet_(ss, SHEETS.activities.name, ACT_COLS);
    var us = ensureSheet_(ss, USERS.name, USER_COLS);
    if (String(us.getRange(1, 1).getValue()) === 'email') us.getRange(1, 1).setValue('user');
  });
}

function seed_(ss) {
  if (!CONFIG.SEED_SAMPLE) return;
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SEEDED')) return;
  withLock_(function () {
    if (props.getProperty('SEEDED')) return;
    [['leads', SEED.leads], ['activities', SEED.activities]].forEach(function (pair) {
      var cfg = SHEETS[pair[0]];
      var sh = ss.getSheetByName(cfg.name);
      if (sh.getLastRow() > 1) return;
      var rows = pair[1].map(function (rec) {
        return cfg.cols.map(function (c) {
          var v = rec[c];
          if (NUM_COLS[c]) return Number(v) || 0;
          return v == null ? '' : String(v);
        });
      });
      if (rows.length) sh.getRange(2, 1, rows.length, cfg.cols.length).setValues(rows);
    });
    props.setProperty('SEEDED', '1');
  });
}

function norm_(c, v) {
  if (NUM_COLS[c]) return Number(v) || 0;
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

function readAll_(sh, cols) {
  var n = sh.getLastRow();
  if (n < 2) return [];
  var vals = sh.getRange(2, 1, n - 1, cols.length).getValues();
  var out = [];
  vals.forEach(function (r) {
    if (!r[0]) return;
    var o = {};
    cols.forEach(function (c, i) { o[c] = norm_(c, r[i]); });
    out.push(o);
  });
  return out;
}

function data_(ss) {
  return {
    leads: readAll_(ss.getSheetByName(SHEETS.leads.name), LEAD_COLS),
    activities: readAll_(ss.getSheetByName(SHEETS.activities.name), ACT_COLS)
  };
}

