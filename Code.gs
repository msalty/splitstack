/**
 * ============================================================================
 *  SPLITSTACK  —  Google Apps Script backend
 * ============================================================================
 *  This script turns YOUR Google Spreadsheet into a private API for the
 *  SplitStack expense-sharing PWA. You own the data; nothing leaves your
 *  Google account.
 *
 *  SETUP (see SETUP.md for the illustrated version)
 *   1. Create a new Google Sheet.
 *   2. Extensions ▸ Apps Script. Delete the sample code, paste this file.
 *   3. Run ▸ setup()  (authorise when prompted). Copy the SETUP KEY it prints.
 *   4. Deploy ▸ New deployment ▸ Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Copy the /exec URL.
 *   5. Open the PWA, paste the URL + setup key, create your admin account.
 * ============================================================================
 */

/* ---------------------------------------------------------------- constants */

var TAB_USERS    = 'Users';
var TAB_LEDGERS  = 'Ledgers';
var TAB_MEMBERS  = 'Members';
var TAB_CONFIG   = 'Config';

var USER_COLS   = ['UserId','Username','DisplayName','Email','Role','Salt','Iterations',
                   'Verifier','TokenVer','Avatar','Color','Emoji','Active','CreatedAt','UpdatedAt'];
var LEDGER_COLS = ['LedgerId','Name','SheetName','Emoji','Color','InviteToken','Archived',
                   'CreatedBy','CreatedAt','UpdatedAt'];
var MEMBER_COLS = ['LedgerId','UserId','JoinedAt'];
var TXN_COLS    = ['TxnId','Type','Date','Name','Category','Amount','PaidBy','PaidTo',
                   'EnteredBy','SplitPct','Notes','ReceiptId','Deleted','CreatedAt','UpdatedAt','Rev'];

var PBKDF2_ITERATIONS = 210000;
var SESSION_DAYS      = 60;
var API_VERSION       = 1;

/* ------------------------------------------------------------- entry points */

