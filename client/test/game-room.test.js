// Joining a game's room (src/lib/gameRoom.js): once on arrival, and again after every
// reconnect, since the server forgets a socket's game and team when the connection drops.
import test from 'node:test'
import assert from 'node:assert/strict'
import { joinGameOnConnect } from '../src/lib/gameRoom.js'

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
