# displays

GUI output manager for Hyprland (Wails: Go + WebKitGTK). Packaged as a Nix flake.

## Install & Test Policy (strict)

- **Nix flake only.** This app is installed exclusively as a Nix package on a Nix
  system: via this repo's flake (`nix build` / `nix run`) or as the `displays`
  flake input of the NixOS configuration (dotfiles `nixos/flake.nix`).
- **Testing uses the flake-built package.** Run the artifact produced by
  `nix build` / `nix run` — never test through `wails dev`, `go run`, manually
  built binaries, copied artifacts, or any other workaround.
- **No `result` symlinks.** Build with `nix build --no-link --print-out-paths`.

## Commands

- Build: `nix build --no-link --print-out-paths`
- Run (flake): `nix run /home/det/dev/displays`
- Go tests: `nix-shell --run "go test ./..."`
- Frontend build: `nix-shell --run "npm --prefix frontend run build"`
- E2E: `node tests/run.mjs` (needs frontend/dist built first)

## Notes

- Hyprland 0.55 with Lua config: live changes go through
  `hyprctl eval 'hl.monitor({...})'`, `hyprctl keyword` is rejected.
- `GDK_BACKEND=x11` is forced in `main.go` (WebKitGTK DPR bug on wlroots Wayland).
- Layout geometry is logical pixels (`pixels / scale`) — see adjacency solver
  in `frontend/src/main.js`.
