// Posture: a streak for sitting well, kept by the camera, and two gestures. The tracker (tracker.js)
// does the watching; this page draws it two ways: small in the column, and large as a pane laid out
// like workshop's session launcher (a serif headline, a card, then sections of pills and switches).
//
// The gestures: hold up a thumbs up or a middle finger for a moment and it is counted, shown, and
// (with "Tell the session in focus" on, the default) typed into the focused session, so Claude hears it.

import { tracker, ALERT_MS } from './tracker.js'
import { CHECKS, CHECK_LABEL, ISSUE_TEXT, WINDOW_MS, span, stopwatch, summarize } from './math.js'
import { GESTURE } from './gesture.js'

const ws = window.workshop

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k)
  return e
}
const text = (node, s) => {
  if (node.textContent !== s) node.textContent = s
}
const show = (node, on) => node.classList.toggle('gone', !on)

// ---- the reactions (gestures), kept in storage --------------------------------------------------

const MAX_REACTIONS = 200
const KINDS = Object.keys(GESTURE)
let reactions = []
let send = true
let sessions = []

const isReaction = (r) => !!r && !!GESTURE[r.kind] && Number.isFinite(r.at)
const today = () => {
  const from = new Date().setHours(0, 0, 0, 0)
  const n = Object.fromEntries(KINDS.map((k) => [k, 0]))
  for (const r of reactions) if (r.at >= from) n[r.kind]++
  return n
}

async function onGesture(kind) {
  const g = GESTURE[kind]
  // Asked fresh: sessions.watch fires only on a change, so the copy kept from it can be empty or old
  // (a page that has just loaded, a session focused since). The copy is only for drawing.
  if (send) sessions = await ws.sessions.list().catch(() => sessions)
  const focused = sessions.find((s) => s.focused && s.open)
  let sent = null
  let why = ''
  if (send && focused) {
    try {
      await ws.sessions.paste(focused.id, g.text)
      sent = focused.name
    } catch (err) {
      why = String(err?.message ?? err).replace(/^sessions\.paste: /, '')
    }
  } else if (send) why = 'no session in focus'
  reactions = [...reactions, { kind, at: Date.now(), session: sent }].slice(-MAX_REACTIONS)
  ws.storage.set('reactions', reactions).catch(() => {})
  burst(g.emoji, sent ? `Sent to ${sent}` : send ? `Not sent: ${why}` : 'Counted')
  update()
}

// ---- the views ----------------------------------------------------------------------------------

const WORD = {
  starting: 'starting',
  'starting-camera': 'starting',
  error: 'no camera',
  paused: 'paused',
  uncalibrated: 'calibrate',
  calibrating: 'calibrating',
  good: 'sitting well',
  bad: 'slouching',
  away: 'away'
}

const STRICT = [
  { v: 0.7, label: 'Gentle', hint: 'Only a real slump counts.' },
  { v: 1, label: 'Normal', hint: 'A clear drift from how you calibrated counts.' },
  { v: 1.4, label: 'Firm', hint: 'Smaller drifts count, sooner.' },
  { v: 1.8, label: 'Strict', hint: 'Almost any drift from your calibrated posture counts.' }
]

function feedBox(cls) {
  const canvas = el('canvas', { class: 'feed' })
  tracker.attach(canvas)
  const coverText = el('span')
  const cover = el('div', { class: 'cover' }, el('div', { class: 'cover-mark' }), coverText)
  const calibN = el('div', { class: 'calib-n' })
  const calibNote = el('div', { class: 'calib-note' })
  const calibBar = el('i')
  const calib = el('div', { class: 'calib' }, calibN, calibNote, el('div', { class: 'calib-bar' }, calibBar))
  const seeing = el('div', { class: 'seeing' })
  const box = el('div', { class: `feed-box ${cls}` }, canvas, cover, calib, seeing)
  return {
    box,
    update(v) {
      box.dataset.status = v.status
      const live = ['good', 'bad', 'away', 'uncalibrated', 'calibrating'].includes(v.status)
      show(cover, !live)
      text(coverText, v.status === 'paused' ? 'Camera off' : cls === 'small' && v.status === 'error' ? 'No camera' : v.note || WORD[v.status])
      show(calib, !!v.calib)
      if (v.calib) {
        text(calibN, String(v.calib.left))
        text(calibNote, v.note)
        calibBar.style.width = `${v.calib.frac * 100}%`
      }
      show(seeing, !!v.seeing)
      text(seeing, v.seeing ? GESTURE[v.seeing].emoji : '')
    }
  }
}

