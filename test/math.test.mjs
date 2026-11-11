// Posture's rules as shipped (dist/math.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assess, buildBaseline, computeMetrics, isBaseline, paint, span, stopwatch, summarize, GAP_MS, KEEP_MS } from '../dist/math.js'

/** A pose: shoulders at y, a head `neck` above them, ears and mouth placed around the nose. */
function pose({ neck = 0.2, y = 0.7, w = 0.3, cx = 0.5, tilt = 0 } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }))
  const at = (i, x, yy) => (lm[i] = { x, y: yy, visibility: 1 })
  at(11, cx + w / 2, y + tilt)
  at(12, cx - w / 2, y - tilt)
  at(7, cx + 0.06, y - neck)
  at(8, cx - 0.06, y - neck)
  at(0, cx, y - neck + 0.01)
  at(9, cx + 0.02, y - neck + 0.05)
  at(10, cx - 0.02, y - neck + 0.05)
  return lm
}

test('no body, no metrics', () => {
  assert.equal(computeMetrics(null), null)
  assert.equal(computeMetrics(Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }))), null)
})

test('sitting as calibrated is 0; slumping, leaning in and tilting count', () => {
  const samples = Array.from({ length: 12 }, () => computeMetrics(pose()))
  const base = buildBaseline(samples, 1)
  assert.ok(isBaseline(base))
  assert.ok(assess(computeMetrics(pose()), base).score < 0.01)
  assert.equal(assess(computeMetrics(pose({ neck: 0.14 })), base).worst, 'neck')
  assert.equal(assess(computeMetrics(pose({ w: 0.4 })), base).worst, 'lean')
  assert.equal(assess(computeMetrics(pose({ y: 0.85 })), base).worst, 'slump')
  assert.equal(assess(computeMetrics(pose({ tilt: 0.05 })), base).worst, 'tilt')
  assert.ok(assess(computeMetrics(pose({ neck: 0.14 })), base).score > 1)
})

test('a hand at the chin is the chin check, with no baseline needed', () => {
  const lm = pose()
  const m = computeMetrics(lm)
  const hand = Array.from({ length: 21 }, () => ({ x: m.chinAt.x + 0.01, y: m.chinAt.y + 0.01 }))
  const withHand = computeMetrics(lm, [hand])
  const base = buildBaseline(Array.from({ length: 10 }, () => m), 1)
  assert.equal(assess(withHand, base).worst, 'chin')
  assert.ok(assess(withHand, base).score > 1)
  assert.equal(m.handChin, Infinity)
})

test('buildBaseline wants ten samples', () => {
  assert.equal(buildBaseline([computeMetrics(pose())]), null)
})

test('paint: runs join, a later state paints over from where it began, old history goes', () => {
  const h = []
  paint(h, 'good', 0, 1000)
  paint(h, 'good', 1000, 2000)
  assert.deepEqual(h, [{ s: 'good', a: 0, b: 2000 }])
  paint(h, 'bad', 1500, 4000) // a slouch counted from its start, inside the good run
  assert.deepEqual(h, [{ s: 'good', a: 0, b: 1500 }, { s: 'bad', a: 1500, b: 4000 }])
  paint(h, 'good', 4000 + GAP_MS + 1, 4000 + GAP_MS + 1) // after a gap: a new run
  assert.equal(h.length, 3)
  paint(h, 'away', KEEP_MS + 5000, KEEP_MS + 5000) // keeps what ends inside the last KEEP_MS
  assert.deepEqual(h.map((x) => x.s), ['good', 'away'])
  paint(h, 'away', KEEP_MS + 20_000, KEEP_MS + 20_000)
  assert.deepEqual(h.map((x) => x.s), ['away', 'away']) // the good runs gone; two aways a gap apart
})

test('summarize: clipped to the window, totals and the longest good stretch', () => {
  const now = 10 * 60_000
  const t = summarize([{ s: 'good', a: -1e9, b: 60_000 }, { s: 'bad', a: 60_000, b: 120_000 }, { s: 'good', a: 120_000, b: now }], now, 5 * 60_000)
  assert.equal(t.bad, 0)
  assert.equal(t.good, 5 * 60_000)
  assert.equal(t.best, 5 * 60_000)
})

test('clocks', () => {
  assert.equal(stopwatch(65_000), '1:05')
  assert.equal(stopwatch(3_725_000), '1:02:05')
  assert.equal(span(45_000), '45s')
  assert.equal(span(510_000), '8m 30s')
  assert.equal(span(4_320_000), '1h 12m')
})
