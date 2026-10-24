{ lib, stdenvNoCC, fetchurl, unzip }:
let
  version = "0.0.18";
  releases = {
    x86_64-linux = {
      platform = "linux-amd64";
      sha256 = "3c82307316acd93c88a384b62af1d81d3f4cb0efa975f9c0bfaef922866a04c4";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      sha256 = "a5f3d70efc75f5e66ab5c67c44d272aa80b2736f93f875f165140517750ec035";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      sha256 = "ba7a0994f7dd15bc8708aa1602ecf54371a492319a641ab9c33dc00f1fd56bfe";
    };
  };
  release = releases.${stdenvNoCC.hostPlatform.system};
in
stdenvNoCC.mkDerivation {
  pname = "tunnel-client";
  inherit version;
  src = fetchurl {
    url = "https://github.com/openai/tunnel-client/releases/download/v${version}/tunnel-client-v${version}-${release.platform}.zip";
    inherit (release) sha256;
  };
  nativeBuildInputs = [ unzip ];
  sourceRoot = ".";
  dontConfigure = true;
  dontBuild = true;
  # Preserve upstream binaries, including signed Darwin binaries and the bundled helper.
  dontFixup = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 tunnel-client "$out/bin/tunnel-client"
    install -Dm755 cloudflared "$out/bin/cloudflared"
    install -Dm644 cloudflared-manifest.json "$out/bin/cloudflared-manifest.json"
    mkdir -p "$out/share/doc/tunnel-client"
    cp LICENSE NOTICE *-licenses.txt *.spdx.json "$out/share/doc/tunnel-client/"
    runHook postInstall
  '';
  meta = {
    description = "OpenAI Secure MCP Tunnel client";
    homepage = "https://github.com/openai/tunnel-client";
    license = lib.licenses.asl20;
    platforms = builtins.attrNames releases;
    mainProgram = "tunnel-client";
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
