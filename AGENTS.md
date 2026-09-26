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
  by side). The DS touchscreen is the right-hand panel.
- `EJS_defaultOptions` is only consulted when there are **no saved settings** for
  the game. `getCoreSettings()` in `emulator.js` writes the saved blob first and
  appends defaults only for keys not already present, so a layout stored during an
  earlier session silently wins over the default on every later load. That is what
  produced the "half game, half black" report: the core ran its own `Top/Bottom`
  default (256x384, ~1.5:1 portrait) and the fitter left black either side of a
  landscape stage. `guardScreenLayout()` re-asserts `Left/Right` from
  `EJS_ready`/`EJS_onGameStart` and refits the canvas, so the frame is right on
  every load rather than only the first. It re-asserts instead of writing
  localStorage because `changeSettingOption` is the same path the settings menu
  uses, and it no-ops when the layout is already correct.
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

## Canvas geometry and the letterbox bands

The melonDS core sizes its GL viewport from the canvas *element* box and then fits
the 2.67:1 DS frame inside the canvas *buffer*. With a box wider than the video it
letterboxes in-buffer and paints the bands opaque black — they are the core's pixels,
so no CSS behind the canvas can fill them. `fitCanvas()` sets the canvas box to the
video aspect, which makes the viewport fill the buffer exactly (verify with
`gl.getParameter(gl.VIEWPORT)` vs `canvas.height`). A frame captured from the core
then feeds `--frame-blur` for the remaining CSS bands.

`getVideoDimensions('aspect')` returns the portrait `0.667` before the core applies
the Left/Right layout, so `fitCanvas()` ignores anything at or below `1.2` and retries.
Taking that early value squashes the canvas to a quarter width.

EmulatorJS' `.ejs_virtualGamepad_left/right` are full-height containers and its
stylesheet re-enables `pointer-events` on them, so both the parent *and* the clusters
must be set to `none` for the floating pad's touches to land. Only
`.ejs_virtualGamepad_button` and the d-pad keep `auto`.

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
