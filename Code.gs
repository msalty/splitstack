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

var TAB_USERS     = 'Users';
var TAB_LEDGERS   = 'Ledgers';
var TAB_MEMBERS   = 'Members';
var TAB_CONFIG    = 'Config';
var TAB_RECURRING = 'Recurring';

var USER_COLS   = ['UserId','Username','DisplayName','Email','Role','Salt','Iterations',
                   'Verifier','TokenVer','Avatar','Color','Emoji','Active','Notify','Kind',
                   'PayType','PayHandle','CreatedAt','UpdatedAt'];
var LEDGER_COLS = ['LedgerId','Name','SheetName','Emoji','Color','InviteToken','Archived',
                   'Presets','DefaultSplit','CreatedBy','CreatedAt','UpdatedAt'];
var MEMBER_COLS = ['LedgerId','UserId','JoinedAt'];
var TXN_COLS    = ['TxnId','Type','Date','Name','Category','Amount','PaidBy','PaidTo',
                   'EnteredBy','SplitPct','Notes','ReceiptId','Deleted','CreatedAt','UpdatedAt','Rev',
                   'ReviewState','ReviewBy','ReviewNote','ReviewDone','ReviewWas'];
var RECUR_COLS  = ['RuleId','LedgerId','Name','Category','Amount','PaidBy','SplitPct','Notes',
                   'Freq','Every','Anchor','NextDate','LastRun','Active','Review',
                   'CreatedBy','CreatedAt','UpdatedAt'];

var PBKDF2_ITERATIONS = 210000;
var SESSION_DAYS      = 60;
var API_VERSION       = 7;

/* Recurring rules never run more than this many periods in one pass. A script
   whose trigger was off for a year should not wake up and post 365 rows. */
var RECUR_CATCHUP_MAX = 24;

/* Brute-force protection. Failures are counted per username in the script
   cache, so the window expires on its own and nothing accumulates forever. */
var LOCK_AFTER      = 8;    // wrong passwords before that username is frozen
var LOCK_WINDOW_SEC = 900;  // …for this long (15 minutes)
var SPRAY_AFTER     = 100;  // total failures across all accounts before everyone slows down

/* ------------------------------------------------------------- entry points */

/**
 * Opening the /exec URL in a browser is the natural way to check "did my
 * deployment work?", so answer that question in plain English instead of
 * raw JSON.
 *
 * Deliberately does NOT print the setup key. This page is reachable by anyone
 * who has the URL, and before an admin is claimed the key is the only thing
 * standing between them and squatting the instance. The key lives behind the
 * spreadsheet menu, which requires access to the sheet itself.
 */
