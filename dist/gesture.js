// Three hand gestures read from MediaPipe's hand landmarks: THUMBS UP, THUMBS DOWN, MIDDLE FINGER. Pure,
// tested as shipped (test/gesture.test.mjs). MediaPipe's own gesture recognizer knows a thumbs up
// but not the finger, so both are read here, from the 21 points the hand model already gives the
// chin check: no third model.
//
// Points: 0 wrist; thumb 1–4; index 5–8; middle 9–12; ring 13–16; pinky 17–20 (knuckle, two
// joints, tip). How CURLED a finger is comes from the 3D world landmarks when there are some (a fist
// seen side on still reads as a fist); which way it POINTS comes from the image (y down).

const FINGERS = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20]
}
const THUMB = [1, 2, 3, 4]

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0))

/**
 * How far a finger reaches out of the palm: tip-to-wrist over knuckle-to-wrist. About 1.8–2 when it
 * is straight, about 1 when it is folded into the palm.
 */
export function reach(p, finger) {
  const [mcp, , , tip] = FINGERS[finger]
  const k = d3(p[mcp], p[0])
  return k > 0 ? d3(p[tip], p[0]) / k : 0
}

/** 1 for a straight chain of joints, less as it bends: the tip's distance over the bones' length. */
export function straightness(p, chain) {
  let bones = 0
  for (let i = 1; i < chain.length; i++) bones += d3(p[chain[i - 1]], p[chain[i]])
  return bones > 0 ? d3(p[chain[0]], p[chain[chain.length - 1]]) / bones : 0
}

export const EXTENDED = 1.55
export const CURLED = 1.3
/** The ring finger rides up a little when the middle one is raised: a looser bar for it there. */
const RING_LOOSE = 1.42

/** Pointing up in the picture: mostly vertical, tip above its base. Image coords, y down. */
function pointsUp(a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dy < 0 && Math.abs(dy) > Math.abs(dx) * 1.2
}
/** `i` is the hand's highest point in the picture. */
const topmost = (img, i) => img.every((q, j) => j === i || q.y >= img[i].y)
/** `i` is the hand's lowest point in the picture. */
const bottommost = (img, i) => img.every((q, j) => j === i || q.y <= img[i].y)
const flipY = (p) => ({ ...p, y: -p.y })

/**
 * Which gesture one hand makes, or null. `img` is the hand in image coords, `world` the same points
 * in metres (optional: the image is used for both without it).
 * @returns {'up' | 'down' | 'finger' | null}
 */
export function classify(img, world = img) {
  if (!img || img.length < 21 || !world || world.length < 21) return null
  const r = (f) => reach(world, f)
  const curled = (f, bar = CURLED) => r(f) < bar

  // The middle finger: straight, up, the hand's highest point; index and pinky folded down.
  if (r('middle') > EXTENDED && straightness(world, FINGERS.middle) > 0.9 && pointsUp(img[9], img[12]) && topmost(img, 12) && curled('index') && curled('pinky') && curled('ring', RING_LOOSE)) {
    return 'finger'
  }

  // The thumbs up and down: the four fingers folded into a fist, the thumb straight out of it, clear
  // of the fist (a thumb tucked across the fingers is not one), and its tip the hand's highest point
  // pointing up, or its lowest pointing down.
  const palm = d3(world[0], world[9])
  const thumbOut = palm > 0 && ['index', 'middle', 'ring', 'pinky'].every((f) => curled(f)) && straightness(world, THUMB.slice(1)) > 0.88 && d3(world[4], world[5]) / palm > 0.55
  if (thumbOut && pointsUp(img[2], img[4]) && topmost(img, 4)) return 'up'
  if (thumbOut && pointsUp(flipY(img[2]), flipY(img[4])) && bottommost(img, 4)) return 'down'
  return null
}

/** The first gesture any hand makes (two hands could disagree: the first one seen wins). */
export function classifyHands(imgHands = [], worldHands = []) {
  for (let i = 0; i < imgHands.length; i++) {
    const g = classify(imgHands[i], worldHands[i] ?? imgHands[i])
    if (g) return g
  }
  return null
}

/** A gesture has to be held this long, in frames seen in a row, before it counts. */
export const HOLD_FRAMES = 3
/** After a gesture fires, the same one again waits this long; any gesture waits SETTLE_MS. */
export const SAME_MS = 6000
export const SETTLE_MS = 2500

/**
 * Held gestures to single events. Feed it every frame's reading; it returns the gesture once, on the
 * frame it has been held long enough, and null otherwise. Holding it longer does not repeat it: the
 * hand has to drop (or change) first.
 */
export function gestureGate() {
  let current = null
  let frames = 0
  let fired = false
  let lastAt = -Infinity
  let lastKind = null
  return (g, now) => {
    if (g !== current) {
      current = g
      frames = 0
      fired = false
    }
    if (!g) return null
    frames++
    if (fired || frames < HOLD_FRAMES) return null
    if (now - lastAt < SETTLE_MS || (g === lastKind && now - lastAt < SAME_MS)) return null
    fired = true
    lastAt = now
    lastKind = g
    return g
  }
}

/** What a gesture looks like and says. `text` is what a session is sent when sending is on. */
export const GESTURE = {
  up: { emoji: '👍', name: 'Thumbs up', text: '👍 (a thumbs-up, from the camera: I like this)' },
  down: { emoji: '👎', name: 'Thumbs down', text: '👎 (a thumbs-down, from the camera: not this)' },
  finger: { emoji: '🖕', name: 'Middle finger', text: '🖕 (a middle finger, from the camera: I don’t like this)' }
}
