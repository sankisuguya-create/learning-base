/**
 * Loader.gs — 学習BASE の読み込み係（GAS に貼るのはこの1枚だけ。以後は貼り直さない）
 *
 * 正本は learning-base。中身（共通部品・各アプリのサーバー側のコード・画面のファイル）は jsDelivr から取ってきて実行する。
 * 更新：learning-base の main に PR がマージされると、GitHub の自動処理が検査を通した上で release.json（版と指紋）を書く。
 *   読み込み係はそれを読んで、5分以内に新しい版にする（PR のマージが「学校に出してよい」の承認になる）。
 *   戻す・止める時は、BASEシートの platform シートの「版」にコミット番号を書く（その版で固定。「自動」と書くか空にすれば再び追う）。
 *
 * 設置（1回だけ）
 *   1. BASEシート（学習BASE の本体のスプレッドシート）で「拡張機能 → Apps Script」を開き、このファイルを コード.gs に貼る（他のファイルは要らない）
 *   2. エディタで lbSetup を実行（承認・自動実行の設置）→ ウェブアプリとしてデプロイ（自分として実行・ドメイン内の全員）→ もう一度 lbSetup
 *   （BASEシートに付けた GAS なら設定は要らない。スクリプト プロパティ HUB_ID は、前の形＝算数TA のハブを使う GAS の時だけ）
 *   旧GAS（算数TA のハブを使っていた学習BASE）から移る時は README「BASEシートへの移転」：旧GAS にもこのファイルを貼り、lbMoveOut を実行する
 *   （platform シートは要らない。無い・「版」が空・「自動」なら release.json に従う）
 *
 * 読む量（2026-11-17 から）：毎回読むのは共通部品（dist/core.js）だけ。教科（アプリ）のコードは、その教科を使う時だけ
 *   dist/app-<id>.js を読む（教科を足しても1回に読む量が増えない）。どのファイルも dist/manifest.json の指紋と照らし合わせてから実行する。
 *   manifest に files が無い古い版（戻した時など）は、前の形の dist/server.js（全部入り）を読む
 *
 * 取ってくる順（実測：一時保存から読むと約120ms、jsDelivr から取ると約1.4秒。2026-11-09）
 *   1. 一時保存（CacheService。版ごと・最長6時間。1時間ごとに温め直す）
 *   2. jsDelivr（版で固定した URL。指紋が設定されていれば照合し、違えば実行しない）
 *   3. BASEシートの platform_code シート（jsDelivr から取れた時に写しを残す。jsDelivr が止まった時の予備）
 */
var LB_REPO = 'sankisuguya-create/learning-base';
var LB_CHUNK = 30000;            // CacheService の1件100KB。日本語は1字3バイトなので3万字で切る
var LB_VER_TTL = 300;            // 版の一時保存（秒）。マージ・版の書き換えから反映するまでの最大の時間
var LB_RELEASE_URL = 'https://raw.githubusercontent.com/' + LB_REPO + '/main/release.json';   // GitHub から直接（jsDelivr の @main は古いことがある）
var LB_CODE_TTL = 21600;         // 中身の一時保存（秒）。CacheService の上限
var LB_ = { ready: false, ver: '', sha: '' };

/* ---------- 画面・自動実行から呼ばれる入口（この名前は変えない） ---------- */

