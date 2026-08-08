# SplitStack — setup guide

Shared expenses for housemates, trips, groups and family. Your Google Sheet is the database,
your Google account is the server, and nothing else is involved.

**Total setup time: about 10 minutes.** You only do this once.

---

## What you're building

```
   Your phone / laptop                Your Google account
  ┌────────────────────┐            ┌──────────────────────┐
  │  SplitStack PWA    │  https     │  Apps Script web app │
  │  (installed app)   │ ─────────► │  (the API)           │
  │                    │            │          │           │
  │  IndexedDB cache   │            │          ▼           │
  │  works offline     │            │  Your Google Sheet   │
  └────────────────────┘            │  · Users             │
                                    │  · Ledgers           │
                                    │  · Members           │
                                    │  · Config            │
                                    │  · one tab per ledger│
                                    └──────────────────────┘
```

Every ledger you create becomes its own tab in the workbook, exactly as you asked.
Usernames and passwords live on one shared `Users` tab, so one login works across every ledger.

---

## Part 1 — The backend (5 minutes)

### 1. Make the spreadsheet

Go to [sheets.new](https://sheets.new) and name it something like **SplitStack Data**.
Leave it empty — the script builds every tab it needs.

### 2. Add the script

In that sheet: **Extensions ▸ Apps Script**.

Delete the `function myFunction() {}` placeholder, then paste in the entire contents of
**`Code.gs`**. Click the 💾 save icon.

### 3. Run `setup()`

In the toolbar, make sure the function dropdown says **setup**, then click **▶ Run**.

Google will ask for permission the first time:

- *"Google hasn't verified this app"* → click **Advanced** → **Go to (your project name)**
- Then **Allow**

This is normal. You're authorising *your own* script to edit *your own* sheet.

When it finishes, a dialog shows your **SETUP KEY** — six characters like `A3F91C`.
Write it down. If you miss it, run the `showSetupKey` function to print it again
(look in **Execution log** at the bottom).

### 4. Deploy it as a web app

**Deploy ▸ New deployment**

- Click the ⚙️ gear next to "Select type" → **Web app**
- Description: `SplitStack API`
- **Execute as: Me**  ← must be Me
- **Who has access: Anyone**  ← must be Anyone
- **Deploy**

> "Anyone" sounds alarming but is required — it means anyone can *reach* the URL, not that
> anyone can *read your data*. Every request still has to pass the username/password check.
> Without this, the app can't talk to the script at all.

Copy the **Web app URL**. It looks like:

```
https://script.google.com/macros/s/AKfycb.....................lQ/exec
```

Keep it handy — you'll paste it into the app in a moment.

---

## Part 2 — The app (5 minutes)

The app is four static files. It needs to be served over **HTTPS** (browsers require that for
password hashing, offline caching, and "Add to Home Screen"). Opening `index.html` off your
hard drive won't work.

Pick whichever of these you like — all free:

### Option A — Netlify Drop (easiest, no account needed to start)

1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the whole folder (`index.html`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/`) onto the page
3. You get a URL like `https://silly-name-123.netlify.app` — done

### Option B — GitHub Pages

1. Create a repo, upload the files to the root
2. **Settings ▸ Pages ▸ Source: main / (root)**
3. Your app lives at `https://yourname.github.io/reponame/`

### Option C — Cloudflare Pages

Connect the repo, leave the build command blank, set the output directory to `/`.

**Whichever you pick, keep the file layout intact:**

```
index.html
app.js
sw.js
manifest.webmanifest
icons/
  icon-192.png
  icon-512.png
  maskable-512.png
  favicon.png
```

---

## Part 3 — First run

1. Open your app URL.
2. Paste the **/exec URL** from step 4 → **Connect**.
3. It recognises there's no admin yet and shows the admin setup screen.
4. Enter your **setup key**, your name, a username and a password (8+ characters) → **Create admin account**.

The setup key is burned on use — nobody can claim admin a second time.

**Install it properly:**

- **iPhone/iPad:** open in Safari → Share → *Add to Home Screen*
- **Android:** Chrome will offer *Install app*, or Menu → *Add to Home screen*
- **Desktop:** Chrome/Edge show an install icon in the address bar

Once installed it runs full screen, keeps working with no signal, and syncs when you're back online.

---

## Part 4 — Adding people

### Create a ledger

Tap **+** on the home screen. Give it a name, an icon, a colour, and tick who's in it.
A new tab appears in your spreadsheet immediately.

### Two ways to get someone in

**The invite-link way (recommended)** — they pick their own password, you never handle it:

1. **Settings ▸ People ▸ + Add a person**. Fill in their name and username.
   **Leave both password fields blank.**
2. Add them to a ledger (Settings ▸ Ledgers ▸ tap the ledger ▸ tick their name).
3. Open the ledger and tap ✉️ → **Copy link**. Text it to them.
4. They open it, tap their own face under *Claim your seat*, choose a password, and they're in.

**The set-it-yourself way** — you pick a password and tell them what it is.
Same as above, but fill in the password fields. They can change it later from their profile.

### Someone who already has an account

Send them the same invite link. They tap **Log in and join** and the ledger is added to their list.

### Regenerating a link

✉️ → **Generate a new link** kills the old one instantly. Do this if a link leaks.

---

## How the money math works

Every expense is stored as **percentages**, which keeps splits meaningful even if you edit
the amount later.

- **Equal** is the default and includes the payer, as you specified.
- **%** lets you type exact percentages. Tap 🔒 on anyone whose share should stay put while the
  others rebalance around them.
- **$** lets you type dollar amounts — the app converts them to percentages behind the scenes.

Because a three-way split can't be expressed exactly in percentages, the app allocates real money
to the cent using largest-remainder rounding: shares always add up to the exact total, and every
device computes the identical split, so balances never drift by a penny.

**Balances** show what each person is net owed (green) or owes (red).
**Simplest way to settle** computes the fewest possible transfers that zero everyone out —
with five people that's usually four payments instead of ten.

**Record a payment** (🤝) logs actual money changing hands and adjusts the balances. It doesn't
delete anything, so the history stays honest.

---

## What's in the spreadsheet

| Tab | What it holds |
|---|---|
| `Users` | One row per person: username, display name, role, salt, iterations, verifier, avatar, colour |
| `Ledgers` | One row per ledger: name, sheet tab name, icon, colour, invite token, archived flag |
| `Members` | Which people belong to which ledgers |
| `Config` | App name, currency, symbol, receipt folder id |
| *(one per ledger)* | The actual transactions |

Each ledger tab has these columns:

`TxnId` · `Type` · `Date` · `Name` · `Category` · `Amount` · `PaidBy` · `PaidTo` ·
`EnteredBy` · `SplitPct` · `Notes` · `ReceiptId` · `Deleted` · `CreatedAt` · `UpdatedAt` · `Rev`

You can read and filter these freely, and build your own pivot tables and charts against them.

> **One rule: read freely, write through the app.**
> `Rev` is a strictly increasing revision number and it is what drives incremental sync — phones
> ask "give me everything above revision N". Don't edit `TxnId` or `Rev` by hand.
>
> If you *do* type a row in directly, it has no `Rev`, so phones won't pick it up on a normal
> sync. Everyone can run **Profile ▸ Rebuild local data** to pull it in.
>
> To remove an expense, delete it inside the app. It sets the `Deleted` flag rather than removing
> the row, which is what lets other devices learn about the deletion.

---

## About the passwords

You asked for encrypted passwords in the sheet. Here's what actually happens, which is stronger
than encryption for this purpose:

1. Your browser stretches your password with **PBKDF2-HMAC-SHA256, 210,000 iterations**, using a
   random 16-byte salt unique to you.
2. Only the derived key is sent to the server — **your actual password never leaves your device.**
3. The server HMACs that derived key with a secret "pepper" stored in Script Properties
   (*not* in the spreadsheet) and stores only the result.

So the sheet holds a verifier that is useless on its own. Someone who steals the whole spreadsheet
still can't log in as anyone or recover a password, because the pepper isn't in there. Even *you*
as the admin can't read anyone's password — you can only reset it.

Sessions are stateless signed tokens with a 60-day expiry. Changing or resetting a password,
disabling an account, or using **Sign out other devices** invalidates every existing session for
that person immediately.

### Brute-force protection

Eight wrong passwords freezes that username for fifteen minutes, and each wrong attempt before
that gets progressively slower (¼ second, then ½, and so on). A correct login resets the counter.
Lockouts are per-username, so one person getting locked out doesn't affect anyone else, and they
expire on their own — no cleanup needed.

The same protection covers the setup key and the password-change form. If someone needs back in
sooner, an admin doesn't have to wait it out — that's what `adminUnlock` is for.

There's also a spray guard: if failures spike across *many* accounts at once, every login slows
down until the wave passes.

### Username enumeration

Ask for the salt of an account that doesn't exist and you get a decoy — same length, same
alphabet, same iteration count, and stable for that name so it doesn't change between tries. Wrong
password and no-such-user return the identical error. There is no way to use the login screen to
work out who has an account.

### The shared access phrase (optional, off by default)

**Settings ▸ Security ▸ Shared access phrase.**

When it's on, the server won't answer *anything* except a bare version check until the phrase is
supplied — the login screen isn't even reachable. Each person types it once per device, on top of
their own password.

Worth turning on if your `/exec` URL ever leaks, or if you just want a second wall. Only a
verifier is stored, so the phrase itself isn't in your spreadsheet either.

Be clear-eyed about what it is, though: **one shared value that everyone knows.** It does not
rotate when someone moves out — you have to change it, and then everybody re-enters it. It raises
the wall around the building; your per-user passwords are still what lock the individual doors.
It's a supplement, never a replacement.

> Turning it on or changing it signs nobody out, but every device will ask for the new phrase the
> next time it syncs. Have it ready before you change it.

---

## Offline behaviour

- The interface, your ledgers and every transaction are cached locally in IndexedDB.
- Adding, editing and deleting expenses all work with no connection. They show a small
  *"syncing"* marker.
- Changes go into an ordered outbox and replay when you're back online — automatically on
  reconnect, when you reopen the app, and whenever you tap **Sync now**.
- Every transaction carries a client-generated id, so a replayed queue can never create duplicates.
  This is tested: pushing the same entry three times produces exactly one row.
- Receipt photos queue too, and upload when the connection returns.

---

## Troubleshooting

**"Couldn't reach it. Check the URL…"**
Nearly always one of: the URL ends in `/dev` instead of `/exec` (the app auto-corrects this, but
check), or the deployment access isn't set to **Anyone**. Re-deploy with
**Deploy ▸ Manage deployments ▸ ✏️ ▸ Who has access: Anyone**.

**I changed `Code.gs` and nothing happened.**
Apps Script serves the *deployed* version, not the saved one. Go to
**Deploy ▸ Manage deployments ▸ ✏️ edit ▸ Version: New version ▸ Deploy**.
The URL stays the same.

**I lost the setup key / need to start the admin account over.**
Run `resetAdminClaim()` in the Apps Script editor. It clears the admin's password and prints a
fresh setup key in the execution log.

**Someone locked themselves out.**
It clears itself after fifteen minutes. To do it now, run `adminUnlock({username:'sam'})` in the
Apps Script editor, or call it from an admin account in the app.

**I turned the access phrase on and forgot it.**
In the Apps Script editor, open the `Config` tab of your spreadsheet and delete the value in the
`gateVerifier` row. That switches the gate off. You can set a new one from Settings afterwards.

**Login says my password is wrong and I'm certain it isn't.**
Check the page is on `https://`. Password hashing needs a secure context, and it silently has
nothing to work with on `http://`.

**Someone's changes aren't showing up.**
Have them tap **Sync now** on the home screen. If it's still off,
**Profile ▸ Rebuild local data** re-downloads everything from the sheet.

**A ledger looks wrong after I edited the sheet by hand.**
Use **Profile ▸ Rebuild local data**. If you deleted rows directly, that's expected — delete
inside the app instead.

**The app won't update after I re-upload the files.**
See *Updating the app* below — there's a button for this now.

---

## Updating the app

Installed PWAs are cached aggressively — that's what makes them work offline, and it's also what
makes them feel stuck on an old version. Three things now handle it.

**1. Code is fetched network-first.** `index.html` and `app.js` go to the network first every
time, falling back to cache only if the network is slow or absent. So when you're online, simply
reopening the app gets the newest code. This is the main fix; previously the code was served
cache-first, which meant a new build only appeared a launch or two later.

**2. The app tells you.** When a new version is detected, a purple *"A new version is ready"*
banner appears at the top of every screen. Tap it and the app restarts on the new build. It checks
on launch and whenever you bring the app back to the foreground (at most every 30 minutes).

**3. There are buttons.** **Profile ▸ App & updates**:

| Button | What it does |
|---|---|
| **Check for updates** | Re-fetches the service worker *and* compares the deployed `app.js` build against the running one. Catches the case where you re-uploaded files but didn't bump a version. |
| **Restart to update** | Appears when an update is waiting. Activates it and reloads. |
| **Clear cache & reload** | The nuclear option. Deletes every cache, unregisters the service worker, reloads from scratch. Use if it's still somehow stuck. |

None of these touch your ledgers, your login, or anything queued offline — that all lives in
IndexedDB, separately from the app cache. If you have unsynced changes, *Clear cache & reload*
warns you first.

### When you re-upload a new build

Bump both version constants so the app can name what it's running:

- `APP_BUILD` at the top of `app.js`
- `SW_BUILD` at the top of `sw.js`

Keep them identical. Strictly speaking this is optional — network-first means fresh code arrives
either way — but bumping `SW_BUILD` is what makes the service worker itself update, and it's what
Settings displays.

---

## Things worth knowing

- **Google's quotas** are generous for this: 20,000 URL-fetch-free script calls/day and
  90 minutes of runtime. A household of five won't come close.
- **Receipts** are stored in a Drive folder called *SplitStack Receipts — (your sheet name)*,
  not inside the spreadsheet, so the sheet stays fast.
- **Avatars** are stored as small compressed images directly in the `Users` tab.
- **Backups** — the spreadsheet has full revision history (**File ▸ Version history**). You already
  have a complete audit trail for free.
- **Multiple admins** are supported. Settings ▸ People ▸ tap someone ▸ Role: Admin. The app won't
  let you remove or disable the last remaining admin.
- **Archiving** a ledger hides it from the main grid without deleting anything.

---

## Files

| File | Purpose |
|---|---|
| `Code.gs` | The whole backend. Paste into Apps Script. |
| `index.html` | Markup and the full design system. |
| `app.js` | The application: sync engine, offline queue, money math, every screen. |
| `sw.js` | Service worker — offline app shell. |
| `manifest.webmanifest` | Makes it installable. |
| `icons/` | App icons, including a maskable one for Android. |
