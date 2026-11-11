# A workshop tile

This folder is a **tile**: a small app in the right-hand column of workshop (a desktop app for
Claude Code sessions). A tile is a web page plus a manifest. It runs in a sandbox: no node, no
file system, no network, nothing but what `tile.json` declares, and all of it through one object,
`window.workshop`.

**The loop.** Workshop is showing this folder as a tile now (marked `dev`). Save a file under
`dist/` and the page reloads; save `tile.json` and the whole tile loads again. If `tile.json` is
refused the tile leaves the column, and the reason is listed in workshop's center pane under
"Tiles that were refused" (press `+` at the top of the sessions column to see it). You cannot see
the tile yourself: say what you changed and ask the user to look.

## The folder

```
tile.json          the manifest
dist/index.html    the page (dist/tile.js, dist/tile.css beside it)
icon.svg           16 x 16, drawn in the tile's head
plugin/            optional: skills that teach a Claude session to use the tile (below)
```

Plain HTML, CSS and JavaScript modules, no build step, is the simplest thing that works and what
workshop's own tiles do. If you use a framework, the BUILT page must be in `dist/` and committed:
nothing is ever built on the user's machine.

## tile.json

```json
{
  "id": "my-tile",              lowercase letters, digits, dashes; never change it once it has data
  "name": "My tile",
  "version": "0.1.0",
  "workshop": "^1",
  "author": "you",
  "hint": "One line shown as a tooltip",
  "icon": "icon.svg",
  "entry": "dist/index.html",
  "pane": false,                true: the tile can open large in the center column
  "multiple": false,            true: up to four instances at once
  "span": 1,                    height in the column, 1 or 2 (each about 190 px)
  "permissions": { }
}
```

An unknown key under `permissions` is an error, not a warning. Ask for the least you need: the
user is shown the list.

