# Foundation prompt — Sheets-backed, offline-first PWA

Copy everything below the line into a new project to get the same foundation
SplitStack is built on: a Google Apps Script backend over a spreadsheet you own,
and a static PWA whose service worker is a good neighbour on a shared origin.

Fill in the four bracketed blocks at the top and delete the rest of this page.

---

## What I want you to build

Build **[APP NAME]** — [one sentence: what it is and who uses it].

The data it keeps:

- [entity, e.g. "Expense — date, amount, who paid, how it splits"]
- [entity]
- [entity]

The people who use it: [e.g. "a household of 2–10; one admin, everyone else a
member; members see everything on ledgers they belong to"].

Non-negotiable about the foundation: it must work offline on a phone, it must
store its data in a Google Sheet the user owns, and it must not require the user
to run a server, install Node, or sign up for anything but Google.

## The shape of the deliverable

Static files, no build step, no npm, no framework, no bundler, no CDN. A user
must be able to drag the folder onto Netlify Drop and have a working app.

```
index.html            markup shell + all CSS (design tokens in :root, dark mode
                      via prefers-color-scheme), CSP meta tag, no inline script
app.js                the entire client: state, router, views, sync, IndexedDB
sw.js                 service worker (see "Service worker isolation")
manifest.webmanifest  relative start_url and scope ("./"), icons, shortcuts
icons/                192, 512, maskable-512, favicon
Code.gs               the entire backend, one file, pasted into Apps Script
appsscript.json       runtime + oauthScopes + webapp deployment settings
SETUP.md              the illustrated guide a non-developer follows
build-demo.js         builds demo.html (see "Demo build")
```

Client code is modern ES (async/await, classes, optional chaining). `Code.gs` is
V8 but written in `var`/`function` style — Apps Script stack traces are friendlier
that way and the file gets pasted around by hand.

Comments explain *why*, not what. A comment that restates the line below it is
noise; a comment that records the trap you avoided is the most valuable thing in
the file. Match that density.

## Backend: Google Apps Script over one spreadsheet

**Deployment model.** One spreadsheet, `Extensions ▸ Apps Script`, deployed as a
web app with `executeAs: USER_DEPLOYING` and `access: ANYONE_ANONYMOUS`. The
script runs as the owner, so it can touch their sheet; "anyone" is what makes it
reachable without a Google login, which is why the app has its own auth (below).
Request the narrowest `oauthScopes` that actually work and list them explicitly
in `appsscript.json` — never let Apps Script infer them.

**One entry point.** `doPost(e)` parses `e.postData.contents` as JSON and routes
on a single envelope:

```js
{ action: 'push', token: '<session token>', gate: '<optional phrase>', payload: {…} }
→ { ok: true, data: {…} }  |  { ok: false, error: 'CODE_LIKE_THIS' }
```

`route()` is a flat switch in three tiers: `ping` (no auth, reports API version
and whether setup is done), unauthenticated actions (login, salt lookup, invite
claim), then everything else behind `requireAuth(req.token)`, with admin actions
guarded by an extra `requireAdmin(me)`. Errors are thrown as short stable codes;
the client owns the human wording.

`doGet(e)` returns a small HTML status page, not JSON — opening the `/exec` URL
in a browser is how people check whether their deployment worked, so answer that
question in plain English. It must never print secrets.

**The sheet is the database.** One tab per collection, a header row of column
names, one row per record. Access rows by header *name*, never by index:

- `readTab(name, cols)` → array of objects, each carrying `__row`
- `appendRow` / `updateRow` — one read + one write per row, never per field
- `appendRows` — a single `setValues` for a whole batch (quota matters)
- `ensureColumns(sheet, cols)` adds any column a newer version expects, guarded
  by a `SCHEMA_VERSION` stamp in Script Properties so the migration runs once
  ever and upgrading is nothing but a copy-paste of `Code.gs`. Writes to a column
  that doesn't exist are silently dropped, which is how a new feature ends up
  doing nothing at all.
- Wrap every write path in `LockService.getScriptLock()` with a ~25s wait.
- A `Config` tab of `Key`/`Value` pairs holds instance settings; cache it per
  request and invalidate on write.
- Secrets and counters live in Script Properties, never in the sheet.

**Delta sync.** Every record row carries `CreatedAt`, `UpdatedAt` and a `Rev`.
Revisions come from a monotonic counter — `Math.max(Date.now(), last + 1)`,
persisted in Script Properties, reserving a block per batch. `Date.now()` alone
collides inside a millisecond, and a client sitting on that cursor never hears
about the second write.

- `pull({ since: { [collectionId]: cursor } })` returns only rows newer than the
  cursor, plus the new cursor and a `full: since === 0` flag.
- `push({ id, records, since })` is an idempotent upsert — **the client generates
  record ids**, so replaying a queued offline batch can never duplicate anything.
  It returns the merged truth (`applied`, changed rows, new cursor) so the client
  reconciles in the same round trip.
- Fields absent from a push mean "unchanged", not "cleared". Be explicit about
  this in code and comments; guard on `undefined`, not falsiness.
- Server-authoritative fields (who wrote a row, timestamps) are taken from the
  session, never from the request body.

**Jobs and blobs.** Recurring work runs on time-driven triggers installed by a
menu item, with handlers listed in one array so they can be verified and
reinstalled. Binary data (photos, attachments) goes to a Drive folder, with the
file id stored in the row; delete the old file when a row stops pointing at it,
after the row commits, so a Drive failure leaves a stray file rather than losing
a save.

**A menu in the spreadsheet.** `onOpen()` installs a menu for routine admin —
show setup key, deployment links, install/verify jobs, unlock an account, reset
the admin claim. Nobody should need the Apps Script editor after the first paste.

## Auth without Google sign-in

Users have accounts in the app, not Google accounts.

- **Setup key.** `setup()` prints a one-time key. The first person to present it
  claims the admin account. The key is reachable only through the spreadsheet
  menu — never printed by `doGet`.
- **PBKDF2 in the browser.** 210,000 iterations, SHA-256, per-user 16-byte salt.
  The server receives only the derived key and stores `HMAC(pepper, 'v1:' + dk)`,
  so a leaked spreadsheet can't be replayed against the API. The pepper is a
  random 32-byte value generated on first use into Script Properties.
- **Client-side floor.** The client refuses any iteration count below the
  constant it ships with, whatever the server claims — a downgrade turns login
  into a plaintext password with extra steps.
- **Tokens.** `base64(userId|expiry|tokenVer) + '.' + HMAC(pepper, payload)`,
  60-day expiry, verified with a constant-time compare. Bumping the user's
  `TokenVer` signs every device out; that's the "sign out everywhere" feature and
  the account-disable path in one field.
- **No enumeration.** An unknown username gets a *stable decoy salt* derived from
  the pepper — same length and alphabet as a real one. "That account is disabled"
  is only ever said after the password checks out.
- **Brute force.** Count failures per username in `CacheService` (lock after ~8
  for 15 minutes, so the window expires on its own), plus a global spray counter
  that slows everyone down after a flood. An admin menu item clears a lockout.
- **Optional gate.** A shared access phrase, off by default, checked before
  everything except `ping`. Stored as a verifier, not a phrase.
- Constant-time comparison for every secret. Validate hex widths on salt and
  derived key before touching them.

## Client transport

```js
fetch(apiUrl, {
  method: 'POST',
  redirect: 'follow',                                   // Apps Script 302s
  headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // dodges preflight
  body: JSON.stringify({ action, token, gate, payload })
})
```

`text/plain` is load-bearing: Apps Script never answers an `OPTIONS` preflight, so
any header that makes the request non-simple breaks it. No custom headers, ever.
Wrap in an `AbortController` with a ~45s timeout, treat a network throw as
`OFFLINE` rather than an error dialog, and map error codes to human sentences in
one lookup table on the client.

## Offline-first client

IndexedDB with four stores: `kv` (state snapshot, cursors), the record store
(keyed `collectionId|recordId`, indexed by collection), `outbox`
(autoIncrement `seq`), and `blobs`.

Every mutation writes locally, marks the record `_local`, queues an outbox item,
and renders immediately. A single `sync()` — never re-entrant — then:

1. Drains the outbox **in order**, blobs before the rows that reference them,
   unqueueing each item only after the server acknowledges it.
2. Pulls deltas per collection using the stored cursors, and merges — where a
   record still sitting in the outbox always wins over the server copy until it
   lands.
3. Persists records and cursors back to IndexedDB.

`OFFLINE` aborts the drain and leaves the queue intact. `UNKNOWN_ACTION` means
the user is running an older `Code.gs` than the app expects: hold the queue and
tell them to update, rather than throwing their work away. A rejection on the
merits is surfaced as a toast and dequeued. The client ships a `NEEDS_API`
constant and compares it against `ping`'s version to explain the mismatch.

## Service worker isolation

This is the part that is easy to get wrong, and getting it wrong breaks *other
people's* apps. On a host like `user.github.io`, several PWAs sit in
subdirectories of one origin. A service worker is scoped to its directory, but
**CacheStorage and the service worker registry are keyed by origin**, so
`caches.keys()` hands you every neighbour's caches, `caches.match()` will happily
answer out of one, and `getRegistrations()` lists their workers. Written the
obvious way, "clear the cache and re-register" silently uninstalls the app next
door.

Requirements:

- **Derive the scope, never hardcode it.** In `sw.js`:
  `const SCOPE = new URL('./', self.location.href).pathname;` and in `app.js`:
  `const APP_SCOPE = new URL('./', document.baseURI).pathname;`. The app must
  work unchanged at a domain root or in any subdirectory.
- **Namespace the caches**: `const CACHE_NS = '<app>@' + SCOPE + ':';`. The
  trailing colon matters — without it a copy installed at `/` would claim
  `/<app>/`'s caches as its own. Never read, write, or delete a cache whose name
  doesn't start with `CACHE_NS`. Open your own cache by name; never call the
  origin-wide `caches.match()`.
- **Answer only for yourself.** In `fetch`: ignore non-`GET`, ignore the API
  origin entirely, ignore cross-origin requests, and ignore same-origin requests
  whose path doesn't start with `SCOPE` — let the neighbour's request go to the
  network untouched and take no copy of it.
- **Register with an explicit scope**: `register(APP_SCOPE + 'sw.js', { scope:
  APP_SCOPE, updateViaCache: 'none' })`. A relative script URL resolves against
  the document while the manifest's resolves against `<base>`; pinning both keeps
  them from drifting.
- **Caching strategy.** Code (HTML/JS/CSS/manifest/JSON) is **network-first**
  with a ~3.5s timeout and cache fallback — serving `app.js` cache-first is what
  makes a PWA feel permanently out of date. Artwork is **cache-first**. The API
  is never touched: `app.js` owns offline behaviour through IndexedDB.
- **Never `skipWaiting()` on install.** A new worker waits; the app notices
  (`updatefound` → `installed` with a controller present), shows "a new version is
  ready", and only on the user's tap posts `skipWaiting` and reloads on
  `controllerchange`. Code must not swap out from under someone mid-edit.
- **Version visible.** `SW_BUILD` in `sw.js` and `APP_BUILD` in `app.js`, bumped
  together, shown in Settings. The update check also fetches `app.js?probe=<ts>`
  with `cache: 'no-store'` and compares the `APP_BUILD` literal, which catches a
  re-upload where `sw.js` itself didn't change. A `message` channel handles
  `version`, `skipWaiting` and `clearCaches`.
- **Hard reset stays inside the fence**: delete only caches in `CACHE_NS`, and
  unregister only `getRegistration(APP_SCOPE)` — never `getRegistrations()`.
- Prefix `localStorage` keys with a short app prefix and give IndexedDB a name
  unique to this app; both are per-origin too.
- Sweep pre-namespace cache names from earlier builds of *your own* app, matched
  by a pattern only your app ever wrote.

## Security posture

A CSP `<meta>` in `index.html`: `default-src 'none'`, `script-src 'self'`, no
inline script at all, `connect-src 'self' https://script.google.com
https://*.googleusercontent.com`, `img-src 'self' data: blob:`, `base-uri 'none'`,
`form-action 'none'`, `frame-ancestors 'none'`. `style-src` may keep
`'unsafe-inline'` if the design uses inline style attributes — say so in a comment
and keep script clean. Escape everything user-supplied on both sides. Never write
a formula into a cell from user input (prefix a leading `=`, `+`, `-`, `@`).

## Demo build

`build-demo.js` (plain Node, no dependencies) assembles `demo.html`: `index.html`
with `app.js` inlined, the IndexedDB layer swapped for an in-memory object, a stub
`localStorage`, `navigator.serviceWorker` stubbed out, and a fake backend that
answers every action from seeded sample data. It must open straight off `file://`
so the app can be tried with zero setup.

## SETUP.md

Written for someone who has never opened Apps Script: make the sheet, paste the
script, run `setup()`, deploy as a web app, host the static files (Netlify Drop /
GitHub Pages / Cloudflare Pages), first run, inviting people. Then the reference
half — what each tab holds, how the passwords work, how to narrow the OAuth
scopes, offline behaviour, troubleshooting, and how to update the script and the
app. Screenshots described in words where they'd help.

## How to work

Build it in one pass and make it complete: every action in `route()` implemented,
every view reachable, the outbox draining, the service worker isolated. Don't
scaffold and leave TODOs. When a decision has a trap behind it — the ones above
are all real ones — leave the comment that explains it.