function strip(thin) {
  const node = el('div', { class: `strip${thin ? ' thin' : ''}` })
  return {
    node,
    update(segs, now) {
      const from = now - WINDOW_MS
      node.replaceChildren(
        ...segs.map((s) => {
          const i = el('i', { class: s.s, title: thin ? null : `${s.s === 'good' ? 'Upright' : s.s === 'bad' ? 'Slouching' : 'Away'} ${span(s.b - s.a)}, from ${new Date(s.a).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` })
          i.style.left = `${((s.a - from) / WINDOW_MS) * 100}%`
          i.style.width = `${Math.max(0.15, ((s.b - s.a) / WINDOW_MS) * 100)}%`
          return i
        })
      )
    }
  }
}

/** The one thing to press when the tracker is stuck: calibrate, turn the camera on, try again. */
function action(v) {
  if (v.status === 'uncalibrated') return { label: 'Calibrate', run: () => tracker.calibrate() }
  if (v.status === 'paused') return { label: 'Turn the camera on', run: () => tracker.setPaused(false) }
  if (v.status === 'error') return { label: 'Try again', run: () => tracker.retry() }
  return null
}

/** The streak's line under the clock. */
function sub(v, now) {
  const slouch = v.badSince !== null ? now - v.badSince : 0
  let s =
    v.status === 'bad' ? `Slouching ${stopwatch(slouch)}`
    : v.status === 'good' ? 'Good posture streak'
    : v.status === 'away' ? 'Out of frame'
    : v.status === 'uncalibrated' ? 'Calibrate to start'
    : v.status === 'calibrating' ? 'Calibrating…'
    : v.status === 'paused' ? 'Paused'
    : v.status === 'error' ? 'No camera'
    : 'Starting…'
  if (v.streakSince === null && v.lastStreak > 0 && !v.status.startsWith('starting')) s += ` · last ${stopwatch(v.lastStreak)}`
  return s
}

// The tile: the feed, the streak, the last two hours in a line, today's gestures.
const tileFeed = feedBox('small')
const tClock = el('div', { class: 'clock' })
const tSub = el('div', { class: 'sub' })
const tStrip = strip(true)
const tShare = el('span', { class: 'share' })
const tMini = el('div', { class: 'mini' }, tStrip.node, tShare)
const tAct = el('button', { class: 'go small', onclick: (e) => (e.stopPropagation(), action(tracker.view)?.run()) })
const tTallies = Object.fromEntries(KINDS.map((k) => [k, el('span', { class: 'tally', title: `${GESTURE[k].name} today` })]))
const tileRoot = el(
  'main',
  { class: 'tile-view', title: 'Open Posture large', onclick: () => ws.view === 'tile' && ws.openPane().catch(() => {}) },
  tileFeed.box,
  el('div', { class: 'side' }, el('div', {}, tClock, tSub), tAct, tMini, el('div', { class: 'tallies' }, Object.values(tTallies)))
)

