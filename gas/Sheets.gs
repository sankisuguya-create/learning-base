/**
 * Sheets.gs — ハブのシートを読み書きする共通の部品（LbSheets）
 *
 * 正本は learning-base。共通部品の一番先に読み込む（他の部品はこれを使う）。
 * スプレッドシートは書いた文字を勝手に変える：「3-1」→ 3月1日、「2026-11-10」→ 日付、「=」「+」で始まる文字 → 数式。
 * そこで、学級・日付・週を書く列は文字の書式にし（textCol）、読む時も日付に化けた値を元の形に戻す（clsCell・ymd）。
 * 手で直した行・書式を付ける前の行があるので、読む時の戻しは書式を付けた後も外さない。
 */
var LbSheets = (function () {
  var TZ = 'Asia/Tokyo';
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** 'YYYY-MM-DD'（日本時間）。d を省略すると今日 */
  function day(d) {
    d = d || new Date();
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /** 学級の欄（'3-1'）。日付に化けていれば月-日に戻す */
  function clsCell(v) { return isDate(v) ? (v.getMonth() + 1) + '-' + v.getDate() : String(v == null ? '' : v).trim(); }
  /** 日付・週の欄（'2026-11-10'）。日付に化けていれば文字に戻す */
  function ymd(v) { return isDate(v) ? day(v) : String(v == null ? '' : v).trim(); }

  /** その列を文字の書式にする（行の数は最低1000行分） */
  function textCol(sh, col) { sh.getRange(1, col, Math.max(sh.getMaxRows ? sh.getMaxRows() : 1000, 1000), 1).setNumberFormat('@'); }
  /**
   * 表を用意する。無ければ作って見出しを書き、textCols（1から数える列の番号）を文字の書式にする。
   * opts.always：既にある表にも毎回文字の書式を付け直す（手で列を足した表のため）
   */
  function sheet(ss, name, head, textCols, opts) {
    var sh = ss.getSheetByName(name), made = false;
    if (!sh) { sh = ss.insertSheet(name); made = true; }
    if (made || (opts && opts.always)) (textCols || []).forEach(function (c) { textCol(sh, c); });
    if (made) sh.getRange(1, 1, 1, head.length).setValues([head]);
    return sh;
  }
  /** 見出しの2行目以降を読む（無ければ []）。cols を省略すると見出しの列の数 */
  function rows(ss, name, cols) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues();
  }

  return { TZ: TZ, isDate: isDate, day: day, clsCell: clsCell, ymd: ymd, textCol: textCol, sheet: sheet, rows: rows };
})();
