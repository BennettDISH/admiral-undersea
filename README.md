# admiral-undersea

A real-time submarine hunt in the browser, with our own rules. Your boat has four stations (the
helm, the listening post, the torpedo room and the engine room), each with its own job and each
needing the others; take all four against the AI's boat, or crew a boat with friends against
another. Every sound your boat makes is a bearing the enemy can plot.

**Live:** https://adventurous-imagination-production-d42d.up.railway.app

## Stack
React 18 + Vite 8 (client) · Express + socket.io (server, real-time multiplayer) · Postgres ·
fleet-kit (Waypoint sign-in, the cookie session, headers, limits, log, errors, health, the top bar)

Monorepo with separate `client/` and `server/` packages. fleet-kit is vendored as
`server/vendor/fleet-kit-1.0.13.tgz` and both packages install that one file (the server
`require`s its CommonJS build; the client imports `fleet-kit/client/topbar`). Once it is
published, both take `github:BennettDISH/fleet-kit#v1.0.0` and the vendor folder goes. A kit
change is a new kit version, never a re-packed tarball; never edit the kit here.

## How it plays (rebuilt 2026-11)
- **The deck** offers the **Tutorial** (a guided first dive against a training boat on its own
  open chart, The Training Range: the helm, listening, the charge that shows why you never charge,
  the torpedo room, the engine room, then a short practice hunt), **Play against AI** with a pick
  of Easy, Normal or Hard (a scripted computer crew, `server/game/ai.js`), and **Crew against crew**.
- **The tutorial goes one control at a time** (since 2026-11-13): the clock stops at every step
  that is read or done, the room dims but for the one control to use, a label beside it says what
  it does, and the card says what to do. A step moves on when the player does the thing (or presses
  Next on a step that is only read); a step that runs the clock (a cell of way, a bearing, a tube
  loading) moves on when that has happened, never on a timer. When the control is on another
  station, its tab is lit first. Back puts the boat as it was when the step before began (a few
  steps deep), Skip this step does it for the player, and Leave tutorial ends it for the deck.
- **The chart**: 16 by 12 cells (two charts dealt at random: The Black Shelf, The Narrows) with
  rocks, thermal vent fields that hide a slow boat's noise, and whales whose song is a false contact.
- **The hunt matters**: speed is noise. At Full a boat is heard across the sea, its own flow noise
  leaves it hearing less than half as far (with wider bearings), and a torpedo's seeker hears it.
  A torpedo arms only after 3 cells (a shot from closer is refused), and once armed its seeker turns
  onto a decoy, or a boat at Half within 1.5 cells or at Full within 3, ahead of it; a slow boat,
  or a fast one in a vent field, slips past. The Normal and Hard crews shoot straight back down a
  loud bearing, so charging in loses; `node server/game/playtest.js 100` plays scripted players
  (careful, charging, rushing, a first-timer) against each crew, and `balance.test.js` holds it.
- **Noise and bearings**: every move, launch, ping and vent is a noise. A boat that hears it gets a
  contact: a wedge along the bearing from where it was, sharper the louder the noise. Two bearings
  from two places cross on the enemy. A ping shows everything within 6 cells exactly, and tells
  the enemy exactly where you are.
- **The helm** steers (eight headings) and orders stop, slow, half or full: faster is louder, full
  deafens our own hydrophones, and rocks at speed cost hull.
- **The listening post** reads the scope, marks the enemy on the chart and pings.
- **The torpedo room** loads two tubes (as fast as their power allows), fires on the mark, steers a
  running torpedo onto a moving target, and throws decoys that sound like a boat at full speed.
- **The engine room** shares the reactor's power (6, overdrive to 9 heats it towards a scram),
  vents heat (which is heard) and repairs what hits break: a fire, flooding (which costs hull if
  left), the sonar dome, a jammed rudder.
- A torpedo blast does 2 on its cell and 1 beside it; five hull sinks a boat; after ten minutes the
  boat with more hull wins. Crew calls ("more power to the engines!", "evade!") go to the whole
  boat, and the auto-crew answers them.
- **The auto-crew** runs every station nobody holds, and the AI's boat (Easy, Normal or Hard: how
  well it listens, how fast it reacts, how well it aims and how it slips a torpedo). It keeps a
  belief map of where the enemy could be, built only from what its own boat heard.

The rules live in a pure, DB-free engine (`server/game/engine.js`, ticked ten times a second; the
auto-crew in `ai.js`) with unit tests (`cd server && npm test`); `server/sockets/game.js` runs the
clock and is a thin socket.io adapter over it. Game data is single-sourced in
`shared/gameConstants.json` (imported by both client and server).

## Sound and art
- One site-wide audio engine (`client/src/lib/audio.js`): the first click anywhere opens it (the
  home page asks you to "Come aboard"), the deck has its own song and the sea, the hunt has two
  layers of music crossfaded by how tense it is, the hull's hum, and every event its sound. On
  iPhones the page asks for the playback audio session so the silent switch does not mute it.