| Permission | Gives |
|---|---|
| `"storage": true` | `workshop.storage` |
| `"net": ["api.example.com", "*.example.org"]` | https / wss to exactly these hosts. No IPs, no `localhost`, no bare `*`. `*.x.com` does not include `x.com`. |
| `"sessions": "read"`, `"launch"` or `"write"` | `workshop.sessions`. Each takes the one before: `launch` adds `launch` (core's new-session form, filled in; needs `"workshop": "^1.4"`), `write` adds `paste` |
| `"transcripts": true` | `workshop.sessions.transcript(id)` and `watchTranscript`: what you typed into a session and what it answered. Needs `"sessions"` too and `"workshop": "^1.5"`. The user is warned loudly at install. With `net` as well, the index lists the tile only after a person has read its code. |
| `"usage": true` | `workshop.usage` |
| `"notify": true` | `workshop.notify` |
| `"door": { "ops": ["add", "list"], "timeoutMs": 10000 }` | `workshop.door`: Claude sessions can call these ops |
| `"files": true` | `workshop.files`: read what the user picks, nothing else |
| `"camera": true`, `"microphone": true` | `navigator.mediaDevices.getUserMedia` |
| `"overlay": true` | `workshop.openOverlay()`: the page over the whole window, e.g. a lightbox. Needs `"workshop": "^1.1"` |
| `"music": true` | `workshop.music`: what Spotify or Music is playing, with its artwork, and play, pause, skip, seek, volume. Needs `"workshop": "^1.3"`. No `net` needed for the artwork |
| `"oauth": ["accounts.example.com"]` | `workshop.oauth`: sign the user in with OAuth; workshop catches the browser's redirect and hands you the code. Same host rules as `net`. Needs `"workshop": "^1.5"`; the token endpoint must also be in `net` |

There is no permission for running programs, writing files, or reading a path the user did not
pick. If the tile needs one of those, say so plainly instead of working around it.

## window.workshop

Always there:

```js
workshop.id, workshop.instance
workshop.view                        // 'tile' | 'pane' | 'overlay'
workshop.onViewChange((view) => {})  // returns a function that stops listening
workshop.theme.vars                  // { '--ws-bg': '#…', … }; already applied to :root as CSS variables
workshop.theme.onChange((vars) => {})
await workshop.head.set({ title, badge })   // the tile's head is drawn by workshop; title ≤ 60, badge ≤ 12 chars
await workshop.openPane(); await workshop.closePane()   // needs "pane": true
await workshop.openExternal('https://…')    // the user's browser; one a second
```

The overlay (needs `"overlay": true`):

```js
await workshop.openOverlay()   // rejects unless the user clicked or typed in this page in the last 5 s
await workshop.closeOverlay()
```

The same page, not a new one, is laid over the whole window, below a strip workshop draws with the
tile's name and a ×; `workshop.view` becomes `'overlay'`. Draw your own backdrop: the page is
transparent, so a `color-mix(in srgb, var(--ws-bg) 70%, transparent)` background is what dims
the window behind it (`backdrop-filter` cannot blur what is outside the page). Esc always closes
it and your page never receives that Esc. One click opens it once: reopening needs a new click.
It goes back to the view it came from (`tile` or `pane`).

Behind a permission (each call rejects with a clear message if the permission is missing):

```js
await workshop.storage.get(key)             // any JSON value, or null
await workshop.storage.set(key, value)      // null removes it. 5 MB for the whole tile.
workshop.storage.watch(key, (value) => {})  // also fires for your own writes

await workshop.sessions.list()              // [{ id, name, project, root, status, focused, open }]
                                            // project: the folder the session started in
                                            // root: the project it belongs to: its git repository's root
                                            //   (every worktree of one repo shares it), else the start folder.
                                            //   File things by root.
workshop.sessions.watch((list) => {})
await workshop.sessions.paste(id, text)     // "write" only: types into a session and submits
await workshop.sessions.launch({ folder, worktree })  // "launch" or "write" (bridge 1.4); absent without it.
                                            // Opens core's new-session form with `folder` filled in and
                                            // `worktree: {}` (or `{ branch: 'fix-auth' }`, a new worktree of
                                            // that name, whose branch the CLI calls worktree-fix-auth) ticked.
                                            // The user presses Start: a tile never starts a session or
                                            // writes its first prompt. Only from a click or key in the tile.
await workshop.sessions.transcript(id)      // "transcripts" (bridge 1.7): { id, title, found, blocks }, the last 80
                                            // blocks as a session tile draws them: { kind: 'user', text, ts },
                                            // { kind: 'text', text (markdown), ts }, { kind: 'tool', name, label,
                                            // done, error, ts, path? }. null for a closed session. Not the raw file.
workshop.sessions.watchTranscript(id, (t) => {})   // the same, on every change; returns a function that stops it

await workshop.usage.get(); workshop.usage.watch((u) => {})   // rate-limit windows, per-session cost and context %

await workshop.notify({ text })             // a chip on the tile's head and a macOS notification; one per 3 s
await workshop.notify({ text, attention: true })   // also makes a session's status mark jump once:
                                            // the session that last called this tile's door (10 min), else the focused one

workshop.door.handle('add', async (args, caller, { session }) => result)
// args: string[] exactly as typed. caller: the session's name, or 'outside'.
// session: the caller's id as workshop.sessions lists it, or null. Return JSON; throw to refuse.

// "music": true. Only there when declared.
const now = await workshop.music.get()
// { player: 'spotify' | 'music' | null,       the app in use: the one playing, else the one open; null if neither is open
//   state: 'playing' | 'paused' | 'stopped',
//   track: { title, artist, album, durationMs, art } | null,
//   positionMs, volume (0–100, or null), shuffle?, repeat? ('off' | 'one' | 'all'),
//   error?: 'denied' | 'failed', message? }    show `message` when there is an error (below)
const stop = workshop.music.watch((now) => {})  // fires at once, then on every change; call stop() when hidden for good
await workshop.music.toggle()                  // also play(), pause(), next(), previous()
await workshop.music.seek(90_000)              // milliseconds, a whole number
await workshop.music.setVolume(60)             // the app's own volume, 0 to 100
await workshop.music.playUri('spotify:track:4uLU6hMCjMI75M1A2tKUQC')  // Spotify only; see below

// "oauth": [hosts]. Only there when declared. See "Signing in" below.
workshop.oauth.redirectUri                  // 'http://127.0.0.1:47800/oauth/<your id>/callback': register this with the provider
const { query } = await workshop.oauth.authorize(url)  // only in answer to a click; 'code=…' or 'error=access_denied'
await workshop.oauth.cancel()               // ends a pending sign-in (authorize rejects with 'oauth: cancelled')

const picked = await workshop.files.pick({ folder: true, title: 'Your games' })  // { handle, name, kind } or null
await workshop.files.list()                 // what was picked before (kept across restarts)
await workshop.files.entries(handle, 'sub/folder')   // [{ name, kind, size }]
await workshop.files.read(handle, 'a/b.txt', 'text') // or 'bytes'
workshop.files.url(handle, 'a/b.png')       // for <img>, <audio>, fetch (streamed)
await workshop.files.forget(handle)
```

**Music, in practice.** A now-playing tile is a few lines:

```js
const img = document.querySelector('img'), title = document.querySelector('.title'), btn = document.querySelector('button')
workshop.music.watch((m) => {
  if (m.error) return void (title.textContent = m.message)       // e.g. macOS said no: it says where to allow it
  if (!m.player) return void (title.textContent = 'Open Spotify or Music')
  title.textContent = m.track ? `${m.track.title} · ${m.track.artist}` : 'Nothing playing'
  img.src = m.track?.art ?? ''                                     // tile://<your id>/~music/art/…: your own origin
  btn.textContent = m.state === 'playing' ? 'Pause' : 'Play'
})
btn.onclick = () => workshop.music.toggle().catch((e) => (title.textContent = e.message))
```

- Workshop drives the apps for you; it **never opens one**. With neither open, `player` is null and
  a control rejects. Ask the user to open the app.
- The first time, macOS asks the user whether workshop may control Spotify (or Music). If they
  say no, `error` is `'denied'` and `message` says where to turn it on (System Settings › Privacy &
  Security › Automation); controls reject with the same words. Show it; don't retry in a loop.
- Workshop reads the app about once a second while playing and only while some page watches.
  `positionMs` is as of that reading: to draw a smooth progress bar, count forward yourself
  between updates while `state` is `'playing'`.
- `art` is null until workshop has the picture, then the watcher fires again with it. It is on your
  tile's own origin, so the CSP needs only `img-src 'self'`.
- `playUri` takes only the form Spotify's "Share › Copy Spotify URI" gives:
  `spotify:track|album|playlist|artist|episode|show:<22 letters and digits>`. Search and
  playlists are Spotify's web API, which needs the user signed in (see "Signing in").
- Shuffle and repeat are read, not set.
- `await workshop.music.show()` brings the app in use to the front (an "Open Spotify" button), bridge
  1.6: set `"workshop": "^1.6"`. Only from a click or key in your tile, once per input and once a
  second; like every control it never opens an app that is closed, and rejects with the same
  sentence when neither is open.

**Signing in (OAuth).** A tile cannot run a server or reach `127.0.0.1`, so a desktop sign-in's
redirect has nowhere to land. Workshop catches it for you:

```js
// On a click (workshop refuses authorize() otherwise):
const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
const u = new URL('https://accounts.example.com/authorize')
u.search = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: workshop.oauth.redirectUri,
  code_challenge: challenge, code_challenge_method: 'S256', scope: '…' })
const { query } = await workshop.oauth.authorize(u.toString())
const code = new URLSearchParams(query).get('code')       // null if the user said no: see `error`
// Exchange it yourself (the token host must be in permissions.net and the CSP's connect-src):
const tokens = await (await fetch('https://accounts.example.com/api/token', { method: 'POST',
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: workshop.oauth.redirectUri, client_id: CLIENT_ID, code_verifier: verifier }) })).json()
await workshop.storage.set('tokens', tokens)
```

- `redirectUri` is your tile's own, the same on every Mac. Register exactly that string with the
  provider. It names your tile's id, so another tile can never use your app's client id.
- Workshop requires the authorization-code flow with PKCE (`response_type=code`,
  `code_challenge_method=S256`) and sets `state` itself; it removes `state` from what you get back.
- The page the browser lands on is workshop's ("You can close this tab"). A sign-in waits 5
  minutes, then rejects with `oauth: timed out`. A new `authorize()` cancels your earlier one.
- It works only with a provider that lets an app sign in without a client secret (a "public
  client" with PKCE) and lets a web page call its token endpoint (CORS). Spotify does. A provider
  that needs a secret cannot be used from a tile: a secret shipped in a tile is published.
- Keep the refresh token in `workshop.storage`; workshop never sees your tokens.

Web storage (`localStorage`, IndexedDB) works and is the tile's own, but `workshop.storage` is
what survives a reinstall and is shared between instances. Keep real data there.

## Rules of the sandbox

- **The network is closed.** A host must be in `permissions.net` AND in the page's
  Content-Security-Policy (`connect-src` for fetch, `img-src` for images) in `dist/index.html`.
- Keep the CSP strict: no inline scripts or styles. Build DOM nodes; never put text from the
  network or from a session into `innerHTML`.
- Links and popups open in the user's browser. The page cannot navigate away from itself.
- Use the `--ws-*` variables for every colour so the tile follows the user's theme, light or dark:
  `--ws-bg`, `--ws-panel` (the tile's own surface), `--ws-ink`, `--ws-muted`, `--ws-line`,
  `--ws-accent`, the status colours `--ws-busy`, `--ws-idle`, `--ws-blocked`, `--ws-starting`,
  `--ws-dead`, and `--ws-green` and `--ws-red` for added and removed, good and bad (both read as
  small text on `--ws-panel`).
- Use workshop's fonts so the tile looks at home: `var(--ws-font)` for the interface,
  `var(--ws-font-mono)` for code and paths, `var(--ws-font-serif)` for prose that is read (an
  article, a note). Workshop loads the faces into the page itself; the page's CSP must allow
  `font-src 'self'`, as the starter's does. To ship a font of your own, put the file in `dist/`.
- A tile is small: the column is about a third of the window. Design for 400 px wide first, and
  give `pane` view more room if `"pane": true`.
- **The wheel belongs to the column at your page's edge.** In the column (`workshop.view` is
  `'tile'`), a wheel your page cannot use scrolls the tile column instead: nothing under the
  pointer scrolls that way, or what does is already at its end. A list that scrolls keeps the
  wheel until it reaches its top or bottom, then the column moves on, as nested scrolling does in
  any web page. To keep a wheel for yourself (a map's zoom, a dial), call `preventDefault()` on it
  in a non-passive listener. A pinch (ctrl + wheel) is never passed on. In `pane` and `overlay`
  views every wheel stays in your page.

### Why there is no backend for this tile

Workshop has a second, trusted tier: a tile that ships with workshop itself (Git) may add
a `backend`, a node program of its own with full access to the Mac, which its page reaches
through `workshop.backend`. Your tile cannot have one. Workshop refuses to load, install or list
any other tile that declares a `backend` or carries a `backend.mjs`, and `tile check` says so.

That is on purpose: a tile from the index runs on strangers' Macs, and a program with full access
is how a tile could read their files, their keys and their conversations. Everything a tile needs
should come through the page and the permissions above. If yours cannot be built without the
machine, say what it needed when you report back: that is how the contract grows, for everyone.

## Letting Claude sessions use the tile (the door)

Declare ops in `permissions.door.ops`, answer them with `workshop.door.handle`, and a session
calls one from the shell:

```bash
node "$WORKSHOP_TILE" <tile-id> <op> [args…]    # prints the result as JSON; exit 1 on a refusal
```

`$WORKSHOP_TILE` is set in every session workshop starts, including this one, so you can test
your own ops. The tile must be on. To teach sessions when to use it, add a skill:

```
plugin/.claude-plugin/plugin.json     { "name": "<the tile's id>", "description": "…", "version": "0.1.0" }
plugin/skills/<skill>/SKILL.md        frontmatter (name, description), then the commands
```

Only skills are accepted there (no hooks, MCP servers, agents or commands). A session that was
already running does not see a skill added later; a new session does.

## Check it

Run the same checks workshop runs before it loads a tile, from this folder:

```bash
node "$(dirname "$WORKSHOP_TILE")/workshop.mjs" tile check .     # add --json for a machine-readable report
```

It checks `tile.json`, that the page and icon exist inside the folder, that `plugin/` holds only
skills, and that nothing asks for the trusted tier (a `backend`: only tiles that ship with
workshop may have one). Exit 0 means the tile will load; every error says what to fix. Warnings
are things that load but probably not as you meant (no CSP, a symlink, which install turns into a
plain file). Run it after every change to `tile.json` and before you say you are done.

## When you are done

Run `tile check` (above) and fix what it reports. Then tell the user what the tile does, which
permissions it asks for and why, and anything it could not do inside the sandbox.
