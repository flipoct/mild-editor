import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

// Development builds: the editor API for the debug probe (MILD_DEBUG_PROBE), which runs
// outside the bundle and cannot import the prebundled instance itself.
if (import.meta.env.DEV) (window as unknown as { __monaco?: typeof monaco }).__monaco = monaco;
