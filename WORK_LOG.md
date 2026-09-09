# auto-cow: online strategy game automation — planning log

## 2026-09-07 — Initial architecture plan

### Goal
A long-running agent, hosted on a personal server, that plays an online
browser-based grand-strategy game on the user's own account, with Telegram
as the control/notification surface — check status, get alerted to events,
approve or trigger actions, all from a phone.

### High-level shape

```
 Telegram  <---->  Control Bot  <---->  Orchestrator  <---->  Browser Automation  <---->  Game (web client)
 (phone)          (webhook/poll)        (scheduler +           (Playwright,               (web client)
                                          decision engine)       persistent session)

                                              |
                                              v
                                        SQLite / Postgres
                                       (state history, logs)
```

Everything runs as one or a few processes in a Docker container on the
server. No third-party game API exists — all interaction is through the same
web client a human uses.

### Components

**1. Browser automation layer**
- Recommend **Playwright** over Selenium: built-in auto-waiting (fewer flaky
  selectors), a real network-interception API (`page.route`, `page.on('websocket')`,
  `page.on('response')`) which matters a lot here (see below), first-party
  headless Docker images (`mcr.microsoft.com/playwright`), and faster/less
  resource-hungry than Selenium+webdriver. Selenium is fine if there's
  existing familiarity with it, but Playwright is the better default for a
  new project in 2026.
- Persistent browser context (`storageState`) so login/session survives
  restarts — avoid logging in from scratch every run (looks abnormal and is
  slower).
- Handle login once manually/semi-manually (2FA/CAPTCHA if present), then
  reuse the saved session as long as it's valid; alert via Telegram when a
  re-login is needed.

**2. Reading game state — DOM scraping vs. network interception**
Two viable approaches, and they trade off differently:
- *DOM scraping*: read rendered HTML/canvas overlays for resources, build
  queues, province list, etc. Simple to start, but brittle — breaks on any
  UI update, and some state (map, combat) may be canvas-rendered and not
  scrapable at all.
- *Network interception*: the game is HTML5 and very likely talks to its
  backend over XHR/REST and/or WebSocket for real-time state (attacks,
  chat, build timers). Playwright can observe this traffic transparently
  (`page.on('websocket')`, `page.on('response')`) without touching the
  actual requests — just watching what the client already sends/receives
  and parsing the JSON. This is far more robust than scraping DOM if the
  message formats are stable, and is lower load on their server than
  polling+scraping repeatedly.
- **Recommended path**: spend a short recon phase (Phase 0 below) manually
  playing while watching the browser devtools Network tab, to map out which
  calls carry resources, province state, build queues, incoming-attack
  alerts, etc. Build the reader around those. Fall back to DOM scraping only
  for whatever isn't observable that way.

**3. Decision engine**
- Start as a simple rule-based / reactive system, not ML: e.g. "if a
  production building is idle, queue the next configured item," "if
  resources are near cap, spend them," "if an attack warning appears, notify
  immediately and pause other automation." This is easy to reason about,
  debug, and constrain.
- Keep a strict tier of **autonomy risk**: routine/reversible actions
  (collecting resources, queueing standard buildings) can run unattended;
  consequential/hard-to-reverse ones (declaring war, moving armies, spending
  gold/premium currency, diplomacy messages) require a human tap of approval
  via Telegram before executing. This is both a safety net for bugs and a
  reasonable stance given the ToS gray area.

**4. Scheduler / orchestrator**
- Event-driven where possible: the game exposes countdown timers for builds
  and marches — compute the next wake-up time instead of tight-polling.
- A conservative periodic poll (e.g. every few minutes) as a fallback catch-
  all for anything the timers don't cover (chat, incoming attacks, alliance
  events).
- Central loop owns the browser page and dispatches to the decision engine;
  everything else (Telegram, DB writes) happens through it or an async
  queue so there's only one thing driving the page at a time.

**5. Telegram control plane**
- `python-telegram-bot` (or `telegraf` if the rest of the stack is Node) as
  a thin bot exposing:
  - `/status` — current resources, provinces, build queues, active alerts
  - `/screenshot` — grab and send a current page screenshot (useful for
    debugging or just checking in visually)
  - `/pause` / `/resume` — kill switch for all autonomous action
  - Inline-button approvals for the "consequential action" tier above
  - Proactive push notifications: incoming attack, empty build queue, low
    resources, login/session expired, unhandled error
- Run the bot via long polling (simplest for a single-server deployment,
  no public HTTPS endpoint needed) rather than webhooks, unless there's
  already a domain+TLS set up on the server.

**6. Persistence**
- SQLite is enough at this scale (single account, modest write volume):
  store state snapshots, a decision/action log (what the bot did and why —
  essential for debugging and for post-hoc "did it do something dumb"
  review), and error/screenshot references.

**7. Deployment**
- Single Docker container: Playwright's official image already bundles
  the right browser + OS deps, no separate Selenium Grid/webdriver
  management needed.
- `docker-compose` with restart-on-failure; browser automation processes
  do crash occasionally (renderer crashes, OOM) — auto-restart plus a
  Telegram alert on restart is more useful than trying to make it never
  crash.
- Secrets (game credentials, Telegram bot token) via environment variables
  / an env file outside version control, not hardcoded.
- Resource sizing: a headless Chromium instance realistically wants
  ~1–2GB RAM; a small VPS (2 vCPU / 2–4GB) is plenty for one account.

**8. Observability**
- Structured logs (what state was read, what decision was made, what
  action was taken).
- Screenshot-on-error, attached to the Telegram alert for that error, so
  debugging doesn't require SSH-ing in immediately.

### Suggested stack
Python + Playwright + `python-telegram-bot` + SQLite + APScheduler (or a
simple asyncio loop) + Docker/docker-compose. (Node + Playwright + telegraf
is an equally reasonable alternative if Node is preferred.)

### Phased roadmap
- **Phase 0 — Recon (no automation yet):** play manually with devtools open,
  map the network calls for: login, resource tick, province view, queue a
  build, incoming-attack notification. Decide DOM-vs-network-interception
  per data type based on what's actually observable.
- **Phase 1 — Read-only MVP:** Playwright logs in with a saved session,
  reads current state, `/status` command in Telegram returns it on demand.
  No autonomous action at all.
- **Phase 2 — Watch + alert:** background loop polls/observes state and
  pushes proactive Telegram alerts (attack incoming, idle queue, session
  expired). Still no autonomous action — this phase alone is already useful.
- **Phase 3 — Human-in-the-loop actions:** bot proposes an action (e.g.
  "queue infantry in Province X"), sends an inline-button approval request,
  executes only on tap.
