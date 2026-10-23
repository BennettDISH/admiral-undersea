# admiral-undersea

A digital, real-time version of the **Captain Sonar** board game — create or join a game, sit in a
lobby, and play a live match in the browser.

**Live:** https://adventurous-imagination-production-d42d.up.railway.app

## Stack
React 18 + Vite (client) · Express + socket.io (server, real-time multiplayer) · Postgres ·
bcryptjs + JWT sessions

Monorepo with separate `client/` and `server/` packages.

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
| `JWT_SECRET` | **yes in production** | Signs session tokens. The server **refuses to start** in production without it. |
| `NODE_ENV` | recommended | Set to `production` on Railway (enables the `JWT_SECRET` guard + Express prod mode). |
| `PORT` | no | Provided by Railway; defaults to 5000. |
| `FRONTEND_URL` | no | Another origin allowed to call the API and open sockets, only for a client hosted elsewhere. Unset, production allows only its own pages (same-origin needs no CORS); development allows the Vite dev server, `http://localhost:5173`. |
| `AUTH_SERVICE_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` | no | Central SSO. All three enable the "Sign in with SSO" button. Set **server-side only** — no build-time (`VITE_`) vars needed. |
| `APP_BASE_URL` | no | Overrides the origin used to build the OAuth `redirect_uri`. Only needed if the request host differs from the public URL. |

> **SSO note:** SSO is a **server-side** confidential OAuth client (same pattern as the CMS).
> The browser only hits same-origin routes (`/api/auth/sso/login`, `/auth/callback`); the
> `client_id`/`secret` never reach the client bundle, so there are no build-time vars to bake
> in. The `redirect_uri` sent to the auth-service is `<this app's origin>/auth/callback`, which
> must be registered (exactly) on the auth-service for this client.

## Getting started
```bash
npm run install-all          # installs both client and server deps
# configure server/.env (DATABASE_URL, etc.)

npm run dev                  # server (nodemon)
npm run client               # Vite client (separate terminal)
```

No Postgres handy? `cd server && npm run dev:local` runs the server on an in-process PGlite
database (`PGLITE_DIR` to keep it on disk).

Test: `cd server && npm test` (the rules engine plus a socket integration test).

Production: `npm run build` (builds client), then `npm start` (serves `client/dist` via `server/index.js`).

## Admin
Admin: `/admin`, Waypoint id 1 only (`ADMIN_CENTRAL_USER_IDS=1`). Signed out goes to sign-in and comes back; anyone else sees "This page is for the site admin."; every `/api/admin` route answers 403 to a non-admin.

## Layout
- `shared/gameConstants.json` — board, sectors, systems, engineer circuits (single-sourced client+server).
- `client/src/pages/` — Home, Login, Register, AuthCallback, CreateGame, JoinGame, Lobby, Game, Admin (`/admin`; `client/src/lib/adminGate.js` decides what it shows).
- `client/src/game/` — `MapBoard`, shared `constants.js`, `radio.js` (deduction), `EventLog`, `ToastHost`.
- `client/src/components/TopBar.jsx` and `client/src/lib/` — the shared games top bar, Waypoint sign-in, joining a game's room.
- `server/game/` — pure rules engine: `constants.js`, `map.js`, `engine.js` (+ `*.test.js`).
- `server/sockets/game.js` — thin socket.io adapter over the engine; `rateLimit.js` caps events per socket. It plays from memory and writes each match to Postgres a moment after it changes.
- `server/routes/` — `auth.js`, `games.js`, `admin.js` (look-only admin views: users, games, and the environment switches shown on or off), `health.js` (`GET /api/health`: a `SELECT 1` with a 3 s timeout, 200 or 503, no database text); `server/middleware/` — session and admin checks.
- `server/services/matchStore.js` — the `game_matches` table: a match (or the lobby's automated-roles setup) saved so a deploy does not wipe it. `join-game` reads it back, timers and automated crew pick up where they were, and a finished game's match is dropped a day after game-over, any other after 7 days unchanged (swept hourly).
- `server/services/guestSweep.js`, `guestCheck.js` — removes guests idle for 30 days, after asking Waypoint (`POST /api/auth/proxy/guests`) which of them may go: a guest that claimed its account stays, and nobody is removed while Waypoint cannot answer.
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
