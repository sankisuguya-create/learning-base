// 写し：正本は gas/Pages.gs（tools/build.cjs が作る。直接直さない）
/**
 * Pages.gs — 学習BASE の入口（学習BASE → 教科 → ページ）と「いまの学習」
 *
 * 正本は learning-base。設計：`-` リポジトリ principles/learning-app-foundation.md §14「入口の階層」
 *
 * - ページの目録（catalog/pages.json）はリポジトリに置く。Claude が足す。教師はスプレッドシートで目録を作らない
 * - 教師が決めるのは学級ごとの「公開」と「いまの学習」だけ（ハブのシートに保存）
 * - 目録は公開のリポジトリにあり、児童名を含まない。画面（ブラウザ）が jsDelivr から直接読む
 * - このファイルは画面でも使う（web/pages.js は tools/build.cjs が作るこのファイルの写し）。
 *   判定の部分（validate・isOn・inPeriod・home・teacherView）は GAS の機能を使わずに書く（ブラウザでも動くように）
 *
 * 目録の形：
 * { version: 1, pages: [
 *   { id: 'tamath-kuku', subject: 'sansu', grades: [3], unit: 'かけ算', title: '九九 タイムアタック', ruby: 'くく タイムアタック',
 *     kind: 'app', app: 'tamath', params: { unit: 'kuku' }, order: 10, defaultOn: true },
 *   { id: 'sakubun-1', subject: 'kokugo', grades: [3, 4], unit: '作文', title: '…', kind: 'page',
 *     src: { repo: 'sankisuguya-create/worksheet-platform', path: 'pages/sakubun-1.js', ver: '<コミット>' } }
 * ] }
 */