function doGet(e) {
  return json({ ok: true, service: 'splitstack', version: API_VERSION, ready: isReady() });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'BAD_JSON' });
  }
  try {
    return json({ ok: true, data: route(req) });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function route(req) {
  var action = req.action;
  var p      = req.payload || {};

  // --- unauthenticated -----------------------------------------------------
  switch (action) {
    case 'ping':        return { version: API_VERSION, ready: isReady(), appName: cfg('appName', 'SplitStack'),
                                 currency: cfg('currency', 'USD'), iterations: PBKDF2_ITERATIONS };
    case 'claimAdmin':  return claimAdmin(p);
    case 'authSalt':    return authSalt(p);
    case 'login':       return login(p);
    case 'inviteInfo':  return inviteInfo(p);
    case 'claimSeat':   return claimSeat(p);
  }

  // --- authenticated -------------------------------------------------------
  var me = requireAuth(req.token);

  switch (action) {
    case 'bootstrap':      return bootstrap(me);
    case 'pull':           return pull(me, p);
    case 'push':           return push(me, p);
    case 'joinLedger':     return joinLedger(me, p);
    case 'setAvatar':      return setAvatar(me, p);
    case 'changePassword': return changePassword(me, p);
    case 'putReceipt':     return putReceipt(me, p);
    case 'getReceipt':     return getReceipt(me, p);

    /* ---- admin only ---- */
    case 'adminUsers':       return requireAdmin(me), listUsers();
    case 'adminSaveUser':    return requireAdmin(me), saveUser(me, p);
    case 'adminDeleteUser':  return requireAdmin(me), deleteUser(me, p);
    case 'adminSetPassword': return requireAdmin(me), adminSetPassword(p);
    case 'adminSaveLedger':  return requireAdmin(me), saveLedger(me, p);
    case 'adminDeleteLedger':return requireAdmin(me), deleteLedger(p);
    case 'adminSetMembers':  return requireAdmin(me), setMembers(p);
    case 'adminRotateInvite':return requireAdmin(me), rotateInvite(p);
    case 'adminSetConfig':   return requireAdmin(me), setConfig(p);
  }
  throw new Error('UNKNOWN_ACTION:' + action);
}

/* ------------------------------------------------------------------ storage */

function ss() {
  if (!ss._c) ss._c = SpreadsheetApp.getActiveSpreadsheet();
  return ss._c;
}

function tab(name, cols) {
  var s = ss().getSheetByName(name);
  if (!s) {
    s = ss().insertSheet(name);
    if (cols) {
      s.getRange(1, 1, 1, cols.length).setValues([cols]);
      s.setFrozenRows(1);
      s.getRange(1, 1, 1, cols.length)
        .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
    }
  }
  return s;
}

/** Read a tab as an array of objects (row index preserved as __row). */
function readTab(name, cols) {
  var s = tab(name, cols);
  var lastRow = s.getLastRow();
  if (lastRow < 2) return [];
  var head = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  var vals = s.getRange(2, 1, lastRow - 1, s.getLastColumn()).getValues();
  return vals.map(function (r, i) {
    var o = { __row: i + 2 };
    for (var c = 0; c < head.length; c++) if (head[c]) o[head[c]] = r[c];
    return o;
  });
}

/* Header lookups are cached per execution — they never change mid-request. */
var _hdr = {};
function headerIndex(sheet) {
  var name = sheet.getName();
  if (_hdr[name]) return _hdr[name];
  var head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var m = { __width: head.length };
  head.forEach(function (h, i) { if (h) m[h] = i + 1; });
  return (_hdr[name] = m);
}

function appendRow(name, cols, obj) {
  var s = tab(name, cols);
  var idx = headerIndex(s);
  var row = new Array(idx.__width).fill('');
  Object.keys(obj).forEach(function (k) { if (idx[k]) row[idx[k] - 1] = obj[k]; });
  s.getRange(s.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

/** One read + one write per row, instead of one API call per field. */
function updateRow(name, cols, rowNum, obj) {
  var s = tab(name, cols);
  var idx = headerIndex(s);
  var rng = s.getRange(rowNum, 1, 1, idx.__width);
  var row = rng.getValues()[0];
  Object.keys(obj).forEach(function (k) { if (idx[k]) row[idx[k] - 1] = obj[k]; });
  rng.setValues([row]);
}

/** Bulk upsert for sync batches: one setValues for all appends. */
function appendRows(name, cols, objs) {
  if (!objs.length) return;
  var s = tab(name, cols);
  var idx = headerIndex(s);
  var rows = objs.map(function (obj) {
    var row = new Array(idx.__width).fill('');
    Object.keys(obj).forEach(function (k) { if (idx[k]) row[idx[k] - 1] = obj[k]; });
    return row;
  });
  s.getRange(s.getLastRow() + 1, 1, rows.length, idx.__width).setValues(rows);
}

/**
 * Strictly increasing revision numbers, the backbone of delta sync.
 * Date.now() alone is not enough: two writes inside the same millisecond would
 * share a revision, and a client sitting on that cursor would never be told
 * about the second one. This counter can never hand out the same value twice.
 */
function nextRev(count) {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('LAST_REV') || 0);
  var base = Math.max(Date.now(), last + 1);
  props.setProperty('LAST_REV', String(base + Math.max(1, count) - 1));
  return base;
}

/** Make sure a sheet has every column we expect, adding any that are missing. */
function ensureColumns(sheet, cols) {
  var width = Math.max(1, sheet.getLastColumn());
  var head = sheet.getRange(1, 1, 1, width).getValues()[0];
  var missing = cols.filter(function (c) { return head.indexOf(c) === -1; });
  if (!missing.length) return;
  sheet.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
  delete _hdr[sheet.getName()];
}

function lock(fn) {
  var l = LockService.getScriptLock();
  l.waitLock(25000);
  try { return fn(); } finally { l.releaseLock(); }
}

/* ------------------------------------------------------------------- config */

var _cfg = null;
function cfgAll() {
  if (_cfg) return _cfg;
  _cfg = {};
  readTab(TAB_CONFIG, ['Key', 'Value']).forEach(function (r) { if (r.Key) _cfg[r.Key] = r.Value; });
  return _cfg;
}
function cfg(key, dflt) {
  var v = cfgAll()[key];
  return (v === undefined || v === '') ? dflt : v;
}

function setCfg(key, value) {
  var s = tab(TAB_CONFIG, ['Key', 'Value']);
  var rows = readTab(TAB_CONFIG, ['Key', 'Value']);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].Key === key) { s.getRange(rows[i].__row, 2).setValue(value); _cfg = null; return; }
  }
  s.appendRow([key, value]);
  _cfg = null;
}

function setConfig(p) {
  ['appName', 'currency', 'currencySymbol'].forEach(function (k) {
    if (p[k] !== undefined) setCfg(k, p[k]);
  });
  return { ok: true };
}

var _pepper = null;
function pepper() {
  if (_pepper) return _pepper;
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty('PEPPER');
  if (!v) { v = randomHex(32); props.setProperty('PEPPER', v); }
  return (_pepper = v);
}

function isReady() {
  var users = readTab(TAB_USERS, USER_COLS);
  return users.some(function (u) { return u.Role === 'admin' && u.Verifier; });
}

/* -------------------------------------------------------------------- setup */

