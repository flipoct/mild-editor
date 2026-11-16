import type { UiTheme } from "./types";

const themeIconCache = new Map<UiTheme, Uint8Array>();

/** The window and taskbar icon: `.welcome-mark`'s tile and serif m, in the theme's colours. */
export const createThemeWindowIcon = async (theme: UiTheme) => {
  const cached = themeIconCache.get(theme);
  if (cached) return cached;

  const mark = document.createElement("span");
  mark.className = "welcome-mark";
  mark.textContent = "m";
  mark.style.position = "fixed";
  mark.style.visibility = "hidden";
  mark.style.pointerEvents = "none";
  document.body.appendChild(mark);
  const markStyle = getComputedStyle(mark);
  const sourceSize = Number.parseFloat(markStyle.width);
  const sourceRadius = Number.parseFloat(markStyle.borderRadius);
  const sourceBorderWidth = Number.parseFloat(markStyle.borderTopWidth);
  const sourceFontSize = Number.parseFloat(markStyle.fontSize);
  const background = markStyle.backgroundColor;
  const foreground = markStyle.color;
  const font = `${markStyle.fontStyle} ${markStyle.fontWeight} ${sourceFontSize}px ${markStyle.fontFamily}`;
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
  context.strokeStyle = foreground;
  context.stroke();

  context.fillStyle = foreground;
  context.font = font.replace(`${sourceFontSize}px`, `${sourceFontSize * scale}px`);
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  const metrics = context.measureText("m");
  const baseline = size / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  context.fillText("m", size / 2, baseline);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not create the theme icon.")), "image/png");
  });
  const icon = new Uint8Array(await blob.arrayBuffer());
  themeIconCache.set(theme, icon);
  return icon;
};