- Effects and songs are our own, from games-media's sound factory, on the media host
  (`client/public/audio/manifest.json`). The crew's callouts are short ElevenLabs lines
  (`client/src/game/voice.js`, made by `scripts/voices.mjs`, served from `client/public/audio/voice/`)
  played through an intercom filter; the speaker's portrait talks while they play.
- `/pane-quiet.js` (from games-media) keeps the desktop app's test browser silent and nothing else.
- The chart, scope and crew faces are drawn on canvases (`client/src/game/`); sprite-factory art
  loads from `client/public/art/manifest.json` when it is there (`sprites.js`), and our procedural
  drawing (`draw.js`) stands in for any clip that is not.

## Environment
The server reads these env vars (set them in Railway):

| Var | Required | Purpose |
|-----|----------|---------|
| `DATABASE_URL` | yes | Postgres connection (schema auto-applies on boot). |
| `JWT_SECRET` (or `SESSION_SECRET`) | **yes in production** | Signs the session cookie (`SESSION_SECRET` wins when both are set; `JWT_SECRET` also reads the old tokens until their reader goes). The server **refuses to start** in production without one. |
| `NODE_ENV` | recommended | Set to `production` on Railway (enables the secret guard + Express prod mode). |
| `ADMIN_CENTRAL_USER_IDS` | no | The site admin's Waypoint central id (`1`). Unset, nobody is admin. |
| `PORT` | no | Provided by Railway; defaults to 5000. |
| `FRONTEND_URL` | no | Another origin allowed to call the API and open sockets, only for a client hosted elsewhere. Unset, production allows only its own pages (same-origin needs no CORS); development allows the Vite dev server, `http://localhost:5173`. |
| `AUTH_SERVICE_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` | no | Central SSO. All three enable the "Sign in with SSO" button. Set **server-side only** — no build-time (`VITE_`) vars needed. |
| `APP_BASE_URL` | no | Overrides the origin used to build the OAuth `redirect_uri`. Only needed if the request host differs from the public URL. |

> **SSO note:** SSO is a **server-side** confidential OAuth client (fleet-kit's `createWaypoint`,
> `server/config/auth.js`). The browser only hits same-origin routes (`/api/auth/sso/login`,
> then Waypoint, then `/auth/callback`, which the server answers itself: it checks the state
> cookie, exchanges the code and sets the session); the `client_id`/`secret` never reach the
> client bundle, so there are no build-time vars to bake in. The `redirect_uri` sent to the
> auth-service is `<this app's origin>/auth/callback`, which must be registered (exactly) on the
> auth-service for this client.
>
> **The session** is an httpOnly `__Host-au_session` cookie: 30 days, renewed daily while in use
> (each renewal stamps `last_seen_at`), and signing out ends it on every device
> (`users.token_version`). The REST API and the game's sockets read the same cookie; a socket's
> handshake must come from the game's own pages (fleet-kit's `originAllowed`). Every write under
> `/api` must come from the game's own pages too (`sameOriginWrites`). Until 2026-10 the session
> was a 7-day token in localStorage: a page that still holds one hands it over once with its first
> `/api/auth/me` and is moved onto the cookie with the end it had. That reader (`legacy` in
> `server/config/auth.js`) can go a week after the deploy.

## Getting started
```bash
npm run install-all          # installs both client and server deps
# configure server/.env (DATABASE_URL, etc.)

npm run dev                  # server (nodemon)
npm run client               # Vite client (separate terminal)
```

No Postgres handy? `cd server && npm run dev:local` runs the server on an in-process PGlite
database (`PGLITE_DIR` to keep it on disk); build the client first and it serves that too.