/** Run this once from the Apps Script editor. */
function setup() {
  tab(TAB_USERS,   USER_COLS);
  tab(TAB_LEDGERS, LEDGER_COLS);
  tab(TAB_MEMBERS, MEMBER_COLS);
  tab(TAB_CONFIG,  ['Key', 'Value']);

  if (!cfg('currency'))       setCfg('currency', 'USD');
  if (!cfg('currencySymbol')) setCfg('currencySymbol', '$');
  if (!cfg('appName'))        setCfg('appName', 'SplitStack');

  var key = cfg('setupKey');
  if (!key) { key = randomHex(6).toUpperCase(); setCfg('setupKey', key); }
  pepper();

  var msg = '\n=================================================\n' +
            '  SplitStack is ready.\n' +
            '  SETUP KEY:  ' + key + '\n' +
            '  Use it once in the app to create your admin account.\n' +
            '=================================================\n';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('SplitStack setup complete', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return key;
}

/** Convenience: re-print the setup key. */
function showSetupKey() { Logger.log(cfg('setupKey')); return cfg('setupKey'); }

/** Nuke the admin verifier so a new admin account can be claimed. */
function resetAdminClaim() {
  var users = readTab(TAB_USERS, USER_COLS);
  users.forEach(function (u) {
    if (u.Role === 'admin') updateRow(TAB_USERS, USER_COLS, u.__row, { Verifier: '', TokenVer: (Number(u.TokenVer) || 0) + 1 });
  });
  setCfg('setupKey', randomHex(6).toUpperCase());
  Logger.log('New setup key: ' + cfg('setupKey'));
}

/* --------------------------------------------------------------------- auth */

function randomHex(bytes) {
  var out = '';
  for (var i = 0; i < bytes; i++) out += ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2);
  return out;
}

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + randomHex(5);
}

function hmac(keyStr, msgStr) {
  var sig = Utilities.computeHmacSha256Signature(msgStr, keyStr);
  return Utilities.base64Encode(sig);
}

/**
 * The browser does the expensive PBKDF2 and sends us the derived key (dk).
 * We never see the plaintext password. We store HMAC(pepper, dk) so that a
 * leaked spreadsheet still can't be replayed against the API.
 */
function verifierFor(dk) { return hmac(pepper(), 'v1:' + dk); }

function makeToken(user) {
  var exp     = Date.now() + SESSION_DAYS * 86400000;
  var payload = user.UserId + '|' + exp + '|' + (Number(user.TokenVer) || 0);
  return Utilities.base64EncodeWebSafe(payload) + '.' + hmac(pepper(), payload).replace(/=+$/, '');
}

function requireAuth(token) {
  if (!token) throw new Error('AUTH_REQUIRED');
  var parts = String(token).split('.');
  if (parts.length !== 2) throw new Error('AUTH_INVALID');
  var payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString(); }
  catch (e) { throw new Error('AUTH_INVALID'); }
  if (hmac(pepper(), payload).replace(/=+$/, '') !== parts[1]) throw new Error('AUTH_INVALID');

  var bits = payload.split('|');
  if (Number(bits[1]) < Date.now()) throw new Error('AUTH_EXPIRED');

  var u = findUser('UserId', bits[0]);
  if (!u || u.Active === false || u.Active === 'FALSE') throw new Error('AUTH_INVALID');
  if ((Number(u.TokenVer) || 0) !== Number(bits[2])) throw new Error('AUTH_STALE');
  return u;
}

function requireAdmin(me) {
  if (me.Role !== 'admin') throw new Error('FORBIDDEN');
  return true;
}

function findUser(field, value) {
  var users = readTab(TAB_USERS, USER_COLS);
  var v = String(value).toLowerCase();
  for (var i = 0; i < users.length; i++) {
    if (String(users[i][field]).toLowerCase() === v) return users[i];
  }
  return null;
}

/** Return the salt for a username. Unknown users get a stable fake salt. */
function authSalt(p) {
  var u = findUser('Username', p.username || '');
  if (u && u.Salt) return { salt: u.Salt, iterations: Number(u.Iterations) || PBKDF2_ITERATIONS, exists: true };
  // Deterministic decoy so attackers can't enumerate accounts.
  return {
    salt: hmac(pepper(), 'decoy:' + String(p.username || '').toLowerCase()).replace(/[^a-f0-9]/gi, '').slice(0, 32) || randomHex(16),
    iterations: PBKDF2_ITERATIONS,
    exists: false
  };
}

function login(p) {
  var u = findUser('Username', p.username || '');
  if (!u || !u.Verifier) { Utilities.sleep(400); throw new Error('BAD_CREDENTIALS'); }
  if (u.Active === false || u.Active === 'FALSE') throw new Error('ACCOUNT_DISABLED');
  if (verifierFor(p.dk) !== u.Verifier) { Utilities.sleep(400); throw new Error('BAD_CREDENTIALS'); }
  return { token: makeToken(u), me: publicUser(u), state: bootstrap(u) };
}

