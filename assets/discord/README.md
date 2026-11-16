Images for Discord's activity status (`src/discord.ts`). Discord fetches them from this
repository by URL, pinned to the commit that added them, so changing one means adding a new
file and pointing the code at the new commit.

- `mild.png`: the chili icon of 1.14–1.20, no longer used. The status now shows the serif m
  straight from `src-tauri/icons/128x128@2x.png` at commit `f52ddbc`, where it is the bundled icon.
- `cpp.png`, `python.png`: the language marks of `src/icons.tsx` on a round white badge.
