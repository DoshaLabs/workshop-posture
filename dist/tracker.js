// The tracker: the camera, MediaPipe's pose and hand models, the streak and the history. One per
// page; it runs while the tile is on and not paused, whether the tile is in the column, a pane or
// scrolled out of view. The views only draw it (tile.js).
//
// Ported from deck's lib/posture.ts. What changed for the sandbox: MediaPipe and both models are
// files of this tile (dist/vendor, dist/models), served from its own origin, so nothing is fetched
// and the tile needs no `net`; what deck kept in localStorage is in workshop.storage; the camera is
// plain getUserMedia (the "camera" permission). New: each frame's hands are read for a gesture.

import { HandLandmarker, PoseLandmarker } from './vendor/vision_bundle.mjs'
import { assess, buildBaseline, computeMetrics, isBaseline, isSeg, paint, ISSUE_TEXT, LM, GAP_MS } from './math.js'
import { classifyHands, gestureGate } from './gesture.js'

const ws = window.workshop

const WASM = {
  wasmLoaderPath: new URL('./vendor/wasm/vision_wasm_internal.js', import.meta.url).href,
  wasmBinaryPath: new URL('./vendor/wasm/vision_wasm_internal.wasm', import.meta.url).href
}
const POSE_MODEL = new URL('./models/pose_landmarker_lite.task', import.meta.url).href
const HAND_MODEL = new URL('./models/hand_landmarker.task', import.meta.url).href

/** Detections a second: posture is slow, gestures want a little more; both models run on the CPU. */
const FRAME_MS = 200
/** No body this long = away (counted from the last frame you were seen in). */
const AWAY_MS = 2500
/** Hysteresis on the smoothed score. */
const BAD_ON = 1.0
const BAD_OFF = 0.8
/** A slouch this long breaks the streak (and is counted from its start). */
const GRACE_MS = 3000
export const ALERT_MS = 10_000
const REALERT_MS = 5 * 60_000
const CALIB_COUNTDOWN_MS = 3000
const CALIB_SAMPLE_MS = 4000
const SAVE_MS = 30_000
/** A camera muted (no frames) this long is treated as gone, and reopened. */
const MUTED_MS = 3000
const RETRY_MS = 5000
const RETRY_MAX = 60_000

const K = { baseline: 'baseline', history: 'history', paused: 'paused', strictness: 'strictness' }

const clampStrict = (v) => (Number.isFinite(v) ? Math.min(2, Math.max(0.5, Math.round(v * 10) / 10)) : 1)

class Tracker {
  status = 'starting'
  note = 'loading…'
  paused = false
  strictness = 1
  baseline = null
  history = []

  video = null
  stream = null
  pose = null
  hand = null
  lm = null
  handPts = []
  hands = null
  timer = undefined
  saveTimer = undefined
  retryTimer = undefined
  retryMs = RETRY_MS
  gen = 0
  mutedSince = null
  calibWanted = false

  lastSeen = 0
  lastTick = 0
  score = 0
  isBad = false
  checks = null
  worst = null
  pendingBad = null
  streakSince = null
  lastStreak = 0
  badSince = null
  nextAlert = Infinity
  calib = null

  gate = gestureGate()
  /** The gesture being made right now (before the hold has counted it), for the feed's overlay. */
  seeing = null

  listeners = new Set()
  gestureListeners = new Set()
  alertListeners = new Set()
  canvases = new Set()
  raf = 0
  colors = { good: '#3ecf8e', bad: '#d3402a', warn: '#e0a526', read: 0 }

  async init() {
    const [b, h, p, s] = await Promise.all([K.baseline, K.history, K.paused, K.strictness].map((k) => ws.storage.get(k).catch(() => null)))
    this.baseline = isBaseline(b) ? b : null
    this.history = Array.isArray(h) ? h.filter(isSeg) : []
    this.paused = p === true
    this.strictness = clampStrict(Number(s ?? 1))
    window.addEventListener('pagehide', () => this.flush())
    this.sync()
  }

