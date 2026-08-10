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

This is normal. You're authorising *your own* script to edit *your own* sheet, plus two things
that follow from that: permission to run on a timer (repeating expenses post themselves at about
3am) and permission to send mail as you (the email summaries). Both are switched on for you here.

When it finishes, a dialog shows your **SETUP KEY** — six characters like `A3F91C`, and a line
confirming background jobs are on. If it says they aren't, run `setup()` again and accept the
permission prompt — everything else works without them, but nothing repeats and no email goes out.

Now go back to your spreadsheet tab and **reload the page**. A new **SplitStack** menu appears in
the menu bar, next to Help. That's where everything lives from now on — you shouldn't need the
Apps Script editor again.

> Lost the key? **SplitStack ▸ Show setup key**.

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

Keep it handy — you'll paste it into the app in a moment. (This is the only time you'll ever paste
it by hand. After your first sign-in, the app hands out self-configuring links instead.)

**Want to check it worked?** Open that URL in a browser tab. You should get a friendly
*"Backend is live"* page rather than an error or a wall of JSON. If you see that page, the hard
part is done.

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

That's genuinely all they do. **The link carries your backend address with it**, so a brand-new
phone that has never heard of SplitStack goes straight from the text message to "choose a
password" — no URLs to paste, no setup key, nothing to explain. Tell them to *Add to Home Screen*
afterwards and they're done.

**The set-it-yourself way** — you pick a password and tell them what it is.
Same as above, but fill in the password fields. They can change it later from their profile.

### Members who aren't people

Not everyone on a ledger has a phone. **Settings ▸ People ▸ + Add someone** offers two kinds:

| | |
|---|---|
| 👤 **Person** | Gets a login, an invite link, and email. What you've always had. |
| 🏢 **Not a person** | Holds a balance and takes a share of a split. Nothing else. |

Use the second for an employer you claim expenses back from, a house kitty, a landlord, or
somebody who is simply never going to install this. All you give it is a name, a colour and
optionally a badge emoji — no username, no password, no email, because none of them would mean
anything.

It behaves like any other member where money is concerned: it can pay for things, take a share,
carry a balance, and appear in *Simplest way to settle*. It's shut out of everything that assumes
a human — it can't sign in, it's never offered as a claimable seat on an invite link, it's never
emailed or nudged, and it can't be an admin.

**They're squared off rather than round**, so a split row shows at a glance that one of the shares
belongs to a company rather than a housemate.

> Someone who has already set a password can't be turned into a non-person — they'd have a working
> login for an account the app no longer offers a way into. Remove them and add the entity instead.

### Someone who already has an account

Send them the same invite link. They tap **Log in and join** and the ledger is added to their list.

### Adding a device for yourself

**SplitStack ▸ Show app links** in your spreadsheet gives you a one-tap link that configures any
device by itself. The same link appears on the *"Backend is live"* page at your `/exec` URL. Handy
for setting up your own tablet, or for someone who needs the app but isn't on a ledger yet.

### Regenerating a link

✉️ → **Generate a new link** kills the old one instantly. Do this if a link leaks — and note that
because invite links now carry your backend address, a leaked link exposes that too. Regenerating
is the fix, and it takes one tap.

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

## When someone changes your expense

Everyone on a ledger can edit everything — that's deliberate, because the person with the receipt
isn't always the person who typed it in. What the app adds is that a change never happens quietly.

**If someone who didn't enter it changes it**, it's marked for review by whoever *did* enter it. They
see 👀 on the row, a count on the ledger tile, and a banner above the feed that filters the list down
to just the entries waiting on them. Opening it shows plain language about what moved — *Amount
$1,760.00 → $1,840.00 · Changed the split* — and two choices: **Looks right to me**, or **Put it back
the way it was**, which restores the previous values in one tap. Deleting someone else's expense
works the same way: it stays visible to them, struck through, until they sign the deletion off.