Test: `cd server && npm test` (the rules engine and auto-crew, the socket adapter, its stations and
handshake, matches across a restart, sign-in against fleet-kit's stand-in Waypoint, admin, games and
the lobby cap, the guest sweep, and fleet-kit's security checks on the real routes in
`server/security.test.js`), and `cd client && npm test` (the sound manifest and lines, what each
event sounds like, the client's copy of the rules).

Production: `npm run build` (builds client), then `npm start` (serves `client/dist` via `server/index.js`).

## Admin
Admin: `/admin`, Waypoint id 1 only (`ADMIN_CENTRAL_USER_IDS=1`). The server decides the page before it goes out (fleet-kit's `adminPage`): signed out goes to sign-in and comes back; anyone else gets a plain "This page is for the site admin." page; every `/api/admin` route answers 403 to a non-admin. The central id decides it on every request; a guest is never an admin.

## Guests
Guests: yes, because a friend should be able to join a lobby from a link with no account. `POST /api/auth/guest` (fleet-kit's, limited per address) mints a Waypoint guest and signs it in (no redirect, no form); the daily guest sweep (`server/services/guestSweep.js`) removes guests idle past 30 days once Waypoint says they may go (fleet-kit's `checkGuests`), and a guest that claimed its account stays.

## Limits
One person may hold ten open lobbies at a time (made in the last day and not started); the create
answer says how many are open and the lobby warns from eight. Each socket may send ten events a
second (`server/sockets/rateLimit.js`); a crew call waits a moment and a half between calls from the
same station.

## Layout
- `shared/gameConstants.json` — the charts, headings and speeds, power, torpedoes, pings, decoys, faults and crew calls (single-sourced client+server).
- `client/src/pages/` — Home (the deck), Login, Register, CreateGame, JoinGame, Lobby (the muster), Game (the control room), Admin (`/admin`; `client/src/lib/adminGate.js` decides what it shows).
- `client/src/game/` — `rules.js` (the client's copy of the rules), `useMatch.js` (a match from the socket), `ChartCanvas.jsx` and `draw.js` (the chart table), `Scope.jsx` (the hydrophone scope), `Stations.jsx` (the four consoles), `CrewPanel.jsx` (the talking faces), `reactions.js` (what each event sounds and looks like), `voice.js` (the crew's lines), `sprites.js` (sprite-factory art).
- `client/src/lib/` — `audio.js` and `soundNames.js` (the site's sound), `useScene.js`, the shared games top bar (fleet-kit's `<fleet-topbar>`, with the menu taken over so Sign out holds the sign-in page and drops the socket), Waypoint sign-in decisions (`signIn.js`), joining a game's room. `client/src/services/api.js` asks `/api/auth/me` once on load (handing over an old token once).
- `server/game/` — `engine.js` (the rules), `ai.js` (the auto-crew and the AI's Easy / Normal / Hard crews), `tutorial.js` (the guided first dive: its lessons, goals and training boat; the words are `client/src/game/tutorial.js`), `map.js` (charts, steps, bearings, routes), `modes.js` (tutorial, vs-ai-easy, vs-ai-normal, vs-ai-hard, crews; older games' vs-ai and vs-ai-veteran play as Easy and Hard), `playtest.js` (scripted players for balance), `constants.js` (+ `*.test.js`).
- `server/sockets/game.js` — the clock that ticks every running match ten times a second (paused when nobody is aboard), the socket.io adapter over the engine; the handshake reads the session cookie and checks the Origin; `rateLimit.js` caps events per socket. It plays from memory and writes each match to Postgres every few seconds. Each play is taken only from a player holding its station in the game they joined, one player may hold several, a refusal comes back as `action-rejected` with a `message`, and a station whose people have all left is handed to the auto-crew until one comes back.
- `server/config/auth.js` — fleet-kit's `createWaypoint` (app `au`, callback `/auth/callback`, guests allowed): the users row by central id (adopting an unclaimed pre-Waypoint row by email), who is a guest (by Waypoint's generated name), the session's row read, sign-out, renewal and the old-token reader.
- `server/routes/` — `auth.js` (the game's own password sign-in and Register, then fleet-kit's router: config, sso/login, me, logout, logout-all, guest), `games.js` (making a game, with the caps: 10 open lobbies and 60 games a day per person, each answer saying how many so the lobby warns first; reading one), `admin.js` (look-only admin views: users, games, and the environment switches shown on or off). `server/index.js` mounts fleet-kit's trust proxy 1, request log, write guard, health (`GET /api/health`: a `SELECT 1` within 3 s, 200 or 503, no database text), JSON 404, admin page gate, SPA fallback and error handler; `server/middleware/securityHeaders.js` is fleet-kit's headers with the game's CSP additions.
- `server/services/matchStore.js` — the `game_matches` table: a match saved so a deploy does not wipe it. `join-game` reads it back and the clock picks up where it was; a row from before the 2026-11 overhaul is not a match, and a game being played starts afresh. A finished game's match is dropped a day after game-over, any other after 7 days unchanged (swept hourly).
- `server/services/guestSweep.js` — removes guests idle for 30 days, after asking Waypoint (fleet-kit's `checkGuests`, `POST /api/auth/proxy/guests`) which of them may go: a guest that claimed its account stays, and nobody is removed while Waypoint cannot answer.
- `scripts/voices.mjs` — makes the crew's lines with ElevenLabs (key from the environment only).
- `database/` — schema.

## Deploy
Railway (project "Games", with the other games). The root `postinstall` installs both
packages and builds the client; `npm start` then serves the API, sockets and the built client.

Healthcheck: `GET /api/health` answers 200 `{status:'ok',db:'ok'}` while Postgres replies, and 503
`{status:'unavailable',db:'not answering'}` otherwise. Set that path as the healthcheck on the live
Railway service (service settings, not a `railway.toml`, which Railway stops reading on 2026-12-01),
with a timeout of 60 to 300 seconds.

## Roadmap
Open work lives in [docs/ROADMAP.md](docs/ROADMAP.md).
