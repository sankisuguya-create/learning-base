/**
 * Loader.gs — 学習BASE の読み込み係（GAS に貼るのはこの1枚だけ。以後は貼り直さない）
 *
 * 正本は learning-base。中身（共通部品・各アプリのサーバー側のコード・画面のファイル）は jsDelivr から取ってきて実行する。
 * 更新は「ハブの platform シートの 版 を書き換える」だけ（反映は最大5分。すぐ反映するにはエディタで lbReload を実行）。
 *
 * 設置（1回だけ）
 *   1. このファイルを コード.gs に貼る（他のファイルは要らない）
 *   2. プロジェクトの設定 → スクリプト プロパティ → HUB_ID にハブのスプレッドシートの ID
 *   3. ハブに platform シートを作り、A1「版」・B1 にコミット番号（またはタグ）。A2「指紋」・B2 は任意（dist/manifest.json の server の値）
 *   4. エディタで lbSetup を実行（承認・自動実行の設置）→ ウェブアプリとしてデプロイ（自分として実行・ドメイン内の全員）
 *
 * 取ってくる順（実測：一時保存から読むと約120ms、jsDelivr から取ると約1.4秒。2026-11-09）
 *   1. 一時保存（CacheService。版ごと・最長6時間。1時間ごとに温め直す）
 *   2. jsDelivr（版で固定した URL。指紋が設定されていれば照合し、違えば実行しない）
 *   3. ハブの platform_code シート（jsDelivr から取れた時に写しを残す。jsDelivr が止まった時の予備）
 */
var LB_REPO = 'sankisuguya-create/learning-base';
var LB_CHUNK = 30000;            // CacheService の1件100KB。日本語は1字3バイトなので3万字で切る
var LB_VER_TTL = 300;            // 版の一時保存（秒）。版を書き換えてから反映するまでの最大の時間
var LB_CODE_TTL = 21600;         // 中身の一時保存（秒）。CacheService の上限
var LB_ = { ready: false, ver: '', sha: '' };

/* ---------- 画面・自動実行から呼ばれる入口（この名前は変えない） ---------- */

function doGet(e) {
  try { lbNeed_(); return LbPlatform.doGet(e || { parameter: {} }); }
  catch (err) { return lbErrorPage_(err); }
}
/** 学習BASE の画面（web/home.js など）からの呼び出し */
function lbCall(mod, name, args) { lbNeed_(); return LbPlatform.call(mod, name, args); }
/** 算数タイムアタックの画面からの呼び出し（算数TA の google.script.run の差し替えがこの名前で呼ぶ） */
function apiCall(unit, name, args) { lbNeed_(); return LbPlatform.appApi('tamath', unit, name, args); }
function lbNightly() { lbNeed_(); return LbPlatform.nightly(); }
function lbDaily() { lbNeed_(); return LbPlatform.daily(); }
function lbRollover() { lbNeed_(); return LbPlatform.rollover(); }
/** 時間切れで残った夜の処理の続き（算数TA が1回だけの自動実行で呼ぶ） */
function continueAll() { lbNeed_(); return LbPlatform.continueAll(); }
/** 1時間ごと：中身の一時保存を温め直す（児童が開いた時に取り直しで待たせない） */
function lbHourly() {
  var v = lbVersion_(true);
  lbText_('server.js', v.ver, v.sha, true);
  lbText_('html.json', v.ver, '', true);
}

/* ---------- エディタから実行する（所有者だけ） ---------- */