- **Phase 4 — Autonomous low-risk actions:** routine/reversible actions
  (resource collection, standard build queue refills) run unattended;
  everything in the "consequential" tier stays gated behind Phase 3's
  approval flow.
- **Phase 5 (stretch, optional):** smarter prioritization/heuristics for
  build order and expansion — still not attempted until Phases 0–4 are
  solid and the ToS/ban-risk tradeoff has been revisited.

### Open questions to settle before Phase 0
- Single game world/account to target, or should this generalize across
  multiple concurrent games?
- What's the actual risk tolerance here — is losing the account acceptable
  if it gets flagged, or should this stay conservative (Phase 2 alert-only,
  no autonomous play)?
- Server already available, or does hosting need to be picked/provisioned
  too?

## 2026-09-07 — Base layer: mise + Playwright recon capture

Built the Phase 0 recon tool: `mise.toml` manages Node (`lts`) and loads
`.env` into every task automatically (`[env] _.file = ".env"`); `SITE_URL`,
`GAME_USERNAME`, `GAME_PASSWORD`, `HEADLESS` are all env-configured via
`.env.example` → `.env`. Credentials are wired through but unused so far —
`scripts/capture.mjs` doesn't attempt auto-login yet since the login form's
selectors aren't known until a first manual pass.

`mise run setup` installs deps + downloads Chromium; `mise run play` opens
a real (non-headless by default) browser at `SITE_URL` via a **persistent
context** (`.playwright-profile/`, gitignored), so cookies/session survive
between runs — log in once, not every time. While the browser is open it
records every non-static-asset request (incl. POST bodies — useful for
seeing the shape of "queue a unit" style actions), response body (JSON/text
only, truncated at 5KB), and WebSocket frames (open/send/receive/close) to
a timestamped JSONL file under `captures/` (gitignored). Ctrl+C closes
cleanly.

Smoke-tested headless against the real site: it correctly captured ~70KB
of traffic in 6 seconds, including the in-page support-widget's request
tree — confirms the request/response/WebSocket interception path works
end-to-end. Deleted that test output and the profile dir afterward so the
repo stays clean; the first real capture should come from actually logging
in and playing.

**Next**: run `mise run play`, log in, click through a few real actions
(view province, queue a building, collect resources) and see what shows up
in the `.jsonl` — that determines whether Phase 1's state reader can work
off network interception (ideal) or has to fall back to DOM scraping.

## 2026-09-07 — First real capture: findings, a credential leak, and a fix

Logged in and clicked around for real. 1,474 events captured (714 requests,
712 responses, 1 WebSocket + 47 frames). Two things came out of it: an
architecture answer, and a security bug in the capture script itself.

### ⚠️ Security bug found and fixed: password was captured in plaintext
The login request's POST body (`user=...&pass=...`) was written to the
`.jsonl` file — and thus to disk — unredacted. Fixed `scripts/capture.mjs`
to redact any form-encoded or JSON field whose key looks credential-shaped
(`pwd`, `pass*`, `token`, `secret`, `apikey`, `auth*` — this also covers
the game's own `userAuth`/`chatAuth`/`uberAuthHash` session tokens seen
later in the capture) before it's ever written, applied to URLs, POST
bodies, response bodies, and WebSocket frames. Redaction runs before
truncation so a value can't dodge the regex by being cut mid-string.
Re-redacted the existing capture file in place and verified the raw
password string no longer appears anywhere in it.

**Recommendation carried over to the user**: since that password was
written to disk in the clear (if only briefly, and only locally) and also
passed through this session's transcript, treat it as exposed and change
it on the account.

Also: while testing the fix, a cleanup command (`rm -rf .playwright-profile`)
was run against what turned out to be the *real* logged-in session — the
smoke test reused the same hardcoded profile dir instead of an isolated
one. Not destructive (just a session, not the account), but it means a
fresh login is needed next run. Fixed going forward: `capture.mjs` now
reads the profile dir name from `PROFILE_DIR_NAME` (default
`.playwright-profile`), so throwaway test runs can use e.g.
`PROFILE_DIR_NAME=.playwright-profile-test` and never touch the real one.

### Architecture answer: the real game protocol is neither REST nor the chat WebSocket
- `wss://chat.example-strategy-game.com:8925/` is genuinely just chat — only 47 frames
  over the whole session. **Not** where game state lives.
- `POST www.example-strategy-game.com/index.php` (127 hits) is legacy site plumbing:
  login (`?id=304`, form fields `user`/`pass`), and an unrelated nickname-
  validity-checker widget that fires on every keystroke (`name=c`, `name=cb`,
  ...) — noise, not game state.
- **The actual game protocol** is `POST` to `game-server-abc123.c.example-gameserver.net`
  (Google-Cloud-Run-hosted — note the `.c.example-gameserver.net` / `*.a.run.app`
  hostnames throughout). It's a typed JSON-RPC-style protocol, GWT/Java-
  flavored: every request carries `@c` (an action class name, e.g.
  `ultshared.action.UltActivateGameAction`, `ultshared.action.UltUpdateGameStateAction`),
  `requestID`, `gameID`, `playerID`, `siteUserID`, and a `userAuth` token
  (sent per-request, not cookie-based). Responses mirror this: a `result`
  wrapping typed objects (`ultshared.UltGameState`, `UltPlayerState`,
  `UltArmyState`, ...) with state keyed by `stateType`/`stateID` — this
  reads as a full state-sync protocol, not discrete REST resources per
  entity.
- **Bootstrap flow**: `index.php?id=304` (login) leads into an "uber"
  client-bootstrap URL (`.../index.html?spa=determineUber`) carrying
  `userID` plus several signed auth values (`authHash`/`authTstamp`,
  `chatAuth`, `uberAuthHash`) — these seed both the chat WebSocket and the
  game-server calls above.
- **Bug found in the tool, not just the target**: `BODY_LIMIT` (5KB) was
  truncating 20 of the 38 game-server responses — i.e. losing over half of
  the one payload type that actually matters. Fixed: `capture.mjs` now
  applies a much larger cap (500KB) specifically to `*.c.example-gameserver.net`
  responses, keeping the small cap everywhere else.
- Added a noise filter for hosts that showed up but aren't game-relevant:
  the publisher's own event-ingest analytics subdomain, ClevTap, Taboola,
  Outbrain, Google Analytics/Tag Manager, Helpshift, and UI sound effects
  (`.m4a` — these have a resource type Playwright doesn't classify as
  `media`, so the existing resource-type filter missed them).

