/**
 * Stores.gs — 教科の記録のスプレッドシートの台帳（LbStores）
 *
 * 正本は learning-base。BASEシートの app_sheets シートが、「どの教科・単元が、どのスプレッドシートに記録を貯めるか」を持つ。
 * 教科ごとに GAS は作らない。学習BASE の GAS 1つが、台帳の ID でそれぞれのスプレッドシートを開いて読み書きする
 * （スプレッドシートに GAS が付いている必要はない）。
 *
 *   app_sheets：アプリ | 単元 | スプレッドシート（URL） | 状態 | 作成
 *     - 単元：算数TA は単元の id（kuku など）。単元を持たない教科（国語など）は空
 *     - 状態：空＝使う。「止める」と書くと、その行は読まない（集計にも入らない）
 *     - 行が無い教科・単元は、アプリが頼んだ時に学習BASE がスプレッドシートを作り、BASEシートと同じフォルダに置いて行を足す
 *
 * 前の形（スクリプトのプロパティに ID を持っていた：算数TA の unit_sheet:<id>・漢字の森の KANZI_SS_ID）は、
 * 台帳に写す（syncLegacy。lbSetup と移転の時に1回だけ）。写した後もプロパティは消さない（前の版に戻した時のため）が、もう読まない。
 *   → 台帳の行を消す＝次にその教科・単元が使われた時に新しいスプレッドシートを作る／「止める」＝使わない
 *
 * 速さ：台帳は一時保存に10分置く（練習は1問ごとに呼ぶので、毎回シートを読まない）。手で直した時は lbReload で消える
 */
