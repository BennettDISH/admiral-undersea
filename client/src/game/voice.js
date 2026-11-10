// The crew's callouts: short lines, one voice per station and one for the deck (orders, the
// clock, the end). Made once with ElevenLabs by scripts/voices.mjs, which reads this list, and
// played over the intercom (lib/audio.js say()). The text is also the caption under the portrait.
export const SPEAKERS = {
  helm: { station: 'helm' },
  listener: { station: 'listener' },
  weapons: { station: 'weapons' },
  chief: { station: 'chief' },
  deck: { station: null },
}

export const LINES = {
  'voice.helm.full': 'All ahead full, aye!',
  'voice.helm.half': 'Half ahead.',
  'voice.helm.slow': 'Slow ahead. Nice and quiet.',
  'voice.helm.stop': 'All stop.',
  'voice.helm.rocks': 'Rocks ahead!',
  'voice.helm.scrape': "We've hit the rocks!",
  'voice.helm.rudder': "Rudder's jammed!",

  'voice.listener.contact': 'Contact. Machinery noise.',
  'voice.listener.bio': 'Biologics. Just a whale.',
  'voice.listener.torpedo': 'Torpedo in the water!',
  'voice.listener.launch': "Launch transient! They've fired!",
  'voice.listener.pinged': "They pinged us! They know where we are!",
  'voice.listener.ping': 'Pinging.',
  'voice.listener.ping-hit': 'Ping return. Got them!',
  'voice.listener.ping-miss': 'Ping is clean. Nothing close.',
  'voice.listener.mark': 'Target marked.',
  'voice.listener.deaf': "Flow noise! I can't hear a thing at full speed.",

  'voice.weapons.loaded-1': 'Tube one loaded.',
  'voice.weapons.loaded-2': 'Tube two loaded.',
  'voice.weapons.fire': 'Fire! Torpedo away!',
  'voice.weapons.decoy': 'Decoy away!',
  'voice.weapons.hit': 'Good hit! We got them!',
  'voice.weapons.miss': 'Miss. Reloading.',
  'voice.weapons.flood': 'Flooding in the torpedo room!',
  'voice.weapons.too-close': "Too close! It won't arm.",
  'voice.weapons.homing': 'Our fish has them on its seeker!',
  'voice.weapons.decoyed': 'They decoyed our fish!',

  'voice.chief.power': 'More power, aye.',
  'voice.chief.fire': 'Fire in the engine room!',
  'voice.chief.repaired': 'Repairs done.',
  'voice.chief.hot': "Reactor's running hot!",
  'voice.chief.scram': "Scram! We've lost the reactor!",
  'voice.chief.power-up': "Reactor's back online.",
  'voice.chief.vent': 'Venting coolant.',
  'voice.chief.sonar-dmg': 'The sonar dome is cracked!',

  'voice.deck.dive': 'Dive! Dive! Take her down!',
  'voice.deck.hit-us': "We're hit! Damage report!",
  'voice.deck.win': 'Enemy boat destroyed. Well done, crew.',
  'voice.deck.lose': 'Abandon ship!',
  'voice.deck.two-min': 'Two minutes left.',
  'voice.deck.power-engines': 'More power to the engines!',
  'voice.deck.power-sonar': 'More power to sonar!',
  'voice.deck.power-tubes': 'More power to the tubes!',
  'voice.deck.evade': 'Evade! Evade!',
  'voice.deck.go-quiet': 'Go quiet.',
  'voice.deck.ping-now': 'Ping them!',
  'voice.deck.fire-when-ready': 'Fire when ready.',
  'voice.deck.hold-fire': 'Hold fire!',
}

/** Which station's portrait speaks a line ('deck' lines have none). */
export const speakerOf = (name) => name.split('.')[1]

/** Every character the lines cost to make, for the ElevenLabs budget. */
export const totalCharacters = () => Object.values(LINES).reduce((n, t) => n + t.length, 0)
