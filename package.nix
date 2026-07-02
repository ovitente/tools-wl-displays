{ lib
, buildGoModule
, buildNpmPackage
, pkg-config
, wrapGAppsHook3
, gtk3
, webkitgtk_4_1
}:

let
  version = "0.1.0";

  # Stage 1: build the Vite frontend into a static bundle. buildGoModule can't
  # run `npm install` (no network in the sandbox), so the frontend is a separate
  # fixed-output-deps derivation and its result is embedded in stage 2.
  frontend = buildNpmPackage {
    pname = "displays-frontend";
    inherit version;
    src = ./frontend;

    # Hash of the npm dependency closure derived from frontend/package-lock.json.
    npmDepsHash = "sha256-IjRHQIWV8ZwzwrVbPa4YGBOh2H7SP1s3v4weg45MziA=";

    # `npm run build` == `vite build` (see frontend/package.json), output -> dist/.
    installPhase = ''
      runHook preInstall
      cp -r dist $out
      runHook postInstall
    '';
  };
in
buildGoModule {
  pname = "displays";
  inherit version;
  src = ./.;

  # Hash of the vendored Go module closure (go.mod/go.sum).
  vendorHash = "sha256-SsH+FqUKzk/ktC1izlYBojhMOZ1o4SeGz80GqdSU9Bc=";

  # Only the root main package; tests and helpers stay out of the build.
  subPackages = [ "." ];

  # Wails' Linux webview is a cgo binding to gtk3/webkit2gtk — cgo must be on,
  # or the go build silently falls back to a non-GUI stub.
  env.CGO_ENABLED = "1";

  # Tags `wails build` injects, without which the GTK/WebKit backend is
  # compiled out and the binary is a headless stub:
  #   desktop     — native window frontend (not the dev/browser server)
  #   production  — disable the dev asset server
  #   webkit2_41  — link webkit2gtk ABI 4.1 (nixpkgs ships 4.1, not 4.0)
  tags = [ "desktop" "production" "webkit2_41" ];

  # pkg-config lets cgo find gtk3/webkit; wrapGAppsHook3 injects the GTK/GI
  # runtime env (GSettings schemas, typelibs) into the final binary.
  nativeBuildInputs = [ pkg-config wrapGAppsHook3 ];
  buildInputs = [ gtk3 webkitgtk_4_1 ];

  # `//go:embed all:frontend/dist` (main.go) needs the built bundle present
  # before `go build`. The flake source is git-tracked only, so dist is absent
  # here — drop in the stage-1 output.
  preBuild = ''
    rm -rf frontend/dist
    cp -r ${frontend} frontend/dist
    chmod -R u+w frontend/dist
  '';

  meta = {
    description = "GUI output manager for Hyprland (Wails)";
    homepage = "https://github.com/ovitente/tools-wl-displays";
    mainProgram = "displays";
    platforms = lib.platforms.linux;
  };
}
