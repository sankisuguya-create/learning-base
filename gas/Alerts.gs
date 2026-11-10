/**
 * Alerts.gs — 今週の3件（教師が次に手を打つ相手を、学級ごとに3件まで）
 *
 * 正本は learning-base。設計：`-` リポジトリ principles/learning-app-foundation.md §6
 * 毎晩、集計（facts）から学級ごとに候補を計算し、ハブの now3 シートに置く。教師が学習BASE を開くと最上部に出る。
 * 判定の規則と閾値の初期値は RULES の1か所だけに置く（初期値は根拠なし）。
 * 所有者は学習BASE の「閾値を見直す」画面で値を変えられる（ハブの rules シートに保存。翌晩の計算から効く）。
 * 変えられる項目と範囲は SPEC。週の数（4週・2週）は規則の形なので変えない。
 * 閾値を見直す数（候補の数・分布）は児童の学習状態なので学校の中だけで見る（改善用の書き出しには入れない）。
 *
 * 候補の種類（強い順）
 *   drop   急に崩れた児童：今週の正答率が直近4週の平均より15ポイント以上下がった（今週10問以上）、または時間が25%以上長くなった
 *   class  学級でつまずいている技能：直近2週にその技能に取り組んだ児童（5問以上を5人以上）のうち、半数以上が正答率70%未満
 *   stall  伸びが止まった児童：練習中の技能で、直近4週とその前の4週がどちらも20問以上あるのに、
 *          正答率が2ポイント以上上がっておらず、時間も3%以上短くなっていない
 */
