# Roadmap

Open ideas, planned work and known issues. One line per item.

The game was rebuilt in November 2026 as our own real-time hunt (four stations, bearings, the
auto-crew and the AI's boat); the old turn-based board rules are gone.

- A third chart, and charts picked in the lobby rather than at random.
- More crew lines for the auto-crew answering calls ("Evading, aye"), within the ElevenLabs budget.
  The crew's voices are written into `scripts/voices.mjs` now, so a new line is one command.
- Spoken lines for the tutorial's cards (they show as text with the teaching face for now).
- Spectators: a seat that watches both boats' charts after the match ends (a replay of the bearings).
- The Easy / Normal / Hard numbers (`server/game/ai.js` SKILLS) are tuned on scripted players
  (`node server/game/playtest.js 100`); they want a few real matches against people.