/** 承認と自動実行の設置。版・中身が読めるかも確かめる */
function lbSetup() {
  lbOwnerOnly_();
  lbNeed_();
  var want = { lbNightly: 23, lbRollover: 2, lbDaily: 3 }, have = {}, removed = [];
  var mine = { lbNightly: 1, lbRollover: 1, lbDaily: 1, lbHourly: 1, continueAll: 1 };
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    // 前の形（アプリの GAS を直接貼っていた時）の自動実行は、呼ぶ関数がもう無いので消す
    if (!mine[fn]) { ScriptApp.deleteTrigger(t); removed.push(fn); return; }
    have[fn] = true;
  });
  for (var fn in want) if (!have[fn]) ScriptApp.newTrigger(fn).timeBased().atHour(want[fn]).everyDays(1).create();
  if (!have.lbHourly) ScriptApp.newTrigger('lbHourly').timeBased().everyHours(1).create();
  var msg = '学習BASE の準備ができました（版 ' + LB_.ver + '）\n' + (removed.length ? '前の形の自動実行を消しました：' + removed.join('・') + '\n' : '') + LbPlatform.setup();
  console.log(msg);
  return msg;
}
/** 版を書き換えた後、5分待たずに反映する */
function lbReload() {
  lbOwnerOnly_();
  CacheService.getScriptCache().remove('lb:ver');
  console.log('版の一時保存を消しました。次に開いた時に読み直します');
}
/** いまの状態（版・一時保存・ハブの写し）を実行ログに出す */
function lbStatus() {
  lbOwnerOnly_();
  var out = [];
  try { var v = lbVersion_(true); out.push('版: ' + v.ver + (v.sha ? '（指紋あり）' : '（指紋なし）')); } catch (e) { out.push('版: × ' + e.message); }
  try { lbNeed_(); out.push('中身: ○ 読み込めた'); } catch (e2) { out.push('中身: × ' + e2.message); }
  console.log(out.join('\n'));
  return out.join('\n');
}

/* ---------- 読み込み ---------- */

function lbNeed_() {
  if (LB_.ready) return;
  var v = lbVersion_();
  var code = lbText_('server.js', v.ver, v.sha);
  (0, eval)(code);                                   // 大域に共通部品・入口の振り分け（LbPlatform）・各アプリを定義する
  LB_.ver = v.ver; LB_.sha = v.sha; LB_.ready = true;
}

/** ハブの platform シートの 版・指紋。5分保存する */
function lbVersion_(fresh) {
  var c = CacheService.getScriptCache(), hit = fresh ? null : c.get('lb:ver');
  if (hit) { var p = hit.split('|'); return { ver: p[0], sha: p[1] || '' }; }
  var id = String(PropertiesService.getScriptProperties().getProperty('HUB_ID') || '').trim();
  if (!id) throw new Error('スクリプト プロパティ HUB_ID（ハブのスプレッドシートの ID）が設定されていません');
  var sh = SpreadsheetApp.openById(id).getSheetByName('platform');
  if (!sh) throw new Error('ハブに platform シートがありません（A1「版」・B1 にコミット番号）');
  var ver = '', sha = '';
  sh.getDataRange().getValues().forEach(function (r) {
    var k = String(r[0]).trim(), val = String(r[1]).trim();
    if (k === '版') ver = val;
    if (k === '指紋') sha = val.toLowerCase();
  });
  if (!/^[0-9a-f]{7,40}$|^v[\w.\-]+$/.test(ver)) throw new Error('platform シートの 版 がコミット番号でもタグでもありません: ' + ver);
  c.put('lb:ver', ver + '|' + sha, LB_VER_TTL);
  return { ver: ver, sha: sha };
}

/** dist/<name> の中身。一時保存 → jsDelivr → ハブの写し の順。refresh なら一時保存を読んだ上で入れ直す（期限を延ばす） */
function lbText_(name, ver, sha, refresh) {
  var key = 'lb:' + name + ':' + ver, text = lbCacheGet_(key);
  if (text != null) { if (refresh) lbCachePut_(key, text); return text; }
  var url = 'https://cdn.jsdelivr.net/gh/' + LB_REPO + '@' + ver + '/dist/' + name, fetched = null, why = '';
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) fetched = res.getContentText('UTF-8');
    else why = 'jsDelivr ' + res.getResponseCode();
  } catch (e) { why = 'jsDelivr に届かない（' + e.message + '）'; }
  if (fetched != null) {
    if (sha && lbSha_(fetched) !== sha) throw new Error(name + ' の指紋が platform シートの指紋と違います。実行しません（版 ' + ver + '）');
    lbCachePut_(key, fetched);
    try { lbHubCopyPut_(name, ver, fetched); } catch (e2) { console.error('ハブの写しを残せません: ' + e2.message); }
    return fetched;
  }
  var copy = lbHubCopyGet_(name, ver);
  if (copy != null) { lbCachePut_(key, copy); return copy; }
  throw new Error(name + ' を読めません（' + why + '。ハブに版 ' + ver + ' の写しもありません）');
}

