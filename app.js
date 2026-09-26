/* NDS Pocket — Nintendo DS player built on EmulatorJS.
   Everything runs locally: the chosen ROM is read from disk and never uploaded. */
(() => {
  "use strict";

  const EJS_DATA = "https://cdn.emulatorjs.org/stable/data/";
  const EJS_LOADER = EJS_DATA + "loader.js";
  const EJS_CSS = EJS_DATA + "emulator.min.css";
  const STORE_KEY = "ndspocket.settings.v1";

  // Control ids, matching EmulatorJS' own mapping for the NDS control scheme.
  const C = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };
  const DPAD = [C.UP, C.DOWN, C.LEFT, C.RIGHT];

  const $ = (id) => document.getElementById(id);

  const el = {
    app: $("app"),
    bar: $("bar"),
    brandDot: document.querySelector(".brand .dot"),
    btnRom: $("btnRom"),
    btnEject: $("btnEject"),
    btnScheme: $("btnScheme"),
    schemeLabel: $("schemeLabel"),
    btnPad: $("btnPad"),
    padLabel: $("padLabel"),
    btnBar: $("btnBar"),
    barLabel: $("barLabel"),
    btnFull: $("btnFull"),
    btnExitFull: $("btnExitFull"),
    opacityWrap: $("opacityWrap"),
    opacity: $("opacity"),
    opacityOut: $("opacityOut"),
    btnAutoSave: $("btnAutoSave"),
    autoLabel: $("autoLabel"),

    stage: $("stage"),
    game: $("game"),
    padZone: $("padZone"),
    gameBar: $("gameBar"),

    boot: $("boot"),
    drop: $("drop"),
    btnBios: $("btnBios"),
    btnAbout: $("btnAbout"),
    checks: $("checks"),

    load: $("load"),
    loadTitle: $("loadTitle"),
    loadMsg: $("loadMsg"),
    loadBar: $("loadBar"),
    loadRetry: $("loadRetry"),

    sheet: $("sheet"),
    sheetTitle: $("sheetTitle"),
    sheetBody: $("sheetBody"),
    sheetX: $("sheetX"),
    rotate: $("rotate"),

    romInput: $("romInput"),
    biosInput: $("biosInput"),
  };

  const settings = Object.assign(
    { padOpacity: 0.7, scheme: "stick", padHidden: false, barHidden: false, autoSave: true },
    readSettings()
  );

  let emulator = null;
  let booted = false;
  let stick = null;
  let biosFiles = [];
  // EmulatorJS treats EJS_biosUrl as a URL string and calls .split("/") on it, so
  // a raw File would throw inside a promise that never settles and hang the boot.
  // Hand it a blob: URL instead, and revoke it once the core has read the bytes.
  let biosBlobUrl = "";
  async function makeBiosUrl() {
    if (biosBlobUrl) { try { URL.revokeObjectURL(biosBlobUrl); } catch { /* already gone */ } biosBlobUrl = ""; }
    if (!biosFiles.length) return "";
    const payload = await biosPayload();
    biosBlobUrl = URL.createObjectURL(payload);
    return biosBlobUrl;
  }
  let ejecting = false;
  let bootWatchdog = 0;

  function readSettings() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }
  function writeSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  }

  /* ---------------- environment checks ---------------- */

  function addCheck(text, state) {
    const li = document.createElement("li");
    li.textContent = text;
    if (state) li.className = state;
    el.checks.appendChild(li);
    return li;
  }

  function reportEnvironment() {
    el.checks.replaceChildren();

    if (!window.isSecureContext) {
      addCheck("Page must be served over HTTPS for the emulator to run", "bad");
    }

    if (typeof SharedArrayBuffer === "function") {
      addCheck("Fast multi-threaded core enabled", "ok");
    } else {
      addCheck("Single-threaded core (this page isn't cross-origin isolated)", "warn");
    }

    if (typeof WebAssembly !== "object") {
      addCheck("This browser has no WebAssembly support", "bad");
    }

    if (!navigator.serviceWorker) {
      addCheck("Service worker unavailable — offline mode and fast cores are off", "warn");
    }
  }

  /* ---------------- service worker ---------------- */

  // Guards against a reload loop if the browser never hands us a controller.
  const RELOAD_FLAG = "ndspocket.reloaded";

  function registerServiceWorker() {
    if (!navigator.serviceWorker || !window.isSecureContext) return;

    navigator.serviceWorker.register("sw.js", { scope: "./" }).then((reg) => {
      // The worker injects COOP/COEP, which only applies to documents it controls.
      // One reload after the first install is what turns isolation on.
      if (!navigator.serviceWorker.controller) {
        if (sessionStorage.getItem(RELOAD_FLAG)) {
          addCheck("Running without cross-origin isolation — reload once to enable fast cores", "warn");
          return;
        }
        const reload = () => {
          sessionStorage.setItem(RELOAD_FLAG, "1");
          location.reload();
        };
        navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
        // Fall back in case controllerchange never fires (older WebKit).
        setTimeout(() => { if (!navigator.serviceWorker.controller) reload(); }, 1500);
      }
      reg.update && reg.update();
    }).catch(() => {
      addCheck("Service worker could not be registered", "warn");
    });
  }

  /* ---------------- emulator lifecycle ---------------- */

  function defineEjsGlobals() {
    const w = window;
    w.EJS_player = "#game";
    w.EJS_core = "nds";
    w.EJS_controlScheme = "nds";
    w.EJS_pathtodata = EJS_DATA;
    w.EJS_startOnLoaded = true;
    w.EJS_volume = 0.7;
    // Threaded cores are the documented source of rendering trouble on Apple
    // mobile: the worker-backed melonDS build is what painted partial or blank
    // frames on iPhone. The service worker makes the page cross-origin isolated,
    // which exposes SharedArrayBuffer, so EmulatorJS would otherwise pick the
    // threaded build on a phone by default. Desktop keeps the faster build, and
    // the in-game Core Options menu can still turn threads back on by hand.
    // iPadOS reports a desktop UA, so touch capability has to be checked too.
    const ua = navigator.userAgent || "";
    const appleMobile = /iPhone|iPad|iPod/.test(ua)
      || (/Mac/.test(navigator.platform || "") && navigator.maxTouchPoints > 1);
    w.EJS_threads = !appleMobile && typeof SharedArrayBuffer === "function";
    w.EJS_defaultOptions = { melonds_screen_layout: "Left/Right" };
    // D-pad on WASD. EmulatorJS replaces the whole scheme when this is set, so
    // it mirrors the built-in nds map with two changes: the arrows become WASD,
    // and X/Y move off A/S (to K/L) because otherwise pressing A would fire
    // dpad-left and the X button at the same time.
    w.EJS_defaultControls = {
      0: {
        0: { value: "x", value2: "BUTTON_2" },
        1: { value: "l", value2: "BUTTON_4" },
        2: { value: "v", value2: "SELECT" },
        3: { value: "enter", value2: "START" },
        4: { value: "w", value2: "DPAD_UP" },
        5: { value: "s", value2: "DPAD_DOWN" },
        6: { value: "a", value2: "DPAD_LEFT" },
        7: { value: "d", value2: "DPAD_RIGHT" },
        8: { value: "z", value2: "BUTTON_1" },
        9: { value: "k", value2: "BUTTON_3" },
        10: { value: "q", value2: "LEFT_TOP_SHOULDER" },
        11: { value: "e", value2: "RIGHT_TOP_SHOULDER" },
        14: { value: "", value2: "LEFT_STICK" },
        24: { value: "1" },
        25: { value: "2" },
        26: { value: "3" },
        27: {},
        28: {},
        29: {},
      },
      1: {}, 2: {}, 3: {},
    };
    // The shell supplies its own on-screen controls, so trim EmulatorJS' chrome
    // down to the essentials and keep every button in the menu bar. Its own
    // fullscreen button is off because it force-locks NDS to portrait, which
    // would fight this landscape-only layout.
    w.EJS_Buttons = {
      playPause: true, restart: true, saveState: true, loadState: true,
      saveSavFiles: true, loadSavFiles: true, screenshot: true, fullscreen: false,
      settings: true, contextMenu: true, volume: true, gamepad: true,
      cheat: false, cacheManager: false, netplay: false, screenRecord: false,
      exitEmulation: false, mute: true, quickSave: false, quickLoad: false,
      diskButton: false,
    };
    w.EJS_ready = () => {
      hideLoad();
      el.brandDot.classList.add("live");
      setupOnScreenControls();
      setScheme(settings.scheme, true);
      applyOpacity(settings.padOpacity, true);
      applyPadHidden(settings.padHidden, true);
      adoptGameBar();
      applyBarHidden(settings.barHidden, true);
      lockLandscape();
      updateOrientation();
      guardScreenLayout();
      fitCanvasSoon();
    };
    w.EJS_onGameStart = () => {
      hideLoad();
      el.brandDot.classList.add("live");
      lockLandscape();
      updateOrientation();
      guardScreenLayout();
      fitCanvasSoon();
      startAutoSave();
      // Loading a state mid-boot fights the BIOS handshake, so let the core settle
      // first. A missing or stale state simply leaves the game at its own start.
      if (settings.autoSave) setTimeout(autoLoad, 2500);
    };
  }

  function ensureEmulatorStyles() {
    if (document.querySelector("link[data-ejs]")) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = EJS_CSS;
    link.dataset.ejs = "1";
    document.head.appendChild(link);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.dataset.ejs = "1";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  // The loader injects its own sub-scripts; tag them so teardown can find them.
  function tagEmulatorScripts() {
    document.querySelectorAll("script[src]").forEach((s) => {
      if (s.src.includes("cdn.emulatorjs.org")) s.dataset.ejs = "1";
    });
  }

  function whenEmulatorReady(timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function poll() {
        if (window.EJS_emulator) return resolve(window.EJS_emulator);
        if (Date.now() - started > timeoutMs) return reject(new Error("Emulator did not initialise"));
        setTimeout(poll, 50);
      })();
    });
  }

  async function startGame(file) {
    if (ejecting) return;
    // EmulatorJS' bundle can only be evaluated once per document, so a game can
    // only be swapped by reloading. Anything else would need a second page load
    // to be safe, and losing a running game silently is worse than a reload.
    if (booted || window.EJS_emulator) { eject(); return; }

    teardownEmulator();
    showLoad("Loading", "Reading " + file.name + "…");

    window.EJS_gameUrl = file;
    window.EJS_gameName = (file.name || "game").replace(/\.[^.]+$/, "");
    autoSlug = slugFor(file.name);
    // A previous session may have turned autosave off, in which case the state it
    // left behind must not come back now that the slug is known.
    if (!settings.autoSave) dropAutoState();
    // Keep big ROMs out of the browser cache; re-picking a file is cheap and this
    // avoids blowing the storage quota on iOS.
    window.EJS_CacheLimit = 0;
    window.EJS_biosUrl = await makeBiosUrl();

    ensureEmulatorStyles();

    try {
      showLoad("Loading", "Fetching the emulator core…", 12);
      await loadScript(EJS_LOADER);
      emulator = await whenEmulatorReady(15000);
      tagEmulatorScripts();
      booted = true;
      el.btnEject.hidden = false;
      el.btnScheme.hidden = false;
      el.btnPad.hidden = false;
      el.btnBar.hidden = false;
      el.btnFull.hidden = false;
      el.opacityWrap.hidden = false;
      el.btnAutoSave.hidden = false;
      showLoad("Loading", "Starting emulation…", 45);
      // EJS_ready / EJS_onGameStart drive the rest of the progress UI. If a core
      // rejects the ROM it only paints "Failed to start game" inside its own
      // canvas, so watch for that and surface something actionable.
      armBootWatchdog(file);
    } catch (err) {
      showLoad("Could not start", "The emulator core failed to load. Check your connection and try again.", null, true);
      console.error(err);
    }
  }

  // A core that can't parse the ROM paints "Failed to start game" into its own
  // canvas and stops. Poll for that, plus a hard deadline, so the user is not
  // left staring at a loading card.
  function armBootWatchdog(file) {
    clearInterval(bootWatchdog);
    const deadline = Date.now() + 60000;
    bootWatchdog = setInterval(() => {
      if (!emulator) return;
      if (emulator.started) { clearInterval(bootWatchdog); return; }
      const text = emulator.textElem ? emulator.textElem.innerText : "";
      if (emulator.failedToStart || /failed to start/i.test(text)) {
        clearInterval(bootWatchdog);
        showLoad(
          "Could not load " + file.name,
          "The emulator rejected this file. It may be a GBA or 3DS image, a corrupt dump, or a bad archive. Try a different ROM, or switch core under Menu → Core.",
          null, true
        );
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(bootWatchdog);
        showLoad(
          "Still loading " + file.name,
          "This is taking longer than usual. Big ROMs can be slow to copy into memory — give it a moment, or eject and try another file.",
          null, true
        );
      }
    }, 700);
  }

  function teardownEmulator() {
    clearInterval(bootWatchdog);
    if (emulator) {
      try { emulator.gamepad && emulator.gamepad.terminate && emulator.gamepad.terminate(); } catch { /* already gone */ }
      try { emulator.callEvent && emulator.callEvent("exit"); } catch { /* already gone */ }
    }
    emulator = null;
    booted = false;
    window.EJS_emulator = null;
    if (biosBlobUrl) { try { URL.revokeObjectURL(biosBlobUrl); } catch { /* already gone */ } biosBlobUrl = ""; }
    if (padObserver) { padObserver.disconnect(); padObserver = null; }
    stopAutoSave();
    destroyStick();
    el.game.replaceChildren();
    document.body.classList.remove("pad-on");
    document.body.classList.remove("menu-off");
    setFallbackFullscreen(false);
    el.brandDot.classList.remove("live");
    ["btnEject", "btnScheme", "btnPad", "btnBar", "btnFull", "btnAutoSave"].forEach((k) => { el[k].hidden = true; });
    el.opacityWrap.hidden = true;
  }

  // EmulatorJS declares its classes at the top level of a classic script, so the
  // bundle can only ever be evaluated once per document. Swapping games therefore
  // needs a fresh page; the flag just tells the next load to show the picker.
  const EJECT_FLAG = "ndspocket.eject";

  function eject() {
    ejecting = true;
    // Nothing to tear down by hand: the reload below discards the emulator, and
    // calling exit()/unmount here can leave the core's IndexedDB mid-sync.
    try { sessionStorage.setItem(EJECT_FLAG, "1"); } catch { /* private mode */ }
    location.reload();
  }

  /* ---------------- overlays ---------------- */

  function showLoad(title, msg, pct, failed) {
    el.load.hidden = false;
    el.loadTitle.textContent = title;
    el.loadMsg.textContent = msg;
    // Once a load fails, offer a way out instead of a dead-end card.
    el.loadRetry.hidden = !failed;
    if (typeof pct === "number") {
      el.loadBar.style.width = pct + "%";
      el.loadBar.parentElement.style.display = "";
    } else if (failed) {
      el.loadBar.parentElement.style.display = "none";
    } else {
      el.loadBar.style.width = "8%";
      el.loadBar.parentElement.style.display = "";
    }
  }

  function hideLoad() {
    el.load.hidden = true;
    el.loadBar.style.width = "0%";
  }

  function openSheet(title, html) {
    el.sheetTitle.textContent = title;
    el.sheetBody.innerHTML = html;
    el.sheet.hidden = false;
  }
  function closeSheet() { el.sheet.hidden = true; }

  // The DS shows two screens side by side, so portrait is unusable. Ask for
  // landscape up front (Android) and nag on iPhone, where the API is absent.
  function updateOrientation() {
    const portrait = window.matchMedia("(orientation: portrait)").matches;
    el.rotate.hidden = !(booted && portrait);
  }

  function wireOrientation() {
    window.addEventListener("resize", updateOrientation);
    window.addEventListener("orientationchange", updateOrientation);
    updateOrientation();
  }

  // EmulatorJS only reads EJS_defaultOptions when it has no saved settings for the
  // game, so a layout stored during an earlier session keeps overriding the
  // side-by-side default. A stacked frame (256x384) fitted into a landscape stage
  // fills roughly a quarter of its width, leaving black either side - the "half
  // game, half black" players reported. Re-assert the layout once the core is up
  // and refit the canvas, so the frame is right on every load, not just the first.
  function guardScreenLayout() {
    if (!emulator || typeof emulator.changeSettingOption !== "function") return;
    let current = null;
    try { current = emulator.getSettingValue("melonds_screen_layout"); } catch { /* menu not built yet */ }
    if (current === "Left/Right") return;
    emulator.changeSettingOption("melonds_screen_layout", "Left/Right");
    requestAnimationFrame(() => {
      if (emulator && emulator.handleResize) emulator.handleResize();
    });
  }

  // The core renders into a GL viewport shaped from the canvas box, then letterboxes
  // that inside the canvas buffer when the box is wider than the DS frame. Those
  // bands are painted opaque black by the core, so nothing behind the canvas can
  // fill them: the only way to lose them is to make the box the same shape as the
  // video. EmulatorJS' own background blur would have the same problem, which is why
  // this is a canvas geometry fix rather than a styling one.
  //
  // melonDS reports its dimensions before it has switched to the Left/Right layout,
  // when the value is still the portrait 0.667, and taking that would squash the
  // canvas to a quarter of its width. Only a landscape aspect is trusted; a retry
  // picks up the real value once the core is running.
  function fitCanvas() {
    if (!emulator || !emulator.gameManager) return false;
    const cv = document.querySelector(".ejs_canvas");
    if (!cv) return false;
    let aspect = 0;
    try { aspect = Number(emulator.gameManager.getVideoDimensions("aspect")) || 0; } catch { /* not up yet */ }
    if (!(aspect > 1.2)) return false;
    cv.style.aspectRatio = String(aspect);
    cv.style.height = "auto";
    cv.style.width = "100%";
    cv.style.margin = "auto";
    if (emulator.handleResize) emulator.handleResize();
    captureFrame();
    return true;
  }

  // Refit until the core reports a landscape aspect, then leave it alone.
  function fitCanvasSoon() {
    let tries = 0;
    const tick = () => {
      if (fitCanvas() || tries++ >= 10) return;
      setTimeout(tick, 400);
    };
    tick();
  }

  // Feed the letterbox bands a blurred copy of the frame. EmulatorJS' own
  // backgroundBlur needs a config image and is dropped on start, so the capture
  // comes from the core instead. This is ambience rather than a live mirror: one
  // good frame is enough, and a failed capture just leaves the backdrop colour.
  let frameCaptured = false;
  let frameBlobUrl = "";

  function captureFrame() {
    if (frameCaptured || !emulator || !emulator.gameManager) return;
    const gm = emulator.gameManager;
    if (typeof gm.screenshot !== "function") return;
    frameCaptured = true;
    gm.screenshot().then((buf) => {
      if (!buf || !buf.length) { frameCaptured = false; return; }
      const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
      const img = new Image();
      img.onload = () => {
        // The URL is referenced by a CSS custom property, so it has to stay alive;
        // revoking it here leaves the property pointing at a dead blob and the
        // bands fall back to the plain colour. Keep the newest one instead.
        if (frameBlobUrl) URL.revokeObjectURL(frameBlobUrl);
        frameBlobUrl = url;
        document.documentElement.style.setProperty("--frame-blur", `url("${url}")`);
      };
      img.onerror = () => { URL.revokeObjectURL(url); frameCaptured = false; };
      img.src = url;
    }).catch(() => { frameCaptured = false; });
  }

  // Safari on iPhone exposes no element-level fullscreen at all: neither
  // requestFullscreen nor webkitRequestFullscreen exists on an ordinary element,
  // and document.fullscreenEnabled stays unusable there. So the only trustworthy
  // test is whether the element itself carries one of the methods.
  function fullscreenFn(node) {
    return node && (node.requestFullscreen || node.webkitRequestFullscreen || node.mozRequestFullScreen || node.msRequestFullscreen);
  }

  let fallbackFullscreen = false;

  function setFallbackFullscreen(on) {
    fallbackFullscreen = on;
    el.app.classList.toggle("pseudo-full", on);
    el.btnExitFull.hidden = !on;
    const label = el.btnFull.querySelector("span");
    if (label) label.textContent = on ? "Exit" : "Full";
    el.btnFull.classList.toggle("on", on);
    // The stage just changed size, so let the emulator re-fit its canvas.
    if (emulator && emulator.handleResize) requestAnimationFrame(() => emulator.handleResize());
    lockLandscape();
  }

  function lockLandscape() {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("landscape").catch(() => { /* iOS has no lock */ });
    }
  }

  const HELP_HTML = `
    <div class="note">Your ROM stays on this device. Nothing is uploaded, and no game files ship with this site.</div>

    <h2>Getting a ROM</h2>
    <p>NDS Pocket plays <code>.nds</code> files. Dump your own cartridges, or start with free homebrew.</p>
    <ul>
      <li><b>Zipped ROMs work too</b> — pick a <code>.zip</code> and the game inside is used automatically.</li>
      <li>Homebrew titles are a good first test if you don't have a dump yet.</li>
    </ul>

    <h2>Controls</h2>
    <table>
      <tr><th>Action</th><th>Touch</th><th>Keyboard</th></tr>
      <tr><td>D-pad</td><td>Stick or D-pad, bottom left</td><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td></tr>
      <tr><td>A / B</td><td>Right cluster</td><td><kbd>Z</kbd> / <kbd>X</kbd></td></tr>
      <tr><td>X / Y</td><td>Right cluster</td><td><kbd>K</kbd> / <kbd>L</kbd></td></tr>
      <tr><td>L / R</td><td>Top corners</td><td><kbd>Q</kbd> / <kbd>E</kbd></td></tr>
      <tr><td>Start / Select</td><td>Centre</td><td><kbd>Enter</kbd> / <kbd>V</kbd></td></tr>
    </table>
    <p>The DS touchscreen is the right-hand panel. Tap it directly — the left panel is the top screen and ignores taps.</p>
    <p>A wired or Bluetooth controller is picked up automatically. On-screen buttons only appear for pads you have not connected, so a physical controller stays in charge.</p>

    <h2>On-screen controls</h2>
    <ul>
      <li><b>Opacity</b> in the top bar fades the overlay from 20% to 100%.</li>
      <li><b>Pad on/off</b> hides the overlay entirely — handy when you're on a physical controller.</li>
      <li><b>Stick / D-pad</b> switches the left control between an analog thumbstick and a classic D-pad.</li>
    </ul>

    <h2>In-game controls</h2>
    <p>Restart, pause, save states, settings and the rest live in the top bar, to the right of the buttons above — they no longer float over the game. Scroll the bar sideways if your screen is narrow, and use <b>Bar on/off</b> to hide it when you want nothing on screen.</p>

    <h2>Screen layout</h2>
    <p>Both DS screens are shown side by side, which suits landscape. To change it, open <b>Settings</b> in the in-game bar at the top → <b>Backend Core Options</b> → <b>melonds screen layout</b>. "Top/Bottom" stacks them if you prefer.</p>

    <h2>BIOS (optional)</h2>
    <p>The default core boots games without a BIOS, so skip this unless a title misbehaves. To add one, tap <b>Add NDS BIOS</b> and pick <code>bios7.bin</code>, <code>bios9.bin</code> and <code>firmware.bin</code> — you can select all three at once, or drop in a <code>.zip</code> that already contains them. They're kept in this browser only and are cleared when you eject.</p>

    <h2>Install as an app</h2>
    <p>On iPhone: <b>Share → Add to Home Screen</b>, then launch it and rotate to landscape. On desktop Chrome or Edge, use the install icon in the address bar.</p>

    <h2>Full screen</h2>
    <p><b>Full</b> in the top bar hides the toolbar so the game fills the screen. Tap the small <b>×</b> that appears in the corner to come back, or press <kbd>Esc</kbd> on a keyboard.</p>

    <h2>If a game won't boot</h2>
    <ul>
      <li>Try the emulator menu → <b>Core (Requires restart)</b> and switch to <b>desmume</b> or <b>desmume2015</b>, then reload. Some titles prefer a specific core.</li>
      <li>Make sure the file is really a DS ROM (<code>.nds</code>), not a GBA or 3DS image.</li>
      <li>Very large ROMs take a few seconds to copy into memory — the loading bar will tell you.</li>
    </ul>

    <div class="note warn">NDS Pocket is an emulator shell and ships no games, BIOS files or copyrighted content. Use ROMs you own.</div>
  `;

  /* ---------------- ROM intake ---------------- */

  const ROM_EXT = /\.(nds|srl|dsi)$/i;
  const ARCHIVE_EXT = /\.(zip|7z|rar)$/i;

  async function acceptRom(file) {
    if (!file) return;
    const ok = ROM_EXT.test(file.name) || ARCHIVE_EXT.test(file.name);
    if (!ok) {
      showLoad("Unsupported file", file.name + " isn't a DS ROM. Pick a .nds file, or a .zip containing one.", null, true);
      return;
    }
    el.boot.hidden = true;
    startGame(file);
  }

  function pickRom() { el.romInput.click(); }

  function wireRomInputs() {
    el.btnRom.addEventListener("click", pickRom);
    el.drop.addEventListener("click", pickRom);
    el.drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickRom(); }
    });

    el.romInput.addEventListener("change", () => {
      const f = el.romInput.files && el.romInput.files[0];
      el.romInput.value = "";
      acceptRom(f);
    });

    // Eject sends us back to a fresh page; drop the flag and stay on the picker.
    try { sessionStorage.removeItem(EJECT_FLAG); } catch { /* private mode */ }
    let depth = 0;
    const stage = el.stage;
    ["dragenter", "dragover"].forEach((t) =>
      stage.addEventListener(t, (e) => {
        e.preventDefault();
        if (t === "dragenter") depth++;
        el.boot.hidden = false;
        el.drop.classList.add("over");
      })
    );
    ["dragleave", "drop"].forEach((t) =>
      stage.addEventListener(t, (e) => {
        e.preventDefault();
        if (t === "dragleave") depth = Math.max(0, depth - 1);
        else depth = 0;
        if (depth === 0) el.drop.classList.remove("over");
      })
    );
    stage.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) acceptRom(f);
    });
  }

  function wireBios() {
    el.btnBios.addEventListener("click", () => el.biosInput.click());
    el.biosInput.addEventListener("change", () => {
      const picked = Array.from(el.biosInput.files || []);
      el.biosInput.value = "";
      // Cancelling the dialog fires a change event with no files. Keep the
      // previously chosen BIOS instead of silently dropping it.
      if (!picked.length) return;
      biosFiles = picked;
      const label = picked.length === 1 ? picked[0].name : picked.length + " files";
      el.btnBios.textContent = "BIOS: " + label;
      el.btnBios.style.color = "var(--ok)";
    });
  }

  /* ---------------- BIOS packing ---------------- */

  // EmulatorJS writes the BIOS under the file name it sees, and the NDS core only
  // looks for bios7.bin / bios9.bin / firmware.bin. A single file handed over as a
  // blob URL keeps its blob UUID instead of its name, so the core would never find
  // it. Zipping preserves the names, which is what the emulator actually unpacks.
  function crc32(bytes) {
    let c, crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = (crc ^ bytes[i]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipStore(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const { name, data } of entries) {
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // local file header
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, 0x0800, true);       // UTF-8 names
      lv.setUint16(8, 0, true);            // stored, no compression
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      parts.push(local, data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);   // central directory header
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);
      offset += local.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);     // end of central directory
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }

  async function biosPayload() {
    const files = biosFiles;
    if (files.length === 1 && /\.(zip|7z|rar)$/i.test(files[0].name)) return files[0];
    const entries = [];
    for (const f of files) entries.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
    return zipStore(entries);
  }

  /* ---------------- on-screen controls ---------------- */

  function setScheme(scheme, quiet) {
    settings.scheme = scheme;
    if (!quiet) writeSettings();

    el.schemeLabel.textContent = scheme === "stick" ? "Stick" : "D-pad";
    if (!emulator) return;

    // EmulatorJS' own D-pad is pinned to the bottom-left corner, which is not where
    // a thumb naturally rests. Both schemes are drawn by the floating control
    // instead — a ring in "stick", a cross in "dpad" — so its D-pad stays hidden
    // either way. L/R shoulders are a separate element and remain untouched.
    const apply = () => {
      const dpad = document.querySelector(".ejs_virtualGamepad_parent .b_dpad");
      if (!dpad) return false;
      dpad.style.visibility = "hidden";
      buildStick();
      if (stick) stick.wrap.classList.toggle("dpad", scheme === "dpad");
      return true;
    };

    if (apply()) return;
    // Controls are built a tick after "ready"; retry briefly.
    let tries = 0;
    const retry = () => { if (!apply() && tries++ < 60) requestAnimationFrame(retry); };
    requestAnimationFrame(retry);
  }

  // A floating pad: the ring is not pinned to a corner, it appears wherever the
  // thumb lands in the left half of the screen. The base stays put once the thumb
  // is down, and once the thumb travels past the ring it is the base that follows,
  // so a long drag keeps full travel without ever leaving the finger behind.
  const STICK_R = 52;      // max knob travel, px
  const STICK_BASE = 76;   // ring diameter, px
  const STICK_DRIFT = 58;  // how far the thumb may roam before the base follows

  function buildStick() {
    if (stick) return;
    const wrap = document.createElement("div");
    wrap.id = "stick";
    wrap.setAttribute("role", "slider");
    wrap.setAttribute("aria-label", "Analog stick");
    wrap.innerHTML = '<div id="stickKnob"></div>';
    el.game.appendChild(wrap);

    const knob = wrap.querySelector("#stickKnob");
    let active = false;
    let held = new Set();
    let baseX = 0, baseY = 0;   // ring centre, in stage coordinates

    const press = (code) => {
      if (held.has(code)) return;
      held.add(code);
      emulator.gameManager.simulateInput(0, code, 1);
    };
    const release = (code) => {
      if (!held.has(code)) return;
      held.delete(code);
      emulator.gameManager.simulateInput(0, code, 0);
    };
    const clearAll = () => { Array.from(held).forEach(release); };

    const placeBase = (x, y) => {
      baseX = x;
      baseY = y;
      wrap.style.left = x + "px";
      wrap.style.top = y + "px";
    };

    const update = (clientX, clientY) => {
      // The ring is positioned inside the stage, so compare in stage coordinates.
      // Using viewport coordinates here would offset every reading by the stage
      // origin (the header height) and pin the stick against its travel limit.
      const stage = el.stage.getBoundingClientRect();
      const x = clientX - stage.left;
      const y = clientY - stage.top;
      let dx = x - baseX;
      let dy = y - baseY;

      // Let the base chase the thumb so the stick never runs out of travel.
      const roam = Math.hypot(dx, dy);
      if (roam > STICK_DRIFT) {
        const pull = roam - STICK_DRIFT;
        baseX += (dx / roam) * pull;
        baseY += (dy / roam) * pull;
        wrap.style.left = baseX + "px";
        wrap.style.top = baseY + "px";
        dx = x - baseX;
        dy = y - baseY;
      }

      const dist = Math.hypot(dx, dy);
      if (dist > STICK_R) { dx = (dx / dist) * STICK_R; dy = (dy / dist) * STICK_R; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;

      // 8-way with a dead zone, so diagonals work the way a DS expects.
      const dead = STICK_R * 0.3;
      const nx = Math.abs(dx) < dead ? 0 : dx;
      const ny = Math.abs(dy) < dead ? 0 : dy;

      const want = new Set();
      if (nx > 0) want.add(C.RIGHT);
      if (nx < 0) want.add(C.LEFT);
      if (ny > 0) want.add(C.DOWN);
      if (ny < 0) want.add(C.UP);

      DPAD.forEach((c) => (want.has(c) ? press(c) : release(c)));
      wrap.classList.toggle("active", want.size > 0);
    };

    const end = () => {
      if (!active) return;
      active = false;
      clearAll();
      knob.style.transform = "translate(0px, 0px)";
      wrap.classList.remove("active");
      wrap.classList.remove("shown");
    };

    // Pointer events are captured on the zone, so a drag that leaves the zone or
    // the window still arrives here until the finger lifts.
    const zone = el.padZone;

    const onDown = (e) => {
      if (active) return;
      const stage = el.stage.getBoundingClientRect();
      const x = e.clientX - stage.left;
      const y = e.clientY - stage.top;
      active = true;
      placeBase(x, y);
      wrap.classList.add("shown");
      // Throws if the pointer is already gone (a tap so short the id was retired);
      // the drag still works, it just cannot leave the zone.
      try { zone.setPointerCapture(e.pointerId); } catch { /* pointer already retired */ }
      update(e.clientX, e.clientY);
      e.preventDefault();
    };
    const onMove = (e) => { if (active) { update(e.clientX, e.clientY); e.preventDefault(); } };

    zone.addEventListener("pointerdown", onDown);
    zone.addEventListener("pointermove", onMove);
    ["pointerup", "pointercancel"].forEach((t) => zone.addEventListener(t, end));

    // Safari historically delivered only touch events here, so the pad is also driven
    // by touch. Whichever family arrives first wins; the other is then ignored, which
    // keeps a single finger from driving the stick twice.
    let touchActive = false;
    const touchXY = (t) => ({ x: t.clientX, y: t.clientY });
    const onTouchStart = (e) => {
      if (active || touchActive) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const pt = touchXY(t);
      touchActive = true;
      const stage = el.stage.getBoundingClientRect();
      active = true;
      placeBase(pt.x - stage.left, pt.y - stage.top);
      wrap.classList.add("shown");
      update(pt.x, pt.y);
      e.preventDefault();
    };
    const onTouchMove = (e) => {
      if (!active || !touchActive) return;
      const t = e.changedTouches[0];
      if (!t) return;
      update(t.clientX, t.clientY);
      e.preventDefault();
    };
    const onTouchEnd = () => { touchActive = false; end(); };

    zone.addEventListener("touchstart", onTouchStart, { passive: false });
    zone.addEventListener("touchmove", onTouchMove, { passive: false });
    ["touchend", "touchcancel"].forEach((t) => zone.addEventListener(t, onTouchEnd));

    // Releasing outside the window would otherwise leave a direction stuck down.
    const onBlur = () => end();
    const onHide = () => { if (document.hidden) end(); };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHide);

    stick = {
      wrap,
      end,
      destroy() {
        zone.removeEventListener("pointerdown", onDown);
        zone.removeEventListener("pointermove", onMove);
        ["pointerup", "pointercancel"].forEach((t) => zone.removeEventListener(t, end));
        zone.removeEventListener("touchstart", onTouchStart);
        zone.removeEventListener("touchmove", onTouchMove);
        ["touchend", "touchcancel"].forEach((t) => zone.removeEventListener(t, onTouchEnd));
        window.removeEventListener("blur", onBlur);
        document.removeEventListener("visibilitychange", onHide);
      },
    };
  }

  function destroyStick() {
    if (!stick) return;
    stick.end();
    stick.destroy();
    stick.wrap.remove();
    stick = null;
  }

  /* ---------------- auto-save ----------------
     EmulatorJS already persists battery saves (.sav) when it exits, but that only
     helps games that save on their own. This keeps an emulator save state instead,
     so progress survives a refresh, a backgrounded tab, or a battery save the game
     never wrote. Stored in IndexedDB rather than localStorage because a DS state is
     far past the localStorage quota. */

  const AUTOSAVE_MS = 60000;
  const AUTOSAVE_DB = "ndspocket-autosave";
  const AUTOSAVE_STORE = "states";

  let autoTimer = 0;
  let autoSlug = "";

  function autoDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("no indexedDB"));
      const req = indexedDB.open(AUTOSAVE_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(AUTOSAVE_STORE)) {
          req.result.createObjectStore(AUTOSAVE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function autoTx(mode, run) {
    const db = await autoDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUTOSAVE_STORE, mode);
      const store = tx.objectStore(AUTOSAVE_STORE);
      let out;
      try { out = run(store); } catch (err) { reject(err); return; }
      tx.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : out); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  const autoKey = (slug) => "state:" + slug;

  // The stored state is only removed once the ROM it belongs to is known, so that
  // switching autosave off before a game is picked does not race the slug assignment
  // and leave a stale state behind that a later session would resume from.
  function dropAutoState() {
    if (!autoSlug) return;
    autoTx("readwrite", (s) => s.delete(autoKey(autoSlug))).catch(() => { /* nothing stored */ });
  }

  // A ROM is identified by its file name, so the same game resumes across sessions
  // without anything being uploaded or fingerprinted.
  function slugFor(name) {
    return String(name || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "game";
  }

  function autoSaveNow() {
    if (!settings.autoSave || !emulator || !emulator.started || !autoSlug) return;
    const gm = emulator.gameManager;
    if (!gm || typeof gm.getState !== "function") return;
    let data;
    // getState() throws when the core has no savestate support, and it also throws
    // mid-boot, so this must stay guarded rather than assumed.
    try {
      if (typeof gm.supportsStates === "function" && !gm.supportsStates()) return;
      data = gm.getState();
    } catch { return; }
    if (!data || !data.length) return;
    autoTx("readwrite", (s) => s.put({ at: Date.now(), data }, autoKey(autoSlug)))
      .then(() => flashAutoSaved())
      .catch(() => { /* quota or private mode: autosave just stays off */ });
  }

  function autoLoad() {
    if (!settings.autoSave || !emulator || !autoSlug) return;
    const gm = emulator.gameManager;
    if (!gm || typeof gm.loadState !== "function") return;
    autoTx("readonly", (s) => s.get(autoKey(autoSlug)))
      .then((rec) => {
        if (!rec || !rec.data) return;
        try { gm.loadState(rec.data); } catch { /* state from another core build */ }
      })
      .catch(() => { /* nothing stored */ });
  }

  function startAutoSave() {
    stopAutoSave();
    if (!settings.autoSave) return;
    autoTimer = setInterval(autoSaveNow, AUTOSAVE_MS);
  }

  function stopAutoSave() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = 0;
  }

  function flashAutoSaved() {
    if (!el.btnAutoSave) return;
    el.btnAutoSave.classList.add("saved");
    setTimeout(() => el.btnAutoSave.classList.remove("saved"), 600);
  }

  function applyAutoSave(on, quiet) {
    settings.autoSave = on;
    el.btnAutoSave.classList.toggle("on", on);
    el.autoLabel.textContent = on ? "Auto on" : "Auto off";
    el.btnAutoSave.title = on
      ? "Progress is saved every minute and when you leave the page"
      : "Automatic saving is off";
    if (on) {
      startAutoSave();
    } else {
      stopAutoSave();
      // Drop the stored state too, otherwise turning autosave back on would resume
      // from a moment the player has since moved past.
      dropAutoState();
    }
    if (!quiet) writeSettings();
  }

  let padObserver = null;

  function setupOnScreenControls() {
    if (!emulator) return;
    // EmulatorJS hides the on-screen pad on desktop-class devices (it keys off a
    // mobile UA check) and again while it finishes building the menu bar. This app
    // is built around touch play, so keep it shown and let the Pad on/off button
    // be the only thing that hides it.
    showPad(true);
    watchPad();
    document.body.classList.add("pad-on");
  }

  function showPad(show) {
    if (emulator && typeof emulator.toggleVirtualGamepad === "function") {
      emulator.toggleVirtualGamepad(show);
    }
  }

  // Re-assert visibility whenever EmulatorJS flips the inline style on its own.
  function watchPad() {
    const pad = document.querySelector(".ejs_virtualGamepad_parent");
    if (!pad || padObserver) return;
    padObserver = new MutationObserver(() => {
      if (settings.padHidden) return;
      if (pad.style.display === "none") pad.style.display = "";
    });
    padObserver.observe(pad, { attributes: true, attributeFilter: ["style"] });
  }

  function applyOpacity(value, quiet) {
    settings.padOpacity = value;
    const pct = Math.round(value * 100);
    document.documentElement.style.setProperty("--pad-opacity", String(value));
    el.opacity.value = String(pct);
    el.opacityOut.textContent = pct + "%";
    if (!quiet) writeSettings();
  }

  // EmulatorJS floats its control bar over the game and auto-shows it on a 3s
  // timer from start(). Both are wrong for this layout: the bar would cover the
  // touchscreen, and on a phone it would pop in and out under a moving thumb. So
  // the bar is adopted into the header, and its own show/hide state is ignored in
  // favour of a plain toggle the player controls.
  function adoptGameBar() {
    const bar = el.game && el.game.querySelector(".ejs_menu_bar");
    if (!bar || !el.gameBar) return;
    el.gameBar.appendChild(bar);
    el.btnBar.hidden = false;
  }

  function applyBarHidden(hidden, quiet) {
    settings.barHidden = hidden;
    document.body.classList.toggle("menu-off", hidden);
    el.btnBar.classList.toggle("on", !hidden);
    el.barLabel.textContent = hidden ? "Bar off" : "Bar on";
    if (!quiet) writeSettings();
  }

  function applyPadHidden(hidden, quiet) {
    settings.padHidden = hidden;
    document.body.classList.toggle("pad-off", hidden);
    el.btnPad.classList.toggle("on", !hidden);
    el.padLabel.textContent = hidden ? "Pad off" : "Pad on";

    // Keep EmulatorJS' own state in sync; its inline display beats our class rules.
    showPad(!hidden);

    el.opacityWrap.style.opacity = hidden ? ".45" : "";
    el.opacityWrap.style.pointerEvents = hidden ? "none" : "";
    if (!quiet) writeSettings();
  }

  function wireControls() {
    el.btnBar.addEventListener("click", () => applyBarHidden(!settings.barHidden));

    el.btnScheme.addEventListener("click", () => {
      setScheme(settings.scheme === "stick" ? "dpad" : "stick");
    });

    el.btnPad.addEventListener("click", () => applyPadHidden(!settings.padHidden));

    el.opacity.addEventListener("input", () => applyOpacity(Number(el.opacity.value) / 100));

    el.btnAutoSave.addEventListener("click", () => applyAutoSave(!settings.autoSave));

    // Last-chance save: pagehide fires on iOS where unload often does not, and a
    // backgrounded tab is where a mobile session usually ends.
    window.addEventListener("pagehide", () => { autoSaveNow(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) autoSaveNow(); });

    el.btnFull.addEventListener("click", () => {
      if (!emulator) return;
      if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen().catch(() => { /* already out */ });
        return;
      }
      const p = emulator.elements && emulator.elements.parent;
      const fn = fullscreenFn(p);
      if (fn) {
        // .call() is the call site that throws when the method is missing, so the
        // function must be checked before it is invoked, not caught after. The
        // prefix may also be a different one than the unprefixed exit call uses.
        try {
          Promise.resolve(fn.call(p)).catch(() => setFallbackFullscreen(true));
        } catch {
          setFallbackFullscreen(true);
        }
        lockLandscape();
        return;
      }
      // iPhone Safari has no element fullscreen at all, so hide the shell chrome
      // instead. Same visual result, and it still leaves landscape untouched.
      setFallbackFullscreen(!fallbackFullscreen);
    });

    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && screen.orientation && screen.orientation.unlock) {
        try { screen.orientation.unlock(); } catch { /* unsupported */ }
      }
    });

    el.btnExitFull.addEventListener("click", () => setFallbackFullscreen(false));

    el.btnEject.addEventListener("click", eject);
    el.btnAbout.addEventListener("click", () => openSheet("Setup & help", HELP_HTML));
    el.sheetX.addEventListener("click", closeSheet);
    // Tapping the dimmed backdrop closes the sheet, so the X is not the only way out.
    el.sheet.addEventListener("click", (e) => { if (e.target === el.sheet) closeSheet(); });
    el.loadRetry.addEventListener("click", () => { hideLoad(); pickRom(); });

    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!el.sheet.hidden) { closeSheet(); return; }
      if (fallbackFullscreen) setFallbackFullscreen(false);
    });
  }

  /* ---------------- go ---------------- */

  function init() {
    registerServiceWorker();
    defineEjsGlobals();
    wireRomInputs();
    wireBios();
    wireControls();
    wireOrientation();
    applyOpacity(settings.padOpacity, true);
    applyPadHidden(settings.padHidden, true);
    applyBarHidden(settings.barHidden, true);
    applyAutoSave(settings.autoSave, true);
    reportEnvironment();
    // Eject reloads the page; keep the picker up and stay in landscape.
    try {
      if (sessionStorage.getItem(EJECT_FLAG)) {
        sessionStorage.removeItem(EJECT_FLAG);
        lockLandscape();
      }
    } catch { /* private mode */ }

    // Show the frame's own colours in the letterbox bands rather than plain black.
    document.documentElement.style.setProperty("--frame-fill", "#0b1016");
    el.opacityOut.textContent = Math.round(settings.padOpacity * 100) + "%";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