function doGet(e) {
  try { var q = (e && e.parameter) || {}; lbNeed_(q.app || (q.unit ? 'tamath' : '')); return LbPlatform.doGet(e || { parameter: {} }); }
  catch (err) { return lbErrorPage_(err); }
}
/** 学習BASE の画面（web/home.js など）からの呼び出し */
function lbCall(mod, name, args) { var am = /^app:([a-z][a-z0-9-]*)$/.exec(String(mod)); lbNeed_(am ? am[1] : ''); return LbPlatform.call(mod, name, args); }
/** 算数タイムアタックの画面からの呼び出し（算数TA の google.script.run の差し替えがこの名前で呼ぶ） */
function apiCall(unit, name, args) { lbNeed_('tamath'); return LbPlatform.appApi('tamath', unit, name, args); }
function lbNightly() { lbNeed_(); return LbPlatform.nightly(); }
function lbDaily() { lbNeed_(); return LbPlatform.daily(); }
function lbRollover() { lbNeed_(); return LbPlatform.rollover(); }
/** 月曜の朝：今週の3件の件数を先生にメールで知らせる */
function lbWeekly() { lbNeed_(); return LbPlatform.weekly(); }
/** 時間切れで残った夜の処理の続き（算数TA が1回だけの自動実行で呼ぶ） */
function continueAll() { lbNeed_(); return LbPlatform.continueAll(); }
/** 1時間ごと：中身の一時保存を温め直す（児童が開いた時に取り直しで待たせない）。共通部品と全教科のファイル */
function lbHourly() {
  var v = lbVersion_(true), m = lbManifest_(v, true);
  if (!m.files) { lbText_('server.js', v.ver, m.server || '', true); lbText_('html.json', v.ver, '', true); return; }
  Object.keys(m.files).forEach(function (f) { if (f !== 'server.js' && f !== 'html.json') lbText_(f, v.ver, m.files[f], true); });
}

/* ---------- エディタから実行する（所有者だけ） ---------- */

/** 承認と自動実行の設置。版・中身が読めるかも確かめる */
function lbSetup() {
  lbOwnerOnly_();
  lbNeed_();
  var want = { lbNightly: 23, lbRollover: 2, lbDaily: 3 }, have = {}, removed = [];
  var mine = { lbNightly: 1, lbRollover: 1, lbDaily: 1, lbHourly: 1, lbWeekly: 1, continueAll: 1 };
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    // 前の形（アプリの GAS を直接貼っていた時）の自動実行は、呼ぶ関数がもう無いので消す
    if (!mine[fn]) { ScriptApp.deleteTrigger(t); removed.push(fn); return; }
    have[fn] = true;
  });
  for (var fn in want) if (!have[fn]) ScriptApp.newTrigger(fn).timeBased().atHour(want[fn]).everyDays(1).create();
  if (!have.lbHourly) ScriptApp.newTrigger('lbHourly').timeBased().everyHours(1).create();
  if (!have.lbWeekly) ScriptApp.newTrigger('lbWeekly').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).nearMinute(40).create();
  var msg = '学習BASE の準備ができました（版 ' + LB_.ver + '）\n' + (removed.length ? '前の形の自動実行を消しました：' + removed.join('・') + '\n' : '') + LbPlatform.setup();
  console.log(msg);
  return msg;
}
/**
 * 旧GAS で1回だけ実行：学習BASE を新しい BASEシートへ移す（下の URL を新しいスプレッドシートのものに書き換えて実行）。
 * 学習BASE のシート・教科の記録の紐付け・設定を写し、旧GAS の自動実行を止める。結果は実行ログに
 */
function lbMoveOut(url) {
  lbOwnerOnly_();
  url = url || 'ここに新しいBASEシートのURLを貼る';
  lbNeed_();
  var msg = LbMove.out(url);
  console.log(msg);
  return msg;
}
/** 版を書き換えた後・台帳（app_sheets）を手で直した後、待たずに反映する */
function lbReload() {
  lbOwnerOnly_();
  CacheService.getScriptCache().removeAll(['lb:ver', 'lb:stores', 'lb:moved']);
  console.log('版の一時保存を消しました。次に開いた時に読み直します');
}
/** いまの状態（版・一時保存・BASEシートの写し）を実行ログに出す */
function lbStatus() {
  lbOwnerOnly_();
  var out = [];
  try { var v = lbVersion_(true); out.push('版: ' + v.ver + '（' + v.mode + '・' + (v.msha || v.sha ? '指紋あり' : '指紋なし') + '）'); } catch (e) { out.push('版: × ' + e.message); }
  try { lbNeed_(); out.push('中身: ○ 読み込めた（' + (LB_.m && LB_.m.files ? '教科ごとに読む形' : '前の形：全部入り') + '）'); } catch (e2) { out.push('中身: × ' + e2.message); }
  try { (typeof LB_APP_IDS !== 'undefined' ? LB_APP_IDS : []).forEach(function (id) { var m = lbApp_(id) || LB_MODULES[id]; out.push('教科 ' + id + ': ' + (m && m.broken ? '× ' + m.broken : '○')); }); } catch (e3) { out.push('教科: × ' + e3.message); }
  console.log(out.join('\n'));
  return out.join('\n');
}

