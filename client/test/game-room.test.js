// Joining a game's room (src/lib/gameRoom.js): once on arrival, and again after every
// reconnect, since the server forgets a socket's game and team when the connection drops.
import test from 'node:test'
import assert from 'node:assert/strict'
import { joinGameOnConnect, joinGame, stallNotice, stallOver, STALL_NOTE, connectionLost, LOST_AFTER_MS, endedNote } from '../src/lib/gameRoom.js'

function fakeSocket(connected) {
  const listeners = {}
  const socket = {
    connected,
    emitted: [],
    emit(ev, payload) { socket.emitted.push({ ev, payload }) },
    on(ev, fn) { (listeners[ev] ||= []).push(fn) },
    off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn) },
    fire(ev) { for (const fn of listeners[ev] || []) fn() },
  }
  return socket
}

test('an open socket joins straight away', () => {
  const socket = fakeSocket(true)
  joinGameOnConnect(socket, 'ABC123')
  assert.deepEqual(socket.emitted, [{ ev: 'join-game', payload: { gameCode: 'ABC123' } }])
})

test('a socket still connecting joins once it connects, not before', () => {
  const socket = fakeSocket(false)
  joinGameOnConnect(socket, 'ABC123')
  assert.equal(socket.emitted.length, 0)
  socket.fire('connect')
  assert.equal(socket.emitted.length, 1)
})

test('every reconnect joins the game again', () => {
  const socket = fakeSocket(true)
  joinGameOnConnect(socket, 'ABC123')
  socket.fire('connect')
  socket.fire('connect')
  assert.equal(socket.emitted.length, 3)
  assert.ok(socket.emitted.every((e) => e.ev === 'join-game' && e.payload.gameCode === 'ABC123'))
})

test('leaving the page stops the rejoins', () => {
  const socket = fakeSocket(false)
  const stop = joinGameOnConnect(socket, 'ABC123')
  stop()
  socket.fire('connect')
  assert.equal(socket.emitted.length, 0)
})

// A stalled match (the server's 'match-error'): the notice, its Rejoin, and what ends it.
test('Rejoin joins the game again', () => {
  const socket = fakeSocket(true)
  joinGame(socket, 'ABC123')
  assert.deepEqual(socket.emitted, [{ ev: 'join-game', payload: { gameCode: 'ABC123' } }])
})

test('a stall notice says to rejoin, at the time the server stopped, else the last view\'s', () => {
  assert.deepEqual(stallNotice({ reason: 'stalled', message: '<b>anything</b>', t: 42.5 }, 40), { message: STALL_NOTE, t: 42.5 })
  assert.equal(STALL_NOTE, 'The boat stalled: rejoin to carry on.')
  assert.equal(stallNotice({ t: null }, 40).t, 40)
  assert.equal(stallNotice(undefined, undefined).t, 0)
})

test('a play during the stall keeps the notice; the clock moving again, or a full view, ends it', () => {
  const stall = stallNotice({ t: 42.5 })
  assert.equal(stallOver(stall, { t: 42.5 }), false, 'a view from a play while stopped')
  assert.equal(stallOver(stall, { t: 42.6 }), true, 'someone rejoined and the clock runs')
  assert.equal(stallOver(stall, { t: 42.5, contacts: [] }), true, 'this player\'s own rejoin')
})

// A dropped connection often leaves the socket looking open for half a minute, so the game page
// says the connection is lost once a running match's views stop coming, or the socket is closed.
test('a running match with no view for a few seconds is a lost connection', () => {
  const view = { v: 2, t: 40, over: null }
  const base = { connected: true, view, over: null, lastViewAt: 10000 }
  assert.equal(connectionLost({ ...base, now: 10000 + 500 }), false)
  assert.equal(connectionLost({ ...base, now: 10000 + LOST_AFTER_MS + 1 }), true)
  assert.equal(connectionLost({ ...base, connected: false, now: 10000 + 500 }), true, 'a closed socket says so at once')
})

test('no lost-connection notice while the clock is stopped by design', () => {
  const late = { connected: true, lastViewAt: 0, now: 60000, over: null }
  assert.equal(connectionLost({ ...late, view: null }), false, 'still coming aboard')
  assert.equal(connectionLost({ ...late, view: { t: 12, tutorial: { paused: true } } }), false, 'a tutorial step being read sends nothing')
  assert.equal(connectionLost({ ...late, view: { t: 600, over: { winner: null } } }), false, 'the game is over')
  assert.equal(connectionLost({ ...late, view: { t: 80 }, over: { winner: 'alpha' } }), false, 'game-over came before the last view')
  assert.equal(connectionLost({ ...late, view: { t: 12, tutorial: { paused: false } } }), true)
})

// An ended game's code or lobby link says it is over instead of showing a lobby where nothing works.
test('a finished game is over, said from its result; one still mustering or playing is not', () => {
  const boats = { alpha: 'Marlin', bravo: 'Barracuda' }
  assert.equal(endedNote({ status: 'finished', game_mode: 'crews', winner_team: 'bravo' }, boats), 'This game is over: the Barracuda won.')
  assert.equal(endedNote({ status: 'finished', game_mode: 'vs-ai-hard', winner_team: null }, boats), 'This game is over.')
  assert.equal(endedNote({ status: 'finished', game_mode: 'tutorial', winner_team: null }, boats), 'This training dive is over.')
  assert.equal(endedNote({ status: 'lobby', game_mode: 'crews' }, boats), null)
  assert.equal(endedNote({ status: 'playing', game_mode: 'crews' }, boats), null)
  assert.equal(endedNote(null, boats), null)
})