// The pane: the launcher's shape.
const paneFeed = feedBox('large')
const pHead = el('h1')
const pHint = el('p', { class: 'lede' })
const pGo = el('button', { class: 'go' })
const pPause = el('button', { class: 'ghost' })
const pCancel = el('button', { class: 'ghost', onclick: () => tracker.cancelCalibration() }, 'Cancel')
pGo.addEventListener('click', () => (action(tracker.view) ?? { run: () => tracker.calibrate() }).run())
pPause.addEventListener('click', () => tracker.setPaused(!tracker.view.paused))
const pWhere = el('span', { class: 'where' })

const checkRows = CHECKS.map((k) => {
  const b = el('b')
  const row = el('div', { class: 'check', title: ISSUE_TEXT[k] }, el('span', {}, CHECK_LABEL[k]), el('i', {}, b, el('em')))
  return { k, row, b }
})
const pHands = el('p', { class: 'hint', title: 'Each hand’s nearest point to your chin, in shoulder widths. The chin check starts at 0.70 and counts fully at 0.35.' })

const pStrip = strip(false)
const pAxis = el('div', { class: 'axis' })
const pTracked = el('span', { class: 'note' })
const total = (cls) => {
  const n = el('b')
  const l = el('span')
  return { node: el('div', { class: `total ${cls}` }, n, l), n, l }
}
const totals = { good: total('good'), bad: total('bad'), away: total('away'), best: total('best') }

const strictPills = STRICT.map((s) => el('button', { role: 'radio', onclick: () => tracker.setStrictness(s.v) }, s.label))
const pStrictHint = el('p', { class: 'hint' })

const gCard = (kind) => {
  const n = el('b')
  return { node: el('div', { class: `gesture ${kind}` }, el('span', { class: 'emoji' }, GESTURE[kind].emoji), el('span', { class: 'gtext' }, n, el('span', {}, `${GESTURE[kind].name} today`))), n }
}
const gCards = Object.fromEntries(KINDS.map((k) => [k, gCard(k)]))
const sendBox = el('input', { type: 'checkbox' })
sendBox.addEventListener('change', () => {
  send = sendBox.checked
  ws.storage.set('send', send).catch(() => {})
  update()
})
// Reset: two clicks, as workshop's destructive buttons are. The first arms it red for three
// seconds; the second clears the counts and the log.
const gReset = el('button', { class: 'ghost reset', title: 'Clear today’s counts and the list below' }, 'Reset counts')
let armTimer
gReset.addEventListener('click', () => {
  if (!gReset.classList.contains('armed')) {
    gReset.classList.add('armed')
    gReset.textContent = 'Click again to reset'
    armTimer = setTimeout(disarm, 3000)
    return
  }
  disarm()
  reactions = []
  ws.storage.set('reactions', reactions).catch(() => {})
  update()
})
function disarm() {
  clearTimeout(armTimer)
  gReset.classList.remove('armed')
  gReset.textContent = 'Reset counts'
}
const sendWhere = el('span')
const recent = el('ol', { class: 'recent' })

const paneRoot = el(
  'main',
  { class: 'pane-view' },
  el(
    'div',
    { class: 'wrap' },
    el('div', { class: 'hero' }, pHead, pHint),
    el('div', { class: 'card' }, paneFeed.box, el('div', { class: 'card-foot' }, pWhere, pCancel, pPause, pGo)),
    el('section', {}, el('h2', {}, 'How you’re sitting'), el('div', { class: 'checks' }, checkRows.map((c) => c.row)), pHands),
    el('section', {}, el('div', { class: 'h-row' }, el('h2', {}, 'The last two hours'), pTracked), pStrip.node, pAxis, el('div', { class: 'totals' }, Object.values(totals).map((t) => t.node))),
    el('section', {}, el('h2', {}, 'Strictness'), el('div', { class: 'pills', role: 'radiogroup', 'aria-label': 'Strictness' }, strictPills), pStrictHint),
    el(
      'section',
      { class: 'extras' },
      el('div', { class: 'h-row' }, el('h2', {}, 'Gestures'), gReset),
      el('p', { class: 'hint' }, 'Hold a thumbs up, a thumbs down or a middle finger up to the camera for a moment. Each one counts once; drop your hand to make another.'),
      el('div', { class: 'gestures' }, Object.values(gCards).map((c) => c.node)),
      el('label', { class: 'switch' }, sendBox, el('span', { class: 'track' }), el('span', {}, el('b', {}, 'Tell the session in focus'), sendWhere)),
      recent
    )
  )
)

