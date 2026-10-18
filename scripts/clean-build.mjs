// Trims the local build cache (src-tauri/target), which otherwise only ever grows.
//
//   npm run clean:build          what piles up: the release build, the incremental cache and
//                                every old build of this project's own crates
//   npm run clean:build -- --all the whole cache; the next build compiles everything again
//
// Cargo keeps what it built for every version and feature set it was ever asked for, and
// never removes any of it. The crates of this project are the large ones (the app's library
// is over half a gigabyte a copy) and the ones that change, so a copy is left behind by each
// version bump. Dependencies are kept: they are what takes long to compile, and they change
// rarely. Nothing here is needed to run the app; whatever is removed is rebuilt on demand.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "Cargo.toml");
const target = join(dirname(manifest), "target");
const OWN = ["mild-editor", "mild-editor-cef-helper", "mild-relay"];

const size = (path) => {
  if (!existsSync(path)) return 0;
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path).reduce((total, name) => total + size(join(path, name)), 0);
};
const gigabytes = (bytes) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

const before = size(target);
if (process.argv.includes("--all")) {
  rmSync(target, { recursive: true, force: true });
} else {
  for (const part of ["release", "tmp", join("debug", "incremental")]) rmSync(join(target, part), { recursive: true, force: true });
  if (existsSync(join(target, "debug"))) {
    execFileSync("cargo", ["clean", "--manifest-path", manifest, ...OWN.flatMap((name) => ["-p", name])], { stdio: "inherit" });
  }
}
console.log(`build cache: ${gigabytes(before)} -> ${gigabytes(size(target))}`);
