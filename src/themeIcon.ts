import { APP_MARK } from "./icons";
import type { UiTheme } from "./types";

const themeIconCache = new Map<UiTheme, Uint8Array>();

export const createThemeWindowIcon = async (theme: UiTheme) => {
  const cached = themeIconCache.get(theme);
  if (cached) return cached;

  const mark = document.createElement("span");
  mark.className = "welcome-mark";
  mark.style.position = "fixed";
  mark.style.visibility = "hidden";
  mark.style.pointerEvents = "none";
  document.body.appendChild(mark);
  const markStyle = getComputedStyle(mark);
  const sourceSize = Number.parseFloat(markStyle.width);
  const sourceRadius = Number.parseFloat(markStyle.borderRadius);
  const sourceBorderWidth = Number.parseFloat(markStyle.borderTopWidth);
  const sourcePadding = Number.parseFloat(markStyle.paddingTop);
  const background = markStyle.backgroundColor;
  const border = markStyle.borderTopColor;
  mark.remove();

  const canvas = document.createElement("canvas");
  const size = 128;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");

  const scale = size / sourceSize;
  const borderWidth = sourceBorderWidth * scale;
  const inset = borderWidth / 2;
  context.beginPath();
  context.roundRect(inset, inset, size - borderWidth, size - borderWidth, sourceRadius * scale);
  context.fillStyle = background;
  context.fill();
  context.lineWidth = borderWidth;
  context.strokeStyle = border;
  context.stroke();

  const [x, y, width] = APP_MARK.viewBox;
  const artInset = (sourceBorderWidth + sourcePadding) * scale;
  const artScale = (size - artInset * 2) / width;
  context.translate(artInset, artInset);
  context.scale(artScale, artScale);
  context.translate(-x, -y);
  for (const path of APP_MARK.fills) {
    context.fillStyle = path.fill;
    context.fill(new Path2D(path.d));
  }
  context.strokeStyle = APP_MARK.stem.stroke;
  context.lineWidth = APP_MARK.stem.width;
  context.lineCap = "round";
  context.stroke(new Path2D(APP_MARK.stem.d));
  context.fillStyle = APP_MARK.cap.fill;
  context.fill(new Path2D(APP_MARK.cap.d));

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not create the theme icon.")), "image/png");
  });
  const icon = new Uint8Array(await blob.arrayBuffer());
  themeIconCache.set(theme, icon);
  return icon;
};
