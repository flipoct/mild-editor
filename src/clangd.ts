import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as Monaco from "monaco-editor";

type MonacoApi = typeof import("monaco-editor");
type JsonObject = Record<string, any>;

export type ClangdInfo = { available: boolean; path?: string; version?: string; generation?: number };
export type ClangdLiveStatus = "ready" | "connecting" | "error";

/**
 * A path as clangd spells it in a URI: percent-encoded UTF-8 except the characters it leaves
 * as they are (clang-tools-extra/clangd/URI.cpp, `shouldEscape`). A folder with a space or
 * Korean in its name came back from clangd encoded while the editor had sent it raw, and the
 * diagnostics for it were dropped as being about some other file.
 */
export const fileUri = (path: string) => {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const encoded = [...new TextEncoder().encode(clean)]
    .map((byte) => /[A-Za-z0-9\-_.~/:]/.test(String.fromCharCode(byte)) && byte < 0x80 ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
  return `file:///${encoded}`;
};

/** Two URIs for the same file: clangd may encode differently or change the drive letter's case. */
export const sameFileUri = (left: string, right: string) => {
  const plain = (uri: string) => {
    let path = uri;
    try { path = decodeURIComponent(uri); } catch { /* compare as given */ }
    return path.replace(/^file:\/\/\/?/i, "").replace(/^([a-z]):/i, (_, drive: string) => `${drive.toLowerCase()}:`);
  };
  return plain(left) === plain(right);
};

/** How long a request may go unanswered before the feature asking gives up on it. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Starting takes longer: clangd parses the standard library before it answers. */
const INITIALIZE_TIMEOUT_MS = 60_000;
/** A clangd that keeps dying is left down after this many restarts in `RESTART_WINDOW_MS`. */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

export class ClangdClient {
  private monaco: MonacoApi;
  private editor: Monaco.editor.IStandaloneCodeEditor;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void; timer: number }>();
  private unlisten?: UnlistenFn;
  private unlistenExit?: UnlistenFn;
  /** Which start of clangd this client talks to; an exit of an older one is not news. */
  private generation = -1;
  private disposed = false;
  private restarts: number[] = [];
  private launchArgs?: { configuredPath: string | null; workspacePath: string | null; atcoderLibraryPath: string | null };
  private document = { workspacePath: null as string | null, filename: "" };
  /** Told when clangd goes down and comes back by itself, for the status bar. */
  onStatus?: (status: ClangdLiveStatus) => void;
  private disposables: Monaco.IDisposable[] = [];
  private modelDisposable?: Monaco.IDisposable;
  private uri = "";
  private version = 1;
  private changeTimer?: number;
  private ready = false;

  constructor(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor) {
    this.monaco = monaco;
    this.editor = editor;
  }

  async start(configuredPath: string | null, workspacePath: string | null, filename: string, code: string, atcoderLibraryPath: string | null = null): Promise<ClangdInfo> {
    this.unlisten = await listen<string>("clangd-message", ({ payload }) => this.handleMessage(payload));
    this.unlistenExit = await listen<number>("clangd-exit", ({ payload }) => this.handleExit(payload));
    this.launchArgs = { configuredPath: configuredPath || null, workspacePath, atcoderLibraryPath };
    const info = await this.launch();
    this.registerProviders();
    await this.setDocument(workspacePath, filename, code);
    return info;
  }

  /** Starts clangd and introduces the editor to it; the providers and the document are the caller's. */
  private async launch(): Promise<ClangdInfo> {
    const { configuredPath, workspacePath, atcoderLibraryPath } = this.launchArgs!;
    this.ready = false;
    const info = await invoke<ClangdInfo>("start_clangd", { configuredPath, workspacePath, atcoderLibraryPath });
    this.generation = info.generation ?? -1;
    const rootUri = workspacePath ? fileUri(workspacePath) : null;
    await this.request("initialize", {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: { relatedInformation: true },
          signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } } },
        },
      },
      initializationOptions: { fallbackFlags: ["-std=gnu++20", "-xc++", ...(atcoderLibraryPath ? [`-I${atcoderLibraryPath}`] : [])] },
      workspaceFolders: rootUri ? [{ uri: rootUri, name: workspacePath?.split(/[\\/]/).at(-1) || "contest" }] : null,
    }, INITIALIZE_TIMEOUT_MS);
    await this.notify("initialized", {});
    this.ready = true;
    return info;
  }

  /**
   * clangd ended. One this client stopped or replaced is expected; any other exit (a crash on
   * an odd header, the process killed) used to leave completion waiting on answers that would
   * never come. Now what was asked is answered with an error, and clangd is started again
   * with the open document — unless it keeps dying, which a restart will not fix.
   */
  private handleExit(generation: number) {
    if (generation !== this.generation || this.disposed) return;
    this.ready = false;
    this.uri = "";
    this.rejectPending(new Error("clangd stopped"));
    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) { this.onStatus?.("error"); return; }
    this.restarts.push(now);
    this.onStatus?.("connecting");
    window.setTimeout(() => {
      if (this.disposed) return;
      void this.launch()
        .then(() => this.setDocument(this.document.workspacePath, this.document.filename, this.editor.getValue()))
        .then(() => this.onStatus?.("ready"))
        .catch(() => this.onStatus?.("error"));
    }, 1000);
  }

  private rejectPending(reason: Error) {
    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
  }

  async setDocument(workspacePath: string | null, filename: string, code: string) {
    this.document = { workspacePath, filename };
    if (!this.ready) return;
    if (this.uri) await this.notify("textDocument/didClose", { textDocument: { uri: this.uri } });
    this.uri = fileUri(workspacePath ? `${workspacePath}/${filename}` : `mild-editor/${filename}`);
    this.version = 1;
    await this.notify("textDocument/didOpen", { textDocument: { uri: this.uri, languageId: "cpp", version: this.version, text: code } });
    this.modelDisposable?.dispose();
    this.modelDisposable = this.editor.getModel()?.onDidChangeContent(() => {
      window.clearTimeout(this.changeTimer);
      this.changeTimer = window.setTimeout(() => {
        this.version += 1;
        void this.notify("textDocument/didChange", { textDocument: { uri: this.uri, version: this.version }, contentChanges: [{ text: this.editor.getValue() }] });
      }, 180);
    });
  }

  private registerProviders() {
    const position = (value: Monaco.Position) => ({ line: value.lineNumber - 1, character: value.column - 1 });
    this.disposables.push(this.monaco.languages.registerCompletionItemProvider("cpp", {
      triggerCharacters: [".", ">", ":", "<", "\"", "/"],
      provideCompletionItems: async (model, pos) => {
        const result = await this.request("textDocument/completion", { textDocument: { uri: this.uri }, position: position(pos), context: { triggerKind: 1 } }).catch(() => null);
        const items = Array.isArray(result) ? result : result?.items || [];
        const word = model.getWordUntilPosition(pos);
        const fallbackRange = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        return { suggestions: items.map((item: JsonObject) => ({
          label: typeof item.label === "string" ? item.label : item.label?.label || "",
          detail: item.detail,
          documentation: typeof item.documentation === "string" ? item.documentation : item.documentation?.value,
          kind: this.completionKind(item.kind),
          insertText: item.textEdit?.newText || item.insertText || (typeof item.label === "string" ? item.label : item.label?.label) || "",
          insertTextRules: item.insertTextFormat === 2 ? this.monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: item.textEdit?.range ? this.range(item.textEdit.range) : fallbackRange,
          sortText: item.sortText,
          filterText: item.filterText,
        })) };
      },
    }));
    this.disposables.push(this.monaco.languages.registerHoverProvider("cpp", {
      provideHover: async (_model, pos) => {
        const result = await this.request("textDocument/hover", { textDocument: { uri: this.uri }, position: position(pos) }).catch(() => null);
        if (!result?.contents) return null;
        const values = Array.isArray(result.contents) ? result.contents : [result.contents];
        return { range: result.range ? this.range(result.range) : undefined, contents: values.map((value: any) => ({ value: typeof value === "string" ? value : value.value || "" })) };
      },
    }));
    this.disposables.push(this.monaco.languages.registerSignatureHelpProvider("cpp", {
      signatureHelpTriggerCharacters: ["(", ","],
      provideSignatureHelp: async (_model, pos) => {
        const result = await this.request("textDocument/signatureHelp", { textDocument: { uri: this.uri }, position: position(pos) }).catch(() => null);
        if (!result) return null;
        return { value: result, dispose() {} };
      },
    }));
  }

  private handleMessage(raw: string) {
    let message: JsonObject;
    try { message = JSON.parse(raw); } catch { return; }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics" && this.uri && sameFileUri(String(message.params?.uri || ""), this.uri)) {
      const model = this.editor.getModel();
      if (!model) return;
      this.monaco.editor.setModelMarkers(model, "clangd", (message.params.diagnostics || []).filter((diagnostic: JsonObject) => !String(diagnostic.message || "").startsWith("In included file:")).map((diagnostic: JsonObject) => ({
        ...this.range(diagnostic.range), message: diagnostic.message, source: diagnostic.source || "clangd", code: diagnostic.code,
        severity: diagnostic.severity === 1 ? this.monaco.MarkerSeverity.Error : diagnostic.severity === 2 ? this.monaco.MarkerSeverity.Warning : this.monaco.MarkerSeverity.Info,
      })));
    }
  }

  private range(range: JsonObject) {
    return { startLineNumber: range.start.line + 1, startColumn: range.start.character + 1, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 };
  }

  private completionKind(kind?: number) {
    const kinds = this.monaco.languages.CompletionItemKind;
    return [kinds.Text, kinds.Method, kinds.Function, kinds.Constructor, kinds.Field, kinds.Variable, kinds.Class, kinds.Interface, kinds.Module, kinds.Property, kinds.Unit, kinds.Value, kinds.Enum, kinds.Keyword, kinds.Snippet, kinds.Color, kinds.File, kinds.Reference, kinds.Folder, kinds.EnumMember, kinds.Constant, kinds.Struct, kinds.Event, kinds.Operator, kinds.TypeParameter][Math.max(0, (kind || 1) - 1)] || kinds.Text;
  }

  private request(method: string, params: JsonObject, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`clangd did not answer ${method}`));
        // The request may still be running in clangd: ask it to stop wasting time on it.
        void this.notify("$/cancelRequest", { id }).catch(() => {});
      }, timeoutMs);
      const settle = <T,>(done: (value: T) => void) => (value: T) => { window.clearTimeout(timer); done(value); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), timer });
      void this.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        this.pending.delete(id);
        window.clearTimeout(timer);
        reject(error);
      });
    });
  }

  private notify(method: string, params: JsonObject) { return this.send({ jsonrpc: "2.0", method, params }); }
  private send(message: JsonObject) { return invoke<void>("send_clangd_message", { message: JSON.stringify(message) }); }

  async dispose() {
    this.ready = false;
    this.disposed = true;
    this.rejectPending(new Error("clangd stopped"));
    this.modelDisposable?.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.unlisten?.();
    this.unlistenExit?.();
    await invoke("stop_clangd").catch(() => {});
  }
}
