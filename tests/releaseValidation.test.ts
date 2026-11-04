import test from "node:test";
import assert from "node:assert/strict";
import {
  validateReleaseAssets,
  reconcileManifest,
  validateManifest,
  REQUIRED_PLATFORMS,
} from "../scripts/validate-release.js";

const sampleValidAssets = [
  { name: "Lyra_2.0.29_amd64.AppImage", size: 92924408, url: "https://github.com/gixi404/lyra/releases/download/v2.0.29/Lyra_2.0.29_amd64.AppImage" },
  { name: "Lyra_2.0.29_amd64.AppImage.sig", size: 416, url: "https://github.com/gixi404/lyra/releases/download/v2.0.29/Lyra_2.0.29_amd64.AppImage.sig" },
  { name: "Lyra_2.0.29_amd64.deb", size: 12845446, url: "https://github.com/gixi404/lyra/releases/download/v2.0.29/Lyra_2.0.29_amd64.deb" },
  { name: "Lyra_2.0.29_amd64.deb.sig", size: 408, url: "https://github.com/gixi404/lyra/releases/download/v2.0.29/Lyra_2.0.29_amd64.deb.sig" },
  { name: "Lyra-2.0.29-1.x86_64.rpm", size: 12847344, url: "https://github.com/gixi404/lyra/releases/download/v2.0.29/Lyra-2.0.29-1.x86_64.rpm" },
  { name: "Lyra-2.0.29-1.x86_64.rpm.sig", size: 412, url: "https://github.com/gixi404/lyra/releases/download/v2.0.29/Lyra-2.0.29-1.x86_64.rpm.sig" },
  { name: "Lyra_2.0.29_x64_es-ES.msi", size: 12754944, url: "https://github.com/gixi404/lyra/releases/download/v2.0.29/Lyra_2.0.29_x64_es-ES.msi" },
  { name: "Lyra_2.0.29_x64_es-ES.msi.sig", size: 416, url: "https://github.com/gixi404/lyra/releases/download/v2.0.29/Lyra_2.0.29_x64_es-ES.msi.sig" },
  { name: "Lyra_2.0.29_x64-setup.exe", size: 11305680, url: "https://github.com/gixi404/lyra/releases/download/v2.0.29/Lyra_2.0.29_x64-setup.exe" },
  { name: "Lyra_2.0.29_x64-setup.exe.sig", size: 416, url: "https://github.com/gixi404/lyra/releases/download/v2.0.29/Lyra_2.0.29_x64-setup.exe.sig" },
];

const mockSignatures: Record<string, string> = {
  "Lyra_2.0.29_amd64.AppImage.sig": "untrusted comment: signature from tauri secret key\nRURi...AppImageSig",
  "Lyra_2.0.29_amd64.deb.sig": "untrusted comment: signature from tauri secret key\nRURi...DebSig",
  "Lyra-2.0.29-1.x86_64.rpm.sig": "untrusted comment: signature from tauri secret key\nRURi...RpmSig",
  "Lyra_2.0.29_x64_es-ES.msi.sig": "untrusted comment: signature from tauri secret key\nRURi...MsiSig",
  "Lyra_2.0.29_x64-setup.exe.sig": "untrusted comment: signature from tauri secret key\nRURi...ExeSig",
};

const getSigMock = (sigName: string) => mockSignatures[sigName] || "untrusted comment: defaultSig";

test("validateReleaseAssets: succeeds when all 5 packages and .sig exist with positive size", () => {
  const map = validateReleaseAssets(sampleValidAssets) as Record<string, unknown>;
  assert.ok(map["AppImage"]);
  assert.ok(map["DEB"]);
  assert.ok(map["RPM"]);
  assert.ok(map["MSI"]);
  assert.ok(map["NSIS"]);
});

test("validateReleaseAssets: throws if a binary package is missing", () => {
  const incomplete = sampleValidAssets.filter((a) => !a.name.endsWith(".rpm"));
  assert.throws(() => validateReleaseAssets(incomplete), /RPM.*ausente/);
});

test("validateReleaseAssets: throws if an asset is 0 bytes (corrupt upload)", () => {
  const corrupted = sampleValidAssets.map((a) =>
    a.name.endsWith(".msi") ? { ...a, size: 0 } : a
  );
  assert.throws(() => validateReleaseAssets(corrupted), /MSI vacío/);
});