var LbPages = (function () {
  /** 教科（並び順もこの順）。色では見分けない（教科は10以上あり、色で区別できるのは4つまで）。絵と名前で見分ける */
  var SUBJECTS = [
    { id: 'kokugo', label: '国語', ruby: 'こくご', low: 'こくご' },
    { id: 'shakai', label: '社会', ruby: 'しゃかい', low: 'しゃかい' },
    { id: 'sansu', label: '算数', ruby: 'さんすう', low: 'さんすう' },
    { id: 'rika', label: '理科', ruby: 'りか', low: 'りか' },
    { id: 'seikatsu', label: '生活', ruby: 'せいかつ', low: 'せいかつ' },
    { id: 'ongaku', label: '音楽', ruby: 'おんがく', low: 'おんがく' },
    { id: 'zuko', label: '図工', ruby: 'ずこう', low: 'ずこう' },
    { id: 'katei', label: '家庭', ruby: 'かてい', low: 'かてい' },
    { id: 'taiiku', label: '体育', ruby: 'たいいく', low: 'たいいく' },
    { id: 'gaikokugo', label: '外国語', ruby: 'がいこくご', low: 'えいご' },
    { id: 'dotoku', label: '道徳', ruby: 'どうとく', low: 'どうとく' },
    { id: 'sogo', label: '総合', ruby: 'そうごう', low: 'そうごう' },
    { id: 'other', label: 'その他', ruby: 'そのほか', low: 'そのほか' }
  ];
  var SUBJECT_IDS = SUBJECTS.map(function (s) { return s.id; });
  var NOW_MAX = 3;                       // いまの学習は3件まで（多いと「いま」が分からなくなる）
  var PUB_SHEET = 'class_pages', PUB_HEAD = ['学級', 'ページ', '公開', '更新', '教師'];
  var NOW_SHEET = 'now_learning', NOW_HEAD = ['学級', 'ページ', '順', 'から', 'まで', '更新', '教師'];

  /* ---------- 目録 ---------- */

  function validate(cat) {
    var e = [];
    if (!cat || !Array.isArray(cat.pages)) return ['pages がありません'];
    var seen = {};
    cat.pages.forEach(function (p, i) {
      var w = 'pages[' + i + ']（' + (p && p.id) + '）';
      if (!p || !/^[a-z0-9][a-z0-9-]*$/.test(String(p.id || ''))) { e.push(w + ' の id は英小文字・数字・-'); return; }
      if (seen[p.id]) e.push('id が重複: ' + p.id);
      seen[p.id] = true;
      if (SUBJECT_IDS.indexOf(p.subject) < 0) e.push(w + ' の教科が不明: ' + p.subject);
      if (!Array.isArray(p.grades) || !p.grades.length || p.grades.some(function (g) { return !(g >= 1 && g <= 6); })) e.push(w + ' の grades は 1〜6 の配列');
      if (!p.title) e.push(w + ' に title がありません');
      if (p.kind === 'app') { if (!/^[a-z][a-z0-9-]*$/.test(String(p.app || ''))) e.push(w + ' の app が不正'); }
      else if (p.kind === 'page') {
        var s = p.src || {};
        if (!s.repo || !s.path || !/^[0-9a-f]{7,40}$|^v[\w.\-]+$/.test(String(s.ver || ''))) e.push(w + ' の src は repo・path・ver（コミットかタグ）');
      } else e.push(w + ' の kind は app か page');
    });
    return e;
  }

  /* ---------- 学級の設定（教師が決める） ---------- */

  /**
   * 学級の設定。{ publish: { ページ: true/false }, now: [{ page, order, from, to }] }
   * 公開：書かれていないページは目録の defaultOn（省略時 true）に従う
   */
  function isOn(page, settings) {
    var v = settings && settings.publish ? settings.publish[page.id] : undefined;
    if (v === true || v === false) return v;
    return page.defaultOn !== false;
  }
  /** 'YYYY-MM-DD' の範囲に today が入るか（from・to は空なら無制限） */
  function inPeriod(n, today) {
    return (!n.from || String(n.from) <= today) && (!n.to || today <= String(n.to));
  }

  /**
   * 児童のホームに出すもの。
   * 返す：{ now: [ページ], subjects: [{ id, label, ruby, low, count }], bySubject: { 教科: [{ unit, pages: [ページ] }] } }
   * - その学年のページだけ・公開のページだけ
   * - いまの学習：期間内のもの・公開しているもの・学年が合うものを順に最大3件
   * - 教科：その学年に公開のページがある教科だけ。ページが1つだけの教科は only にそのページ（タイルから直接開く）
   */
  function home(cat, grade, settings, today) {
    var g = Number(grade);
    var vis = (cat.pages || []).filter(function (p) { return p.grades.indexOf(g) >= 0 && isOn(p, settings); });
    var byId = {}; vis.forEach(function (p) { byId[p.id] = p; });
    var now = ((settings && settings.now) || []).filter(function (n) { return byId[n.page] && inPeriod(n, today); })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
      .slice(0, NOW_MAX).map(function (n) { return byId[n.page]; });
    var bySubject = {};
    vis.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0) || (a.title < b.title ? -1 : 1); }).forEach(function (p) {
      var units = bySubject[p.subject] || (bySubject[p.subject] = []);
      var u = units.filter(function (x) { return x.unit === (p.unit || ''); })[0];
      if (!u) { u = { unit: p.unit || '', pages: [] }; units.push(u); }
      u.pages.push(p);
    });
    var subjects = SUBJECTS.filter(function (s) { return bySubject[s.id]; }).map(function (s) {
      var count = bySubject[s.id].reduce(function (t, u) { return t + u.pages.length; }, 0);
      var o = { id: s.id, label: s.label, ruby: s.ruby, low: s.low, count: count };
      // 見せるページが1つだけの教科は、教科の画面を挟まずにそのページを開く（押す回数を1回減らす）
      if (count === 1) o.only = bySubject[s.id][0].pages[0];
      return o;
    });
    return { now: now, subjects: subjects, bySubject: bySubject };
  }

  /** 教師画面：その学年の全ページ（公開していないものも）と、いまの状態 */
  function teacherView(cat, grade, settings, today) {
    var g = Number(grade);
    var nowIds = ((settings && settings.now) || []).filter(function (n) { return inPeriod(n, today); }).map(function (n) { return n.page; });
    return (cat.pages || []).filter(function (p) { return p.grades.indexOf(g) >= 0; }).map(function (p) {
      return { page: p, on: isOn(p, settings), now: nowIds.indexOf(p.id) >= 0 };
    });
  }

  /* ---------- 保存（ハブのシート） ---------- */

  /** その学級の設定を読む */
  function readSettings(hubSs, classKey) {
    var out = { publish: {}, now: [] };
    var ps = hubSs.getSheetByName(PUB_SHEET);
    if (ps && ps.getLastRow() > 1) ps.getRange(2, 1, ps.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (String(r[0]) === classKey && r[1]) out.publish[String(r[1])] = r[2] === true || String(r[2]).toUpperCase() === 'TRUE';
    });
    var ns = hubSs.getSheetByName(NOW_SHEET);
    if (ns && ns.getLastRow() > 1) ns.getRange(2, 1, ns.getLastRow() - 1, 5).getValues().forEach(function (r) {
      if (String(r[0]) === classKey && r[1]) out.now.push({ page: String(r[1]), order: Number(r[2]) || 0, from: ymd(r[3]), to: ymd(r[4]) });
    });
    return out;
  }
  function ymd(v) {
    if (v instanceof Date) return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
    return String(v || '');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** 公開を切り替える（押すたびに保存）。その学級・そのページの行を書き換える（無ければ足す） */
  function setPublish(hubSs, classKey, pageId, on, by) {
    var sh = sheet(hubSs, PUB_SHEET, PUB_HEAD), v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (String(v[i][0]) === classKey && String(v[i][1]) === pageId) { sh.getRange(i + 1, 3, 1, 3).setValues([[!!on, new Date(), by || '']]); return; }
    }
    sh.appendRow([classKey, pageId, !!on, new Date(), by || '']);
  }

  /** その学級の公開を全部、目録の既定に戻す */
  function resetPublish(hubSs, classKey) {
    var sh = hubSs.getSheetByName(PUB_SHEET);
    if (!sh) return 0;
    var v = sh.getDataRange().getValues(), keep = [v[0]], n = 0;
    for (var i = 1; i < v.length; i++) { if (String(v[i][0]) === classKey) n++; else keep.push(v[i]); }
    sh.clearContents();
    sh.getRange(1, 1, keep.length, PUB_HEAD.length).setValues(keep.map(function (r) { return pad5(r); }));
    return n;
  }
  function pad5(r) { var o = r.slice(0, PUB_HEAD.length); while (o.length < PUB_HEAD.length) o.push(''); return o; }

  /**
   * いまの学習を置き換える（その学級の分を list で丸ごと入れ替える）。list：[{ page, from, to }]（順は並びのとおり）
   * 3件を越える分は捨てる
   */
  function setNow(hubSs, classKey, list, by) {
    var sh = sheet(hubSs, NOW_SHEET, NOW_HEAD), v = sh.getDataRange().getValues(), keep = [v[0]];
    for (var i = 1; i < v.length; i++) if (String(v[i][0]) !== classKey) keep.push(v[i]);
    (list || []).slice(0, NOW_MAX).forEach(function (n, k) { keep.push([classKey, n.page, k + 1, n.from || '', n.to || '', new Date(), by || '']); });
    sh.clearContents();
    sh.getRange(1, 1, keep.length, NOW_HEAD.length).setValues(keep.map(function (r) { var o = r.slice(0, NOW_HEAD.length); while (o.length < NOW_HEAD.length) o.push(''); return o; }));
  }

  function sheet(ss, name, head) {
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, head.length).setValues([head]); }
    return sh;
  }

  return { SUBJECTS: SUBJECTS, NOW_MAX: NOW_MAX, validate: validate, isOn: isOn, inPeriod: inPeriod, home: home, teacherView: teacherView,
    readSettings: readSettings, setPublish: setPublish, resetPublish: resetPublish, setNow: setNow };
})();
