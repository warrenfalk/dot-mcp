{
  lib,
  stdenvNoCC,
  nodejs_24,
  pnpm,
  pnpmConfigHook,
  fetchPnpmDeps,
  makeWrapper,
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "dot-mcp";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../test
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../tsconfig.json
    ];
  };
  nativeBuildInputs = [
    nodejs_24
    pnpm
    pnpmConfigHook
    makeWrapper
  ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 4;
    hash = "sha256-Kz+OA8No+CfHCPMMfMEjO3iWEVwDI2ACig9e4vtfs94=";
  };
  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test dist/test/*.test.js
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    # A fresh frozen install avoids prune resolving optional compiler packages.
    rm -rf node_modules
    pnpm install --prod --offline --ignore-scripts --frozen-lockfile
    mkdir -p "$out/lib/dot-mcp" "$out/bin"
    cp -r dist node_modules package.json "$out/lib/dot-mcp/"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dot-mcp" \
      --add-flags "$out/lib/dot-mcp/dist/src/index.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dot-mcp-doctor" \
      --add-flags "$out/lib/dot-mcp/dist/src/doctor.js"
    runHook postInstall
  '';
  meta = {
    description = "MCP adapter for external Codex thread control";
    mainProgram = "dot-mcp";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
  };
})