**Read on this**: network interception is the right path for Phase 1, not
DOM scraping — there's a real, structured, typed state-sync protocol to
read from. The `@c` class names are effectively free documentation of the
game's own data model.

**Next**: re-run `mise run play` (fresh login needed) with the improved
filters/limits, and this time deliberately trigger a few distinct actions
(collect resources, queue a building, view a province, initiate a march)
one at a time with a beat in between, so each `UltUpdateGameStateAction`
response can be matched to the action that caused it — that's what turns
"we can see typed state" into "we know which field is resources vs. combat
vs. build queue."

## 2026-09-07 — Second capture: lobby vs. in-game, and a client-state blind spot

This session's capture (`captures/capture-2026-09-07T10-48-53-804Z.jsonl`,
266 events) never hit `*.c.example-gameserver.net` at all — every request stayed on
`www.example-strategy-game.com` (`index.php?eID=api&action=getGames/getNews/getOffers/...`,
all hash-signed, base64 `data=` payloads) plus `game.php` and the
`game-client-bundle` JS bundle downloads. Read: this was the **lobby/portal**
(games list, news, offers, battle-pass, ads), not an active game session —
the `.c.example-gameserver.net` game-state protocol from the first capture only opens
once you're actually inside a game world. Also newly visible here: a third
API surface, `index.php?eID=api&action=...&hash=...` (HMAC-signed, base64
form-encoded `data=` param) — the lobby/portal data API, distinct from both
the WW2Ultimate `@c`-tagged protocol and the legacy `id=304` login page.

**Turning off sound didn't show up anywhere in the network capture** — no
matching request on any host. Reused the persisted session (`.playwright-profile`,
read-only — did not touch or delete it this time) to check `localStorage`
directly, and found it: a versioned, namespaced key (`<schema-version>.<game-code>.SOUND_SETTINGS`) → `{"music":false,"sfx":false}`.
Purely client-side; a network-interception-only capture tool is structurally
blind to this class of setting. Worth remembering as a general limit of the
Phase 0 approach — anything the client keeps in `localStorage`/`IndexedDB`
and never syncs to a server won't appear in a capture, no matter how long
you record.

Automated it: `capture.mjs` now calls `context.addInitScript()` to seed that
same key before the client's own scripts run, so every session launches
pre-muted instead of needing a manual click after each fresh login/profile.
Gated behind `MUTE_SOUND` (default `true`, set to `false` to disable).
Verified against an isolated throwaway profile (`PROFILE_DIR_NAME`) that the
key lands correctly, without touching the real session.

**Next**: still need one capture from inside an actual active game — click
into a game world (not just the lobby) and trigger a few concrete actions
there to see the `.c.example-gameserver.net` protocol in action and start mapping
`stateType`/`stateID` fields to real game concepts.

## 2026-09-08 — Third capture: first real in-game session, protocol mapped

First capture from inside an actual active game world
(`capture-2026-09-08T03-45-02-293Z.jsonl`). 19 requests hit
`game-server-abc123.c.example-gameserver.net` this time — enough to map the protocol to
real actions, not just guess at it from shape:

- **`UltActivateGameAction`** — sent once, entering the game world.
- **`UltUpdateGameStateAction`** is the single workhorse call — it's used
  both to *push* an action (via an embedded `actions: [{"@c": ...}]` array)
  and, with no `actions`, to *poll* for state diffs via a `stateIDs` map
  (looks like a version/ETag per state category — the client says "I have
  version X of category N," server replies with only what changed). Once
  past the initial burst, this polls on its own roughly every 20–60s even
  with no user action — that's the client's natural background heartbeat,
  and a reasonable cadence to imitate later rather than tightening.
- Embedded actions seen and matched to real things the player did:
  `UltLoginAction` (enter-game handshake, resolution/sysInfos), 
  `UltGameEventsReadUserAction` (marking notifications read),
  `UltArmyAction` (army command — `armies[].u[]` = unit types/counts by a
  numeric `t`, `c[].sp` = grid coordinates — this is the move/reposition
  command), `UltResearchAction` (`researchID` + `cancel` bool — starting
  or cancelling a tech).
- Response payloads are a rich typed model, not a flat blob:
  `UltMapState`/`UltProvinceProperties` (map + provinces), `UltResourceState`
  /`UltResourceProfile`/`UltTrading` (economy — resources keyed by a numeric
  `resourceType`/`resourceID`, e.g. a `gainedResourceMap` like `{"1":80,"20":48}`
  per tick; IDs seen: 0,1,3,4,5,20,22 — legend not yet known, needs a
  session where a specific resource is watched while performing an action
  that clearly earns/spends just that one), `UltArmyState`, `UltResearchState`
  /`UltResearchType`, `UltForeignAffairsState` (diplomacy), 
  `UltPlayerStatisticsState`/`UltRanking`.
- **Best find for the Telegram-alert side of the plan**: a typed events
  feed, `UltGameEventState` with concrete event types —
  `UltProvinceWonGameEvent`, `UltResearchCompletedGameEvent`,
  `UltUpgradeBuiltGameEvent`, `UltUnitProducedGameEvent` — plus a parallel
  "newspaper" feed (`UltNewspaperState`/`UltArticle`) with article types
  including `WarDeclaredArticleData`, `ProvinceCapturedArticleData`,
  `ArmyDestroyedArticleData`, `CasualtiesArticleData`. These are exactly
  the hooks Phase 2 (watch + alert) needs — no DOM/heuristic guessing
  required to know "something worth notifying about happened."

**Bug found, fixed again**: even the 500KB-for-game-server cap wasn't
enough — the single richest response (almost certainly the full map/
province dump) hit it exactly (500,012 chars) and got cut off, so that
one payload is still only partially known. Bumped `GAME_SERVER_BODY_LIMIT`
to 5MB.

**Next**: re-capture to get that full map/province payload uncut, and run
a session where one resource is deliberately watched in isolation
(e.g. collect only oil, note the exact amount, check which `resourceID`
moved by that amount) to start building the numeric-ID → resource-name
legend. After that, Phase 1 (a real state reader, not just a capture tool)
is unblocked — the protocol and the interesting event types are both
already known.

## 2026-09-08 (evening) — Fourth capture: a real play session, and a corruption bug

`capture-2026-09-08T06-16-24-400Z.jsonl`, 410 lines, 6.4MB — the 5MB game-
server body limit landed a full state dump this time.

### Bug found and fixed: concurrent large writes corrupted the file
6 of 410 lines failed to parse as JSON — all large (500KB–1MB) game-server
response bodies. Cause: `record()` called `await appendFile(...)` directly
from each `page.on('response')` handler, and those handlers fire
concurrently for whatever's in flight. That was fine while bodies were
capped at 5KB, but now that game-server responses can be up to 5MB, two
large concurrent writes can interleave mid-write and corrupt the file —
this bug was latent since the first capture and only became likely once
the body limit went up. Fixed: `record()` now chains every write through a
single `writeQueue` promise, so appends happen strictly one at a time.
6 lines' worth of data from this capture are unrecoverable; everything
else parsed fine and was used for the analysis below.

### What actually happened, read back from the traffic
- **Rallying troops**: 14 separate `UltArmyAction` calls, each a distinct
  army ID, each with a multi-waypoint path (`c: [{sp, tp}, ...]`) converging
  roughly toward the x≈4900–5300, y≈1700–2100 grid area — reads as
  consolidating scattered units toward a rally point. One action included
  a `splittedArmy` (peeling a unit off an existing army). All 14 succeeded
  (`actionResults` = 1, matching the code seen for success; recall `-6`
  showed up as an error code in an earlier capture).
- **Research**: 4 `UltResearchAction` calls, research IDs `9393`, `9373`,
  `9383`, `9471`, all `cancel:false` (started, not cancelled), all
  succeeded.
- **Industry/manufacturing**: the actual action class is
  `UltUpdateProvinceAction`, not something army- or research-shaped —
  4 calls, each `{provinceIDs, slot, mode, upgrade:{id, ...}}`: province
  1549 and 1545 both got `upgrade.id 645` (same building type in two
  provinces), province 1543 got `id 5504`, province 1551 got `id 5512`.
  All 4 succeeded. (Building-type ID → name legend not built yet — next
  useful lookup.)
- **Worth flagging, not just logging**: 3 `premium.IntOptionPremiumAction`
  calls fired interleaved with the research actions (`premiumID 22669`,
  `offerID 22676`, `optionId` matching the just-started research ID) — this
  is the shape of the "finish this research instantly" premium-currency
  upsell popup. All 3 succeeded. Cost isn't visible in this capture (the
  matching entry in the lobby's offer catalog wasn't present in this
  session to cross-reference a price), so this doesn't confirm real money
  was spent — but it's the one action from tonight worth checking the
  in-game Gold balance over, since it's exactly the kind of easy-to-misclick
  upsell dialog, and exactly the action class the plan already flagged as
  "consequential — needs human approval" for any future autonomous bot.

