# admiral-undersea

A digital, real-time version of the **Captain Sonar** board game — create or join a game, sit in a
lobby, and play a live match in the browser.

**Live:** https://adventurous-imagination-production-d42d.up.railway.app

## Stack
React 18 + Vite 8 (client) · Express + socket.io (server, real-time multiplayer) · Postgres ·
fleet-kit (Waypoint sign-in, the cookie session, headers, limits, log, errors, health, the top bar)

Monorepo with separate `client/` and `server/` packages. fleet-kit is vendored as
`server/vendor/fleet-kit-1.0.7.tgz` and both packages install that one file (the server
`require`s its CommonJS build; the client imports `fleet-kit/client/topbar`). Once it is
published, both take `github:BennettDISH/fleet-kit#v1.0.0` and the vendor folder goes. A kit
change is a new kit version, never a re-packed tarball; never edit the kit here.

> **Status: full game.** All five systems (torpedo, mine, drone, sonar, silence) plus
> surfacing are implemented, with faithful rules: movement legality (no islands / own-trail /
> off-grid), BFS-ranged torpedoes, sector-based drone & sonar, engineering hull damage, and a
> real Radio Operator deduction tool (auto-plot + candidate elimination). Both **turn-based**
> and real-time **Live** modes are supported. Results persist.
>
> The rules live in a pure, DB-free engine (`server/game/`) with unit tests (`cd server && npm test`);
> `server/sockets/game.js` is a thin socket.io adapter over it. Board/system data is single-sourced
> in `shared/gameConstants.json` (imported by both client and server).

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
database (`PGLITE_DIR` to keep it on disk).

Test: `cd server && npm test` (the rules engine, the socket adapter and handshake, sign-in against
fleet-kit's stand-in Waypoint, admin, games, the guest sweep), and `cd client && npm test`.

Production: `npm run build` (builds client), then `npm start` (serves `client/dist` via `server/index.js`).

## Admin
Admin: `/admin`, Waypoint id 1 only (`ADMIN_CENTRAL_USER_IDS=1`). The server decides the page before it goes out (fleet-kit's `adminPage`): signed out goes to sign-in and comes back; anyone else gets a plain "This page is for the site admin." page; every `/api/admin` route answers 403 to a non-admin. The central id decides it on every request; a guest is never an admin.

## Guests
Guests: yes, because a friend should be able to join a lobby from a link with no account. `POST /api/auth/guest` (fleet-kit's, limited per address) mints a Waypoint guest and signs it in (no redirect, no form); the daily guest sweep (`server/services/guestSweep.js`) removes guests idle past 30 days once Waypoint says they may go (fleet-kit's `checkGuests`), and a guest that claimed its account stays.

## Layout
- `shared/gameConstants.json` — board, sectors, systems, engineer circuits (single-sourced client+server).
- `client/src/pages/` — Home, Login, Register, CreateGame, JoinGame, Lobby, Game, Admin (`/admin`; `client/src/lib/adminGate.js` decides what it shows).
- `client/src/game/` — `MapBoard`, shared `constants.js`, `radio.js` (deduction), `EventLog`, `ToastHost`.
- `client/src/components/TopBar.jsx` and `client/src/lib/` — the shared games top bar (fleet-kit's `<fleet-topbar>`, with the menu taken over so Sign out holds the sign-in page and drops the socket), Waypoint sign-in decisions (`signIn.js`: straight to Waypoint or not, where to come back to, what a `?error=` says), joining a game's room. `client/src/services/api.js` asks `/api/auth/me` once on load (handing over an old token once).
- `server/game/` — pure rules engine: `constants.js`, `map.js`, `engine.js` (+ `*.test.js`).
- `server/sockets/game.js` — thin socket.io adapter over the engine; the handshake reads the session cookie and checks the Origin; `rateLimit.js` caps events per socket. It plays from memory and writes each match to Postgres a moment after it changes.
- `server/config/auth.js` — fleet-kit's `createWaypoint` (app `au`, callback `/auth/callback`, guests allowed): the users row by central id (adopting an unclaimed pre-Waypoint row by email), who is a guest (by Waypoint's generated name), the session's row read, sign-out, renewal and the old-token reader.
- `server/routes/` — `auth.js` (the game's own password sign-in and Register, then fleet-kit's router: config, sso/login, me, logout, logout-all, guest), `games.js`, `admin.js` (look-only admin views: users, games, and the environment switches shown on or off). `server/index.js` mounts fleet-kit's trust proxy 1, request log, write guard, health (`GET /api/health`: a `SELECT 1` within 3 s, 200 or 503, no database text), JSON 404, admin page gate, SPA fallback and error handler; `server/middleware/securityHeaders.js` is fleet-kit's headers with the game's CSP additions.
- `server/services/matchStore.js` — the `game_matches` table: a match (or the lobby's automated-roles setup) saved so a deploy does not wipe it. `join-game` reads it back, timers and automated crew pick up where they were, and a finished game's match is dropped a day after game-over, any other after 7 days unchanged (swept hourly).
- `server/services/guestSweep.js` — removes guests idle for 30 days, after asking Waypoint (fleet-kit's `checkGuests`, `POST /api/auth/proxy/guests`) which of them may go: a guest that claimed its account stays, and nobody is removed while Waypoint cannot answer.
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
