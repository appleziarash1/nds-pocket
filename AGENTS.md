# AGENTS.md

## Project

NDS Pocket — a client-side Nintendo DS emulator PWA. Bring-your-own-ROM: files are
read in the browser and never uploaded. Hosted on GitHub Pages at
https://appleziarash1.github.io/nds-pocket/ (repo `appleziarash1/nds-pocket`, `main`).

EmulatorJS is loaded from CDN (`loader.js`, `emulator.js`). NDS cores: `melonds`
(default), `desmume`, `desmume2015`. The `*_threaded` variants 404.

## Deploy

Pushing to `main` publishes via GitHub Pages. Verify live with the test harnesses
in `/tmp` (see below) pointed at the live URL, not just localhost.

### Shipping a change without breaking returning visitors

The service worker caches the app shell, and GitHub Pages sends no cache headers,
so a deploy has to actively push past it. Two things are needed, and neither alone
is enough:

- **Bump `VERSION` in `sw.js`.** The new worker's `activate` deletes the previous
  version's caches. Without it the old shell survives the deploy.
- **Bump the `?v=` query on `styles.css` and `app.js` in `index.html`.** This is
  the part that matters. A visitor's *first* request after a deploy is still
  handled by the old worker, which serves shell assets cache-first — so they would
  get the new HTML with the previous `app.js`. Cache-first lookup keys on the full
  URL, so the changed query is what misses the cache and reaches the network.

That second point is not theoretical: it was caught by `swupgrade.js`, which serves
the previous commit, lets its worker install, then swaps in the working tree. The
skew threw `Cannot read properties of null (reading 'addEventListener')` from
`wireControls` — the old `app.js` calling `el.btnMenu.addEventListener` on HTML
that no longer had that button. Note the throw aborts the rest of `init()`, so the
symptom is a page that looks half-dead rather than one obviously broken.

Both mechanisms live outside `app.js` on purpose: a fix *in* `app.js` cannot help,
because the stale script is exactly what is running. Don't try to paper over the
skew with a `controllerchange` reload — the code doing the reloading is the code
that failed to load. Bumping the query string makes the first load correct, with
no reload.

`sw.js`'s shell branch is network-first and its offline fallback matches with
`ignoreSearch: true`, because the versioned request never equals the precached
entry otherwise. `offline.js` guards that.

Run `node /tmp/swupgrade.js <previous-ref>` after changing any shell asset.

## EmulatorJS integration notes

These are non-obvious behaviours discovered by reading `emulator.js`; they cost
real debugging time.

- `EJS_biosUrl` is treated as a URL **string** — `downloadFile` calls
  `assetUrl.split("/")`. Passing a `File` throws, and the throw happens inside
  `new Promise(async (resolve) => ...)` in `downloadBios()`, which never settles.
  Result: boot hangs on "Still loading" forever with no error and no console
  output. Always pass a `blob:` URL (see `makeBiosUrl` in `app.js`).
- The BIOS filename matters. A single file delivered as a blob URL is written to
  the FS under the blob UUID, so the core never finds it. `app.js` packs picked
  files into a zip (stored, not deflated) so `bios7.bin` / `bios9.bin` /
  `firmware.bin` keep their names. Verified: raw `.bin`, multi-select, and `.zip`
  all land under the right names.
- Core option labels in the settings menu are the raw core option names, e.g.
  `melonds screen layout`, not prettified. The core list entry is
  `Core (Requires restart)`. Help text must match these exactly.
- With `melonds_screen_layout: "Left/Right"` the canvas is ~2.4:1 (two panels side
  by side). The DS touchscreen is the right-hand panel. `"Top/Bottom"` stacks them
  (~0.67:1) and suits portrait.
- `EJS_defaultOptions` is only consulted when there are **no saved settings** for
  the game. `getCoreSettings()` in `emulator.js` writes the saved blob first and
  appends defaults only for keys not already present, so a layout stored during an
  earlier session silently wins. `guardScreenLayout()` re-asserts the layout from
  `EJS_ready`/`EJS_onGameStart` and refits the canvas. It re-asserts instead of
  writing localStorage because `changeSettingOption` is the same path the settings
  menu uses, and it no-ops when the layout is already correct.
- The layout is not hard-coded to landscape: `settings.layout` is `auto` (follows
  `matchMedia("(orientation: portrait)")`), `landscape`, or `portrait`, cycled by
  the **Layout** button. `applyLayout()` maps it to the core value (`Left/Right` /
  `Top/Bottom`) and also drives `screen.orientation.lock`, which is only requested
  when the player pinned an orientation — on `auto` the screen must stay free to
  rotate. `updateOrientation()` re-runs the guard and the fit on
  `resize`/`orientationchange`, so turning the phone swaps the layout live with no
  reload.
