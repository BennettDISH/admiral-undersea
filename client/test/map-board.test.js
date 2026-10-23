// MapBoard (src/game/MapBoard.jsx) as markup: a grid with one tab stop, and every cell labelled.
// Node cannot read JSX, so the component is bundled with esbuild (which Vite already ships) and
// rendered to a string with react-dom/server; the keys themselves are tested in map-grid.test.js.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DATA = JSON.parse(readFileSync(resolve(here, '../../shared/gameConstants.json'), 'utf8'))
const MAP = DATA.map
const { width, height } = DATA.board

let dir
let render
before(async () => {
  const entry = `
    import React from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    import MapBoard from ${JSON.stringify(resolve(here, '../src/game/MapBoard.jsx'))}
    export const render = (props) => renderToStaticMarkup(React.createElement(MapBoard, props))
  `
  const bundle = await build({
    stdin: { contents: entry, resolveDir: here, loader: 'js' },
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"test"' },
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  dir = mkdtempSync(join(tmpdir(), 'map-board-'))
  const file = join(dir, 'render.mjs')
  writeFileSync(file, bundle.outputFiles[0].text)
  ;({ render } = await import(pathToFileURL(file).href))
})
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
const cellsOf = (html) => [...html.matchAll(/<div ([^>]*role="gridcell"[^>]*)>/g)].map((m) => attrsOf(m[1]))
const at = (cells, x, y) => cells.find((c) => c['data-x'] === String(x) && c['data-y'] === String(y))
const waterNear = (x, y) => {
  const out = []
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) if (MAP[r][c] === 0 && Math.abs(c - x) + Math.abs(r - y) === 1) out.push({ x: c, y: r })
  return out
}
const sub = { position: { x: 1, y: 1 }, path: [{ x: 1, y: 0 }] }

test('the board is a labelled grid of rows and cells', () => {
  const html = render({ submarine: sub, ariaLabel: "Captain's map" })
  assert.equal([...html.matchAll(/role="grid"/g)].length, 1)
  assert.match(html, /aria-label="Captain&#x27;s map"/)
  assert.match(html, new RegExp(`aria-rowcount="${height}"`))
  assert.match(html, new RegExp(`aria-colcount="${width}"`))
  assert.equal([...html.matchAll(/role="row"/g)].length, height)
  assert.equal(cellsOf(html).length, width * height)
})

test('every cell says its row, column and sector, and what is in it', () => {
  const cells = cellsOf(render({ submarine: sub, mines: [{ x: 4, y: 4 }] }))
  assert.equal(new Set(cells.map((c) => c['aria-label'])).size, width * height, 'no two cells share a label')
  assert.match(at(cells, 7, 3)['aria-label'], /^row 3, column 7, sector 2, /)
  assert.match(at(cells, 1, 1)['aria-label'], /^row 1, column 1, sector 1, water, your submarine$/)
  assert.match(at(cells, 1, 0)['aria-label'], /your trail/)
  assert.match(at(cells, 4, 4)['aria-label'], /your mine/)
  const island = cells.find((c) => MAP[Number(c['data-y'])][Number(c['data-x'])] === 1)
  assert.match(island['aria-label'], /, island$/)
  for (const c of cells) assert.match(c['aria-label'], /^row \d+, column \d+, sector \d+, (water|island)/)
})

test('the board is one tab stop: the submarine, until a pick is under way', () => {
  const cells = cellsOf(render({ submarine: sub }))
  const stops = cells.filter((c) => c.tabindex === '0')
  assert.equal(stops.length, 1)
  assert.equal(stops[0]['data-x'], '1')
  assert.equal(stops[0]['data-y'], '1')
  assert.equal(cells.filter((c) => c.tabindex === '-1').length, width * height - 1)
  assert.ok(cells.every((c) => c['aria-disabled'] === undefined), 'nothing is disabled when nothing is being picked')
})

test('while aiming, the legal targets are the ones to pick, and the tab stop starts on the nearest', () => {
  const targets = waterNear(1, 1)
  assert.ok(targets.length >= 2, 'the fixture sub has water around it')
  const html = render({
    submarine: { position: sub.position, path: [] }, overlay: 'torpedo', legalCells: new Set(targets.map((t) => `${t.x},${t.y}`)), onCellClick() {},
  })
  const cells = cellsOf(html)
  for (const t of targets) {
    const c = at(cells, t.x, t.y)
    assert.match(c['aria-label'], /, water, torpedo target$/)
    assert.equal(c['aria-disabled'], undefined)
    assert.match(c.class, /clickable/)
  }
  const other = at(cells, width - 1, height - 1)
  assert.equal(other['aria-disabled'], 'true', 'a cell that is not a target says so')
  assert.doesNotMatch(other['aria-label'], /target/)
  const stop = cells.find((c) => c.tabindex === '0')
  const first = targets.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0]
  assert.deepEqual([stop['data-x'], stop['data-y']], [String(first.x), String(first.y)])
})

test('each system names what picking a cell does', () => {
  const near = waterNear(1, 1)[0]
  const legalCells = new Set([`${near.x},${near.y}`])
  for (const [overlay, note] of [['mine', 'mine can go here'], ['silence', 'can move here silently']]) {
    const cell = at(cellsOf(render({ submarine: sub, overlay, legalCells, onCellClick() {} })), near.x, near.y)
    assert.ok(cell['aria-label'].endsWith(`, ${note}`), `${overlay}: ${cell['aria-label']}`)
  }
})

test('aiming a drone, any cell picks its sector', () => {
  const cells = cellsOf(render({ submarine: sub, overlay: 'drone-sector', onSectorClick() {} }))
  assert.ok(cells.every((c) => c['aria-disabled'] === undefined))
  assert.match(at(cells, 7, 3)['aria-label'], /, scan sector 2$/)
  assert.match(at(cells, width - 1, height - 1)['aria-label'], /, scan sector 6$/, 'the last sector of the 3 x 2')
})

test('plotting on the radio map: no submarine, candidates marked, the tab stop on the first of them', () => {
  const cells = cellsOf(render({
    small: true, overlay: 'radio', onCellClick() {}, candidates: new Set(['6,3', '4,9']), ghostStart: { x: 6, y: 3 },
    ghostPath: [{ x: 6, y: 3 }, { x: 6, y: 4 }], annotations: new Set(['4,9']),
  }))
  assert.match(at(cells, 6, 3)['aria-label'], /guessed enemy start, possible enemy position$/)
  assert.match(at(cells, 6, 4)['aria-label'], /traced guess$/)
  assert.match(at(cells, 4, 9)['aria-label'], /possible enemy position, marked$/)
  const stop = cells.filter((c) => c.tabindex === '0')
  assert.equal(stop.length, 1)
  assert.deepEqual([stop[0]['data-x'], stop[0]['data-y']], ['6', '3'])
  assert.ok(cells.every((c) => c['aria-disabled'] === undefined), 'every cell can take a guess')
})

test('with nothing to go on, the tab stop is the top left', () => {
  const stops = cellsOf(render({})).filter((c) => c.tabindex === '0')
  assert.equal(stops.length, 1)
  assert.deepEqual([stops[0]['data-x'], stops[0]['data-y']], ['0', '0'])
})
