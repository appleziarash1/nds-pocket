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

`app.js`'s thumbstick listens for **pointer** events (`pointerdown`/`pointermove`),
not touch events. Test it with `Input.dispatchTouchEvent` (Safari derives pointer
events from touch) or synthetic `PointerEvent`s — synthetic `TouchEvent`s will not
drive it.

## Style

No comments that restate the code. Comment only non-obvious invariants, e.g. why a
blob URL is used, or why an empty `change` event must not clear state.