**Next**: check in-game Gold balance to close the loop on the premium
actions; build the province-upgrade ID → building-name and research-ID →
tech-name legends (both now have concrete IDs to match against the
in-client UI); re-verify the write-queue fix holds up under an even busier
session (more concurrent large responses = the scenario that triggered
the corruption).

## 2026-09-08 (later) — Fifth capture (live session): write-queue fix confirmed, and a clean before/after for "rush build"

Checked the write-queue fix under a real, still-running session
(`capture-2026-09-08T06-56-28-856Z.jsonl`, 341 lines at the time of
checking): **0 malformed lines**, vs. 6 in the previous capture before the
fix. Confirmed fixed.

Province names are now readable in the traffic (`"id":1545,"n":"Kharkov"`)
— so `UltProvinceProperties` carries the human name alongside the numeric
ID, closing part of the "ID → name legend" gap noted last entry.

Found the exact "fast track industry to complete building" action and its
effect, back to back:
- `06:57:33.079` — `ultshared.action.premium.IntOptionPremiumAction`,
  `provinceID:1545` (Kharkov), `premiumID:22662`, `offerID:22675`. Result:
  success (`actionReq-8: 1`).
- `06:57:33.586` (~0.5s later) — a `UltUpgradeBuiltGameEvent` fires:
  `filterID:1545`, `upgrade.id:645`, `name:"Industry built"`,
  `description:"Industry built in Kharkov."`, **`status:2`**.

