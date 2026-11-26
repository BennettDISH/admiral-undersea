// The bug tracker's button on a phone (src/styles/_room.scss): put away while a match is on, so it
// can't sit over the Helm's Stbd, and back once the match ends.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const scss = readFileSync(new URL('../src/styles/_room.scss', import.meta.url), 'utf8')

test('on a touch screen the report button is hidden only while a match is on', () => {
  const block = /@media \(hover: none\) and \(pointer: coarse\) \{([^}]*\})\s*\}/.exec(scss)
  assert.ok(block, 'a touch-screen rule')
  assert.match(block[1], /body:has\(\.game-page\.control-room\):not\(:has\(\.ending\)\) #bug-tracker-widget-host \{ display: none !important; \}/)
})
