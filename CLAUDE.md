# Admiral Undersea

Our own real-time submarine hunt: a boat of four stations (helm, listening, torpedo room, engine
room), each depending on the others, against the AI's boat or a crew of friends. The rules are
ours; never borrow a board game's name, roles, boards or rules text.

- Rules engine: `server/game/engine.js` (pure, ticked ten times a second), the auto-crew and AI
  boat `server/game/ai.js` (a belief map from what its own boat heard, never the truth), data in
  `shared/gameConstants.json` (charts, power, torpedoes, pings) shared with the client.
- Sound: one site-wide engine (`client/src/lib/audio.js`) opened by the first click; the manifest
  `client/public/audio/manifest.json` (our sound-factory effects and songs on the media host, the
  crew's ElevenLabs lines in `client/public/audio/voice/`, made by `scripts/voices.mjs`).
  `/pane-quiet.js` keeps the desktop app's test browser silent; never remove it.

## Architecture
- **Frontend**: React 18 + Vite + SASS (`/client/`)
- **Backend**: Express.js + Socket.IO (`/server/`)
- **Database**: PostgreSQL
- **Auth**: fleet-kit's Waypoint sign-in and cookie session (`server/config/auth.js`), plus the game's own password forms (bcryptjs, `server/routes/auth.js`)
- **Deployment**: Railway (auto-deploys on git push)

## Commands
```bash
npm run dev          # Start the server only (nodemon)
npm run client       # Start the Vite client (a second terminal)
npm run build        # Build client for production
npm run start        # Start production server
npm test             # Server tests, then client tests
```

## Project Structure
- `/server/` — Express backend with Socket.IO for real-time gameplay
- `/client/` — React Vite frontend
- `/database/` — Database schemas

## Deployment
- **Platform**: Railway
- Push to main → automatic rebuild and deploy
- Entry: `node server/index.js`
