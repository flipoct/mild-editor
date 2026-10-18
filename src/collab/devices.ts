import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { IS_TAURI } from "../platform";
import { collab, joinRoom } from "./collabStore";
import { formatInvite, shortAddress } from "./protocol";

/**
 * Development only: another copy of the app on this computer that behaves as a device of its
 * own — its own workspace, settings and storage (src-tauri/src/devices.rs) — so a shared room
 * can be tried alone. A device started from an open room joins it by itself, the way a
 * teammate would with the invitation.
 */
export const DEVICES = import.meta.env.DEV && IS_TAURI;

export type Device = { number: number; invite: string | null };

/** What this copy is: null for the first one (and outside development builds). */
const device: Promise<Device | null> = DEVICES ? invoke<Device | null>("dev_device").catch(() => null) : Promise.resolve(null);

export const useDevice = () => {
  const [value, setValue] = useState<Device | null>(null);
  useEffect(() => { void device.then(setValue); }, []);
  return value;
};

/**
 * Starts another device. With a room open here it joins that room — through the loopback
 * address, which reaches a relay on this computer whatever the network.
 */
export const openDevice = () => {
  const room = collab.get();
  const invite = room.phase === "live" && room.address ? formatInvite([shortAddress(room.address)], room.code.replace(/-/g, "")) : null;
  return invoke<number>("dev_open_device", { invite });
};

// A device started to join a room does so once its workspace is open.
void device.then(async (self) => {
  if (!self?.invite) return;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    if (collab.get().phase !== "idle") return;
    // `joinRoom` says when there is no workspace yet; it is then simply tried again.
    await joinRoom({ invite: self.invite, name: `Device ${self.number}`, parent: "" });
    const state = collab.get();
    if (state.phase !== "idle" || state.error?.message !== "collabErrNoWorkspace") return;
    collab.set({ error: null });
  }
});
