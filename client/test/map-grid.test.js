// The map as a keyboard grid (src/game/mapGrid.js): how a cell is named, where each key goes,
// and where the tab stop starts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cellLabel, describeCell, keyAction, pickNote, startCell } from '../src/game/mapGrid.js'

const dims = { width: 15, height: 10, page: 5 } // the board: 15 across, 10 down, sectors 5 x 5
const press = (key, at, extra = {}) => keyAction({ key, ...extra }, at, dims)

test('a cell is named by row, column and sector', () => {
  assert.equal(cellLabel(7, 3, 2), 'row 3, column 7, sector 2')
  assert.equal(cellLabel(7, 3, 2, ['water', null, 'torpedo target']), 'row 3, column 7, sector 2, water, torpedo target')
})

test('what is in a cell follows its position, and only what is there', () => {
  const base = { x: 1, y: 1, sector: 1 }
  assert.equal(describeCell({ ...base }), 'row 1, column 1, sector 1, water')
  assert.equal(describeCell({ ...base, island: true }), 'row 1, column 1, sector 1, island')
  assert.equal(describeCell({ ...base, sub: true, path: true }), 'row 1, column 1, sector 1, water, your submarine')
  assert.equal(describeCell({ ...base, path: true, mine: true }), 'row 1, column 1, sector 1, water, your trail, your mine')
  assert.equal(
    describeCell({ ...base, ghostStart: true, ghost: true, candidate: true, annotated: true, enemySector: true }),
    'row 1, column 1, sector 1, water, guessed enemy start, possible enemy position, marked, enemy surfaced in this sector',
  )
  assert.equal(describeCell({ ...base, ghost: true }), 'row 1, column 1, sector 1, water, traced guess')
  assert.equal(describeCell({ ...base, pick: pickNote('torpedo', 1) }), 'row 1, column 1, sector 1, water, torpedo target')
})

test('picking is described for each system', () => {
  assert.equal(pickNote('torpedo', 4), 'torpedo target')
  assert.equal(pickNote('mine', 4), 'mine can go here')
  assert.equal(pickNote('silence', 4), 'can move here silently')
  assert.equal(pickNote('drone-sector', 4), 'scan sector 4')
})

test('the arrow keys move one cell and stop at the edges', () => {
  assert.deepEqual(press('ArrowRight', { x: 3, y: 3 }), { type: 'focus', cell: { x: 4, y: 3 } })
  assert.deepEqual(press('ArrowLeft', { x: 3, y: 3 }), { type: 'focus', cell: { x: 2, y: 3 } })
  assert.deepEqual(press('ArrowUp', { x: 3, y: 3 }), { type: 'focus', cell: { x: 3, y: 2 } })
  assert.deepEqual(press('ArrowDown', { x: 3, y: 3 }), { type: 'focus', cell: { x: 3, y: 4 } })
  assert.deepEqual(press('ArrowLeft', { x: 0, y: 3 }), { type: 'focus', cell: { x: 0, y: 3 } })
  assert.deepEqual(press('ArrowUp', { x: 3, y: 0 }), { type: 'focus', cell: { x: 3, y: 0 } })
  assert.deepEqual(press('ArrowRight', { x: 14, y: 3 }), { type: 'focus', cell: { x: 14, y: 3 } })
  assert.deepEqual(press('ArrowDown', { x: 3, y: 9 }), { type: 'focus', cell: { x: 3, y: 9 } })
})

test('Home and End go to the ends of the row, with Ctrl to the corners; the page keys go a sector', () => {
  assert.deepEqual(press('Home', { x: 8, y: 6 }), { type: 'focus', cell: { x: 0, y: 6 } })
  assert.deepEqual(press('End', { x: 8, y: 6 }), { type: 'focus', cell: { x: 14, y: 6 } })
  assert.deepEqual(press('Home', { x: 8, y: 6 }, { ctrlKey: true }), { type: 'focus', cell: { x: 0, y: 0 } })
  assert.deepEqual(press('End', { x: 8, y: 6 }, { ctrlKey: true }), { type: 'focus', cell: { x: 14, y: 9 } })
  assert.deepEqual(press('PageUp', { x: 8, y: 6 }), { type: 'focus', cell: { x: 8, y: 1 } })
  assert.deepEqual(press('PageDown', { x: 8, y: 2 }), { type: 'focus', cell: { x: 8, y: 7 } })
  assert.deepEqual(press('PageUp', { x: 8, y: 2 }), { type: 'focus', cell: { x: 8, y: 0 } })
  assert.deepEqual(press('PageDown', { x: 8, y: 6 }), { type: 'focus', cell: { x: 8, y: 9 } })
})

test('Enter and Space pick, Escape cancels', () => {
  assert.deepEqual(press('Enter', { x: 1, y: 1 }), { type: 'pick' })
  assert.deepEqual(press(' ', { x: 1, y: 1 }), { type: 'pick' })
  assert.deepEqual(press('Escape', { x: 1, y: 1 }), { type: 'cancel' })
})

test('other keys, and shortcuts with Alt or Meta, are left alone', () => {
  for (const key of ['Tab', 'a', 'Shift', 'F5', 'Backspace']) assert.equal(press(key, { x: 1, y: 1 }), null, key)
  assert.equal(press('ArrowRight', { x: 1, y: 1 }, { altKey: true }), null, 'Alt+Arrow is browser back/forward')
  assert.equal(press('ArrowLeft', { x: 1, y: 1 }, { metaKey: true }), null)
  assert.equal(press('ArrowRight', { x: 1, y: 1 }, { ctrlKey: true }), null, 'Ctrl+Arrow is not ours')
  assert.equal(press('Enter', { x: 1, y: 1 }, { altKey: true }), null)
})

test('the tab stop starts at the legal target nearest the submarine', () => {
  const targets = new Set(['5,5', '2,1', '1,2', '9,9'])
  assert.deepEqual(startCell({ position: { x: 1, y: 1 }, prefer: targets }), { x: 2, y: 1 }, 'reading order breaks the tie at distance 1')
  assert.deepEqual(startCell({ position: { x: 8, y: 8 }, prefer: targets }), { x: 9, y: 9 })
})

test('with no targets the tab stop starts on the submarine, else the top left', () => {
  assert.deepEqual(startCell({ position: { x: 4, y: 6 }, prefer: new Set() }), { x: 4, y: 6 })
  assert.deepEqual(startCell({ position: { x: 4, y: 6 } }), { x: 4, y: 6 })
  assert.deepEqual(startCell({}), { x: 0, y: 0 })
})

test('with no submarine the tab stop starts at the first candidate in reading order', () => {
  assert.deepEqual(startCell({ prefer: new Set(['7,4', '3,4', '9,2']) }), { x: 9, y: 2 })
})
