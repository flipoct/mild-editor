import { invoke } from "@tauri-apps/api/core";

/**
 * An icon of the user's own (Settings → Appearance): any picture, made a square PNG here and
 * kept as a data URL in the settings. The backend shows it as the window's or the Dock's icon
 * (src-tauri/src/app_icon.rs); an icon taken from an address is also what Discord shows.
 */

const SIZE = 256;

/** `blob` as a square PNG icon: the middle of the picture, scaled to fill it. */
export const imageToIcon = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.onload = () => {
    URL.revokeObjectURL(url);
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext("2d");
    if (!context || !image.naturalWidth || !image.naturalHeight) { reject(new Error("That picture cannot be read.")); return; }
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
    resolve(canvas.toDataURL("image/png"));
  };
  image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That is not a picture the editor can read.")); };
  image.src = url;
});

/** The PNG bytes of an icon kept as a data URL. */
export const iconBytes = (dataUrl: string) => {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** The picture at an https address, made an icon; the backend downloads it, since the page may not. */
export const iconFromUrl = async (url: string) => {
  const bytes = await invoke<number[]>("fetch_icon_image", { url });
  return imageToIcon(new Blob([new Uint8Array(bytes)]));
};

/** Whether `url` is an address Discord can show a picture from. */
export const isImageAddress = (url: string) => {
  try { return new URL(url).protocol === "https:"; } catch { return false; }
};