function claimAdmin(p) {
  return lock(function () {
    setup();
    if (isReady()) throw new Error('ADMIN_EXISTS');
    if (String(p.setupKey || '').toUpperCase().trim() !== String(cfg('setupKey')).toUpperCase().trim()) {
      Utilities.sleep(800);
      throw new Error('BAD_SETUP_KEY');
    }
    validateUsername(p.username);
    var now = new Date();
    var u = {
      UserId: uid('usr'), Username: String(p.username).toLowerCase().trim(),
      DisplayName: p.displayName || p.username, Email: p.email || '', Role: 'admin',
      Salt: p.salt, Iterations: PBKDF2_ITERATIONS, Verifier: verifierFor(p.dk), TokenVer: 1,
      Avatar: '', Color: pickColor(0), Emoji: '👑', Active: true, CreatedAt: now, UpdatedAt: now
    };
    appendRow(TAB_USERS, USER_COLS, u);
    setCfg('setupKey', randomHex(6).toUpperCase()); // burn the key
    var fresh = findUser('UserId', u.UserId);
    return { token: makeToken(fresh), me: publicUser(fresh), state: bootstrap(fresh) };
  });
}

function changePassword(me, p) {
  return lock(function () {
    if (verifierFor(p.oldDk) !== me.Verifier) throw new Error('BAD_CREDENTIALS');
    updateRow(TAB_USERS, USER_COLS, me.__row, {
      Salt: p.salt, Iterations: PBKDF2_ITERATIONS, Verifier: verifierFor(p.dk),
      TokenVer: (Number(me.TokenVer) || 0) + 1, UpdatedAt: new Date()
    });
    var fresh = findUser('UserId', me.UserId);
    return { token: makeToken(fresh) };
  });
}

function adminSetPassword(p) {
  return lock(function () {
    var u = findUser('UserId', p.userId);
    if (!u) throw new Error('NO_SUCH_USER');
    updateRow(TAB_USERS, USER_COLS, u.__row, {
      Salt: p.salt, Iterations: PBKDF2_ITERATIONS, Verifier: verifierFor(p.dk),
      TokenVer: (Number(u.TokenVer) || 0) + 1, UpdatedAt: new Date()
    });
    return { ok: true };
  });
}

function validateUsername(n) {
  if (!n || !/^[a-z0-9._-]{2,24}$/i.test(String(n).trim())) throw new Error('BAD_USERNAME');
}

/* -------------------------------------------------------------------- users */

function publicUser(u) {
  return {
    id: u.UserId, username: u.Username, name: u.DisplayName || u.Username,
    email: u.Email || '', role: u.Role || 'member', avatar: u.Avatar || '',
    color: u.Color || pickColor(0), emoji: u.Emoji || '', active: u.Active !== false && u.Active !== 'FALSE',
    hasPassword: !!u.Verifier
  };
}

var PALETTE = ['#6C5CE7','#00B894','#FF7675','#FDCB6E','#0984E3','#E84393','#00CEC9','#E17055','#A29BFE','#55EFC4'];
function pickColor(i) { return PALETTE[i % PALETTE.length]; }

function listUsers() {
  return { users: readTab(TAB_USERS, USER_COLS).map(publicUser) };
}

function saveUser(me, p) {
  return lock(function () {
    var now = new Date();
    if (p.id) {
      var u = findUser('UserId', p.id);
      if (!u) throw new Error('NO_SUCH_USER');
      var patch = { UpdatedAt: now };
      if (p.name  !== undefined) patch.DisplayName = p.name;
      if (p.email !== undefined) patch.Email = p.email;
      if (p.emoji !== undefined) patch.Emoji = p.emoji;
      if (p.color !== undefined) patch.Color = p.color;
      if (p.username !== undefined && String(p.username).toLowerCase() !== String(u.Username).toLowerCase()) {
        validateUsername(p.username);
        if (findUser('Username', p.username)) throw new Error('USERNAME_TAKEN');
        patch.Username = String(p.username).toLowerCase().trim();
      }
      if (p.active !== undefined) {
        // Never let the last active admin be disabled.
        if (!p.active && u.Role === 'admin' && activeAdminCount() <= 1) throw new Error('LAST_ADMIN');
        patch.Active = !!p.active;
        if (!p.active) patch.TokenVer = (Number(u.TokenVer) || 0) + 1;
      }
      if (p.role !== undefined && p.role !== u.Role) {
        if (u.Role === 'admin' && activeAdminCount() <= 1) throw new Error('LAST_ADMIN');
        patch.Role = p.role === 'admin' ? 'admin' : 'member';
      }
      updateRow(TAB_USERS, USER_COLS, u.__row, patch);
      return { user: publicUser(findUser('UserId', p.id)) };
    }

    validateUsername(p.username);
    if (findUser('Username', p.username)) throw new Error('USERNAME_TAKEN');
    var n = readTab(TAB_USERS, USER_COLS).length;
    var nu = {
      UserId: uid('usr'), Username: String(p.username).toLowerCase().trim(),
      DisplayName: p.name || p.username, Email: p.email || '',
      Role: p.role === 'admin' ? 'admin' : 'member',
      Salt: p.salt || '', Iterations: PBKDF2_ITERATIONS, Verifier: p.dk ? verifierFor(p.dk) : '',
      TokenVer: 1, Avatar: '', Color: p.color || pickColor(n), Emoji: p.emoji || '',
      Active: true, CreatedAt: now, UpdatedAt: now
    };
    appendRow(TAB_USERS, USER_COLS, nu);
    return { user: publicUser(findUser('UserId', nu.UserId)) };
  });
}

