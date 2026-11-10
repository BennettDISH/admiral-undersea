// Every sound the boat asks for. The manifest (public/audio/manifest.json) may name only these,
// and a name with no recording is just quiet, so a missing file never breaks play. The effects
// and music are our own, made in games-media's sound factory (library/sounds/admiral-*); the crew's
// voices are short ElevenLabs lines (voice.<station>.<line>, listed in game/voice.js).
export const SFX = [
  // the first ones, from 2026-11-08
  'sonar',       // a ping heard back: a drone's or sonar's report (kept for the scope's returns)
  'torpedo',     // one of ours leaving its tube
  'hit',         // a blast that damages our hull: a close, deep boom and the steel ringing
  'far',         // a blast that does not: a muffled thud off the hull
  'creak',       // the hull groaning after a hit
  'aye',         // a station answering over the intercom
  // music and ambience (loops)
  'music.menu', 'music.calm', 'music.fight', 'sting.win', 'sting.lose',
  'amb.hull', 'amb.sea',
  // the consoles
  'ui.click', 'ui.lever', 'ui.beep',
  // the hunt
  'ping.out', 'ping.in', 'blip', 'tube.load', 'torpedo.run', 'klaxon', 'scrape', 'decoy', 'vent',
  'fire', 'flood', 'repair', 'scram', 'power.up', 'whale', 'sink', 'breach', 'bubbles', 'dive',
]

const VOICE = /^voice\.(helm|listener|weapons|chief|deck)\.[a-z0-9-]{1,24}$/

export const isSoundName = (name) => SFX.includes(name) || VOICE.test(name)
