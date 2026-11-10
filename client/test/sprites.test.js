// The sprite factory's frames on the chart and the portraits (src/game/sprites.js): which frame a
// clip shows when, looping or once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { frameAt, hasSet } from '../src/game/sprites.js'

const clip = (n, { fps = 10, loop = true } = {}) => ({ fps, loop, frames: Array.from({ length: n }, (_, i) => [0, i, 0, 1, 1, 0, 0]) })

test('a loop wraps round; a one-shot ends after its last frame', () => {
  const loop = clip(4)
  assert.equal(frameAt(loop, 0)[1], 0)
  assert.equal(frameAt(loop, 0.35)[1], 3)
  assert.equal(frameAt(loop, 0.45)[1], 0, 'round again')
  assert.equal(frameAt(loop, -0.05)[1], 3, 'a time a moment early still draws')
  const once = clip(4, { loop: false })
  assert.equal(frameAt(once, 0.35)[1], 3)
  assert.equal(frameAt(once, 0.45), null, 'over')
  assert.equal(frameAt(loop, 0.45, true), null, 'a loop asked for once ends too')
})

test('the art manifest names the undersea set and every crew face with its mouths and blink, all on the media host', () => {
  const art = JSON.parse(readFileSync(new URL('../public/art/manifest.json', import.meta.url), 'utf8'))
  const names = Object.keys(art.sets)
  assert.ok(names.includes('fx-undersea'))
  for (const who of ['helm', 'listener', 'torpedo', 'chief']) {
    for (const part of ['', '-mouth-closed', '-mouth-small', '-mouth-open', '-blink']) assert.ok(names.includes(`crew-${who}${part}`), `crew-${who}${part}`)
  }
  for (const [name, url] of Object.entries(art.sets)) {
    assert.match(url, new RegExp(`^https://media\\.bennettdishmanmedia\\.com/spellweave/art/${name}/frames-[0-9a-f]{8}\\.json$`), name)
  }
})

test('nothing is drawn from a set that has not loaded', () => {
  assert.equal(hasSet('crew-helm'), false)
})