/* ---------- 読み込み ---------- */

/**
 * 共通部品（と、分かっていればその呼び出しで使う教科）を読み込む。
 * 一時保存への往復を減らす（2026-11-18）：目録（manifest）は版と一緒に覚えておき（lbVersion_）、分けた個数は目録の字数から計算し、
 * 共通部品と教科の中身を1回の getAll でまとめて読む。ふだん（一時保存にある時）は、版の1回＋中身の1回の2往復
 */
function lbNeed_(hint) {
  if (LB_.ready) return;
  var v = lbVersion_(), m = v.m;
  LB_.ver = v.ver; LB_.sha = v.sha; LB_.m = m; LB_.mver = v.ver; LB_.mv = v.mv || null;
  if (!m || !m.files || !m.files['core.js']) {                     // 前の形の版：全部入り
    if (!m) m = LB_.m = lbManifest_(v);
    if (!m.files || !m.files['core.js']) { (0, eval)(lbText_('server.js', v.ver, m.server || v.sha)); LB_.ready = true; return; }
  }
  var names = ['core.js'], app = hint && m.files['app-' + hint + '.js'] ? 'app-' + hint + '.js' : '';
  if (app) names.push(app);
  var got = {}, appErr = null;
  try { got = lbTexts_(names, v.ver, m); }
  catch (e) { if (!app) throw e; appErr = e; got = lbTexts_(['core.js'], v.ver, m); }   // 教科のファイルだけが読めない時は、共通部品は動かす
  (0, eval)(got['core.js']);                                       // 共通部品と振り分け（LbPlatform）
  // その呼び出しで使う教科（ほかの教科は要る時に LB_LOADER.app）。読めない・指紋が合わない時は、その教科だけ止める
  if (app && !appErr) { try { (0, eval)(got[app]); } catch (e2) { appErr = e2; } }
  if (appErr) { LB_MODULES[hint] = { broken: String(appErr && appErr.message || appErr) }; console.error('教科 ' + hint + ' を読み込めません: ' + LB_MODULES[hint].broken); }
  LB_.ready = true;
}
/**
 * いくつかのファイルを読む。一時保存にあるものは1回の getAll でまとめて読み（キーは目録の字数から計算）、無いものだけ1つずつ取ってくる。
 * どれも目録の指紋と照らし合わせる（一時保存に入れる時に照らし合わせ済み。取ってくるものは lbText_ が照らし合わせる）
 */
function lbTexts_(names, ver, m) {
  var keys = [], plan = {}, out = {};
  names.forEach(function (n) {
    var len = m.chars && m.chars[n], k = Math.ceil((len || 0) / LB_CHUNK) || 1, base = 'lb:' + n + ':' + ver;
    plan[n] = [];
    for (var i = 0; i < k; i++) { plan[n].push(base + ':' + i); keys.push(base + ':' + i); }
    keys.push(base + ':n');
  });
  var c = CacheService.getScriptCache(), hit = {};
  try { hit = c.getAll(keys); } catch (e) { hit = {}; }
  names.forEach(function (n) {
    var parts = plan[n], ok = hit['lb:' + n + ':' + ver + ':n'] === String(parts.length) && parts.every(function (k) { return hit[k] != null; });
    out[n] = ok ? parts.map(function (k) { return hit[k]; }).join('') : lbText_(n, ver, m.files[n]);
  });
  return out;
}
/** 目録（dist/manifest.json）。ふだんは lbVersion_ が版と一緒に覚えている */
function lbManifest_(v, refresh) {
  if (!refresh && v.m) return v.m;
  if (!refresh && LB_.m && LB_.mver === v.ver) return LB_.m;
  var m = JSON.parse(lbText_('manifest.json', v.ver, v.msha || '', refresh));
  LB_.m = m; LB_.mver = v.ver;
  return m;
}
/** 教科（アプリ）のサーバーのコードを読む（1回の実行で1回だけ）。前の形の版では server.js に全部入っているので何もしない */
function lbApp_(id) {
  if (!/^[a-z][a-z0-9-]*$/.test(String(id))) throw new Error('アプリの名前が不正です: ' + id);
  if (typeof LB_MODULES !== 'undefined' && LB_MODULES[id]) return LB_MODULES[id];
  var m = LB_.m || lbManifest_(lbVersion_()), name = 'app-' + id + '.js';
  if (!m.files) return null;
  if (!m.files[name]) throw new Error('この版に教科 ' + id + ' はありません');
  (0, eval)(lbTexts_([name], LB_.ver, m)[name]);
  return LB_MODULES[id];
}

