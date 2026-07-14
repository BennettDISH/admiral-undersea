# admiral-undersea

A digital, real-time version of the **Captain Sonar** board game — create or join a game, sit in a
lobby, and play a live match in the browser.

## Stack
React 18 + Vite (client) · Express + socket.io (server) · Postgres · bcryptjs + JWT sessions

Monorepo with separate `client/` and `server/` packages.

> **Status: playable prototype.** The full lobby → move → charge → torpedo loop works and
> results persist, but this is a vertical slice of Captain Sonar — only the torpedo system
> is implemented; mine/drone/sonar/silence, surfacing, and movement legality are not yet built.

## Environment
The server reads these env vars (set them in Railway):

| Var | Required | Purpose |
|-----|----------|---------|
| `DATABASE_URL` | yes | Postgres connection (schema auto-applies on boot). |
| `JWT_SECRET` | **yes in production** | Signs session tokens. The server **refuses to start** in production without it. |
| `NODE_ENV` | recommended | Set to `production` on Railway (enables the `JWT_SECRET` guard + Express prod mode). |
| `PORT` | no | Provided by Railway; defaults to 5000. |
| `FRONTEND_URL` | no | CORS / socket origin; defaults to `http://localhost:5173`. |
| `AUTH_SERVICE_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` | no | **Server-side** SSO (token exchange). All three required to enable central SSO. |
| `VITE_AUTH_SERVICE_URL`, `VITE_SSO_CLIENT_ID` | no | **Client-side** SSO (build-time). Without these the "Sign in with SSO" button does not render. Set the same values as the server vars. |

> **SSO note:** central login is a two-sided config. The **client build** needs the two `VITE_`
> vars (baked in at `npm run build`), and the **server** needs the three non-`VITE_` vars at
> runtime. Because Railway injects env at both build and run, set all five there. The
> `redirect_uri` sent to the auth-service is `<this app's origin>/auth/callback`, which must be
> registered (exactly) on the auth-service for this client.

## Getting started
```bash
npm run install-all          # installs both client and server deps
# configure server/.env (DATABASE_URL, etc.)

npm run dev                  # server (nodemon)
npm run client               # Vite client (separate terminal)
```

Production: `npm run build` (builds client), then `npm start` (serves via `server/index.js`).

## Layout
- `client/src/pages/` — Home, Login, Register, AuthCallback, CreateGame, JoinGame, Lobby, Game.
- `server/routes/` — `auth.js`, `games.js`; real-time play over socket.io.
- `database/` — schema.

## Deploy
Railway.

## Notes
Real-time multiplayer (socket.io). See `../PORTFOLIO.md`.