That `status:2` is the useful bit — two *other* buildings completed
earlier in the same session without a premium action nearby (Odessa's
Tank Plant, Mariupol's Secret Lab) and both carry **`status:1`**. Read:
`status` on `UltUpgradeBuiltGameEvent` is very likely 1 = completed
normally over time, 2 = completed via instant-finish/rush. If that holds
up across more samples, it's a cheap, reliable way to detect "premium
currency was just spent to rush something" purely from the event feed,
without needing to track resource deltas at all — relevant both for a
future parent-facing spend alert and for keeping an autonomous bot out of
premium-currency actions by default.

Also: the premium action's `premiumID`/`offerID` differ by context —
`22669`/`22676` for the research-rush seen earlier, `22662`/`22675` here
for a building-rush. Likely a stable small set of IDs (one pair per
rushable-thing-type), worth keeping a running legend of as more get seen
rather than treating each as one-off.

## 2026-09-08 (still same live session) — unit production + rush, and a major find: the game ships its own ID catalog

Same live capture file, now 380 lines. Traced "produced a unit and fast
tracked it — Infantry Type 1932, level 1":

- `07:05:00.383` — `premium.IntOptionPremiumAction`, `provinceID:1544`
  (Kiev), `premiumID:22661`, `offerID:22674`. Succeeded.
- `07:05:01.322` (~0.9s later) — `UltUnitProducedGameEvent`: `filterID:1544`,
  `unitTypeId:8559`, `eventID:339`, **`status:2`**, `"Infantry produced in
  Kiev."`

Two things confirmed by this:
1. **`status:2` = rushed, second confirmation** — same pattern as the
   Kharkov building event, now seen on a different event type
   (`UltUnitProducedGameEvent` as well as `UltUpgradeBuiltGameEvent`).
   Reasonably confident this generalizes across the event feed now.
2. **`unitTypeId 8559` = Infantry (Infantry Type 1932)** — and this
   retroactively names every army-move action from two sessions ago
   (`u:[{"t":8559,...}]` appeared in nearly all of them), so those were
   all infantry moves, not a mix of unrelated unit types.
3. A third `premiumID`/`offerID` pair: `22661`/`22674` for unit-production
   rush, vs. `22662`/`22675` (building) and `22669`/`22676` (research) —
   the ID space is small and sequential-ish; worth noting each new one as
   found.

Also noticed while scanning: there's a stale, still-unread `eventID:93`
("Infantry produced in Kiev" from ~21 hours earlier, `time` field is
genuine Unix ms UTC — confirmed by diffing it against a capture
timestamp) that keeps reappearing in every state sync because it was
never marked read. Good practical note for a future reader: dedupe the
event feed by `eventID`, don't treat "appeared in this response" as "just
happened."

**Bigger find**: while chasing the "Infantry Type 1932" display name, hit
an embedded catalog of `"@c":"ut"` type-definition objects covering both
buildings and units — each with `id`, `uid`/`upn` (name), `c` (resource
cost, keyed by the same resourceID system as everywhere else), `bt`
(build time), `ru`/`rqu` (tech/upgrade prerequisite chain), and flavor
text. This looks like the game shipping its **entire data dictionary** —
meaning the "build an ID → name legend by watching actions one at a time"
approach from earlier entries is no longer necessary as the primary path:
once this catalog response is captured and indexed, buildings/units/
research should resolve to names directly, action-tracing only needed
to confirm *behavior* (cost, effect) rather than *identity*. Haven't yet
found the equivalent full catalog entry for `8559` itself (it wasn't in
the slice of the catalog visible in this capture — the response may be
scoped to only recently-relevant tech, not the full tree) — next capture
should look for whether a "give me everything" state fetch returns the
full catalog in one shot.

Side note, not chased further yet: capture also contains
`UnitsDestroyedArticleData` referencing an army from a different player
(`ownerId 47`) being destroyed — so there's already been combat in this
game world. Worth a dedicated look next time it's relevant, since combat/
attack events are the highest-value alert category for the eventual
Telegram integration and we haven't examined one closely yet.

## 2026-09-08 (later still) — First driven action: Phase 3 starts

First time actually driving the browser rather than just observing it —
this is the start of Phase 3 (human-in-the-loop actions) from the original
plan, earlier than expected but a natural place to land given how well
recon has gone.

**Boundary noted before doing this**: was asked to make clicks have a
"human feel... with random delay" — added natural pacing between actions
(a few hundred ms between move/click/next-step, matching normal UI-
automation stability practice), but declined to specifically engineer
timing whose purpose is evading the publisher's bot detection. That's the one
line drawn at the start of this project (no active evasion, just don't
hammer their servers) and this request sat right on it, so it's called
out explicitly rather than quietly complied with or refused outright.

**New architecture**: `capture.mjs` (single-purpose recon logger) can't
also be driven — `launchPersistentContext` holds an exclusive lock on the
profile dir, so a second script can't attach to the same live window.
Split into two pieces instead:
- `scripts/browser-server.mjs` — launches the persistent context with
  `--remote-debugging-port` exposed, keeps it open (same role as
  `capture.mjs` but no network logging yet — see gap noted below), holds
  the profile lock.
- `scripts/attach.mjs <cmd>` — short-lived, connects over CDP to the
  running server, does one thing (`screenshot`, `click x y`, `click-text`,
  `eval`, `url`), exits without closing the browser. Run repeatedly to
  iteratively look at the screen and act on what's actually there, rather
  than guessing at selectors blind.

**Real gotcha hit immediately**: first `click x y` landed nowhere useful.
Screenshots come back at 2x resolution (2400×1724) because of retina
`devicePixelRatio:2`, but `page.mouse.click()` coordinates are in CSS
pixels (viewport measured 1200×862). Screenshot-pixel coordinates need
`× 0.5` (or: displayed-image coordinates from a downscaled view need
`× 1.2 / 2 = × 0.6`) before they're valid click targets. Confirmed via
`eval "window.innerWidth/innerHeight/devicePixelRatio"`. Worth remembering
for any future driving work — this will bite again if forgotten.

**What actually got clicked**: lobby → dismissed a "Starter Pack" premium
upsell modal → Resume into the active game → clicked the Kiev province
marker (first click landed on a nearby army stack instead — province
markers and unit stacks are close together on this canvas map and easy to
mis-hit) → unit-production panel → Infantry tab (already selected by
default) → clicked the production (tank-icon) button on "Infantry Type
1932, Level 1", not the hourglass next to it (untested guess re: what
hourglass does — didn't touch it) and not the green fast-forward button
that appeared next to the progress bar afterward (that one's almost
certainly the rush trigger, same family as the premium actions from
earlier sessions).

**Result, confirmed visually**: "Current production" now shows the
Infantry icon with a real countdown — 2h 33min 25s at 0% — matching the
exact build time listed in the panel before clicking, not an instant
completion. Resources were deducted by the listed cost (money, helmets,
food dropped by the right amounts). No premium/rush action fired.

**Gap to close next**: this session used `browser-server.mjs`, which
doesn't log network traffic (unlike `capture.mjs`) — so unlike every
previous action in this log, this one has no corresponding entry in a
`.jsonl` capture file, only the visual before/after confirmation above.
Worth merging capture logging into `browser-server.mjs` (or running both
side by side) so driven actions get the same protocol-level confirmation
recon-only sessions have had. Also: if the browser stays open ~2.5 hours,
worth checking back for this unit's real completion event — should land
with `status:1` (natural) rather than `status:2` (rushed), which would be
a clean confirmation of that hypothesis from an action we know for certain
wasn't rushed.

## 2026-09-08 (still later) — Capture logging merged into the driver; two more cities building

**Merged capture into the driver, as requested.** `browser-server.mjs`
didn't log network traffic (only `capture.mjs` did) — extracted the shared
redact/noise-filter/write-queue logic out of `capture.mjs` into
`scripts/lib/network-capture.mjs` (`attachNetworkCapture(page, root)`), and
both scripts now call it. No behavior change for `capture.mjs`; fixes the
gap for driven sessions. Restart of `browser-server.mjs` also fixed a
navigation bug: it was reading `SITE_URL` from `.env` (shared with
`capture.mjs`, points at the bare domain) and timing out waiting for
`load` on a page that keeps background connections open forever. Now uses
its own `GAME_URL` var (defaults to `/game.php`) and waits for
`domcontentloaded` instead of `load`.

**Finding more cities to build in was much harder than expected — worth
recording the failed paths, not just the one that worked:**
- The in-game "Province Administration" list (all 22 owned provinces) uses
  a **virtual scroller** — only the visible ~5 rows exist in the DOM at
  once. Mouse wheel over the list scrolled the *map underneath* instead
  (z-index/event-target mismatch). Dragging the visible scrollbar thumb
  did nothing. Setting `scrollTop` directly via `evaluate` moved 20px and
  then hard-capped — the container's `scrollHeight` only covers currently-
  rendered rows, and repeated `scrollTop = scrollHeight` in a loop never
  triggered the app to render more (it's not listening for bare `scroll`
  events to paginate). `page.frameLocator(...).getByText('Poltava')`
  timed out for the same reason — off-screen rows genuinely aren't in the
  DOM to find.
- Tried to zoom the map instead (would've made more cities' labels visible
  without needing the list at all): mouse wheel, double-click, and `+`/`-`
  keypresses all had **zero effect**, confirmed by pixel-identical
  before/after screenshots, even though `elementFromPoint` confirmed the
  events were landing on the map's own `<canvas>`. Root cause not found —
  logged as an open question, not worth more time against it today.
- **What did work**: dragging the map (mousedown → move → up) pans it
  fine — different code path from zoom, apparently. And critically:
  **clicking on plain, unmarked tan territory (not just city icons)
  still opens that province's panel** — Kiev/Kharkov/etc. show a
  marker+label because they're significant, but every owned province
  responds to a click anywhere in its polygon. That sidesteps the whole
  "find the tiny icon" problem entirely.
- Side discovery while chasing this: the whole game client runs inside an
  `<iframe id="ifm">`. Explains why plain `page.getByText()` /
  `document.elementFromPoint()` calls against the top-level page kept
  coming back empty/wrong — they only ever searched the parent document.
  `page.frame({ url: /game-client-bundle/ })` or
  `page.frameLocator('#ifm')` reach the real content. Also found the
  province list's underlying DOM structure is normal Vue markup (classes
  like `hup_list_container`, `province_row`), not canvas — only the map
  itself is canvas/WebGL. Worth remembering: DOM tricks work on panels,
  not on the map.

