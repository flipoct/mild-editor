import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Translate } from "./i18n";
import { errorMessage, IS_TAURI } from "./platform";
import { useSetting } from "./settingsStore";
import type { BackgroundImageFile } from "./types";

/**
 * The wallpaper as something a page can paint: the stored preference is a path, which the
 * backend reads into an object URL. The browser preview has no path to read, so there the
 * picked file itself becomes the URL and only its name is kept.
 */
export function useBackgroundImage(t: Translate) {
  const [path, setPath] = useSetting("backgroundImagePath");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  /** The hidden file input the preview picks through; whoever shows the picker renders it. */
  const inputRef = useRef<HTMLInputElement | null>(null);
  const browserUrlRef = useRef("");

  useEffect(() => {
    setError("");
    if (!path) {
      setUrl("");
      return;
    }
    if (!IS_TAURI) return;
    let cancelled = false;
    let objectUrl = "";
    void invoke<BackgroundImageFile>("read_image_file", { request: { path } })
      .then((image) => {
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(image.bytes)], { type: image.mime }));
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setUrl(objectUrl);
      })
      .catch((error) => {
        if (!cancelled) {
          setUrl("");
          setError(errorMessage(error));
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  useEffect(() => () => {
    if (browserUrlRef.current) URL.revokeObjectURL(browserUrlRef.current);
  }, []);

  const choose = async () => {
    if (!IS_TAURI) {
      inputRef.current?.click();
      return;
    }
    try {
      const picked = await open({ multiple: false, directory: false, title: t("chooseBackground"), filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }] });
      if (!picked || Array.isArray(picked)) return;
      setPath(picked);
    } catch (error) {
      setError(errorMessage(error));
    }
  };

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) {
      setError("Background images must be 40 MB or smaller.");
      return;
    }
    if (browserUrlRef.current) URL.revokeObjectURL(browserUrlRef.current);
    const objectUrl = URL.createObjectURL(file);
    browserUrlRef.current = objectUrl;
    setError("");
    setPath(file.name);
    setUrl(objectUrl);
  };

  const clear = () => {
    if (browserUrlRef.current) {
      URL.revokeObjectURL(browserUrlRef.current);
      browserUrlRef.current = "";
    }
    setUrl("");
    setPath("");
    setError("");
  };

  return { path, url, error, inputRef, choose, chooseFile, clear };
}

export type BackgroundImage = ReturnType<typeof useBackgroundImage>;
