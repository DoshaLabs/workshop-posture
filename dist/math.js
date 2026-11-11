// Posture's rules: pure, no DOM, tested as shipped (test/math.test.mjs). Ported from deck's
// postureMath.ts (itself Posture Pal's, github.com/cgrilson7/posture-pal): the four baseline checks
// are Posture Pal's unchanged; the fifth, CHIN ON HAND, needs no baseline.
//
// MediaPipe Pose landmarks are normalized image coords (x right, y down). Every metric is divided
// by shoulder width so it holds steady as you move nearer to or farther from the camera.

export const LM = { NOSE: 0, L_EAR: 7, R_EAR: 8, MOUTH_L: 9, MOUTH_R: 10, L_SHOULDER: 11, R_SHOULDER: 12 }
/** Each hand as the pose model sees it: wrist, pinky, index and thumb knuckles (your left, then right). */
const HANDS = [
  [15, 17, 19, 21],
  [16, 18, 20, 22]
]

const MIN_VISIBILITY = 0.5
/** The pose model's hand points go faint against the face even when it has them right: a lower bar for those. */
const HAND_VISIBILITY = 0.3

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const angleDeg = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI

/**
 * Posture metrics from one frame's pose landmarks, or null if the upper body isn't visible.
 * `hands` are the hand landmarker's (21 points each, the same image coords) when it ran.
 * @returns {{ neck: number, size: number, shoulderY: number, shoulderTilt: number, handChin: number,
 *   hands: { left: number, right: number }, chinAt: {x:number,y:number}, handAt: {x:number,y:number} | null } | null}
 */
export function computeMetrics(lm, hands = []) {
  if (!lm) return null
  const ls = lm[LM.L_SHOULDER]
  const rs = lm[LM.R_SHOULDER]
  const le = lm[LM.L_EAR]
  const re = lm[LM.R_EAR]
  const nose = lm[LM.NOSE]
  const visible = (p) => !!p && (p.visibility ?? 1) >= MIN_VISIBILITY
  if (!visible(ls) || !visible(rs) || !visible(nose)) return null

  const shoulderW = dist(ls, rs)
  if (shoulderW < 0.05) return null
  const shoulders = mid(ls, rs)
  // Ears are a steadier "head height" than the nose, which drops whenever you glance at the keyboard.
  const head = visible(le) && visible(re) ? mid(le, re) : nose
  const tilt = (a, b) => {
    let d = angleDeg(a, b)
    if (d > 90) d -= 180
    if (d < -90) d += 180
    return d
  }

  // The chin: below the mouth by about the nose-to-mouth drop again. The model places the mouth even
  // when a hand covers it, so it is used whatever its visibility says.
  const ml = lm[LM.MOUTH_L]
  const mr = lm[LM.MOUTH_R]
  const mouth = ml && mr ? mid(ml, mr) : { x: nose.x, y: nose.y + 0.12 * shoulderW }
  const chin = { x: mouth.x + (mouth.x - nose.x) * 1.3, y: mouth.y + (mouth.y - nose.y) * 1.3 }
  let handChin = Infinity
  let handAt = null
  const side = { left: Infinity, right: Infinity }
  const consider = (p, who) => {
    const d = dist(p, chin) / shoulderW
    if (d < side[who]) side[who] = d
    if (d < handChin) {
      handChin = d
      handAt = { x: p.x, y: p.y }
    }
  }
  HANDS.forEach((hand, h) => {
    for (const i of hand) {
      const p = lm[i]
      if (p && (p.visibility ?? 1) >= HAND_VISIBILITY) consider(p, h === 0 ? 'left' : 'right')
    }
  })
  // The hand landmarker's: whose hand by where its wrist is against the shoulders' middle (the
  // camera's image is not mirrored, so your left is at the larger x).
  for (const hand of hands) {
    if (!hand[0]) continue
    const who = hand[0].x > shoulders.x ? 'left' : 'right'
    for (const p of hand) consider(p, who)
  }

  return { neck: (shoulders.y - head.y) / shoulderW, size: shoulderW, shoulderY: shoulders.y, shoulderTilt: tilt(ls, rs), handChin, hands: side, chinAt: chin, handAt }
}

/** Calibration samples to a baseline by the median (robust to a fidget or two); null under 10 samples. */
export function buildBaseline(samples, now = Date.now()) {
  if (samples.length < 10) return null
  const median = (key) => {
    const v = samples.map((s) => s[key]).sort((a, b) => a - b)
    const m = v.length >> 1
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
  }
  return { neck: median('neck'), size: median('size'), shoulderY: median('shoulderY'), shoulderTilt: median('shoulderTilt'), createdAt: now }
}

