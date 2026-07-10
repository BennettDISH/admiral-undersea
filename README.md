# admiral-undersea

A digital, real-time version of the **Captain Sonar** board game — create or join a game, sit in a
lobby, and play a live match in the browser.

## Stack
React 18 + Vite (client) · Express + socket.io (server) · Postgres · bcryptjs auth

Monorepo with separate `client/` and `server/` packages.

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
