// The gesture rules as shipped (dist/gesture.js), on hands built by hand: 21 points in the hand
// model's order, the wrist at the origin, the palm about 1 long, y down as in the picture.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, classifyHands, gestureGate, HOLD_FRAMES, SAME_MS, SETTLE_MS, reach } from '../dist/gesture.js'

const P = (x, y, z = 0) => ({ x, y, z })

/** An upright hand, fingers up, palm to the camera. `up` names the fingers held straight. */
function upright(up = [], thumb = 'tucked') {
  const xs = { index: -0.3, middle: -0.1, ring: 0.1, pinky: 0.3 }
  const pts = [P(0, 0)]
  // The thumb: out to the side and up, or folded across the fingers.
  if (thumb === 'out') pts.push(P(-0.35, -0.25), P(-0.6, -0.5), P(-0.75, -0.72), P(-0.88, -0.92))
  else pts.push(P(-0.3, -0.25), P(-0.4, -0.5), P(-0.25, -0.7, -0.3), P(-0.05, -0.75, -0.4))
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    const x = xs[f]
    if (up.includes(f)) pts.push(P(x, -1), P(x, -1.4), P(x, -1.65), P(x, -1.85))
    else pts.push(P(x, -1), P(x, -1.3, -0.25), P(x, -1.05, -0.4), P(x, -0.85, -0.25))
  }
  return pts
}

/** A fist on its side, knuckles toward the camera's right, and the thumb up, out or tucked. */
function sideFist(thumb = 'up') {
  const pts = [P(0, 0)]
  if (thumb === 'up') pts.push(P(0.2, -0.3), P(0.45, -0.6), P(0.5, -0.95), P(0.52, -1.25))
  else if (thumb === 'down') pts.push(P(0.2, 0.3), P(0.45, 0.6), P(0.5, 0.95), P(0.52, 1.25))
  else pts.push(P(0.2, -0.3), P(0.45, -0.45), P(0.7, -0.35, -0.2), P(0.8, -0.15, -0.3))
  const ys = { index: -0.3, middle: -0.1, ring: 0.1, pinky: 0.3 }
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    const y = ys[f]
    pts.push(P(1, y), P(1.3, y, -0.25), P(1.05, y, -0.4), P(0.6, y, -0.3))
  }
  return pts
}

/** Turned upside down in the picture (a thumbs down; a finger pointing at the floor). */
const flip = (h) => h.map((p) => ({ ...p, y: -p.y }))

test('reach: about 1.8 straight, under 1 folded', () => {
  const h = upright(['middle'])
  assert.ok(reach(h, 'middle') > 1.7)
  assert.ok(reach(h, 'index') < 1)
})

test('the middle finger, alone and up, is the finger', () => {
  assert.equal(classify(upright(['middle'])), 'finger')
  assert.equal(classify(upright(['middle'], 'out')), 'finger')
})

test('a fist on its side with the thumb straight up is a thumbs up', () => {
  assert.equal(classify(sideFist('up')), 'up')
})

test('a fist with the thumb straight down is a thumbs down', () => {
  assert.equal(classify(sideFist('down')), 'down')
  assert.equal(classify(flip(sideFist('up'))), 'down')
})

test('a thumb out sideways is neither up nor down', () => {
  const h = sideFist('up')
  // Turn the thumb to point right, level with the knuckles.
  h[2] = { x: 0.45, y: -0.3, z: 0 }
  h[3] = { x: 0.8, y: -0.35, z: 0 }
  h[4] = { x: 1.15, y: -0.38, z: 0 }
  assert.equal(classify(h), null)
})

test('what is not a gesture', () => {
  assert.equal(classify(upright(['index', 'middle', 'ring', 'pinky'], 'out')), null, 'an open palm')
  assert.equal(classify(upright(['index'])), null, 'pointing up')
  assert.equal(classify(upright(['index', 'middle'])), null, 'a peace sign')
  assert.equal(classify(upright([])), null, 'a fist')
  assert.equal(classify(sideFist('tucked')), null, 'a fist with the thumb across it')
  assert.equal(classify(flip(sideFist('tucked'))), null, 'an upside-down fist, thumb tucked')
  assert.equal(classify(flip(upright(['middle']))), null, 'the finger pointed at the floor')
  assert.equal(classify(upright(['middle', 'ring'])), null, 'middle and ring up')
  assert.equal(classify(null), null)
  assert.equal(classify(upright().slice(0, 10)), null, 'too few points')
})

test('the 3D points decide curl: a fist that looks straight in the picture is still a fist', () => {
  // The picture alone (z dropped) would make the folded fingers look as long as straight ones if
  // they pointed at the camera; the world points carry the fold.
  const world = sideFist('up')
  const img = world.map((p) => ({ x: p.x, y: p.y }))
  assert.equal(classify(img, world), 'up')
})

test('classifyHands: the first hand that makes one', () => {
  assert.equal(classifyHands([upright([]), sideFist('up')]), 'up')
  assert.equal(classifyHands([]), null)
})

test('the gate: held for HOLD_FRAMES, once, then not again until the hand drops', () => {
  const gate = gestureGate()
  let t = 100_000
  const out = []
  for (let i = 0; i < HOLD_FRAMES + 5; i++) out.push(gate('up', (t += 200)))
  assert.deepEqual(out.filter(Boolean), ['up'])
  assert.equal(out.indexOf('up'), HOLD_FRAMES - 1)
})

test('the gate: the same gesture again waits SAME_MS; another waits SETTLE_MS', () => {
  const gate = gestureGate()
  const hold = (g, at) => {
    let r = null
    for (let i = 0; i < HOLD_FRAMES; i++) r = gate(g, at + i * 200) ?? r
    gate(null, at + HOLD_FRAMES * 200)
    return r
  }
  assert.equal(hold('up', 0), 'up')
  assert.equal(hold('up', 2000), null, 'the same, too soon')
  assert.equal(hold('finger', 1000), null, 'another, inside SETTLE_MS')
  assert.equal(hold('finger', SETTLE_MS + 500), 'finger')
  assert.equal(hold('up', SAME_MS + 2000), 'up')
})

test('the gate: a flicker shorter than the hold does nothing', () => {
  const gate = gestureGate()
  assert.equal(gate('finger', 0), null)
  assert.equal(gate(null, 200), null)
  assert.equal(gate('finger', 400), null)
  assert.equal(gate('up', 600), null)
})