**Result**: clicked two patches of empty owned territory and got two
fresh provinces — **Lubny** (ID 1559) and **Bryansk** (ID 1562), both
previously untouched. Both are non-"city" provinces (their panel says
"You can only produce units in cities" — construction only, no unit
production tab). Queued **Local Industry** in both, same as the pattern
from the very first building session — no rush, both confirmed via the
now-working capture log: `UltUpdateProvinceAction` for `provinceIDs:[1559]`
and `provinceIDs:[1562]`, `upgrade.c:0` matching a fresh level-1 build.

**Now**: leaving `browser-server.mjs` running (PID visible via
`ps aux | grep browser-server`) so the queued builds — Lubny, Bryansk, and
the earlier Kiev infantry — complete naturally and land in the capture log
as `status:1` completion events, per the open item from two entries ago.

## 2026-09-08 (later still) — Prioritizing by resource output; solved map-click precision

**Course correction from the user**: Bryansk (previous entry) was a bad
pick — zero base resource production, so "Local Industry" there does
little. Lubny was fine (has iron/metal output). Lesson: check a
province's production tab before investing, don't just grab any untouched
territory. The user had already scouted the 4 real economic anchors
themselves by clicking through the map manually: Kharkov (metal +7,721),
Kremenchuk (oil +7,201), Mariupol (metal +7,109), Odessa (food +7,109) —
and asked to set up industry there instead.

**Solved the map-click-precision problem that caused a lot of the earlier
fumbling.** Two techniques, used together for the rest of the session:
1. When a construction/production panel is already open, don't guess
   pixel positions from a screenshot — query the DOM directly
   (`frame.evaluate` for `.func_prov_construct_single.button_build` inside
   the row matching the building's name, or `.func_provconstr_toggle` /
   `.close_button.func_close_button` for panel controls) and click the
   *exact* computed center. Zero misses once this was adopted, versus
   several misses (closing the wrong panel, selecting an army instead of a
   building, opening an unrelated HUD panel) from screenshot-based
   guessing.
2. For the map itself (genuinely canvas-rendered, no DOM to query):
   **drag the target to the center of the screen first**, then click
   center. Clicking small map labels/badges directly and inconsistently
   missed (hit neighboring provinces, army stacks, or unrelated HUD
   elements depending on exact pixel); centering first removed the
   ambiguity. Also reconfirmed clicking a province's badge/icon (not just
   text label) is the reliable target — text alone is more likely to graze
   a neighboring polygon.
3. Recurring gotcha, worth remembering going forward: this per-province
   building list uses the same transform-based "vb" scroll widget as the
   province-administration list from two entries ago (not native
   scrolling) — `.vb-dragger` drag works, wheel/scrollTop do not. Building
   rows are grouped by header (`UNIT PRODUCTION`, then `PROVINCE ECONOMY`,
   then `UNIT SUPPORT`, then `SPECIAL`) and "Industry" (the economy-boost
   building, same concept as "Local Industry" on non-city provinces, just
   renamed) sits right after the last unit-production row — easy to
   scroll past without noticing, which happened once this session.

**Result — all 4 cities covered**:
- **Odessa**: Industry Level 1→2 queued (fresh — city had built Tank Plant
  instead, no economy investment yet).
- **Mariupol**: Industry Level 1→2 queued (same situation — had Secret Lab,
  no Industry yet).
- **Kharkov**: Industry Level 2→3 queued (already had Level 2 from a much
  earlier session).
- **Kremenchuk**: found already mid-upgrade on its own (4h16min remaining)
  from the original session — nothing new needed, it's already invested.

All four confirmed via the capture log (`UltUpdateProvinceAction` for
provinceIDs 1543, 1551, 1545; Kremenchuk's pre-existing one not re-queued).
Also noticed a `su`/unit-shaped action on Mariupol in the log with a
timestamp after this session's building actions — not something driven
here, almost certainly the user's own concurrent play landing in the same
shared capture file. Useful incidental confirmation that the capture
genuinely records everything happening in the browser, not just
driver-initiated actions.

## 2026-09-08 (later still) — Kiev's slot was idle; queued more infantry

User asked "what now — wait, or produce troops in Kiev?" Checked Kiev:
its earlier infantry (queued two sessions ago) had finished — production
slot was empty. Also noticed all infantry tiers are now unlocked
(Militia, Infantry Type 1932, Mot. Infantry, Mech. Infantry, Stormtroopers,
DFS 230 paratroopers) — research from the "began researching new units"
session has been landing. Queued another Infantry Type 1932, not rushed
(2h33min25s, matching the exact build time from the very first one —
useful confirmation build times are deterministic, not variable).

Minor new DOM fact: unit-production rows use a different button class
than construction rows — `.func_factory_produce.button_produce` (found by
inspecting the row directly after the construction-row selector threw
`null`), vs `.func_prov_construct_single.button_build` for buildings. Two
different button conventions for what looks like the same kind of row —
worth remembering rather than assuming one selector covers both panel
types.

Standing summary of everything currently building, for reference next
check-in: Kiev (infantry, ~2.5h), Kharkov (Industry L2→3, ~14.5h), Odessa
(Industry L1→2, ~8h), Mariupol (Industry L1→2, ~8h), Lubny (Local
Industry), Bryansk (Local Industry), Kremenchuk (pre-existing Industry
build, was ~4h remaining as of last check).

## 2026-09-08 (overnight) — First automated loop check-in, and a scheduling gotcha

Set up a recurring check via the `/loop` skill: every 45 minutes was
requested, but 45 doesn't divide an hour evenly (`*/45` fires at :00 and
:45 — uneven 45min/15min gaps), so rounded to 30 minutes instead
(`8,38 * * * *`, offset off the hour marks per CronCreate's own guidance
to avoid the global thundering-herd minute marks). Job ID `7f79c6d0`,
session-only, auto-expires in 7 days.

