import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./platform";
import { createStore } from "./store";

/**
 * The Pythons and C++ compilers this computer has (src-tauri/src/toolchains.rs), for Settings →
 * Languages and the run bar's quick switch. Looked for once when first asked, and again on
 * request: each look starts every interpreter and compiler found.
 */
export type Toolchain = { path: string; version: string; origin: string; managed: boolean; gcc: boolean; isDefault: boolean };

export type PythonDownload = { version: string; name: string; url: string; size: number };

type State = { pythons: Toolchain[] | null; compilers: Toolchain[] | null; scanning: boolean };

export const toolchains = createStore<State>({ pythons: null, compilers: null, scanning: false });

let scan: Promise<void> | null = null;

/** Looks for every interpreter and compiler again. */
export const rescanToolchains = () => {
  if (!IS_TAURI) return Promise.resolve();
  scan ??= (async () => {
    toolchains.set({ scanning: true });
    try {
      const [pythons, compilers] = await Promise.all([invoke<Toolchain[]>("list_pythons"), invoke<Toolchain[]>("list_compilers")]);
      toolchains.set({ pythons, compilers });
    } finally {
      toolchains.set({ scanning: false });
      scan = null;
    }
  })();
  return scan;
};

/** Looks once, the first time anything wants the lists. */
export const ensureToolchains = () => {
  if (toolchains.get().pythons === null && !scan) void rescanToolchains().catch(() => undefined);
};

/** `3.12.7` → `3.12`, for a label with no room for the patch. */
export const minorVersion = (version: string) => version.split(".").slice(0, 2).join(".");

/** What a toolchain is called in a list: its version, and where it came from when that tells two apart. */
export const toolchainLabel = (toolchain: Toolchain, others: Toolchain[]) => {
  const twin = others.some((other) => other !== toolchain && other.version === toolchain.version);
  return twin || toolchain.origin !== "system" ? `${toolchain.version} · ${toolchain.origin}` : toolchain.version;
};

/** The chosen one in `list`, the default when nothing is chosen, or undefined while the list is unknown or the choice is gone. */
export const chosenToolchain = (list: Toolchain[] | null, chosen: string) =>
  list?.find((toolchain) => chosen ? toolchain.path === chosen : toolchain.isDefault);
