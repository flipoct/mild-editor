import type { BeforeMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import type { CodeSnippet } from "./types";

let completionsRegistered = false;
let snippetCompletionSource: CodeSnippet[] = [];
/** The user's snippets, offered as `snippet::name` completions next to the built-in ones. */
export const setSnippetCompletions = (snippets: CodeSnippet[]) => { snippetCompletionSource = snippets; };

/** Defines the editor themes that go with each interface theme, and registers the completions once. */
export const setupMonaco: BeforeMount = (monaco) => {
  const monacoChrome = (panel: string, field: string, border: string, selected: string, accent: string) => ({
    "focusBorder": accent,
    "editorWidget.background": panel,
    "editorWidget.border": border,
    "editorHoverWidget.background": panel,
    "editorHoverWidget.border": border,
    "editorSuggestWidget.background": panel,
    "editorSuggestWidget.border": border,
    "editorSuggestWidget.selectedBackground": selected,
    "editorSuggestWidget.highlightForeground": accent,
    "input.background": field,
    "input.border": border,
    "list.hoverBackground": selected,
    "list.activeSelectionBackground": selected,
    "list.highlightForeground": accent,
    "scrollbarSlider.background": `${border}88`,
    "scrollbarSlider.hoverBackground": border,
  });
  monaco.editor.defineTheme("mild-pastel", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8f9b82", fontStyle: "italic" },
      { token: "keyword", foreground: "d7a8c4" },
      { token: "string", foreground: "d8c692" },
      { token: "number", foreground: "b6c9a8" },
      { token: "type", foreground: "a9c7cf" },
    ],
    colors: {
      ...monacoChrome("#292a26", "#232420", "#41423c", "#30312d", "#dec58e"),
      "editor.background": "#2b2c28",
      "editor.foreground": "#dedbd2",
      "editorLineNumber.foreground": "#666861",
      "editorLineNumber.activeForeground": "#c8c4b8",
      "editorCursor.foreground": "#e6c98f",
      "editor.selectionBackground": "#59665f88",
      "editor.lineHighlightBackground": "#31322e",
      "editorIndentGuide.background1": "#3c3d38",
      "editorIndentGuide.activeBackground1": "#62645c",
    },
  });
  monaco.editor.defineTheme("mild-midnight", {
    base: "vs-dark",
    inherit: true,
    rules: [{ token: "comment", foreground: "6c7086", fontStyle: "italic" }, { token: "keyword", foreground: "cba6f7" }, { token: "string", foreground: "a6e3a1" }, { token: "number", foreground: "fab387" }, { token: "type", foreground: "89dceb" }],
    colors: { ...monacoChrome("#181825", "#11111b", "#45475a", "#313244", "#cba6f7"), "editor.background": "#1e1e2e", "editor.foreground": "#cdd6f4", "editorLineNumber.foreground": "#585b70", "editorLineNumber.activeForeground": "#bac2de", "editorCursor.foreground": "#f5e0dc", "editor.selectionBackground": "#585b7088", "editor.lineHighlightBackground": "#252536", "editorIndentGuide.background1": "#313244", "editorIndentGuide.activeBackground1": "#585b70" },
  });
  monaco.editor.defineTheme("mild-latte", {
    base: "vs",
    inherit: true,
    rules: [{ token: "comment", foreground: "9893a5", fontStyle: "italic" }, { token: "keyword", foreground: "907aa9" }, { token: "string", foreground: "286983" }, { token: "number", foreground: "d7827e" }, { token: "type", foreground: "56949f" }],
    colors: { ...monacoChrome("#fffaf3", "#faf4ed", "#dfdad9", "#f2e9e1", "#907aa9"), "editor.background": "#faf4ed", "editor.foreground": "#575279", "editorLineNumber.foreground": "#9893a5", "editorLineNumber.activeForeground": "#575279", "editorCursor.foreground": "#b4637a", "editor.selectionBackground": "#dfdad9aa", "editor.lineHighlightBackground": "#f2e9e1", "editorIndentGuide.background1": "#dfdad9", "editorIndentGuide.activeBackground1": "#cecacd" },
  });
  monaco.editor.defineTheme("mild-sakura", {
    base: "vs-dark", inherit: true,
    rules: [{ token: "comment", foreground: "6272a4", fontStyle: "italic" }, { token: "keyword", foreground: "ff79c6" }, { token: "string", foreground: "f1fa8c" }, { token: "number", foreground: "bd93f9" }, { token: "type", foreground: "8be9fd", fontStyle: "italic" }, { token: "identifier.function", foreground: "50fa7b" }, { token: "predefined", foreground: "8be9fd" }],
    colors: { ...monacoChrome("#21222c", "#191a21", "#44475a", "#343746", "#bd93f9"), "editor.background": "#282a36", "editor.foreground": "#f8f8f2", "editorLineNumber.foreground": "#6272a4", "editorLineNumber.activeForeground": "#f8f8f2", "editorCursor.foreground": "#f8f8f0", "editor.selectionBackground": "#44475a", "editor.lineHighlightBackground": "#2f3240", "editorIndentGuide.background1": "#3b3e4d", "editorIndentGuide.activeBackground1": "#6272a4", "editorBracketMatch.background": "#bd93f922", "editorBracketMatch.border": "#bd93f9" },
  });
  monaco.editor.defineTheme("mild-blossom", {
    base: "vs-dark", inherit: true,
    rules: [{ token: "comment", foreground: "928374", fontStyle: "italic" }, { token: "keyword", foreground: "fb4934" }, { token: "string", foreground: "b8bb26" }, { token: "number", foreground: "d3869b" }, { token: "type", foreground: "fabd2f" }, { token: "identifier.function", foreground: "b8bb26" }, { token: "predefined", foreground: "8ec07c" }],
    colors: { ...monacoChrome("#32302f", "#242321", "#504945", "#3c3836", "#fabd2f"), "editor.background": "#282828", "editor.foreground": "#ebdbb2", "editorLineNumber.foreground": "#665c54", "editorLineNumber.activeForeground": "#ebdbb2", "editorCursor.foreground": "#fabd2f", "editor.selectionBackground": "#665c54", "editor.lineHighlightBackground": "#32302f", "editorIndentGuide.background1": "#3c3836", "editorIndentGuide.activeBackground1": "#7c6f64", "editorBracketMatch.background": "#fabd2f22", "editorBracketMatch.border": "#fabd2f" },
  });
  monaco.editor.defineTheme("mild-nord", {
    base: "vs-dark", inherit: true,
    rules: [{ token: "comment", foreground: "616e88", fontStyle: "italic" }, { token: "keyword", foreground: "b48ead" }, { token: "string", foreground: "a3be8c" }, { token: "number", foreground: "d08770" }, { token: "type", foreground: "88c0d0" }],
    colors: { ...monacoChrome("#343b49", "#292e38", "#4c566a", "#3b4252", "#88c0d0"), "editor.background": "#2e3440", "editor.foreground": "#d8dee9", "editorLineNumber.foreground": "#4c566a", "editorLineNumber.activeForeground": "#d8dee9", "editorCursor.foreground": "#88c0d0", "editor.selectionBackground": "#434c5eaa", "editor.lineHighlightBackground": "#343b49", "editorIndentGuide.background1": "#3b4252", "editorIndentGuide.activeBackground1": "#616e88" },
  });
  monaco.editor.defineTheme("mild-tokyo", {
    base: "vs-dark", inherit: true,
    rules: [{ token: "comment", foreground: "565f89", fontStyle: "italic" }, { token: "keyword", foreground: "bb9af7" }, { token: "string", foreground: "9ece6a" }, { token: "number", foreground: "ff9e64" }, { token: "type", foreground: "7dcfff" }],
    colors: { ...monacoChrome("#202230", "#161720", "#3b4261", "#292e42", "#7aa2f7"), "editor.background": "#1a1b26", "editor.foreground": "#c0caf5", "editorLineNumber.foreground": "#3b4261", "editorLineNumber.activeForeground": "#a9b1d6", "editorCursor.foreground": "#7aa2f7", "editor.selectionBackground": "#33467c88", "editor.lineHighlightBackground": "#202230", "editorIndentGuide.background1": "#292e42", "editorIndentGuide.activeBackground1": "#515c7e" },
  });
  if (!completionsRegistered) {
    completionsRegistered = true;
    const register = (languageId: string, entries: Array<[string, string, string?]>) => monaco.languages.registerCompletionItemProvider(languageId, {
      provideCompletionItems(model: Monaco.editor.ITextModel, position: Monaco.Position) {
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const snippetPrefix = /snippet::[\w-]*$/.exec(linePrefix)?.[0];
        const snippetRange = snippetPrefix
          ? { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: position.column - snippetPrefix.length, endColumn: position.column }
          : range;
        const language = languageId === "cpp" ? "cpp" : "python";
        const builtIns = entries.map(([label, insertText, detail]) => ({ label, insertText, detail, range, kind: monaco.languages.CompletionItemKind.Snippet, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }));
        const snippets = snippetCompletionSource
          .filter((snippet) => snippet.language === language && snippet.name.trim())
          .map((snippet) => ({
            label: `snippet::${snippet.name.trim()}`,
            filterText: `snippet::${snippet.name.trim()}`,
            insertText: snippet.code,
            detail: "Mild Editor snippet",
            range: snippetRange,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          }));
        return { suggestions: [...snippets, ...builtIns] };
      },
    });
    register("cpp", [
      ["vector", "vector", "std::vector type"], ["pair", "pair", "std::pair type"],
      ["sort", "sort(${1:v}.begin(), ${1:v}.end());", "std::sort"], ["lower_bound", "lower_bound(${1:v}.begin(), ${1:v}.end(), ${2:value})", "std::lower_bound"],
      ["upper_bound", "upper_bound(${1:v}.begin(), ${1:v}.end(), ${2:value})", "std::upper_bound"], ["priority_queue", "priority_queue", "std::priority_queue type"],
      ["unordered_map", "unordered_map", "std::unordered_map type"], ["fori", "for (int ${1:i} = 0; ${1:i} < ${2:n}; ++${1:i}) {\n\t${0}\n}", "indexed loop"],
    ]);
    register("python", [
      ["forrange", "for ${1:i} in range(${2:n}):\n\t${0}", "range loop"], ["enumerate", "for ${1:i}, ${2:value} in enumerate(${3:items}):\n\t${0}", "enumerate loop"],
      ["listcomp", "[${1:expr} for ${2:x} in ${3:items}]", "list comprehension"], ["readints", "list(map(int, input().split()))", "read integer list"],
      ["heap", "import heapq\n${1:heap} = []\nheapq.heappush(${1:heap}, ${2:value})", "heapq"],
    ]);
  }
};