var LbStores = (function () {
  var SHEET = 'app_sheets', HEAD = ['アプリ', '単元', 'スプレッドシート', '状態', '作成'];
  var CACHE_KEY = 'lb:stores', TTL = 600, DONE_KEY = 'LB_STORES_LEGACY_DONE';
  /** 前の形のプロパティ → 台帳の行 */
  var LEGACY = [
    { re: /^unit_sheet:([a-z0-9_-]+)$/, app: 'tamath', unit: function (m) { return m[1]; } },
    { re: /^KANZI_SS_ID$/, app: 'kanzi', unit: function () { return ''; } }
  ];
  var memo = null;

  function idOf(v) {
    var s = String(v == null ? '' : v).trim(), m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(s);
    if (m) return m[1];
    return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
  }
  function urlOf(id) { return 'https://docs.google.com/spreadsheets/d/' + id + '/edit'; }
  function key(app, unit) { return String(app || '') + '|' + String(unit || ''); }

  /** 台帳の全行 [{ app, unit, id, on }] */
  function list() {
    if (memo) return memo;
    var c = CacheService.getScriptCache(), hit = null;
    try { hit = c.get(CACHE_KEY); } catch (e) {}
    if (hit) { try { return (memo = JSON.parse(hit)); } catch (e) {} }
    var out = LbSheets.rows(Base.hub(), SHEET, 4).map(function (r) {
      return { app: String(r[0] || '').trim(), unit: String(r[1] || '').trim(), id: idOf(r[2]), on: String(r[3] || '').trim() !== '止める' };
    }).filter(function (r) { return r.app; });
    try { c.put(CACHE_KEY, JSON.stringify(out), TTL); } catch (e) {}
    return (memo = out);
  }
  function forget() { memo = null; try { CacheService.getScriptCache().remove(CACHE_KEY); } catch (e) {} }
  function find(app, unit) {
    var k = key(app, unit), rows = list();
    for (var i = 0; i < rows.length; i++) if (key(rows[i].app, rows[i].unit) === k) return rows[i];
    return null;
  }

  /** 台帳に1行足す（同じアプリ・単元が既にあれば足さない）。返す：足したか */
  function add(app, unit, id, note) {
    var hub = Base.hub(), sh = LbSheets.sheet(hub, SHEET, HEAD, [1, 2, 5]);   // アプリ・単元・作成日は文字（単元名・日付が日付や数式に化けないように）
    forget();
    if (find(app, unit)) return false;
    sh.appendRow([app, unit || '', urlOf(id), '', note || LbSheets.day()]);
    forget();
    return true;
  }

  /**
   * その教科・単元の記録のスプレッドシートの ID。無ければ ''。
   *   opts.legacyProp：前の形のプロパティの名前（台帳に無くてプロパティにあれば、台帳に写して使う）
   *   opts.create   ：台帳にもプロパティにも無い時に作るスプレッドシートの名前（省略すると作らない）
   *   opts.peek     ：台帳に書かない（ホームを開くたびに呼ぶ所で使う）
   * 「止める」の行があれば ''（プロパティにあっても使わない：先生が止めたものを勝手に戻さない）
   */
  function id(app, unit, opts) {
    opts = opts || {};
    var r = find(app, unit);
    if (r) return r.on ? r.id : '';
    var props = PropertiesService.getScriptProperties();
    // 前の形のプロパティは、台帳へ写し終えるまでだけ読む（写した後に先生が消した行を、プロパティから勝手に戻さない）
    var legacy = opts.legacyProp && !props.getProperty(DONE_KEY) ? idOf(props.getProperty(opts.legacyProp)) : '';
    if (legacy) { if (!opts.peek) add(app, unit, legacy, '前の形から写した'); return legacy; }
    if (!opts.create || opts.peek) return '';
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      forget();
      r = find(app, unit);
      if (r) return r.on ? r.id : '';
      var ss = SpreadsheetApp.create(String(opts.create));
      besideBase(ss.getId());
      add(app, unit, ss.getId(), LbSheets.day());
      return ss.getId();
    } finally { lock.releaseLock(); }
  }
  function open(app, unit, opts) { var i = id(app, unit, opts); return i ? SpreadsheetApp.openById(i) : null; }
  /** そのアプリの使う行（止めたものを除く） */
  function ofApp(app) { return list().filter(function (r) { return r.app === app && r.on && r.id; }); }

  /** 作ったスプレッドシートを BASEシートと同じフォルダへ（動かせなければマイドライブのまま。権限は Loader の lbScopes_） */
  function besideBase(fileId) {
    try {
      var parents = DriveApp.getFileById(Base.hubId() || Base.hub().getId()).getParents();
      if (parents.hasNext()) DriveApp.getFileById(fileId).moveTo(parents.next());
    } catch (e) { console.error('記録のスプレッドシートを BASEシートのフォルダへ動かせません（マイドライブにあります）: ' + e.message); }
  }

  /**
   * 前の形のプロパティを台帳に写す（1回だけ。写し終えたら印 LB_STORES_LEGACY_DONE を置き、以後はプロパティを読まない）。
   * 返す：写した行の数
   */
  /** 台帳のシートを用意する（行が1つも無くても、見出しだけのシートを置く。先生が「どこに書くか」を探さずに済むように） */
  function ensure() { return LbSheets.sheet(Base.hub(), SHEET, HEAD, [1, 2, 5]); }
  function syncLegacy() {
    var P = PropertiesService.getScriptProperties();
    if (P.getProperty(DONE_KEY)) return 0;
    var props = P.getProperties(), n = 0;
    Object.keys(props).sort().forEach(function (k) {
      LEGACY.forEach(function (L) {
        var m = L.re.exec(k), sid = m && idOf(props[k]);
        if (sid && add(L.app, L.unit(m), sid, '前の形から写した')) n++;
      });
    });
    P.setProperty(DONE_KEY, LbSheets.day());
    return n;
  }

  /**
   * 算数TA のハブ（links シートの sheet 列＝単元ごとの記録のスプレッドシート）から、台帳の tamath の行を一括でつなぎ直す（1回だけ。印 LB_HUB_LINKED）。
   * 学習BASE に入る前に単元ごとの GAS で貯めた記録（図形の育ち・記録・ランキング）を引き継ぐため。
   * ハブ：移転した後は旧ハブ（LB_MOVED_FROM）、移転前は今のハブ。台帳に同じ単元の行があり、別のシートなら置き換える（学習BASE が作った空のシート）。
   * 返す：報告の文（何もしなければ ''）
   */
  function linkFromHub() {
    var P = PropertiesService.getScriptProperties();
    if (P.getProperty('LB_HUB_LINKED')) return '';
    var from = String(P.getProperty('LB_MOVED_FROM') || ''), hub;
    try { hub = from ? SpreadsheetApp.openById(from) : Base.hub(); } catch (e) { return 'ハブから単元のシートをつなぐ：× 旧ハブを開けません（' + e.message + '）'; }
    var lk = hub.getSheetByName('links');
    if (!lk || lk.getLastRow() < 2) { P.setProperty('LB_HUB_LINKED', LbSheets.day()); return ''; }
    var v = lk.getDataRange().getValues(), head = v[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var ci = head.indexOf('id'), cs = head.indexOf('sheet');
    if (ci < 0 || cs < 0) { P.setProperty('LB_HUB_LINKED', LbSheets.day()); return 'ハブから単元のシートをつなぐ：links に id・sheet の列がありません'; }
    var sh = LbSheets.sheet(Base.hub(), SHEET, HEAD, [1, 2, 5]), rows = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues() : [];
    var added = [], replaced = [], same = 0;
    for (var i = 1; i < v.length; i++) {
      var unit = String(v[i][ci] || '').trim(), sid = idOf(v[i][cs]);
      if (!/^[a-z0-9_-]+$/.test(unit) || !sid) continue;
      var at = -1;
      for (var j = 0; j < rows.length; j++) if (String(rows[j][0]).trim() === 'tamath' && String(rows[j][1]).trim() === unit) { at = j; break; }
      if (at < 0) { sh.appendRow(['tamath', unit, urlOf(sid), '', 'ハブから ' + LbSheets.day()]); added.push(unit); continue; }
      var cur = idOf(rows[at][2]);
      if (cur === sid) { same++; continue; }
      sh.getRange(at + 2, 3).setValue(urlOf(sid));
      sh.getRange(at + 2, 5).setValue('ハブから ' + LbSheets.day() + '（前：' + cur + '）');
      replaced.push(unit);
    }
    forget();
    P.setProperty('LB_HUB_LINKED', LbSheets.day());
    if (!added.length && !replaced.length) return '';
    return 'ハブから単元のシートをつないだ：置き換え ' + replaced.length + ' 件' + (replaced.length ? '（' + replaced.join('・') + '）' : '') +
      '・足した ' + added.length + ' 件' + (added.length ? '（' + added.join('・') + '）' : '') + (same ? '・同じ ' + same + ' 件' : '') +
      (replaced.length ? '\n  置き換えた単元で学習BASE に入ってから解いた分は、前のシート（作成の欄の「前：」の ID）に残っています' : '');
  }

  return { SHEET: SHEET, linkFromHub: linkFromHub, HEAD: HEAD, LEGACY: LEGACY, list: list, find: find, id: id, open: open, ofApp: ofApp, add: add,
    syncLegacy: syncLegacy, ensure: ensure, forget: forget, idOf: idOf, urlOf: urlOf };
})();