**If two people changed it at once** — both offline, say — the app can tell, because an edit carries
the revision it was built on. The later one still wins, as it always did, but it's marked as a
collision rather than an ordinary edit so the author knows two people were in there.

**To ask everyone to look**, open any expense and tap **👀 Ask everyone to review this**. Good for
placeholders, estimates and anything not yet final. Everyone splitting it signs off individually —
the row shows *2 of 4* until the last person agrees — and whoever raised it (or an admin) can
withdraw it early.

Reviews never change the money. An entry under review counts towards balances exactly like any
other, and the Balances tab says so rather than letting the numbers quietly disagree with the feed.
Signing off works offline like everything else; it queues and syncs when you're back.

---

**Finding an expense** — tap 🔍 in a ledger's header to filter the Expenses list as you type.
It matches the expense name and the amount, and every word you type has to land somewhere, so
`pizza 40` finds the $40 pizza and nothing else. Amounts are forgiving about formatting: `12.5`,
`$12.50` and `1,840` all find what you'd expect. Settlements match on who paid whom. The running
`3 matches · $9,600.00` line above the results totals what you're looking at. Search runs on the
copy already on your phone, so it works offline too.

---

## Getting paid

**Profile ▸ Getting paid.** Pick Venmo, PayPal.me, Cash App, Revolut, UPI — or paste any link —
and add your handle.

From then on, anyone who owes you sees a button on the Balances tab that opens that app **with the
amount already filled in**, then drops them straight into *Record a payment* so the ledger catches
up. It never moves money by itself; you both still confirm, in the app that actually holds it.

These are ordinary web links, so they work on a desktop browser and hand off to the installed app
on a phone.

---

## Arranging your home screen

**Profile ▸ Arrange your ledgers.** Move them up and down with the arrows, and switch archived
ledgers on or off. Every member gets this, not just admins.

**It's yours alone.** Reordering doesn't move anybody else's home screen — it's a view preference,
not shared data, so it isn't stored in the spreadsheet at all. That means two upshots worth
knowing:

- It's **per device**. Arrange your phone and your tablet keeps its own order.
- It **survives signing out** and *Clear cache & reload*, and two people signing in on the same
  device keep separate arrangements.

Leaving it alone changes nothing: with no arrangement saved, ledgers appear in the order they
always did. A ledger created after you last arranged things goes to the end rather than displacing
what you set. **Back to the default order** clears your arrangement rather than freezing a copy of
it, so new ledgers keep falling in naturally afterwards.

Hiding archived ledgers leaves a quiet line at the bottom of the home screen — *"2 archived
ledgers hidden"* — that takes you straight back to this screen, so nothing disappears without a
way back.

---

## Everyone, at a glance

The purple card on the home screen totals what you're owed across every ledger. **Tap it** and you
get it broken down per person instead: *Ada owes you $466.35* — made of *+$621.35* on the beach
house and *−$155.00* from the ski trip.

The numbers are the same settle-up suggestions each ledger's Balances tab already shows, added up,
so the two can never disagree. **Nothing settles from here on purpose** — a debt lives on its
ledger, and paying one house's balance with another's would leave both wrong. Each line links back
to where the money actually is.

---

## What's changed since you last looked

Open a ledger and, if anything landed since your last visit, a line at the top says so:
*"3 new since you last looked — Sam, Ada · $184.20"*.

Your own entries never count — you know about those. It's driven by the same revision counter the
sync engine runs on, so it's accurate even if you were offline for a week, and it clears itself
once you've been.

---

## Finding things

Tap 🔍 in a ledger's header and, alongside the text box, you get filter chips for **who paid** and
**which category**. They narrow whatever you've typed rather than replacing it, so *Ben · Groceries
· "wine"* is a valid question. Only the payers and categories actually used on that ledger are
offered, so the row stays short.

---

## Categories