function activeAdminCount() {
  return readTab(TAB_USERS, USER_COLS).filter(function (u) {
    return u.Role === 'admin' && u.Active !== false && u.Active !== 'FALSE';
  }).length;
}

function deleteUser(me, p) {
  return lock(function () {
    var u = findUser('UserId', p.id);
    if (!u) throw new Error('NO_SUCH_USER');
    if (u.UserId === me.UserId) throw new Error('CANNOT_DELETE_SELF');
    if (u.Role === 'admin' && activeAdminCount() <= 1) throw new Error('LAST_ADMIN');
    tab(TAB_USERS, USER_COLS).deleteRow(u.__row);
    // drop memberships
    var s = tab(TAB_MEMBERS, MEMBER_COLS);
    readTab(TAB_MEMBERS, MEMBER_COLS)
      .filter(function (m) { return m.UserId === p.id; })
      .sort(function (a, b) { return b.__row - a.__row; })
      .forEach(function (m) { s.deleteRow(m.__row); });
    return { ok: true };
  });
}

function setAvatar(me, p) {
  return lock(function () {
    var targetId = p.userId && me.Role === 'admin' ? p.userId : me.UserId;
    var u = findUser('UserId', targetId);
    if (!u) throw new Error('NO_SUCH_USER');
    var data = String(p.avatar || '');
    if (data.length > 48000) throw new Error('AVATAR_TOO_BIG');
    updateRow(TAB_USERS, USER_COLS, u.__row, { Avatar: data, UpdatedAt: new Date() });
    return { ok: true, avatar: data };
  });
}

/* ------------------------------------------------------------------ ledgers */

function sheetNameFor(name) {
  var base = String(name).replace(/[\[\]\*\/\\\?:]/g, ' ').trim().slice(0, 80) || 'Ledger';
  var candidate = base, i = 2;
  while (ss().getSheetByName(candidate)) candidate = base.slice(0, 74) + ' (' + (i++) + ')';
  return candidate;
}

function ledgerById(id) {
  var all = readTab(TAB_LEDGERS, LEDGER_COLS);
  for (var i = 0; i < all.length; i++) if (all[i].LedgerId === id) return all[i];
  return null;
}

function publicLedger(l) {
  return {
    id: l.LedgerId, name: l.Name, emoji: l.Emoji || '💸', color: l.Color || PALETTE[0],
    invite: l.InviteToken, archived: l.Archived === true || l.Archived === 'TRUE',
    createdAt: l.CreatedAt ? new Date(l.CreatedAt).toISOString() : null
  };
}

function saveLedger(me, p) {
  return lock(function () {
    var now = new Date();
    if (p.id) {
      var l = ledgerById(p.id);
      if (!l) throw new Error('NO_SUCH_LEDGER');
      var patch = { UpdatedAt: now };
      if (p.name && p.name !== l.Name) {
        var sh = ss().getSheetByName(l.SheetName);
        var newName = sheetNameFor(p.name);
        if (sh) sh.setName(newName);
        patch.Name = p.name; patch.SheetName = newName;
      }
      if (p.emoji !== undefined) patch.Emoji = p.emoji;
      if (p.color !== undefined) patch.Color = p.color;
      if (p.archived !== undefined) patch.Archived = !!p.archived;
      updateRow(TAB_LEDGERS, LEDGER_COLS, l.__row, patch);
      if (p.memberIds) setMembers({ ledgerId: p.id, userIds: p.memberIds });
      return { ledger: publicLedger(ledgerById(p.id)) };
    }

    var name = String(p.name || '').trim();
    if (!name) throw new Error('NAME_REQUIRED');
    var sheetName = sheetNameFor(name);
    var s = ss().insertSheet(sheetName);
    s.getRange(1, 1, 1, TXN_COLS.length).setValues([TXN_COLS]);
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, TXN_COLS.length).setFontWeight('bold')
      .setBackground(p.color || PALETTE[0]).setFontColor('#ffffff');
    s.setColumnWidth(1, 160); s.setColumnWidth(4, 220); s.setColumnWidth(11, 260);

    var l = {
      LedgerId: uid('ldg'), Name: name, SheetName: sheetName,
      Emoji: p.emoji || '💸', Color: p.color || PALETTE[0],
      InviteToken: randomHex(12), Archived: false,
      CreatedBy: me.UserId, CreatedAt: now, UpdatedAt: now
    };
    appendRow(TAB_LEDGERS, LEDGER_COLS, l);

    var ids = (p.memberIds && p.memberIds.length) ? p.memberIds : [me.UserId];
    if (ids.indexOf(me.UserId) === -1) ids.push(me.UserId);
    setMembers({ ledgerId: l.LedgerId, userIds: ids });
    return { ledger: publicLedger(ledgerById(l.LedgerId)) };
  });
}