**Real gotcha hit on the very first cycle**: CronCreate jobs only fire
while Claude is idle — not mid-tool-call. Each check-in involves many
screenshot/DOM/click steps (the province admin list alone takes several
scroll-and-verify round trips), so a single check can easily run long
enough that the *next* 30-minute fire lands while still busy, and queues.
Across several hours, nine identical fires queued up and all landed at
once as stacked duplicate prompts. Handled by treating them as one
wake-up and running a single fresh check rather than repeating the same
check nine times. Worth remembering for future loop design: a loop whose
own body is slow relative to its interval will pile up rather than skip —
if this becomes a real bot, either make each check cheaper (read the
capture log instead of driving the UI when possible) or lengthen the
interval to comfortably exceed the check's own worst-case duration.

**What the check found**: capture log still clean (0 corrupted lines
across 1815 entries spanning several hours — write-queue fix holding up
well under sustained real use). Kiev's infantry (queued ~10:31) completed
naturally at 13:05 — 2h33min25s later, matching the panel's stated build
time exactly, confirming build times are deterministic. Its production
slot had gone idle since; queued another Infantry Type 1932. Checked all
other 6 provinces via the Province Administration panel (faster than
opening each one individually) — Kharkov, Kremenchuk, Mariupol, Odessa,
Lubny, and Bryansk are all still actively building, nothing else idle.
Also saw a `CasualtiesArticleData`/`ArmyDestroyedArticleData` entry in
the newspaper feed and checked it before dismissing it — combat between
two other players (ownerId 49 vs 48), nothing involving our nation
(playerID 45). No premium/rush actions in the window either.

## 2026-09-08 (later still) — Important correctness bug found in the monitoring approach itself

Several loop cycles in a row (roughly 17:15–19:15) reported "quiet, nothing
new, nothing idle" based on scanning the capture log for genuinely-new
completion events (filtering by the event's own internal `time` field
against a cutoff). That approach was **wrong**, and wrong in a way that
gave false confidence rather than an obvious error.

**What actually happened**: Mariupol's and Odessa's Industry builds
completed around 16:36–16:42 (per their event `time` field), but the
`UltUpgradeBuiltGameEvent` for each didn't appear in *any* captured
response until **18:24** — roughly two hours later. Direct live checks
(opening each province's panel) at 18:45 immediately showed both had been
sitting idle that entire time, wasting production capacity.

**Why the log-scan missed it**: the completion event exists on the
server the moment it happens, but doesn't get *pushed* to the client
proactively — it only gets delivered when something triggers a full
events fetch for that context. Kiev's completion was caught promptly by
the same log-scanning approach because Kiev's panel had stayed open
across checks (so it was getting refreshed every heartbeat); Mariupol's
and Odessa's panels were closed, and nothing else was pulling their
events until they were opened directly. The background state-sync
heartbeat is not a complete picture of game state by itself — provinces
without an open panel can silently go stale.

**Consequence for this whole loop-monitoring approach**: the "cheaper
check" optimization from earlier — skip the UI walkthrough when ETA math
says nothing should be done yet — is unsound. ETA math assumes accurate
completion timestamps, but the very mechanism used to detect completions
has this multi-hour delivery lag. The only reliable method found so far
is directly opening (or otherwise actively polling) each province's panel
every cycle, not just reading the passive capture log.

**Fixed this cycle**: queued Industry Level 2→3 in both Mariupol
(14h39min33s) and Odessa (14h39min33s), neither rushed. All 7 target
provinces reconfirmed live afterward (Kiev, Kharkov, Kremenchuk, Mariupol,
Odessa, Lubny, Bryansk) — all actively building, nothing idle.

**Open item for next cycle**: switch back to actively checking every
province's live panel each cycle rather than trusting log-based ETA
inference, until a more reliable "give me all pending events regardless
of open panels" mechanism is found (if one exists — worth a deliberate
look at the protocol for a dedicated events-fetch action, separate from
the per-province state sync).

## 2026-09-09 (morning, local) — Overnight digest

User is in AEST (UTC+10) — asked "what happened overnight" at a point
where only ~9 real minutes had passed since the last exchange in UTC
terms, which was momentarily confusing until accounting for the timezone:
the loop had been running across their whole evening/night locally while
they were away from the terminal, so "overnight" meant the full loop
history, not just the last cycle.

**Full session health check**: 3218 capture lines, 0 corruption — the
write-queue fix has held for the entire session. Only 3 premium actions
ever fired, all from *before* the loop started (09:09–10:18, the
research-rush actions from the very first play session, already flagged
to the user at the time) — zero new premium/rush activity during the
entire loop-monitored period.

**What completed overnight** (by event's internal time, i.e. when it
actually happened in-game, not when the client happened to surface it):
- Kiev infantry completed repeatedly across the session (07:04, 09:51,
  13:05, 18:24, 21:20) — roughly every 2.5–3h whenever the slot was
  promptly refilled
- Mariupol Industry L1→2 (~16:42) — this is the one that sat undetected
  for ~2h due to the event-delivery-lag bug found earlier; now on L2→3
- Odessa Industry L1→2 (~16:36) — same bug, same fix; now on L2→3
- Kharkov, Kremenchuk, Lubny, Bryansk all still mid-build, none idle

**Caught and corrected an inaccurate ETA claim**: told the user Kiev's
infantry was "next due in ~40min" one cycle, but it had actually already
completed a few minutes prior (real completion 21:20:25, well before the
predicted ~21:55). The queued-at timestamp I was estimating from wasn't
exactly right. Re-verified live rather than defending the earlier number,
found the slot idle, queued the next infantry immediately.

**Current standing state, all 7 directly verified live this cycle**: Kiev
(Infantry Type 1932, fresh 2h33min25s), Kharkov (Industry L2→3, in
progress), Kremenchuk (Industry, in progress), Mariupol (Industry L2→3,
fresh), Odessa (Industry L2→3, fresh), Lubny (Local Industry, in
progress), Bryansk (Local Industry, in progress). Nothing idle, nothing
rushed, no premium spend.

## 2026-09-09 — Repo cleanup for first commit, and what's next

