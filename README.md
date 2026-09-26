# NDS Pocket

A landscape-first Nintendo DS player that runs entirely in the browser, built on
[EmulatorJS](https://emulatorjs.org/) with the `melonds` core.

**Bring your own ROM.** You pick a file, it is read on your device, and it is
never uploaded anywhere. The site ships no games, no BIOS files and no
copyrighted content.

## Using it

1. Open the site and tap **Add ROM**, then choose a `.nds` file. A `.zip`
   containing a ROM works too.
2. Rotate to landscape. On iPhone, add it to the home screen first
   (**Share → Add to Home Screen**) so it launches without browser chrome.
3. Play. Tap the lower screen to use the DS touchscreen.

The emulator menu is the small handle at the bottom centre. Its own fullscreen
button is intentionally hidden, because EmulatorJS force-locks NDS fullscreen to
portrait, which fights this layout. Use **Full** in the top bar instead.

## Controls

| Action | On-screen | Keyboard |
|---|---|---|
| D-pad | Stick or D-pad, bottom left | Arrow keys |
| A / B | Right cluster | `Z` / `X` |
| X / Y | Right cluster | `A` / `S` |
| L / R | Top corners | `Q` / `E` |
| Start / Select | Centre | `Enter` / `V` |

A USB or Bluetooth gamepad is picked up automatically; the emulator menu shows a
gamepad badge once one connects. The on-screen pad has an opacity slider
(20–100%) and a **Pad on/off** toggle for when you are using a physical
controller.

## Notes on how it works

- **ROM swapping reloads the page.** EmulatorJS evaluates only once per
  document, so ejecting sets a `sessionStorage` flag and reloads to a clean
  picker. The flag prevents a reload loop.
- **The service worker fabricates `COOP`/`COEP` headers.** GitHub Pages cannot
  set them, and the threaded core needs `SharedArrayBuffer`. The worker
  re-serves same-origin responses with the isolation headers, which makes the
  page cross-origin isolated without a server.
- **A boot watchdog catches rejected ROMs.** When a core cannot parse a file it
  only paints "Failed to start game" inside its own canvas, so the shell polls
  for that and shows an actionable card instead of hanging.
- **Both screens sit side by side** by default, which suits landscape. Change it
  under Menu → Backend Core Options → Screen Layout.

## Deploying

Static site, no build step. Publish the repo root to GitHub Pages and set
**Settings → Pages → Source** to the branch root.

If a title misbehaves, switch core under Menu → Core to `desmume` or
`desmume2015`.
