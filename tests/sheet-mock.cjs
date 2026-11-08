// スプレッドシートの最小の模擬（行・列を配列で持つ）
function makeSheet(name, rows) {
  const v = rows || [];
  const sh = {
    v, reads: 0,
    getName: () => name,
    getLastRow: () => v.length,
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => { sh.reads++; return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((v[r - 1 + i] || [])[c - 1 + j] ?? ''))); },
      setValues: vals => { vals.forEach((row, i) => { v[r - 1 + i] = v[r - 1 + i] || []; row.forEach((x, j) => { v[r - 1 + i][c - 1 + j] = x; }); }); },
      setValue: x => { v[r - 1] = v[r - 1] || []; v[r - 1][c - 1] = x; }
    }),
    getDataRange: () => ({ getValues: () => v.map(r => r.slice()) }),
    appendRow: row => { v.push(row.slice()); },
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