/**
 * 使う版と指紋。5分保存する。
 * - BASEシートの platform シートの「版」にコミット番号（またはタグ）があれば、その版で固定（指紋は同じシートの「指紋」）
 * - 無い・空・「自動」なら、GitHub の release.json（main にマージされた版）に従う。取れない時は最後に取れた版
 */
function lbVersion_(fresh) {
  var c = CacheService.getScriptCache(), hit = fresh ? null : c.get('lb:ver');
  if (hit && hit.charAt(0) === '{') { try { return JSON.parse(hit); } catch (e) {} }   // 版と目録（前の形の 'ver|sha|…' は読み直す）
  var sh = lbBook_().getSheetByName('platform');
  var ver = '', sha = '', mode = '固定', mv = null;
  if (sh) sh.getDataRange().getValues().forEach(function (r) {
    var k = String(r[0]).trim(), val = String(r[1]).trim();
    if (k === '版') ver = val;
    if (k === '指紋') sha = val.toLowerCase();
    if (k === '移転先シート' && val) (mv = mv || {}).to = val;   // 移転した後の旧GAS（LbMove.moved）
    if (k === '移転先URL') (mv = mv || {}).url = val;
  });
  if (mv && !mv.to) mv = null;
  var msha = sha;   // platform シートの「指紋」は manifest.json の指紋（新しい形）。前の形の server.js の指紋なら下で使う
  if (!ver || ver === '自動') {
    var rel = lbRelease_();
    ver = rel.ver; sha = rel.sha; msha = rel.msha || ''; mode = '自動';
  }
  if (!/^[0-9a-f]{7,40}$|^v[\w.\-]+$/.test(ver)) throw new Error('platform シートの 版 がコミット番号でもタグでもありません: ' + ver + '（自動に戻すなら「自動」と書くか空にする）');
  var out = { ver: ver, sha: sha, mode: mode, msha: msha, m: null, mv: mv };
  try { out.m = lbManifest_(out, !!fresh); } catch (e) { console.error('目録を読めません: ' + e.message); }   // 目録も一緒に覚える（呼び出しのたびに読まない）
  if (out.m) c.put('lb:ver', JSON.stringify(out), LB_VER_TTL);
  return out;
}
/** GitHub の release.json（{ ver, sha }）。取れたら覚えておき、取れない時は覚えた版を返す */
function lbRelease_() {
  var props = PropertiesService.getScriptProperties(), why = '';
  try {
    var res = UrlFetchApp.fetch(LB_RELEASE_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      var j = JSON.parse(res.getContentText('UTF-8'));
      if (j && /^[0-9a-f]{40}$/.test(String(j.ver))) {
        var rs = String(j.sha || '').toLowerCase(), rm = String(j.manifest || '').toLowerCase();
        props.setProperty('LB_RELEASE', j.ver + '|' + rs + '|' + rm);
        return { ver: j.ver, sha: rs, msha: rm };
      }
      why = 'release.json の形が違う';
    } else why = 'release.json ' + res.getResponseCode();
  } catch (e) { why = 'GitHub に届かない（' + e.message + '）'; }
  var last = String(props.getProperty('LB_RELEASE') || '');
  if (last) { var p = last.split('|'); console.error(why + '。最後に取れた版 ' + p[0].slice(0, 7) + ' で動きます'); return { ver: p[0], sha: p[1] || '', msha: p[2] || '' }; }
  throw new Error('使う版が決まりません（' + why + '。BASEシートの platform シートの「版」にコミット番号を書けば、その版で動きます）');
}

