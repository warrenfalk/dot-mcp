{
  description = "Dot MCP bridge for the local Codex app-server";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in { tunnel-client = pkgs.callPackage ./nix/tunnel-client.nix { }; });
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in { default = pkgs.mkShell {
          packages = [ pkgs.nodejs_24 pkgs.pnpm self.packages.${system}.tunnel-client ];
        }; });
    };
}
