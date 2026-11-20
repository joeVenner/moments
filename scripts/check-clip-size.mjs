#!/usr/bin/env node
/**
 * Fails when the App Clip is over Apple's 15 MB limit for Clips opened from
 * a QR code or App Clip Code (the 100 MB limit is for digital-only
 * invocations, which can't carry the event link).
 *
 * Builds the Clip for Release (generic iOS, unsigned), strips a copy of it
 * the way an App Store build is stripped, and adds up its files' sizes.
 * App Store Connect measures the thinned, uncompressed variant per device,
 * which is about the same or smaller; an unstripped build overstates it
 * (debug symbols roughly double it).
 *
 * Usage: npm run ios:clip:size  (manual; macOS with Xcode)
 *        CLIP_SIZE_LIMIT_MB=10 npm run ios:clip:size  (a tighter budget)
 * Exit codes: 0 within the limit, 1 over it, 2 the check itself failed.
 * The scheme is the one Xcode creates for the MomentsClip target.
 */
import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MB = 1_000_000;
/** Packages are cloned once here and reused, so reruns don't fetch them again. */
const PACKAGE_CACHE = join(tmpdir(), "moments-clip-size-packages");

/** The check itself failed: exit 2, so "too big" (1) stays distinguishable. */
class CheckFailed extends Error {}

const LIMIT_MB = Number(process.env.CLIP_SIZE_LIMIT_MB ?? 15);
if (!Number.isFinite(LIMIT_MB) || LIMIT_MB <= 0) {
  console.error(`CLIP_SIZE_LIMIT_MB must be a positive number, got ${JSON.stringify(process.env.CLIP_SIZE_LIMIT_MB)}.`);
  process.exit(2);
}

/** Total bytes of every regular file under `path` (links aren't followed). */
function bytesUnder(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) return readdirSync(path).reduce((sum, name) => sum + bytesUnder(join(path, name)), 0);
  return stat.isFile() ? stat.size : 0;
}

const work = mkdtempSync(join(tmpdir(), "moments-clip-size-"));
try {
  const derivedData = join(work, "DerivedData");
  try {
    execFileSync(
      "xcodebuild",
      [
        "build",
        "-project", "ios/Moments.xcodeproj",
        "-scheme", "MomentsClip",
        "-configuration", "Release",
        "-destination", "generic/platform=iOS",
        "-derivedDataPath", derivedData,
        "-clonedSourcePackagesDirPath", PACKAGE_CACHE,
        "-skipPackagePluginValidation",
        "-quiet",
        "CODE_SIGNING_ALLOWED=NO",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  } catch {
    throw new CheckFailed("Couldn't build the App Clip (xcodebuild's errors are above).");
  }
  const built = join(derivedData, "Build/Products/Release-iphoneos/MomentsClip.app");
  const app = join(work, "MomentsClip.app");
  cpSync(built, app, { recursive: true, verbatimSymlinks: true });
  try {
    execFileSync("xcrun", ["strip", "-rSTx", join(app, "MomentsClip")]);
  } catch {
    throw new CheckFailed("Couldn't strip the App Clip's binary.");
  }

  const sizeMB = bytesUnder(app) / MB;
  const unstrippedMB = bytesUnder(built) / MB;
  console.log(`App Clip: ${sizeMB.toFixed(1)} MB stripped (${unstrippedMB.toFixed(1)} MB as built), limit ${LIMIT_MB} MB.`);
  if (sizeMB > LIMIT_MB) {
    console.error(`The App Clip is over the ${LIMIT_MB} MB limit: a QR code could no longer open it.`);
    process.exitCode = 1;
  }
} catch (error) {
  if (!(error instanceof CheckFailed)) throw error;
  console.error(error.message);
  process.exitCode = 2;
} finally {
  rmSync(work, { recursive: true, force: true });
}