- Threaded cores are a rendering risk on Apple mobile. The service worker's
  COOP/COEP headers make the page cross-origin isolated, which exposes
  `SharedArrayBuffer`, so `EJS_threads` would otherwise be true on iPhone and pull
  the `melonds-thread` build. `app.js` keeps threads for desktop and turns them off
  for Apple mobile (`iPhone|iPad|iPod` in the UA, plus a `MacIntel` platform with
  `maxTouchPoints > 1` for iPadOS, which reports a desktop UA). EmulatorJS still
  offers a Threads toggle in Core Options, so this is a default, not a lock.
- A suppressed `EJS_defaultOptions` is the quickest way to reproduce the stacked
  layout for testing: `Object.defineProperty(window, 'EJS_defaultOptions', {get: () =>
  undefined, set: () => {}})` in an init script. `/tmp/regress.py` uses it.
- The melonds core's own `b_speed_fast` / `b_speed_slow` buttons sit flush against
  the bottom edge and can measure a few px off screen. That is cosmetic, not a bug.

## Fullscreen

iPhone Safari has **no** element-level fullscreen: `requestFullscreen` and
`webkitRequestFullscreen` are both `undefined` on an ordinary element (only video
gets `webkitEnterFullScreen`). The usual `if (rf) rf.call(el)` guard therefore
silently does nothing, and `document.fullscreenEnabled` is not a safe proxy for
the same reason. Detect on the element itself (`fullscreenFn` in `app.js`).

When no method exists the app falls back to `#app.pseudo-full`, which drops the
header from the layout so the canvas fills the display. That is a real height
change (348 -> 390 on iPhone 12 landscape), so `emulator.handleResize()` must be
called after toggling. Because the header is gone, `.exit-full`
(`#btnExitFull`) is the only way out, so it has to stay hittable; Escape also
exits. Teardown resets the state, otherwise ejecting leaves the header hidden.

The in-game bar normally lives in the header, but there is no header in
`pseudo-full`, so it is floated back over the top edge instead. That makes it the
one case where the bar overlays the game; it is kept to a single row and given
`margin-right` to clear `.exit-full`.

## The in-game control bar

EmulatorJS renders its control bar (restart, pause, save state, settings, …) as an
overlay inside `#game`, and `start()` auto-opens it on a timer. Both are wrong
here: it would cover the touchscreen, and on a phone it would pop in and out under
a moving thumb. `adoptGameBar()` moves the `.ejs_menu_bar` node into `#gameBar` in
the header, and its own show/hide state is ignored in favour of the `barHidden`
setting behind **Bar on/off**.

Three non-obvious consequences of moving it out of `#game`:

- EmulatorJS skins its buttons under `.ejs_big_screen` / `.ejs_small_screen`,
  classes it sets on the *stage*. In the header that scope no longer matches, so
  the buttons fall back to the browser's default grey. `styles.css` restates the
  transparent skin and the icon-only layout explicitly.
- EmulatorJS injects `emulator.min.css` **after** `styles.css`, so equal-specificity
  overrides lose. Its own floating pad toggle (`.ejs_virtualGamepad_open`) needs
  `#game .ejs_virtualGamepad_open` to beat it; a bare class selector silently does
  nothing.
- The popups (settings, disks) anchor inside the bar and open *upward*
  (`bottom:100%`). `#gameBar` scrolls sideways, which would clip them, so they are
  re-anchored `position:fixed` below the header. Any new popup added by a core will
  need the same treatment.

## Offline

Offline needs the EmulatorJS **loader** and bundle cached, not just the app shell.
The loader, `emulator.min.css` and `emulator.min.js` are injected as plain
`<script>`/`<link>` tags with no `crossorigin` attribute, so the browser fetches
them without CORS and they arrive as **opaque** responses (`status === 0`,
`type === "opaque"`). An earlier `fetch` handler guarded on
`res.status === 200 && type in {basic, cors}` and silently dropped every one of
them: the shell cached, the emulator did not, and a cold offline start died on
`Could not load .../loader.js`. The guard now accepts opaque responses, since a
cached opaque response can still be replayed to the same kind of tag.

Opaque responses **cannot** be re-wrapped (`withHeaders` would throw), so the
same-origin COOP/COEP path must not touch them. They also cannot be read, so
`mode: "cors"` vs `mode: "no-cors"` has to match how the page will request the
file: warming the core files (`melonds-wasm.data`, `melonds.json`, `version.json`,
`extract7z.js`, `localization/en-US.json`) with `no-cors` would store opaque
entries whose URLs match the core's later `fetch`, and a cors read of an opaque
entry is rejected. Install therefore warms in two groups, `WARM_NO_CORS` and
`WARM_CORS`; the core files except the default `melonds` fill in on first use.

