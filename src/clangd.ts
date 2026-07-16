import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as Monaco from "monaco-editor";

type MonacoApi = typeof import("monaco-editor");
type JsonObject = Record<string, any>;

export type ClangdInfo = { available: boolean; path?: string; version?: string };

const fileUri = (path: string) => `file:///${path.replace(/\\/g, "/").replace(/^\//, "")}`;

export class ClangdClient {
  private monaco: MonacoApi;
  private editor: Monaco.editor.IStandaloneCodeEditor;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>();
  private unlisten?: UnlistenFn;
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
    const info = await invoke<ClangdInfo>("start_clangd", { configuredPath: configuredPath || null, workspacePath, atcoderLibraryPath });
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
    });
    await this.notify("initialized", {});
    this.ready = true;
    this.registerProviders();
    await this.setDocument(workspacePath, filename, code);
    return info;
  }

  async setDocument(workspacePath: string | null, filename: string, code: string) {
    if (!this.ready) return;
    if (this.uri) await this.notify("textDocument/didClose", { textDocument: { uri: this.uri } });
    this.uri = workspacePath ? fileUri(`${workspacePath}/${filename}`) : `file:///mild-editor/${filename}`;
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
    if (message.method === "textDocument/publishDiagnostics" && message.params?.uri === this.uri) {
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

  private request(method: string, params: JsonObject): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.send({ jsonrpc: "2.0", id, method, params }).catch(reject);
    });
  }

  private notify(method: string, params: JsonObject) { return this.send({ jsonrpc: "2.0", method, params }); }
  private send(message: JsonObject) { return invoke<void>("send_clangd_message", { message: JSON.stringify(message) }); }

  async dispose() {
    this.ready = false;
    this.modelDisposable?.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.unlisten?.();
    await invoke("stop_clangd").catch(() => {});
  }
}
