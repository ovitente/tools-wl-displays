# Dev/build environment for the Wails app.
# Enter with `nix-shell`, then `wails build` (or `wails dev`).
{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    go
    wails
    nodejs
    pkg-config
    gtk3
    webkitgtk_4_1
    lua            # for syntax-checking generated monitors.lua
  ];

  # Wails on Linux must build against the 4.1 ABI of webkit2gtk here
  # (nixpkgs 25.11 dropped 4.0). Build with: wails build -tags webkit2_41
  shellHook = ''
    export CGO_ENABLED=1
  '';
}
