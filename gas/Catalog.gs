/**
 * Catalog.gs — アプリが宣言する「技能の目録」
 *
 * 正本は learning-base。記録（Session）・集計（Facts）・指示・得意苦手は、すべてこの目録の技能のキーでつながる。
 * アプリが違っても、同じキーなら同じ技能として扱う。
 *
 * 目録の形：
 * {
 *   app: 'tamath',                 // アプリの id（英小文字・数字・-）
 *   title: '算数タイムアタック',
 *   version: 3,                    // 目録の版（中身を変えたら上げる）
 *   skills: [                      // 技能。キーは「/」区切りの階層（日本語の字も使える：kanji/g3/港）
 *     { key: 'math/mul/kuku/7', label: '7の段', grade: 3, curriculum: '3A(3)', mastery: { acc: 0.95 } }
 *   ],
 *   misconceptions: [             // 誤答の型（任意）
 *     { key: 'mul/adjacent-row', label: '隣の段と取り違える' }
 *   ],
 *   mastery: { minN: 20, acc: 0.9, gmMs: 0, windowWeeks: 4 },   // 「到達」の基準（技能ごとに上書きできる）
 *   rollup: 0,                     // 集計の細かさ。0＝キーのまま。2 なら頭の2段（kanji/g3）にまとめる
 *   directives: ['weight', 'unlock', 'range']   // 受け取れる指示の種類
 * }
 */
var LbCatalog = (function () {
  var DIRECTIVE_KINDS = ['weight', 'unlock', 'range'];
  var DEFAULT_MASTERY = { minN: 20, acc: 0.9, gmMs: 0, windowWeeks: 4 };
  var KEY_RE = /^[^\/\s]+(\/[^\/\s]+)*$/;
  var SHEET = 'catalog';
  var HEAD = ['app', 'version', 'title', 'updated', 'json'];

  /** 目録の誤り。空の配列なら正しい */
  function validate(cat) {
    var e = [];
    if (!cat || typeof cat !== 'object') return ['目録がありません'];
    if (!/^[a-z][a-z0-9-]*$/.test(String(cat.app || ''))) e.push('app は英小文字・数字・- で書く: ' + cat.app);
    if (!cat.title) e.push('title がありません');
    if (!(Number(cat.version) >= 1)) e.push('version は 1 以上の数');
    var seen = {};
    (cat.skills || []).forEach(function (s, i) {
      if (!s || !KEY_RE.test(String(s.key || ''))) { e.push('skills[' + i + '] のキーが不正: ' + (s && s.key)); return; }
      if (seen[s.key]) e.push('技能のキーが重複: ' + s.key);
      seen[s.key] = true;
      if (!s.label) e.push('技能 ' + s.key + ' に label がありません');
      if (s.mastery) e = e.concat(checkMastery(s.mastery, '技能 ' + s.key));
    });
    if (!(cat.skills || []).length) e.push('skills が空です');
    var ms = {};
    (cat.misconceptions || []).forEach(function (m, i) {
      if (!m || !m.key) { e.push('misconceptions[' + i + '] に key がありません'); return; }
      if (ms[m.key]) e.push('誤答の型のキーが重複: ' + m.key);
      ms[m.key] = true;
      if (!m.label) e.push('誤答の型 ' + m.key + ' に label がありません');
    });
    if (cat.mastery) e = e.concat(checkMastery(cat.mastery, '目録'));
    if (cat.rollup != null && !(Number(cat.rollup) >= 0)) e.push('rollup は 0 以上の整数');
    (cat.directives || []).forEach(function (d) { if (DIRECTIVE_KINDS.indexOf(d) < 0) e.push('知らない指示の種類: ' + d); });
    return e;
  }
  function checkMastery(m, where) {
    var e = [];
    if (m.acc != null && !(m.acc > 0 && m.acc <= 1)) e.push(where + ' の mastery.acc は 0〜1');
    if (m.minN != null && !(m.minN >= 1)) e.push(where + ' の mastery.minN は 1 以上');
    if (m.gmMs != null && !(m.gmMs >= 0)) e.push(where + ' の mastery.gmMs は 0 以上（0＝時間を見ない）');
    if (m.windowWeeks != null && !(m.windowWeeks >= 1)) e.push(where + ' の mastery.windowWeeks は 1 以上');
    return e;
  }

  function index(cat) {
    var o = {};
    (cat.skills || []).forEach(function (s) { o[s.key] = s; });
    return o;
  }

  /** その技能の「到達」の基準（技能の上書き > 目録 > 既定） */
  function mastery(cat, key) {
    var out = {}, k;
    for (k in DEFAULT_MASTERY) out[k] = DEFAULT_MASTERY[k];
    if (cat && cat.mastery) for (k in cat.mastery) out[k] = cat.mastery[k];
    var s = cat ? index(cat)[key] : null;
    if (s && s.mastery) for (k in s.mastery) out[k] = s.mastery[k];
    return out;
  }

  /** 集計のキー（rollup 段にまとめる） */
  function rollupKey(cat, key) {
    var r = Number(cat && cat.rollup) || 0;
    if (!r) return key;
    return String(key).split('/').slice(0, r).join('/');
  }

  /** 目録をハブの catalog シートに書く。中身が同じなら書かない。返す：書いたか */
  function publish(hubSs, cat) {
    var err = validate(cat);
    if (err.length) throw new Error('目録の誤り：' + err.join(' / '));
    var sh = hubSs.getSheetByName(SHEET) || hubSs.insertSheet(SHEET);
    var v = sh.getDataRange().getValues();
    if (!v.length || String(v[0][0]) !== HEAD[0]) { sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]); v = [HEAD]; }
    var json = JSON.stringify(cat);
    for (var i = 1; i < v.length; i++) {
      if (String(v[i][0]) === cat.app) {
        if (String(v[i][4]) === json) return false;
        sh.getRange(i + 1, 1, 1, HEAD.length).setValues([[cat.app, cat.version, cat.title, new Date(), json]]);
        return true;
      }
    }
    sh.appendRow([cat.app, cat.version, cat.title, new Date(), json]);
    return true;
  }

  /** ハブの目録を全部読む。{ app: 目録 }。壊れた行は飛ばす */
  function readAll(hubSs) {
    var sh = hubSs.getSheetByName(SHEET), out = {};
    if (!sh) return out;
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      try { var c = JSON.parse(String(v[i][4])); if (c && c.app) out[c.app] = c; } catch (e) {}
    }
    return out;
  }

  return { DIRECTIVE_KINDS: DIRECTIVE_KINDS, DEFAULT_MASTERY: DEFAULT_MASTERY, validate: validate, index: index,
    mastery: mastery, rollupKey: rollupKey, publish: publish, readAll: readAll };
})();
