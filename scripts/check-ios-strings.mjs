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
 * Usage: npm run ios:strings:check   (manual; macOS with Xcode, builds the app)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CATALOG = "ios/Moments/Localizable.xcstrings";
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
  for (const file of xliff.matchAll(/<file original="([^"]*)"([\s\S]*?)<\/file>/g)) {
    if (file[1].includes("InfoPlist")) continue;
    // Plural variations come back as "key|==|plural.one"; the key is the part before.
    for (const unit of file[2].matchAll(/<trans-unit id="([^"]*)"/g)) used.add(unescapeXml(unit[1]).split("|==|")[0]);
  }
  const catalog = JSON.parse(readFileSync(CATALOG, "utf8")).strings;
  const missing = [...used].filter((key) => !(key in catalog)).sort();

  for (const key of missing) console.error(`missing: ${JSON.stringify(key)}`);
  console.log(`${used.size} strings in code, ${missing.length} missing from ${CATALOG}.`);
  process.exitCode = missing.length > 0 ? 1 : 0;
} finally {
  rmSync(out, { recursive: true, force: true });
}