  get view() {
    const c = this.calib
    const now = Date.now()
    const left = (ms) => Math.max(1, Math.ceil((ms - (now - c.start)) / 1000))
    return {
      status: this.status,
      note: this.note,
      streakSince: this.streakSince,
      lastStreak: this.lastStreak,
      badSince: this.badSince,
      calib: c ? (c.phase === 'countdown' ? { phase: c.phase, left: left(CALIB_COUNTDOWN_MS), frac: 0 } : { phase: c.phase, left: left(CALIB_SAMPLE_MS), frac: Math.min(1, (now - c.start) / CALIB_SAMPLE_MS) }) : null,
      score: this.score,
      checks: this.checks,
      worst: this.worst,
      hands: this.hands,
      handModel: !!this.hand,
      calibrated: !!this.baseline,
      paused: this.paused,
      strictness: this.strictness,
      seeing: this.seeing,
      history: this.history
    }
  }

  subscribe(cb) {
    this.listeners.add(cb)
    cb(this.view)
    return () => this.listeners.delete(cb)
  }
  /** cb(kind): a gesture held long enough to count, once per gesture. */
  onGesture(cb) {
    this.gestureListeners.add(cb)
    return () => this.gestureListeners.delete(cb)
  }
  /** cb(text, first): a slouch has gone on ALERT_MS, then again every REALERT_MS. */
  onAlert(cb) {
    this.alertListeners.add(cb)
    return () => this.alertListeners.delete(cb)
  }

  emit() {
    const v = this.view
    for (const l of this.listeners) l(v)
  }

  // ---- on / off ------------------------------------------------------------------

  setPaused(p) {
    this.paused = p
    ws.storage.set(K.paused, p).catch(() => {})
    this.sync()
  }

  setStrictness(v) {
    this.strictness = clampStrict(v)
    ws.storage.set(K.strictness, this.strictness).catch(() => {})
    this.emit()
  }

  sync() {
    if (!this.paused && !this.stream && this.status !== 'starting-camera') void this.start()
    if (this.paused) this.stop('paused')
  }

  alive() {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live')
  }

  /** The camera went away under us (sleep, a lock, another app, a replug): close it and open it again. */
  revive(why) {
    if (this.paused || this.status === 'starting-camera') return
    console.warn('[posture] camera lost, reopening:', why)
    this.stop('starting')
    void this.start('The camera went away. Reconnecting…')
  }

