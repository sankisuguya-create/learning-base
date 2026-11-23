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
    getLastColumn: () => v.reduce((m, r) => Math.max(m, r.length), 0), getMaxColumns: () => 26, insertColumnsAfter: () => {},
    getRange: (r, c, nr = 1, nc = 1) => { const rg = (typeof r === 'string' ? {   // 'A:A'：1列目から探す（漢字の森の findRow_）
      createTextFinder: t => ({ matchEntireCell: () => ({ findNext: () => { const i = v.findIndex(row => String(row[0]) === String(t)); return i >= 0 ? { getRow: () => i + 1 } : null; } }) })
    } : {
      getValues: () => { sh.reads++; return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((v[r - 1 + i] || [])[c - 1 + j] ?? ''))); },
      setValues: vals => { vals.forEach((row, i) => { v[r - 1 + i] = v[r - 1 + i] || []; row.forEach((x, j) => { v[r - 1 + i][c - 1 + j] = convert(x, text[c + j]); }); }); },
      setValue: x => { v[r - 1] = v[r - 1] || []; v[r - 1][c - 1] = convert(x, text[c]); },
      setNumberFormat: f => { if (f === '@') for (let j = 0; j < nc; j++) text[c + j] = true; return rg; }
    }); return rg; },
    getMaxRows: () => 1000,
    getDataRange: () => ({ getValues: () => v.map(r => r.slice()), getFormulas: () => sh.formulas || v.map(r => r.map(() => '')) }),   // 数式は sh.formulas に置く（検査用）
    appendRow: row => { v.push(row.map((x, j) => convert(x, text[j + 1]))); },
    clearContents: () => { v.length = 0; },
    setFrozenRows: () => {}
  };
  return sh;
}
function makeSS(name) {
  const sheets = {};
  const ss = {
    sheets, getName: () => name, getId: () => name,
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => own(n, makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: sh => { delete sheets[sh.getName()]; },
    editors: [], getEditors: () => ss.editors.map(m => ({ getEmail: () => m }))
  };
  // 写す（copyTo）・名前を変える（setName）：本物と同じく、写したシートの名前は「… のコピー」
  function own(n, sh) {
    let cur = n;
    sh.getName = () => cur;
    sh.setName = m => { delete sheets[cur]; cur = m; sheets[m] = sh; return sh; };
    sh.copyTo = dst => dst._adopt(cur + ' のコピー', sh.v.map(r => r.slice()));
    sheets[n] = sh;
    return sh;
  }
  ss._adopt = (n, rows) => own(n, makeSheet(n, rows));
  return ss;
}
module.exports = { makeSheet, makeSS };
