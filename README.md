# admiral-undersea

A digital, real-time version of the **Captain Sonar** board game — create or join a game, sit in a
lobby, and play a live match in the browser.

## Stack
React 18 + Vite (client) · Express + socket.io (server) · Postgres · bcryptjs + JWT sessions

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
| `FRONTEND_URL` | no | CORS / socket origin; defaults to `http://localhost:5173`. |
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

Production: `npm run build` (builds client), then `npm start` (serves via `server/index.js`).

## Layout
- `shared/gameConstants.json` — board, sectors, systems, engineer circuits (single-sourced client+server).
- `client/src/pages/` — Home, Login, Register, AuthCallback, CreateGame, JoinGame, Lobby, Game.
- `client/src/game/` — `MapBoard`, shared `constants.js`, `radio.js` (deduction), `EventLog`, `ToastHost`.
- `server/game/` — pure rules engine: `constants.js`, `map.js`, `engine.js` (+ `*.test.js`).
- `server/sockets/game.js` — thin socket.io adapter over the engine.
- `server/routes/` — `auth.js`, `games.js`.
- `database/` — schema.

## Deploy
Railway.

## Notes
Real-time multiplayer (socket.io).