  async start(note = 'Asking for the camera…') {
    const gen = ++this.gen
    clearTimeout(this.retryTimer)
    this.set('starting-camera', note)
    let denied = false
    try {
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false })
      } catch (err) {
        denied = err?.name === 'NotAllowedError'
        throw new Error(denied ? 'No camera access. Allow workshop in System Settings › Privacy & Security › Camera, then press Try again.' : `The camera did not open (${err?.message || err?.name || err})`)
      }
      if (gen !== this.gen) return stream.getTracks().forEach((t) => t.stop())
      this.stream = stream
      this.mutedSince = null
      for (const t of stream.getVideoTracks()) {
        t.addEventListener('ended', () => gen === this.gen && this.revive('the track ended'))
        t.addEventListener('mute', () => gen === this.gen && (this.mutedSince ??= Date.now()))
        t.addEventListener('unmute', () => gen === this.gen && (this.mutedSince = null))
      }
      const video = this.videoEl()
      video.srcObject = stream
      await video.play()
      if (gen !== this.gen) return
      this.set('starting-camera', 'Loading the pose model…')
      this.pose ??= await PoseLandmarker.createFromOptions(WASM, { baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 })
      if (gen !== this.gen) return
      this.set('starting-camera', 'Loading the hand model…')
      // The hands: the chin check and the gestures. Posture goes on without them if this fails.
      this.hand ??= await HandLandmarker.createFromOptions(WASM, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        // A hand against the face is half hidden: take it on less certainty than the defaults (0.5).
        minHandDetectionConfidence: 0.3,
        minHandPresenceConfidence: 0.3,
        minTrackingConfidence: 0.3
      }).catch((err) => (console.warn('[posture] no hand model', err), null))
      if (gen !== this.gen) return
    } catch (err) {
      if (gen !== this.gen) return
      this.release()
      // A camera that is busy or not back from sleep is tried again, less and less often; a refusal
      // waits for the user (Try again).
      const wait = this.retryMs
      if (!denied) {
        this.retryMs = Math.min(RETRY_MAX, this.retryMs * 2)
        this.retryTimer = setTimeout(() => gen === this.gen && !this.paused && !this.stream && void this.start(), wait)
      }
      this.set('error', String(err?.message ?? err) + (denied ? '' : ` Trying again in ${Math.round(wait / 1000)}s.`))
      return
    }
    this.retryMs = RETRY_MS
    this.lastSeen = Date.now()
    this.lastTick = 0
    this.status = this.baseline ? 'away' : 'uncalibrated'
    this.note = ''
    this.timer = setInterval(() => this.tick(), FRAME_MS)
    this.saveTimer = setInterval(() => this.flush(), SAVE_MS)
    this.draw()
    this.emit()
    if (this.calibWanted) {
      this.calibWanted = false
      this.calibrate()
    }
  }

  /** After a refusal: ask again (a click on Try again). */
  retry() {
    if (this.paused) return this.setPaused(false)
    if (this.stream || this.status === 'starting-camera') return
    void this.start()
  }

  stop(status) {
    this.gen++
    clearTimeout(this.retryTimer)
    clearInterval(this.timer)
    clearInterval(this.saveTimer)
    this.timer = this.saveTimer = undefined
    this.endStreak(Date.now())
    this.flush()
    this.release()
    this.calib = null
    this.lm = null
    this.handPts = []
    this.hands = null
    this.seeing = null
    this.set(status, '')
    this.draw()
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.mutedSince = null
    if (this.video) this.video.srcObject = null
  }

  videoEl() {
    if (this.video) return this.video
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    // In the document (a detached <video> may stop decoding) but never seen: the canvases show it.
    v.className = 'offscreen'
    document.body.appendChild(v)
    this.video = v
    return v
  }

  set(status, note) {
    this.status = status
    this.note = note
    this.emit()
  }

  // ---- calibration ---------------------------------------------------------------

  calibrate() {
    if (this.paused) this.setPaused(false)
    if (!this.alive()) {
      this.calibWanted = true
      if (this.status === 'starting-camera') return
      this.stop('starting')
      void this.start('Reopening the camera…')
      return
    }
    this.calib = { phase: 'countdown', start: Date.now(), samples: [] }
    this.endStreak(Date.now())
    this.status = 'calibrating'
    this.note = 'Sit the way you want to sit: shoulders back, chin level'
    this.emit()
  }

  cancelCalibration() {
    this.calib = null
    this.status = this.baseline ? 'away' : 'uncalibrated'
    this.note = ''
    this.emit()
  }

  stepCalib(now, m) {
    const c = this.calib
    const elapsed = now - c.start
    if (c.phase === 'countdown') {
      if (elapsed >= CALIB_COUNTDOWN_MS) {
        this.calib = { phase: 'sampling', start: now, samples: [] }
        this.note = 'Hold still. Measuring your good posture'
      }
      return
    }
    if (m) c.samples.push(m)
    if (elapsed < CALIB_SAMPLE_MS) return
    const b = buildBaseline(c.samples)
    if (!b) {
      this.calib = { phase: 'countdown', start: now, samples: [] }
      this.note = 'I couldn’t see you clearly. Head and both shoulders in frame, and some light. Again…'
      return
    }
    this.baseline = b
    ws.storage.set(K.baseline, b).catch(() => {})
    this.calib = null
    this.score = 0
    this.isBad = false
    this.status = 'away' // the next tick enters good (or bad) from here
    this.note = ''
  }

  // ---- the loop ------------------------------------------------------------------

  tick() {
    const video = this.video
    const now = Date.now()
    if (!this.alive()) return this.revive('no live track')
    if (this.mutedSince !== null && now - this.mutedSince > MUTED_MS) return this.revive('muted')
    if (video && video.paused) void video.play().catch(() => {})
    if (!this.pose || !video || video.readyState < 2) return
    // A long gap (the Mac slept, the page was throttled) is untracked: nothing carries across it.
    if (this.lastTick && now - this.lastTick > GAP_MS && (this.status === 'good' || this.status === 'bad')) {
      this.endStreak(this.lastTick)
      this.status = 'away'
    }
    this.lastTick = now
    let lm = null
    try {
      lm = this.pose.detectForVideo(video, performance.now()).landmarks?.[0] ?? null
    } catch (err) {
      console.warn('[posture] detect failed', err)
      return
    }
    this.lm = lm
    this.handPts = []
    let world = []
    if (this.hand) {
      try {
        const r = this.hand.detectForVideo(video, performance.now())
        this.handPts = r.landmarks ?? []
        world = r.worldLandmarks ?? []
      } catch (err) {
        console.warn('[posture] hand detect failed', err)
      }
    }
    // The gestures: read every frame, in and out of calibration, with or without a body in view.
    const g = classifyHands(this.handPts, world)
    this.seeing = g
    const fired = this.gate(g, now)
    if (fired) for (const l of this.gestureListeners) l(fired)

    const m = computeMetrics(lm, this.handPts)
    this.hands = m ? m.hands : null
    if (m) this.lastSeen = now

    if (this.calib) {
      this.stepCalib(now, m)
      return this.emit()
    }
    if (!this.baseline) {
      if (this.status !== 'uncalibrated') this.set('uncalibrated', '')
      else this.emit()
      return
    }
    if (!m) {
      if (now - this.lastSeen > AWAY_MS) {
        if (this.status !== 'away') this.enter('away', this.lastSeen, now)
        else paint(this.history, 'away', now, now)
      } else if (this.status === 'good' || this.status === 'bad') paint(this.history, this.status, now, now)
      return this.emit()
    }

    // A gesture is not a slouch: a hand raised to the camera does not count against the chin check.
    const a = assess(g ? { ...m, handChin: Infinity } : m, this.baseline, this.strictness)
    this.score += (a.score - this.score) * 0.35
    this.isBad = this.isBad ? this.score > BAD_OFF : this.score > BAD_ON
    this.checks = a.checks
    this.worst = a.worst

    if (this.isBad) {
      if (this.status === 'bad') paint(this.history, 'bad', now, now)
      else if (this.status === 'good') {
        this.pendingBad ??= now
        if (now - this.pendingBad >= GRACE_MS) this.enter('bad', this.pendingBad, now)
        else paint(this.history, 'good', now, now)
      } else this.enter('bad', now, now)
    } else {
      this.pendingBad = null
      if (this.status === 'good') paint(this.history, 'good', now, now)
      else this.enter('good', now, now)
    }
    if (this.status === 'bad') {
      this.note = ISSUE_TEXT[a.worst]
      if (now >= this.nextAlert) {
        const first = now - this.badSince < ALERT_MS + REALERT_MS
        for (const l of this.alertListeners) l(ISSUE_TEXT[a.worst], first, now - this.badSince)
        this.nextAlert = now + REALERT_MS
      }
    } else this.note = ''
    this.emit()
  }

  enter(kind, from, now) {
    if (kind === 'good') {
      this.streakSince = from
      this.badSince = null
      this.nextAlert = Infinity
    } else {
      this.endStreak(from)
      this.badSince = kind === 'bad' ? from : null
      this.nextAlert = kind === 'bad' ? from + ALERT_MS : Infinity
    }
    this.pendingBad = null
    this.status = kind
    paint(this.history, kind, from, now)
  }

  endStreak(at) {
    if (this.streakSince !== null) this.lastStreak = Math.max(0, at - this.streakSince)
    this.streakSince = null
    this.badSince = null
    this.pendingBad = null
    this.nextAlert = Infinity
  }

  flush() {
    ws.storage.set(K.history, this.history).catch(() => {})
  }

  // ---- the feed ------------------------------------------------------------------

  /** Draw the camera (mirrored, cropped to fill) and the pose lines into this canvas while attached. */
  attach(canvas) {
    this.canvases.add(canvas)
    this.draw()
    return () => this.canvases.delete(canvas)
  }

  draw = () => {
    cancelAnimationFrame(this.raf)
    if (!this.canvases.size || !this.stream) {
      for (const c of this.canvases) c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
      return
    }
    const video = this.video
    const now = performance.now()
    if (now - this.colors.read > 2000) {
      const cs = getComputedStyle(document.documentElement)
      const v = (n, d) => cs.getPropertyValue(n).trim() || d
      this.colors = { good: v('--ws-green', '#3ecf8e'), bad: v('--ws-red', '#d3402a'), warn: v('--ws-busy', '#e0a526'), accent: v('--ws-accent', '#a9aed6'), read: now }
    }
    const vw = video.videoWidth
    const vh = video.videoHeight
    for (const c of this.canvases) {
      if (!c.isConnected || c.offsetParent === null) continue
      const w = Math.round(c.clientWidth * devicePixelRatio)
      const hgt = Math.round(c.clientHeight * devicePixelRatio)
      if (!w || !hgt || !vw || !vh) continue
      if (c.width !== w || c.height !== hgt) {
        c.width = w
        c.height = hgt
      }
      const ctx = c.getContext('2d')
      if (!ctx) continue
      const k = Math.max(w / vw, hgt / vh)
      const dw = vw * k
      const dh = vh * k
      const ox = (w - dw) / 2
      const oy = (hgt - dh) / 2
      ctx.save()
      ctx.translate(w, 0)
      ctx.scale(-1, 1)
      ctx.drawImage(video, ox, oy, dw, dh)
      this.drawPose(ctx, ox, oy, dw, dh, Math.max(1.5, w / 160))
      ctx.restore()
    }
    this.raf = requestAnimationFrame(this.draw)
  }

  drawPose(ctx, ox, oy, dw, dh, lw) {
    const lm = this.lm
    // The hands: faint dots, or the accent while they make a gesture.
    ctx.fillStyle = this.seeing ? this.colors.accent : 'rgba(255,255,255,.55)'
    for (const hand of this.handPts)
      for (const p of hand) {
        ctx.beginPath()
        ctx.arc(ox + p.x * dw, oy + p.y * dh, Math.max(1, lw * (this.seeing ? 1 : 0.7)), 0, Math.PI * 2)
        ctx.fill()
      }
    if (!lm || this.status === 'calibrating') return
    const P = (i) => [ox + lm[i].x * dw, oy + lm[i].y * dh]
    const color = this.status === 'bad' ? this.colors.bad : this.colors.good
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.strokeStyle = color
    ctx.fillStyle = color
    const line = (a, b) => {
      ctx.beginPath()
      ctx.moveTo(...a)
      ctx.lineTo(...b)
      ctx.stroke()
    }
    line(P(LM.L_SHOULDER), P(LM.R_SHOULDER))
    line(P(LM.L_EAR), P(LM.NOSE))
    line(P(LM.NOSE), P(LM.R_EAR))
    const sm = [(P(LM.L_SHOULDER)[0] + P(LM.R_SHOULDER)[0]) / 2, (P(LM.L_SHOULDER)[1] + P(LM.R_SHOULDER)[1]) / 2]
    const em = [(P(LM.L_EAR)[0] + P(LM.R_EAR)[0]) / 2, (P(LM.L_EAR)[1] + P(LM.R_EAR)[1]) / 2]
    line(sm, em)
    for (const i of [LM.NOSE, LM.L_EAR, LM.R_EAR, LM.L_SHOULDER, LM.R_SHOULDER]) {
      ctx.beginPath()
      ctx.arc(...P(i), lw * 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
    // A hand near the chin: the chin and that hand point joined, amber on the way in, red once it counts.
    const chin = this.checks?.chin ?? 0
    const m = chin >= 0.6 && !this.seeing ? computeMetrics(lm, this.handPts) : null
    if (m?.handAt) {
      const at = (p) => [ox + p.x * dw, oy + p.y * dh]
      ctx.strokeStyle = ctx.fillStyle = chin >= 1 ? this.colors.bad : this.colors.warn
      line(at(m.chinAt), at(m.handAt))
      for (const p of [m.chinAt, m.handAt]) {
        ctx.beginPath()
        ctx.arc(...at(p), lw * 2.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // Where your head sat when you calibrated: a dashed line, so a sinking head shows.
    const b = this.baseline
    if (!b) return
    const sw = Math.hypot(lm[LM.L_SHOULDER].x - lm[LM.R_SHOULDER].x, lm[LM.L_SHOULDER].y - lm[LM.R_SHOULDER].y)
    const y = sm[1] - b.neck * sw * dh
    const half = Math.abs(lm[LM.L_SHOULDER].x - lm[LM.R_SHOULDER].x) * dw * 0.4
    ctx.setLineDash([lw * 3, lw * 3])
    ctx.lineWidth = Math.max(1, lw * 0.6)
    ctx.strokeStyle = 'rgba(255,255,255,.6)'
    line([sm[0] - half, y], [sm[0] + half, y])
    ctx.setLineDash([])
  }
}

export const tracker = new Tracker()