function deleteLedger(p) {
  return lock(function () {
    var l = ledgerById(p.id);
    if (!l) throw new Error('NO_SUCH_LEDGER');
    var sh = ss().getSheetByName(l.SheetName);
    if (sh) {
      if (p.keepSheet) sh.setName('archived — ' + l.SheetName);
      else ss().deleteSheet(sh);
    }
    tab(TAB_LEDGERS, LEDGER_COLS).deleteRow(l.__row);
    var ms = tab(TAB_MEMBERS, MEMBER_COLS);
    readTab(TAB_MEMBERS, MEMBER_COLS)
      .filter(function (m) { return m.LedgerId === p.id; })
      .sort(function (a, b) { return b.__row - a.__row; })
      .forEach(function (m) { ms.deleteRow(m.__row); });
    return { ok: true };
  });
}

function setMembers(p) {
  return lock(function () {
    var want = p.userIds || [];
    var s = tab(TAB_MEMBERS, MEMBER_COLS);
    var cur = readTab(TAB_MEMBERS, MEMBER_COLS).filter(function (m) { return m.LedgerId === p.ledgerId; });
    var have = cur.map(function (m) { return m.UserId; });

    cur.filter(function (m) { return want.indexOf(m.UserId) === -1; })
       .sort(function (a, b) { return b.__row - a.__row; })
       .forEach(function (m) { s.deleteRow(m.__row); });

    want.filter(function (id) { return have.indexOf(id) === -1; })
        .forEach(function (id) { appendRow(TAB_MEMBERS, MEMBER_COLS, { LedgerId: p.ledgerId, UserId: id, JoinedAt: new Date() }); });

    return { ok: true };
  });
}

function rotateInvite(p) {
  return lock(function () {
    var l = ledgerById(p.id);
    if (!l) throw new Error('NO_SUCH_LEDGER');
    var t = randomHex(12);
    updateRow(TAB_LEDGERS, LEDGER_COLS, l.__row, { InviteToken: t, UpdatedAt: new Date() });
    return { invite: t };
  });
}

function ledgerByInvite(token) {
  var all = readTab(TAB_LEDGERS, LEDGER_COLS);
  for (var i = 0; i < all.length; i++) if (all[i].InviteToken && all[i].InviteToken === token) return all[i];
  return null;
}

/** Public preview of an invite: enough to render a nice landing screen. */
function inviteInfo(p) {
  var l = ledgerByInvite(p.invite);
  if (!l) throw new Error('BAD_INVITE');
  var memberIds = readTab(TAB_MEMBERS, MEMBER_COLS)
    .filter(function (m) { return m.LedgerId === l.LedgerId; })
    .map(function (m) { return m.UserId; });
  var users = readTab(TAB_USERS, USER_COLS);
  return {
    ledger: { name: l.Name, emoji: l.Emoji || '💸', color: l.Color || PALETTE[0] },
    members: users.filter(function (u) { return memberIds.indexOf(u.UserId) !== -1; })
                  .map(function (u) { return { id: u.UserId, name: u.DisplayName || u.Username,
                                               avatar: u.Avatar || '', color: u.Color, emoji: u.Emoji,
                                               claimable: !u.Verifier }; })
  };
}

/** A seat the admin created without a password can be claimed by the invitee. */
function claimSeat(p) {
  return lock(function () {
    var l = ledgerByInvite(p.invite);
    if (!l) throw new Error('BAD_INVITE');
    var u = findUser('UserId', p.userId);
    if (!u) throw new Error('NO_SUCH_USER');
    if (u.Verifier) throw new Error('SEAT_TAKEN');
    var isMember = readTab(TAB_MEMBERS, MEMBER_COLS).some(function (m) {
      return m.LedgerId === l.LedgerId && m.UserId === u.UserId;
    });
    if (!isMember) throw new Error('NOT_A_MEMBER');
    updateRow(TAB_USERS, USER_COLS, u.__row, {
      Salt: p.salt, Iterations: PBKDF2_ITERATIONS, Verifier: verifierFor(p.dk),
      TokenVer: (Number(u.TokenVer) || 0) + 1, UpdatedAt: new Date()
    });
    var fresh = findUser('UserId', u.UserId);
    return { token: makeToken(fresh), me: publicUser(fresh), state: bootstrap(fresh) };
  });
}

