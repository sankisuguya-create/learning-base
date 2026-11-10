/**
 * Tune.gs — 学習BASE を直すための材料（使われ方の記録・今週の3件の働き・閾値を変えたら・先生の気づき・改善用の書き出し）
 *
 * 正本は learning-base。設計：`-` リポジトリ principles/learning-app-foundation.md §15、手順：docs/tuning-log.md
 *
 * 改善の入力の主役は、所有者・担任の観察の報告（どの画面で・何をしようとして・何が起きたか）と画面写真（撮影用）。
 * ここで自動で集めるのは、観察では見えないものだけ（決定 2026-11-10）：
 *   - 失敗：サーバーの失敗と画面の JavaScript の失敗（どこで・エラー文。メール・ID・長い数字は伏せる）
 *   - 実機の速さ：サーバーの処理時間と、開いてから表示までの往復（端末のメモリ 4GB以下／8GB 別）
 *   - 始めるまで：児童がホームを開いてから最初のページを開くまでの時間と経路（いまの学習／教科のタイル／教科の中）、
 *       教科に入って何も開かずに戻った回数（行き止まり）。直した時に効いたかを比べるため
 *   - 先生の気づき（feedback）
 * これを「失敗と速さ」の書き出し（exportText）にまとめ、所有者が Claude に渡す。児童の学習状態は入れない。
 * 閾値を見直す材料（tuning・tryRules：候補の数・分布）は児童の学習状態なので、所有者の画面の中だけで見る。
 *
 * 使われ方は、1つ起きるたびにスクリプトのプロパティに足す（シートに書くと遅いので）。
 * プロパティは日付と番号（0〜15、くじ）ごとに分け、同じ瞬間に2人が同じ所へ書く確率を下げる（重なると1回分落ちる。目安の数として使う）。
 * 毎晩、前日までの分を usage シートに1日1行（区分×出来事）でまとめ、プロパティから消す。
 */