function doGet(e) {
  var ready = isReady();
  var home  = cfg('appHomeUrl', '');
  var link  = home ? home + '#/connect/' + deploymentId() : '';

  var html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>SplitStack backend</title><style>' +
    'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#EFEBFF;' +
    'font-family:ui-rounded,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1B1435;padding:24px}' +
    '.c{background:#fff;border-radius:26px;padding:30px;max-width:460px;width:100%;' +
    'box-shadow:0 20px 50px -20px rgba(46,25,110,.4);text-align:center}' +
    'h1{margin:14px 0 6px;font-size:25px}p{color:#4A4368;line-height:1.55;font-size:15px}' +
    '.e{font-size:52px}.ok{color:#00B894;font-weight:800}.warn{color:#F79F1F;font-weight:800}' +
    'a.btn{display:block;margin-top:18px;background:#6C5CE7;color:#fff;text-decoration:none;' +
    'padding:15px;border-radius:16px;font-weight:800}' +
    'code{background:#F6F4FF;padding:3px 7px;border-radius:7px;font-size:12.5px;word-break:break-all}' +
    '.s{margin-top:20px;padding-top:18px;border-top:1px solid #EAE6F8;font-size:13.5px;color:#8A84A6}' +
    '</style></head><body><div class="c">' +
    '<div class="e">' + (ready ? '✅' : '🔌') + '</div>' +
    '<h1>Backend is live</h1>' +
    (ready
      ? '<p>This SplitStack instance is <span class="ok">set up and running</span>.</p>'
      : '<p><span class="warn">No admin account yet.</span> Open your spreadsheet and choose ' +
        '<b>SplitStack ▸ Show setup key</b>, then use it in the app.</p>') +
    (link
      ? '<a class="btn" href="' + escapeHtml(link) + '">Open the app →</a>' +
        '<div class="s">Share that link with anyone who needs to connect a new device.</div>'
      : '<div class="s">Once you have opened the app once and signed in as admin, ' +
        'this page will show a one-tap link you can share.<br><br>' +
        'Your backend URL is:<br><code>' + escapeHtml(deploymentUrl()) + '</code></div>') +
    '</div></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('SplitStack')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The live web-app URL, as the script sees itself. */
function deploymentUrl() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/**
 * The bit of the URL worth putting in a link. Every deployment looks like
 * https://script.google.com/macros/s/<ID>/exec, so the ID alone rebuilds it.
 * Anything unusual (Workspace domain deployments) falls back to the full URL.
 */
function deploymentId() {
  var url = deploymentUrl();
  var m = /^https:\/\/script\.google\.com\/macros\/s\/([A-Za-z0-9_\-]+)\/exec$/.exec(url);
  if (m) return m[1];
  return url ? 'u.' + Utilities.base64EncodeWebSafe(url).replace(/=+$/, '') : '';
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

  // 'ping' is the only thing reachable without the gate — the client needs it
  // to discover whether a gate is even configured. It reveals nothing useful.
  if (action === 'ping') {
    return {
      version: API_VERSION, ready: isReady(), gated: gateEnabled(),
      appName: cfg('appName', 'SplitStack'), currency: cfg('currency', 'USD'),
      iterations: PBKDF2_ITERATIONS
    };
  }

  requireGate(req);
  ensureSchema();

  // --- unauthenticated -----------------------------------------------------
  switch (action) {
    case 'claimAdmin':  return claimAdmin(p);
    case 'authSalt':    return authSalt(p);
    case 'login':       return login(p);
    case 'inviteInfo':  return inviteInfo(p);
    case 'claimSeat':   return claimSeat(p);
  }

  // --- authenticated -------------------------------------------------------
  var me = requireAuth(req.token);

  switch (action) {
    case 'bootstrap':      return noteHome(me, p), bootstrap(me);
    case 'pull':           return pull(me, p);
    case 'push':           return push(me, p);
    case 'reviewTxn':      return reviewTxn(me, p);
    case 'joinLedger':     return joinLedger(me, p);
    case 'setAvatar':      return setAvatar(me, p);
    case 'changePassword': return changePassword(me, p);
    case 'signOutEverywhere': return signOutEverywhere(me);
    case 'putReceipt':     return putReceipt(me, p);
    case 'getReceipt':     return getReceipt(me, p);
    case 'setProfile':     return setProfile(me, p);
    case 'setPresets':     return setPresets(me, p);
    case 'recurringSave':  return recurringSave(me, p);
    case 'recurringDelete':return recurringDelete(me, p);
    case 'nudge':          return nudge(me, p);

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
    case 'adminSetGate':     return requireAdmin(me), setGate(me, p);
    case 'adminUnlock':      return requireAdmin(me), adminUnlock(p);
    case 'adminTestDigest':  return requireAdmin(me), testDigest(me);
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

/**
 * The columns this version needs, added to a spreadsheet built by an older one.
 *
 * Upgrading is a copy-paste of Code.gs, and expecting people to also remember
 * to run setup() is how a feature ends up silently doing nothing: writes to a
 * column that doesn't exist are dropped without complaint, because rows are
 * addressed by header name. So the check runs itself, guarded by a stamp in
 * Script Properties — one cheap property read per request, and the actual
 * migration exactly once ever.
 */
var SCHEMA_VERSION = '7';

function ensureSchema() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA') === SCHEMA_VERSION) return;
  ensureColumns(tab(TAB_USERS,     USER_COLS),  USER_COLS);
  ensureColumns(tab(TAB_LEDGERS,   LEDGER_COLS), LEDGER_COLS);
  ensureColumns(tab(TAB_MEMBERS,   MEMBER_COLS), MEMBER_COLS);
  ensureColumns(tab(TAB_RECURRING, RECUR_COLS),  RECUR_COLS);
  props.setProperty('SCHEMA', SCHEMA_VERSION);
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

var DIGEST_MODES = ['off', 'daily', 'weekly'];

function setConfig(p) {
  ['appName', 'currency', 'currencySymbol'].forEach(function (k) {
    if (p[k] !== undefined) setCfg(k, p[k]);
  });
  if (p.digest !== undefined) {
    if (DIGEST_MODES.indexOf(p.digest) === -1) throw new Error('BAD_DIGEST_MODE');
    setCfg('digest', p.digest);
  }
  if (p.categories !== undefined) setCfg('categories', encodeCategories(p.categories));
  return { ok: true };
}

/**
 * The expense categories this instance offers. Blank means "use the built-in
 * list", which is what every instance did before this was configurable — the
 * defaults live in the client, so an empty setting keeps them there rather
 * than freezing today's list into the spreadsheet.
 *
 * Category names are stored on transactions as plain strings, so removing one
 * never rewrites history: old rows keep the name and fall back to a generic
 * icon.
 */
var CATEGORY_MAX = 40;

function encodeCategories(list) {
  if (!list || !list.length) return '';
  var seen = {};
  var out = [];
  list.slice(0, CATEGORY_MAX).forEach(function (c) {
    var emoji = String((c && c.emoji) || '').trim().slice(0, 4);
    var name  = String((c && c.name)  || '').trim().slice(0, 24);
    if (!name) return;
    var key = name.toLowerCase();
    if (seen[key]) return;                       // two chips with one name is a trap
    seen[key] = 1;
    out.push({ emoji: emoji || '🧾', name: name });
  });
  if (!out.length) throw new Error('CATEGORIES_REQUIRED');
  return JSON.stringify(out);
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

/* ══════════════════════════════════════════════ spreadsheet menu (onOpen) */
/**
 * Puts a SplitStack menu in the spreadsheet's own menu bar, so routine admin
 * never requires the Apps Script editor. Appears after you reload the sheet.
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('SplitStack')
      .addItem('🔗  Show app links', 'menuLinks')
      .addItem('🔑  Show setup key', 'menuKey')
      .addSeparator()
      .addItem('🛠  Run setup / repair', 'menuSetup')
      .addItem('⏰  Check background jobs', 'menuJobs')
      .addItem('🔓  Unlock a locked account', 'menuUnlock')
      .addItem('♻️  Reset the admin account', 'menuResetAdmin')
      .addToUi();
  } catch (e) {}
}

function menuSetup() {
  setup(true);
  ui().alert('SplitStack',
    'Tabs checked and repaired. Everything is in place.\n\n' +
    'Background jobs: ' + (jobsInstalled()
      ? 'on — repeating expenses post daily and email summaries go out in the morning.'
      : "NOT running. Open Extensions ▸ Apps Script, run setup() once and accept the permission " +
        'prompt. Everything else works without them.'),
    ui().ButtonSet.OK);
}

function ui() { return SpreadsheetApp.getUi(); }

function menuKey() {
  if (isReady()) {
    ui().alert('Already set up',
      'This instance already has an admin account, so the setup key is spent.\n\n' +
      'If you need to start the admin account over, use SplitStack ▸ Reset the admin account.',
      ui().ButtonSet.OK);
    return;
  }
  ui().alert('Your setup key',
    cfg('setupKey', '(run setup first)') +
    '\n\nEnter this in the app once, when you create your admin account. ' +
    'It stops working the moment that account exists.',
    ui().ButtonSet.OK);
}

function menuLinks() {
  var url  = deploymentUrl();
  var home = cfg('appHomeUrl', '');
  if (!url) {
    ui().alert('Not deployed yet',
      'Deploy ▸ New deployment ▸ Web app, with "Execute as: Me" and "Who has access: Anyone". ' +
      'Then come back here.', ui().ButtonSet.OK);
    return;
  }
  var msg = 'BACKEND URL (paste into the app the first time):\n' + url + '\n\n';
  msg += home
    ? 'ONE-TAP LINK (share this — it configures a device by itself):\n' +
      home + '#/connect/' + deploymentId() + '\n\n' +
      'To invite someone to a specific ledger, use the ✉️ button inside that ledger instead — ' +
      'those links carry the backend too.'
    : 'Open the app and sign in as admin once, and a shareable one-tap link will appear here.';
  ui().alert('SplitStack links', msg, ui().ButtonSet.OK);
}

/**
 * Repeating expenses and email summaries both depend on two daily triggers.
 * If those are missing the app looks broken in a way nothing else explains, so
 * give it a button that says what is wrong and fixes it.
 */
function menuJobs() {
  var on = jobsInstalled();
  if (on) {
    var res = ui().alert('Background jobs are on',
      'Repeating expenses post at about 3am and email summaries go out at about 8am, ' +
      'in ' + tz() + '.\n\nRe-install them? (Harmless — it just replaces the two triggers.)',
      ui().ButtonSet.YES_NO);
    if (res !== ui().Button.YES) return;
  }
  var r = installTriggers();
  ui().alert(r.ok ? 'Background jobs are on' : "Couldn't install them",
    r.ok ? 'Repeating expenses will post daily, and email summaries follow the schedule ' +
           'you set under Settings ▸ Notifications in the app.'
         : r.error + '\n\nThis usually means the script needs re-authorising. In the Apps Script ' +
           'editor, run setup() once and accept the permission prompt.',
    ui().ButtonSet.OK);
}

function menuUnlock() {
  var res = ui().prompt('Unlock an account',
    'Username to unlock (clears the 15-minute lockout):', ui().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui().Button.OK) return;
  var name = res.getResponseText().trim();
  if (!name) return;
  adminUnlock({ username: name });
  ui().alert('Unlocked', '"' + name + '" can try signing in again straight away.', ui().ButtonSet.OK);
}

function menuResetAdmin() {
  var res = ui().alert('Reset the admin account?',
    "The admin's password is cleared and a new setup key is issued. Ledgers and expenses are " +
    'untouched. You will create the admin account again in the app.',
    ui().ButtonSet.YES_NO);
  if (res !== ui().Button.YES) return;
  resetAdminClaim();
  ui().alert('Done', 'New setup key: ' + cfg('setupKey') +
    '\n\nOpen the app and create the admin account again.', ui().ButtonSet.OK);
}

/* -------------------------------------------------------------------- setup */

/**
 * Creates or repairs every tab. Safe to run any number of times.
 * Pass true to skip the dialog (the spreadsheet menu shows its own).
 */
function setup(silent) {
  // Columns are looked up by header name, never by position, so a sheet made
  // by an older version just gains the new ones on the end. Forced rather than
  // stamp-guarded here, because "repair" is exactly what this button promises.
  PropertiesService.getScriptProperties().deleteProperty('SCHEMA');
  ensureSchema();
  tab(TAB_CONFIG,  ['Key', 'Value']);

  if (!cfg('currency'))       setCfg('currency', 'USD');
  if (!cfg('currencySymbol')) setCfg('currencySymbol', '$');
  if (!cfg('appName'))        setCfg('appName', 'SplitStack');
  if (!cfg('digest'))         setCfg('digest', 'weekly');

  var jobs = installTriggers();

  var key = cfg('setupKey');
  if (!key) { key = randomHex(6).toUpperCase(); setCfg('setupKey', key); }
  pepper();

  var claimed = isReady();
  var msg = claimed
    ? 'Tabs checked. This instance already has an admin account.\n\n' +
      'Use the SplitStack menu in your spreadsheet for links and day-to-day admin.'
    : '\n=================================================\n' +
      '  SplitStack is ready.\n' +
      '  SETUP KEY:  ' + key + '\n' +
      '  Use it once in the app to create your admin account.\n' +
      '=================================================\n';
  msg += '\n\nBackground jobs: ' + (jobs.ok
    ? 'on (repeating expenses post daily, email summaries go out in the morning).'
    : 'NOT installed — ' + jobs.error + '\nRepeating expenses and email summaries need them. ' +
      'Run setup again from the Apps Script editor and accept the extra permission.');
  Logger.log(msg);
  if (!silent) {
    try { SpreadsheetApp.getUi().alert('SplitStack', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  }
  return key;
}

/** Convenience: re-print the setup key. */
function showSetupKey() { Logger.log(cfg('setupKey')); return cfg('setupKey'); }

/* ══════════════════════════════════════════════════════════ background jobs */
/**
 * Two daily time-driven triggers do all the unattended work:
 *
 *   rollRecurring  — posts repeating expenses that have come due
 *   sendDigests    — emails everyone their balances and anything awaiting them
 *
 * Both are safe to run more often than needed (they no-op when there is
 * nothing to do), and both are idempotent within a day, so a double
 * installation cannot double-post. Even so, this clears its own triggers
 * before creating them, so running setup repeatedly never stacks them up.
 *
 * Creating triggers needs a scope the original script did not ask for, so an
 * instance upgraded from an older version has to re-authorise once. Failing
 * that is not fatal — everything else keeps working, and setup() says so.
 */
var JOB_HANDLERS = ['rollRecurring', 'sendDigests'];

function installTriggers() {
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (JOB_HANDLERS.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
    });
    // 3am: expenses are dated and posted before anybody looks at the app.
    ScriptApp.newTrigger('rollRecurring').timeBased().atHour(3).everyDays(1).create();
    // 8am: the summary lands with the morning email, after the 3am rows exist.
    ScriptApp.newTrigger('sendDigests').timeBased().atHour(8).everyDays(1).create();
    try { CacheService.getScriptCache().remove('jobs'); } catch (e) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * Listing triggers is not free and bootstrap runs on every sync, so the answer
 * is cached. Installing them clears the cache, and the worst case for a stale
 * "no" is a banner that lingers five minutes.
 */
function jobsInstalled() {
  var c = CacheService.getScriptCache();
  var hit = c.get('jobs');
  if (hit !== null) return hit === '1';
  var on = false;
  try {
    on = ScriptApp.getProjectTriggers().some(function (t) {
      return JOB_HANDLERS.indexOf(t.getHandlerFunction()) !== -1;
    });
  } catch (e) { on = false; }
  c.put('jobs', on ? '1' : '0', 300);
  return on;
}

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

/* ═══════════════════════════════════════════════════ shared gate passphrase */
/**
 * OPTIONAL second factor for the whole instance. When set, no endpoint except
 * 'ping' will answer without it — so an attacker who somehow learns your /exec
 * URL cannot even reach the login form, let alone guess passwords.
 *
 * It is one shared value that everybody types once per device. That means it
 * does NOT rotate when someone leaves, and it is not a substitute for good
 * per-user passwords. It raises the wall around the building; the per-user
 * passwords still lock the individual doors.
 *
 * Only a verifier is stored, never the phrase itself.
 */
function gateEnabled() { return !!cfg('gateVerifier', ''); }

function requireGate(req) {
  var want = cfg('gateVerifier', '');
  if (!want) return true;                                  // disabled
  var got = req.gate === undefined ? '' : String(req.gate);
  if (!got) throw new Error('GATE_REQUIRED');
  if (hmac(pepper(), 'gate:' + got) !== want) {
    var c = CacheService.getScriptCache();
    var n = Number(c.get('gatefail') || 0);
    c.put('gatefail', String(n + 1), LOCK_WINDOW_SEC);
    Utilities.sleep(Math.min(3000, 300 * (n + 1)));         // slow down guessing
    throw new Error('GATE_INVALID');
  }
  return true;
}

function setGate(me, p) {
  var phrase = String(p.phrase === undefined ? '' : p.phrase).trim();
  if (!phrase) { setCfg('gateVerifier', ''); return { gated: false }; }
  if (phrase.length < 6) throw new Error('GATE_TOO_SHORT');
  setCfg('gateVerifier', hmac(pepper(), 'gate:' + phrase));
  return { gated: true };
}

/* ══════════════════════════════════════════════ brute-force / rate limiting */
/**
 * Counts consecutive failures per username in the script cache. Entries expire
 * on their own, so a locked account frees itself after the window without any
 * cleanup job. An admin can also clear it immediately.
 */
function guardKey(username) { return 'fail:' + String(username || '').toLowerCase(); }

function guardCheck(username) {
  var c = CacheService.getScriptCache();
  var key = guardKey(username);
  var n = Number(c.get(key) || 0);
  if (n >= LOCK_AFTER) throw new Error('TOO_MANY_ATTEMPTS');
  // Password spraying: many accounts, few guesses each. Slow everyone if it spikes.
  var spray = Number(c.get('fail:*') || 0);
  if (spray > SPRAY_AFTER) Utilities.sleep(2000);
  return { cache: c, key: key, n: n };
}

function guardFail(g) {
  g.cache.put(g.key, String(g.n + 1), LOCK_WINDOW_SEC);
  var spray = Number(g.cache.get('fail:*') || 0);
  g.cache.put('fail:*', String(spray + 1), LOCK_WINDOW_SEC);
  Utilities.sleep(Math.min(2500, 250 * (g.n + 1)));   // 250ms, 500ms, 750ms …
}

function guardPass(g) { g.cache.remove(g.key); }

/** Admin escape hatch: clear a lockout without waiting it out. */
function adminUnlock(p) {
  CacheService.getScriptCache().remove(guardKey(p.username || ''));
  return { ok: true };
}

/* ------------------------------------------------------------------ crypto */

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

function bytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    s += ('0' + b.toString(16)).slice(-2);
  }
  return s;
}

function hmacHex(keyStr, msgStr) {
  return bytesToHex(Utilities.computeHmacSha256Signature(msgStr, keyStr));
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
  // Belt and braces: an entity is never issued a token, so holding one means
  // something is wrong. Fail closed rather than reason about how.
  if (isEntity(u)) throw new Error('AUTH_INVALID');
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

/**
 * Return the salt for a username. Unknown users get a stable decoy salt so the
 * response is indistinguishable from a real one.
 *
 * Deliberately does NOT say whether the account exists — that would hand an
 * attacker a free username-enumeration oracle and undo the point of the decoy.
 */
function authSalt(p) {
  var u = findUser('Username', p.username || '');
  if (u && u.Salt) return { salt: u.Salt, iterations: Number(u.Iterations) || PBKDF2_ITERATIONS };
  // Same length and alphabet as a real 16-byte salt, and stable per username,
  // so a decoy is indistinguishable from the genuine article.
  return {
    salt: hmacHex(pepper(), 'decoy:' + String(p.username || '').toLowerCase()).slice(0, 32),
    iterations: PBKDF2_ITERATIONS
  };
}

function login(p) {
  var g = guardCheck(p.username);
  var u = findUser('Username', p.username || '');
  // An entity is indistinguishable from a name nobody has registered, which is
  // the same answer the login screen already gives for every unknown username.
  if (!u || !u.Verifier || isEntity(u))        { guardFail(g); throw new Error('BAD_CREDENTIALS'); }
  if (u.Active === false || u.Active === 'FALSE') throw new Error('ACCOUNT_DISABLED');
  if (verifierFor(p.dk) !== u.Verifier)        { guardFail(g); throw new Error('BAD_CREDENTIALS'); }
  guardPass(g);
  return { token: makeToken(u), me: publicUser(u), state: bootstrap(u) };
}

function claimAdmin(p) {
  return lock(function () {
    setup(true);
    if (isReady()) throw new Error('ADMIN_EXISTS');
    var g = guardCheck('*setupkey*');
    if (String(p.setupKey || '').toUpperCase().trim() !== String(cfg('setupKey')).toUpperCase().trim()) {
      guardFail(g);
      throw new Error('BAD_SETUP_KEY');
    }
    guardPass(g);
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
    var g = guardCheck(me.Username);
    if (verifierFor(p.oldDk) !== me.Verifier) { guardFail(g); throw new Error('BAD_CREDENTIALS'); }
    guardPass(g);
    updateRow(TAB_USERS, USER_COLS, me.__row, {
      Salt: p.salt, Iterations: PBKDF2_ITERATIONS, Verifier: verifierFor(p.dk),
      TokenVer: (Number(me.TokenVer) || 0) + 1, UpdatedAt: new Date()
    });
    var fresh = findUser('UserId', me.UserId);
    return { token: makeToken(fresh) };
  });
}

/** Invalidate every other device for this person, keeping the current one. */
function signOutEverywhere(me) {
  return lock(function () {
    updateRow(TAB_USERS, USER_COLS, me.__row, {
      TokenVer: (Number(me.TokenVer) || 0) + 1, UpdatedAt: new Date()
    });
    return { token: makeToken(findUser('UserId', me.UserId)) };
  });
}

function adminSetPassword(p) {
  return lock(function () {
    var u = findUser('UserId', p.userId);
    if (!u) throw new Error('NO_SUCH_USER');
    if (isEntity(u)) throw new Error('NOT_A_PERSON');
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

/* ═══════════════════════════════════════════════════ people and non-people */
/**
 * Not every member of a ledger is a person with a phone.
 *
 * An employer you claim expenses back from, a house kitty, a partner who is
 * never going to install this — each needs to hold a balance and appear in a
 * split, and none of them can log in. Marking them as an entity is what stops
 * the app treating them as somebody who simply hasn't signed up yet: the
 * difference between "Acme Corp owes you £340" and offering a stranger with
 * your invite link the chance to log in as your employer.
 *
 * Entities are ordinary rows everywhere the money is concerned, and are shut
 * out of every path that assumes a human: login, invites, seat claiming,
 * email, admin. Those guards are deliberately spread across each of those
 * paths rather than centralised — a single missed check should fail closed in
 * one place, not open up all of them.
 */
function isEntity(u) {
  return !!u && String(u.Kind == null ? '' : u.Kind).toLowerCase() === 'entity';
}

/**
 * Entities never type a username, but the sheet still wants one — it is the
 * human-readable handle in a column people read. Derive it from the name and
 * make it unique, so "Acme Corp" becomes acme-corp without anybody being asked
 * to invent something.
 */
function entityUsername(name) {
  var base = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  if (base.length < 2) base = 'entity';
  var candidate = base, n = 2;
  while (findUser('Username', candidate)) {
    candidate = base.slice(0, 20 - String(n).length - 1) + '-' + n;
    n++;
  }
  return candidate;
}

function publicUser(u) {
  return {
    id: u.UserId, username: u.Username, name: u.DisplayName || u.Username,
    email: u.Email || '', role: u.Role || 'member', avatar: u.Avatar || '',
    color: u.Color || pickColor(0), emoji: u.Emoji || '', active: u.Active !== false && u.Active !== 'FALSE',
    notify: notifyOn(u),
    kind: isEntity(u) ? 'entity' : 'person',
    payType: u.PayType || '', payHandle: u.PayHandle || '',
    hasPassword: !!u.Verifier
  };
}

/* Where money can actually be sent. The app turns these into a deep link that
   opens the relevant app with the amount already filled in — the one step in
   settling up that SplitStack could never help with before.

   'link' is the escape hatch: anything else, pasted as a plain https URL. */
var PAY_TYPES = ['venmo', 'paypal', 'cashapp', 'revolut', 'upi', 'link'];

/** Email is opt-out: a blank cell on an existing sheet means "yes, please". */
function notifyOn(u) { return String(u.Notify == null ? '' : u.Notify).toLowerCase() !== 'off'; }

/**
 * Your own name, email and email preference. Admins can already edit anyone
 * through adminSaveUser; this is the door that does not need to be an admin to
 * walk through, so people can fix their own address and switch email off.
 */
function setProfile(me, p) {
  return lock(function () {
    var patch = { UpdatedAt: new Date() };
    if (p.name !== undefined) {
      var name = String(p.name).trim().slice(0, 60);
      if (!name) throw new Error('NAME_REQUIRED');
      patch.DisplayName = name;
    }
    if (p.email !== undefined) {
      var email = String(p.email).trim().slice(0, 160);
      if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) throw new Error('BAD_EMAIL');
      patch.Email = email;
    }
    if (p.notify !== undefined) patch.Notify = p.notify ? 'on' : 'off';
    if (p.payType !== undefined || p.payHandle !== undefined) {
      var type = String(p.payType || '').toLowerCase();
      var handle = String(p.payHandle || '').trim().slice(0, 200);
      if (!handle) { type = ''; handle = ''; }               // clearing one clears both
      else if (PAY_TYPES.indexOf(type) === -1) throw new Error('BAD_PAY_TYPE');
      // A free-form link is the only value that becomes a URL verbatim, so it
      // is the only one that has to be checked. The rest are interpolated into
      // a scheme the client controls.
      else if (type === 'link' && !/^https:\/\/[^\s"'<>]{4,200}$/.test(handle)) throw new Error('BAD_PAY_LINK');
      patch.PayType = type;
      patch.PayHandle = handle;
    }
    updateRow(TAB_USERS, USER_COLS, me.__row, patch);
    return { me: publicUser(findUser('UserId', me.UserId)) };
  });
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
      if (p.kind !== undefined) {
        var wantEntity = p.kind === 'entity';
        // Somebody who has set a password is a person, whatever the form says.
        // Demoting them would strand a working login behind an account the app
        // no longer offers a way to sign into.
        if (wantEntity && u.Verifier) throw new Error('HAS_A_LOGIN');
        if (wantEntity && u.Role === 'admin') throw new Error('ADMIN_IS_A_PERSON');
        patch.Kind = wantEntity ? 'entity' : 'person';
        if (wantEntity) { patch.Role = 'member'; patch.Email = ''; patch.Notify = 'off'; }
      }
      var willBeEntity = patch.Kind ? patch.Kind === 'entity' : isEntity(u);
      if (p.role !== undefined && p.role !== u.Role) {
        if (willBeEntity && p.role === 'admin') throw new Error('ADMIN_IS_A_PERSON');
        if (u.Role === 'admin' && activeAdminCount() <= 1) throw new Error('LAST_ADMIN');
        patch.Role = p.role === 'admin' ? 'admin' : 'member';
      }
      updateRow(TAB_USERS, USER_COLS, u.__row, patch);
      return { user: publicUser(findUser('UserId', p.id)) };
    }

    var entity = p.kind === 'entity';
    var username;
    if (entity) {
      if (!String(p.name || '').trim()) throw new Error('NAME_REQUIRED');
      username = entityUsername(p.name);
    } else {
      validateUsername(p.username);
      if (findUser('Username', p.username)) throw new Error('USERNAME_TAKEN');
      username = String(p.username).toLowerCase().trim();
    }
    var n = readTab(TAB_USERS, USER_COLS).length;
    var nu = {
      UserId: uid('usr'), Username: username,
      DisplayName: p.name || p.username, Email: entity ? '' : (p.email || ''),
      Role: (!entity && p.role === 'admin') ? 'admin' : 'member',
      // An entity is given no credentials at all — not a blank password, which
      // is a seat waiting to be claimed, but nothing a login could ever match.
      Salt: entity ? '' : (p.salt || ''),
      Iterations: PBKDF2_ITERATIONS,
      Verifier: (!entity && p.dk) ? verifierFor(p.dk) : '',
      TokenVer: 1, Avatar: '', Color: p.color || pickColor(n),
      Emoji: p.emoji || (entity ? '🏢' : ''),
      Active: true, Notify: entity ? 'off' : '', Kind: entity ? 'entity' : 'person',
      CreatedAt: now, UpdatedAt: now
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
    presets: parseJson(l.Presets) || [],
    // null means "split new expenses evenly", which is what every ledger did
    // before this existed and what most of them still want.
    defaultSplit: parseJson(l.DefaultSplit) || null,
    createdAt: l.CreatedAt ? new Date(l.CreatedAt).toISOString() : null
  };
}

/* ═══════════════════════════════════════════════════════════ split presets */
/**
 * A named split saved on the ledger — "Rent split", "Everyone but Ben" — so a
 * house whose rent is 40/30/30 sets those percentages once instead of every
 * month.
 *
 * Deliberately NOT admin-only. Presets are a convenience for whoever enters
 * expenses, and the person who enters the rent is not necessarily the person
 * who created the ledger. Membership is the right bar, same as pushing a
 * transaction.
 */
var PRESET_MAX = 12;

function setPresets(me, p) {
  return lock(function () {
    assertMember(me, p.ledgerId);
    var l = ledgerById(p.ledgerId);
    var members = memberIdsOf(p.ledgerId);
    var list = (p.presets || []).slice(0, PRESET_MAX).map(function (x) {
      var name = String(x.name || '').trim().slice(0, 40);
      if (!name) throw new Error('NAME_REQUIRED');
      var split = normaliseSplit(x.split, members);
      if (!split) throw new Error('SPLIT_REQUIRED');
      return { id: String(x.id || uid('pst')).slice(0, 40), name: name, split: split };
    });
    updateRow(TAB_LEDGERS, LEDGER_COLS, l.__row, {
      Presets: JSON.stringify(list), UpdatedAt: new Date()
    });
    return { presets: list };
  });
}

/* ═══════════════════════════════════════════════════════════ default split */
/**
 * How new expenses on this ledger start out. A house that always divides rent
 * 60/40 shouldn't retype 60/40, and two people can't reach the saved-splits
 * shortcut at all — a two-person ledger is exactly the case that had no relief.
 *
 * Stored as a plain split, or blank for "evenly", which is what every ledger
 * did before this existed. Admin-only, because it is a statement of policy
 * about how the household divides things rather than a shortcut for whoever is
 * doing the typing — saved splits are the latter, and they stay open to
 * everyone.
 *
 * A default naming somebody who has left is normalised down on the way in, so
 * the stored value can never disagree with the membership beside it. Somebody
 * who *joins* is a different matter and deliberately left alone: excluding one
 * person on purpose is legitimate, so the app surfaces it in the ledger's
 * settings instead of guessing.
 */
function defaultSplitFor(raw, memberIds) {
  if (!raw || !Object.keys(raw).length) return '';        // blank means evenly
  var split = normaliseSplit(raw, memberIds);
  if (!split) throw new Error('SPLIT_REQUIRED');
  return JSON.stringify(split);
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
      // Membership first: the default split has to be judged against who ends
      // up on the ledger, not who was on it when the request was written.
      if (p.memberIds) setMembers({ ledgerId: p.id, userIds: p.memberIds });
      if (p.defaultSplit !== undefined) {
        patch.DefaultSplit = defaultSplitFor(p.defaultSplit, memberIdsOf(p.id));
      }
      updateRow(TAB_LEDGERS, LEDGER_COLS, l.__row, patch);
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
    if (p.defaultSplit !== undefined) {
      updateRow(TAB_LEDGERS, LEDGER_COLS, ledgerById(l.LedgerId).__row, {
        DefaultSplit: defaultSplitFor(p.defaultSplit, memberIdsOf(l.LedgerId))
      });
    }
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
                                               kind: isEntity(u) ? 'entity' : 'person',
                                               // An entity has no seat to claim. Without this, an
                                               // employer on the ledger reads to whoever holds the
                                               // link as an unclaimed account they may as well take.
                                               claimable: !u.Verifier && !isEntity(u) }; })
  };
}

/** A seat the admin created without a password can be claimed by the invitee. */
function claimSeat(p) {
  return lock(function () {
    var l = ledgerByInvite(p.invite);
    if (!l) throw new Error('BAD_INVITE');
    var u = findUser('UserId', p.userId);
    if (!u) throw new Error('NO_SUCH_USER');
    if (isEntity(u)) throw new Error('NOT_A_PERSON');
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

/**
 * Remember where the app is hosted, reported by the admin's own client. This
 * is what lets the /exec page and the spreadsheet menu produce working links
 * without anyone configuring anything.
 *
 * Admin only — otherwise any member could repoint those links elsewhere.
 */
function noteHome(me, p) {
  if (me.Role !== 'admin') return;
  var home = String((p && p.home) || '').trim();
  if (!/^https:\/\/[^\s"'<>]{4,300}$/.test(home)) return;
  if (cfg('appHomeUrl', '') === home) return;
  setCfg('appHomeUrl', home);
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
    recurring: myRecurring(me),
    config:   { currency: cfg('currency', 'USD'), symbol: cfg('currencySymbol', '$'),
                appName: cfg('appName', 'SplitStack'), gated: gateEnabled(),
                digest: cfg('digest', 'weekly'),
                categories: parseJson(cfg('categories', '')) || null,
                // Repeating expenses and email both ride on the daily triggers.
                // The app says so plainly rather than looking broken.
                jobs: jobsInstalled() },
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
    updatedAt: Number(r.Rev) || (r.UpdatedAt ? new Date(r.UpdatedAt).getTime() : 0),
    reviewState: r.ReviewState || '',
    reviewBy: r.ReviewBy || '',
    reviewNote: r.ReviewNote || '',
    reviewDone: splitIds(r.ReviewDone),
    reviewWas: parseJson(r.ReviewWas)
  };
}

function splitIds(s) {
  return String(s == null ? '' : s).split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return !!x; });
}
function parseJson(s) {
  try { return s ? JSON.parse(s) : null; } catch (e) { return null; }
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
      var rev = reviewForChange(me, t, prior);
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
        Rev: stamp,
        ReviewState: rev.state,
        ReviewBy: rev.by,
        ReviewNote: rev.note,
        ReviewDone: rev.done,
        ReviewWas: rev.was
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

/* ------------------------------------------------------------------ review */
/**
 * Decides whether a change needs a human to look at it.
 *
 *   · someone other than the original author changed the row  -> 'edit'
 *   · …and the row had already moved on since that person last
 *     saw it, so the two of them collided                     -> 'conflict'
 *   · the author touching their own row                       -> clears whatever
 *     was open; they have plainly seen it
 *
 * The client supplies baseRev (the Rev its edit was built on) and a plain
 * language summary of what it changed, because it is the side that knows the
 * currency symbol and the old values. The server decides the state, so a
 * client cannot talk its way out of being flagged.
 */
function reviewForChange(me, t, prior) {
  var clear = { state: '', by: '', note: '', done: '', was: '' };
  if (!prior) return clear;                      // brand new: nothing to review yet
  var author = prior.EnteredBy || t.enteredBy || '';
  if (!author || author === me.UserId) return clear;

  var base = Number(t.baseRev) || 0;
  var cur  = Number(prior.Rev) || 0;
  return {
    state: (base > 0 && cur > base) ? 'conflict' : 'edit',
    by: me.UserId,
    note: String(t.reviewNote || '').slice(0, 500),
    done: '',
    was: t.reviewWas ? JSON.stringify(t.reviewWas).slice(0, 8000) : ''
  };
}

/** Who still has to sign a change off. Derived, never stored. */
function reviewersOf(row) {
  if (row.ReviewState === 'flag') {
    // A manual flag asks everyone with money in it.
    if (row.Type === 'settlement') return splitIds(row.PaidBy + ',' + row.PaidTo);
    var split = parseJson(row.SplitPct) || {};
    var ids = [];
    for (var k in split) if (split.hasOwnProperty(k)) ids.push(k);
    return ids;
  }
  return splitIds(row.EnteredBy);   // an edit is the author's to accept
}

/**
 * Sign-off, raising a flag and withdrawing one. Deliberately its own action
 * rather than a whole-row push: reviewing is not editing, and it must never
 * overwrite someone's concurrent change to the amounts.
 */
function reviewTxn(me, p) {
  return lock(function () {
    var l = assertMember(me, p.ledgerId);
    txnSheet(l);
    var rows = readTab(l.SheetName, TXN_COLS), row = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].TxnId === p.txnId) { row = rows[i]; break; }
    }
    if (!row) throw new Error('NO_SUCH_TXN');

    var clear = { ReviewState: '', ReviewBy: '', ReviewNote: '', ReviewDone: '', ReviewWas: '' };
    var patch;

    if (p.op === 'flag') {
      patch = { ReviewState: 'flag', ReviewBy: me.UserId,
                ReviewNote: String(p.note || '').slice(0, 500),
                // Raising the flag counts as having looked at it yourself.
                ReviewDone: me.UserId, ReviewWas: '' };
    } else if (p.op === 'unflag') {
      if (row.ReviewState !== 'flag') throw new Error('NOT_FLAGGED');
      if (row.ReviewBy !== me.UserId && me.Role !== 'admin') throw new Error('FORBIDDEN');
      patch = clear;
    } else if (p.op === 'ack') {
      if (!row.ReviewState) throw new Error('NOT_UNDER_REVIEW');
      var need = reviewersOf(row);
      if (need.indexOf(me.UserId) === -1 && me.Role !== 'admin') throw new Error('FORBIDDEN');
      var done = splitIds(row.ReviewDone);
      if (done.indexOf(me.UserId) === -1) done.push(me.UserId);
      var outstanding = need.filter(function (u) { return done.indexOf(u) === -1; });
      patch = outstanding.length ? { ReviewDone: done.join(',') } : clear;
    } else {
      throw new Error('BAD_REVIEW_OP');
    }

    patch.UpdatedAt = new Date();
    patch.Rev = nextRev(1);
    updateRow(l.SheetName, TXN_COLS, row.__row, patch);
    SpreadsheetApp.flush();

    for (var k in patch) if (patch.hasOwnProperty(k)) row[k] = patch[k];
    return { txn: rowToTxn(row), cursor: patch.Rev };
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

/* ════════════════════════════════════════════════════ repeating expenses */
/**
 * Rent, the internet bill, the cleaner — the entries somebody would otherwise
 * retype every month. A rule is a template plus a schedule; a daily trigger
 * turns due rules into ordinary transactions and steps the schedule on.
 *
 * The generated rows are ordinary rows in every respect. Nothing downstream —
 * sync, balances, reviews, editing, deletion — knows or cares that a rule put
 * them there, which is what keeps this feature from leaking into the rest of
 * the app.
 */

/** The sheet's own timezone is the one the user thinks in. */
function tz() {
  try { return ss().getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'UTC'; }
  catch (e) { return 'UTC'; }
}
function todayStr() { return Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd'); }

/**
 * Cells hand back either a string or a Date depending on how Sheets decided to
 * store what was written. Both have to come out as a plain YYYY-MM-DD, and a
 * Date has to be read in the sheet's timezone or it slides a day.
 */
function dateStr(v) {
  if (!v && v !== 0) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function ymd(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

/**
 * Step a date on by one period.
 *
 * `anchor` is the day of the month the rule was created on, and it is why this
 * takes a parameter instead of reading the day off `from`: a monthly rule
 * starting on the 31st has to become the 28th in February and then go back to
 * the 31st in March, not stay on the 28th forever. All arithmetic is on the
 * numbers themselves — no Date objects, so no timezone can shift a day.
 */
function addPeriod(from, freq, every, anchor) {
  var p = String(from).split('-');
  var y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
  var n = Math.max(1, Math.min(52, Number(every) || 1));

  if (freq === 'weekly') {
    var t = new Date(Date.UTC(y, m - 1, d));
    t.setUTCDate(t.getUTCDate() + 7 * n);
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  if (freq === 'yearly') {
    y += n;
    return ymd(y, m, Math.min(anchor || d, daysInMonth(y, m)));
  }
  m += n;                                  // monthly
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12) + 1;
  return ymd(y, m, Math.min(anchor || d, daysInMonth(y, m)));
}

var RECUR_FREQS = ['weekly', 'monthly', 'yearly'];

function rowToRule(r) {
  return {
    id: r.RuleId,
    ledgerId: r.LedgerId,
    name: r.Name || '',
    category: r.Category || '',
    amount: Number(r.Amount) || 0,
    paidBy: r.PaidBy || '',
    split: parseJson(r.SplitPct) || {},
    notes: r.Notes || '',
    freq: r.Freq || 'monthly',
    every: Number(r.Every) || 1,
    anchor: Number(r.Anchor) || 0,
    nextDate: dateStr(r.NextDate),
    lastRun: dateStr(r.LastRun),
    active: !(r.Active === false || r.Active === 'FALSE'),
    review: r.Review === true || r.Review === 'TRUE',
    createdBy: r.CreatedBy || ''
  };
}

function allRules() { return readTab(TAB_RECURRING, RECUR_COLS).filter(function (r) { return !!r.RuleId; }); }

function myRecurring(me) {
  var ids = myLedgers(me).map(function (l) { return l.LedgerId; });
  return allRules()
    .filter(function (r) { return ids.indexOf(r.LedgerId) !== -1; })
    .map(rowToRule);
}

/**
 * Drop anyone who is no longer on the ledger and rescale what is left back to
 * 100. A rule outlives the housemate who moved out, and posting a split that
 * pays out to a non-member would leave balances that no longer sum to zero.
 */
function normaliseSplit(split, memberIds) {
  var kept = {}, sum = 0;
  Object.keys(split || {}).forEach(function (k) {
    if (memberIds.indexOf(k) === -1) return;
    var v = Number(split[k]) || 0;
    if (v <= 0) return;
    kept[k] = v; sum += v;
  });
  var ids = Object.keys(kept);
  if (!ids.length || sum <= 0) return null;
  if (Math.abs(sum - 100) < 0.005) return kept;

  var out = {}, acc = 0;
  ids.forEach(function (k, i) {
    if (i === ids.length - 1) out[k] = Math.round((100 - acc) * 100) / 100;
    else { var v = Math.round(kept[k] / sum * 10000) / 100; out[k] = v; acc += v; }
  });
  return out;
}

function memberIdsOf(ledgerId) {
  return readTab(TAB_MEMBERS, MEMBER_COLS)
    .filter(function (m) { return m.LedgerId === ledgerId; })
    .map(function (m) { return m.UserId; });
}

function validateRule(p, memberIds) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('NAME_REQUIRED');
  if (!(Number(p.amount) > 0)) throw new Error('BAD_AMOUNT');
  if (Number(p.amount) > 100000000) throw new Error('AMOUNT_TOO_LARGE');
  if (RECUR_FREQS.indexOf(p.freq) === -1) throw new Error('BAD_FREQUENCY');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.nextDate || ''))) throw new Error('BAD_DATE');
  if (memberIds.indexOf(p.paidBy) === -1) throw new Error('PAYER_NOT_A_MEMBER');
  var split = normaliseSplit(p.split, memberIds);
  if (!split) throw new Error('SPLIT_REQUIRED');
  return { name: name.slice(0, 120), split: split };
}

function recurringSave(me, p) {
  return lock(function () {
    assertMember(me, p.ledgerId);
    tab(TAB_RECURRING, RECUR_COLS);
    var members = memberIdsOf(p.ledgerId);
    var v = validateRule(p, members);
    var now = new Date();
    var anchor = Number(String(p.nextDate).slice(8, 10));

    var vals = {
      LedgerId: p.ledgerId,
      Name: v.name,
      Category: String(p.category || '').slice(0, 40),
      Amount: Math.round(Number(p.amount) * 100) / 100,
      PaidBy: p.paidBy,
      SplitPct: JSON.stringify(v.split),
      Notes: String(p.notes || '').slice(0, 500),
      Freq: p.freq,
      Every: Math.max(1, Math.min(52, Number(p.every) || 1)),
      Anchor: anchor,
      NextDate: p.nextDate,
      Active: p.active !== false,
      Review: !!p.review,
      UpdatedAt: now
    };

    // Ids come from the client so a rule created on a plane can be replayed
    // without becoming two rules — the same idempotency transactions get.
    var id = String(p.id || uid('rec')).slice(0, 60);
    var found = null;
    allRules().forEach(function (r) { if (r.RuleId === id) found = r; });

    if (found) {
      if (found.LedgerId !== p.ledgerId) throw new Error('FORBIDDEN');
      // LastRun is the engine's to write, and CreatedBy says whose entry the
      // posted rows are — neither is the editor's to overwrite.
      updateRow(TAB_RECURRING, RECUR_COLS, found.__row, vals);
    } else {
      vals.RuleId = id;
      vals.CreatedBy = me.UserId;
      vals.CreatedAt = now;
      vals.LastRun = '';
      appendRow(TAB_RECURRING, RECUR_COLS, vals);
    }

    var fresh = null;
    allRules().forEach(function (r) { if (r.RuleId === id) fresh = r; });
    return { rule: rowToRule(fresh) };
  });
}

function recurringDelete(me, p) {
  return lock(function () {
    var rows = allRules(), found = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].RuleId === p.id) { found = rows[i]; break; }
    if (!found) return { ok: true };            // already gone; nothing to argue about
    assertMember(me, found.LedgerId);
    tab(TAB_RECURRING, RECUR_COLS).deleteRow(found.__row);
    return { ok: true };
  });
}

/**
 * The daily job. Posts every occurrence a rule owes, oldest first, then leaves
 * NextDate pointing at the next one that has not happened yet.
 *
 * Transaction ids are derived from the rule and the date, so a rule that runs
 * twice in a day — or a script that was off for a week and catches up — can
 * never post the same occurrence twice. That is the same idempotency the
 * offline outbox relies on, reused.
 */
function rollRecurring() {
  return lock(function () {
    var today = todayStr();
    var rules = allRules();
    if (!rules.length) return { posted: 0 };

    var ledgers = {};
    readTab(TAB_LEDGERS, LEDGER_COLS).forEach(function (l) { ledgers[l.LedgerId] = l; });

    var posted = 0;
    rules.forEach(function (r) {
      var rule = rowToRule(r);
      if (!rule.active || !rule.nextDate || rule.nextDate > today) return;
      var ledger = ledgers[rule.ledgerId];
      if (!ledger) return;

      var members = memberIdsOf(rule.ledgerId);
      var split = normaliseSplit(rule.split, members);
      var payer = members.indexOf(rule.paidBy) !== -1 ? rule.paidBy : null;
      if (!split || !payer) {
        // The people it was written for are gone. Park it rather than post
        // something wrong; the ledger still shows the rule, switched off.
        updateRow(TAB_RECURRING, RECUR_COLS, r.__row, { Active: false, UpdatedAt: new Date() });
        return;
      }

      txnSheet(ledger);                       // make sure the tab and columns exist
      var existing = {};
      readTab(ledger.SheetName, TXN_COLS).forEach(function (x) { if (x.TxnId) existing[x.TxnId] = true; });

      var due = [], cursor = rule.nextDate, guard = 0;
      while (cursor <= today && guard++ < RECUR_CATCHUP_MAX) {
        due.push(cursor);
        cursor = addPeriod(cursor, rule.freq, rule.every, rule.anchor);
      }
      // A rule left unattended for longer than the catch-up window skips the
      // backlog rather than dumping two years of rent into the feed at once.
      if (guard >= RECUR_CATCHUP_MAX) {
        while (cursor <= today) cursor = addPeriod(cursor, rule.freq, rule.every, rule.anchor);
      }

      var fresh = due.filter(function (d) { return !existing['rec_' + rule.id + '_' + d]; });
      if (fresh.length) {
        var base = nextRev(fresh.length);
        var rows = fresh.map(function (d, i) {
          return {
            TxnId: 'rec_' + rule.id + '_' + d,
            Type: 'expense',
            Date: d,
            Name: rule.name,
            Category: rule.category,
            Amount: rule.amount,
            PaidBy: payer,
            PaidTo: '',
            EnteredBy: rule.createdBy || payer,
            SplitPct: JSON.stringify(split),
            Notes: rule.notes,
            ReceiptId: '',
            Deleted: false,
            CreatedAt: new Date(),
            UpdatedAt: new Date(),
            Rev: base + i,
            // Opted-in rules land marked for review, so a rent rise gets seen
            // rather than quietly accruing. Whoever set the rule up counts as
            // having looked already.
            ReviewState: rule.review ? 'flag' : '',
            ReviewBy: rule.review ? (rule.createdBy || payer) : '',
            ReviewNote: rule.review ? 'Posted automatically — check the amount is still right' : '',
            ReviewDone: rule.review ? (rule.createdBy || payer) : '',
            ReviewWas: ''
          };
        });
        appendRows(ledger.SheetName, TXN_COLS, rows);
        posted += rows.length;
      }

      updateRow(TAB_RECURRING, RECUR_COLS, r.__row, {
        NextDate: cursor, LastRun: today, UpdatedAt: new Date()
      });
    });

    SpreadsheetApp.flush();
    return { posted: posted };
  });
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

/* ══════════════════════════════════════════════════════════════════ email */
/**
 * The one piece of infrastructure this app gets for free. The script runs as
 * you, inside your Google account, so it can send mail through your own quota
 * with no third-party service, no API key and no data leaving the account that
 * already holds the spreadsheet.
 *
 * Two things go out:
 *   · a digest, on a schedule the admin picks — where you stand, what is new,
 *     and anything waiting on you
 *   · a nudge, on demand — one person asking another for money they are owed
 *
 * Everything is opt-out per person (Users ▸ Notify) and gated on there being
 * an address to send to. Nobody is emailed twice about the same thing: the
 * digest only reports transactions newer than the last one that went out.
 */

/* ---- money, exactly as the client computes it ---------------------------- */
/* These mirror allocate() / balancesFor() / simplify() in app.js. An email
   that disagreed with the screen would be worse than no email, so the
   largest-remainder rounding and the id tie-break are reproduced precisely. */

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function allocateSrv(amount, split) {
  var ids = Object.keys(split || {}).sort();
  var out = {};
  if (!ids.length) return out;
  var total = Math.round(round2(amount) * 100);
  var raw = ids.map(function (id) { return round2(amount) * (Number(split[id]) || 0) / 100 * 100; });
  var cents = raw.map(function (v) { return Math.floor(v); });
  var residual = total - cents.reduce(function (a, b) { return a + b; }, 0);
  var order = ids.map(function (id, i) { return { i: i, id: id, frac: raw[i] - cents[i] }; })
    .sort(function (a, b) { return (b.frac - a.frac) || (a.id < b.id ? -1 : 1); });
  for (var k = 0; residual > 0 && k < 10000; k++, residual--) cents[order[k % ids.length].i]++;
  for (var j = 0; residual < 0 && j < 10000; j++, residual++) cents[order[order.length - 1 - (j % ids.length)].i]--;
  ids.forEach(function (id, i) { out[id] = cents[i] / 100; });
  return out;
}

function balancesOf(ledger, memberIds) {
  var net = {};
  memberIds.forEach(function (i) { net[i] = 0; });
  readTab(ledger.SheetName, TXN_COLS).forEach(function (r) {
    if (!r.TxnId) return;
    var t = rowToTxn(r);
    if (t.deleted) return;
    if (t.type === 'settlement') {
      net[t.paidBy] = round2((net[t.paidBy] || 0) + t.amount);
      net[t.paidTo] = round2((net[t.paidTo] || 0) - t.amount);
    } else {
      net[t.paidBy] = round2((net[t.paidBy] || 0) + t.amount);
      var shares = allocateSrv(t.amount, t.split);
      Object.keys(shares).forEach(function (u) { net[u] = round2((net[u] || 0) - shares[u]); });
    }
  });
  Object.keys(net).forEach(function (k) { net[k] = round2(net[k]); });
  return net;
}

function fmtMoney(n) {
  var sym = cfg('currencySymbol', '$');
  var v = Math.abs(round2(n)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '−' : '') + sym + v;
}

/* ---- plumbing ------------------------------------------------------------ */

function appUrl() {
  var home = cfg('appHomeUrl', '');
  return home || deploymentUrl();
}

/** Never let a scheduled job burn the whole daily allowance in one pass. */
function mailQuota() {
  try { return MailApp.getRemainingDailyQuota(); } catch (e) { return 0; }
}

function sendMail(to, subject, html) {
  MailApp.sendEmail({
    to: to,
    subject: subject,
    htmlBody: html,
    body: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    name: cfg('appName', 'SplitStack')
  });
}

function mailShell(title, intro, blocks, ctaLabel) {
  var url = appUrl();
  return '' +
    '<div style="margin:0;padding:24px 12px;background:#EFEBFF;font-family:-apple-system,BlinkMacSystemFont,' +
    '\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#1B1435">' +
    '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:22px;padding:28px;' +
    'box-shadow:0 18px 44px -22px rgba(46,25,110,.45)">' +
    '<div style="font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8A84A6">' +
    escapeHtml(cfg('appName', 'SplitStack')) + '</div>' +
    '<h1 style="margin:6px 0 10px;font-size:23px;line-height:1.25">' + escapeHtml(title) + '</h1>' +
    (intro ? '<p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4A4368">' + intro + '</p>' : '') +
    blocks +
    (url ? '<a href="' + escapeHtml(url) + '" style="display:block;margin-top:22px;background:#6C5CE7;color:#fff;' +
      'text-decoration:none;padding:14px;border-radius:15px;font-weight:800;text-align:center">' +
      escapeHtml(ctaLabel || 'Open the app') + '</a>' : '') +
    '<p style="margin:20px 0 0;padding-top:16px;border-top:1px solid #EAE6F8;font-size:12px;line-height:1.5;color:#8A84A6">' +
    'You are getting this because you are on a shared ledger. Turn it off any time under ' +
    'your profile in the app.</p>' +
    '</div></div>';
}

function mailRow(left, right, colour) {
  return '<tr>' +
    '<td style="padding:9px 0;border-bottom:1px solid #F0EDFB;font-size:14.5px;font-weight:600">' + left + '</td>' +
    '<td style="padding:9px 0;border-bottom:1px solid #F0EDFB;font-size:15px;font-weight:800;text-align:right;' +
    'white-space:nowrap;color:' + (colour || '#1B1435') + '">' + right + '</td></tr>';
}
function mailTable(rows) {
  return '<table style="width:100%;border-collapse:collapse;margin:6px 0 2px">' + rows + '</table>';
}

/* ---- the digest ---------------------------------------------------------- */

/**
 * Daily job. Decides for itself whether today is a sending day, so the
 * schedule can change without touching the trigger.
 */
function sendDigests() {
  var mode = String(cfg('digest', 'weekly'));
  if (mode === 'off') return { sent: 0, reason: 'off' };
  // Day-of-week via the date string rather than a locale-sensitive format
  // pattern: today in the sheet's timezone, read back as UTC, is unambiguous.
  if (mode === 'weekly' && new Date(todayStr() + 'T00:00:00Z').getUTCDay() !== 1) {
    return { sent: 0, reason: 'not-monday' };
  }
  return runDigest(null);
}

/**
 * Build and send. `only` restricts it to a single user, which is what the
 * admin's "send me one now" button uses.
 *
 * The since-cursor is a Rev, the same strictly increasing counter delta sync
 * runs on, so "new since the last digest" means exactly what it says even if a
 * run was missed or fired late.
 */
function runDigest(only) {
  var since = Number(cfg('lastDigestRev', 0)) || 0;
  // On the very first run every row in the sheet is technically "new". Report
  // reviews and balances, seed the cursor, and start reporting changes next
  // time — nobody wants their whole history in an email.
  var firstRun = since === 0;
  var users = readTab(TAB_USERS, USER_COLS);
  var ledgers = readTab(TAB_LEDGERS, LEDGER_COLS);
  var members = readTab(TAB_MEMBERS, MEMBER_COLS);
  var nameOf = {};
  users.forEach(function (u) { nameOf[u.UserId] = u.DisplayName || u.Username; });

  // One read per ledger, reused for everybody on it.
  var facts = {}, maxRev = since;
  ledgers.forEach(function (l) {
    if (l.Archived === true || l.Archived === 'TRUE') return;
    var ids = members.filter(function (m) { return m.LedgerId === l.LedgerId; })
                     .map(function (m) { return m.UserId; });
    if (!ids.length) return;
    var fresh = [], open = [];
    readTab(l.SheetName, TXN_COLS).forEach(function (r) {
      if (!r.TxnId) return;
      var t = rowToTxn(r);
      if (t.updatedAt > maxRev) maxRev = t.updatedAt;
      if (t.reviewState) open.push({ txn: t, need: reviewersOf(r) });
      if (!firstRun && !t.deleted && t.updatedAt > since) fresh.push(t);
    });
    facts[l.LedgerId] = { ledger: l, ids: ids, net: balancesOf(l, ids), fresh: fresh, open: open };
  });

  var quota = mailQuota();
  var sent = 0, skipped = 0;
  users.forEach(function (u) {
    if (only && u.UserId !== only) return;
    if (!u.Email || !notifyOn(u) || isEntity(u)) return;
    if (u.Active === false || u.Active === 'FALSE') return;
    if (sent >= quota - 1) { skipped++; return; }

    var mine = Object.keys(facts).filter(function (id) { return facts[id].ids.indexOf(u.UserId) !== -1; });
    if (!mine.length) return;

    var total = 0, balRows = '', newRows = '', reviewRows = '', newCount = 0, reviewCount = 0;
    mine.forEach(function (id) {
      var f = facts[id];
      var v = f.net[u.UserId] || 0;
      total = round2(total + v);
      balRows += mailRow(
        escapeHtml((f.ledger.Emoji || '💸') + '  ' + f.ledger.Name),
        (Math.abs(v) < 0.005 ? 'settled' : (v > 0 ? '+' : '') + fmtMoney(v)),
        Math.abs(v) < 0.005 ? '#8A84A6' : (v > 0 ? '#00B894' : '#FF7675'));

      f.fresh.forEach(function (t) {
        newCount++;
        if (newCount > 12) return;
        newRows += mailRow(
          escapeHtml(t.type === 'settlement'
            ? (nameOf[t.paidBy] || '?') + ' paid ' + (nameOf[t.paidTo] || '?')
            : t.name + ' · ' + (nameOf[t.paidBy] || '?')),
          escapeHtml(fmtMoney(t.amount)));
      });

      f.open.forEach(function (o) {
        if (o.need.indexOf(u.UserId) === -1) return;
        if ((o.txn.reviewDone || []).indexOf(u.UserId) !== -1) return;
        reviewCount++;
        if (reviewCount > 8) return;
        reviewRows += mailRow(escapeHtml(o.txn.name || 'Settle up'), escapeHtml(fmtMoney(o.txn.amount)), '#F79F1F');
      });
    });

    // Nothing moved and nothing is waiting: say nothing. An inbox that only
    // hears from you when there is something to hear is one people keep on.
    if (!newCount && !reviewCount) return;

    var blocks = '';
    if (reviewCount) {
      blocks += '<div style="background:#FFF6E6;border-radius:15px;padding:14px 16px;margin-bottom:16px">' +
        '<div style="font-weight:800;font-size:15px">👀 ' + reviewCount +
        (reviewCount === 1 ? ' entry needs' : ' entries need') + ' your sign-off</div>' +
        mailTable(reviewRows) + '</div>';
    }
    blocks += '<div style="font-size:12.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;' +
      'color:#8A84A6;margin-top:8px">Where you stand</div>' + mailTable(balRows);
    if (newCount) {
      blocks += '<div style="font-size:12.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;' +
        'color:#8A84A6;margin-top:20px">' + newCount + (newCount === 1 ? ' new or changed entry' : ' new or changed entries') + '</div>' +
        mailTable(newRows) +
        (newCount > 12 ? '<p style="margin:8px 0 0;font-size:13px;color:#8A84A6">…and ' + (newCount - 12) + ' more.</p>' : '');
    }

    var headline = Math.abs(total) < 0.005 ? 'You are all square'
      : total > 0 ? 'You are owed ' + fmtMoney(total)
                  : 'You owe ' + fmtMoney(Math.abs(total));
    try {
      sendMail(u.Email, headline, mailShell(headline,
        'Across ' + mine.length + (mine.length === 1 ? ' ledger.' : ' ledgers.'), blocks, 'Open the app'));
      sent++;
    } catch (e) { skipped++; }
  });

  // Only move the cursor on a full run — a single test send must not eat
  // everybody else's "what's new".
  if (!only && maxRev > since) setCfg('lastDigestRev', String(maxRev));
  return { sent: sent, skipped: skipped };
}

/** Admin button: send just me one, right now, whatever the schedule says. */
function testDigest(me) {
  if (!me.Email) throw new Error('NO_EMAIL_ON_FILE');
  if (mailQuota() < 1) throw new Error('MAIL_QUOTA_EXHAUSTED');
  var r = runDigest(me.UserId);
  return { sent: r.sent, quiet: r.sent === 0 };
}

/* ---- nudges -------------------------------------------------------------- */

/* Six hours between nudges to the same person on the same ledger — also the
   longest the script cache will hold a key, which is why it is not a day. */
var NUDGE_COOLDOWN_SEC = 21600;

/**
 * "You owe me money." Sent by a person, not the system, so it carries their
 * name and is rate-limited per pair per ledger — a reminder that can be fired
 * twenty times in a row is harassment, not a reminder.
 *
 * The amount is recomputed here rather than trusted from the client, so nobody
 * can email a housemate a number they made up.
 */
function nudge(me, p) {
  var l = assertMember(me, p.ledgerId);
  var target = findUser('UserId', p.userId || '');
  if (!target) throw new Error('NO_SUCH_USER');
  if (target.UserId === me.UserId) throw new Error('CANNOT_NUDGE_SELF');

  var ids = memberIdsOf(p.ledgerId);
  if (ids.indexOf(target.UserId) === -1) throw new Error('NOT_A_MEMBER');
  if (isEntity(target)) throw new Error('NOT_A_PERSON');
  if (!target.Email) throw new Error('NO_EMAIL_ON_FILE');
  if (!notifyOn(target)) throw new Error('NOTIFY_OFF');

  var net = balancesOf(l, ids);
  var owed = round2(-(net[target.UserId] || 0));       // positive: they are in the red
  var mine = round2(net[me.UserId] || 0);
  if (owed < 0.01) throw new Error('NOTHING_OWED');
  if (mine < 0.01) throw new Error('YOU_ARE_NOT_OWED');
  var amount = round2(Math.min(owed, mine));           // never ask for more than you are owed

  var cache = CacheService.getScriptCache();
  var key = 'nudge:' + me.UserId + ':' + target.UserId + ':' + p.ledgerId;
  if (cache.get(key)) throw new Error('NUDGE_TOO_SOON');
  if (mailQuota() < 1) throw new Error('MAIL_QUOTA_EXHAUSTED');

  var from = me.DisplayName || me.Username;
  var title = from + ' nudged you about ' + l.Name;
  var body = mailShell(
    'Settling up on ' + (l.Emoji || '💸') + ' ' + l.Name,
    escapeHtml(from) + ' sent you a friendly reminder.',
    '<div style="background:#F6F4FF;border-radius:15px;padding:18px;text-align:center">' +
    '<div style="font-size:13px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#8A84A6">You owe</div>' +
    '<div style="font-size:34px;font-weight:900;margin-top:4px">' + escapeHtml(fmtMoney(amount)) + '</div>' +
    '<div style="font-size:14px;color:#4A4368;margin-top:6px">to ' + escapeHtml(from) + '</div></div>' +
    (p.note ? '<p style="margin:16px 0 0;font-size:15px;line-height:1.55;font-weight:600">“' +
      escapeHtml(String(p.note).slice(0, 300)) + '”</p>' : ''),
    'Settle up in the app');

  sendMail(target.Email, title, body);
  cache.put(key, '1', NUDGE_COOLDOWN_SEC);
  return { ok: true, amount: amount, to: target.DisplayName || target.Username };
}

/* -------------------------------------------------------------------- utils */

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