var LbAlerts = (function () {
  var RULES = {
    drop: { weekMinN: 10, baseWeeks: 4, baseMinN: 10, accDrop: 0.15, timeRise: 1.25 },
    klass: { weeks: 2, kidMinN: 5, minKids: 5, accBelow: 0.7, share: 0.5 },
    stall: { weeks: 4, minN: 20, accGain: 0.02, timeRatio: 0.97 },
    max: 3,
    dismissDays: 14
  };
  /**
   * 所有者が変えられる項目。scale：画面での表し方（0.15 → 15 ポイント）。step：見直す画面で試す幅（'x' は半分と1.5倍）
   */
  var SPEC = [
    { path: 'drop.accDrop', kind: 'drop', label: '正答率の下がり幅（これ以上で出す）', unit: 'ポイント', scale: 100, min: 0.03, max: 0.5, step: 0.05 },
    { path: 'drop.timeRise', kind: 'drop', label: '時間の伸び（これ以上で出す）', unit: '倍', scale: 1, min: 1.05, max: 3, step: 0.15 },
    { path: 'drop.weekMinN', kind: 'drop', label: '今週の問題数（これ以上の時だけ）', unit: '問', scale: 1, min: 1, max: 200, int: true, step: 'x' },
    { path: 'drop.baseMinN', kind: 'drop', label: '前の4週の問題数（これ以上の時だけ）', unit: '問', scale: 1, min: 1, max: 400, int: true, step: 'x' },
    { path: 'klass.accBelow', kind: 'klass', label: '低いとみなす正答率（これ未満）', unit: '%', scale: 100, min: 0.3, max: 0.95, step: 0.1 },
    { path: 'klass.share', kind: 'klass', label: '低い児童の割合（これ以上で出す）', unit: '%', scale: 100, min: 0.1, max: 1, step: 0.1 },
    { path: 'klass.minKids', kind: 'klass', label: '取り組んだ児童（これ以上の時だけ）', unit: '人', scale: 1, min: 2, max: 40, int: true, step: 2 },
    { path: 'klass.kidMinN', kind: 'klass', label: '1人の問題数（これ以上で数に入れる）', unit: '問', scale: 1, min: 1, max: 200, int: true, step: 'x' },
    { path: 'stall.minN', kind: 'stall', label: '前後4週それぞれの問題数（これ以上の時だけ）', unit: '問', scale: 1, min: 5, max: 400, int: true, step: 'x' },
    { path: 'stall.accGain', kind: 'stall', label: '正答率の伸び（これ未満なら止まった）', unit: 'ポイント', scale: 100, min: 0, max: 0.3, step: 0.02 },
    { path: 'stall.timeRatio', kind: 'stall', label: '時間の比（これより大きければ止まった）', unit: '倍', scale: 1, min: 0.5, max: 1.2, step: 0.02 },
    { path: 'max', kind: 'all', label: '学級ごとに出す数', unit: '件', scale: 1, min: 1, max: 10, int: true },
    { path: 'dismissDays', kind: 'all', label: '押した項目を出さない日数', unit: '日', scale: 1, min: 1, max: 60, int: true }
  ];
  var RULE_SHEET = 'rules', RULE_HEAD = ['項目', '値', '初期値', '説明', '変えた日', '変えた人'];
  var KIND_RANK = { drop: 3, klass: 2, stall: 1 };
  /** 種類の名前（ここが唯一の置き場。メール・書き出し・先生の画面はここから取る）。LABEL は記号つき（色だけで伝えないため） */
  var KIND_NAME = { drop: '急に崩れた', klass: '学級でつまずき', stall: '伸びが止まった' };
  var KIND_MARK = { drop: '▼', klass: '●', stall: '―' };
  var LABEL = {}; Object.keys(KIND_NAME).forEach(function (k) { LABEL[k] = KIND_MARK[k] + ' ' + KIND_NAME[k]; });
  var SHEET = 'now3', HEAD = ['学級', '順', 'キー', '種類', '学習者ID', 'アプリ', '技能', '根拠', '週'];
  var DEC_SHEET = 'decisions', DEC_HEAD = ['日時', '教師', '学級', 'キー', '種類', 'どうした', 'メモ'];

  /** 学習者ID|アプリ|技能 → { 週: 集計の行 } */
  function index(acc) {
    var ix = {};
    for (var k in acc) {
      var f = acc[k], key = f.lid + '|' + f.app + '|' + f.skill;
      (ix[key] = ix[key] || {})[f.week] = f;
    }
    return ix;
  }
  function weeksBack(w0, from, to) { var out = []; for (var i = from; i <= to; i++) out.push(LbFacts.addWeeks(w0, -i)); return out; }
  function sum(byWeek, weeks) { return LbFacts.combine(weeks.map(function (w) { return byWeek[w]; }).filter(Boolean)); }

  /** 名簿 → { 学習者ID: 学級キー } */
  function classMap(roster) { var m = {}; roster.forEach(function (r) { if (r.lid) m[r.lid] = r.grade + '-' + r.cls; }); return m; }

  /**
   * 規則に当たる候補を全部返す（上位3件に切る前。判断済みも含む）。
   * ix：index(acc)／clsOf：classMap(roster)／rules：RULES と同じ形（閾値を変えたらどうなるかを数える時に別の値を渡す）
   * 返す：[{ cls, key, kind, lids, app, skill, week, mag, ev }]
   */
  function candidates(ix, clsOf, cats, w0, rules) {
    var R = rules || RULES, out = [];
    function add(cls, item) { item.cls = cls; out.push(item); }
    var perSkill = {};   // 学級|アプリ|技能 → [{ lid, acc }]
    Object.keys(ix).forEach(function (key) {
      var p = key.split('|'), lid = p[0], app = p[1], skill = p.slice(2).join('|'), byWeek = ix[key], cls = clsOf[lid];
      if (!cls) return;
      // drop
      var d = R.drop, now = sum(byWeek, [w0]), base = sum(byWeek, weeksBack(w0, 1, d.baseWeeks));
      if (now.n >= d.weekMinN && base.n >= d.baseMinN) {
        var sn = LbFacts.stats(now), sb = LbFacts.stats(base);
        var accDrop = sb.acc - sn.acc, rise = (sn.gmMs && sb.gmMs) ? sn.gmMs / sb.gmMs : 1;
        if (accDrop >= d.accDrop || rise >= d.timeRise) add(cls, { key: 'drop|' + lid + '|' + app + '|' + skill + '|' + w0, kind: 'drop', lids: [lid], app: app, skill: skill, week: w0,
          mag: Math.max(accDrop / d.accDrop, rise / d.timeRise), ev: { accNow: sn.acc, accBase: sb.acc, msNow: sn.gmMs, msBase: sb.gmMs, nNow: now.n } });
      }
      // stall
      var st = R.stall, rec = sum(byWeek, weeksBack(w0, 0, st.weeks - 1)), prev = sum(byWeek, weeksBack(w0, st.weeks, 2 * st.weeks - 1));
      if (rec.n >= st.minN && prev.n >= st.minN && LbFacts.state(rec, LbCatalog.mastery(cats[app], skill)) !== '到達') {
        var sr = LbFacts.stats(rec), sp = LbFacts.stats(prev);
        var noGain = (sr.acc - sp.acc) < st.accGain, noFaster = (sr.gmMs && sp.gmMs) ? sr.gmMs / sp.gmMs > st.timeRatio : true;
        if (noGain && noFaster) add(cls, { key: 'stall|' + lid + '|' + app + '|' + skill + '|' + w0, kind: 'stall', lids: [lid], app: app, skill: skill, week: w0,
          mag: rec.n / st.minN, ev: { accNow: sr.acc, accBase: sp.acc, msNow: sr.gmMs, msBase: sp.gmMs, nNow: rec.n, nBase: prev.n } });
      }
      // klass の材料
      var k = R.klass, two = sum(byWeek, weeksBack(w0, 0, k.weeks - 1));
      if (two.n >= k.kidMinN) (perSkill[cls + '|' + app + '|' + skill] = perSkill[cls + '|' + app + '|' + skill] || []).push({ lid: lid, acc: LbFacts.stats(two).acc });
    });
    Object.keys(perSkill).forEach(function (key) {
      var k = R.klass, kids = perSkill[key];
      if (kids.length < k.minKids) return;
      var low = kids.filter(function (x) { return x.acc < k.accBelow; }), share = low.length / kids.length;
      if (share < k.share) return;
      var p = key.split('|'), cls = p[0], app = p[1], skill = p.slice(2).join('|');
      add(cls, { key: 'klass|' + cls + '|' + app + '|' + skill + '|' + w0, kind: 'klass', lids: low.map(function (x) { return x.lid; }), app: app, skill: skill, week: w0,
        mag: share / k.share, ev: { kids: kids.length, low: low.length, below: k.accBelow } });
    });
    return out;
  }

  /**
   * 候補を計算する（純粋な計算）。
   * acc：集計（LbFacts.read の返り値）／roster：名簿（lid・grade・cls）／cats：{ アプリ: 目録 }／today：'YYYY-MM-DD'
   * 返す：{ 学級: [{ key, kind, lids, app, skill, ev, week }] }（強い順に最大3件）
   */
  function compute(acc, roster, cats, today, dismissed, rules) {
    dismissed = dismissed || {};
    var R = rules || RULES, cand = {};
    candidates(index(acc), classMap(roster), cats, weekOfDay(today), R).forEach(function (x) {
      if (!dismissed[x.key]) (cand[x.cls] = cand[x.cls] || []).push(x);
    });
    var out = {};
    Object.keys(cand).forEach(function (cls) {
      out[cls] = cand[cls].sort(function (a, b) { return KIND_RANK[b.kind] - KIND_RANK[a.kind] || b.mag - a.mag || (a.key < b.key ? -1 : 1); })
        .slice(0, R.max).map(function (x) { return { key: x.key, kind: x.kind, lids: x.lids, app: x.app, skill: x.skill, ev: x.ev, week: x.week }; });
    });
    return out;
  }
  function weekOfDay(today) { return LbFacts.weekOf(new Date(today + 'T12:00:00+09:00')); }

  /** 根拠の一文（教師の画面に出す。名前は含めない） */
  function describe(item) {
    var e = item.ev || {}, pct = function (x) { return x == null ? '—' : Math.round(x * 100) + '%'; }, sec = function (x) { return x ? (x / 1000).toFixed(1) + '秒' : '—'; };
    if (item.kind === 'drop') return '正答率 ' + pct(e.accBase) + ' → ' + pct(e.accNow) + '・時間 ' + sec(e.msBase) + ' → ' + sec(e.msNow) + '（今週 ' + e.nNow + '問・前の4週と比べて）';
    if (item.kind === 'stall') return '正答率 ' + pct(e.accBase) + ' → ' + pct(e.accNow) + '・時間 ' + sec(e.msBase) + ' → ' + sec(e.msNow) + '（前の4週 ' + e.nBase + '問 → 直近4週 ' + e.nNow + '問）';
    return '取り組んだ ' + e.kids + '人のうち ' + e.low + '人が正答率' + Math.round((e.below || 0.7) * 100) + '%未満（直近2週）';
  }

  /* ---------- 保存 ---------- */

  var textCol = LbSheets.textCol, clsCell = LbSheets.clsCell;

  /** 計算した候補を now3 シートに置く（丸ごと入れ替え） */
  function store(hubSs, byClass) {
    var sh = hubSs.getSheetByName(SHEET) || hubSs.insertSheet(SHEET), rows = [HEAD];
    Object.keys(byClass).sort().forEach(function (cls) {
      byClass[cls].forEach(function (x, i) { rows.push([cls, i + 1, x.key, x.kind, x.lids.join(','), x.app, x.skill, JSON.stringify(x.ev), x.week]); });
    });
    sh.clearContents(); textCol(sh, 1); textCol(sh, 9);
    sh.getRange(1, 1, rows.length, HEAD.length).setValues(rows);
    return rows.length - 1;
  }
  /** その学級の候補（判断済み・見たものを除く） */
  function read(hubSs, classKey) {
    var sh = hubSs.getSheetByName(SHEET);
    if (!sh || sh.getLastRow() < 2) return [];
    var done = decidedKeys(hubSs);
    return sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues().filter(function (r) { return clsCell(r[0]) === classKey && !done[r[2]]; })
      .sort(function (a, b) { return a[1] - b[1]; }).map(function (r) {
        var ev = {}; try { ev = JSON.parse(String(r[7])); } catch (e) {}
        return { key: String(r[2]), kind: String(r[3]), lids: String(r[4]).split(',').filter(Boolean), app: String(r[5]), skill: String(r[6]), ev: ev };
      });
  }
  /** 判断の記録（判断が変わった／見た）。押された時だけ1行 */
  function decide(hubSs, classKey, item, action, memo, by) {
    var sh = hubSs.getSheetByName(DEC_SHEET);
    if (!sh) { sh = hubSs.insertSheet(DEC_SHEET); sh.getRange(1, 1, 1, DEC_HEAD.length).setValues([DEC_HEAD]); textCol(sh, 3); }
    sh.appendRow([new Date(), by || '', classKey, String(item.key), String(item.kind || ''), action === 'changed' ? '判断が変わった' : '見た', String(memo || '').slice(0, 500)]);
  }
  /** 判断済み・見た キー（直近 dismissDays 日。同じ週のキーは同じなので、次の週にまた条件に当たれば出る） */
  function decidedKeys(hubSs, now, days) {
    var sh = hubSs.getSheetByName(DEC_SHEET), out = {};
    if (!sh || sh.getLastRow() < 2) return out;
    var since = (now || Date.now()) - (days || active(hubSs).dismissDays) * 86400000;
    sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
      var t = r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime();
      if (!isNaN(t) && t >= since) out[String(r[3])] = true;
    });
    return out;
  }

  /* ---------- 所有者が変えた値（rules シート） ---------- */

  function getPath(o, path) { return path.split('.').reduce(function (x, k) { return x == null ? undefined : x[k]; }, o); }
  function setPath(o, path, v) { var ks = path.split('.'), x = o; for (var i = 0; i < ks.length - 1; i++) x = x[ks[i]]; x[ks[ks.length - 1]] = v; }
  function specOf(path) { for (var i = 0; i < SPEC.length; i++) if (SPEC[i].path === path) return SPEC[i]; return null; }
  /** 値を確かめる。返す：数（直した値）か null（使えない値） */
  function clean(spec, v) {
    var x = typeof v === 'number' ? v : Number(String(v == null ? '' : v).trim());
    if (String(v).trim() === '' || !isFinite(x)) return null;
    if (spec.int) x = Math.round(x);
    if (x < spec.min - 1e-9 || x > spec.max + 1e-9) return null;
    return x;
  }
  /**
   * 初期値に {項目: 値} を重ねた規則（使えない値・知らない項目は捨てる）。
   * 返す：{ rules, bad: [項目] }
   */
  function withValues(values) {
    var r = JSON.parse(JSON.stringify(RULES)), bad = [];
    Object.keys(values || {}).forEach(function (path) {
      var sp = specOf(path), x = sp ? clean(sp, values[path]) : null;
      if (x == null) { bad.push(path); return; }
      setPath(r, path, x);
    });
    return { rules: r, bad: bad };
  }
  /** 所有者が変えた値（rules シート）。{ 項目: 値 }。初期値と同じ行は返さない */
  function savedValues(hubSs) {
    var sh = hubSs.getSheetByName(RULE_SHEET), out = {};
    if (!sh || sh.getLastRow() < 2) return out;
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      var path = String(r[0] || '').trim(), sp = specOf(path);
      if (!sp || r[1] === '' || r[1] == null) return;
      var x = clean(sp, r[1]);
      if (x != null && x !== getPath(RULES, path)) out[path] = x;
    });
    return out;
  }
  /** いま効いている規則（初期値＋rules シート）。シートの使えない値は無視する（初期値のまま） */
  function active(hubSs) { return withValues(savedValues(hubSs)).rules; }
  /**
   * 所有者が値を保存する。values：{ 項目: 値 }（初期値に戻す項目は値を空にする）。
   * 使えない値が1つでもあれば何も保存しない。返す：保存後の { 項目: 値 }
   */
  function saveValues(hubSs, values, by) {
    var cur = savedValues(hubSs), next = {};
    Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
    var bad = [];
    Object.keys(values || {}).forEach(function (path) {
      var sp = specOf(path);
      if (!sp) { bad.push(path); return; }
      var v = values[path];
      if (v === '' || v == null) { delete next[path]; return; }
      var x = clean(sp, v);
      if (x == null) { bad.push(path); return; }
      if (x === getPath(RULES, path)) delete next[path]; else next[path] = x;
    });
    if (bad.length) throw new Error('使えない値です：' + bad.map(function (p) { var sp = specOf(p); return sp ? sp.label : p; }).join('・'));
    var sh = hubSs.getSheetByName(RULE_SHEET) || hubSs.insertSheet(RULE_SHEET), now = new Date();
    var old = {};
    if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(function (r) { old[String(r[0])] = r; });
    var rows = [RULE_HEAD].concat(SPEC.map(function (sp) {
      var has = Object.prototype.hasOwnProperty.call(next, sp.path), o = old[sp.path];
      var changed = (has ? next[sp.path] : '') !== (o ? (o[1] === '' ? '' : Number(o[1])) : '');
      return [sp.path, has ? next[sp.path] : '', getPath(RULES, sp.path), sp.label + '（' + sp.unit + (sp.scale !== 1 ? '・' + sp.scale + '倍して表示' : '') + '）',
        changed ? now : (o ? o[4] : ''), changed ? String(by || '') : (o ? o[5] : '')];
    }));
    sh.clearContents();
    sh.getRange(1, 1, rows.length, RULE_HEAD.length).setValues(rows);
    return next;
  }
  /** 今週の3件を計算し直して now3 に置く（毎晩・所有者が保存した時）。返す：{ 学級: [...] } */
  function refresh(hubSs, fy, roster, cats, today) {
    var R = active(hubSs);
    var by = compute(LbFacts.read(hubSs, fy), roster, cats, today, decidedKeys(hubSs, null, R.dismissDays), R);
    store(hubSs, by);
    return by;
  }

  return { RULES: RULES, SPEC: SPEC, KIND_NAME: KIND_NAME, specOf: specOf, getPath: getPath, setPath: setPath, withValues: withValues, savedValues: savedValues, active: active, saveValues: saveValues, refresh: refresh, LABEL: LABEL, KIND_RANK: KIND_RANK, compute: compute, candidates: candidates, index: index, classMap: classMap, weekOfDay: weekOfDay, sum: sum, weeksBack: weeksBack, describe: describe, store: store, read: read, decide: decide, decidedKeys: decidedKeys };
})();
