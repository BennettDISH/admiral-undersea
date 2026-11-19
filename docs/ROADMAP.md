# Roadmap

Open ideas, planned work and known issues. One line per item.

The game was rebuilt in November 2026 as our own real-time hunt (four stations, bearings, the
auto-crew and the AI's boat); the old turn-based board rules are gone. As of 2026-11-18 the game
is finished: from here on only real bugs and fleet-kit bumps, no new modes unless asked.

- The Easy / Normal / Hard numbers (`server/game/ai.js` SKILLS) are tuned on scripted players
  (`node server/game/playtest.js 100`); they want a few real matches against people, then one
  tuning pass. Charging in must keep losing and a careful hunt winning.

Cut on 2026-11-18 (not to be picked up again unless asked): a third chart and a chart pick in the
lobby, more crew lines, spoken lines for the tutorial's cards, and spectators. The hidden `?local`
password form and Register stay as they are, so old accounts are never locked out.
