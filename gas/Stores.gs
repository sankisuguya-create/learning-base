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
 * 見つけたら台帳に写す（syncLegacy。lbSetup と移転の時）。写した後もプロパティは消さない（前の版に戻した時のため）。
 *
 * 速さ：台帳は一時保存に10分置く（練習は1問ごとに呼ぶので、毎回シートを読まない）。手で直した時は lbReload で消える
 */
var LbStores = (function () {
  var SHEET = 'app_sheets', HEAD = ['アプリ', '単元', 'スプレッドシート', '状態', '作成'];
  var CACHE_KEY = 'lb:stores', TTL = 600;
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
    var hub = Base.hub(), sh = LbSheets.sheet(hub, SHEET, HEAD, [1, 2]);
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
    var legacy = opts.legacyProp ? idOf(props.getProperty(opts.legacyProp)) : '';
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

  /** 前の形のプロパティ（props：{ 名前: 値 }。省略するとこのプロジェクトのもの）を台帳に写す。返す：写した行の数 */
  function syncLegacy(props) {
    props = props || PropertiesService.getScriptProperties().getProperties();
    var n = 0;
    Object.keys(props).sort().forEach(function (k) {
      LEGACY.forEach(function (L) {
        var m = L.re.exec(k), sid = m && idOf(props[k]);
        if (sid && add(L.app, L.unit(m), sid, '前の形から写した')) n++;
      });
    });
    return n;
  }

  return { SHEET: SHEET, HEAD: HEAD, LEGACY: LEGACY, list: list, find: find, id: id, open: open, ofApp: ofApp, add: add,
    syncLegacy: syncLegacy, forget: forget, idOf: idOf, urlOf: urlOf };
})();