test("reconcileManifest: generates complete manifest when latest.json is initially missing", () => {
  const assetMap = validateReleaseAssets(sampleValidAssets);
  const { manifest, wasModified } = reconcileManifest(
    null,
    "2.0.29",
    "Release notes",
    assetMap,
    getSigMock
  );

  assert.equal(wasModified, true);
  assert.equal(manifest.version, "2.0.29");
  for (const platform of REQUIRED_PLATFORMS) {
    assert.ok(manifest.platforms[platform], `Missing platform ${platform}`);
    assert.ok(manifest.platforms[platform].signature.startsWith("untrusted comment:"));
    assert.ok(manifest.platforms[platform].url.startsWith("https://github.com/gixi404/lyra/releases/download/"));
  }
});

test("reconcileManifest: heals dropped platforms when concurrent runner overwrites latest.json", () => {
  const assetMap = validateReleaseAssets(sampleValidAssets);
  // Simula que el runner de Windows sobrescribió latest.json dejando solo plataformas Windows
  const windowsOnlyManifest = {
    version: "2.0.29",
    notes: "Windows build",
    pub_date: "2026-11-03T00:00:00Z",
    platforms: {
      "windows-x86_64": { signature: mockSignatures["Lyra_2.0.29_x64_es-ES.msi.sig"], url: sampleValidAssets[6].url },
      "windows-x86_64-msi": { signature: mockSignatures["Lyra_2.0.29_x64_es-ES.msi.sig"], url: sampleValidAssets[6].url },
      "windows-x86_64-nsis": { signature: mockSignatures["Lyra_2.0.29_x64-setup.exe.sig"], url: sampleValidAssets[8].url },
    },
  };

  const { manifest, wasModified } = reconcileManifest(
    windowsOnlyManifest,
    "2.0.29",
    "Release notes",
    assetMap,
    getSigMock
  );

  assert.equal(wasModified, true);
  // Todas las plataformas Linux fueron recuperadas de los artefactos
  assert.ok(manifest.platforms["linux-x86_64"]);
  assert.ok(manifest.platforms["linux-x86_64-appimage"]);
  assert.ok(manifest.platforms["linux-x86_64-deb"]);
  assert.ok(manifest.platforms["linux-x86_64-rpm"]);
  assert.equal(manifest.platforms["linux-x86_64-rpm"].signature, mockSignatures["Lyra-2.0.29-1.x86_64.rpm.sig"]);
});

test("reconcileManifest: does not modify manifest when all platforms and signatures match", () => {
  const assetMap = validateReleaseAssets(sampleValidAssets);
  const { manifest: fullManifest } = reconcileManifest(null, "2.0.29", "Notes", assetMap, getSigMock);

  const result = reconcileManifest(fullManifest, "2.0.29", "Notes", assetMap, getSigMock);
  assert.equal(result.wasModified, false);
});

test("validateManifest: validates a 100% correct manifest and rejects invalid ones", () => {
  const assetMap = validateReleaseAssets(sampleValidAssets);
  const { manifest } = reconcileManifest(null, "2.0.29", "Notes", assetMap, getSigMock);

  // Correct manifest passes
  assert.ok(validateManifest(manifest, "2.0.29", assetMap));

  // Version mismatch fails
  assert.throws(() => validateManifest(manifest, "2.0.30", assetMap), /no coincide con la versión esperada/);

  // Missing platform fails
  const missingDeb = JSON.parse(JSON.stringify(manifest));
  delete missingDeb.platforms["linux-x86_64-deb"];
  assert.throws(() => validateManifest(missingDeb, "2.0.29", assetMap), /linux-x86_64-deb' no está presente/);

  // Invalid URL host/scheme fails
  const badUrl = JSON.parse(JSON.stringify(manifest));
  badUrl.platforms["linux-x86_64"].url = "http://malicious.com/appimage";
  assert.throws(() => validateManifest(badUrl, "2.0.29", assetMap), /URL no autorizada/);

  // Corrupted / empty signature fails
  const badSig = JSON.parse(JSON.stringify(manifest));
  badSig.platforms["linux-x86_64-rpm"].signature = "";
  assert.throws(() => validateManifest(badSig, "2.0.29", assetMap), /Firma ausente o vacía/);
});
