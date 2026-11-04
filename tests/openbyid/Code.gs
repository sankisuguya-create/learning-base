// 別のスプレッドシートを開く時間の試験（openById）
// 1. 下の UNIT_SHEET_ID に、記録のたまっている単元のスプレッドシートのIDを入れる
//    （URLの /d/ と /edit の間の文字列）
// 2. 関数 measure を5回実行する（1回ずつ「実行」を押す。毎回が別の実行になる）
// 3. このスプレッドシートの「計測」シートに1回1行たまる
var UNIT_SHEET_ID = 'ここにIDを入れる';

function measure() {
  var out = [new Date()];
  // A: いまの方式（GASが付いているスプレッドシートを開く）
  var t = Date.now();
  var a = SpreadsheetApp.getActiveSpreadsheet();
  a.getSheets().length;
  out.push(Date.now() - t);
  // B: 別のスプレッドシートを開く（1回目）
  t = Date.now();
  var b = SpreadsheetApp.openById(UNIT_SHEET_ID);
  var log = b.getSheetByName('log');
  out.push(Date.now() - t);
  // C: 同じ実行の中で、もう一度開く（2回目）
  t = Date.now();
  SpreadsheetApp.openById(UNIT_SHEET_ID).getSheetByName('log');
  out.push(Date.now() - t);
  // D: 開いたシートの最後の50行を読む（記録の集計で行う読み方）
  t = Date.now();
  var n = log ? log.getLastRow() : 0;
  if (n > 1) log.getRange(Math.max(2, n - 49), 1, Math.min(50, n - 1), log.getLastColumn()).getValues();
  out.push(Date.now() - t, n);
  // E: 1行書いて消す（記録の書き込みに近い操作。単元のシートは汚さず、試験用のシートで行う）
  t = Date.now();
  var w = b.getSheetByName('openbyid_test') || b.insertSheet('openbyid_test');
  w.appendRow([new Date()]);
  out.push(Date.now() - t);

  var sh = a.getSheetByName('計測') || a.insertSheet('計測');
  if (sh.getLastRow() === 0) sh.appendRow(['日時', 'A 付属を開くms', 'B 別を開く1回目ms', 'C 別を開く2回目ms', 'D 50行読むms', 'logの行数', 'E 1行書くms']);
  sh.appendRow(out);
}

// 終わったら1回実行：単元のスプレッドシートに作った試験用シートを消す
function cleanup() {
  var b = SpreadsheetApp.openById(UNIT_SHEET_ID);
  var w = b.getSheetByName('openbyid_test');
  if (w) b.deleteSheet(w);
}
