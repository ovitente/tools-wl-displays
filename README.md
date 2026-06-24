# displays

GUI output manager for Hyprland — enable/disable, arrange (drag + edge-snap),
and set resolution / refresh rate / scale per monitor. A Wails (Go + system
WebKit) app: lightweight native binary, the UI is plain HTML/CSS/JS.

## How it works

- **Read** — `hyprctl monitors all -j` (includes disabled outputs).
- **Apply (live)** — for each output `hyprctl keyword monitor "NAME,WxH@Hz,XxY,scale"`
  (or `NAME,disable`). Takes effect instantly, no reload.
- **Persist** — rewrites `~/.config/hypr/monitors.lua`, which `hyprland.lua`
  sources via `dofile()`, so the layout survives reload/reboot.

The frontend re-reads state after Apply, so any value Hyprland adjusts
(e.g. an invalid scale snapped to a valid one) is reflected back.

## Build

Requires the toolchain from `shell.nix` (Go, Wails, WebKitGTK 4.1, Node, GTK3).

```sh
nix-shell
wails build -tags webkit2_41    # nixpkgs ships webkit2gtk abi 4.1
```

Binary: `build/bin/displays`.

## Dev

```sh
nix-shell --run "wails dev -tags webkit2_41"
```

## Launch

Bound to `SUPER+SHIFT+D` in the Hyprland config. `Esc` closes the window.
The window is frameless; drag it by the title bar.

## Notes / gotchas

- **XWayland is forced** (`GDK_BACKEND=x11`, set in `main.go`). Under the native
  Wayland backend, WebKitGTK on wlroots reports `devicePixelRatio = 1/96`, which
  shrinks the entire UI ~96×. XWayland reports the correct DPR.
- **Lua Hyprland (0.55):** `hyprctl keyword` is rejected ("can't work with
  non-legacy parsers"). Live changes use `hyprctl eval 'hl.monitor({...})'`.

## Tests

- `node tests/run.mjs` — headless e2e (puppeteer + system Chrome): stubs the Go
  backend, drives the real UI (toggle, mode change, Apply payload), screenshots
  each step to `tests/screenshots/`, checks for console/asset errors.
- `go test ./...` — backend: availableModes parsing, scale formatting, and a live
  `GetMonitors` against the running Hyprland (skipped without a session).
- `visual.sh` (lives in dotfiles: `.config/hypr/scripts/visual.sh`) — launches the
  built binary in the live Hyprland session and captures the actual WebKit render
  with grim. Run: `visual.sh -o /tmp/shot.png`. This catches WebKit-only bugs the
  headless tests can't (e.g. the devicePixelRatio issue above).
