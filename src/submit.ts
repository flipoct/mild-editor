/**
 * Submitting through the problem browser.
 *
 * The embedded Chromium is already logged in to the judge, so a submission needs no stored
 * credentials and no API: the editor opens the judge's own submit page and fills the form.
 * By default the user reviews it and presses the judge's submit button. With "really submit"
 * on, `pressSubmitForm` checks the filled form against the solution and presses that button
 * itself; a check that fails leaves the page alone and says why.
 */

export type SubmitLanguage = "cpp" | "python";

export type SubmitJudge = "atcoder" | "codeforces" | "doj";

export type SubmitTarget = {
  judge: SubmitJudge;
  /** The judge's submit page for this problem. */
  url: string;
  /** AtCoder: the task the form must have selected, from the URL's `taskScreenName`. */
  taskScreenName?: string;
  /** Codeforces contest pages: the problem's letter in the `submittedProblemIndex` list. */
  problemIndex?: string;
  /** Codeforces problem set: `1234A`, typed into `submittedProblemCode`. */
  problemCode?: string;
  /** DOJ: the problem's segment of the URL, which the submit form carries as `problemSlug`. */
  problemSlug?: string;
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
    return match ? { judge: "atcoder", url: `https://atcoder.jp/contests/${match[1]}/submit?taskScreenName=${encodeURIComponent(match[2])}`, taskScreenName: match[2] } : null;
  }
  if (host === "codeforces.com" || host.endsWith(".codeforces.com")) {
    const contest = path.match(/^\/(contest|gym)\/(\d+)\/problem\/([^/]+)$/);
    if (contest) return { judge: "codeforces", url: `https://codeforces.com/${contest[1]}/${contest[2]}/submit`, problemIndex: contest[3].toUpperCase() };
    const problemSet = path.match(/^\/problemset\/problem\/(\d+)\/([^/]+)$/);
    if (problemSet) return { judge: "codeforces", url: "https://codeforces.com/problemset/submit", problemCode: `${problemSet[1]}${problemSet[2].toUpperCase()}` };
  }
  // DOJ submits from the problem's IDE page, `/<locale>/problems/<slug>/ide`. The query stays:
  // a contest problem carries `?contest=<id>`, which is what makes it a contest submission.
  const doj = host === "doj.kr" ? path.match(/^(.*\/problems\/([^/]+?))(?:\/ide)?$/) : null;
  if (doj && doj[2] !== "ide") return { judge: "doj", url: `${url.origin}${doj[1]}/ide${url.search}`, problemSlug: doj[2] };
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

export type FillPayload = { judge: SubmitJudge; code: string; language: string; taskScreenName?: string; problemIndex?: string; problemCode?: string; problemSlug?: string };