`/tmp/offline.py` is the check: boot a ROM online, then `context.route` every
non-localhost request to `abort` and reload. `startedOffline: true` plus
`coreName: "melonds"` is a pass. The only remaining console error is the
`Wake Lock permission request denied` warning, which is expected headless.

## Testing

Chromium headless + CDP scripts in `/tmp` (`accept.js` full suite, `iphone2.js`
landscape/touch, `biosmatrix.js` BIOS matrix, `biocancel.js`). Serve locally from
`/tmp/nds-local`. All suites also run against the live URL.

WebKit is the only faithful target for iPhone behaviour, so the v4 features are
covered by `/tmp/regress_v4.py` (fill, floating pad, autosave), `/tmp/test_interaction.py`
(touchscreen, hide/show, scheme) and `/tmp/test_resume.py` (save then reload then
resume). Run them with `python3 <script> http://localhost:8903/index.html <rom>`.

The floating pad listens for **pointer** events *and* **touch** events. Safari has
historically delivered only touch, so both are bound and whichever arrives first wins.
Test with `page.touchscreen.tap` / `page.mouse`, or synthetic `PointerEvent`s.

Note that `#stick` is positioned with `left`/`top` inside `#game`, so its ring centre
is in *stage* coordinates. `update()` must subtract the stage origin before comparing
against that centre — passing raw `clientX/clientY` offsets every reading by the
header height, which is past both the dead zone and the 52 px travel limit, so the
stick reads one direction and never releases. Verify by pressing at a known point and
checking the ring and knob land on it.

## Canvas geometry and the letterbox bands

The melonDS core sizes its GL viewport from the canvas *element* box and then fits
the DS frame inside the canvas *buffer*. With a box whose aspect differs from the
video it letterboxes in-buffer and paints the bands opaque black — they are the
core's pixels, so no CSS behind the canvas can fill them. `fitCanvas()` sets the
canvas box to the video aspect, which makes the viewport fill the buffer exactly
(verify with `gl.getParameter(gl.VIEWPORT)` vs `canvas.height`). A frame captured
from the core then feeds `--frame-blur` for the remaining CSS bands.

The box is sized in **px from the parent**, constrained on whichever axis binds
(`w = availW; h = w / aspect; if (h > availH) { h = availH; w = h * aspect; }`),
not `width:100%`. Sizing on width alone overflows a short stage: the stacked layout
pinned on a landscape phone wanted 844x1266 inside a 348px-tall stage.

`getVideoDimensions('aspect')` returns the other orientation's aspect before the
core applies the requested layout, so `fitCanvas()` only accepts a reading that
matches the requested layout — landscape waits for `> 1.2`, portrait for `< 1` —
and retries. Taking an early value squashes the canvas to a fraction of its size.

The floating pad's `update()` reads the stage rect on every pointermove. That forced
layout during play is exactly when the main thread is busiest, so the rect is cached
in `stageRect()` and invalidated by `watchStageRect()` (resize, orientationchange,
and a `ResizeObserver` on the stage).

EmulatorJS' `.ejs_virtualGamepad_left/right` are full-height containers and its
stylesheet re-enables `pointer-events` on them, so both the parent *and* the clusters
must be set to `none` for the floating pad's touches to land. Only
`.ejs_virtualGamepad_button` and the d-pad keep `auto`.

## Letterbox fill and the stage bottom edge

The bands are fed by a frame captured from the core. That URL lives in a CSS custom
property, so it must **not** be revoked on load: revoking leaves `--frame-blur`
pointing at a dead blob and the bands silently fall back to the flat colour (a `new
Image()` on the property value then reports `onerror`). Keep the newest URL and revoke
the previous one when replacing it.

`#app` carries the bottom safe-area inset so the header clears the home indicator, but
the stage pulls it back out with a negative `margin-bottom`. Without that the game stops
21 px short of the bottom edge on a notched phone, leaving a strip of page background
under it; the controls already offset themselves by `--safe-b`. Check by sampling the
last rows of a screenshot: the strip is `#0b1016`, while the stage under it shows the
frame fill.

## Autosave

Save states go to IndexedDB (`ndspocket-autosave`), keyed by `state:<rom-slug>` from
the ROM's file name, because a DS state is ~6.5 MB and would blow the localStorage
quota. Writes happen every 60 s, on `pagehide` and on tab hide; the state is loaded
2.5 s after game start, since loading mid-boot fights the BIOS handshake. Turning
autosave off deletes the stored state, and a boot with autosave off drops any state
left by an earlier session, so re-enabling never resumes a stale moment.

## Style

No comments that restate the code. Comment only non-obvious invariants, e.g. why a
blob URL is used, or why an empty `change` event must not clear state.
