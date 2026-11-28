/**
 * What the board's own controls say (ui.ts), in the editor and on a tablet alike. The editor
 * picks the language its interface is in; a tablet's page, its browser's.
 */
const en = {
  select: "Select", hand: "Move the view", pen: "Pen", highlighter: "Highlighter", eraser: "Eraser",
  text: "Text & math", rect: "Rectangle", ellipse: "Ellipse", arrow: "Arrow", line: "Line", image: "Insert a picture",
  lock: "Keep the tool (Q): stay on a shape tool after drawing",
  undo: "Undo", redo: "Redo", zoomIn: "Zoom in", zoomOut: "Zoom out", zoomReset: "Back to 100%", fit: "Show everything",
  menu: "More", exportPng: "Save as PNG…", copyPng: "Copy as PNG", grid: "Dot grid", fingerDraw: "Draw with fingers too", shortcuts: "Keyboard shortcuts",
  color: "Colour", fill: "Fill", noFill: "No fill", width: "Width", thin: "Thin", medium: "Medium", bold: "Bold", fontSize: "Text size",
  selection: "Selection", front: "Bring to front", back: "Send to back", duplicate: "Duplicate", remove: "Delete",
  editText: "Edit text",
  hintSelect: "Double-click an empty spot to write · Space+drag moves · Ctrl+wheel zooms",
  hintHand: "Drag to move the view",
  hintPen: "Two fingers move and zoom · Ctrl+Z takes it back",
  hintHighlighter: "Goes under writing and formulas",
  hintEraser: "Rubs out lines, shapes and writing it passes · pictures stay",
  hintText: "Click to write · $x^2$ is a formula · Esc to finish",
  hintRect: "Shift for a square", hintEllipse: "Shift for a circle", hintArrow: "Shift for 15° steps", hintLine: "Shift for 15° steps",
  nothingToExport: "There is nothing to export", copied: "Copied the PNG", pngFailed: "Could not make the PNG",
  imageFailed: "Could not read the picture", imageTooBig: "The picture is too large",
  fingersDraw: "Fingers draw too", fingersPan: "While a pen is in use, fingers only move the view",
  close: "Close",
  keysTools: "Tools", keysEdit: "Editing", keysView: "View", keysMath: "Math",
  keyMove: "Move", keyZoom: "Zoom", keyFit: "100% · show everything",
  keyUndo: "Undo · redo", keyClip: "Copy · cut · paste", keyDuplicate: "Duplicate", keySelectAll: "Select all", keyOrder: "Forward · backward",
  keyEditText: "Edit text", keyEndText: "Finish editing", keyShift: "Keep proportions · 15° steps",
  wheel: "wheel", drag: "drag", pinch: "pinch", doubleClick: "double-click", empty: "on an empty spot",
  mathNote: "In writing, $x^2$ is a formula in the line and $$\\int_0^1 f$$ one on its own. A dollar sign is \\$.",
};

export type BoardWords = typeof en;

const ko: BoardWords = {
  select: "선택", hand: "화면 이동", pen: "펜", highlighter: "형광펜", eraser: "지우개",
  text: "글·수식", rect: "사각형", ellipse: "타원", arrow: "화살표", line: "선", image: "사진 넣기",
  lock: "도구 고정 (Q): 도형을 그린 뒤에도 같은 도구 유지",
  undo: "실행 취소", redo: "다시 실행", zoomIn: "확대", zoomOut: "축소", zoomReset: "100%로", fit: "전체 보기",
  menu: "더 보기", exportPng: "PNG로 저장…", copyPng: "PNG를 클립보드에 복사", grid: "점 격자", fingerDraw: "손가락으로도 그리기", shortcuts: "단축키",
  color: "색", fill: "채우기", noFill: "채우기 없음", width: "굵기", thin: "가늘게", medium: "보통", bold: "굵게", fontSize: "글자 크기",
  selection: "선택한 것", front: "맨 앞으로", back: "맨 뒤로", duplicate: "복제", remove: "삭제",
  editText: "글 고치기",
  hintSelect: "빈 곳을 더블클릭하면 글쓰기 · Space+드래그로 이동 · Ctrl+휠로 확대",
  hintHand: "끌어서 화면 이동",
  hintPen: "두 손가락으로 화면 이동·확대 · Ctrl+Z로 되돌리기",
  hintHighlighter: "글과 수식 아래에 깔립니다",
  hintEraser: "지나간 선·도형·글을 지웁니다 · 사진은 지우지 않습니다",
  hintText: "클릭해서 입력 · $x^2$는 수식 · Esc로 마침",
  hintRect: "Shift를 누르면 정사각형", hintEllipse: "Shift를 누르면 원", hintArrow: "Shift를 누르면 15° 단위", hintLine: "Shift를 누르면 15° 단위",
  nothingToExport: "내보낼 것이 없습니다", copied: "PNG를 복사했습니다", pngFailed: "PNG를 만들지 못했습니다",
  imageFailed: "사진을 읽을 수 없습니다", imageTooBig: "사진이 너무 큽니다",
  fingersDraw: "손가락으로도 그립니다", fingersPan: "펜을 쓰는 동안 손가락은 화면만 옮깁니다",
  close: "닫기",
  keysTools: "도구", keysEdit: "편집", keysView: "화면", keysMath: "수식",
  keyMove: "이동", keyZoom: "확대·축소", keyFit: "100% · 전체 보기",
  keyUndo: "실행 취소 · 다시 실행", keyClip: "복사 · 잘라내기 · 붙여넣기", keyDuplicate: "복제", keySelectAll: "모두 선택", keyOrder: "앞으로 · 뒤로",
  keyEditText: "글 고치기", keyEndText: "글 편집 마치기", keyShift: "비율 유지 · 15° 맞춤",
  wheel: "휠", drag: "드래그", pinch: "핀치", doubleClick: "더블클릭", empty: "빈 곳",
  mathNote: "글 안에서 $x^2$는 줄 안 수식, $$\\int_0^1 f$$는 큰 수식입니다. 달러 기호는 \\$.",
};

export const boardWords = (korean: boolean): BoardWords => korean ? ko : en;
