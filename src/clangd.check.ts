/**
 * A quick check of how the clangd client names files, run with
 * `node --experimental-strip-types src/clangd.check.ts`.
 */
import { fileUri, sameFileUri } from "./clangd.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); }
  else console.log("ok   ", label);
};

eq("a plain Windows path", fileUri("C:\\work\\A.cpp"), "file:///C:/work/A.cpp");
eq("a space is encoded", fileUri("C:\\my work\\A.cpp"), "file:///C:/my%20work/A.cpp");
eq("Korean is encoded as UTF-8", fileUri("C:\\Users\\민준\\A.cpp"), "file:///C:/Users/%EB%AF%BC%EC%A4%80/A.cpp");
eq("a POSIX path", fileUri("/home/me/a b.cpp"), "file:///home/me/a%20b.cpp");
eq("what clangd leaves alone stays", fileUri("C:/a-b_c.d~e/A.cpp"), "file:///C:/a-b_c.d~e/A.cpp");
eq("# and % are encoded", fileUri("C:/x#1/100%.cpp"), "file:///C:/x%231/100%25.cpp");

eq("the drive letter's case does not matter", sameFileUri("file:///c:/work/A.cpp", "file:///C:/work/A.cpp"), true);
eq("encoded and plain are the same file", sameFileUri("file:///C:/my%20work/A.cpp", "file:///C:/my work/A.cpp"), true);
eq("Korean, encoded either way", sameFileUri("file:///C:/Users/%EB%AF%BC%EC%A4%80/A.cpp", fileUri("C:\\Users\\민준\\A.cpp")), true);
eq("another file is another file", sameFileUri("file:///C:/work/A.cpp", "file:///C:/work/B.cpp"), false);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
