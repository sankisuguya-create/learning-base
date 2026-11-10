// スプレッドシートの最小の模擬（行・列を配列で持つ）
// 本物と同じく、書いた文字を勝手に変える（文字の書式「@」にした列は変えない）：
//   「3-1」「2026-11-10」のような文字 → 日付（Date）。「=」「+」で始まる文字 → 数式（読むと '#ERROR!'）
function convert(x, textCol) {
  if (typeof x !== 'string' || textCol) return x;
  if (/^[=+]/.test(x)) return '#ERROR!';
  let m = x.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = x.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) return new Date(2026, +m[1] - 1, +m[2]);
  return x;
}
function makeSheet(name, rows) {
  const v = rows || [], text = {};
  const sh = {
    v, reads: 0,
    getName: () => name,
    getLastRow: () => v.length,
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => { sh.reads++; return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((v[r - 1 + i] || [])[c - 1 + j] ?? ''))); },
      setValues: vals => { vals.forEach((row, i) => { v[r - 1 + i] = v[r - 1 + i] || []; row.forEach((x, j) => { v[r - 1 + i][c - 1 + j] = convert(x, text[c + j]); }); }); },
      setValue: x => { v[r - 1] = v[r - 1] || []; v[r - 1][c - 1] = convert(x, text[c]); },
      setNumberFormat: f => { if (f === '@') for (let j = 0; j < nc; j++) text[c + j] = true; return this; }
    }),
    getMaxRows: () => 1000,
    getDataRange: () => ({ getValues: () => v.map(r => r.slice()) }),
    appendRow: row => { v.push(row.map((x, j) => convert(x, text[j + 1]))); },
    clearContents: () => { v.length = 0; },
    setFrozenRows: () => {}
  };
  return sh;
}
function makeSS(name) {
  const sheets = {};
  return {
    sheets, getName: () => name, getId: () => name,
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets)
  };
}
module.exports = { makeSheet, makeSS };
