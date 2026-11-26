// The deck (src/pages/Home.jsx): Come aboard opens the sound, then the ways to play show.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8')

test('the deck cards wait for the Come aboard press itself, not for the sound opening', () => {
  // A touch opens the sound on its pointerdown (lib/audio.js armAudio). If the cards replaced the
  // button then, the tap's click would land on the Tutorial card under the finger and start a game.
  assert.match(home, /const \[aboardDone, setAboardDone\] = useState\(unlocked\)/, 'already open (back from a game): the cards at once')
  assert.match(home, /const aboard = \(\) => \{[^}]*setAboardDone\(true\)[^}]*\}/, 'the button\'s own click shows them')
  assert.match(home, /\{!aboardDone \? \(\s*<div className="aboard">/)
  assert.doesNotMatch(home, /\{!unlocked \?/, 'the sound opening alone does not swap the button out')
})