/** Runs inside the judge's page. Self-contained: it arrives there as source text. */
async function fillSubmitForm(payload: FillPayload, pick: typeof pickLanguageOption) {
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
  // React applies a click's state changes in a microtask; the DOM it renders is there after a pause.
  const settle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 60));

  if (payload.judge === "doj") {
    // Both of DOJ's editors are CodeMirror 6, which hangs its view off the content element:
    // `cmView` up to view 6.38, `cmTile` from the tile rewrite on.
    type View = { state: { doc: { length: number } }; dispatch: (spec: unknown) => void };
    const replaceCode = (content: Element | null) => {
      try {
        const marks = content as unknown as { cmView?: { view?: View }; cmTile?: { root?: { view?: View } | null } } | null;
        const view = marks?.cmView?.view ?? marks?.cmTile?.root?.view;
        view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: payload.code } });
      } catch { /* not CodeMirror */ }
    };
    // The IDE builds itself after the page has loaded and reads its files from browser storage,
    // so everything below waits for it, within one budget for the whole fill.
    const deadline = Date.now() + 20000;
    const until = async (ready: () => boolean) => {
      while (!ready() && Date.now() < deadline) await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      return ready();
    };
    await until(() => Boolean(document.querySelector(".doj-local-ide, form.doj-submit-launcher-form")));

    if (document.querySelector(".doj-local-ide")) {
      // The IDE at `/problems/<slug>/ide`: a workspace of files, of which the entry file is sent.
      const mainEditor = () => document.querySelector(".doj-local-ide-code-pane.is-main-group .cm-content");
      const ready = () => !document.querySelector(".doj-local-ide-loading") && Boolean(mainEditor());
      await until(ready);
      const languageList = () => document.querySelector<HTMLSelectElement>('.doj-local-ide select[aria-label="제출 언어"], .doj-local-ide select[aria-label="Submission language"], .doj-local-ide-language select');
      const list = languageList();
      if (list) {
        const value = pick([...list.options].map((option) => ({ value: option.value, text: option.text, selected: option.selected })), payload.language);
        if (value && list.value !== value) {
          // The language list is a dressed-up native select; its change event is what DOJ acts on.
          // Only `change`: the IDE saves the workspace on each one before it switches.
          assign(list, value);
          list.dispatchEvent(new Event("change", { bubbles: true }));
          // Each language other than C++ keeps a workspace of its own, which loads on the switch.
          await until(() => languageList()?.value === value);
          await settle();
          await until(ready);
        }
      }
      // The explorer marks the entry file "main": it has to be the file in the main editor.
      const entry = [...document.querySelectorAll<HTMLButtonElement>(".doj-local-ide-file-name")].find((button) => button.querySelector("em")?.textContent?.trim() === "main");
      if (entry && !entry.closest(".doj-local-ide-file")?.classList.contains("is-active")) {
        entry.click();
        await settle();
        await until(ready);
      }
      replaceCode(mainEditor());
      await settle();
      return;
    }

    // The older form: a modal opened from the problem page, with its own dropdown.
    if (!document.querySelector(".doj-submit-modal")) {
      document.querySelector<HTMLButtonElement>('form.doj-submit-launcher-form button.doj-submit-launcher')?.click();
      await settle();
    }
    const trigger = document.querySelector<HTMLButtonElement>(".doj-submit-modal .doj-dropdown-trigger");
    if (trigger) {
      trigger.click();
      await settle();
      const options = [...document.querySelectorAll<HTMLButtonElement>('.doj-dropdown-option[role="option"]')];
      const value = pick(options.map((option) => ({ value: option.textContent?.trim() ?? "", text: option.textContent?.trim() ?? "", selected: option.getAttribute("aria-selected") === "true" })), payload.language);
      const chosen = options.find((option) => option.textContent?.trim() === value);
      // Picking closes the list; with nothing to pick, the trigger closes it again.
      (chosen ?? trigger).click();
      await settle();
    }
    for (const content of document.querySelectorAll(".doj-submit-modal .cm-content")) replaceCode(content);
    await settle();
    return;
  }

  if (payload.problemIndex) {
    const select = document.querySelector<HTMLSelectElement>('select[name="submittedProblemIndex"]');
    if (select && [...select.options].some((option) => option.value === payload.problemIndex)) { assign(select, payload.problemIndex); changed(select); }
  }
  if (payload.problemCode) {
    const input = document.querySelector<HTMLInputElement>('input[name="submittedProblemCode"]');
    if (input) { assign(input, payload.problemCode); changed(input); }
  }

  // AtCoder keeps one list per task and shows the task's own; Codeforces has a single one.
  const lists = [...document.querySelectorAll<HTMLSelectElement>(payload.judge === "atcoder" ? 'select[name="data.LanguageId"]' : 'select[name="programTypeId"]')];
  for (const select of lists.filter((item) => item.offsetParent !== null || lists.length === 1)) {
    const value = pick([...select.options].map((option) => ({ value: option.value, text: option.text, selected: option.selected })), payload.language);
    if (value && select.value !== value) { assign(select, value); changed(select); }
  }

  // Both judges lay an Ace editor over a plain textarea and submit whichever is showing.
  for (const area of document.querySelectorAll<HTMLTextAreaElement>(payload.judge === "atcoder" ? 'textarea[name="sourceCode"]' : 'textarea[name="source"], textarea#sourceCodeTextarea')) {
    assign(area, payload.code);
    changed(area);
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

/** A page-side result travels back through the page title, the one thing the browser reports as it changes. */
export const SUBMIT_MARK = "mild-editor:submit:";

export type PressPayload = FillPayload & { nonce: string };

/** What a press could not confirm, spelled out for the status bar; `pressed` means the button was clicked. */
export type PressResult = "pressed" | "form" | "problem" | "language" | "code" | "button";

/**
 * Runs inside the judge's page: fills the form, checks every field it will send against the
 * solution, and only then presses the judge's submit button. The outcome is written into the
 * page title as `mild-editor:submit:<nonce>:<result>`; a failure's title is put back later.
 */
async function pressSubmitForm(payload: PressPayload, pick: typeof pickLanguageOption, fill: typeof fillSubmitForm) {
  const original = document.title;
  // A retry from the editor must not send the solution a second time: one press per page.
  const page = window as unknown as { __mildEditorPressedAt?: number };
  const report = (result: PressResult) => {
    document.title = `mild-editor:submit:${payload.nonce}:${result}`;
    if (result !== "pressed") window.setTimeout(() => { if (document.title.startsWith("mild-editor:submit:")) document.title = original; }, 1500);
  };
  // Line endings differ between platforms and editors; a missing final newline changes nothing.
  const same = (left: string, right: string) => left.replace(/\r\n?/g, "\n").trimEnd() === right.replace(/\r\n?/g, "\n").trimEnd();
  const family = payload.language === "cpp" ? /(^|\W)(C\+\+|G\+\+|Clang\+\+)/i : /(^|\W)(Python|PyPy|CPython)/i;
  const visible = (element: Element) => (element as HTMLElement).offsetParent !== null;
  const ace = (window as unknown as { ace?: { edit: (element: Element) => { getValue: () => string } } }).ace;
  const aceAgrees = () => !ace || [...document.querySelectorAll(".ace_editor")].every((element) => {
    try { return same(ace.edit(element).getValue(), payload.code); } catch { return true; }
  });
  if (page.__mildEditorPressedAt && Date.now() - page.__mildEditorPressedAt < 60000) return report("pressed");

  await fill(payload, pick);
  await new Promise<void>((resolve) => window.setTimeout(resolve, 400));

  let button: HTMLButtonElement | HTMLInputElement | null = null;
  if (payload.judge === "atcoder") {
    const task = document.querySelector<HTMLSelectElement>('select[name="data.TaskScreenName"]');
    if (!task) return report("form");
    if (task.value !== payload.taskScreenName) return report("problem");
    const lists = [...document.querySelectorAll<HTMLSelectElement>('select[name="data.LanguageId"]')].filter(visible);
    if (lists.length !== 1 || !family.test(lists[0].selectedOptions[0]?.text ?? "")) return report("language");
    const areas = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[name="sourceCode"]')];
    if (!areas.length || !areas.every((area) => same(area.value, payload.code)) || !aceAgrees()) return report("code");
    button = document.querySelector<HTMLButtonElement>('#submit, form[action$="/submit"] button[type="submit"]');
  } else if (payload.judge === "codeforces") {
    const form = document.querySelector<HTMLFormElement>("form.submit-form") ?? document.querySelector<HTMLFormElement>('form[action*="/submit"]');
    if (!form) return report("form");
    if (payload.problemIndex) {
      const select = form.querySelector<HTMLSelectElement>('select[name="submittedProblemIndex"]');
      if (select?.value !== payload.problemIndex) return report("problem");
    } else {
      const input = form.querySelector<HTMLInputElement>('input[name="submittedProblemCode"]');
      if (input?.value.trim().toUpperCase() !== payload.problemCode?.toUpperCase()) return report("problem");
    }
    const list = form.querySelector<HTMLSelectElement>('select[name="programTypeId"]');
    if (!list || !family.test(list.selectedOptions[0]?.text ?? "")) return report("language");
    const areas = [...form.querySelectorAll<HTMLTextAreaElement>('textarea[name="source"], textarea#sourceCodeTextarea')];
    if (!areas.length || !areas.every((area) => same(area.value, payload.code)) || !aceAgrees()) return report("code");
    button = form.querySelector<HTMLInputElement>('input.submit[type="submit"], input[type="submit"], button[type="submit"]');
  } else {
    // DOJ's submit button sits in the IDE (or the older modal) and names its form, whose hidden
    // inputs mirror the editor's state: they are what is sent.
    const submitButton = () => [...document.querySelectorAll<HTMLButtonElement>('.doj-local-ide button[type="submit"], .doj-submit-modal button[type="submit"]')].find((item) => item.form) ?? null;
    let found = submitButton();
    if (!found) {
      // With several problems open the IDE asks which one to send first; that dialog holds the button.
      const opener = document.querySelector<HTMLButtonElement>('.doj-local-ide-submit button[type="button"]');
      if (opener && !opener.disabled) {
        opener.click();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
        found = submitButton();
      }
    }
    const form = found?.form;
    if (!form) return report("form");
    const field = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value ?? "";
    const slug = (payload.problemSlug ?? "").toLowerCase();
    if (!slug || ![field("problemSlug"), field("problemId")].some((value) => value.toLowerCase() === slug)) return report("problem");
    if (!(payload.language === "cpp" ? /^(cpp|c\+\+)/i : /^(python|pypy)/i).test(field("language"))) return report("language");
    if (!same(field("sourceCode"), payload.code)) return report("code");
    button = found;
  }
  if (!button || button.disabled) return report("button");

  page.__mildEditorPressedAt = Date.now();
  report("pressed");
  button.click();
}

export const pressSubmitFormScript = (payload: PressPayload) =>
  `(${pressSubmitForm.toString()})(${JSON.stringify(payload)}, ${pickLanguageOption.toString()}, ${fillSubmitForm.toString()});`;