/** An existing logged-in user redeems an invite link. */
function joinLedger(me, p) {
  return lock(function () {
    var l = ledgerByInvite(p.invite);
    if (!l) throw new Error('BAD_INVITE');
    var already = readTab(TAB_MEMBERS, MEMBER_COLS).some(function (m) {
      return m.LedgerId === l.LedgerId && m.UserId === me.UserId;
    });
    if (!already) appendRow(TAB_MEMBERS, MEMBER_COLS, { LedgerId: l.LedgerId, UserId: me.UserId, JoinedAt: new Date() });
    return { ledgerId: l.LedgerId, state: bootstrap(me) };
  });
}

/* ------------------------------------------------------------------- ledger */

function myLedgers(me) {
  var mem = readTab(TAB_MEMBERS, MEMBER_COLS);
  var all = readTab(TAB_LEDGERS, LEDGER_COLS);
  if (me.Role === 'admin') return all;
  var mine = mem.filter(function (m) { return m.UserId === me.UserId; }).map(function (m) { return m.LedgerId; });
  return all.filter(function (l) { return mine.indexOf(l.LedgerId) !== -1; });
}

function bootstrap(me) {
  var users   = readTab(TAB_USERS, USER_COLS);
  var ledgers = myLedgers(me);
  var ids     = ledgers.map(function (l) { return l.LedgerId; });
  var members = readTab(TAB_MEMBERS, MEMBER_COLS).filter(function (m) { return ids.indexOf(m.LedgerId) !== -1; });

  // Members only see users they actually share a ledger with (+ themselves).
  var visible;
  if (me.Role === 'admin') visible = users;
  else {
    var set = {}; set[me.UserId] = 1;
    members.forEach(function (m) { set[m.UserId] = 1; });
    visible = users.filter(function (u) { return set[u.UserId]; });
  }

  return {
    me:       publicUser(me),
    users:    visible.map(publicUser),
    ledgers:  ledgers.map(publicLedger),
    members:  members.map(function (m) { return { ledgerId: m.LedgerId, userId: m.UserId }; }),
    config:   { currency: cfg('currency', 'USD'), symbol: cfg('currencySymbol', '$'), appName: cfg('appName', 'SplitStack') },
    serverTime: new Date().toISOString()
  };
}

function assertMember(me, ledgerId) {
  var l = ledgerById(ledgerId);
  if (!l) throw new Error('NO_SUCH_LEDGER');
  if (me.Role === 'admin') return l;
  var ok = readTab(TAB_MEMBERS, MEMBER_COLS).some(function (m) {
    return m.LedgerId === ledgerId && m.UserId === me.UserId;
  });
  if (!ok) throw new Error('FORBIDDEN');
  return l;
}

function txnSheet(ledger) {
  var s = ss().getSheetByName(ledger.SheetName);
  if (!s) {
    s = ss().insertSheet(ledger.SheetName);
    s.getRange(1, 1, 1, TXN_COLS.length).setValues([TXN_COLS]);
    s.setFrozenRows(1);
  } else {
    ensureColumns(s, TXN_COLS);
  }
  return s;
}

function rowToTxn(r) {
  var split = {};
  try { split = r.SplitPct ? JSON.parse(r.SplitPct) : {}; } catch (e) { split = {}; }
  return {
    id: r.TxnId,
    type: r.Type || 'expense',
    date: r.Date ? new Date(r.Date).toISOString().slice(0, 10) : '',
    name: r.Name || '',
    category: r.Category || '',
    amount: Number(r.Amount) || 0,
    paidBy: r.PaidBy || '',
    paidTo: r.PaidTo || '',
    enteredBy: r.EnteredBy || '',
    split: split,
    notes: r.Notes || '',
    receiptId: r.ReceiptId || '',
    deleted: r.Deleted === true || r.Deleted === 'TRUE',
    createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : null,
    // Rev is authoritative. UpdatedAt is only a fallback for hand-typed rows.
    updatedAt: Number(r.Rev) || (r.UpdatedAt ? new Date(r.UpdatedAt).getTime() : 0)
  };
}

