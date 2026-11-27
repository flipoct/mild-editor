import katexCss from "katex/dist/katex.min.css?inline";
import type { BoardCanvas } from "./canvas";
import { boundsOf } from "./model";
import { canvasShade, drawElement, TEXT_CSS } from "./render";

/**
 * A board as a PNG: what is selected, or everything. Pen lines, shapes and pictures are drawn
 * on a canvas as on screen; writing is its own HTML wrapped in an SVG `foreignObject` and drawn
 * over them, with KaTeX's fonts carried inside so the formulas come out as they look.
 */

let fontedKatex: Promise<string> | null = null;

const toBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
};

/** KaTeX's style with every font in it as a `data:` URL: a picture cannot load anything. */
const katexWithFonts = () => fontedKatex ??= (async () => {
  const urls = [...new Set([...katexCss.matchAll(/url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/g)].map((match) => match[1]))];
  const data = new Map<string, string>();
  await Promise.all(urls.map(async (url) => {
    if (url.startsWith("data:")) return;
    const response = await fetch(url);
    if (response.ok) data.set(url, `data:font/woff2;base64,${toBase64(await response.arrayBuffer())}`);
  }));
  // Only the woff2 of each face: the others would be fetched as well.
  return katexCss
    .replace(/src:\s*url\(\s*["']?([^"')]+\.woff2)["']?\s*\)\s*format\(["']?woff2["']?\)[^;}]*/g, (whole, url: string) => data.has(url) ? `src:url(${data.get(url)}) format("woff2")` : whole);
})();

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export const boardPicture = async (board: BoardCanvas, { scale = 2, pad = 24 } = {}): Promise<Blob> => {
  board.commitEdit();
  board.renderer.flush();
  const elements = board.selection.size ? board.selected() : [...board.elements()];
  const bounds = boundsOf(elements);
  if (!bounds) throw new Error("empty");
  const dark = board.dark();
  const width = Math.ceil(bounds.w + pad * 2);
  const height = Math.ceil(bounds.h + pad * 2);
  scale = Math.min(scale, 8192 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = canvasShade(dark);
  context.fillRect(0, 0, canvas.width, canvas.height);
  await board.renderer.images.ready(elements.flatMap((element) => element.type === "image" ? [element.asset] : []));
  context.setTransform(scale, 0, 0, scale, (pad - bounds.x) * scale, (pad - bounds.y) * scale);
  for (const element of elements) drawElement(context, element, dark, board.renderer.images);

  const texts = elements.filter((element) => element.type === "text" && board.renderer.textNode(element.id));
  if (texts.length) {
    const serializer = new XMLSerializer();
    const html = texts.map((element) => {
      const node = board.renderer.textNode(element.id)!.cloneNode(true) as HTMLElement;
      node.style.left = `${element.x - bounds.x + pad}px`;
      node.style.top = `${element.y - bounds.y + pad}px`;
      node.style.visibility = "";
      node.classList.remove("erasing");
      return serializer.serializeToString(node);
    }).join("");
    const css = TEXT_CSS + (html.includes("katex") ? await katexWithFonts() : "");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${width} ${height}">`
      + `<foreignObject x="0" y="0" width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px">`
      + `<style>${escapeXml(css)}</style>${html}</div></foreignObject></svg>`;
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  return new Promise<Blob>((resolve, reject) => {
    try { canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("png")), "image/png"); } catch (error) { reject(error); }
  });
};
