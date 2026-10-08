import type { ProblemTab, TestCase } from "./types";

/**
 * Development only: `?demo` fills the browser preview (`npm run dev:web`) with a workspace,
 * so the interface can be looked at without the Tauri backend. `?demo=settings` also opens
 * the settings dialog.
 */
export const DEMO_MODE = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("demo") : null;

export const demoTests: TestCase[] = [
  { id: 1, name: "sample 1", input: "3\n1 2 3\n", expected: "6", output: "6\n", error: "", status: "ac", open: false, timeMs: 12 },
  { id: 2, name: "sample 2", input: "4\n10 20 30 40\n", expected: "100\n7", output: "100\n9\n", error: "", status: "wa", open: true, timeMs: 15 },
  { id: 3, name: "sample 3", input: "1\n1000000000\n", expected: "1000000000", output: "", error: "Error: TLE (2s)", status: "tle", open: false, timeMs: 2000 },
  { id: 4, name: "test 4", input: "0\n", expected: "0", output: "", error: "", status: "idle", open: false },
];

export const demoCode = "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    int n;\n    cin >> n;\n    long long sum = 0;\n    for (int i = 0; i < n; i++) {\n        long long x;\n        cin >> x;\n        sum += x;\n    }\n    cout << sum << \"\\n\";\n    return 0;\n}\n";

export const demoTabs: ProblemTab[] = DEMO_MODE === null ? [] : [
  { id: "demo-a", title: "A - Sum", filename: "AtCoder/abc400/A_Sum.cpp", language: "cpp", codes: { cpp: demoCode, python: "" }, tests: demoTests, source: "atcoder", judgeStatus: "AC" },
  { id: "demo-b", title: "B - Pairs", filename: "AtCoder/abc400/B_Pairs.cpp", language: "cpp", codes: { cpp: demoCode, python: "" }, tests: demoTests, dirty: true, source: "atcoder", judgeStatus: "WA" },
  { id: "demo-c", title: "C - Graph", filename: "AtCoder/abc400/C_Graph.py", language: "python", codes: { cpp: "", python: "print(1)\n" }, tests: demoTests, source: "atcoder" },
  { id: "demo-d", title: "Watermelon", filename: "Codeforces/A_Watermelon.cpp", language: "cpp", codes: { cpp: demoCode, python: "" }, tests: demoTests, source: "codeforces" },
];

