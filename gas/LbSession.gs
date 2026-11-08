/**
 * LbSession.gs — 1回の取り組み（セッション）を1行で記録する
 *
 * 正本は learning-base。GAS には組み込みの Session があるので、名前は LbSession。
 *
 * セッションの形：
 * {
 *   ts: Date か ms, lid: '学習者ID'（または mail。どちらかで本人を決める）, app: 'tamath', activity: 'kuku',
 *   context: 'live' | 'practice' | 'test' | …（本番・練習など。アプリが決める）,
 *   directive: '指示ID'（指示を受けて出した問題なら）, ver: 'アプリの版',
 *   items: [{ q: '7×8', a: '56', ok: true, ms: 2140, first: 1200, tries: 1, skill: 'math/mul/kuku/7', mis: '誤答の型' }],
 *   extra: { …アプリだけが使う小さな情報 }
 * }
 * - ms：問題が出てから答えを確定するまで。first：最初のキー（タップ）まで。時間の集計は first を優先する
 *   （打鍵の数の差を時間に混ぜないため。算数TA の README「所要時間で測る」）
 * - 本人は学習者ID（lid）で束ねる。メールの無い転入生も記録でき、後でメールが付いても記録がつながる
 * - 教師が児童の代わりに取り組んだ時は、操作した教師を by に残す（Base.actAs）
 * - 全問を1つのセルに JSON で残す（解いた順・後半の崩れ・問題ごとの時間を後から分析できる）
 * - 書く時に技能ごとの統計（skills）もまとめておく（毎晩の集計で問題の欄を読まずに済む）
 */
