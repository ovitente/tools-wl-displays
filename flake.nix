{
  description = "displays — GUI output manager for Hyprland (Wails)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        displays = pkgs.callPackage ./package.nix { };
        default = self.packages.${pkgs.system}.displays;
      });

      # Reuse the existing dev/build environment (nix-shell + wails build).
      devShells = forAllSystems (pkgs: {
        default = import ./shell.nix { inherit pkgs; };
      });
    };
}