function lbSha_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function lbCacheGet_(key) {
  var c = CacheService.getScriptCache(), n = Number(c.get(key + ':n') || 0);
  if (!n) return null;
  var keys = []; for (var i = 0; i < n; i++) keys.push(key + ':' + i);
  var got = c.getAll(keys), s = '';
  for (var j = 0; j < n; j++) { if (got[keys[j]] == null) return null; s += got[keys[j]]; }
  return s;
}
function lbCachePut_(key, text) {
  var m = {}, n = Math.ceil(text.length / LB_CHUNK) || 1;
  for (var i = 0; i < n; i++) m[key + ':' + i] = text.slice(i * LB_CHUNK, (i + 1) * LB_CHUNK);
  m[key + ':n'] = String(n);
  try { CacheService.getScriptCache().putAll(m, LB_CODE_TTL); } catch (e) { console.error('一時保存に入れられません: ' + e.message); }
}
/**
 * ハブの platform_code シートに写しを残す（名前ごとに最新の版だけ。1セル3万字ずつ）。
 * - 各セルの頭に「#」を付ける：区切りの頭が「=」「+」だとスプレッドシートが数式として扱い、中身が壊れるため
 * - 版を変えた直後は大勢が同時に取りに来るので、ロックが取れた1つの実行だけが書く（取れなければ書かない）
 */
function lbHubCopyPut_(name, ver, text) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('HUB_ID'));
    var sh = ss.getSheetByName('platform_code') || ss.insertSheet('platform_code');
    var v = sh.getLastRow() ? sh.getDataRange().getValues() : [];
    if (v.some(function (r) { return r[0] === name && String(r[1]) === ver; })) return;
    var keep = v.filter(function (r) { return r[0] !== name; });
    for (var i = 0; i * LB_CHUNK < text.length; i++) keep.push([name, ver, i, '#' + text.slice(i * LB_CHUNK, (i + 1) * LB_CHUNK)]);
    sh.clearContents();
    if (keep.length) sh.getRange(1, 1, keep.length, 4).setValues(keep);
  } finally { lock.releaseLock(); }
}
function lbHubCopyGet_(name, ver) {
  try {
    var sh = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('HUB_ID')).getSheetByName('platform_code');
    if (!sh || !sh.getLastRow()) return null;
    var parts = sh.getDataRange().getValues().filter(function (r) { return r[0] === name && String(r[1]) === ver; })
      .sort(function (a, b) { return a[2] - b[2]; });
    if (!parts.length || parts.some(function (r) { return String(r[3]).charAt(0) !== '#'; })) return null;   // 壊れた写しは使わない
    return parts.map(function (r) { return String(r[3]).slice(1); }).join('');
  } catch (e) { return null; }
}

/** 画面のファイル（html.json）。アプリの画面を返す時だけ読む（呼び出しのたびには読まない） */
function lbFiles_() {
  if (typeof LB_FILES !== 'undefined' && LB_FILES) return LB_FILES;
  var v = lbVersion_();
  globalThis.LB_FILES = JSON.parse(lbText_('html.json', v.ver, ''));
  return LB_FILES;
}
/** 共通部品・振り分けが読み込み係に問い合わせる口 */
var LB_LOADER = { files: function () { return lbFiles_(); }, ver: function () { return LB_.ver; }, repo: LB_REPO };

function lbOwnerOnly_() {
  var a = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var e = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!a || a !== e) throw new Error('この関数は、所有者が Apps Script のエディタから実行してください');
}
function lbErrorPage_(err) {
  console.error('doGet: ' + (err && err.stack || err));
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width, initial-scale=1"><div lang="ja" style="font-family:\'BIZ UDPGothic\',\'Noto Sans CJK JP\',sans-serif;font-size:20px;padding:24px;line-height:1.7">' +
    'いま ひらけません。すこし まってから、ページを ひらきなおしてね。<br><small style="color:#616870">（先生へ：' +
    String(err && err.message || err).replace(/[<>&]/g, '') + '）</small></div>').setTitle('学習BASE');
}
