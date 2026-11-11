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
 *     src: { repo: 'sankisuguya-create/worksheet-platform', path: 'pages/sakubun-1.js', ver: '<コミット>' } },
 *   { id: 'toi-board', subject: 'sogo', grades: [3], title: 'といボード', kind: 'link', linkId: 'toi-board' }
 *     … 別の GAS で動くもの。開く先の URL は公開の目録に書かず、ハブの links シートの id=linkId の行の url を使う
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
  var ORDER_SHEET = 'class_order', ORDER_HEAD = ['学級', '教科', '並び', '更新', '教師'];   // 先生モードでドラッグした教科の中の並び
  var COLOR_SHEET = 'class_colors', COLOR_HEAD = ['学級', 'ページ', '色', '更新', '教師'];   // 先生モードで選んだタイルの色
  /**
   * タイルの色（算数TA のハブ apps/hub/Code.gs の COLORS と同じ30色）：名前 → [地の色, 文字の色]。
   * 先生が学級ごとに選べる（無ければハブの links シートの color）。色だけで見分けさせない（題を必ず出す）
   */
  var TILE_COLORS = {
    mint: ['#12C48B', '#052A1F'], blue: ['#2B4CF2', '#F0F3FF'], amber: ['#FFC400', '#2E2200'], red: ['#FF5C38', '#2C0A02'],
    purple: ['#6D4AE0', '#F3EEFF'], gray: ['#4A5568', '#EEF1F6'], lavender: ['#D3C9FB', '#1C152F'], olive: ['#696713', '#F6F6EB'],
    wine: ['#900D2A', '#F7F7F7'], cyan: ['#0DA2C6', '#1A1A1A'], rose: ['#DE5F99', '#2C101C'], teal: ['#13745F', '#EBF9F4'],
    brown: ['#964D0C', '#FEF3EC'], peach: ['#FCC1B6', '#2E100C'], lime: ['#9EB919', '#181E01'], aqua: ['#2CECF2', '#1A1A1A'],
    plum: ['#80146F', '#FCF1F9'], periwinkle: ['#6B89F9', '#121932'], ochre: ['#CB7E19', '#1A1A1A'], sky: ['#A8D8FB', '#001D2F'],
    orchid: ['#CE88F7', '#22132B'], peacock: ['#1C6E80', '#EBF8FC'], green: ['#057918', '#EFF8EF'], pink: ['#FEA4D2', '#2B101F'],
    mustard: ['#AA9117', '#1A1A1A'], leaf: ['#97EB79', '#0E2007'], apricot: ['#FDB171', '#2B1401'], coral: ['#FB8087', '#2E1012'],
    turquoise: ['#16A7A3', '#1A1A1A'], cobalt: ['#1468A3', '#EDF6FF']
  };

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
      } else if (p.kind === 'link') {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(String(p.linkId || ''))) e.push(w + ' の linkId（ハブの links シートの id）が不正');
      } else e.push(w + ' の kind は app・page・link');
      if (p.actAs != null && typeof p.actAs !== 'boolean') e.push(w + ' の actAs は true / false（代わりに取り組むに対応しているか）');
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
  /**
   * 教科の中のページを、先生が並べた順にする（純粋な計算。画面でも使う）。
   * ids：先生が並べたページの id の並び。そこに無いページ（後で目録に足したものなど）は、元の順のまま後ろに付ける
   */
  function sortByOrder(pages, ids) {
    if (!ids || !ids.length) return pages.slice();
    var pos = {}; ids.forEach(function (id, i) { pos[id] = i; });
    return pages.map(function (p, i) { return { p: p, i: i }; }).sort(function (a, b) {
      var x = pos.hasOwnProperty(a.p.id) ? pos[a.p.id] : ids.length + a.i, y = pos.hasOwnProperty(b.p.id) ? pos[b.p.id] : ids.length + b.i;
      return x - y;
    }).map(function (o) { return o.p; });
  }

  function readSettings(hubSs, classKey) {
    var out = { publish: {}, now: [], order: {}, colors: {} };
    var ps = hubSs.getSheetByName(PUB_SHEET);
    if (ps && ps.getLastRow() > 1) ps.getRange(2, 1, ps.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (clsCell(r[0]) === classKey && r[1]) out.publish[String(r[1])] = r[2] === true || String(r[2]).toUpperCase() === 'TRUE';
    });
    var ns = hubSs.getSheetByName(NOW_SHEET);
    if (ns && ns.getLastRow() > 1) ns.getRange(2, 1, ns.getLastRow() - 1, 5).getValues().forEach(function (r) {
      if (clsCell(r[0]) === classKey && r[1]) out.now.push({ page: String(r[1]), order: Number(r[2]) || 0, from: ymd(r[3]), to: ymd(r[4]) });
    });
    var os = hubSs.getSheetByName(ORDER_SHEET);
    if (os && os.getLastRow() > 1) os.getRange(2, 1, os.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (clsCell(r[0]) === classKey && r[1]) out.order[String(r[1])] = String(r[2] || '').split(',').filter(Boolean);
    });
    var cs = hubSs.getSheetByName(COLOR_SHEET);
    if (cs && cs.getLastRow() > 1) cs.getRange(2, 1, cs.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (clsCell(r[0]) === classKey && r[1] && TILE_COLORS[String(r[2])]) out.colors[String(r[1])] = String(r[2]);
    });
    return out;
  }
  // 学級・日付が日付に化けた値を戻す（Sheets.gs。保存の関数の中でだけ使う：画面の写し web/pages.js では呼ばれない）
  function clsCell(v) { return LbSheets.clsCell(v); }
  function ymd(v) { return LbSheets.ymd(v); }

  /** 公開を切り替える（押すたびに保存）。その学級・そのページの行を書き換える（無ければ足す） */
  function setPublish(hubSs, classKey, pageId, on, by) {
    var sh = sheet(hubSs, PUB_SHEET, PUB_HEAD), v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (clsCell(v[i][0]) === classKey && String(v[i][1]) === pageId) { sh.getRange(i + 1, 1, 1, 5).setValues([[classKey, pageId, !!on, new Date(), by || '']]); return; }
    }
    sh.appendRow([classKey, pageId, !!on, new Date(), by || '']);
  }

  /** 教科の中の並びを保存する（その学級・その教科の行を置き換える）。ids が空なら行を消す（目録の順に戻る） */
  function setOrder(hubSs, classKey, subject, ids, by) {
    if (SUBJECT_IDS.indexOf(subject) < 0) throw new Error('知らない教科です: ' + subject);
    var clean = (ids || []).map(String).filter(function (id) { return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id); });
    var sh = sheet(hubSs, ORDER_SHEET, ORDER_HEAD), v = sh.getDataRange().getValues(), keep = [v[0]];
    for (var i = 1; i < v.length; i++) {
      if (clsCell(v[i][0]) === classKey && String(v[i][1]) === subject) continue;
      var row = v[i].slice(0, ORDER_HEAD.length); row[0] = clsCell(row[0]); while (row.length < ORDER_HEAD.length) row.push(''); keep.push(row);
    }
    if (clean.length) keep.push([classKey, subject, clean.join(','), new Date(), by || '']);
    sh.clearContents();
    sh.getRange(1, 1, keep.length, ORDER_HEAD.length).setValues(keep);
    return clean;
  }

  /** タイルの色を選ぶ（その学級・そのページ）。color が空ならハブの links の色に戻す */
  function setColor(hubSs, classKey, pageId, color, by) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(pageId))) throw new Error('ページの名前が不正です');
    color = String(color || '');
    if (color && !TILE_COLORS[color]) throw new Error('知らない色です: ' + color);
    var sh = sheet(hubSs, COLOR_SHEET, COLOR_HEAD), v = sh.getDataRange().getValues(), keep = [v[0]];
    for (var i = 1; i < v.length; i++) {
      if (clsCell(v[i][0]) === classKey && String(v[i][1]) === pageId) continue;
      var row = v[i].slice(0, COLOR_HEAD.length); row[0] = clsCell(row[0]); while (row.length < COLOR_HEAD.length) row.push(''); keep.push(row);
    }
    if (color) keep.push([classKey, pageId, color, new Date(), by || '']);
    sh.clearContents();
    sh.getRange(1, 1, keep.length, COLOR_HEAD.length).setValues(keep);
  }

  /** その学級の公開を全部、目録の既定に戻す */
  function resetPublish(hubSs, classKey) {
    if (!hubSs.getSheetByName(PUB_SHEET)) return 0;
    var sh = sheet(hubSs, PUB_SHEET, PUB_HEAD);
    var v = sh.getDataRange().getValues(), keep = [v[0]], n = 0;
    for (var i = 1; i < v.length; i++) { var row = v[i].slice(); row[0] = clsCell(row[0]); if (row[0] === classKey) n++; else keep.push(row); }
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
    for (var i = 1; i < v.length; i++) {
      if (clsCell(v[i][0]) === classKey) continue;
      var row = v[i].slice(); row[0] = clsCell(row[0]); row[3] = ymd(row[3]); row[4] = ymd(row[4]); keep.push(row);
    }
    (list || []).slice(0, NOW_MAX).forEach(function (n, k) { keep.push([classKey, n.page, k + 1, n.from || '', n.to || '', new Date(), by || '']); });
    sh.clearContents();
    sh.getRange(1, 1, keep.length, NOW_HEAD.length).setValues(keep.map(function (r) { var o = r.slice(0, NOW_HEAD.length); while (o.length < NOW_HEAD.length) o.push(''); return o; }));
  }

  /** 表を用意する。学級と日付の列は毎回文字の書式にする（「3-1」が日付に化けないように） */
  function sheet(ss, name, head) {
    var cols = [];
    head.forEach(function (h, i) { if (h === '学級' || h === 'から' || h === 'まで') cols.push(i + 1); });
    return LbSheets.sheet(ss, name, head, cols, { always: true });
  }

  return { SUBJECTS: SUBJECTS, NOW_MAX: NOW_MAX, TILE_COLORS: TILE_COLORS, setColor: setColor, validate: validate, isOn: isOn, inPeriod: inPeriod, home: home, teacherView: teacherView, sortByOrder: sortByOrder, setOrder: setOrder,
    readSettings: readSettings, setPublish: setPublish, resetPublish: resetPublish, setNow: setNow };
})();
