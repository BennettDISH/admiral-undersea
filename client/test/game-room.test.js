// Joining a game's room (src/lib/gameRoom.js): once on arrival, and again after every
// reconnect, since the server forgets a socket's game and team when the connection drops.
import test from 'node:test'
import assert from 'node:assert/strict'
import { joinGameOnConnect, joinGame, stallNotice, stallOver, STALL_NOTE } from '../src/lib/gameRoom.js'

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