export const isBaseline = (b) => !!b && ['neck', 'size', 'shoulderY', 'shoulderTilt'].every((k) => Number.isFinite(b[k])) && b.neck > 0 && b.size > 0

// Deviation from baseline at which each check counts as fully "bad" (1.0) at strictness 1.
const TOLERANCE = { neck: 0.18, lean: 0.15, slump: 0.35, tilt: 9 }
// Chin on hand, in shoulder widths from the chin to the nearest hand point: nothing past FAR, fully
// bad at NEAR. A palm under the chin sits at ~0.1–0.3; hands on the keyboard are well past 1.
export const CHIN_FAR = 0.7
export const CHIN_NEAR = 0.35

export const CHECKS = ['neck', 'lean', 'slump', 'tilt', 'chin']

/** Each check yields 0 (as calibrated) … 1 (at tolerance) … >1 (worse); the score is the worst. */
export function assess(m, base, strictness = 1) {
  const s = Math.max(0.25, strictness)
  const checks = {
    neck: Math.max(0, (base.neck - m.neck) / base.neck) / (TOLERANCE.neck / s),
    lean: Math.max(0, m.size / base.size - 1) / (TOLERANCE.lean / s),
    slump: Math.max(0, (m.shoulderY - base.shoulderY) / base.size) / (TOLERANCE.slump / s),
    tilt: Math.abs(m.shoulderTilt - base.shoulderTilt) / (TOLERANCE.tilt / s),
    chin: (Math.max(0, CHIN_FAR - m.handChin) / (CHIN_FAR - CHIN_NEAR)) * s
  }
  let worst = 'neck'
  for (const k of CHECKS) if (checks[k] > checks[worst]) worst = k
  return { score: checks[worst], worst, checks }
}

export const ISSUE_TEXT = {
  neck: 'Head is dropping. Lift your chin and sit tall',
  lean: 'Leaning toward the screen. Sit back',
  slump: 'Slumping down in your chair. Sit up',
  tilt: 'Leaning to one side. Level your shoulders',
  chin: 'Chin on your hand. Hands down, let your neck hold your head'
}

export const CHECK_LABEL = { neck: 'Head height', lean: 'Leaning in', slump: 'Slumping', tilt: 'Side lean', chin: 'Chin on hand' }

// ---- the history: stretches of good / bad / away, [a, b] in epoch ms ------------------------------

/** Ticks further apart than this leave the time between untracked. */
export const GAP_MS = 5000
/** What the pane shows, and what is kept (a little more). */
export const WINDOW_MS = 2 * 60 * 60_000
export const KEEP_MS = 3 * 60 * 60_000

export const isSeg = (x) => !!x && (x.s === 'good' || x.s === 'bad' || x.s === 'away') && Number.isFinite(x.a) && Number.isFinite(x.b) && x.b >= x.a

/** The history from `from` to `now` is `kind`: what was painted after `from` is painted over. Mutates `h`. */
export function paint(h, kind, from, now) {
  if (from < now) {
    while (h.length && h[h.length - 1].a >= from) h.pop()
    const cut = h[h.length - 1]
    if (cut && cut.b > from) cut.b = from
  }
  const last = h[h.length - 1]
  if (last && last.s === kind && from - last.b <= GAP_MS) last.b = Math.max(last.b, now)
  else h.push({ s: kind, a: from, b: now })
  const old = now - KEEP_MS
  while (h.length && h[0].b < old) h.shift()
  return h
}

/** The last `span` ms of the history, clipped: the time in each kind, and the longest good stretch. */
export function summarize(history, now, span = WINDOW_MS) {
  const from = now - span
  const segs = []
  const t = { good: 0, bad: 0, away: 0, best: 0 }
  for (const x of history) {
    if (x.b <= from) continue
    const s = { s: x.s, a: Math.max(x.a, from), b: Math.min(x.b, now) }
    if (s.b <= s.a) continue
    segs.push(s)
    t[s.s] += s.b - s.a
    if (s.s === 'good') t.best = Math.max(t.best, s.b - s.a)
  }
  return { ...t, segs }
}

/** 12:34, or 1:02:03 past the hour. */
export function stopwatch(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** 1h 12m, 8m 30s, 45s. */
export function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 && m < 10 ? `${m}m ${s % 60}s` : `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
