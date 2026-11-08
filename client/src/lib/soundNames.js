// Every sound the boat asks for. The manifest (public/audio/manifest.json) may name only these,
// and a name with no recording is just quiet, so a missing file never breaks play. All are our
// own, made in games-media's sound factory (library/sounds/admiral-*).
export const SFX = [
  'sonar',    // a ping: the enemy pinging us, our sonar's answer coming back, a drone's report
  'torpedo',  // one of ours leaving its tube
  'hit',      // a blast that damages our hull: a close, deep boom and the steel ringing
  'far',      // a blast that does not: a muffled thud off the hull, a near miss or our torpedo landing
  'creak',    // the hull groaning: after a hit, and when a breakdown or the reactor hurts the boat
  'aye',      // a station answering the captain over the intercom ("Aye, Captain")
];

export const isSoundName = (name) => SFX.includes(name);