document.body.replaceChildren(tileRoot, paneRoot)

// ---- the burst: a gesture, big, over whichever view is showing --------------------------------

function burst(emoji, line) {
  const b = el('div', { class: 'burst', 'aria-live': 'polite' }, el('span', { class: 'b-emoji' }, emoji), el('span', { class: 'b-line' }, line))
  document.body.append(b)
  setTimeout(() => b.remove(), 2400)
}

// ---- update --------------------------------------------------------------------------------------

let lastBadge = ''
function update() {
  const v = tracker.view
  const now = Date.now()
  // A float (popped out, bridge 1.8) is the tile's own face in a square; an overlay is never asked for.
  const view = ws.view === 'tile' || ws.view === 'float' ? 'tile' : 'pane'
  document.documentElement.dataset.view = ws.view === 'float' ? 'float' : view
  const t = summarize(v.history, now)
  const seen = t.good + t.bad
  const running = v.streakSince !== null
  document.documentElement.classList.toggle('alarm', v.status === 'bad' && v.badSince !== null && now - v.badSince >= ALERT_MS)
  const act = action(v)
  const n = today()

  // The head's badge: the state in a word, or the streak's minutes while it runs (12 characters at most).
  const mins = running ? Math.floor((now - v.streakSince) / 60_000) : 0
  const badge = v.status === 'good' ? (mins ? `${mins}m upright` : 'upright') : WORD[v.status]
  if (badge !== lastBadge) {
    lastBadge = badge
    ws.head.set({ title: 'Posture', badge: badge.slice(0, 12) }).catch(() => {})
  }

  if (view === 'tile') {
    tileFeed.update(v)
    text(tClock, stopwatch(running ? now - v.streakSince : 0))
    tClock.dataset.status = v.status
    text(tSub, sub(v, now))
    show(tAct, !!act)
    if (act) text(tAct, act.label)
    show(tMini, !act)
    tStrip.update(t.segs, now)
    text(tShare, seen ? `${Math.round((t.good / seen) * 100)}% upright · 2h` : 'No history yet')
    for (const k of KINDS) text(tTallies[k], `${GESTURE[k].emoji} ${n[k]}`)
    return
  }

  paneFeed.update(v)
  pHead.dataset.status = v.status
  text(
    pHead,
    v.status === 'good' ? `Sitting well for ${stopwatch(now - v.streakSince)}`
    : v.status === 'bad' ? 'You’re slouching'
    : v.status === 'away' ? 'Waiting for you to come back'
    : v.status === 'uncalibrated' ? 'Show me how you like to sit'
    : v.status === 'calibrating' ? 'Hold that posture'
    : v.status === 'paused' ? 'The camera is off'
    : v.status === 'error' ? 'I can’t see the camera'
    : 'Getting the camera ready'
  )
  text(
    pHint,
    v.status === 'bad' ? `${v.note}.`
    : v.status === 'uncalibrated' ? 'Sit tall, shoulders back, chin level, then press Calibrate and hold still for a few seconds.'
    : v.status === 'error' ? v.note
    : v.status === 'paused' ? 'Nothing is watched or counted until you turn it back on.'
    : sub(v, now)
  )
  text(pWhere, 'Everything stays on this Mac')
  text(pGo, act ? act.label : v.calibrated ? 'Recalibrate' : 'Calibrate')
  pGo.disabled = !!v.calib || (!act && !['good', 'bad', 'away'].includes(v.status))
  show(pCancel, !!v.calib)
  text(pPause, 'Pause')
  show(pPause, !v.paused && v.status !== 'error')

  const live = v.status === 'good' || v.status === 'bad'
  for (const c of checkRows) {
    const x = v.checks && live ? v.checks[c.k] : 0
    c.b.className = x >= 1 ? 'bad' : x >= 0.6 ? 'warn' : 'good'
    c.b.style.width = `${Math.min(100, (x / 1.5) * 100)}%`
  }
  const one = (d) => (d === undefined || !Number.isFinite(d) ? 'not seen' : d.toFixed(2))
  show(pHands, live)
  text(pHands, `Hand to chin: left ${one(v.hands?.left)}, right ${one(v.hands?.right)}${v.handModel ? '' : ' (pose points only)'}`)

  pStrip.update(t.segs, now)
  const tracked = seen + t.away
  text(pTracked, tracked ? `tracked ${span(tracked)}` : 'nothing tracked yet')
  pAxis.replaceChildren(
    ...[0, 30, 60, 90, 120].map((m) => {
      const s = el('span', {}, m === 120 ? 'now' : new Date(now - WINDOW_MS + m * 60_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
      s.style.left = `${(m / 120) * 100}%`
      return s
    })
  )
  const pct = (x) => (seen ? ` · ${Math.round((x / seen) * 100)}%` : '')
  text(totals.good.n, span(t.good))
  text(totals.good.l, `upright${pct(t.good)}`)
  text(totals.bad.n, span(t.bad))
  text(totals.bad.l, `slouching${pct(t.bad)}`)
  text(totals.away.n, span(t.away))
  text(totals.away.l, 'away')
  text(totals.best.n, stopwatch(t.best))
  text(totals.best.l, 'longest streak')

  const near = STRICT.reduce((a, b) => (Math.abs(b.v - v.strictness) < Math.abs(a.v - v.strictness) ? b : a))
  strictPills.forEach((p, i) => {
    p.classList.toggle('on', STRICT[i] === near)
    p.setAttribute('aria-checked', String(STRICT[i] === near))
  })
  text(pStrictHint, near.hint)

  for (const k of KINDS) text(gCards[k].n, String(n[k]))
  sendBox.checked = send
  const focused = sessions.find((s) => s.focused && s.open)
  text(
    sendWhere,
    !send ? 'Off: gestures are only counted here.'
    : focused ? `Typed into ${focused.name} as a message, so it hears how you feel about what it just did.`
    : 'Typed into the session you are working in, as a message. None is in focus now.'
  )
  const last = reactions.slice(-6).reverse()
  recent.replaceChildren(
    ...last.map((r) =>
      el('li', {}, el('span', { class: 'r-emoji' }, GESTURE[r.kind].emoji), el('span', {}, new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })), el('span', { class: 'r-where' }, r.session ? `to ${r.session}` : 'not sent'))
    )
  )
  show(recent, last.length > 0)
  gReset.disabled = reactions.length === 0 && !gReset.classList.contains('armed')
}

// ---- start ---------------------------------------------------------------------------------------

const stored = await Promise.all([ws.storage.get('reactions'), ws.storage.get('send')].map((p) => p.catch(() => null)))
reactions = Array.isArray(stored[0]) ? stored[0].filter(isReaction) : []
send = stored[1] !== false

// watch fires only when the list changes, never at once: read it now too, or the page knows no
// session until the next one starts, stops or changes status.
ws.sessions.watch((list) => {
  sessions = list
  update()
})
sessions = await ws.sessions.list().catch(() => [])
ws.onViewChange(() => update())
tracker.subscribe(() => update())
tracker.onGesture((kind) => void onGesture(kind))
tracker.onAlert((issue, first, ms) => {
  ws.notify({ text: first ? `Slouching for ${span(ms)}. ${issue}.` : `Still slouching, ${span(ms)} now. ${issue}.`, attention: true }).catch(() => {})
})
setInterval(update, 1000)
await tracker.init()
update()
