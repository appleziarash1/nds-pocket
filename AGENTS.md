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