/** dist/<name> の中身。一時保存 → jsDelivr → BASEシートの写し の順。refresh なら一時保存を読んだ上で入れ直す（期限を延ばす） */
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
    if (sha && lbSha_(fetched) !== sha) throw new Error(name + ' の指紋が合いません。実行しません（版 ' + ver + '）');
    lbCachePut_(key, fetched);
    try { lbHubCopyPut_(name, ver, fetched); } catch (e2) { console.error('BASEシートの写しを残せません: ' + e2.message); }
    return fetched;
  }
  var copy = lbHubCopyGet_(name, ver);
  if (copy != null) { lbCachePut_(key, copy); return copy; }
  throw new Error(name + ' を読めません（' + why + '。BASEシートに版 ' + ver + ' の写しもありません）');
}

/** BASEシート：この GAS が付いているスプレッドシート。前の形（HUB_ID がある GAS）は HUB_ID のもの */
function lbBook_() {
  var id = String(PropertiesService.getScriptProperties().getProperty('HUB_ID') || '').trim();
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('BASEシートが分かりません（BASEシートの「拡張機能 → Apps Script」で開いた GAS に貼ってください）');
  return ss;
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
 * BASEシートの platform_code シートに写しを残す（名前ごとに最新の版だけ。1セル3万字ずつ）。
 * - 各セルの頭に「#」を付ける：区切りの頭が「=」「+」だとスプレッドシートが数式として扱い、中身が壊れるため
 * - 版を変えた直後は大勢が同時に取りに来るので、ロックが取れた1つの実行だけが書く（取れなければ書かない）
 */
function lbHubCopyPut_(name, ver, text) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    var ss = lbBook_();
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
    var sh = lbBook_().getSheetByName('platform_code');
    if (!sh || !sh.getLastRow()) return null;
    var parts = sh.getDataRange().getValues().filter(function (r) { return r[0] === name && String(r[1]) === ver; })
      .sort(function (a, b) { return a[2] - b[2]; });
    if (!parts.length || parts.some(function (r) { return String(r[3]).charAt(0) !== '#'; })) return null;   // 壊れた写しは使わない
    return parts.map(function (r) { return String(r[3]).slice(1); }).join('');
  } catch (e) { return null; }
}

/** 画面のファイル。教科のページを返す時に、その教科の分（dist/html-<id>.json）だけ読む。前の形の版は html.json（全部） */
function lbFiles_(id) {
  if (typeof LB_FILES === 'undefined' || !LB_FILES) globalThis.LB_FILES = {};
  LB_.files = LB_.files || {};
  var m = LB_.m || lbManifest_(lbVersion_()), name = m.files && id ? 'html-' + id + '.json' : 'html.json';
  if (LB_.files[name]) return LB_FILES;
  if (m.files && !m.files[name]) return LB_FILES;                  // 画面のファイルを持たない教科
  var got = JSON.parse(m.files ? lbTexts_([name], LB_.ver, m)[name] : lbText_(name, LB_.ver, ''));
  for (var k in got) LB_FILES[k] = got[k];
  LB_.files[name] = true;
  return LB_FILES;
}
/** 共通部品・振り分けが読み込み係に問い合わせる口 */
var LB_LOADER = { files: function (id) { return lbFiles_(id); }, app: function (id) { return lbApp_(id); }, ver: function () { return LB_.ver; }, repo: LB_REPO, moved: function () { return LB_.mv || null; } };

/**
 * 権限の宣言（呼ばない）。GAS は貼られたファイルに書かれた命令を見て承認を求める権限を決めるので、
 * jsDelivr から取ってくるコードだけが使う機能（メール・ドキュメント）は、ここに書いておかないと承認の対象にならない。
 * MailApp：今週の3件のメール／DocumentApp：NotebookLM 用の書き出し（段階E）／DriveApp：教科の記録のスプレッドシートを BASEシートのフォルダに置く
 */
function lbScopes_() { MailApp.getRemainingDailyQuota(); DocumentApp.create; DriveApp.getRootFolder; SpreadsheetApp.create; }

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
