// Single-sourced game data (shared with the client via ../../shared/gameConstants.json), plus the
// server's own tuning on top of it. Every number a player can feel lives in one of the two.
const DATA = require('../../shared/gameConstants.json');

const STATIONS = DATA.stations; // helm, listener, weapons, chief
const HEADINGS = DATA.headings; // N, NE, E, SE, S, SW, W, NW (index * 45 degrees)
const TEAMS = ['alpha', 'bravo'];

// The server's sim and its noise model. Levels: 1 a slow boat, 2 half, 3 full, 4 a running
// torpedo or a scrape on rock, 5 a launch or a ping, 6 a blast.
const TUNING = {
  TICK_SECONDS: 0.1,
  MATCH_SECONDS: DATA.matchSeconds, // then the boat with more hull wins (equal is a draw)
  HEAT_PER_OVER_POWER: 7,       // per second, for each power above the base
  HEAT_COOL: 6,                 // per second, at or under the base
  HEAT_FIRE: 6,                 // per second while a fire burns
  SCRAM_SECONDS: 8,
  HEAT_AFTER_SCRAM: 60,
  FIRE_ENGINE_CAP: 2,           // engines power while a fire burns
  FLOOD_DAMAGE_SECONDS: 20,     // a flood left alone costs one hull this often
  TORPEDO_NOISE_EVERY: 0.6,
  DECOY_NOISE_EVERY: 1.1,
  WHALE_SECONDS_PER_CELL: 4,
  WHALE_SONG_MIN: 9,
  WHALE_SONG_MAX: 16,
  CONTACT_TTL: 45,              // seconds a heard contact stays on the plot
  MAX_CONTACTS: 60,
  BLAST_TTL: 12,
  VENT_MASK: 2,                 // a boat in a vent field is this much quieter
  HEAR_BASE: 2,
  HEAR_PER_LEVEL: 3.2,
  HEAR_PER_SONAR: 0.8,
  // Our own flow noise: how far we hear at each of our speeds (stop, slow, half, full). A boat at
  // Full is nearly deaf, and what it does hear comes in as a wider bearing.
  HEAR_SPEED_FACTOR: DATA.hearingAtSpeed,
  WIDTH_AT_FULL: 1.4,
  SONAR_FAULT_FACTOR: 0.6,
  // A running torpedo's seeker, once armed, turns onto something loud near it: a decoy within
  // SEEKER_DECOY_RANGE (it goes for a decoy first), else a boat by the noise it makes
  // (its speed, less a vent field's mask): Half within 1.5 cells, Full within 3, Slow never.
  SEEKER_RANGE: [0, 0, 1.5, 3],
  SEEKER_DECOY_RANGE: 3.5,
  SEEKER_CONE: 70,              // degrees either side of its run that a seeker hears

  WIDTH_BASE: 28,
  WIDTH_PER_LEVEL: 5,
  WIDTH_PER_SONAR: 3,
  WIDTH_PER_CELL: 1.2,
  WIDTH_MIN: 4,
  WIDTH_MAX: 45,
  NEAR_CELLS: 3,                // a contact this close is marked near
  AWAY_SECONDS: 15,             // a station whose players are all gone this long is run by the auto-crew
  FOCUS_SECONDS: 2,             // a held station nobody is looking at is covered by the auto-crew after this
  CALL_COOLDOWN: 1.5,
  CALL_BOOST_SECONDS: 20,       // the auto chief answers a call for power for this long
  FIRE_MIN_DISTANCE: 3.5,       // the auto torpedo room fires from at least this far (a torpedo arms after TORPEDO.armAfter)
};

module.exports = {
  DATA,
  BOARD: DATA.board,
  MAPS: DATA.maps,
  STATIONS,
  HEADINGS,
  TEAMS,
  SPEEDS: DATA.speeds,
  SECONDS_PER_CELL: DATA.secondsPerCell,
  HULL_MAX: DATA.hullMax,
  POWER: DATA.power,
  TORPEDO: DATA.torpedo,
  PING: DATA.ping,
  DECOY: DATA.decoy,
  VENT: DATA.vent,
  REPAIR_SECONDS: DATA.repairSeconds,
  FAULTS: DATA.faults,
  FAULT_KINDS: Object.keys(DATA.faults),
  CALLS: DATA.calls,
  CALL_IDS: Object.keys(DATA.calls),
  TUNING,
};