**Settings ▸ Categories ▸ Expense categories** — rename them, change the icons, remove the ones
your household never uses, add the ones it does. Up to forty.

Removing one never rewrites history: past expenses keep the name they were filed under and just
fall back to a generic 🧾. There's a one-tap way back to the built-in list if you change your mind.

**The app also guesses.** Type "Uber to the airport" and it picks Transport; "Big Tesco shop" picks
Groceries. It only ever *pre*-selects — the moment you tap a category yourself it stops guessing
for that expense, because being quietly overruled by a keyword list is worse than choosing it
yourself. The matching runs entirely on your phone; nothing is sent anywhere.

---

## Expenses that repeat

Rent, the internet bill, the cleaner — the things somebody would otherwise retype every month.

**Setting one up** is part of logging it the first time. Fill in the expense as usual, and under
**Repeats** pick *Weekly*, *Monthly* or *Yearly*. The app tells you in plain words what it will
do — *"Posts on the 1st of each month — next on Sep 1"* — and the entry you just logged counts as
the first one, so the rule starts from the one after it.

From then on the ledger carries a **🔁 Repeating** card above the feed showing how many there are
and what lands next. Tap it to see them all; tap any one to change the amount, the payer, the
schedule or the date, to **pause** it, or to stop it entirely. Stopping a rule never touches the
entries it already posted — it just stops adding new ones.