var LbSession = (function () {
  var HEAD = ['ts', 'lid', 'mail', 'by', 'grade', 'cls', 'no', 'app', 'activity', 'context', 'directive', 'ver', 'items', 'skills', 'extra'];
  var COL = {}; HEAD.forEach(function (h, i) { COL[h] = i; });
  var CELL_MAX = 45000;          // セルの上限 50,000 字に余裕を見る
  var SHARD_ROWS = 150000;       // 1シートの行数の上限（越えたら sessions_<年度>_2 へ）

  function validate(sess, cat) {
    var e = [];
    if (!sess) return ['セッションがありません'];
    if (!sess.lid && !(sess.mail && String(sess.mail).indexOf('@') >= 0)) e.push('本人（lid か mail）がありません');
    if (!/^[a-z][a-z0-9-]*$/.test(String(sess.app || ''))) e.push('app が不正');
    if (!sess.activity) e.push('activity がありません');
    if (!Array.isArray(sess.items)) e.push('items は配列');
    var idx = cat ? LbCatalog.index(cat) : null;
    (sess.items || []).forEach(function (it, i) {
      if (!it || typeof it.ok !== 'boolean') e.push('items[' + i + '].ok は true / false');
      if (it && it.ms != null && !(Number(it.ms) >= 0)) e.push('items[' + i + '].ms は 0 以上');
      if (it && it.first != null && !(Number(it.first) >= 0)) e.push('items[' + i + '].first は 0 以上');
      if (!it || !it.skill) e.push('items[' + i + '] に skill がありません');
      else if (idx && !idx[it.skill]) e.push('items[' + i + '] の技能が目録にない: ' + it.skill);
    });
    return e;
  }

  /**
   * 技能ごとの統計。{ 技能: { n, ok, tn, sl, sl2, mis: { 型: 回数 } } }
   * tn：時間のある問題の数、sl・sl2：時間（ms）の対数の和と二乗和（反応時間は遅い側に裾を引くので対数で扱う）
   * cat を渡すと rollup の段にまとめる
   */
  function summarize(items, cat) {
    var out = {};
    (items || []).forEach(function (it) {
      if (!it || !it.skill) return;
      var key = cat ? LbCatalog.rollupKey(cat, it.skill) : it.skill;
      var s = out[key] || (out[key] = { n: 0, ok: 0, tn: 0, sl: 0, sl2: 0, mis: {} });
      s.n++;
      if (it.ok) s.ok++;
      var t = it.first != null ? Number(it.first) : Number(it.ms);
      if (t > 0 && isFinite(t)) { var l = Math.log(t); s.tn++; s.sl += l; s.sl2 += l * l; }
      if (!it.ok && it.mis) s.mis[it.mis] = (s.mis[it.mis] || 0) + 1;
    });
    for (var k in out) { out[k].sl = round(out[k].sl); out[k].sl2 = round(out[k].sl2); }
    return out;
  }
  function round(x) { return Math.round(x * 1e6) / 1e6; }

  /** シートの1行にする。child は名簿の行（Base.child / Base.learner の返り値。所属を記録時点の値で残す） */
  function toRow(sess, child, cat, by) {
    var ts = sess.ts instanceof Date ? sess.ts : new Date(sess.ts || Date.now());
    var skills = summarize(sess.items, cat);
    var extra = sess.extra ? JSON.parse(JSON.stringify(sess.extra)) : {};
    var items = JSON.stringify(sess.items || []);
    if (items.length > CELL_MAX) { items = ''; extra.truncated = (sess.items || []).length; }   // 技能別の統計は残る
    var ex = JSON.stringify(extra);
    if (ex === '{}') ex = '';
    var sk = JSON.stringify(skills);
    if (sk.length > CELL_MAX) throw new Error('技能別の統計が大きすぎます（' + sk.length + ' 字）。目録の rollup でまとめてください');
    var lid = child && child.lid ? child.lid : String(sess.lid || '');
    var mail = child ? (child.mail || '') : String(sess.mail || '').toLowerCase();
    return [ts, lid, mail, String(by || ''), child ? child.grade : '', child ? child.cls : '', child ? child.no : '',
      sess.app, String(sess.activity), String(sess.context || ''), String(sess.directive || ''), String(sess.ver || ''),
      items, sk, ex];
  }

  function fromRow(r) {
    function j(x, d) { try { return x === '' || x == null ? d : JSON.parse(String(x)); } catch (e) { return d; } }
    return { ts: r[COL.ts], lid: String(r[COL.lid]), mail: String(r[COL.mail]), by: String(r[COL.by]), grade: Number(r[COL.grade]) || 0, cls: String(r[COL.cls]), no: Number(r[COL.no]) || 0,
      app: String(r[COL.app]), activity: String(r[COL.activity]), context: String(r[COL.context]), directive: String(r[COL.directive]),
      ver: String(r[COL.ver]), items: j(r[COL.items], []), skills: j(r[COL.skills], {}), extra: j(r[COL.extra], {}) };
  }

  /** その年度のセッションのシート名の一覧（sessions_2026, sessions_2026_2, …）。古い順 */
  function sheetNames(ss, fy) {
    var base = 'sessions_' + fy, out = [];
    ss.getSheets().forEach(function (s) {
      var n = s.getName();
      if (n === base || n.indexOf(base + '_') === 0) out.push(n);
    });
    return out.sort(function (a, b) { return part(a) - part(b); });
    function part(n) { var m = n.match(/_(\d+)$/); return n === base ? 1 : (m ? Number(m[1]) : 1); }
  }

  /**
   * 書き込む。名簿にない人（おためし）は書かない（opts.allowGuest で書ける）。
   * 本人の決め方：opts.learner（名簿の行。教師が代わりに取り組む時は Base.actAs の learner）> sess.lid > sess.mail
   * opts.by：操作した教師のメール（代わりに取り組んだ時）
   * 返す：{ ok, sheet, reason }
   * ss はアプリの記録のスプレッドシート。cat は目録（検査と rollup に使う。省略可）
   */
  function write(ss, sess, opts) {
    opts = opts || {};
    var child = opts.learner !== undefined ? opts.learner : (sess.lid ? Base.learner(sess.lid) : Base.child(sess.mail));
    var err = validate(child ? withLid(sess, child.lid) : sess, opts.catalog);
    if (err.length) throw new Error('セッションの誤り：' + err.join(' / '));
    if (!child && !opts.allowGuest) return { ok: false, reason: 'guest' };
    var row = toRow(sess, child, opts.catalog, opts.by);
    var fy = Base.fyOf(row[COL.ts]);
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var names = sheetNames(ss, fy), name = names.length ? names[names.length - 1] : 'sessions_' + fy;
      var sh = ss.getSheetByName(name);
      if (sh && sh.getLastRow() >= SHARD_ROWS) { name = 'sessions_' + fy + '_' + (names.length + 1); sh = null; }
      if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]); sh.setFrozenRows(1); }
      sh.appendRow(row);
      return { ok: true, sheet: name };
    } finally { lock.releaseLock(); }
  }

  function withLid(sess, lid) { var o = {}; for (var k in sess) o[k] = sess[k]; o.lid = lid; return o; }

  return { HEAD: HEAD, COL: COL, SHARD_ROWS: SHARD_ROWS, validate: validate, summarize: summarize,
    toRow: toRow, fromRow: fromRow, sheetNames: sheetNames, write: write };
})();
