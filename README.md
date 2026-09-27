# NDS Pocket

A Nintendo DS player that runs entirely in the browser, built on
[EmulatorJS](https://emulatorjs.org/) with the `melonds` core. It works in either
orientation and, once opened, keeps working offline.

**Bring your own ROM.** You pick a file, it is read on your device, and it is
never uploaded anywhere. The site ships no games, no BIOS files and no
copyrighted content.

## Using it

1. Open the site and tap **Add ROM**, then choose a `.nds` file. A `.zip`
   containing a ROM works too.
2. Play. On iPhone, add it to the home screen first (**Share → Add to Home
   Screen**) so it launches without browser chrome and can run offline.
3. The two DS screens are shown side by side in landscape and stacked in
   portrait. **Auto** in the top bar follows the way you hold the phone; tap it to
   pin **Side** or **Stacked** instead.

The emulator menu is the small handle at the bottom centre. Its own fullscreen
button is intentionally hidden, because EmulatorJS force-locks NDS fullscreen to
portrait, which fights this layout. Use **Full** in the top bar instead.

### BIOS (optional)

Games boot without one. If a title misbehaves, tap **Add NDS BIOS** and select
`bios7.bin`, `bios9.bin` and `firmware.bin` together, or drop in a `.zip` holding
them. Files are packed in the browser so the core finds them under their real
names; nothing leaves the device.

## Controls

| Action | On-screen | Keyboard |
|---|---|---|
| D-pad | Floating pad, left half | `W` `A` `S` `D` |
| A / B | Right cluster | `Z` / `X` |
| X / Y | Right cluster | `K` / `L` |
| L / R | Top corners | `Q` / `E` |
| Start / Select | Centre | `Enter` / `V` |

The direction control floats: press anywhere in the left half and the ring appears
under your thumb, then keeps up as you drag, so a long hold never runs out of travel.
**Stick** draws a ring and knob; **D-pad** draws a four-way cross. Both are driven by
touch, so the same control works under a thumb on the glass or a mouse in a desktop
browser.

A USB or Bluetooth gamepad is picked up automatically; the emulator menu shows a
gamepad badge once one connects. The on-screen pad has an opacity slider (20–100%)
and a **Pad on/off** toggle for when you are using a physical controller.

Because the pad covers the left half, that area maps to the **top screen**. The
touchscreen is the right half, and stays clear for games that use it. In portrait
the pad zone follows the top screen, since the stacked pair puts it in the upper
half and leaves the lower half free for the touchscreen.

### Autosave

**Save** is on by default and writes an emulator save state every minute, plus once
more when you leave the page. Reopening the same ROM resumes from it. States are
kept in IndexedDB — one is around 6.5 MB, which would blow the `localStorage` quota
— and are keyed by the ROM's file name. Switching **Save** off deletes the stored
state, so turning it back on never drops you into a moment you have moved past.

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
- **Offline play works after one online visit.** The worker caches the app shell
  at install and warms the EmulatorJS front end (loader, stylesheet, bundle) and
  the default `melonds` core. The CDN serves the scripts without CORS, so those
  land in the cache as opaque responses — storable and replayable, but unreadable,
  which is why the worker treats them differently from the core files.
- **The screen layout follows the orientation.** Side by side in landscape,
  stacked in portrait, with a **Layout** button to pin either one. Switching swaps
  the core's own `Screen Layout` option and refits the canvas; the same pass runs
  on rotation, so turning the phone changes the layout live without a reload.
- **The frame keeps its aspect ratio.** A side-by-side pair is about 2.67:1 and a
  stacked pair about 0.67:1. The canvas is shaped to whichever the core reports and
  sized to fit the stage on its binding axis, so it never stretches or runs off the
  screen, and the frame edges sit against a soft copy of the picture rather than
  black bars.

## Deploying

Static site, no build step. Publish the repo root to GitHub Pages and set
**Settings → Pages → Source** to the branch root.

If a title misbehaves, switch core under Menu → Core to `desmume` or
`desmume2015`.