**Tick "Ask everyone to check each one"** and every posted entry arrives marked for review, so a
rent rise gets noticed instead of quietly accruing. This uses the same sign-off flow as any other
[review](#when-someone-changes-your-expense).

A few things worth knowing:

- **The 31st behaves.** A monthly rule starting on the 31st posts on the 28th in February and goes
  back to the 31st in March. It doesn't drift.
- **Posted entries are ordinary entries.** You can edit them, delete them, attach a receipt,
  search them. Nothing downstream knows a rule put them there.
- **It can't double-post.** Each occurrence has an id derived from the rule and the date, so a job
  that runs twice — or catches up after the script was off for a week — still produces one row.
- **A long gap is capped.** If nothing ran for more than 24 periods, it skips the backlog rather
  than dumping two years of rent into your feed, and resumes from now.
- **If everyone in the split leaves the ledger**, the rule pauses itself instead of posting
  something wrong. It stays visible, switched off.

Rules are stored on a `Recurring` tab in your spreadsheet, and they need the daily trigger to
actually fire — see *"Nothing is repeating"* in [Troubleshooting](#troubleshooting).

---

## The default split

Not every ledger divides evenly. A couple whose rent goes 60/40, a house where one room is
bigger — retyping that on every expense is the sort of thing an app should do for you.

**Settings ▸ Ledgers ▸ tap the ledger ▸ Default split.** Choose *Evenly* (what every ledger did
before, and still the default) or *Custom*, then type the percentages once. From then on:

- **New expenses open already set that way**, in `%` mode rather than Equal.
- **Repeating rules inherit it** through the expense you create them from — so a repeating rent
  divides the way the house does, without being told again.
- A **⭐ Default** chip appears above the member toggles, so one tap puts it back after you've
  changed something for a one-off.

Anyone can still change any split on any expense. The default only decides where you start.

**It's admin-only**, because it's a statement of policy about how the household divides things
rather than a shortcut for whoever happens to be typing — [saved splits](#saved-splits) are the
latter, and those stay open to every member.

### When somebody joins

A default that names Mike and Sam says nothing about Ada. Rather than guess, the ledger's settings
say so plainly the moment you tick her on:

> ⚠️ **Ada isn't in it** — new expenses will leave her out unless you say otherwise.
> **Include her equally**

That button folds her in without throwing away the ratio between the people already there: 40/30/30
plus a fourth becomes 30/22.5/22.5/25, not a flat quarter each. Leaving her out is a legitimate
choice too — a house where one person pays their share separately — which is exactly why the app
surfaces it instead of deciding for you.

Somebody who *leaves* needs no decision, so there's no prompt: they drop out of the default and the
remaining shares rescale to total 100.

> Changing the default never rewrites a repeating rule that already exists — a standing instruction
> about money shouldn't move on its own. To bring one in line, open it under **🔁 Repeating** and
> tap **⭐ Use the default**.

---

## Saved splits

A house whose rent is 40/30/30 shouldn't have to type 40/30/30 every month.

In the expense sheet, set the split up however you like, then tap **＋ Save this split** under
*Split between* and give it a name. It becomes a chip — *🔖 Rent split* — that any member can tap
to load those percentages in one go. Twelve per ledger.

They're saved on the ledger, not on you, so everybody in the house gets them. Anyone on the ledger
can add and delete them; you don't have to be an admin. Saving over a name you've already used
replaces it rather than making a second chip that looks identical.

If somebody in a saved split leaves the ledger, the split still works — their share is dropped and
the rest is rescaled to add back up to 100.

---

## Email

Your Google account is already the server, so it can also be the mail server. No third-party
service, no API key, nothing leaves the account that holds the spreadsheet.

**The summary.** **Settings ▸ Notifications** sets it to *Off*, *Weekly* (Monday mornings) or
*Daily*. Everyone with an address on file gets where they stand across every ledger, what's
changed since the last one, and anything waiting on their sign-off. **A quiet week sends nothing
at all** — if nothing moved and nothing is waiting, there's no email, which is what stops it
becoming something people filter away. **Send me one now** does exactly that, to you only.

**Nudges.** On the Balances tab, anyone who owes *you* money gets a 👋 next to their line. It
emails them a friendly reminder with the amount and, if you want, a line of your own. Limited to
one per person per ledger every six hours, so it can't turn into pestering. The amount is
recomputed on the server from the ledger itself, so nobody can email a housemate a number they
made up.

**Everyone controls their own.** **Profile ▸ Email** is where you set your address and switch the
whole thing off. Off means no summaries *and* nobody can nudge you. No address on file means
nothing to send to, and everything else in the app behaves identically.

> Sending uses your Google account's own daily mail quota — 100 recipients a day on a personal
> account, 1,500 on Workspace. A household will never come close. If it ever runs out, the jobs
> stop for the day and pick up tomorrow rather than failing loudly.

---

## What's in the spreadsheet

| Tab | What it holds |
|---|---|
| `Users` | One row per member: username, display name, role, salt, iterations, verifier, avatar, colour, email preference, pay handle, and whether it's a person or not |
| `Ledgers` | One row per ledger: name, sheet tab name, icon, colour, invite token, archived flag, saved splits, default split |
| `Members` | Which people belong to which ledgers |
| `Recurring` | One row per repeating expense: the template, the schedule, and when it next fires |
| `Config` | App name, currency, symbol, receipt folder id, email schedule, category list |
| *(one per ledger)* | The actual transactions |

Each ledger tab has these columns:

`TxnId` · `Type` · `Date` · `Name` · `Category` · `Amount` · `PaidBy` · `PaidTo` ·
`EnteredBy` · `SplitPct` · `Notes` · `ReceiptId` · `Deleted` · `CreatedAt` · `UpdatedAt` · `Rev` ·
`ReviewState` · `ReviewBy` · `ReviewNote` · `ReviewDone` · `ReviewWas`

The last five track [reviews](#when-someone-changes-your-expense): `ReviewState` is empty, `edit`,
`conflict` or `flag`; `ReviewDone` lists who has signed off; `ReviewWas` holds the pre-edit values
that **Put it back** restores. Filter on `ReviewState` to see everything still open.

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

### Where the secrets come from

Every secret the backend mints — the pepper, the setup key, invite tokens — is drawn from
`Utilities.getUuid()`, which is backed by Java's `SecureRandom`, and stretched with SHA-256.
Nothing security-relevant uses `Math.random()`, which is fast, seeded, and reversible: given a
few of its outputs you can work out the rest of the stream in both directions.

> **Upgrading from a version before this?** Instances set up earlier generated their pepper with
> `Math.random()`. Pasting in the new `Code.gs` fixes everything minted from now on, but it cannot
> re-mint a pepper that is already in use — that value is what every stored password verifier is
> built on, so replacing it would lock everybody out. If your setup key was ever shared somewhere
> public, the tidy way to start over on new randomness is: **SplitStack ▸ Reset the admin account**,
> claim it again, then have everyone set a new password.

### What one member can reach

Being on a ledger gets you that ledger, and stops there.

- **Receipts.** A receipt is fetched by Drive file id, and the script runs as *you* — so an
  unchecked id would be a way to ask for any file in your Drive. Two things have to agree before
  the backend will hand one over: the file lives in the SplitStack receipts folder, and a row on a
  ledger you belong to points at it. The same pair of checks decides what the cleanup sweeper is
  allowed to bin.
- **People.** You see the people you share a ledger with, and nobody else. Admins see everyone.
- **Money.** An expense can only name people who are on that ledger — or who were on it when the
  expense was written, so history stays editable after somebody moves out.
- **Authorship.** Who entered a row is taken from the session that wrote it, never from the request.
  Nobody can put their edit in someone else's name, or dodge review by claiming to be the author.

### Your spreadsheet can't be turned into a program

Names, notes and categories are typed by people and land in cells you scroll past. Sheets treats a
value starting with `=`, `+`, `-` or `@` as a *formula*, so an expense named `=IMPORTRANGE(…)` would
be code running with your access the moment you opened the tab. Everything written to a cell is
marked as text first, so what you see in the sheet is what somebody typed, and nothing more.

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

**Nothing is repeating, and no email is arriving.**
Both run off two daily triggers, and a script upgraded from an older version has to be
re-authorised before it can create them. In your spreadsheet: **SplitStack ▸ Check background
jobs**. If that reports a problem, open **Extensions ▸ Apps Script**, run `setup()` once, and
accept the permission prompt. Rules and settings you made in the meantime are kept — they just
start firing.

**A repeating expense posted the wrong amount.**
Edit the entry it posted like any other expense (that fixes this month), then open **🔁 Repeating**
on the ledger and fix the rule (that fixes every month after). The two are deliberately separate.

**The email says a different number from the app.**
It shouldn't — the balance code is the same on both sides, down to how the leftover pennies are
handed out. If they really disagree, the app is probably holding changes that haven't synced:
tap **Sync now** and compare again.

**Someone's changes aren't showing up.**
Have them tap **Sync now** on the home screen. If it's still off,
**Profile ▸ Rebuild local data** re-downloads everything from the sheet.

**A ledger looks wrong after I edited the sheet by hand.**
Use **Profile ▸ Rebuild local data**. If you deleted rows directly, that's expected — delete
inside the app instead.

**The app won't update after I re-upload the files.**
See *Updating the app* below — there's a button for this now.

---

## Updating the backend script

The app updates itself. **The Apps Script doesn't** — you pasted it in by hand, so you replace it by
hand. Anything that needs a new backend action (reviews, for one) silently does nothing until you do.

1. Open your spreadsheet ▸ **Extensions ▸ Apps Script**
2. Select everything in `Code.gs` and paste the latest version over it. **Save.**
3. **Deploy ▸ Manage deployments ▸ ✏️ (edit) ▸ Version: New version ▸ Deploy**

> **Step 3 is the one people miss.** Saving the editor does not change what your `/exec` URL serves —
> Apps Script keeps serving the deployed version until you publish a new one. Same URL, same setup
> key, everyone stays logged in.

New columns appear on their own; the script adds any it's missing the next time a phone syncs, and
existing rows are left alone. If the app is talking to a backend too old for a feature, it now says
so in a banner rather than failing quietly, and anything you marked in the meantime is held on the
device and goes through once you've deployed.

> **One extra step the first time you upgrade to a version with repeating expenses and email.**
> Those need permission to run on a timer and to send mail, which the older script never asked for.
> After step 3, run `setup()` once from the editor and accept the prompt — or use
> **SplitStack ▸ Check background jobs** in the spreadsheet, which does the same thing and tells you
> where it stands. The app shows a warning under Settings ▸ Notifications until this is done.

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

## The SplitStack menu in your spreadsheet

After you reload the sheet, a **SplitStack** menu sits in the menu bar. It exists so you never have
to go back into the Apps Script editor.

| Item | What it's for |
|---|---|
| **🔗 Show app links** | Your backend URL, plus a one-tap link that configures any new device |
| **🔑 Show setup key** | The key for creating the admin account (refuses once one exists) |
| **🛠 Run setup / repair** | Rebuilds any missing tab or column. Safe to run any time; never touches data |
| **⏰ Check background jobs** | Says whether repeating expenses and email summaries are actually scheduled, and re-installs them if not |
| **🧹 Clean up unused files** | Finds receipt photos nothing points at any more, tells you what it found, and bins them only if you say yes |
| **🔓 Unlock a locked account** | Clears someone's 15-minute lockout immediately |
| **♻️ Reset the admin account** | Clears the admin password and issues a fresh setup key. Ledgers untouched |

---

## Giving someone their own copy

If a friend wants their own instance rather than joining yours, they don't have to repeat the
copy-paste. Once yours is working:

1. In your spreadsheet: **File ▸ Make a copy**
2. Delete the data rows from the copy (keep the header rows), or just delete every ledger tab and
   clear `Users`, `Ledgers` and `Members`
3. In the copy: **Extensions ▸ Apps Script ▸ Project Settings**, and delete the `PEPPER` script
   property if one exists, so they get their own secret
4. Share that copy with them

A bound Apps Script travels with the spreadsheet, so the code comes along. They deploy it as their
own web app and run through Part 3 — no pasting code, and roughly three minutes of work.

> Make sure you're copying a *cleared* sheet, not one with your household's expenses in it.

---

## Things worth knowing

- **Google's quotas** are generous for this: 20,000 URL-fetch-free script calls/day, 90 minutes of
  runtime, and 100 email recipients a day (1,500 on Workspace). A household of five won't come
  close to any of them.
- **The two daily jobs** run at roughly 3am and 8am in your spreadsheet's timezone
  (**File ▸ Settings ▸ Time zone**). Google decides the exact minute; "roughly" is as precise as
  time-driven triggers get, and nothing depends on the precision.
- **Receipts** are stored in a Drive folder called *SplitStack Receipts — (your sheet name)*,
  not inside the spreadsheet, so the sheet stays fast. They're tidied up as you go: replacing or
  removing a photo bins the one it replaced, and deleting a ledger bins the photos that belonged
  to it. Always **to the Drive bin**, never destroyed, so you have about thirty days to change your
  mind. Deleting a very large ledger bins the first hundred and tells you how many are left in the
  folder — the rest are yours to clear whenever.
- **Deleting an expense doesn't touch its receipt.** A deleted expense is a tombstone rather than a
  removed row, which is how other phones learn about the deletion and what *Put it back* restores;
  binning the photo would make that restore incomplete.
- **SplitStack ▸ 🧹 Clean up unused files** sweeps up anything left behind — by a version that
  predates the tidying above, or by a very large delete that hit its per-run limit. It scans first
  and reports what it found (*"48 files checked · 45 still in use · 3 unused, 1.2 MB"*), and does
  nothing at all unless you say yes. It's careful by design: files under a week old are never
  touched, because a receipt is uploaded just *before* the expense that references it, and anything
  in the folder that SplitStack didn't create is counted and left alone. Normally it should find
  nothing.
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
