/**
 * Tuning.gs — 閾値を見直す材料（LbTuning）。所有者の画面の中だけで見る（児童の学習状態なので、書き出しには入れない）
 *
 * 正本は learning-base。今週の3件の規則と値は Alerts.gs（RULES・SPEC・ハブの rules）。ここはそれを数え比べるだけ：
 *   - 出た記録（now3_log）と先生の反応（decisions）を週×種類で
 *   - 閾値を1つずつ変えた時・入れた値の時の候補の数
 *   - 規則が見ている値の散らばり（人数は5人未満を伏せる）
 */
var LbTuning = (function () {
  var MIN_CELL = 5;
  var LOG = 'now3_log', LOG_HEAD = ['週', '学級', 'キー', '種類', '初めて出た日'];
  var day = LbSheets.day, ymd = LbSheets.ymd, sheet = LbSheets.sheet;
  /** 人数の欄：0 はそのまま、1〜4 は「5人未満」 */
  function people(n) { return !n ? '0' : n < MIN_CELL ? MIN_CELL + '人未満' : String(n); }

  /* ---------- 今週の3件の働き ---------- */

  /** 毎晩：画面に出した項目を now3_log に残す（同じキーは1回だけ。now3 は毎晩入れ替わるので、出たことの記録はここにしか残らない） */
  function logAlerts(hub, byClass, today) {
    var sh = sheet(hub, LOG, LOG_HEAD, [1, 2, 5]), have = {};
    if (sh.getLastRow() >= 2) sh.getRange(2, 3, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { have[String(r[0])] = true; });
    var rows = [];
    Object.keys(byClass).sort().forEach(function (cls) {
      byClass[cls].forEach(function (x) { if (!have[x.key]) { have[x.key] = true; rows.push([x.week, cls, x.key, x.kind, today || day()]); } });
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, LOG_HEAD.length).setValues(rows);
    return rows.length;
  }
  /** 週×種類：出た・判断が変わった・見た・押されていない（直近 weeks 週） */
  function performance(hub, today, weeks) {
    var w0 = LbAlerts.weekOfDay(today), from = LbFacts.addWeeks(w0, -((weeks || 8) - 1));
    var dec = {}, dsh = hub.getSheetByName('decisions');
    if (dsh && dsh.getLastRow() >= 2) dsh.getRange(2, 1, dsh.getLastRow() - 1, 6).getValues().forEach(function (r) {
      var k = String(r[3]), a = String(r[5]) === '判断が変わった' ? 'changed' : 'seen';
      if (dec[k] !== 'changed') dec[k] = a;
    });
    var by = {}, sh = hub.getSheetByName(LOG);
    if (sh && sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
      var w = ymd(r[0]), kind = String(r[3]);
      if (w < from || w > w0) return;
      var o = by[w + '|' + kind] || (by[w + '|' + kind] = { week: w, kind: kind, fired: 0, changed: 0, seen: 0, open: 0 });
      o.fired++;
      o[dec[String(r[2])] || 'open']++;
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return a.week < b.week ? 1 : a.week > b.week ? -1 : (LbAlerts.KIND_RANK[b.kind] || 0) - (LbAlerts.KIND_RANK[a.kind] || 0); });
  }

  /* ---------- 閾値を変えたら ---------- */

  function round(x) { return Math.round(x * 1000) / 1000; }
  /** 試す値：いまの値から step だけ上下（'x' は半分と1.5倍）。範囲の外と、いまの値と同じものは除く */
  function variants(sp, cur) {
    if (!sp.step) return [];
    var v = sp.step === 'x' ? [cur * 0.5, cur * 1.5] : [cur - sp.step, cur + sp.step];
    return v.map(function (x) { return sp.int ? Math.round(x) : round(x); })
      .filter(function (x, i, a) { return x >= sp.min - 1e-9 && x <= sp.max + 1e-9 && x !== cur && a.indexOf(x) === i; });
  }
  /** 規則で候補を数える（3件に切る前・判断済みも含む）。{ drop, klass, stall, classes } */
  function counter(acc, roster, cats, today) {
    var ix = LbAlerts.index(acc), clsOf = LbAlerts.classMap(roster), w0 = LbAlerts.weekOfDay(today);
    return function (rules) {
      var c = { drop: 0, klass: 0, stall: 0 }, cls = {};
      LbAlerts.candidates(ix, clsOf, cats, w0, rules).forEach(function (x) { c[x.kind]++; cls[x.cls] = true; });
      c.classes = Object.keys(cls).length;
      return c;
    };
  }
  /** いまの規則（base）と、項目を1つずつ上下に変えた時の候補の数。学校の中だけで見る */
  function sensitivity(acc, roster, cats, today, base) {
    base = base || LbAlerts.RULES;
    var run = counter(acc, roster, cats, today);
    var rows = [Object.assign({ rule: 'いまの値', label: 'いまの値', value: '', now: '' }, run(base))];
    LbAlerts.SPEC.forEach(function (sp) {
      var cur = LbAlerts.getPath(base, sp.path);
      variants(sp, cur).forEach(function (val) {
        var r = JSON.parse(JSON.stringify(base));
        LbAlerts.setPath(r, sp.path, val);
        rows.push(Object.assign({ rule: sp.path, label: sp.label, unit: sp.unit, scale: sp.scale, value: val, now: cur }, run(r)));
      });
    });
    return rows;
  }
  /** 所有者が画面で入れた値で数える（保存しない）。values は { 項目: 値 }（画面の表し方ではなく元の値）。返す：{ now, tried, bad } */
  function tryRules(acc, roster, cats, today, base, values) {
    var run = counter(acc, roster, cats, today), cur = {};
    LbAlerts.SPEC.forEach(function (sp) { cur[sp.path] = LbAlerts.getPath(base, sp.path); });
    Object.keys(values || {}).forEach(function (k) { cur[k] = values[k]; });
    var w = LbAlerts.withValues(cur);
    return { now: run(base), tried: run(w.rules), bad: w.bad };
  }

  /* ---------- 記録の分布（人数は5人未満を伏せる） ---------- */

  /** 値 → 区間の名前。edges は [上限, 名前] の昇順（最後は Infinity） */
  function bin(x, edges) { for (var i = 0; i < edges.length; i++) if (x < edges[i][0]) return edges[i][1]; return edges[edges.length - 1][1]; }
  var BINS = {
    dropAcc: [[0, '上がった'], [5, '0〜5'], [10, '5〜10'], [15, '10〜15'], [20, '15〜20'], [Infinity, '20以上']],
    dropTime: [[0.9, '0.9倍未満'], [1.1, '0.9〜1.1倍'], [1.25, '1.1〜1.25倍'], [1.5, '1.25〜1.5倍'], [Infinity, '1.5倍以上']],
    stallAcc: [[-5, '-5未満'], [0, '-5〜0'], [2, '0〜2'], [5, '2〜5'], [Infinity, '5以上']],
    stallTime: [[0.9, '0.9倍未満'], [0.97, '0.9〜0.97倍'], [1.03, '0.97〜1.03倍'], [Infinity, '1.03倍以上']],
    klassShare: [[0.3, '3割未満'], [0.5, '3〜5割'], [0.7, '5〜7割'], [Infinity, '7割以上']]
  };
  /**
   * 規則が見ている値が、全校でどう散らばっているか（閾値がどこを切っているかを見るため）。
   * 児童の数は区間ごとに数え（同じ児童が別の技能で別の区間に入ることはある）、5人未満は伏せる。合計は書かない（引き算で伏せた欄が分かるため）
   */
  function distributions(acc, roster, cats, today, rules) {
    var R = rules || LbAlerts.RULES, ix = LbAlerts.index(acc), clsOf = LbAlerts.classMap(roster), w0 = LbAlerts.weekOfDay(today);
    var sets = {}; Object.keys(BINS).forEach(function (k) { sets[k] = {}; BINS[k].forEach(function (b) { sets[k][b[1]] = {}; }); });
    var grade = {}, groups = {};
    roster.forEach(function (r) { if (r.lid && r.grade) grade[r.grade] = grade[r.grade] || { week: {}, month: {}, n: 0 }; });
    Object.keys(ix).forEach(function (key) {
      var p = key.split('|'), lid = p[0], app = p[1], skill = p.slice(2).join('|'), byWeek = ix[key], cls = clsOf[lid];
      if (!cls) return;
      var g = grade[Number(cls.split('-')[0])];
      var now = LbAlerts.sum(byWeek, [w0]), month = LbAlerts.sum(byWeek, LbAlerts.weeksBack(w0, 0, 3));
      if (g && now.n) { g.week[lid] = true; g.n += now.n; }
      if (g && month.n) g.month[lid] = true;
      var base = LbAlerts.sum(byWeek, LbAlerts.weeksBack(w0, 1, R.drop.baseWeeks));
      if (now.n >= R.drop.weekMinN && base.n >= R.drop.baseMinN) {
        var sn = LbFacts.stats(now), sb = LbFacts.stats(base);
        sets.dropAcc[bin((sb.acc - sn.acc) * 100, BINS.dropAcc)][lid] = true;
        if (sn.gmMs && sb.gmMs) sets.dropTime[bin(sn.gmMs / sb.gmMs, BINS.dropTime)][lid] = true;
      }
      var st = R.stall, rec = LbAlerts.sum(byWeek, LbAlerts.weeksBack(w0, 0, st.weeks - 1)), prev = LbAlerts.sum(byWeek, LbAlerts.weeksBack(w0, st.weeks, 2 * st.weeks - 1));
      if (rec.n >= st.minN && prev.n >= st.minN && LbFacts.state(rec, LbCatalog.mastery(cats[app], skill)) !== '到達') {
        var sr = LbFacts.stats(rec), sp = LbFacts.stats(prev);
        sets.stallAcc[bin((sr.acc - sp.acc) * 100, BINS.stallAcc)][lid] = true;
        if (sr.gmMs && sp.gmMs) sets.stallTime[bin(sr.gmMs / sp.gmMs, BINS.stallTime)][lid] = true;
      }
      var two = LbAlerts.sum(byWeek, LbAlerts.weeksBack(w0, 0, R.klass.weeks - 1));
      if (two.n >= R.klass.kidMinN) { var gk = cls + '|' + app + '|' + skill, o = groups[gk] || (groups[gk] = { kids: 0, low: 0 }); o.kids++; if (LbFacts.stats(two).acc < R.klass.accBelow) o.low++; }
    });
    var hist = {};
    Object.keys(BINS).forEach(function (k) { if (k !== 'klassShare') hist[k] = BINS[k].map(function (b) { return [b[1], people(Object.keys(sets[k][b[1]]).length)]; }); });
    // 学級でつまずき：学級×技能のまとまりの数（児童の数ではないので伏せない）。取り組んだ児童が規則の人数に足りないまとまりは数えない
    var gc = {}; BINS.klassShare.forEach(function (b) { gc[b[1]] = 0; });
    Object.keys(groups).forEach(function (k) { var o = groups[k]; if (o.kids >= R.klass.minKids) gc[bin(o.low / o.kids, BINS.klassShare)]++; });
    hist.klassShare = BINS.klassShare.map(function (b) { return [b[1], String(gc[b[1]])]; });
    var grades = Object.keys(grade).map(Number).sort().map(function (g) {
      var o = grade[g], wk = Object.keys(o.week).length;
      return { grade: g, week: people(wk), month: people(Object.keys(o.month).length), n: wk >= MIN_CELL ? String(o.n) : '—' };
    });
    return { hist: hist, grades: grades };
  }

  /**
   * 閾値を見直す画面の材料（所有者だけ・学校の中だけ）。
   * o: { hub, today, roster, acc, cats }。返す：{ spec: [...], counts, sens, dist, perf }
   */
  function tuning(o) {
    var base = LbAlerts.active(o.hub), saved = LbAlerts.savedValues(o.hub);
    var spec = LbAlerts.SPEC.map(function (sp) {
      return { path: sp.path, kind: sp.kind, label: sp.label, unit: sp.unit, scale: sp.scale, int: !!sp.int, min: sp.min, max: sp.max,
        value: LbAlerts.getPath(base, sp.path), def: LbAlerts.getPath(LbAlerts.RULES, sp.path), changed: Object.prototype.hasOwnProperty.call(saved, sp.path) };
    });
    var sens = sensitivity(o.acc, o.roster, o.cats, o.today, base);
    return { spec: spec, counts: sens[0], sens: sens.slice(1), dist: distributions(o.acc, o.roster, o.cats, o.today, base), perf: performance(o.hub, o.today, 8) };
  }

  return { MIN_CELL: MIN_CELL, people: people, logAlerts: logAlerts, performance: performance, variants: variants, sensitivity: sensitivity,
    tryRules: tryRules, distributions: distributions, tuning: tuning };
})();
