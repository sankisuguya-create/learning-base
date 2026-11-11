/**
 * Directives.gs — 指示（LbDirectives）：先生が今週の3件から「手を打つ」と、アプリの練習の出題が変わる
 *
 * 正本は learning-base。設計：`-` リポジトリ principles/learning-app-foundation.md §6・§16
 *
 * 決定（2026-11-10）
 * - 種類は weight（練習の出題に重みを付ける）だけ。アプリの目録の directives に 'weight' があるアプリだけが受け取る
 * - 効かせるのは練習だけ。本番の出題は変えない（本番の記録で指示の前と後を同じ条件で比べるため）
 * - 練習の「ぜんぶ」で、指示した技能の問題を半分混ぜる（アプリが WEIGHT_SHARE を使う）
 * - 児童の画面の「★ おすすめ」は、先生が指示ごとに選んだ時だけ（既定は出さない）。理由・先生の名前は出さない
 * - 期間（1週／2週）が終わった翌朝、本番の記録で結果を出す：対象の児童の変化から、同じ学年で指示を受けていない児童の変化を引く。
 *   本番が10問未満なら「数が少ない」とだけ出す（人数も期間も小さいので、差は目安）
 *
 * ハブの directives シート：1行＝1つの指示（対象の児童は複数のことがある）
 */
