/**
 * Tune.gs — 学習BASE を直すための材料（使われ方の記録・今週の3件の働き・閾値を変えたら・先生の気づき・改善用の書き出し）
 *
 * 正本は learning-base。設計：`-` リポジトリ principles/learning-app-foundation.md §15、手順：docs/tuning-log.md
 *
 * 流れ：所有者が先生の画面の「改善用に書き出す」を押す → 文章をコピーして AI（私用 PC の Claude）に渡す
 *   → AI が閾値・設定・画面の直し方を提案 → PR → マージで反映 → 次の書き出しで効いたかを見る。
 * 書き出しは学校の外（私用 PC）に出る前提で作る。だから：
 *   - 児童の名前・メール・学習者ID を書かない（最後に機械で確かめ、残っていれば書き出さない）
 *   - 児童の人数は 5人未満なら「5人未満」と書く（1人・2人の欄から個人が分かるのを防ぐ）
 *   - 先生の気づきの文の中の名前は記号に置き換える（記号表はハブの pseudo_<年度> にだけある）
 *   - 先生のメールは書かない（先生1・先生2）。学級は学年だけ
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
  /** 閾値を変えたら：試す値（いまの値の上下）。ここに足せば書き出しに出る */
  var VARIANTS = [
    ['drop.accDrop', [0.10, 0.20]], ['drop.timeRise', [1.15, 1.40]], ['drop.weekMinN', [5, 20]],
    ['klass.accBelow', [0.6, 0.8]], ['klass.share', [0.4, 0.6]], ['klass.minKids', [3, 8]],
    ['stall.minN', [10, 30]], ['stall.accGain', [0.01, 0.05]], ['stall.timeRatio', [0.95, 0.99]]
  ];
  var SPEED = { srv: [[1000, '1秒未満'], [2000, '1〜2秒'], [4000, '2〜4秒'], [Infinity, '4秒以上']],
    rt: [[2000, '2秒未満'], [4000, '2〜4秒'], [8000, '4〜8秒'], [Infinity, '8秒以上']] };

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
  function cleanName(s) { return String(s == null ? '' : s).replace(/[|\s]/g, '').slice(0, 60); }

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
      list.forEach(function (ev) { var k = cleanName(role || '-') + '|' + cleanName(ev); o[k] = (o[k] || 0) + 1; });
      p.setProperty(key, JSON.stringify(o));
    } catch (e) { /* 数えられなくても動く */ }
  }
  function speed(kind, ms) { return kind + ':' + bucket(Number(ms) || 0, SPEED[kind]); }

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

  function getPath(o, path) { return path.split('.').reduce(function (x, k) { return x == null ? undefined : x[k]; }, o); }
  function setPath(o, path, v) { var ks = path.split('.'), x = o; for (var i = 0; i < ks.length - 1; i++) x = x[ks[i]]; x[ks[ks.length - 1]] = v; }
  /** 今週の候補の数（上位3件に切る前・判断済みも含む）を、いまの値と、1つずつ値を変えた時とで比べる */
  function sensitivity(acc, roster, cats, today) {
    var ix = LbAlerts.index(acc), clsOf = LbAlerts.classMap(roster), w0 = LbAlerts.weekOfDay(today);
    function run(rules) {
      var c = { drop: 0, klass: 0, stall: 0 }, cls = {};
      LbAlerts.candidates(ix, clsOf, cats, w0, rules).forEach(function (x) { c[x.kind]++; cls[x.cls] = true; });
      c.classes = Object.keys(cls).length;
      return c;
    }
    var rows = [Object.assign({ rule: 'いまの値', value: '', now: '' }, run(LbAlerts.RULES))];
    VARIANTS.forEach(function (v) {
      v[1].forEach(function (val) {
        var r = JSON.parse(JSON.stringify(LbAlerts.RULES));
        setPath(r, v[0], val);
        rows.push(Object.assign({ rule: v[0], value: val, now: getPath(LbAlerts.RULES, v[0]) }, run(r)));
      });
    });
    return rows;
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
  function distributions(acc, roster, cats, today) {
    var R = LbAlerts.RULES, ix = LbAlerts.index(acc), clsOf = LbAlerts.classMap(roster), w0 = LbAlerts.weekOfDay(today);
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
  /** 名前をかくす用：{ 学習者ID: 記号 }（記号表を作らずに読むだけ。無い人は出さない） */
  function codeOf(hub, fy) {
    var sh = hub.getSheetByName('pseudo_' + fy), out = {};
    if (sh && sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) { if (r[0] && r[1]) out[String(r[0])] = String(r[1]); });
    return out;
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

  function pct(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }
  function table(head, rows) {
    return '| ' + head.join(' | ') + ' |\n|' + head.map(function () { return '---'; }).join('|') + '|\n' +
      rows.map(function (r) { return '| ' + r.map(function (c) { return String(c).replace(/\|/g, '／').replace(/\n/g, ' '); }).join(' | ') + ' |'; }).join('\n');
  }

  /**
   * 改善用の書き出し（Markdown）。
   * o: { hub, fy, today, ver, roster, teachers, acc, cats, settings: [{ classKey, hidden, now }], days }
   * 返す：{ ok, text（ok の時だけ）, problems, notes: [目で確かめてほしいこと（画面にだけ出す。書き出しには入れない）] }
   */
  function exportText(o) {
    var today = o.today || day(), days = o.days || 14;
    var sinceDay = day(new Date(new Date(today + 'T12:00:00+09:00').getTime() - (days - 1) * 86400000));
    var out = [], notes = [];
    out.push('# 学習BASE 改善用の書き出し');
    out.push('書き出した日：' + today + '／版：' + (o.ver || '不明') + '／年度：' + o.fy + '／人数の欄は ' + MIN_CELL + '人未満を伏せています');

    out.push('\n## 1. 今週の3件の規則（gas/Alerts.gs の RULES）\n```json\n' + JSON.stringify(LbAlerts.RULES) + '\n```');

    var perf = performance(o.hub, today, 8);
    out.push('\n## 2. 今週の3件の働き（直近8週・全校）\n出た＝画面に出した件数。押されていない＝出たが「判断が変わった」「見た」のどちらも押されていない。');
    out.push(perf.length ? table(['週', '種類', '出た', '判断が変わった', '見た', '押されていない'], perf.map(function (r) { return [r.week, KIND_JA[r.kind] || r.kind, r.fired, r.changed, r.seen, r.open]; })) : '（まだ記録がありません）');

    var sens = sensitivity(o.acc, o.roster, o.cats, today);
    out.push('\n## 3. 閾値を1つ変えたら（今週の候補の数・3件に切る前・判断済みも含む）');
    out.push(table(['規則', 'いまの値', '試す値', '急に崩れた', '学級でつまずき', '伸びが止まった', '候補のある学級'], sens.map(function (r) { return [r.rule, r.now, r.value, r.drop, r.klass, r.stall, r.classes]; })));

    var dist = distributions(o.acc, o.roster, o.cats, today);
    out.push('\n## 4. 記録の分布（今週。児童の数。同じ児童が別の技能で別の区間に入ることがある）');
    out.push('### 学年ごと\n' + table(['学年', '今週 取り組んだ児童', '直近4週 取り組んだ児童', '今週の問題数'], dist.grades.map(function (g) { return [g.grade + '年', g.week, g.month, g.n]; })));
    var R = LbAlerts.RULES;
    out.push('### 急に崩れた：正答率の下がり幅（ポイント。いまの閾値 ' + Math.round(R.drop.accDrop * 100) + '）\n' + table(['区間', '児童'], dist.hist.dropAcc));
    out.push('### 急に崩れた：時間の伸び（今週÷前の4週。いまの閾値 ' + R.drop.timeRise + '倍）\n' + table(['区間', '児童'], dist.hist.dropTime));
    out.push('### 伸びが止まった：正答率の伸び（ポイント。いまの閾値 ' + Math.round(R.stall.accGain * 100) + ' 未満で止まった扱い）\n' + table(['区間', '児童'], dist.hist.stallAcc));
    out.push('### 伸びが止まった：時間の比（直近4週÷その前。いまの閾値 ' + R.stall.timeRatio + ' より大きいと止まった扱い）\n' + table(['区間', '児童'], dist.hist.stallTime));
    out.push('### 学級でつまずき：70%未満の児童の割合（学級×技能のまとまりの数。いまの閾値 ' + Math.round(R.klass.share * 10) + '割）\n' + table(['区間', 'まとまり'], dist.hist.klassShare));

    var u = usage(o.hub, sinceDay), last7 = day(new Date(new Date(today + 'T12:00:00+09:00').getTime() - 6 * 86400000));
    var ev = {};
    Object.keys(u).forEach(function (d) {
      Object.keys(u[d]).forEach(function (e) { var x = ev[e] || (ev[e] = { a: 0, b: 0 }); if (d >= last7) x.a += u[d][e]; else x.b += u[d][e]; });
    });
    var isSpeed = function (e) { return /\|(srv|rt):/.test(e); }, isErr = function (e) { return /\|(err|client):/.test(e); };
    var rowsOf = function (f) {
      return Object.keys(ev).filter(f).sort().map(function (e) { var i = e.indexOf('|'); return [e.slice(0, i), e.slice(i + 1), ev[e].a, ev[e].b]; });
    };
    out.push('\n## 5. 使われ方（直近7日と、その前の7日。回数）\nboot＝学習BASE を開いた／open:＝ページを開いた／act:＝先生の操作');
    var useRows = rowsOf(function (e) { return !isSpeed(e) && !isErr(e); });
    out.push(useRows.length ? table(['区分', '出来事', '直近7日', 'その前7日'], useRows) : '（まだ記録がありません）');
    out.push('\n## 6. 速さと失敗\nsrv＝サーバーでの処理時間／rt＝開いてから表示までの往復（前回分）／err＝サーバーの失敗／client＝画面の読み込みの失敗');
    var spRows = rowsOf(function (e) { return isSpeed(e) || isErr(e); });
    out.push(spRows.length ? table(['区分', '出来事', '直近7日', 'その前7日'], spRows) : '（まだ記録がありません）');

    var s = o.settings || [];
    var hidCls = s.filter(function (x) { return x.hidden > 0; }).length, nowCls = s.filter(function (x) { return x.now > 0; }).length;
    out.push('\n## 7. 先生の設定\n- 学級：' + s.length + '／かくしたページ：計 ' + s.reduce(function (a, x) { return a + x.hidden; }, 0) + ' 件（' + hidCls + ' 学級）' +
      '／いまの学習：計 ' + s.reduce(function (a, x) { return a + x.now; }, 0) + ' 件（' + nowCls + ' 学級）');

    // 気づき：先生のメールは「先生n」に、学級は学年だけに、文の中の名前は記号に
    var tbl = codes(o.hub, o.fy, o.roster, o.teachers);
    var fb = readFeedback(o.hub, new Date(sinceDay + 'T00:00:00+09:00').getTime()), tno = {}, tn = 0;
    out.push('\n## 8. 先生の気づき（直近' + days + '日。文の中の名前は記号〔…〕に置き換え済み）');
    if (!fb.length) out.push('（ありません）');
    fb.forEach(function (f) {
      if (!tno[f.by]) tno[f.by] = '先生' + (++tn);
      var r = LbPseudo.replace(f.text, tbl);
      r.skipped1.forEach(function (x) { notes.push('1文字の名前かもしれない「' + x.name + '」を置き換えていません（' + day(new Date(f.t)) + ' の気づき）'); });
      r.warn.forEach(function (x) { notes.push('「' + x.name + '」を名前として ' + x.count + ' か所 置き換えました。普通の言葉なら、元の文を言い換えてください'); });
      var g = String(f.cls).split('-')[0];
      out.push('- ' + day(new Date(f.t)) + '・' + tno[f.by] + '・' + (Number(g) ? g + '年' : '学級なし') + '・' + (f.view || '—') + '：' + r.text);
    });

    // 全体にも置き換えをかける（技能の名前などが名前と同じ表記の時のため）。置き換えた所は画面で知らせる
    var text = out.join('\n'), all = LbPseudo.replace(text, tbl);
    var fbStart = text.indexOf('\n## 8. ');
    all.hits.filter(function (h) { return h.start < fbStart; }).forEach(function (h) { notes.push('気づき以外の所で「' + h.from + '」を記号に置き換えました（技能の名前などと重なっています）'); });
    text = all.text;
    var g = guard(text, tbl, o.roster);
    return { ok: g.ok, text: g.ok ? text : '', problems: g.problems, notes: notes.filter(function (v, i, a) { return a.indexOf(v) === i; }) };
  }

  return { MIN_CELL: MIN_CELL, VARIANTS: VARIANTS, count: count, speed: speed, pending: pending, flush: flush, usage: usage,
    logAlerts: logAlerts, performance: performance, sensitivity: sensitivity, distributions: distributions, people: people,
    saveFeedback: saveFeedback, readFeedback: readFeedback, codes: codes, codeOf: codeOf, guard: guard, exportText: exportText };
})();
