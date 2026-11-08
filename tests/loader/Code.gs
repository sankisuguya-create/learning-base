// 試験：GAS がサーバー側のコードを jsDelivr から取ってきて実行できるか、重さはどれくらいか
// 1. 新しいスプレッドシート →「拡張機能 → Apps Script」→ このファイルを コード.gs に貼る
// 2. 関数 measure を「実行」する（初回は承認。外部への接続の許可が出る）
// 3. もう2回 measure を実行する（2回目以降は一時保存から読む経路を測る）
// 4. このスプレッドシートの「計測」シートを見る（児童の情報は入らない）
//
// 取ってくるのは算数タイムアタックのサーバー側のコード（Core.gs ＋ 全単元 AllUnits.gs、約37万バイト）。
// 本番で読み込む量に近い。版はコミット番号で固定している。
var SRC = 'https://cdn.jsdelivr.net/gh/sankisuguya-create/arithmetic-timeattack@a00b2c6ddcac6e141e3c1e761ea8dc08ed941d72/dist/multi/';
var FILES = ['Base.gs', 'Core.gs', 'AllUnits.gs'];
var CHUNK = 30000;   // CacheService の1件100KB。日本語は1字3バイトなので3万字で切る

function measure() {
  var row = { at: new Date() }, t, code = '', path = '';
  var cache = CacheService.getScriptCache();
  try {
    // A. 一時保存から読む（2回目以降の実行を想定）
    t = Date.now();
    var n = Number(cache.get('code:n') || 0);
    if (n) {
      var keys = []; for (var i = 0; i < n; i++) keys.push('code:' + i);
      var got = cache.getAll(keys);
      for (var j = 0; j < n; j++) { if (got[keys[j]] == null) { code = ''; break; } code += got[keys[j]]; }
    }
    row.cacheMs = Date.now() - t;
    path = code ? '一時保存' : 'jsDelivr';

    // B. 無ければ jsDelivr から取る
    if (!code) {
      t = Date.now();
      var res = UrlFetchApp.fetchAll(FILES.map(function (f) { return { url: SRC + f, muteHttpExceptions: true }; }));
      row.fetchMs = Date.now() - t;
      var bad = res.filter(function (r) { return r.getResponseCode() !== 200; });
      if (bad.length) throw new Error('取得できない: ' + bad.map(function (r) { return r.getResponseCode(); }).join(','));
      code = res.map(function (r) { return r.getContentText('UTF-8'); }).join('\n');
      // 一時保存に入れる
      t = Date.now();
      var m = {}, k = Math.ceil(code.length / CHUNK);
      for (var c = 0; c < k; c++) m['code:' + c] = code.slice(c * CHUNK, (c + 1) * CHUNK);
      m['code:n'] = String(k);
      cache.putAll(m, 21600);
      row.cachePutMs = Date.now() - t;
    }
    row.chars = code.length;

    // C. 指紋（改ざんの検査に使う）
    t = Date.now();
    var dig = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, code, Utilities.Charset.UTF_8);
    row.sha = dig.slice(0, 6).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
    row.digestMs = Date.now() - t;

    // D. 実行（大域に関数を定義させる）
    t = Date.now();
    (0, eval)(code);
    row.evalMs = Date.now() - t;

    // E. 読み込めたかを確かめる
    row.units = typeof UNIT_DEFS !== 'undefined' ? Object.keys(UNIT_DEFS).length : 0;
    row.base = typeof Base !== 'undefined' ? 'VER ' + Base.VER : 'なし';
    row.result = '○';
  } catch (e) {
    row.result = '× ' + (e && e.message || e);
  }
  row.path = path;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('計測') || SpreadsheetApp.getActiveSpreadsheet().insertSheet('計測');
  var head = ['日時', '経路', '結果', '一時保存を読むms', 'jsDelivr取得ms', '一時保存に入れるms', '指紋ms', '実行ms', '文字数', '単元数', 'Base', '指紋の頭'];
  if (sh.getLastRow() === 0) sh.appendRow(head);
  sh.appendRow([row.at, row.path, row.result, row.cacheMs, row.fetchMs, row.cachePutMs, row.digestMs, row.evalMs, row.chars, row.units, row.base, row.sha]);
  console.log(JSON.stringify(row));
}

// 一時保存を消して、jsDelivr から取る経路をもう一度測りたい時に実行する
function clearCache() {
  var cache = CacheService.getScriptCache(), n = Number(cache.get('code:n') || 0), keys = ['code:n'];
  for (var i = 0; i < n; i++) keys.push('code:' + i);
  cache.removeAll(keys);
  console.log('消した: ' + keys.length + ' 件');
}
