# Admiral Undersea

Digital version of Captain Sonar board game with real-time multiplayer.

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