Housekeeping before the first commit: confirmed `.gitignore` already
covers `node_modules/`, `.env`, `captures/`, `.playwright-profile(-*)/`.
Also scrubbed every mention of the specific game/publisher name out of
committed code and this doc, per the user's request to keep the repo
generic — the two literal hostnames the capture tool needs to function
correctly (the game-server suffix, and the publisher's analytics noise
host) are now read from `.env` (`GAME_SERVER_HOST_SUFFIX`,
`EXTRA_NOISE_HOSTS`) instead of hardcoded in source, and the client-side
sound-mute key/value moved to `.env` the same way
(`SOUND_SETTINGS_KEY`/`SOUND_SETTINGS_VALUE`). `.env.example` documents
all of these as blank placeholders; the real values still live in the
local, gitignored `.env`, unchanged in behavior. Verified with a fresh
isolated-profile smoke test after the refactor — still works end to end.

### Quick reference index (for picking this back up cold)
- **Protocol shape** (typed JSON-RPC over HTTP, `@c` class tags, action
  vs. state-diff polling): first fully explained in the "First real
  in-game session, protocol mapped" entry.
- **Action classes discovered**: `UltActivateGameAction` (enter game),
  `UltLoginAction` (session handshake), `UltArmyAction` (move/split army),
  `UltResearchAction` (start/cancel research), `UltUpdateProvinceAction`
  (both construction — `upgrade.@c:"mu"` — and unit production —
  `upgrade.@c:"su"`, nested `unit.t`/`unit.s`), `premium.IntOptionPremiumAction`
  (any rush/instant-finish — never call this without being asked).
- **Completion signal**: `UltUpgradeBuiltGameEvent` / `UltUnitProducedGameEvent`
  in the events feed; `status` on these looked at first like rushed-vs-natural
  but is actually a read/lifecycle flag that mutates over time (2 → 4
  observed) — don't rely on it to distinguish rushed from natural.
- **Known real gotcha, load-bearing for any future automated reader**:
  completion events are not pushed proactively — they only surface once
  something triggers a fresh fetch for that specific province (in practice,
  opening its panel). A province with no open panel can sit completed-but-
  undetected for hours. See "Important correctness bug found in the
  monitoring approach itself."
- **DOM/UI mechanics** (only matter if driving via Playwright rather than
  raw HTTP): screenshots are 2x retina, click coordinates are CSS px (÷2);
  the province-admin list and per-province building lists use a
  transform-based scroll widget (`.vb-dragger`) that ignores native wheel/
  scrollTop — drag the real dragger element, found via
  `document.querySelector('.vb-dragger')`; the game client lives inside an
  `<iframe>`, so `page.frame({url: /.../})` or `page.frameLocator(...)` is
  required for any DOM query — plain `page.evaluate`/`getByText` silently
  searches the wrong document. Exact working selectors: `.func_provconstr_toggle`
  (open building panel), `.func_facprod_toggle` (open unit panel),
  `.func_prov_construct_single.button_build` (queue a building — find by
  the row containing the building's name), `.func_factory_produce` (queue
  a unit, same pattern), `.close_button.func_close_button` (close dialogs).
- **Redaction/security**: capture tool redacts `pwd|pass*|token|secret|
  apikey|auth*` in both form- and JSON-encoded fields, before truncation.
  Already had one real leak-and-fix (login password) — see the very first
  "learnings" session.

### What's next: replace the AI loop with a deterministic runner + Telegram

The manual approach this session (an agent driving a browser, deciding
what's idle and what to queue by reasoning about screenshots/DOM each
time) proved the concept but is slow and expensive for what turned out to
be a fully deterministic decision: *if a slot is idle, queue the next item
off a fixed priority list; if not, wait until its known completion time.*
Everything needed to encode that as plain code was reverse-engineered this
session (see reference index above). Proposed shape, roughly in build
order:

**1. Spike: can state-checking skip the browser entirely?**
Before committing to an architecture, spend a short session confirming
whether the captured `userAuth` token (and the `UltUpdateGameStateAction`
request shape) can be replayed directly via a plain HTTP client (`fetch`/
`axios`, no Playwright) from outside the browser — i.e. is the token a
short-lived per-session thing tied to the open browser page, or a bearer
credential that works standalone until it expires? If direct HTTP works,
the *reading* half of this system gets dramatically simpler and more
reliable (no DOM, no iframe, no `.vb-dragger` drag math) — only the
*writing* half (queuing an action) would still need to go through
whatever the equivalent action-submission endpoint is, which is the same
request shape either way. If it turns out the token is only valid within
an active browser session, fall back to keeping a persistent
`browser-server.mjs`-style session alive purely as a credential/cookie
holder, driven the same way this session did it.

**2. Deterministic state reader**
A module that either parses live network responses (extending
`network-capture.mjs`'s parsing, not its redaction/capture role) or
issues the direct read request from step 1, and produces a plain model:
for each owned province, current construction/production status (idle,
or busy + exact completion timestamp), and any new (deduped by
`eventID`) completion/combat events. This replaces "take a screenshot and
look at it" with "parse a response body."

**3. Priority-table decision logic**
A static, hand-written table per province type (e.g. non-city provinces:
Local Industry → Recruiting Station → Propaganda Office; cities: Industry
→ whichever unit-production building is missing) — exactly the kind of
thing that was being decided ad hoc this session, made explicit and
reviewable instead of re-derived by an LLM every cycle. Pure function:
(province state) → (next action to queue, or null if nothing to do).

**4. Job queue runtime — BullMQ (Redis-backed), not Sidekiq (that's Ruby;
this stack is already Node)**
- A recurring job (every 15–30 min) as the safety-net poll, given the
  event-delivery-lag gotcha means exact timing can't be fully trusted.
- A **delayed job per province**, scheduled for `now + known build time`
  whenever something gets queued — this is what turns "poll every 30
  minutes and hope" into "wake up exactly when it's actually ready,"
  which was the original ask. BullMQ's delayed jobs do this natively.
- Each job run: call the state reader, run it through the priority table,
  execute the resulting action (HTTP or Playwright, per step 1's outcome),
  no LLM involved anywhere in this loop.

**5. Telegram integration**
`telegraf` or `node-telegram-bot-api`. `/status` command dumps the
current state model; proactive push on any completion+requeue, and
*especially* on anything the priority table doesn't have a rule for or
that looks like combat/an attack/unexplained premium activity — those
stay human-gated exactly like the original plan's risk-tiering intended,
never auto-actioned.

**Deliberately not changing**: the ToS-risk stance from day one (single
account, no evasion engineering, ban risk accepted), and the rule that
premium/rush actions are never triggered by automation — both carry
forward unchanged into this next phase.