var LbTune = (function () {
  var MIN_CELL = 5;
  var PFX = 'LB_U|', SHARDS = 16;
  var USAGE = 'usage', USAGE_HEAD = ['日付', '区分', '出来事', '回数'];
  var LOG = 'now3_log', LOG_HEAD = ['週', '学級', 'キー', '種類', '初めて出た日'];
  var FB = 'feedback', FB_HEAD = ['日時', '教師', '学級', '画面', '本文'];
  var CODE_HEAD = ['学習者ID・メール', '記号'];
  var KIND_JA = { drop: '急に崩れた', klass: '学級でつまずき', stall: '伸びが止まった' };
  var SPEED = { srv: [[1000, '1秒未満'], [2000, '1〜2秒'], [4000, '2〜4秒'], [Infinity, '4秒以上']],
    rt: [[2000, '2秒未満'], [4000, '2〜4秒'], [8000, '4〜8秒'], [Infinity, '8秒以上']],
    start: [[5000, '5秒未満'], [10000, '5〜10秒'], [20000, '10〜20秒'], [Infinity, '20秒以上']] };
  var PATHS = { now: 'いまの学習', tile: '教科のタイル', subject: '教科の中' };
  var MAX_KEYS = 80;   // 1つのプロパティに置く出来事の種類の上限（エラー文が大量に違う時、9KB を越えないように）

  function day(d) { return Utilities.formatDate(d || new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }
  function ymd(v) {
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) return day(v);
    return String(v == null ? '' : v).trim();
  }
  function textCol(sh, col) { sh.getRange(1, col, Math.max(sh.getMaxRows ? sh.getMaxRows() : 1000, 1000), 1).setNumberFormat('@'); }
  function sheet(hub, name, head, textCols) {
    var sh = hub.getSheetByName(name);
    if (sh) return sh;
    sh = hub.insertSheet(name);
    (textCols || []).forEach(function (c) { textCol(sh, c); });
    sh.getRange(1, 1, 1, head.length).setValues([head]);
    return sh;
  }
  /** 人数の欄：0 はそのまま、1〜4 は「5人未満」 */
  function people(n) { return !n ? '0' : n < MIN_CELL ? MIN_CELL + '人未満' : String(n); }
  function bucket(ms, edges) { for (var i = 0; i < edges.length; i++) if (ms < edges[i][0]) return edges[i][1]; return edges[edges.length - 1][1]; }
  function cleanName(s) { return String(s == null ? '' : s).replace(/[|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); }
  /** エラー文を記録に使える形に（メール・学習者ID・6桁以上の数は伏せる。80字まで） */
  function errText(e) {
    return cleanName(String(e && e.message != null ? e.message : e))
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '＜メール＞').replace(/\bL[0-9A-Za-z]{10}\b/g, '＜ID＞').replace(/\d{6,}/g, '＜数＞').slice(0, 80);
  }
  /** 端末のメモリ（navigator.deviceMemory。Chrome は 0.25〜8 に丸めて返す）→ 区分 */
  function memClass(m) { m = Number(m); return !m ? '不明' : m <= 4 ? '4GB以下' : '8GB'; }

  /* ---------- 使われ方 ---------- */

  /**
   * 出来事を数える（1回の呼び出しで1回だけ書く）。失敗しても画面の動きを止めない。
   * role：child / teacher / guest / none / -（不明）。events：'boot' や ['boot', 'srv:1秒未満']
   */
  function count(role, events) {
    try {
      var list = (Array.isArray(events) ? events : [events]).filter(Boolean);
      if (!list.length) return;
      var p = PropertiesService.getScriptProperties(), key = PFX + day() + '|' + Math.floor(Math.random() * SHARDS);
      var o = {};
      try { o = JSON.parse(p.getProperty(key) || '{}') || {}; } catch (e) { o = {}; }
      list.forEach(function (ev) {
        var k = cleanName(role || '-') + '|' + cleanName(ev);
        if (!(k in o) && Object.keys(o).length >= MAX_KEYS) k = cleanName(role || '-') + '|その他';
        o[k] = (o[k] || 0) + 1;
      });
      p.setProperty(key, JSON.stringify(o));
    } catch (e) { /* 数えられなくても動く */ }
  }
  function speed(kind, ms) { return kind + ':' + bucket(Number(ms) || 0, SPEED[kind]); }
  /** 失敗の出来事の名前：err:どこで:エラー文 */
  function err(where, e) { return 'err:' + cleanName(where).slice(0, 40) + ':' + errText(e); }
  /**
   * ホームを開いた時に画面が送る、前回分の記録（呼び出しを増やさない）から出来事を作る。
   * o: { lastMs, mem, start: { path, ms }, dead }。児童の「始めるまで」「行き止まり」は学年ごと
   */
  function bootEvents(role, grade, o) {
    o = o || {};
    var ev = [];
    if (Number(o.lastMs) > 0) ev.push('rt:' + memClass(o.mem) + ':' + bucket(Number(o.lastMs), SPEED.rt));
    if (role === 'child' && grade) {
      var st = o.start || {};
      if (PATHS[st.path] && Number(st.ms) > 0) ev.push('start:' + grade + '年:' + PATHS[st.path] + ':' + bucket(Number(st.ms), SPEED.start));
      var d = Math.min(Number(o.dead) || 0, 20);
      for (var i = 0; i < d; i++) ev.push('deadend:' + grade + '年');
    }
    return ev;
  }

  /** プロパティにある分（日付 → { 区分|出来事: 回数 }）。beforeDay を渡すとその日より前だけ */
  function pending(beforeDay) {
    var all = PropertiesService.getScriptProperties().getProperties() || {}, out = {}, keys = [];
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(PFX) !== 0) return;
      var d = k.split('|')[1];
      if (beforeDay && d >= beforeDay) return;
      var o = {};
      try { o = JSON.parse(all[k]) || {}; } catch (e) { o = {}; }
      var to = out[d] || (out[d] = {});
      Object.keys(o).forEach(function (e) { to[e] = (to[e] || 0) + (Number(o[e]) || 0); });
      keys.push(k);
    });
    return { byDay: out, keys: keys };
  }
  /** 毎晩：前日までの分を usage シートへ（1日×区分×出来事で1行）。書いてから消す（落ちても数え落としより二重の方が気づける） */
  function flush(hub, today) {
    var pd = pending(today || day()), rows = [];
    Object.keys(pd.byDay).sort().forEach(function (d) {
      Object.keys(pd.byDay[d]).sort().forEach(function (e) { var i = e.indexOf('|'); rows.push([d, e.slice(0, i), e.slice(i + 1), pd.byDay[d][e]]); });
    });
    if (rows.length) {
      var sh = sheet(hub, USAGE, USAGE_HEAD, [1]);
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, USAGE_HEAD.length).setValues(rows);
    }
    var p = PropertiesService.getScriptProperties();
    pd.keys.forEach(function (k) { p.deleteProperty(k); });
    return rows.length;
  }
  /** sinceDay 以降の使われ方（シート＋まだプロパティにある分）。{ 日付: { 区分|出来事: 回数 } } */
  function usage(hub, sinceDay) {
    var out = {};
    function add(d, e, n) { if (d < sinceDay) return; var o = out[d] || (out[d] = {}); o[e] = (o[e] || 0) + n; }
    var sh = hub.getSheetByName(USAGE);
    if (sh && sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) { add(ymd(r[0]), String(r[1]) + '|' + String(r[2]), Number(r[3]) || 0); });
    var pd = pending(null).byDay;
    Object.keys(pd).forEach(function (d) { Object.keys(pd[d]).forEach(function (e) { add(d, e, pd[d][e]); }); });
    return out;
  }

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

  /* ---------- 先生の気づき ---------- */

  function saveFeedback(hub, by, classKey, view, text) {
    text = String(text == null ? '' : text).trim().slice(0, 1000);
    if (!text) throw new Error('気づきが空です');
    var sh = sheet(hub, FB, FB_HEAD, [3, 4, 5]);
    sh.appendRow([new Date(), String(by || ''), String(classKey || ''), cleanName(view), text]);
  }
  function readFeedback(hub, sinceMs) {
    var sh = hub.getSheetByName(FB);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().map(function (r) {
      var t = r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime();
      return { t: t, by: String(r[1]), cls: String(r[2]), view: String(r[3]), text: String(r[4]) };
    }).filter(function (f) { return !isNaN(f.t) && f.t >= sinceMs && f.text; });
  }

  /* ---------- 記号（名前をかくす・気づきの置き換え） ---------- */

  /**
   * 今年度の記号表（ハブの pseudo_<年度>。学習者ID（教師はメール）→ 記号）。まだ記号の無い人にだけ振って足す。
   * 記号は乱数で振る（名前・番号・ID から導けない）。表はハブにだけ置く。
   */
  function codes(hub, fy, roster, teachers) {
    var name = 'pseudo_' + fy;
    function readEx() {
      var sh = hub.getSheetByName(name), ex = {};
      if (sh && sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) { if (r[0] && r[1]) ex[String(r[0])] = String(r[1]); });
      return ex;
    }
    var ppl = roster.filter(function (r) { return r.lid && r.name; }).map(function (r) { return { id: r.lid, sei: r.sei, mei: r.mei, seiKana: r.seiKana, meiKana: r.meiKana }; })
      .concat((teachers || []).filter(function (t) { return t.mail && (t.sei || t.mei); }).map(function (t) { return { id: t.mail, sei: t.sei, mei: t.mei, seiKana: t.seiKana, meiKana: t.meiKana }; }));
    var ex = readEx();
    if (ppl.every(function (p) { return ex[p.id]; })) return LbPseudo.table(ppl, { existing: ex });
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      ex = readEx();
      var tbl = LbPseudo.table(ppl, { existing: ex });
      var rows = ppl.filter(function (p) { return !ex[p.id]; }).map(function (p) { return [p.id, tbl.codeOf[p.id]]; });
      if (rows.length) {
        var sh = sheet(hub, name, CODE_HEAD, [1, 2]);
        sh.getRange(sh.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
      }
      return tbl;
    } finally { lock.releaseLock(); }
  }
  /* ---------- 改善用の書き出し ---------- */

  /**
   * 最後の確かめ：メール・学習者ID・名前（記号表の全表記）が残っていないか。
   * 返す：{ ok, problems: [文] }。名前は置き換えをもう一度かけて、当たる箇所が無いことで確かめる
   */
  function guard(text, tbl, roster) {
    var probs = [];
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.test(text)) probs.push('メールアドレスが残っています');
    var lids = 0;
    roster.forEach(function (r) { if (r.lid && text.indexOf(r.lid) >= 0) lids++; });
    if (lids) probs.push('学習者ID が ' + lids + ' 件 残っています');
    var again = LbPseudo.replace(text, tbl);
    if (again.hits.length) probs.push('名前が ' + again.hits.length + ' か所 残っています');
    return { ok: !probs.length, problems: probs };
  }

  function table(head, rows) {
    return '| ' + head.join(' | ') + ' |\n|' + head.map(function () { return '---'; }).join('|') + '|\n' +
      rows.map(function (r) { return '| ' + r.map(function (c) { return String(c).replace(/\|/g, '／').replace(/\n/g, ' '); }).join(' | ') + ' |'; }).join('\n');
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

  /**
   * 「失敗と速さ」の書き出し（Markdown。所有者が Claude に渡す）。観察では見えないものだけ。児童の学習状態は入れない。
   * o: { hub, fy, today, ver, roster, teachers, settings: [{ classKey, hidden, now }], days }
   * 返す：{ ok, text（ok の時だけ）, problems, notes: [目で確かめてほしいこと（画面にだけ出す。書き出しには入れない）] }
   */
  function exportText(o) {
    var today = o.today || day(), days = o.days || 14;
    var sinceDay = day(new Date(new Date(today + 'T12:00:00+09:00').getTime() - (days - 1) * 86400000));
    var last7 = day(new Date(new Date(today + 'T12:00:00+09:00').getTime() - 6 * 86400000));
    var out = [], notes = [];
    out.push('# 学習BASE 失敗と速さ');
    out.push('書き出した日：' + today + '／版：' + (o.ver || '不明') + '／年度：' + o.fy + '／児童の学習状態は入れていません');

    var u = usage(o.hub, sinceDay), ev = {};
    Object.keys(u).forEach(function (d) {
      Object.keys(u[d]).forEach(function (e) { var x = ev[e] || (ev[e] = { a: 0, b: 0 }); if (d >= last7) x.a += u[d][e]; else x.b += u[d][e]; });
    });
    function pick(re) {
      return Object.keys(ev).filter(function (e) { return re.test(e.slice(e.indexOf('|') + 1)); }).sort().map(function (e) {
        var i = e.indexOf('|'); return { role: e.slice(0, i), name: e.slice(i + 1), a: ev[e].a, b: ev[e].b };
      });
    }
    var boots = pick(/^boot$/);
    out.push('\n開いた回数（分母）：' + (boots.length ? boots.map(function (r) { return r.role + ' ' + r.a + '（その前7日 ' + r.b + '）'; }).join('・') : 'まだ記録がありません'));

    var errs = pick(/^(err|js|client):|^その他$/);
    out.push('\n## 1. 失敗（直近7日と、その前の7日）\nerr＝サーバーの失敗（どこで:エラー文）／js＝画面の JavaScript の失敗／client＝画面の読み込みの失敗。メール・ID・長い数は伏せています');
    out.push(errs.length ? table(['区分', '失敗', '直近7日', 'その前7日'], errs.map(function (r) { return [r.role, r.name, r.a, r.b]; })) : '（ありません）');

    var sp = pick(/^(srv|rt):/);
    out.push('\n## 2. 速さ\nsrv＝サーバーでの処理時間（ホームを開く時）／rt＝開いてから表示までの往復（端末のメモリ別。前回分）');
    out.push(sp.length ? table(['区分', '速さ', '直近7日', 'その前7日'], sp.map(function (r) { return [r.role, r.name, r.a, r.b]; })) : '（まだ記録がありません）');

    var st = pick(/^(start|deadend):/);
    out.push('\n## 3. 始めるまで（児童。直した時に効いたかを比べる用）\nstart＝ホームを開いてから最初のページを開くまで（学年:経路:時間）／deadend＝教科に入って何も開かずに戻った回数');
    out.push(st.length ? table(['出来事', '直近7日', 'その前7日'], st.map(function (r) { return [r.name, r.a, r.b]; })) : '（まだ記録がありません）');

    var s = o.settings || [], saved = LbAlerts.savedValues(o.hub);
    var hidCls = s.filter(function (x) { return x.hidden > 0; }).length, nowCls = s.filter(function (x) { return x.now > 0; }).length;
    out.push('\n## 4. 先生の設定\n- 学級：' + s.length + '／かくしたページ：計 ' + s.reduce(function (a, x) { return a + x.hidden; }, 0) + ' 件（' + hidCls + ' 学級）' +
      '／いまの学習：計 ' + s.reduce(function (a, x) { return a + x.now; }, 0) + ' 件（' + nowCls + ' 学級）');
    out.push('- 閾値（所有者が初期値から変えたもの）：' + (Object.keys(saved).length ? Object.keys(saved).map(function (k) { return k + ' ' + LbAlerts.getPath(LbAlerts.RULES, k) + '→' + saved[k]; }).join('・') : 'なし'));

    // 気づき：先生のメールは「先生n」に、学級は学年だけに、文の中の名前は記号に
    var tbl = codes(o.hub, o.fy, o.roster, o.teachers);
    var fb = readFeedback(o.hub, new Date(sinceDay + 'T00:00:00+09:00').getTime()), tno = {}, tn = 0;
    out.push('\n## 5. 先生の気づき（直近' + days + '日。文の中の名前は記号〔…〕に置き換え済み）');
    if (!fb.length) out.push('（ありません）');
    fb.forEach(function (f) {
      if (!tno[f.by]) tno[f.by] = '先生' + (++tn);
      var r = LbPseudo.replace(f.text, tbl);
      r.skipped1.forEach(function (x) { notes.push('1文字の名前かもしれない「' + x.name + '」を置き換えていません（' + day(new Date(f.t)) + ' の気づき）'); });
      r.warn.forEach(function (x) { notes.push('「' + x.name + '」を名前として ' + x.count + ' か所 置き換えました。普通の言葉なら、元の文を言い換えてください'); });
      if (r.hits.length) notes.push(day(new Date(f.t)) + ' の気づきに児童・先生の名前がありました（記号に置き換え済み）。児童の学習のようすが書かれていないか読んでください');
      var g = String(f.cls).split('-')[0];
      out.push('- ' + day(new Date(f.t)) + '・' + tno[f.by] + '・' + (Number(g) ? g + '年' : '学級なし') + '・' + (f.view || '—') + '：' + r.text);
    });

    // 全体にも置き換えをかける（エラー文などに名前と同じ表記がある時のため）。置き換えた所は画面で知らせる
    var text = out.join('\n'), all = LbPseudo.replace(text, tbl);
    var fbStart = text.indexOf('\n## 5. ');
    all.hits.filter(function (h) { return h.start < fbStart; }).forEach(function (h) { notes.push('気づき以外の所で「' + h.from + '」を記号に置き換えました（エラー文などと重なっています）'); });
    text = all.text;
    var g = guard(text, tbl, o.roster);
    return { ok: g.ok, text: g.ok ? text : '', problems: g.problems, notes: notes.filter(function (v, i, a) { return a.indexOf(v) === i; }) };
  }
  /** 直近7日の失敗の件数（月曜のメールに1行） */
  function errorCount(hub, today) {
    var since = day(new Date(new Date((today || day()) + 'T12:00:00+09:00').getTime() - 6 * 86400000)), u = usage(hub, since), n = 0;
    Object.keys(u).forEach(function (d) { Object.keys(u[d]).forEach(function (e) { if (/\|(err|js|client):/.test(e)) n += u[d][e]; }); });
    return n;
  }

  return { MIN_CELL: MIN_CELL, count: count, speed: speed, err: err, errText: errText, memClass: memClass, bootEvents: bootEvents, errorCount: errorCount, pending: pending, flush: flush, usage: usage,
    logAlerts: logAlerts, performance: performance, variants: variants, sensitivity: sensitivity, tryRules: tryRules, distributions: distributions, people: people,
    tuning: tuning, saveFeedback: saveFeedback, readFeedback: readFeedback, codes: codes, guard: guard, exportText: exportText };
})();
