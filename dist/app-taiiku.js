// dist/app-taiiku.js — 教科 taiiku のサーバーのコード（tools/bundle.cjs が作る。直接直さない）
// ===== アプリ taiiku（sankisuguya-create/taiiku@9f9e827） =====
LB_MODULES["taiiku"] = (function () { try { return (function () {
var LB_APP_REPO = "sankisuguya-create/taiiku";
var LB_APP_COMMIT = "9f9e8276f0eaa980551b81c5645b02c3eb01f23f";
var LB_RESOLVE_ = function (n) { return /^[A-Za-z][A-Za-z0-9]*$/.test(n) ? eval('typeof ' + n + " === 'function' ? " + n + ' : undefined') : undefined; };
// --- gas/Taiiku.js ---
// 体育のページ（学習BASE の中で動く）。learning-base の tools/bundle.cjs がこのファイルを関数に包み、
// apps.lock.json の files（taiiku/board など）を LB_FILES に入れて渡す。約束は learning-base の docs/add-app.md。
//   …/exec?app=taiiku              ラインポートボールの作戦ボード
//   …/exec?app=taiiku&page=board   同じ
// 名簿・記録は使わない（作戦の保存は、その端末のブラウザの中だけ）。
var TAIIKU_PAGES = {
  board: { file: 'taiiku/board', title: 'ラインポートボール 作戦ボード' }
};

function doGet(e) {
  var key = String((e && e.parameter && e.parameter.page) || 'board');
  var pg = TAIIKU_PAGES[key] || TAIIKU_PAGES.board;
  var html = (typeof LB_FILES !== 'undefined' && LB_FILES[pg.file]) || '';
  if (!html) return HtmlService.createHtmlOutput('<p>いまは ひらけません。</p>').setTitle(pg.title);
  return HtmlService.createHtmlOutput(String(html))
    .setTitle(pg.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

return {
  "doGet": (typeof doGet === 'function' ? doGet : undefined)
};
})(); } catch (e) { console.error("アプリ taiiku を読み込めません: " + (e && e.message || e)); return { broken: String(e && e.message || e) }; } })();
