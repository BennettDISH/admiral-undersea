// What the boat does when something happens: every 'fx' event from the server becomes sounds, a
// crew line, something to see on the chart and a line in the log. Pure (the Game page plays it),
// so what a player hears for each event is tested on its own.
import { CALLS, CONTACT_INFO, FAULTS, cellName, dist, bearingText } from './rules.js'

const SPEED_LINES = ['voice.helm.stop', 'voice.helm.slow', 'voice.helm.half', 'voice.helm.full']
const FAULT_LINES = { fire: 'voice.chief.fire', flood: 'voice.weapons.flood', sonar: 'voice.chief.sonar-dmg', rudder: 'voice.helm.rudder' }

/** A fresh memory for throttling repeated lines; keep one per match. */
export const newMemory = () => new Map()

function every(memory, key, ms, now) {
  const last = memory.get(key)
  if (last !== undefined && now - last < ms) return false
  memory.set(key, now)
  return true
}

/**
 * The cues for one event. `ctx` is { team, boat (our view's boat, may be null), now (ms), memory }.
 * Returns { sounds: [[name, opts]], say, visual, log, alarm, shake, flash, tension }.
 */
export function react(ev, { team, boat, now = Date.now(), memory = newMemory() }) {
  const out = { sounds: [], say: null, visual: null, log: null, alarm: 0, shake: null, flash: false, tension: 0 }
  const sound = (name, opts = {}) => out.sounds.push([name, opts])
  const say = (name, gapMs = 0) => { if (!gapMs || every(memory, name, gapMs, now)) out.say = out.say || name }
  const log = (kind, text) => { out.log = { kind, text } }
  const ours = ev.team === team

  switch (ev.type) {
    case 'contact': {
      const c = ev.contact
      const where = c.exact ? cellName(c.x, c.y) : `bearing ${bearingText(c.bearing)}`
      if (c.kind === 'hull' || c.kind === 'vent' || c.kind === 'scrape') {
        if (every(memory, 'blip', 900, now)) sound('blip', { vol: c.near ? 0.9 : 0.55 })
        say('voice.listener.contact', 25000)
        out.tension = c.near ? 0.5 : 0.25
      } else if (c.kind === 'bio') {
        sound('whale', { vol: 0.5 })
        say('voice.listener.bio', 60000)
      } else if (c.kind === 'launch') {
        sound('klaxon', { vol: 0.8 })
        say('voice.listener.launch')
        out.alarm = 6
        out.tension = 1
      } else if (c.kind === 'torpedo') {
        if (every(memory, `torpedo-${c.ref}`, 8000, now)) {
          say('voice.listener.torpedo')
          if (every(memory, 'klaxon', 5000, now)) sound('klaxon', { vol: 0.8 })
        }
        if (every(memory, 'torpedo-blip', 500, now)) sound('blip', { pitch: 1.6, vol: 0.8 })
        out.alarm = 3
        out.tension = 1
      } else if (c.kind === 'ping') {
        sound('ping.in')
        say('voice.listener.pinged')
        out.tension = 0.8
      }
      out.visual = { kind: 'contact', contact: c }
      log(c.kind === 'torpedo' || c.kind === 'launch' ? 'alarm' : 'contact', `${CONTACT_INFO[c.kind]?.label || 'Contact'}, ${where}${c.near ? ', close!' : ''}`)
      break
    }
    case 'ping-result': {
      const found = ev.ping.found.find((f) => f.kind === 'boat')
      sound('ping.out')
      if (found) {
        sound('sonar', { delay: 0.9, pitch: 1.1 })
        say('voice.listener.ping-hit')
        log('alarm', `Ping return: enemy boat at ${cellName(found.x, found.y)}`)
        out.tension = 0.8
      } else {
        say('voice.listener.ping-miss')
        log('info', `Ping clean within ${ev.ping.radius} cells${ev.ping.found.length ? ` (${ev.ping.found.length} small return${ev.ping.found.length > 1 ? 's' : ''})` : ''}`)
      }
      out.visual = { kind: 'ping', ping: ev.ping }
      break
    }
    case 'pinged':
      break // the exact contact that comes with it says it
    case 'fired':
      sound('torpedo')
      say('voice.weapons.fire')
      log('attack', `Torpedo away from tube ${ev.tube + 1}, running to ${cellName(ev.tx, ev.ty)}`)
      out.tension = 0.7
      break
    case 'guided':
      if (every(memory, 'guided', 300, now)) sound('ui.beep', { vol: 0.5 })
      break
    case 'tube-loading':
      sound('ui.lever', { vol: 0.6 })
      break
    case 'tube-loaded':
      sound('tube.load')
      say(ev.tube === 0 ? 'voice.weapons.loaded-1' : 'voice.weapons.loaded-2')
      log('info', `Tube ${ev.tube + 1} loaded`)
      break
    case 'torpedo-spent':
      say('voice.weapons.miss')
      log('info', 'Our torpedo ran out of fuel')
      break
    case 'decoy-out':
      sound('decoy')
      say('voice.weapons.decoy')
      log('info', 'Decoy away')
      break
    case 'blast': {
      const near = boat ? dist(boat, ev) : 99
      const delay = Math.min(1.2, near * 0.08)
      if (near > 1.5) sound('far', { vol: Math.max(0.35, 1 - near / 14), delay })
      out.visual = { kind: 'blast', x: ev.x, y: ev.y }
      out.shake = near <= 1.5 ? null : near < 4 ? 'small' : null
      log('attack', `Explosion at ${cellName(ev.x, ev.y)}`)
      out.tension = 0.6
      break
    }
    case 'hit':
      if (ours) {
        if (ev.cause === 'torpedo') {
          sound('hit')
          sound('breach', { delay: 0.25 })
          sound('creak', { delay: 0.7 })
          sound('bubbles', { delay: 0.4 })
          say('voice.deck.hit-us')
          out.shake = 'big'
          out.flash = true
        } else if (ev.cause === 'rock') {
          sound('creak')
          out.shake = 'small'
        } else if (ev.cause === 'flood') {
          sound('creak')
          sound('bubbles')
          out.shake = 'small'
        }
        log('damage', `${ev.cause === 'flood' ? 'Flooding' : ev.cause === 'rock' ? 'Rocks' : 'Hit'}: hull ${ev.hull}`)
        out.tension = 1
      } else {
        if (ev.cause === 'torpedo') {
          say('voice.weapons.hit')
          sound('breach', { vol: 0.5, delay: 0.5 })
          log('attack', `Hit on the enemy! Their hull: ${ev.hull}`)
        } else log('info', `The enemy took damage: hull ${ev.hull}`)
        out.tension = 0.7
      }
      break
    case 'fault':
      sound(ev.kind === 'fire' ? 'fire' : ev.kind === 'flood' ? 'flood' : 'creak', { vol: 0.8 })
      say(FAULT_LINES[ev.kind])
      log('damage', FAULTS[ev.kind]?.name || ev.kind)
      break
    case 'repairing':
      sound('repair', { vol: 0.7 })
      break
    case 'repaired':
      sound('repair')
      say('voice.chief.repaired', 4000)
      log('info', `Repaired: ${FAULTS[ev.kind]?.name || ev.kind}`)
      break
    case 'scram':
      sound('scram')
      say('voice.chief.scram')
      log('damage', 'Reactor scram: no power')
      out.tension = 0.9
      break
    case 'power-up':
      sound('power.up')
      say('voice.chief.power-up')
      log('info', 'Reactor back online')
      break
    case 'heat-warning':
      sound('ui.beep', { pitch: 0.7 })
      say('voice.chief.hot', 15000)
      break
    case 'vented':
      sound('vent')
      say('voice.chief.vent', 10000)
      break
    case 'power':
      if (every(memory, 'lever', 250, now)) sound('ui.lever', { vol: 0.5 })
      break
    case 'rocks-ahead':
      sound('ui.beep', { pitch: 1.4 })
      say('voice.helm.rocks', 4000)
      log('alarm', 'Rocks ahead!')
      break
    case 'collision':
      sound('scrape', { vol: ev.damage ? 1 : 0.5 })
      if (ev.damage) say('voice.helm.scrape')
      log('damage', ev.damage ? 'We hit the rocks!' : 'Bumped a rock: all stop')
      break
    case 'helm':
      if (every(memory, 'helm-lever', 200, now)) sound('ui.lever', { vol: 0.6 })
      if (memory.get('speed') !== ev.speed) {
        memory.set('speed', ev.speed)
        say(SPEED_LINES[ev.speed], 2500)
      }
      break
    case 'marker':
      if (ev.marker) {
        sound('ui.beep', { vol: 0.6 })
        say('voice.listener.mark', 15000)
      }
      break
    case 'call':
      sound('ui.beep', { pitch: 1.2, vol: 0.6 })
      say(`voice.deck.${ev.call}`)
      out.visual = { kind: 'call', station: ev.station, call: ev.call }
      log('call', CALLS[ev.call] || ev.call)
      if (ev.call === 'power-engines' || ev.call === 'power-sonar' || ev.call === 'power-tubes') memory.set('answer-power', now)
      break
    case 'clock':
      if (ev.left === 120) say('voice.deck.two-min')
      sound('ui.beep', { pitch: 0.8 })
      log('alarm', ev.left === 120 ? 'Two minutes on the clock' : 'Thirty seconds!')
      out.tension = 0.6
      break
    case 'sunk':
      sound('sink', { delay: 0.5 })
      out.visual = { kind: 'sunk', team: ev.team }
      break
    default:
      break
  }
  return out
}

/** The end: our sting and the deck's last word. */
export function ending(winner, team) {
  if (winner === team) return { sound: 'sting.win', say: 'voice.deck.win', title: 'Victory', line: 'The enemy boat is breaking up.' }
  if (winner === null) return { sound: 'sting.lose', say: null, title: 'Stalemate', line: 'Time ran out with both boats even.' }
  return { sound: 'sting.lose', say: 'voice.deck.lose', title: 'Sunk', line: 'Our boat is going down.' }
}
