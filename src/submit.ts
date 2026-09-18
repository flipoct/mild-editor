/**
 * Submitting through the problem browser.
 *
 * The embedded Chromium is already logged in to the judge, so a submission needs no stored
 * credentials and no API: the editor opens the judge's own submit page and fills the form.
 * The user reviews it and presses the judge's submit button; nothing is sent from here.
 */

export type SubmitLanguage = "cpp" | "python";

export type SubmitTarget = {
  /** The judge's submit page for this problem. */
  url: string;
  /** Codeforces contest pages: the problem's letter in the `submittedProblemIndex` list. */
  problemIndex?: string;
  /** Codeforces problem set: `1234A`, typed into `submittedProblemCode`. */
  problemCode?: string;
  /** The form's field names are not known (DOJ renders it client-side): look for an editor and a language list. */
  generic?: boolean;
};

/** The submit page for a problem URL, or `null` for a judge whose form the editor does not know. */
export const submitTarget = (sourceUrl: string | undefined): SubmitTarget | null => {
  if (!sourceUrl) return null;
  let url: URL;
  try { url = new URL(sourceUrl); } catch { return null; }
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");

  if (host === "atcoder.jp") {
    const match = path.match(/^\/contests\/([^/]+)\/tasks\/([^/]+)$/);
    return match ? { url: `https://atcoder.jp/contests/${match[1]}/submit?taskScreenName=${encodeURIComponent(match[2])}` } : null;
  }
  if (host === "codeforces.com" || host.endsWith(".codeforces.com")) {
    const contest = path.match(/^\/(contest|gym)\/(\d+)\/problem\/([^/]+)$/);
    if (contest) return { url: `https://codeforces.com/${contest[1]}/${contest[2]}/submit`, problemIndex: contest[3].toUpperCase() };
    const problemSet = path.match(/^\/problemset\/problem\/(\d+)\/([^/]+)$/);
    if (problemSet) return { url: "https://codeforces.com/problemset/submit", problemCode: `${problemSet[1]}${problemSet[2].toUpperCase()}` };
  }
  // DOJ has no submit page of its own: the form sits on the problem page, once logged in.
  if (host === "doj.kr" && /\/problems\/[^/]+$/.test(path)) return { url: sourceUrl, generic: true };
  return null;
};

/**
 * Picks a language from a judge's list. A judge remembers the language of the last
 * submission, so a selection that is already in the right family is kept; otherwise the
 * newest compiler of the family wins (`C++ 23` over `C++ 17`, `G++23` over `G++17`).
 *
 * Self-contained on purpose: it is sent into the page as source text.
 */
export function pickLanguageOption(options: Array<{ value: string; text: string; selected: boolean }>, language: string): string | null {
  const family = language === "cpp" ? /(^|\W)(C\+\+|G\+\+|Clang\+\+)/i : /(^|\W)(Python|PyPy|CPython)/i;
  const candidates = options.filter((option) => option.value && family.test(option.text));
  if (!candidates.length) return null;
  const current = candidates.find((option) => option.selected);
  if (current) return current.value;
  const version = (text: string) => {
    const match = language === "cpp" ? text.match(/\+\+\s*(\d+)/) : text.match(/(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : 0;
  };
  // GCC is what the local runner uses; PyPy is what a contest solution in Python needs.
  const preferred = language === "cpp" ? /gcc|g\+\+/i : /pypy/i;
  const ranked = [...candidates].sort((left, right) =>
    Number(preferred.test(right.text)) - Number(preferred.test(left.text)) || version(right.text) - version(left.text));
  return ranked[0].value;
}

type FillPayload = { code: string; language: string; problemIndex?: string; problemCode?: string; generic?: boolean };

/** Runs inside the judge's page. Self-contained: it arrives there as source text. */
function fillSubmitForm(payload: FillPayload, pick: typeof pickLanguageOption) {
  // A page built with React ignores a plain `.value =`: it has to go through the native setter.
  const assign = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    const proto = Object.getPrototypeOf(element) as object | null;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : undefined;
    if (setter) setter.call(element, value); else element.value = value;
  };
  const changed = (element: Element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    // AtCoder dresses its selects with select2, which only listens to jQuery's own event.
    const jquery = (window as unknown as { jQuery?: (element: Element) => { trigger: (name: string) => void } }).jQuery;
    try { jquery?.(element).trigger("change"); } catch { /* plain events were sent already */ }
  };

  if (payload.problemIndex) {
    const select = document.querySelector<HTMLSelectElement>('select[name="submittedProblemIndex"]');
    if (select && [...select.options].some((option) => option.value === payload.problemIndex)) { assign(select, payload.problemIndex); changed(select); }
  }
  if (payload.problemCode) {
    const input = document.querySelector<HTMLInputElement>('input[name="submittedProblemCode"]');
    if (input) { assign(input, payload.problemCode); changed(input); }
  }

  // AtCoder keeps one list per task and shows the task's own; Codeforces has a single one.
  const lists = [...document.querySelectorAll<HTMLSelectElement>(payload.generic ? "select" : 'select[name="data.LanguageId"], select[name="programTypeId"]')];
  for (const select of lists.filter((item) => item.offsetParent !== null || lists.length === 1)) {
    const value = pick([...select.options].map((option) => ({ value: option.value, text: option.text, selected: option.selected })), payload.language);
    if (value && select.value !== value) { assign(select, value); changed(select); }
  }

  // Both judges lay an Ace editor over a plain textarea and submit whichever is showing.
  const areas = [...document.querySelectorAll<HTMLTextAreaElement>(payload.generic ? "textarea:not([readonly]):not([disabled])" : 'textarea[name="sourceCode"], textarea[name="source"], textarea#sourceCodeTextarea')]
    // An editor widget keeps a tiny hidden textarea for the keyboard; that one is not the form's.
    .filter((area) => !payload.generic || !area.closest(".monaco-editor, .cm-editor, .ace_editor"));
  for (const area of areas) {
    assign(area, payload.code);
    changed(area);
  }
  if (payload.generic) {
    // Monaco and CodeMirror 6, the two editors a client-rendered form is likely to use.
    const monaco = (window as unknown as { monaco?: { editor: { getModels: () => Array<{ setValue: (value: string) => void }> } } }).monaco;
    try { monaco?.editor.getModels().forEach((model) => model.setValue(payload.code)); } catch { /* not Monaco */ }
    for (const content of document.querySelectorAll(".cm-content")) {
      try {
        const view = (content as unknown as { cmView?: { view?: { state: { doc: { length: number } }; dispatch: (spec: unknown) => void } } }).cmView?.view;
        view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: payload.code } });
      } catch { /* not CodeMirror */ }
    }
  }
  const ace = (window as unknown as { ace?: { edit: (element: Element) => { setValue: (value: string, cursor: number) => void } } }).ace;
  if (ace) {
    for (const element of document.querySelectorAll(".ace_editor")) {
      try { ace.edit(element).setValue(payload.code, -1); } catch { /* the textarea carries the code */ }
    }
  }

  document.querySelector<HTMLElement>('#submit, input.submit[type="submit"], form button[type="submit"]')?.scrollIntoView({ block: "center" });
}

export const fillSubmitFormScript = (payload: FillPayload) =>
  `(${fillSubmitForm.toString()})(${JSON.stringify(payload)}, ${pickLanguageOption.toString()});`;
