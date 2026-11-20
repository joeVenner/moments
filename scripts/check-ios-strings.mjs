#!/usr/bin/env node
/**
 * Checks that every string the iOS app (and its MomentsKit packages) shows is
 * in ios/Moments/Localizable.xcstrings. Package code looks strings up in the
 * app bundle, and Xcode doesn't add package strings to the app's catalog, so a
 * new string would otherwise silently stay English.
 *
 * Uses Xcode's own extraction (xcodebuild -exportLocalizations, which builds
 * the app), so the keys match the compiler's format keys ("%lld", "%@", ...).
 * It can't spot unused catalog entries: the export lists those too.
 *
 * The App Clip links some of the same packages (CLIP_PACKAGES), and looks
 * their strings up in its own bundle, so ios/MomentsClip/Localizable.xcstrings
 * must hold them too (plus the Clip's own, each translated to French).
 * `--sync-clip` copies the missing package strings from the app's catalog
 * into the Clip's, and drops the ones the Clip no longer uses.
 * Usage: npm run ios:strings:check [-- --sync-clip]
 *        (manual; macOS with Xcode, builds the app)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CATALOG = "ios/Moments/Localizable.xcstrings";
const CLIP_CATALOG = "ios/MomentsClip/Localizable.xcstrings";
/** FeatureGuest and everything it depends on (ios/MomentsKit/Package.swift), plus AppRouting. */
const CLIP_PACKAGES = ["AppRouting", "CredentialStore", "DesignSystem", "FeatureGuest", "MediaPipeline", "MomentsAPI", "MomentsDomain", "UploadEngine"];
const syncClip = process.argv.includes("--sync-clip");
const out = mkdtempSync(join(tmpdir(), "moments-strings-"));

function unescapeXml(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

try {
  try {
    execFileSync(
      "xcodebuild",
      ["-exportLocalizations", "-project", "ios/Moments.xcodeproj", "-localizationPath", out,
        "-exportLanguage", "fr", "-skipPackagePluginValidation"],
      { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }
    );
  } catch (error) {
    // The build log is huge: show only its end, where compile errors are.
    const log = `${error.stdout ?? ""}${error.stderr ?? ""}`.split("\n");
    console.error(log.filter((line) => /error|failed/i.test(line)).slice(-40).join("\n"));
    throw new Error("xcodebuild -exportLocalizations failed", { cause: error });
  }
  const xclocDir = join(out, "fr.xcloc", "Localized Contents");
  if (!existsSync(xclocDir)) throw new Error(`no export at ${xclocDir}; did the xcloc layout change?`);
  const xliffName = readdirSync(xclocDir).find((name) => name.endsWith(".xliff"));
  if (!xliffName) throw new Error("xcodebuild produced no XLIFF");
  const xliff = readFileSync(join(xclocDir, xliffName), "utf8");

  const used = new Set();
  const clipUsed = new Set();
  for (const file of xliff.matchAll(/<file original="([^"]*)"([\s\S]*?)<\/file>/g)) {
    if (file[1].includes("InfoPlist")) continue;
    const isClip = file[1].startsWith("MomentsClip/");
    const isClipPackage = CLIP_PACKAGES.some((name) => file[1].includes(`MomentsKit/Sources/${name}/`));
    // Plural variations come back as "key|==|plural.one"; the key is the part before.
    for (const unit of file[2].matchAll(/<trans-unit id="([^"]*)"/g)) {
      const key = unescapeXml(unit[1]).split("|==|")[0];
      if (!isClip) used.add(key);
      // The Clip's own strings belong only in its catalog (not `used`); one
      // missing there can't be copied from the app's, so it is reported.
      if (isClip || isClipPackage) clipUsed.add(key);
    }
  }
  const catalog = JSON.parse(readFileSync(CATALOG, "utf8")).strings;
  const missing = [...used].filter((key) => !(key in catalog)).sort();
  for (const key of missing) console.error(`missing: ${JSON.stringify(key)}`);
  console.log(`${used.size} strings in code, ${missing.length} missing from ${CATALOG}.`);

  const clipFile = JSON.parse(readFileSync(CLIP_CATALOG, "utf8"));
  let clipMissing = [...clipUsed].filter((key) => !(key in clipFile.strings)).sort();
  if (syncClip) {
    for (const key of clipMissing.filter((key) => key in catalog)) clipFile.strings[key] = catalog[key];
    for (const key of Object.keys(clipFile.strings)) if (!clipUsed.has(key)) delete clipFile.strings[key];
    clipFile.strings = Object.fromEntries(Object.entries(clipFile.strings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(CLIP_CATALOG, `${JSON.stringify(clipFile, null, 2)}\n`);
    clipMissing = clipMissing.filter((key) => !(key in catalog));
  }
  // Format-only keys ("%@") need no translation.
  const untranslated = Object.entries(clipFile.strings)
    .filter(([key, entry]) => /[A-Za-z]/.test(key) && !entry.localizations?.fr && entry.shouldTranslate !== false)
    .map(([key]) => key);
  for (const key of clipMissing) console.error(`missing from the Clip: ${JSON.stringify(key)}`);
  for (const key of untranslated) console.error(`no French in the Clip: ${JSON.stringify(key)}`);
  console.log(`${clipUsed.size} strings in the Clip, ${clipMissing.length} missing, ${untranslated.length} without French.`);
  process.exitCode = missing.length + clipMissing.length + untranslated.length > 0 ? 1 : 0;
} finally {
  rmSync(out, { recursive: true, force: true });
}