var LbDirectives = (function () {
  var SHEET = 'directives';
  var HEAD = ['ID', '作成日', '教師', '学級', '学習者ID', 'アプリ', '技能', 'から', 'まで', '見せる', '元のキー', '状態', '結果', '結果の日'];
  var C = {}; HEAD.forEach(function (h, i) { C[h] = i; });
  var TEXT_COLS = [1, 4, 8, 9, 14];   // ID・学級・から・まで・結果の日（日付・3-1 に化けないように）
  var DAYS = [7, 14], WEIGHT_SHARE = 0.5, MIN_N = 10, BEFORE_WEEKS = 4, RESULT_DAYS = 14, CACHE_SEC = 600;
  var day = LbSheets.day, ymd = LbSheets.ymd, clsCell = LbSheets.clsCell;

  function addDays(d, k) { return day(new Date(new Date(d + 'T12:00:00+09:00').getTime() + k * 86400000)); }
  function bool(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

  /** 全部の行（{ row: シートの行番号, id, … }） */
  function all(hub) {
    var sh = hub.getSheetByName(SHEET);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues().map(function (r, i) {
      var res = null;
      try { res = r[C['結果']] ? JSON.parse(String(r[C['結果']])) : null; } catch (e) { res = null; }
      return { row: i + 2, id: String(r[C.ID]), at: r[C['作成日']], by: String(r[C['教師']]), classKey: clsCell(r[C['学級']]),
        lids: String(r[C['学習者ID']]).split(',').filter(Boolean), app: String(r[C['アプリ']]), skill: String(r[C['技能']]),
        from: ymd(r[C['から']]), to: ymd(r[C['まで']]), show: bool(r[C['見せる']]), fromKey: String(r[C['元のキー']]),
        state: String(r[C['状態']]), result: res, resultDay: ymd(r[C['結果の日']]) };
    });
  }
  function bump() { try { CacheService.getScriptCache().put('lbdir:ver', Utilities.getUuid(), 21600); } catch (e) {} }   // 同じミリ秒に2回変えても別の印になるように
  function ver() { try { return CacheService.getScriptCache().get('lbdir:ver') || '0'; } catch (e) { return '0'; } }

  /**
   * 指示を作る。o：{ classKey, lids: [学習者ID], app, skill, days: 7|14, show, fromKey }。返す：作った指示
   * 期間は今日から days 日（今日を含む）
   */
  function create(hub, o, by, today) {
    today = today || day();
    var lids = (o.lids || []).map(String).filter(function (l) { return /^[A-Za-z0-9]{1,20}$/.test(l); });
    if (!lids.length) throw new Error('指示の対象の児童がいません');
    if (!o.app || !o.skill) throw new Error('指示の技能がありません');
    var days = Number(o.days);
    if (DAYS.indexOf(days) < 0) throw new Error('期間は1週か2週です');
    var id = 'D' + today.replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 6);
    var d = { id: id, classKey: String(o.classKey), lids: lids, app: String(o.app), skill: String(o.skill), from: today, to: addDays(today, days - 1),
      show: !!o.show, fromKey: String(o.fromKey || ''), state: '有効' };
    var sh = LbSheets.sheet(hub, SHEET, HEAD, TEXT_COLS);
    var row = []; row[C.ID] = id; row[C['作成日']] = new Date(); row[C['教師']] = String(by || ''); row[C['学級']] = d.classKey;
    row[C['学習者ID']] = lids.join(','); row[C['アプリ']] = d.app; row[C['技能']] = d.skill; row[C['から']] = d.from; row[C['まで']] = d.to;
    row[C['見せる']] = d.show; row[C['元のキー']] = d.fromKey; row[C['状態']] = '有効'; row[C['結果']] = ''; row[C['結果の日']] = '';
    sh.appendRow(row);
    bump();
    return d;
  }
  function setCells(hub, d, vals) {
    var sh = hub.getSheetByName(SHEET);
    Object.keys(vals).forEach(function (h) { sh.getRange(d.row, C[h] + 1).setValue(vals[h]); });
  }
  /** 指示をやめる（有効なものだけ）。classKey が違えば変えない */
  function end(hub, id, classKey) {
    var d = all(hub).filter(function (x) { return x.id === String(id); })[0];
    if (!d) throw new Error('もう ない指示です');
    if (d.classKey !== String(classKey)) throw new Error('この学級の指示ではありません');
    if (d.state !== '有効') return false;
    setCells(hub, d, { '状態': '取消' });
    bump();
    return true;
  }
  function find(hub, id) { return all(hub).filter(function (x) { return x.id === String(id); })[0] || null; }

  /** その学級の、いま効いている指示 */
  function active(hub, classKey, today) {
    today = today || day();
    return all(hub).filter(function (d) { return d.classKey === classKey && d.state === '有効' && d.from <= today && today <= d.to; });
  }
  /**
   * その児童がいま受けている指示（アプリが練習の出題で使う）。[{ id, skill, show }]。
   * 練習は1問ごとに呼ばれるので、児童ごとに10分覚えておく（指示を作る・やめると覚えた分は使わなくなる）
   */
  function forLearner(hub, lid, app, today) {
    today = today || day();
    var key = 'lbdir|' + ver() + '|' + today + '|' + lid + '|' + app, c = null;
    try { c = CacheService.getScriptCache(); var hit = c.get(key); if (hit) return JSON.parse(hit); } catch (e) { c = null; }
    var out = all(hub).filter(function (d) { return d.state === '有効' && d.app === app && d.lids.indexOf(lid) >= 0 && d.from <= today && today <= d.to; })
      .map(function (d) { return { id: d.id, skill: d.skill, show: d.show }; });
    try { if (c) c.put(key, JSON.stringify(out), CACHE_SEC); } catch (e) {}
    return out;
  }

  /* ---------- 結果（期間が終わった翌朝） ---------- */

  function sumOf(acc, lids, app, skill, weeks) {
    var list = [];
    for (var k in acc) { var f = acc[k]; if (f.app === app && f.skill === skill && lids[f.lid] && weeks.indexOf(f.week) >= 0) list.push(f); }
    return LbFacts.combine(list);
  }
  function weeksBetween(from, to) {
    var out = [], w = LbFacts.weekOf(new Date(from + 'T12:00:00+09:00')), last = LbFacts.weekOf(new Date(to + 'T12:00:00+09:00'));
    while (w <= last) { out.push(w); w = LbFacts.addWeeks(w, 1); }
    return out;
  }
  /**
   * 1つの指示の結果（純粋な計算）。acc：集計（本番だけ）／roster：名簿。
   * 前＝始めた週の前の4週、期間中＝始めた週から終えた週まで。比べる相手＝同じ学年で、指示の対象ではなく、その技能を前と期間中の両方で解いた児童
   */
  function measure(d, acc, roster) {
    var w0 = LbFacts.weekOf(new Date(d.from + 'T12:00:00+09:00')), during = weeksBetween(d.from, d.to), before = [];
    for (var i = BEFORE_WEEKS; i >= 1; i--) before.push(LbFacts.addWeeks(w0, -i));
    var grade = Number(String(d.classKey).split('-')[0]), tgt = {}, others = {};
    d.lids.forEach(function (l) { tgt[l] = true; });
    roster.forEach(function (r) { if (r.lid && r.grade === grade && !tgt[r.lid]) others[r.lid] = true; });
    var tb = LbFacts.stats(sumOf(acc, tgt, d.app, d.skill, before)), td = LbFacts.stats(sumOf(acc, tgt, d.app, d.skill, during));
    var both = {};
    Object.keys(others).forEach(function (l) {
      var one = {}; one[l] = true;
      if (sumOf(acc, one, d.app, d.skill, before).n && sumOf(acc, one, d.app, d.skill, during).n) both[l] = true;
    });
    var ob = LbFacts.stats(sumOf(acc, both, d.app, d.skill, before)), od = LbFacts.stats(sumOf(acc, both, d.app, d.skill, during));
    return { enough: tb.n >= MIN_N && td.n >= MIN_N, nBefore: tb.n, nDuring: td.n, accBefore: tb.acc, accDuring: td.acc, msBefore: tb.gmMs, msDuring: td.gmMs,
      others: Object.keys(both).length, oAccBefore: ob.acc, oAccDuring: od.acc, oMsBefore: ob.gmMs, oMsDuring: od.gmMs };
  }
  /** 毎晩：期間が終わった指示の結果を出す。返す：結果を出した数 */
  function evaluate(hub, acc, roster, today) {
    today = today || day();
    var n = 0;
    all(hub).forEach(function (d) {
      if (d.state !== '有効' || d.to >= today) return;
      setCells(hub, d, { '状態': '終了', '結果': JSON.stringify(measure(d, acc, roster)), '結果の日': today });
      n++;
    });
    if (n) bump();
    return n;
  }
  /** 結果の一文（先生の画面に出す。名前は含めない） */
  function describe(r) {
    if (!r) return '';
    if (!r.enough) return '本番の記録が少ないので比べられません（前の4週 ' + r.nBefore + '問・期間中 ' + r.nDuring + '問。' + MIN_N + '問ずつ要ります）';
    var pct = function (x) { return x == null ? '—' : Math.round(x * 100) + '%'; }, sec = function (x) { return x ? (x / 1000).toFixed(1) + '秒' : '—'; };
    var pt = function (a, b) { return a == null || b == null ? '—' : ((b - a) >= 0 ? '+' : '') + Math.round((b - a) * 100) + 'ポイント'; };
    var s = '正答率 ' + pct(r.accBefore) + ' → ' + pct(r.accDuring) + '・時間 ' + sec(r.msBefore) + ' → ' + sec(r.msDuring);
    s += r.others ? '（同じ学年のほかの児童 ' + r.others + '人は正答率 ' + pt(r.oAccBefore, r.oAccDuring) + '）' : '（比べる相手の児童がいません）';
    return s + '。本番の記録で、前の4週と期間中を比べた目安です';
  }
  /** その学級の、まだ見ていない結果（出してから14日まで）。dismissed：見たキー（'result|ID'） */
  function results(hub, classKey, today, dismissed) {
    today = today || day();
    var since = addDays(today, -RESULT_DAYS);
    return all(hub).filter(function (d) {
      return d.classKey === classKey && d.state === '終了' && d.result && d.resultDay >= since && !(dismissed || {})['result|' + d.id];
    });
  }

  return { SHEET: SHEET, DAYS: DAYS, WEIGHT_SHARE: WEIGHT_SHARE, MIN_N: MIN_N, all: all, find: find, create: create, end: end, active: active,
    forLearner: forLearner, measure: measure, evaluate: evaluate, describe: describe, results: results };
})();