/** Delta pull: only rows changed since `since` (epoch ms). */
function pull(me, p) {
  var out = {}, ledgers;
  if (p.ledgerId) ledgers = [assertMember(me, p.ledgerId)];
  else ledgers = myLedgers(me);

  ledgers.forEach(function (l) {
    var since = Number((p.since || {})[l.LedgerId] || 0);
    var rows  = readTab(l.SheetName, TXN_COLS);
    var max   = since;
    var txns  = [];
    rows.forEach(function (r) {
      if (!r.TxnId) return;
      var t = rowToTxn(r);
      if (t.updatedAt > max) max = t.updatedAt;
      if (t.updatedAt > since) txns.push(t);
    });
    out[l.LedgerId] = { txns: txns, cursor: max, full: since === 0 };
  });
  return { ledgers: out, serverTime: Date.now() };
}

/**
 * Idempotent upsert. The client generates TxnIds, so replaying a queued
 * offline batch can never create duplicates.
 */
function push(me, p) {
  return lock(function () {
    var l = assertMember(me, p.ledgerId);
    txnSheet(l);
    var existing = {};
    readTab(l.SheetName, TXN_COLS).forEach(function (r) { if (r.TxnId) existing[r.TxnId] = r; });

    var incoming = p.txns || [];
    var applied = [], toAppend = [], now = new Date();
    var revBase = nextRev(incoming.length || 1);
    incoming.forEach(function (t) {
      validateTxn(t);
      var prior = existing[t.id];
      var stamp = revBase + applied.length; // strictly increasing, never reused
      var vals = {
        TxnId: t.id,
        Type: t.type || 'expense',
        Date: t.date || '',
        Name: t.name || '',
        Category: t.category || '',
        Amount: Number(t.amount) || 0,
        PaidBy: t.paidBy || '',
        PaidTo: t.paidTo || '',
        EnteredBy: t.enteredBy || me.UserId,
        SplitPct: JSON.stringify(t.split || {}),
        Notes: t.notes || '',
        ReceiptId: t.receiptId || '',
        Deleted: !!t.deleted,
        CreatedAt: prior ? prior.CreatedAt : new Date(t.createdAt || now),
        UpdatedAt: new Date(),
        Rev: stamp
      };
      if (prior) updateRow(l.SheetName, TXN_COLS, prior.__row, vals);
      else       toAppend.push(vals);
      applied.push(t.id);
    });
    appendRows(l.SheetName, TXN_COLS, toAppend);
    SpreadsheetApp.flush();

    // Return the merged truth so the client can reconcile immediately.
    var since = Number(p.since || 0);
    var txns = [];
    var max = since;
    readTab(l.SheetName, TXN_COLS).forEach(function (r) {
      if (!r.TxnId) return;
      var x = rowToTxn(r);
      if (x.updatedAt > max) max = x.updatedAt;
      if (x.updatedAt > since) txns.push(x);
    });
    return { applied: applied, txns: txns, cursor: max };
  });
}

function validateTxn(t) {
  if (!t.id) throw new Error('TXN_ID_REQUIRED');
  if (!(Number(t.amount) >= 0)) throw new Error('BAD_AMOUNT');
  if (Number(t.amount) > 100000000) throw new Error('AMOUNT_TOO_LARGE');
  if (t.type === 'settlement') {
    if (!t.paidBy || !t.paidTo) throw new Error('SETTLEMENT_NEEDS_BOTH_PARTIES');
    if (t.paidBy === t.paidTo) throw new Error('SETTLEMENT_SAME_PERSON');
    return;
  }
  if (!t.deleted) {
    var sum = 0, n = 0;
    Object.keys(t.split || {}).forEach(function (k) { sum += Number(t.split[k]) || 0; n++; });
    if (!n) throw new Error('SPLIT_REQUIRED');
    if (Math.abs(sum - 100) > 0.05) throw new Error('SPLIT_MUST_TOTAL_100');
  }
}

/* ----------------------------------------------------------------- receipts */

function receiptFolder() {
  var id = cfg('receiptFolderId');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var name = 'SplitStack Receipts — ' + ss().getName();
  var it = DriveApp.getFoldersByName(name);
  var f = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  setCfg('receiptFolderId', f.getId());
  return f;
}

function putReceipt(me, p) {
  assertMember(me, p.ledgerId);
  var m = /^data:(image\/[a-z+.-]+);base64,(.*)$/i.exec(String(p.dataUrl || ''));
  if (!m) throw new Error('BAD_IMAGE');
  var bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('IMAGE_TOO_BIG');
  var blob = Utilities.newBlob(bytes, m[1], (p.txnId || uid('rcp')) + '.' + m[1].split('/')[1]);
  var file = receiptFolder().createFile(blob);
  return { receiptId: file.getId() };
}

function getReceipt(me, p) {
  var f = DriveApp.getFileById(p.receiptId);
  var b = f.getBlob();
  return { dataUrl: 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()) };
}

/* -------------------------------------------------------------------- utils */

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
