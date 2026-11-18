// dist/app-kanzi.js — 教科 kanzi のサーバーのコード（tools/bundle.cjs が作る。直接直さない）
// ===== アプリ kanzi（sankisuguya-create/kanzi@35ba039） =====
LB_MODULES["kanzi"] = (function () { try { return (function () {
var LB_APP_REPO = "sankisuguya-create/kanzi";
var LB_APP_COMMIT = "35ba0391f5caacb042570031b9d88366bb98b69e";
var LB_RESOLVE_ = function (n) { return /^[A-Za-z][A-Za-z0-9]*$/.test(n) ? eval('typeof ' + n + " === 'function' ? " + n + ' : undefined') : undefined; };
// --- gas/Scheduler.js ---
// 自動生成（tools/build-gas.mjs）。正本は src/scheduler.js
// 出題の計算（純粋関数のみ。画面・保存に依存しない）。設計書 §3・§8 の実装。
// ブラウザでは window.Sched、Node（テスト）と GAS サーバーでは module.exports / グローバル Sched として使う。
(function (root) {
  'use strict';

  // 箱ごとの次回までの日数。かくの箱0（未習）は翌日。設計書 D6（仮の値）
  var INTERVALS = [1, 1, 2, 4, 7, 15];
  var LIMIT = { read: 20, write: 5 }; // 1日の「おすすめ」上限（I5）
  var WRITE_UNLOCK_BOX = 3; // よむがこの箱に達したら かく の「おすすめ」に入れる（D4）
  var MAX_BOX = 5;
  var BASE = Date.UTC(2020, 0, 1);

  // 端末の現地日付を 2020-01-01 からの日数に
  function day(date) {
    var d = date || new Date();
    return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - BASE) / 86400000);
  }

  // 進捗1件 = [box, due, reps, last, miss]（last = 最後に答えた時刻 ms。端末間の統合に使う。miss = まちがえた回数）
  // sel: 児童が選んだ漢字 { 字: [1=選んでいる|0=外した, 時刻] }（時刻の新しい方で統合）
  // done: 最後まで終えた回 { 開始時刻: 問題数 }（全モードの学習集計。途中でやめた回は入らない）
  // old: [境目の時刻, 回数, 問題数] … 境目より前に終えた回の合計（サーバーが compact でまとめる。done が際限なく増えないように）
  // bunkai: ぶんかいの問題ごとの記録 { 問題id: [答えた回数, まちがい回数, 最後に答えた時刻, 最後にまちがえた時刻, 役割まちがい累計, 係り先まちがい累計] }
  // setsumei: せつめい文の くみたて（§27）の文章ごとの記録 { 文章id: [答えた回数, まちがい回数, 最後に答えた時刻, 最後にまちがえた時刻, ①段落番号まちがい累計, ②切れ目まちがい累計, ③文さがしまちがい累計] }
  // tp: れんしゅうプリント（漢字テストの練習）の丸つけの記録 { 丸つけした時刻: [点(0〜100), 問題数] または [点, 問題数, 1]（ヒントあり） }（先生画面の 直近2週間の平均点）
  function newProgress() {
    return { v: 2, read: {}, write: {}, sel: {}, done: {}, old: [0, 0, 0], bunkai: {}, setsumei: {}, tp: {} };
  }
  function norm(p) {
    p = p || newProgress();
    p.read = p.read || {}; p.write = p.write || {}; p.sel = p.sel || {}; p.done = p.done || {}; p.bunkai = p.bunkai || {}; p.setsumei = p.setsumei || {}; p.tp = p.tp || {};
    p.old = Array.isArray(p.old) && p.old.length === 3 ? p.old : [0, 0, 0];
    return p;
  }

  function clone(e) { return e ? e.slice() : e; }

  // よむの採点。戻り値は取り消し用の記録
  function answerRead(p, c, ok, today, now) {
    var before = clone(p.read[c]);
    var beforeW = p.write[c] ? p.write[c].slice() : null;
    var e = p.read[c] || [1, today, 0, 0, 0];
    var box = ok ? Math.min(e[0] + 1, MAX_BOX) : 1;
    p.read[c] = [box, today + INTERVALS[box], e[2] + 1, now || 0, (e[4] || 0) + (ok ? 0 : 1)];
    if (box >= WRITE_UNLOCK_BOX && !p.write[c]) p.write[c] = [0, today + INTERVALS[0], 0, now || 0, 0];
    return { kind: 'read', c: c, before: before, beforeW: beforeW };
  }

  // かくの結果。箱0（未習）は成功で箱1、失敗なら箱0のまま。箱1以上は失敗で箱1
  function answerWrite(p, c, ok, today, now) {
    var before = clone(p.write[c]);
    var e = p.write[c] || [0, today, 0, 0, 0];
    var box = ok ? Math.min(e[0] + 1, MAX_BOX) : (e[0] === 0 ? 0 : 1);
    p.write[c] = [box, today + INTERVALS[box], e[2] + 1, now || 0, (e[4] || 0) + (ok ? 0 : 1)];
    return { kind: 'write', c: c, before: before };
  }

  // ぶんかいの採点。ok は正誤、errs はまちがいの内訳 { role: 役割まちがい数, link: 係り先まちがい数 }（先生集計用の累計）
  function answerBunkai(p, pid, ok, errs, now) {
    var before = clone(p.bunkai[pid]);
    var e = p.bunkai[pid] || [0, 0, 0, 0, 0, 0];
    p.bunkai[pid] = [e[0] + 1, e[1] + (ok ? 0 : 1), now || 0, ok ? e[3] : (now || 0),
      e[4] + (errs && errs.role || 0), e[5] + (errs && errs.link || 0)];
    return { kind: 'bunkai', pid: pid, before: before };
  }

  // せつめい文の採点。errs = [①, ②, ③] の まちがい数（先生集計用の累計）
  function answerSetsumei(p, id, ok, errs, now) {
    p.setsumei = p.setsumei || {};
    var before = clone(p.setsumei[id]);
    var e = p.setsumei[id] || [0, 0, 0, 0, 0, 0, 0];
    errs = errs || [];
    p.setsumei[id] = [e[0] + 1, e[1] + (ok ? 0 : 1), now || 0, ok ? e[3] : (now || 0), e[4] + (errs[0] || 0), e[5] + (errs[1] || 0), e[6] + (errs[2] || 0)];
    return { kind: 'setsumei', id: id, before: before };
  }

  function answeredToday(tbl, today) {
    var n = 0;
    for (var c in tbl) if (tbl[c][2] > 0 && tbl[c][3] && day(new Date(tbl[c][3])) === today) n++;
    return n;
  }

  // 「おすすめ」: 期限が来たカード。期限切れが古い順、同じ日なら教科書順。上限で切る（I5）
  function dueList(p, today, order) {
    var idx = {};
    for (var i = 0; i < order.length; i++) idx[order.charAt(i)] = i;
    function pick(tbl, limit) {
      var out = [];
      for (var c in tbl) if (tbl[c][1] <= today && c in idx) out.push(c);
      out.sort(function (a, b) { return (tbl[a][1] - tbl[b][1]) || (idx[a] - idx[b]); });
      return { list: out.slice(0, limit), total: out.length };
    }
    // 今日すでに答えた分は上限から引く（1日の上限。答えた字は期限が明日以降になるので二重には数えない）
    var r = pick(p.read, Math.max(0, LIMIT.read - answeredToday(p.read, today)));
    var w = pick(p.write, Math.max(0, LIMIT.write - answeredToday(p.write, today)));
    return { read: r.list, write: w.list, readTotal: r.total, writeTotal: w.total };
  }

  // ---- 選んだ漢字
  function isSel(p, c) { return !!(p.sel[c] && p.sel[c][0]); }
  function setSel(p, c, on, now) { p.sel[c] = [on ? 1 : 0, now || 0]; }
  function selected(p, order) {
    var out = [];
    for (var i = 0; i < order.length; i++) if (isSel(p, order.charAt(i))) out.push(order.charAt(i));
    return out;
  }

  // ぶんかいは1回5問（利用者の指定）。まだ答えたことがない問題から（問題集は易→難の並び）、
  // 全部に答えたあとは 最後に答えた時刻の古い順に回す
  var BUNKAI_PER_SESSION = 5;
  function bunkaiPick(list, p) {
    var rest = [], done = [];
    for (var i = 0; i < list.length; i++) {
      var e = p.bunkai && p.bunkai[list[i].id];
      (e && e[0] > 0 ? done : rest).push(list[i]);
    }
    done.sort(function (a, b) { return (p.bunkai[a.id][2] || 0) - (p.bunkai[b.id][2] || 0); });
    return rest.concat(done).slice(0, BUNKAI_PER_SESSION);
  }

  // せつめい文は1回1文章（利用者の指定）。まだ答えていない文章を並び（易→難）どおりに、全部答えたら最後に答えた時刻の古い順
  function setsumeiPick(list, p) {
    var tbl = p.setsumei || {}, rest = [], done = [];
    for (var i = 0; i < list.length; i++) (tbl[list[i].id] && tbl[list[i].id][0] > 0 ? done : rest).push(list[i]);
    done.sort(function (a, b) { return (tbl[a.id][2] || 0) - (tbl[b.id][2] || 0); });
    return rest.concat(done).slice(0, 1);
  }

  // まちがいの多い字（児童個人）: 答えたことがあり、まちがいが1回以上ある字を、累積まちがい率 e[4]/e[2] の高い順に
  // 「まちがいの多い字」は2系統ある（design.md §13）。こちらは児童個人の累積まちがい率。学級の集計は classMissTop
  function missList(p, kind, order) {
    var tbl = kind === 'write' ? p.write : p.read, out = [];
    for (var i = 0; i < order.length; i++) {
      var c = order.charAt(i), e = tbl[c];
      if (e && e[2] > 0 && (e[4] || 0) > 0) out.push({ c: c, r: e[4] / e[2], m: e[4] });
    }
    out.sort(function (a, b) { return (b.r - a.r) || (b.m - a.m); });
    return out.map(function (x) { return x.c; });
  }

  // まちがいの多い字（学級の集計。先生・おためし・過年度データで共通の唯一の実装）:
  // perChar = { 字: [答えた人数, 最後の答えがまちがい（よむ箱1）の人数] } → 割合の高い順の上位。
  // 児童個人の missList（累積まちがい率）とは別の指標なので、同じ「まちがいの多い字」でも結果は違うことに注意
  // opts: { minStudents=3 （答えた人数の下限）, minRate=0 （割合の下限）, chars=対象の字（文字列|配列。無ければ全部）, top=10 （0なら全部） }
  function classMissTop(perChar, opts) {
    opts = opts || {};
    var minS = opts.minStudents === undefined ? 3 : opts.minStudents;
    var minR = opts.minRate || 0, out = [], i, c;
    var chars = opts.chars === undefined || opts.chars === null ? null : (typeof opts.chars === 'string' ? Array.from(opts.chars) : opts.chars);
    function add(ch) {
      var v = perChar[ch];
      if (v && v[0] >= minS && v[1] > 0 && v[1] / v[0] >= minR) out.push({ c: ch, s: v[0], b: v[1], r: v[1] / v[0] });
    }
    if (chars) for (i = 0; i < chars.length; i++) add(chars[i]);
    else for (c in perChar) add(c);
    // 割合 → まちがいの人数 → 字（決定的な並びにするため、同率は人数が多い方・さらに字順で決める）
    out.sort(function (a, b) { return (b.r - a.r) || (b.b - a.b) || (a.c < b.c ? -1 : a.c > b.c ? 1 : 0); });
    var top = opts.top === undefined ? 10 : opts.top;
    return top ? out.slice(0, top) : out;
  }

  // 全モードの学習量。木の成長は forestActivity で別に計算する。
  function activity(p) {
    var n = p.old ? p.old[2] : 0;
    for (var k in p.done) n += p.done[k];
    return n;
  }
  // 新しいカード・モード不明の回は学習集計には残し、森には加算しない。ぶんかいは 'b'（葉はカードと同じ色）
  function forestMode(kind) { return ({ read: 'r', write: 'w', bunkai: 'b', setsumei: 'b' })[kind] || 'x'; }
  // 27本ごとに次の森。速度は森ごとに3/4倍。CAPは1画面分であり成長の上限ではない。
  var FOREST_TREES = 27, FOREST_STEP = 36, FOREST_CAP = FOREST_TREES * FOREST_STEP;
  var FOREST_COLORS = 'prwk';
  function emptyForest() { return { legacy: 0, completed: [], log: '', fraction: 0 }; }
  function copyForest(s) { return { legacy: s.legacy, completed: s.completed.map(function (c) { return c.slice(); }), log: s.log, fraction: s.fraction }; }
  // 完成した森は4色の個数だけ保存。問題ごとの文字列や画像を積み上げない。
  function closeForest(s) {
    var counts = [0, 0, 0, 0];
    for (var i = 0; i < s.log.length; i++) counts[FOREST_COLORS.indexOf(s.log[i])]++;
    s.completed.push(counts); s.log = '';
  }
  function growForest(s, count, mode) {
    count = Number(count);
    if (!Number.isFinite(count) || count <= 0) return;
    if (/^[PRWKYB]$/.test(mode)) {
      // 移行前の木はカード分も含めて残す。ただし旧版の上限を超える過去分は復活させない。
      count = Math.min(Math.floor(count), FOREST_CAP - s.legacy);
      s.legacy += count;
      mode = mode.toLowerCase().replace('y', 'k');
    } else if (!/^[rwb]$/.test(mode)) return;
    if (mode === 'b') mode = 'k'; // ぶんかいの葉はカードと同じ色（保存データは4色のまま）
    while (count > 0) {
      var rate = Math.pow(0.75, s.completed.length);
      var needed = (FOREST_CAP - s.log.length - s.fraction) / rate;
      var used = Math.min(count, needed);
      var amount = s.fraction + used * rate;
      var whole = Math.min(FOREST_CAP - s.log.length, Math.floor(amount + 1e-9));
      s.log += mode.repeat(whole);
      s.fraction = Math.max(0, amount - whole);
      count = Math.max(0, count - used);
      if (s.log.length === FOREST_CAP) { closeForest(s); s.fraction = 0; }
      else break;
    }
  }
  function validArchive(s) {
    return s && Number.isInteger(s.legacy) && s.legacy >= 0 && s.legacy <= FOREST_CAP &&
      typeof s.log === 'string' && s.log.length < FOREST_CAP && /^[prwkb]*$/.test(s.log) &&
      Number.isFinite(s.fraction) && s.fraction >= 0 && s.fraction < 1 &&
      Array.isArray(s.completed) && s.completed.every(function (c) {
        return Array.isArray(c) && c.length === 4 && c.every(function (n) { return Number.isInteger(n) && n >= 0; }) &&
          c.reduce(function (a, b) { return a + b; }, 0) === FOREST_CAP;
      });
  }
  // 旧RLEは972字までしか展開しない（大きな過去記録も描画量に比例させない）。
  function legacyLog(f, n) {
    var s = '', match, re = /([prwky])(\d+)/g;
    if (typeof f.rle === 'string') {
      while (s.length < n && (match = re.exec(f.rle))) s += match[1].repeat(Math.min(Number(match[2]), n - s.length));
    } else s = String(f.base || '').slice(0, n).replace(/[^prwky]/g, 'p');
    return (s + 'p'.repeat(Math.max(0, n - s.length))).replace(/y/g, 'k');
  }
  function forestState(p) {
    var f = p.forest || {};
    if (f.v === 2 && validArchive(f.archive)) return f;
    var archive = emptyForest(), modes = {};
    var base = legacyLog(f, Math.min(p.old ? p.old[2] : 0, FOREST_CAP));
    archive.legacy = base.length; archive.log = base;
    if (base.length === FOREST_CAP) closeForest(archive);
    sessionKeys(p).forEach(function (d) {
      var m = (f.modes || {})[d];
      modes[d] = /^[rwkyb]$/.test(m) ? m.toUpperCase() : 'P';
    });
    return { v: 2, archive: archive, modes: modes };
  }
  function sessionKeys(p) { return Object.keys(p.done || {}).sort(function (a, b) { return Number(a) - Number(b); }); }
  function knownForestMode(mode) { return /^[rwxbPRWKYB]$/.test(mode); }
  function forestGrowth(p) {
    var f = forestState(p), s = copyForest(f.archive), modes = f.modes || {};
    sessionKeys(p).forEach(function (d) {
      growForest(s, p.done[d], modes[d]);
    });
    return s;
  }
  function forestActivity(p) {
    var s = forestGrowth(p);
    return s.completed.length * FOREST_CAP + s.log.length + s.fraction;
  }
  function forestRegionLog(s, region) {
    if (region === s.completed.length) return s.log;
    var counts = s.completed[region];
    return counts ? counts.map(function (n, i) { return FOREST_COLORS[i].repeat(n); }).join('') : '';
  }
  function forestLog(p) {
    var s = forestGrowth(p);
    return forestRegionLog(s, s.log.length || s.fraction || !s.completed.length ? s.completed.length : s.completed.length - 1);
  }
  // 境目より前の回を old にまとめる（何回呼んでも同じ結果。境目は前に進むだけ）
  function compact(p, before) {
    norm(p);
    if (!(before > p.old[0])) return p;
    var f = forestState(p), modes = Object.assign({}, f.modes), archive = copyForest(f.archive);
    var o = [before, p.old[1], p.old[2]];
    sessionKeys(p).forEach(function (d) {
      if (Number(d) < before) {
        growForest(archive, p.done[d], modes[d]);
        o[1]++; o[2] += p.done[d];
        delete modes[d]; delete p.done[d];
      }
    });
    p.forest = { v: 2, archive: archive, modes: modes };
    p.old = o;
    for (var t in p.tp) if (Number(t) < before) delete p.tp[t]; // れんしゅうプリントの点は 古い分を捨てる（見るのは直近2週間）
    return p;
  }
  // まとめる境目: 3か月前の月の1日（その時点の現地時刻）
  function compactBefore(now) { return new Date(now.getFullYear(), now.getMonth() - 3, 1).getTime(); }
  function finishSession(p, startedAt, count, kind) {
    if (count > 0) {
      // 先に移行して既存の回と新しい回を区別する。再送や圧縮済みの回は変更しない。
      if (Number(startedAt) < p.old[0] || Object.prototype.hasOwnProperty.call(p.done, String(startedAt))) return;
      var f = forestState(p);
      p.done[String(startedAt)] = count;
      p.forest = { v: 2, archive: copyForest(f.archive), modes: Object.assign({}, f.modes) };
      p.forest.modes[String(startedAt)] = forestMode(kind);
    }
  }

  // ---- 児童画面のボタンのオン・オフ（学級ごと。先生がおためし画面で切り替える）
  // 持つのはオフにしたボタンのキーだけ。m.＝メニューのボタン、s.＝「どの字で やる？」の選び方（読む・書く・カードで共通）
  // 先生画面・児童画面・GAS サーバーが同じ一覧を使う（ここが唯一の定義）
  var GATE_KEYS = ['m.browse', 'm.read', 'm.write', 'm.fk', 'm.fy', 'm.test', 'm.seen', 'm.other', 'o.bunkai', 'o.setsumei', 'o.sakubun', 's.test', 's.due', 's.sel', 's.rnd', 's.miss', 't.p50', 't.p10', 't.hint', 't.paper', 't.juku'];
  // 配列・「,」区切りの文字列のどちらでも受け、知らないキー・重なりを除いて GATE_KEYS の順に並べる
  function normGates(v) {
    var list = Array.isArray(v) ? v.map(String) : String(v || '').split(',');
    return GATE_KEYS.filter(function (k) { return list.indexOf(k) >= 0; });
  }

  // ぶんかいの自作問題（設定 bunkai:<学級> に JSON で保存）。形の違うものを除き、係り先番号などを整えて返す。
  // 問題は { id, segs: [{ t: 文節の字（{字|よみ}はルビ）, r: 主|述|修|接|独, m: 係り先番号（修飾語のみ。0=なし） }] }
  // data-src/bunkai.txt の正本と同じ約束を満たすものだけが通る（tools/build-bunkai.mjs と同じ検査）。
  function normBunkai(v) {
    var list = v;
    if (typeof v === 'string') { try { list = JSON.parse(v); } catch (e) { return []; } }
    if (!Array.isArray(list)) return [];
    var ROLE = { '主': 1, '述': 1, '修': 1, '接': 1, '独': 1 }, out = [], seen = {};
    list.forEach(function (p) {
      if (out.length >= 50) return;
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[bc][0-9a-z]{1,12}$/i.test(p.id) || seen[p.id]) return;
      var segs = Array.isArray(p.segs) ? p.segs : [];
      if (segs.length < 2 || segs.length > 8) return;
      var clean = [], bad = false, jutu = 0, shugo = 0;
      segs.forEach(function (s) {
        if (bad) return;
        if (!s || typeof s.t !== 'string' || !s.t || s.t.length > 30 || !ROLE[s.r]) { bad = true; return; }
        var m = s.m | 0;
        if (s.r === '修') { if (m < 1 || m > segs.length) { bad = true; return; } }
        else if (m) { bad = true; return; }
        if (s.r === '述') jutu++;
        if (s.r === '主') shugo++;
        clean.push({ t: s.t, r: s.r, m: s.r === '修' ? m : 0 });
      });
      if (bad || jutu !== 1 || shugo > 1) return;
      clean.forEach(function (s, i) {
        if (s.m && (s.m === i + 1 || '主述修'.indexOf(clean[s.m - 1].r) < 0)) bad = true;
      });
      if (bad) return;
      seen[p.id] = 1;
      out.push({ id: p.id, segs: clean });
    });
    return out;
  }

  // ---- 漢字テストの範囲（学級ごとに複数、児童に見せるのは1つ）
  // { active: 見せているテストの id（見せない時は null）, list: [{ id, label, chars }] }
  // 旧形式 { label, chars } は1個だけのテストとして読む（見せていたので active も復元する）
  function normTests(v) {
    var out = { active: null, list: [] };
    if (v && typeof v === 'object') {
      var list = Array.isArray(v.list) ? v.list : (typeof v.chars === 'string' && v.chars ? [{ id: 't1', label: v.label, chars: v.chars }] : []);
      var seen = {};
      list.forEach(function (t, i) {
        if (!t || typeof t !== 'object') return;
        var id = String(t.id || 't' + (i + 1)).slice(0, 24);
        if (seen[id]) return;
        seen[id] = true;
        // okuri: そのテストで 送りがなを問う字（れんしゅうプリントの送りがなの問題は この字だけから出す）。範囲の字の中だけ
        var chars = String(t.chars || ''), okuri = Array.from(String(t.okuri || '')).filter(function (c, k, a) { return chars.indexOf(c) >= 0 && a.indexOf(c) === k; }).join('');
        out.list.push({ id: id, label: String(t.label || '').slice(0, 40), chars: chars, okuri: okuri });
      });
      var active = v.active !== undefined ? v.active : (out.list.length === 1 && !Array.isArray(v.list) ? out.list[0].id : null);
      if (out.list.some(function (t) { return t.id === active; })) out.active = String(active);
    }
    return out;
  }
  // 児童に見せるテスト（旧来の { label, chars } の形で返す）
  function activeTest(tests) {
    var t = normTests(tests), hit = t.list.filter(function (x) { return x.id === t.active; })[0];
    return hit && hit.chars ? { label: hit.label, chars: hit.chars, okuri: hit.okuri || '' } : null;
  }

  // おぼえた字 = よむが箱3以上（chars を渡すとその中だけ数える）
  function learned(p, chars) {
    var n = 0;
    if (chars) { for (var i = 0; i < chars.length; i++) if (p.read[chars[i]] && p.read[chars[i]][0] >= WRITE_UNLOCK_BOX) n++; return n; }
    for (var c in p.read) if (p.read[c][0] >= WRITE_UNLOCK_BOX) n++;
    return n;
  }

  // 2つの進捗を統合（字ごとに最後に答えた方。選択は時刻の新しい方。終えた回は和集合）
  function merge(a, b) {
    a = norm(a); b = norm(b);
    var out = newProgress();
    ['read', 'write', 'sel'].forEach(function (k) {
      var ta = a[k], tb = b[k], c, t = k === 'sel' ? 1 : 3;
      for (c in ta) out[k][c] = ta[c].slice();
      for (c in tb) {
        var x = out[k][c], y = tb[c];
        if (!x || y[t] > x[t] || (k !== 'sel' && y[t] === x[t] && y[2] > x[2])) out[k][c] = y.slice();
      }
    });
    // ぶんかいは「最後に答えた時刻」の新しい方（同じなら回数の多い方）で採る
    for (var pid in a.bunkai) out.bunkai[pid] = a.bunkai[pid].slice();
    for (var pb in b.bunkai) {
      var bx = out.bunkai[pb], by = b.bunkai[pb];
      if (!bx || by[2] > bx[2] || (by[2] === bx[2] && by[0] > bx[0])) out.bunkai[pb] = by.slice();
    }
    for (var sa in a.setsumei || {}) out.setsumei[sa] = a.setsumei[sa].slice();
    for (var sb in b.setsumei || {}) {
      var sx = out.setsumei[sb], sy = b.setsumei[sb];
      if (!sx || sy[2] > sx[2] || (sy[2] === sx[2] && sy[0] > sx[0])) out.setsumei[sb] = sy.slice();
    }
    var t;
    for (t in a.tp) out.tp[t] = a.tp[t].slice();
    for (t in b.tp) out.tp[t] = b.tp[t].slice();
    // まとめた合計は境目の新しい方（同じなら回数の多い方）。境目より前の回は、その合計に入っているので捨てる
    var o = b.old[0] > a.old[0] || (b.old[0] === a.old[0] && b.old[1] > a.old[1]) ? b.old : a.old, d;
    out.old = o.slice();
    for (d in a.done) if (Number(d) >= o[0]) out.done[d] = a.done[d];
    for (d in b.done) if (Number(d) >= o[0]) out.done[d] = b.done[d];
    out.forest = mergeForest(a, b, out, o === b.old ? b : a);
    return out;
  }

  // 色だけの統合。完了回と集計境界の採用ルールは merge 側で決める。
  function mergeForest(a, b, out, archiveSource) {
    var fa = forestState(a), fb = forestState(b), modes = {}, d;
    for (d in out.done) {
      // 同じ回の再送は一度だけ。旧クライアントに色がなくても既存の色を残す。
      var ma = (fa.modes || {})[d], mb = (fb.modes || {})[d];
      // 更新前から開いていた画面で新たに完了した回も、読む・書くだけを加算する。
      if (a.forest?.v === 2 && b.forest?.v !== 2 && !knownForestMode(ma)) mb = /^[RWB]$/.test(mb) ? mb.toLowerCase() : 'x';
      if (b.forest?.v === 2 && a.forest?.v !== 2 && !knownForestMode(mb)) ma = /^[RWB]$/.test(ma) ? ma.toLowerCase() : 'x';
      // 新旧クライアントが同じ回を返してもv2の対象・対象外の区別を優先する。
      if (a.forest?.v === 2 && b.forest?.v !== 2 && knownForestMode(ma)) modes[d] = ma;
      else modes[d] = knownForestMode(mb) ? mb : knownForestMode(ma) ? ma : 'x';
    }
    var archived = archiveSource;
    if (a.old.every(function (v, i) { return v === b.old[i]; })) {
      // 旧クライアントが同じ集計値だけ返した場合、色のある控えを優先。
      if (a.forest?.v === 2 && b.forest?.v !== 2) archived = a;
      else if (b.forest?.v === 2 && a.forest?.v !== 2) archived = b;
      else {
        var ba = fa.archive, bb = fb.archive;
        var known = function (s) { return s.completed.reduce(function (n, c) { return n + c[1] + c[2] + c[3] + (c[4] || 0); }, 0) + s.log.replace(/p/g, '').length; };
        archived = known(bb) > known(ba) ? b : a;
      }
    }
    return { v: 2, archive: copyForest(forestState(archived).archive), modes: modes };
  }

  // 字エントリ1件が形を保っているか: [箱, 期限, 回数, 最後の時刻, まちがい回数] の5要素の数値で、
  // 箱が範囲内（lo=読む1〜・書く0〜 MAX_BOX）、期限・回数・時刻・まちがい回数が非負
  function checkEntry(e, lo) {
    return Array.isArray(e) && e.length === 5 && e.every(function (x) { return Number.isFinite(x); }) &&
      e[0] >= lo && e[0] <= MAX_BOX && e[1] >= 0 && e[2] >= 0 && e[3] >= 0 && e[4] >= 0;
  }
  // 不変条件の検査（I3）。違反の説明の配列を返す（空なら健全）
  function check(p) {
    var bad = [], c;
    for (c in p.read) if (!checkEntry(p.read[c], 1)) bad.push('read ' + c);
    for (c in p.write) if (!checkEntry(p.write[c], 0)) bad.push('write ' + c);
    for (c in p.bunkai) {
      var e = p.bunkai[c];
      if (!(Array.isArray(e) && e.length === 6 && e.every(function (x) { return Number.isFinite(x) && x >= 0; }))) bad.push('bunkai ' + c);
    }
    for (c in p.setsumei || {}) {
      var se = p.setsumei[c];
      if (!(Array.isArray(se) && se.length === 7 && se.every(function (x) { return Number.isFinite(x) && x >= 0; }))) bad.push('setsumei ' + c);
    }
    for (c in p.tp || {}) {
      var te = p.tp[c];
      if (!(Array.isArray(te) && (te.length === 2 || (te.length === 3 && te[2] === 1)) && te[0] >= 0 && te[0] <= 100 && te[1] > 0)) bad.push('tp ' + c);
    }
    if (p.v !== undefined && p.v !== 2) bad.push('v');
    return bad;
  }

  // れんしゅうプリントの丸つけを記録する
  // hint: ヒントモード（2画目までを先に書いた形）で丸つけした回。平均点には入れず、回数だけ別に数える
  function addTprint(p, now, score, n, hint) { norm(p); p.tp[String(now)] = hint ? [score, n, 1] : [score, n]; }
  // 直近 days 日の れんしゅうプリントの平均点 { avg: ヒントなしの平均点（整数。なければ null）, n: ヒントなしの回数, hint: ヒントありの回数 }。1回もなければ null
  function tprintAvg(p, now, days) {
    var from = now - days * 86400000, sum = 0, n = 0, h = 0;
    for (var t in (p && p.tp) || {}) if (Number(t) >= from && Number(t) <= now + 86400000) { if (p.tp[t][2]) h++; else { sum += p.tp[t][0]; n++; } }
    return n || h ? { avg: n ? Math.round(sum / n) : null, n: n, hint: h } : null;
  }

  var api = {
    INTERVALS: INTERVALS, LIMIT: LIMIT, WRITE_UNLOCK_BOX: WRITE_UNLOCK_BOX, MAX_BOX: MAX_BOX,
    day: day, newProgress: newProgress, norm: norm, answerRead: answerRead, answerWrite: answerWrite, answerBunkai: answerBunkai, answerSetsumei: answerSetsumei,
    dueList: dueList, isSel: isSel, setSel: setSel, selected: selected, missList: missList, classMissTop: classMissTop,
    FOREST_TREES: FOREST_TREES, FOREST_STEP: FOREST_STEP, FOREST_CAP: FOREST_CAP,
    activity: activity, forestLog: forestLog, forestGrowth: forestGrowth, forestActivity: forestActivity, forestRegionLog: forestRegionLog,
    compact: compact, addTprint: addTprint, tprintAvg: tprintAvg, compactBefore: compactBefore, finishSession: finishSession, learned: learned, merge: merge, check: check, checkEntry: checkEntry,
    normTests: normTests, activeTest: activeTest, GATE_KEYS: GATE_KEYS, normGates: normGates, normBunkai: normBunkai, bunkaiPick: bunkaiPick, setsumeiPick: setsumeiPick
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sched = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// GAS 版ずれ検知の版（tools/build-gas.mjs が埋め込む）
Sched.VER = "fd477be";

// --- gas/Genko.js ---
// 自動生成（tools/build-gas.mjs）。正本は src/genko.js（作文の形をそろえる normWork をサーバーでも使う）
// 説明文を書く（設計書 §28）の共通部品：原稿用紙の組み方・見なおしの判定・テンプレート・お手本。
// 画面は app.js の sakubun*()、検査は tests/genko.test.mjs。DOM に触れない（ブラウザ・Node 共通）
//
// 原稿用紙の決まり（一般的な書き方。docs/features/setsumei-writing.md に出典）:
//   400字づめ（1行20マス×20行）。右の行から書き、左へ進む。1マスに1字。改行（段落）は次の行から。
//   「、」「。」「」」などは行の頭に書かない → 前の行の最後のマスに、字といっしょに入れる（hang）
//   「「」などは行の最後のマスに書かない → 次の行へ送る
//   小さい「ゃゅょっ」も1マス（画面で右上に寄せる）
//   1行目＝題名（上を3マスあける）、2行目＝名前（下につめ、いちばん下は1マスあける）、本文は3行目から
(function (root) {
  'use strict';
  var Z = '　', ROWS = 20, COLS = 20;
  var HANG = '、。，．」』）〕】！？';
  var OPEN = '「『（〔【';
  var SMALL = 'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ';

  // 半角の英数字・記号・空白を全角に（マス目をそろえる。1字下げを半角空白で入れても判定できるように）
  function toZen(s) {
    return String(s).replace(/[!-~]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 0xFEE0); }).replace(/ /g, Z).replace(/\r/g, '');
  }

  // 文字ごとに（行 col, マス row）を決める。src の改行1つ＝段落の区切り。
  // 返す: { cells: [{ col, row, c, i, hang?, small? }], pos: [i → { col, row, after? }]（i は src の文字番号、末尾 = src.length）, cols }
  // pos はカーソルの位置（その字の前）。after は「そのマスの後ろ」（行の最後のマスの下）
  function layout(src) {
    src = String(src || '');
    var cells = [], pos = new Array(src.length + 1), col = 0, row = 0, i = 0;
    var lines = src.split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      row = 0;
      for (var k = 0; k < line.length; k++, i++) {
        var c = line[k];
        if (row >= ROWS) {
          if (HANG.indexOf(c) >= 0 && k > 0) { cells.push({ col: col, row: ROWS - 1, c: c, i: i, hang: true }); pos[i] = { col: col, row: ROWS - 1, after: true }; continue; }
          col++; row = 0;
        }
        if (OPEN.indexOf(c) >= 0 && row === ROWS - 1) { col++; row = 0; }
        var cell = { col: col, row: row, c: c, i: i };
        if (SMALL.indexOf(c) >= 0) cell.small = true;
        cells.push(cell); pos[i] = { col: col, row: row }; row++;
      }
      pos[i] = row >= ROWS ? { col: col, row: ROWS - 1, after: true } : { col: col, row: row };
      i++; col++;
    }
    return { cells: cells, pos: pos, cols: Math.max(col, 1) };
  }
  function pages(cols) { return Math.max(1, Math.ceil(cols / COLS)); }

  // 名前の行: 下につめて、いちばん下は1マスあける
  function nameLine(name) { name = toZen(name || ''); return Z.repeat(Math.max(0, COLS - 1 - name.length)) + name + Z; }

  // テンプレート（利用者の指定: 穴は【食材】だけ。中は段落の枠＝空の行）
  function template(name) {
    return [Z + Z + Z + 'すがたをかえる【食材】', nameLine(name),
      Z + '【食材】には、いろいろな食べ方のくふうがあります。', '', '', '',
      Z + 'このように、【食材】は、くふうされて、いろいろなすがたになって食べられているのです。'].join('\n');
  }
  function blank(name) { return [Z + Z + Z, nameLine(name), Z].join('\n'); }

  // お手本（自作。教科書の文はうつさない: 設計書 §27 と同じ方針。事実の出典は docs/features/setsumei-writing.md）
  var SAMPLE = [Z + Z + Z + 'すがたをかえる葉っぱ', nameLine('高木　北子'),
    Z + '茶の葉には、いろいろな飲み方のくふうがあります。',
    Z + 'まず、つんだ葉をすぐにむして、もんでからかわかすくふうがあります。すぐにねつをくわえると、葉の色が緑のままのこり、緑茶になります。',
    Z + '次に、葉をしばらくおいておくくふうがあります。もんだ葉をおいておくと、色がだんだん茶色にかわっていきます。とちゅうでねつをくわえるとウーロン茶に、さいごまでかえるとこう茶になります。',
    Z + 'さらに、こなにして飲むくふうもあります。おおいをかけて日光をさえぎってそだてた葉を、もまずにむしてかわかし、石うすでひくと、まっ茶になります。',
    Z + 'このように、茶の葉は、くふうされて、いろいろなすがたになって飲まれているのです。'].join('\n');

  function bare(s) { return String(s || '').replace(/[　 ]/g, ''); }
  // 本文の何番目の段落か（line は改行で数えた番号。原稿用紙の「行」とは違うので、児童・先生には段落の番号で言う）
  function paraNo(text, line) { var ls = String(text || '').split('\n'), n = 0; for (var i = 2; i <= line && i < ls.length; i++) if (bare(ls[i])) n++; return n; }
  // 見なおし（要件2）: [{ line, msg }]（line は 0 から。-1 は文章全体）。空の配列なら だいじょうぶ
  //   題名がない・上をあけていない／名前がない／段落のはじめを1マスあけていない／【】の穴が残っている
  function check(text) {
    var lines = String(text || '').split('\n'), out = [];
    var t = lines[0] || '', n = lines[1] || '';
    if (!bare(t) || /。/.test(t)) out.push({ line: 0, msg: '1行目に 題名を 書こう', tag: '題名' });
    else if (t.indexOf(Z + Z) !== 0) out.push({ line: 0, msg: '題名は 上を 3マス あけて 書こう', tag: '上を あける' });
    if (!bare(n) || /。/.test(n)) out.push({ line: 1, msg: '2行目に 名前を 書こう', tag: '名前' });
    for (var i = 2; i < lines.length; i++) {
      if (bare(lines[i]) && lines[i][0] !== Z) out.push({ line: i, msg: paraNo(text, i) + '番目の 段落：はじめを 1マス あけよう', tag: '1マス あける' });
    }
    if (/【[^】]*】/.test(text)) out.push({ line: -1, msg: '【　】の あなを うめよう', tag: 'あな' });
    return out;
  }
  // 題名（一覧に出す名前）
  function title(text) { return bare(String(text || '').split('\n')[0]) || '（題名なし）'; }
  function count(text) { return bare(String(text || '').split('\n').slice(2).join('')).length; } // 本文の字数（題名・名前を除く）
  function paragraphs(text) { return String(text || '').split('\n').slice(2).filter(function (l) { return bare(l); }).length; }

  // 作品の形をそろえる（保存・受け取りの両方で使う）
  var MAX_CHARS = 4000; // 原稿用紙10枚。セルの上限（5万字）に十分届かない
  function normWork(w) {
    w = w || {};
    var o = { id: String(w.id || '').slice(0, 40), text: toZen(String(w.text || '')).slice(0, MAX_CHARS), mode: w.mode === 'free' ? 'free' : 'tpl', show: !!w.show, updated: Number(w.updated) || 0 };
    o.comments = {};
    if (w.comments && typeof w.comments === 'object') for (var k in w.comments) {
      var c = w.comments[k], line = Number(k);
      if (!(line >= 0 && line < 400) || !c) continue;
      var t = typeof c === 'string' ? c : c.t;
      if (t) o.comments[line] = { t: String(t).slice(0, 200), read: !!(c && c.read), at: Number(c && c.at) || 0 };
    }
    o.fixes = normFixes(w.fixes);
    return o;
  }
  // 段落の順番を入れかえる（line は改行で数えた番号。2行目＝題名・名前の後から）。dir: -1＝前へ（右へ）、+1＝後ろへ（左へ）
  // 返す: { text, map: { もとの行: 新しい行 } }（先生のコメントの付け先を合わせるため）。動かせない時は null
  function moveParagraph(text, line, dir) {
    var ls = String(text || '').split('\n'), to = line + dir;
    if (line < 2 || to < 2 || line >= ls.length || to >= ls.length) return null;
    var t = ls[line]; ls[line] = ls[to]; ls[to] = t;
    var map = {}; map[line] = to; map[to] = line;
    return { text: ls.join('\n'), map: map };
  }
  // コメントの付け先を map で移す（map にない行はそのまま）
  function remapComments(comments, map) {
    var out = {};
    Object.keys(comments || {}).forEach(function (k) { var n = map && (k in map) ? map[k] : Number(k); out[n] = comments[k]; });
    return out;
  }
  // 2つの map を続けて当てた結果（a のあとに b）
  function composeMap(a, b) {
    var res = {}, at = {}, k;
    a = a || {}; b = b || {};
    for (k in a) { var c = Number(a[k]); at[c] = true; res[k] = (c in b) ? Number(b[c]) : c; } // 動いたことのある行
    for (k in b) if (!(k in a) && !at[k]) res[k] = Number(b[k]);                               // まだ動いていない行（もとの位置にいる）
    for (k in res) if (res[k] === Number(k)) delete res[k];
    return res;
  }
  // 先生の修正案（§28 の2回目。W2）: { id, line, start, from, to, at }
  //   line＝改行で数えた段落の番号、start＝その段落の中の何字目（0から）、from＝もとの字、to＝なおした字（空なら消す）。
  //   児童が書きかえても あてはまる所を探せるよう、位置と もとの字の両方を持つ
  function normFixes(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (f) {
      if (!f || out.length >= 100) return;
      var line = Number(f.line), start = Number(f.start), from = String(f.from || '').slice(0, 100), to = toZen(String(f.to == null ? '' : f.to)).replace(/\n/g, '').slice(0, 100);
      if (!(line >= 0 && line < 400) || !(start >= 0 && start < 4000) || !from || from === to) return;
      out.push({ id: String(f.id || '').slice(0, 20) || ('f' + out.length), line: line, start: start, from: from, to: to, at: Number(f.at) || 0 });
    });
    return out;
  }
  // 修正案があてはまる所: { at（本文の中の字の番号）, len }。もとの字が見つからなければ null（児童が書きかえた）
  function fixLocate(text, f) {
    var ls = String(text || '').split('\n');
    if (f.line >= ls.length) return null;
    var l = ls[f.line], base = 0, k;
    for (k = 0; k < f.line; k++) base += ls[k].length + 1;
    if (l.substr(f.start, f.from.length) === f.from) return { at: base + f.start, len: f.from.length };
    var best = -1, bd = 1e9, i = l.indexOf(f.from);
    while (i >= 0) { if (Math.abs(i - f.start) < bd) { bd = Math.abs(i - f.start); best = i; } i = l.indexOf(f.from, i + 1); }
    return best >= 0 ? { at: base + best, len: f.from.length } : null;
  }
  // 修正案を当てた本文（あてはまらなければ null）
  function applyFix(text, f) {
    var p = fixLocate(text, f);
    return p ? String(text).slice(0, p.at) + f.to + String(text).slice(p.at + p.len) : null;
  }
  // 段落の入れかえに合わせて、修正案の段落の番号も移す
  function remapFixes(fixes, map) {
    return (fixes || []).map(function (f) { var o = {}; for (var k in f) o[k] = f[k]; if (map && (f.line in map)) o.line = Number(map[f.line]); return o; });
  }
  function newId() { return 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

  var Genko = { Z: Z, ROWS: ROWS, COLS: COLS, HANG: HANG, OPEN: OPEN, SMALL: SMALL, MAX_CHARS: MAX_CHARS,
    toZen: toZen, layout: layout, pages: pages, nameLine: nameLine, template: template, blank: blank, SAMPLE: SAMPLE,
    check: check, paraNo: paraNo, moveParagraph: moveParagraph, remapComments: remapComments, normFixes: normFixes, fixLocate: fixLocate, applyFix: applyFix, remapFixes: remapFixes, composeMap: composeMap, title: title, count: count, paragraphs: paragraphs, normWork: normWork, newId: newId };
  if (typeof module !== 'undefined' && module.exports) module.exports = Genko; else root.Genko = Genko;
})(typeof globalThis !== "undefined" ? globalThis : this);

// --- gas/Code.js ---
// 漢字の森 GASサーバー（設計書 §7）。スプレッドシートにバインドして使う。
// シート: 名簿[メール, 学年, 組, 番号, 名前]（児童）／ 教師[メール, 学年, 組]（担当。1人で複数行可。組が空なら その学年の全学級）
//         進捗[メール, read, write, meta, 更新] ／ 設定[キー, 値] ／ 名簿YYYY・進捗YYYY（年度末に「残す」でできる過年度データ）
// 学級のキーは「学年-組」（例 3-1）。設定のキー: grades:<学級>（見せる学年 "1,2,3"）／ pointer:<学級>:<学年>（授業の進度）／ order:<学年>（出題順）
//   ／ gates:<学級>（児童画面でオフにしたボタン "m.write,s.rnd"。Sched.GATE_KEYS）／ sakuShare:<学級>（説明文を書く の読み合い "1"）
//         作文[作品, メール, 学級, 本文, 型, 見せる, コメント, 更新]（説明文を書く §28。1作品＝1行）・作文YYYY（過年度）
// 児童への応答には本人の進捗以外を含めない（不変条件 I7）。先生は担当学級のものだけ読み書きできる。
var STUDENT_RE = /@kyoiku\.edu\.nishi\.or\.jp$/;
var TEACHER_RE = /@edu\.nishi\.or\.jp$/;
// 学年ごとの字数（各学年の字の割り振りに使う）。正本は src/data.js の配当データ。tests/data.test.mjs で照合する
var GRADE_LEN = { 1: 80, 2: 160, 3: 200, 4: 202, 5: 193, 6: 191 };

function doGet() {
  if (inBase_()) return lbPage_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('漢字の森')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---- 学習BASE の中で動く時（learning-base の tools/bundle.cjs が、このファイルを関数に包んで LB_APP_COMMIT などを渡す）。
// 単体の GAS（このスプレッドシートに付けたもの）では今まで通り。約束は learning-base の docs/add-app.md
function inBase_() { return typeof LB_APP_COMMIT !== 'undefined'; }
// データのスプレッドシート：単体では付いているもの。学習BASE の中では、スクリプトのプロパティ KANZI_SS_ID（今の漢字の森のスプレッドシートの ID）
var SS_ = null;
function ss_() {
  if (SS_) return SS_;
  if (!inBase_()) return (SS_ = SpreadsheetApp.getActiveSpreadsheet());
  var id = String(PropertiesService.getScriptProperties().getProperty('KANZI_SS_ID') || '').trim();
  if (!id) throw new Error('漢字の森のデータの場所が決まっていません（スクリプトのプロパティ KANZI_SS_ID に、漢字の森のスプレッドシートの ID を入れてください）');
  return (SS_ = SpreadsheetApp.openById(id));
}
function lbReady_() { try { return !!String(PropertiesService.getScriptProperties().getProperty('KANZI_SS_ID') || '').trim(); } catch (e) { return false; } }
// 一時保存：学習BASE の中では全アプリで1つの置き場を使うので、名前の頭に kanzi: を付ける
function cache_() {
  var c = CacheService.getScriptCache();
  if (!inBase_()) return c;
  return { get: function (k) { return c.get('kanzi:' + k); }, put: function (k, v, t) { return c.put('kanzi:' + k, v, t); }, remove: function (k) { return c.remove('kanzi:' + k); } };
}
// 画面：枠（gas/shell.html。tools/build-gas.mjs が作る）だけを返し、プログラム（src/*.js。約130万字）は jsDelivr から版（コミット）で固定して読む。
// 2回目からはブラウザに保存した分を使う。画面からの呼び出しは、学習BASE の lbCall('app:kanzi', 名前, 引数) を通す
function lbPage_() {
  var base = 'https://cdn.jsdelivr.net/gh/' + LB_APP_REPO + '@' + LB_APP_COMMIT + '/';
  var shim = '<script>window.LB_GAS=function(fn,args){return new Promise(function(ok,ng){google.script.run.withSuccessHandler(ok).withFailureHandler(ng).lbCall("app:kanzi",fn,args);});};' +
    'function kanziLoadFail(){var a=document.getElementById("app");if(a&&!window.kanziFailed){window.kanziFailed=1;a.innerHTML="<p>いま ひらけません。すこし まってから、ひらきなおしてね。</p>";}}<\/script>';
  var html = String(LB_FILES['kanzi/shell'])
    .replace('__KANZI_VER__', String(Sched.VER || '').replace(/[^\w.\-]/g, ''))
    .replace('<!--LB_SHIM-->', shim)
    .replace(/<script src="(src\/[\w.\-\/]+)"><\/script>/g, function (m, f) { return '<script src="' + base + f + '" onerror="kanziLoadFail()"><\/script>'; });
  return HtmlService.createHtmlOutput(html).setTitle('漢字の森').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
// ---- 名簿を学習BASE に切り替える（所有者だけ）。切り替える前に照らし合わせ、食い違いが0件の時だけ切り替えられる
function owner_() {
  if (!inBase_()) throw new Error('スプレッドシートの所有者が、学習BASE の中で使えます');
  var a = String(Session.getActiveUser().getEmail() || '').toLowerCase(), e = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!a || a !== e) throw new Error('スプレッドシートの所有者が、学習BASE の中で使えます');
}
// 返す：{ using, ok, kanziOnly: [{klass,no,name}], classMoved: [{klass→base}], orphanSettings: [キー], baseOnlyClasses: [学級] }
function api_lbRosterCheck() {
  owner_(); begin_();
  var mine = rosterFromSheet_(), base = rosterFromBase_(), byMail = {};
  base.forEach(function (x) { byMail[x.email] = x; });
  var kanziOnly = [], moved = [];
  mine.forEach(function (x) {
    var b = byMail[x.email];
    if (!b) kanziOnly.push({ klass: x.klass, no: x.no, name: x.name });
    else if (b.klass !== x.klass) moved.push({ klass: x.klass, base: b.klass, no: x.no, name: x.name });
  });
  var baseK = {}; base.forEach(function (x) { baseK[x.klass] = true; });
  var mineK = {}; mine.forEach(function (x) { mineK[x.klass] = true; });
  var orphan = Object.keys(settings_()).filter(function (k) {
    var m = /^(?:grades|pointer|gates|bunkai|write|sakuShare|test):([^:]+)/.exec(k); return m && !baseK[m[1]];
  });
  return { using: baseRoster_() ? 'base' : 'sheet', ok: !kanziOnly.length && !moved.length && !orphan.length,
    kanziOnly: kanziOnly, classMoved: moved, orphanSettings: orphan, baseOnlyClasses: Object.keys(baseK).filter(function (k) { return !mineK[k]; }).sort() };
}
function api_lbRosterUse(on) {
  owner_();
  var p = PropertiesService.getScriptProperties();
  if (!on) { p.deleteProperty('KANZI_ROSTER'); return api_lbRosterCheck(); }
  var c = api_lbRosterCheck();
  if (!c.ok) throw new Error('食い違いが残っているので切り替えられません（漢字の森だけにいる児童 ' + c.kanziOnly.length + '人・学級が違う児童 ' + c.classMoved.length + '人・学級の無い設定 ' + c.orphanSettings.length + '件）');
  p.setProperty('KANZI_ROSTER', 'base');
  return api_lbRosterCheck();
}

// 画面から呼べる関数（ここに無いものは呼べない）。api_ を足したらここにも足す（tests/gas.test.mjs が照らし合わせる）
function lbApi_(name, args) {
  var API = { api_archiveAnonymize: api_archiveAnonymize, api_archiveSave: api_archiveSave, api_archiveView: api_archiveView, api_archiveYears: api_archiveYears, api_bunkai: api_bunkai, api_gates: api_gates, api_init: api_init, api_lbRosterCheck: api_lbRosterCheck, api_lbRosterUse: api_lbRosterUse, api_sakuComment: api_sakuComment, api_sakuDelete: api_sakuDelete, api_sakuFix: api_sakuFix, api_sakuFixDel: api_sakuFixDel, api_sakuFriends: api_sakuFriends, api_sakuMine: api_sakuMine, api_sakuRead: api_sakuRead, api_sakuSave: api_sakuSave, api_sakuShare: api_sakuShare, api_sakuTeacher: api_sakuTeacher, api_sakuTeacherDelete: api_sakuTeacherDelete, api_save: api_save, api_setBunkai: api_setBunkai, api_setGates: api_setGates, api_setGrades: api_setGrades, api_setOrder: api_setOrder, api_setPointer: api_setPointer, api_setTests: api_setTests, api_setWriteLevel: api_setWriteLevel, api_teacherView: api_teacherView };
  if (!Object.prototype.hasOwnProperty.call(API, String(name))) throw new Error('呼べない関数です: ' + name);
  return API[name].apply(null, Array.isArray(args) ? args : []);
}

// 初回だけエディタから実行する: シートと見出しを作る
function setup() {
  sheet_('名簿', ['メール', '学年', '組', '番号', '名前']);
  sheet_('教師', ['メール', '学年', '組']);
  sheet_('進捗', ['メール', 'read', 'write', 'meta', '更新']);
  sheet_('設定', ['キー', '値']);
  sakuSheet_();
}

// 1回の実行（google.script.run の1呼び出し）の中だけで使う読み込みの控え。
// シートの読み書きは1回ごとに通信が入って遅いので、同じシート・名簿・設定は1回だけ読む。各 api_ の最初に begin_() で空にする
var MEMO_ = {};
function begin_() { MEMO_ = {}; return me_(); }
function memo_(k, f) { return k in MEMO_ ? MEMO_[k] : (MEMO_[k] = f()); }

function sheet_(name, header) {
  return memo_('sheet:' + name, function () {
    var ss = ss_();
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    return sh;
  });
}
function progressSheet_() { return sheet_('進捗', ['メール', 'read', 'write', 'meta', '更新']); }
function settingsSheet_() { return sheet_('設定', ['キー', '値']); }

function me_() {
  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) throw new Error('アカウントを確認できません（公開設定を「ドメイン内」にし、学校アカウントで開いてください）');
  if (baseRoster_()) { var bm = Base.me(); return { email: email, role: bm.role === 'teacher' ? 'teacher' : STUDENT_RE.test(email) ? 'student' : 'unknown' }; }
  var role = STUDENT_RE.test(email) ? 'student' : TEACHER_RE.test(email) ? 'teacher' : 'unknown';
  return { email: email, role: role };
}

function findRow_(sh, key) {
  var hit = sh.getRange('A:A').createTextFinder(key).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}
// 設定シートを1回で全部読む: { キー: { row, value } }（同じキーが2行あれば上の行）
function settings_() {
  return memo_('settings', function () {
    var sh = settingsSheet_(), n = sh.getLastRow() - 1, out = {};
    if (n > 0) sh.getRange(2, 1, n, 2).getValues().forEach(function (r, i) {
      var k = String(r[0]);
      if (k && !(k in out)) out[k] = { row: i + 2, value: r[1] };
    });
    return out;
  });
}
function setting_(key) { var e = settings_()[key]; return e ? e.value : ''; }
// 設定の書き込みはスクリプトロックで順番にする（先生が複数画面・複数人で同時に変えた時に古い値で上書きしない）
function setSetting_(key, value, after) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = settingsSheet_();
    delete MEMO_.settings; // ロックの中では必ず新しく読む（この実行がロック前に読んだ控えを使い回すと、同時保存で同じキーを二重に足す）
    var all = settings_(), e = all[key];
    if (e) sh.getRange(e.row, 2).setValue(value); else sh.appendRow([key, value]);
    all[key] = { row: e ? e.row : sh.getLastRow(), value: value }; // この実行のあとの読み取りにも新しい値を返す
    if (after) after(); // キャッシュの上書きなど、シートと同じ順番で行う処理はロックの中で（api_setGates）
  } finally {
    lock.releaseLock();
  }
}

// 見出しの名前で列を探して読む（列の順番が変わっても、旧版の[メール, 組]の名簿でも読める）
function table_(name, header) {
  var sh = sheet_(name, header), n = sh.getLastRow() - 1, w = sh.getLastColumn();
  if (n < 1 || w < 1) return [];
  var head = sh.getRange(1, 1, 1, w).getValues()[0].map(String), rows = sh.getRange(2, 1, n, w).getValues();
  return rows.map(function (r) { var o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; });
}
function klassKey_(grade, cls) {
  grade = String(grade === undefined ? '' : grade).trim(); cls = String(cls === undefined ? '' : cls).trim();
  return grade && cls ? grade + '-' + cls : cls; // 学年の列が無い旧版の名簿は、組の値をそのままキーにする
}
// 児童の名簿: [{ email, grade, klass, no, name }]
// 名簿と担当の出どころ：学習BASE の中で、所有者が切り替えた後（スクリプトのプロパティ KANZI_ROSTER が base）は学習BASE の名簿と担当。
// それまでは今まで通り、このスプレッドシートの「名簿」「教師」。切り替える前に api_lbRosterCheck で照らし合わせる
function baseRoster_() { return inBase_() && String(PropertiesService.getScriptProperties().getProperty('KANZI_ROSTER') || '') === 'base'; }
function rosterFromBase_() {
  return Base.roster().filter(function (r) { return r.mail && r.name; }).map(function (r) {
    return { email: String(r.mail).toLowerCase(), grade: Number(r.grade) || 0, klass: Base.classKey(r.grade, r.cls), no: r.no || '', name: r.name };
  });
}
function rosterFromSheet_() {
  return table_('名簿', ['メール', '学年', '組', '番号', '名前']).map(function (o) {
    var email = String(o['メール'] || '').trim().toLowerCase();
    var klass = klassKey_(o['学年'], o['組']);
    var g = Number(o['学年']) || Number((klass.match(/^([1-6])/) || [])[1]) || 0;
    return { email: email, grade: g, klass: klass, no: o['番号'] === '' ? '' : o['番号'], name: String(o['名前'] || '') };
  }).filter(function (x) { return x.email && x.klass; });
}
function roster_() {
  if (baseRoster_()) return memo_('roster', rosterFromBase_);
  return memo_('roster', function () { return table_('名簿', ['メール', '学年', '組', '番号', '名前']).map(function (o) {
    var email = String(o['メール'] || '').trim().toLowerCase();
    var klass = klassKey_(o['学年'], o['組']);
    var g = Number(o['学年']) || Number((klass.match(/^([1-6])/) || [])[1]) || 0;
    return { email: email, grade: g, klass: klass, no: o['番号'] === '' ? '' : o['番号'], name: String(o['名前'] || '') };
  }).filter(function (x) { return x.email && x.klass; }); });
}
function classOf_(email) {
  var r = roster_().filter(function (x) { return x.email === email; })[0];
  return r ? r.klass : '';
}
// 先生の担当学級（「教師」シート）。組が空の行は、その学年の名簿にある全学級
function teacherClasses_(email) {
  return memo_('classes:' + email, function () { return teacherClasses0_(email); });
}
function teacherClasses0_(email) {
  var all = {}, out = {};
  if (baseRoster_()) {   // 学習BASE の決まり：教師ドメインの先生は全学級（決定 2026-11-11。作文も含む）
    roster_().forEach(function (x) { all[x.klass] = x.grade; });
    return Object.keys(all).filter(function (k) { var i = k.indexOf('-'); return Base.canSeeClass(email, Number(k.slice(0, i)), k.slice(i + 1)); }).sort();
  }
  roster_().forEach(function (x) { all[x.klass] = x.grade; });
  table_('教師', ['メール', '学年', '組']).forEach(function (o) {
    if (String(o['メール'] || '').trim().toLowerCase() !== email) return;
    var g = String(o['学年'] === undefined ? '' : o['学年']).trim(), c = String(o['組'] === undefined ? '' : o['組']).trim();
    if (c) out[klassKey_(g, c)] = true;
    else if (g) for (var k in all) if (String(all[k]) === g) out[k] = true;
  });
  return Object.keys(out).sort();
}
function requireClass_(klass) {
  var me = requireTeacher_();
  if (teacherClasses_(me.email).indexOf(String(klass)) < 0) throw new Error(klass + ' はあなたの担当学級ではありません（「教師」シートを確認してください）');
  return me;
}
// 担当学級が1つ以上ある先生だけ（過年度データなど 学級を指定しない先生系APIの入口）
function requireAssigned_() {
  var me = requireTeacher_();
  if (!teacherClasses_(me.email).length) throw new Error('担当の学級がありません（「教師」シートを確認してください）');
  return me;
}

// 見せる学年（h＝ひらがな・k＝カタカナ・1〜6年）。未設定なら組名の先頭の数字（例: 3-1 → 3年）、それもなければ3年
function tabList_(list) {
  var seen = {};
  return (list || []).map(function (g) { g = String(g).trim(); return g === 'h' || g === 'k' ? g : Number(g); })
    .filter(function (g) { var ok = (g === 'h' || g === 'k' || (g >= 1 && g <= 6)) && !seen[g]; seen[g] = true; return ok; });
}
function grades_(klass) {
  var list = tabList_(String(setting_('grades:' + klass) || '').split(','));
  if (list.some(function (g) { return typeof g === 'number'; })) return list;
  var m = String(klass).match(/^\s*([1-6])/); // 学級キー「学年-組」の学年
  return [m ? Number(m[1]) : 3];
}
function pointers_(klass) {
  var out = {};
  for (var g = 1; g <= 6; g++) { var v = Number(setting_('pointer:' + klass + ':' + g)) || 0; if (v) out[g] = v; }
  return out;
}
// 漢字テストの範囲（設定のキー test:<学級>）。テストごとに複数管理し、児童に見せるのは1つ。
// { active: id|null, list: [{ id, label, chars }] }。旧形式 { label, chars } も読める（見せている1個のテストとして）
function tests_(klass) {
  try { return Sched.normTests(JSON.parse(setting_('test:' + klass) || 'null')); } catch (e) { return Sched.normTests(null); }
}
function orders_() {
  var out = {};
  for (var g = 1; g <= 6; g++) { var v = validOrder_(g, setting_('order:' + g)); if (v) out[g] = v; }
  return out;
}
function validOrder_(g, s) {
  s = String(s || '');
  var a = Array.from(s);
  return a.length === GRADE_LEN[g] && new Set(a).size === a.length ? s : '';
}

function loadProgress_(email) {
  var sh = progressSheet_();
  var r = findRow_(sh, email);
  if (!r) return { row: 0, p: Sched.newProgress() };
  var v = sh.getRange(r, 2, 1, 3).getValues()[0];
  var p = parseProgress_(v[0], v[1], v[2]), forest = loadForest_(sh, r);
  if (forest) p.forest = forest;
  return { row: r, p: p };
}
// 森の保存領域だけを扱う。A〜E列の形式は先生の集計も使っているため固定。
var FOREST_COLUMN_ = 6;
var FOREST_CHUNK_SIZE_ = 40000;
function loadForest_(sh, row) {
  var count = sh.getLastColumn() - FOREST_COLUMN_ + 1;
  if (count <= 0) return null;
  var raw = sh.getRange(row, FOREST_COLUMN_, 1, count).getValues()[0].join('');
  // 壊れていても（列を消した・手で書きかえた等）開けなくならないようにする。失うのは葉の色だけ（成長量は D列の done・old）
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
// 形の違う字エントリを取り除く（api_save で統合する前の下ごしらえ）。
// まちがい回数の無い旧形式（4要素の数値）は 0 で補って残す。それ以外の不正（非数値・範囲外・負）は字単位で落とす
function dropBadEntries_(tbl, lo) {
  for (var c in tbl) {
    var e = tbl[c];
    if (Array.isArray(e) && e.length === 4 && e.every(function (x) { return Number.isFinite(x); })) tbl[c] = e.concat(0);
    if (!Sched.checkEntry(tbl[c], lo)) delete tbl[c];
  }
}
function writeProgress_(sh, rowNumber, row, forest) {
  var json = JSON.stringify(forest), chunks = [];
  for (var i = 0; i < json.length; i += FOREST_CHUNK_SIZE_) chunks.push(json.slice(i, i + FOREST_CHUNK_SIZE_));
  var last = sh.getLastColumn(), width = Math.max(FOREST_COLUMN_ - 1 + chunks.length, last);
  // 列を足すのは、今ある列より多く要る時だけ（見出しもその時だけ書く。毎回の保存でシートへの書き込みを増やさない）
  if (FOREST_COLUMN_ - 1 + chunks.length > last) {
    var maxColumns = sh.getMaxColumns();
    if (width > maxColumns) sh.insertColumnsAfter(maxColumns, width - maxColumns);
    sh.getRange(1, FOREST_COLUMN_, 1, chunks.length).setValues([chunks.map(function (_, j) { return '森' + (j + 1); })]);
  }
  row = row.concat(chunks);
  // 短くなった時も以前の末尾が残らないよう、使用済みの列まで空にする。
  while (row.length < width) row.push('');
  if (rowNumber) sh.getRange(rowNumber, 1, 1, width).setValues([row]); else sh.appendRow(row);
}
// 進捗の行（read, write, meta の文字列）を読む。壊れた欄は空として扱う（1欄の破損で全部を失わない）
function parseProgress_(read, write, meta) {
  var p = Sched.newProgress();
  try { p.read = JSON.parse(read || '{}'); } catch (e) {}
  try { p.write = JSON.parse(write || '{}'); } catch (e) {}
  try { var m = JSON.parse(meta || '{}'); p.sel = m.sel || {}; p.done = m.done || {}; if (m.old) p.old = m.old; if (m.bunkai) p.bunkai = m.bunkai; if (m.setsumei) p.setsumei = m.setsumei; if (m.tp) p.tp = m.tp; } catch (e) {} // 旧版の行（D列が日付）は無視
  return Sched.norm(p);
}

function api_init() {
  var me = begin_(), orders = orders_(), ver = Sched.VER || '';
  if (me.role === 'student') {
    var klass = classOf_(me.email);
    // 名簿にいない児童は どの学級の児童ページにも対応しない（学級なしを返し、画面は案内だけを出す。進捗・学級設定は読まない）
    if (!klass) return { role: 'student', email: me.email, klass: '', orders: orders, ver: ver };
    return { role: 'student', email: me.email, klass: klass, name: (roster_().filter(function (x) { return x.email === me.email; })[0] || {}).name || '', progress: loadProgress_(me.email).p, grades: grades_(klass), pointers: pointers_(klass), orders: orders, test: Sched.activeTest(tests_(klass)), writeLevel: writeLevel_(klass), gates: gates_(klass), ver: ver };
  }
  if (me.role === 'teacher') return { role: 'teacher', email: me.email, classes: teacherClasses_(me.email), orders: orders, ver: ver };
  return { role: 'unknown', email: me.email, ver: ver };
}

// 児童の進捗を受け取り、保存済みのものと統合して返す。
// 終えた回（done）は1回ごとに増えるので、3か月より前の月の分は合計（old）にまとめて、セルの上限（5万字）に届かないようにする
function api_save(json) {
  var me = begin_();
  if (me.role !== 'student') throw new Error('児童のアカウントではありません');
  // 名簿にいない児童の進捗は どの学級の先生にも届かないので受け取らない
  if (!classOf_(me.email)) throw new Error('名簿に あなたが 入っていません（先生に いってください）');
  var incoming = Sched.norm(JSON.parse(json));
  // 形の違う字エントリは字単位で直す（旧形式は補完）・落としてから統合する。
  // 全体を拒否すると、一部だけ壊れた端末の進捗が永遠に保存できなくなる
  dropBadEntries_(incoming.read, 1); dropBadEntries_(incoming.write, 0);
  // れんしゅうプリントの点も 形の違う回だけ落とす（[点 0〜100, 問題数]）
  Object.keys(incoming.tp).forEach(function (t) { var e = incoming.tp[t]; if (!(isFinite(Number(t)) && Array.isArray(e) && (e.length === 2 || (e.length === 3 && e[2] === 1)) && e[0] >= 0 && e[0] <= 100 && e[1] > 0)) delete incoming.tp[t]; });
  // 同じ児童の2台からの同時保存だけを順番にする（別の児童の行は独立。appendRow は1回で行を足すので競合しない）。
  // ユーザー単位のロックにして、学級の30人が同時に終えても互いを待たせない
  var lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    var cur = loadProgress_(me.email);
    var m = Sched.compact(Sched.merge(cur.p, incoming), Sched.compactBefore(new Date()));
    var row = [me.email, JSON.stringify(m.read), JSON.stringify(m.write), JSON.stringify({ sel: m.sel, done: m.done, old: m.old, bunkai: m.bunkai, setsumei: m.setsumei, tp: m.tp }), new Date()];
    if (row[1].length >= 50000 || row[2].length >= 50000 || row[3].length >= 50000) throw new Error('進捗が大きすぎます'); // I6
    writeProgress_(progressSheet_(), cur.row, row, m.forest);
    return JSON.stringify(m);
  } finally {
    lock.releaseLock();
  }
}

function requireTeacher_() {
  var me = begin_();
  if (me.role !== 'teacher') throw new Error('先生のアカウントではありません');
  return me;
}

// 先生画面に要るものを1回の通信で返す（担当学級だけ）:
// { grades, pointers, test, students: [{ no, name, last, sessions, items, learned, miss }], stats: { students, perChar: { 字: [よむで答えた人数, 最後の答えがまちがい（箱1）の人数] } } }
// 進捗シートは1回だけ読む。字ごとの集計には児童名を含めない
function api_teacherView(klass) {
  requireClass_(klass);
  klass = String(klass);
  var kids = roster_().filter(function (x) { return x.klass === klass; });
  var rows = {}, sh = progressSheet_(), m = sh.getLastRow() - 1;
  if (m > 0) sh.getRange(2, 1, m, 4).getValues().forEach(function (r) { rows[String(r[0]).toLowerCase()] = r; });
  var per = {}, perP = {}, perS = {};
  var students = kids.map(function (k) {
    var r = rows[k.email], out = { no: k.no, name: k.name || k.email.split('@')[0], last: 0, sessions: 0, items: 0, learned: 0, miss: [], tp: null };
    if (!r) return out;
    var p = parseProgress_(r[1], r[2], r[3]), miss = [], c, d;
    // ぶんかい: 問題ごとに [答えた人数, 最後の答えがまちがいの人数, 役割まちがいの累計, 係り先まちがいの累計]
    for (var pid in p.bunkai) {
      var be = p.bunkai[pid];
      if (!(be[0] > 0)) continue;
      var bp = perP[pid] || (perP[pid] = [0, 0, 0, 0]);
      bp[0]++;
      if (be[3] > 0) bp[1]++;
      bp[2] += be[4] || 0; bp[3] += be[5] || 0;
    }
    // せつめい文: 文章ごとに [答えた人数, 最後の答えがまちがいの人数, ①まちがい累計, ②まちがい累計, ③まちがい累計]
    for (var sid in p.setsumei) {
      var se = p.setsumei[sid];
      if (!(se[0] > 0)) continue;
      var sp = perS[sid] || (perS[sid] = [0, 0, 0, 0, 0]);
      sp[0]++;
      if (se[3] > 0 && se[3] >= se[2]) sp[1]++;
      sp[2] += se[4] || 0; sp[3] += se[5] || 0; sp[4] += se[6] || 0;
    }
    [p.read, p.write].forEach(function (t) { for (c in t) { if (t[c][3] > out.last) out.last = t[c][3]; } });
    for (c in p.read) {
      var e = p.read[c];
      if (e[0] >= Sched.WRITE_UNLOCK_BOX) out.learned++;
      if (e[2] > 0) {
        var v = per[c] || (per[c] = [0, 0]);
        v[0]++;
        if (e[0] === 1) v[1]++;
        if ((e[4] || 0) > 0) miss.push({ c: c, r: e[4] / e[2] });
      }
    }
    for (c in p.write) if (p.write[c][2] > 0 && (p.write[c][4] || 0) > 0) miss.push({ c: c, r: p.write[c][4] / p.write[c][2] });
    out.tp = Sched.tprintAvg(p, Date.now(), 14); // れんしゅうプリントの 直近2週間の平均点
    out.sessions = p.old[1]; out.items = p.old[2];
    for (d in p.done) { out.sessions++; out.items += p.done[d]; if (Number(d) > out.last) out.last = Number(d); }
    var seen = {};
    out.miss = miss.sort(function (a, b) { return b.r - a.r; }).map(function (x) { return x.c; }).filter(function (x) { return seen[x] ? false : (seen[x] = true); }).slice(0, 3);
    return out;
  }).sort(function (a, b) { return (Number(a.no) || 999) - (Number(b.no) || 999); });
  var tests = tests_(klass);
  return { grades: grades_(klass), pointers: pointers_(klass), tests: tests, test: Sched.activeTest(tests), writeLevel: writeLevel_(klass), gates: gates_(klass), students: students, bunkai: bunkai_(klass), stats: { students: kids.length, perChar: per, perProblem: perP, perText: perS } };
}

function api_setGrades(klass, list) {
  requireClass_(klass);
  list = tabList_(list);
  if (!list.some(function (g) { return typeof g === 'number'; })) throw new Error('1年〜6年から1つ以上えらんでください');
  setSetting_('grades:' + klass, list.join(','));
  return list;
}
function validChars_(s) {
  var seen = {};
  return Array.from(String(s || '')).filter(function (c) { return /[\u4e00-\u9fff]/.test(c) && !seen[c] && (seen[c] = true); }).slice(0, 300).join('');
}
// テスト範囲の一式 { active, list: [{ id, label, chars }] } をまるごと保存（先生の編集は押すたびに全体を送る）
function api_setTests(klass, json) {
  requireClass_(klass);
  var t = Sched.normTests(JSON.parse(json || 'null'));
  t.list.forEach(function (x) { x.chars = validChars_(x.chars); x.okuri = Array.from(validChars_(x.okuri)).filter(function (c) { return x.chars.indexOf(c) >= 0; }).join(''); });
  if (!t.list.some(function (x) { return x.id === t.active; })) t.active = null;
  var v = t.list.length ? t : null;
  setSetting_('test:' + klass, v ? JSON.stringify(v) : '');
  return v || t; // 消えた時も { active: null, list: [] } を返して画面の状態とそろえる
}
// 書く問題の判定の強さ（設定のキー write:<学級>）: '' ＝ふつう、'easy' ＝やさしい
function writeLevel_(klass) { return String(setting_('write:' + klass)) === 'easy' ? 'easy' : ''; }
function api_setWriteLevel(klass, level) {
  requireClass_(klass);
  level = level === 'easy' ? 'easy' : '';
  setSetting_('write:' + klass, level);
  return level;
}
function api_setPointer(klass, grade, n) {
  requireClass_(klass);
  grade = Number(grade);
  n = Math.max(0, Math.min(GRADE_LEN[grade] || 0, Math.floor(Number(n) || 0)));
  setSetting_('pointer:' + klass + ':' + grade, n);
  return n;
}
function api_setOrder(grade, s) {
  var me = requireTeacher_();
  // 出題順は学年で共通。その学年の学級を担当している先生だけが変えられる
  if (!teacherClasses_(me.email).some(function (k) { return grades_(k).indexOf(Number(grade)) >= 0 || String(k).charAt(0) === String(grade); }))
    throw new Error(grade + '年の学級を担当していないので、出題順は変えられません');
  var v = validOrder_(Number(grade), s);
  if (!v) throw new Error(grade + '年の字がちょうど1回ずつ入っていません');
  setSetting_('order:' + grade, v);
  return v;
}

// ---- 過年度データ（年度末に いまの「名簿」「進捗」を写して残す。児童名は集計に出さない）
// 過年度のシート名は「名簿2025」「進捗2025」（名前＋4桁の年度）
function sheetByName_(name) { return ss_().getSheetByName(name); }
function archYear_(year) {
  year = String(year || '');
  if (!/^\d{4}$/.test(year)) throw new Error('年度は4桁の数字で入れてください（例: 2025）');
  return year;
}
// 残した年度ごとのシートの有無: { '2025': { roster: true, progress: true } }
function archSheets_() {
  var out = {};
  ss_().getSheets().forEach(function (s) {
    var m = /^(名簿|進捗)(\d{4})$/.exec(s.getName());
    if (m) (out[m[2]] = out[m[2]] || {})[m[1] === '名簿' ? 'roster' : 'progress'] = true;
  });
  return out;
}
// 過年度データでメールが残っている行の数（名簿・進捗の両方のA列）。0 なら消去済み。
// 途中で止まった時は 残っている行数が返るので、画面で続きを実行できる（済んだ行はメールが無いので自然に飛ばされる）
function archAnonRemaining_(year) {
  var n = 0;
  ['名簿', '進捗', '作文'].forEach(function (name) {
    var sh = sheetByName_(name + year);
    if (!sh) return;
    var m = sh.getLastRow() - 1, col = archCol_(sh, 'メール', true);
    if (m <= 0) return;
    sh.getRange(2, col, m, 1).getValues().forEach(function (r) { if (String(r[0]).indexOf('@') >= 0) n++; });
  });
  return n;
}
// 過年度シートの列を見出しの名前で探す（1から数えた列番号。無ければ 0）。
// 名簿は列の順を入れ替えても読める作りなので（table_）、消去も列の位置で決め打ちしない。
// メールの列が見つからない時は、消したことにせず止める（消し残しを「消した」と記録しないため）
function archCol_(sh, name, required) {
  var w = sh.getLastColumn(), i = w > 0 ? sh.getRange(1, 1, 1, w).getValues()[0].map(function (h) { return String(h).trim(); }).indexOf(name) : -1;
  if (i < 0 && required) throw new Error(sh.getName() + ' に「' + name + '」の列が見つかりません。1行目の見出しを確認してください');
  return i + 1;
}
function archAnonymized_(year) { return archAnonRemaining_(year) === 0; }
// 「まとめて消す」の確定語（画面は api_archiveView の anonWord を受け取って出し、サーバーでも照合する）
function archAnonWord_(year) { return String(year); }
// 見出しの名前で列を探して読む（過年度のシート用。シートを新しく作らない読み取り専用）
function rowsOf_(sh, header) {
  var n = sh.getLastRow() - 1, w = sh.getLastColumn();
  if (n <= 0 || w <= 0) return [];
  var vals = sh.getRange(1, 1, n + 1, w).getValues(), head = vals[0].map(String);
  return vals.slice(1).map(function (r) { var o = {}; header.forEach(function (h) { var i = head.indexOf(h); o[h] = i >= 0 ? r[i] : ''; }); return o; });
}
// その年度の名簿にある学級の一覧（年度集計の絞り込みと「まとめて消す」の担当判定に使う）
function archClasses_(rs) {
  var set = {};
  if (rs) rowsOf_(rs, ['学年', '組']).forEach(function (o) {
    var k = klassKey_(Number(o['学年']), String(o['組']));
    if (k) set[k] = true;
  });
  return Object.keys(set);
}
// 残した年度の一覧: [{ year, anonymized }]
function api_archiveYears() {
  requireAssigned_();
  var arch = archSheets_(), out = [];
  for (var y in arch) if (arch[y].roster) out.push({ year: y, anonymized: archAnonymized_(y) });
  return out.sort(function (a, b) { return a.year < b.year ? -1 : 1; });
}
// 今年度を 過年度として残す: 「名簿」「進捗」を 名前に年度を付けて複写（いまのシートはそのまま残る）
function api_archiveSave(year) {
  requireAssigned_();
  year = archYear_(year);
  var ss = ss_();
  if (ss.getSheetByName('名簿' + year) || ss.getSheetByName('進捗' + year)) throw new Error(year + '年度は すでに残してあります');
  if (baseRoster_()) {   // 名簿は学習BASE のもの：その時点の名簿を 名簿YYYY に書く（このスプレッドシートの「名簿」は古いので写さない）
    var rows = [['メール', '学年', '組', '番号', '名前']].concat(roster_().map(function (x) { var i = x.klass.indexOf('-'); return [x.email, x.grade, x.klass.slice(i + 1), x.no, x.name]; }));
    var rd = ss.insertSheet('名簿' + year); rd.getRange(1, 1, rows.length, 5).setValues(rows); rd.setFrozenRows(1);
  }
  ['名簿', '進捗', '作文'].forEach(function (name) {
    if (name === '名簿' && baseRoster_()) return;
    var sh = ss.getSheetByName(name);
    if (!sh) return; // 作文は 説明文を書く を使っていない学校には無い
    var dst = ss.insertSheet(name + year), n = sh.getLastRow(), w = sh.getLastColumn();
    if (n > 0 && w > 0) dst.getRange(1, 1, n, w).setValues(sh.getRange(1, 1, n, w).getValues());
    dst.setFrozenRows(1);
  });
  return year;
}
// 過年度の集計: クラスごとに 人数・おぼえた字の合計・まちがいのおおかった字（上位10字。児童名は出さない）
// 返すのは その先生の担当学級だけ（クラス担任は他クラスのデータに干渉できない）。
// canAnonymize は「まとめて消す」を使えるか — その年度の名簿にある全学級を担当する先生だけ
function api_archiveView(year) {
  var me = requireAssigned_();
  year = archYear_(year);
  var rs = sheetByName_('名簿' + year), ps = sheetByName_('進捗' + year);
  if (!rs) throw new Error(year + '年度のデータは ありません');
  var rosterRaw = rowsOf_(rs, ['メール', '学年', '組']);
  var roster = rosterRaw.map(function (o) {
    return { email: String(o['メール']).toLowerCase(), klass: klassKey_(Number(o['学年']), String(o['組'])), grade: Number(o['学年']) || 0 };
  }).filter(function (x) { return x.email && x.klass; });
  var rows = {};
  if (ps) { var m = ps.getLastRow() - 1; if (m > 0) ps.getRange(2, 1, m, 4).getValues().forEach(function (r) { rows[String(r[0]).toLowerCase()] = r; }); }
  // メールが残っている行数（名簿・進捗の両方）。読んだデータから数えるのでシートの読み直しはしない
  var remaining = rosterRaw.filter(function (o) { return String(o['メール']).indexOf('@') >= 0; }).length +
    Object.keys(rows).filter(function (k) { return k.indexOf('@') >= 0; }).length;
  var classes = {};
  roster.forEach(function (k) {
    var cl = classes[k.klass] || (classes[k.klass] = { grade: k.grade, students: 0, learned: 0, perChar: {} });
    cl.students++;
    var r = rows[k.email];
    if (!r) return;
    var p = parseProgress_(r[1], r[2], r[3]), c;
    for (c in p.read) {
      var e = p.read[c];
      if (e[0] >= Sched.WRITE_UNLOCK_BOX) cl.learned++;
      if (e[2] > 0) { var v = cl.perChar[c] || (cl.perChar[c] = [0, 0]); v[0]++; if (e[0] === 1) v[1]++; }
    }
  });
  var anonLog = null;
  try { var l = setting_('archLog:' + year); if (l) anonLog = JSON.parse(l); } catch (e) {}
  var own = teacherClasses_(me.email), archKlasses = archClasses_(rs);
  return { year: year, anonymized: remaining === 0, remaining: remaining, anonWord: archAnonWord_(year), anonLog: anonLog,
    canAnonymize: archKlasses.every(function (k) { return own.indexOf(k) >= 0; }),
    classes: Object.keys(classes).map(function (k) {
    var cl = classes[k];
    // 学級まちがい判定は Sched.classMissTop（3人以上が答え・最後の答えがまちがいの人がいる字を割合順に上位10件）
    var missTop = Sched.classMissTop(cl.perChar, { top: 10 });
    return { klass: k, grade: cl.grade, students: cl.students, learned: cl.learned, missTop: missTop };
  }).filter(function (x) { return own.indexOf(x.klass) >= 0; }).sort(function (a, b) { return a.grade - b.grade || (a.klass < b.klass ? -1 : 1); }) };
}
// 過年度の個人情報をまとめて消す: メール → 児童001・002…、名前 → 空。学年・組・番号・答えの記録は残るので集計は見られる。
// 誤操作を防ぐため、画面が受け取った確定語（anonWord＝年度名）を confirmWord としてサーバーでも照合する。
// メール→番号の対応は一時シート「照合YYYY」に残し、途中で止まった時の再実行は同じ番号で続きを消す（全部消えたら対応表ごと消す。
// 対応表にはメールが残るので、消し残しには出来ない）。消し終わったら実行記録を設定シートに残す（個人情報は入れない）
function api_archiveAnonymize(year, confirmWord) {
  var me = requireAssigned_();
  year = archYear_(year);
  if (String(confirmWord || '') !== archAnonWord_(year)) throw new Error('消す年度の名前が違います。画面の案内どおりに入れてください');
  // 一括で全学級の個人情報を消す操作なので、その年度の名簿にある全学級を担当する先生だけ（クラス担任は他クラスのデータを消せない）
  var mine = teacherClasses_(me.email);
  var rest = archClasses_(sheetByName_('名簿' + year)).filter(function (k) { return mine.indexOf(k) < 0; });
  if (rest.length) throw new Error(year + '年度の 全学級を 担当する先生だけが まとめて消せます（あなたの担当外: ' + rest.join('・') + '）');
  // 同じ年度を同時に消さない（後続が空の照合表を読んで別番号を付け直すと、名簿と進捗の結合が壊れる）
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return anonymize_(year, me);
  } finally {
    lock.releaseLock();
  }
}
function anonymize_(year, me) {
  var ss = ss_();
  var rs = sheetByName_('名簿' + year), ps = sheetByName_('進捗' + year);
  if (!rs && !ps && !sheetByName_('作文' + year)) throw new Error(year + '年度のデータは ありません');
  var mapName = '照合' + year, ms = sheetByName_(mapName) || ss.insertSheet(mapName);
  var ids = {}, m0 = ms.getLastRow(), added = [];
  if (m0 > 0) ms.getRange(1, 1, m0, 2).getValues().forEach(function (r) { var k = String(r[0]); if (k && !(k in ids)) ids[k] = String(r[1]); });
  var n = Object.keys(ids).length;
  function anon(v) {
    v = String(v);
    if (v.indexOf('@') < 0) return v; // 消えた行（児童NNN）や空は飛ばす — 再実行で自然に続きになる
    if (!(v in ids)) { n++; ids[v] = '児童' + ('00' + n).slice(-3); added.push([v, ids[v]]); }
    return ids[v];
  }
  // 先に全メールの番号を確定して照合表に保存してから、名簿・進捗を書き換える。
  // 書き換えの途中で止まっても、照合表が残っていれば再実行で同じ番号が付く（名簿と進捗の結合がずれない）
  // 列は見出しの名前で探す（名簿の列の順が違っても、メール・名前を確実に消す）。メールの列が無ければ何も書き換えずに止める
  var ec = rs ? archCol_(rs, 'メール', true) : 0, nc = rs ? archCol_(rs, '名前', false) : 0, ec2 = ps ? archCol_(ps, 'メール', true) : 0;
  var mails = null, names = null, m = 0;
  if (rs) {
    m = rs.getLastRow() - 1;
    if (m > 0) { mails = rs.getRange(2, ec, m, 1).getValues(); if (nc) names = rs.getRange(2, nc, m, 1).getValues(); }
  }
  var vals2 = null, m2 = 0;
  if (ps) {
    m2 = ps.getLastRow() - 1;
    if (m2 > 0) vals2 = ps.getRange(2, ec2, m2, 1).getValues();
  }
  var ws = sheetByName_('作文' + year), wm = null, wt = null, wec = 0, wtc = 0, m3 = 0;
  if (ws) {
    wec = archCol_(ws, 'メール', true); wtc = archCol_(ws, '本文', false); m3 = ws.getLastRow() - 1;
    if (m3 > 0) { wm = ws.getRange(2, wec, m3, 1).getValues(); if (wtc) wt = ws.getRange(2, wtc, m3, 1).getValues(); }
  }
  if (mails) mails.forEach(function (r) { anon(r[0]); });
  if (vals2) vals2.forEach(function (r) { anon(r[0]); });
  if (wm) wm.forEach(function (r) { anon(r[0]); });
  if (added.length) ms.getRange(m0 + 1, 1, added.length, 2).setValues(added);
  if (mails) {
    // 名前は、メールが残っている行（まだ消していない行）だけ空にする
    mails.forEach(function (r, i) { if (String(r[0]).indexOf('@') >= 0) { r[0] = anon(r[0]); if (names) names[i][0] = ''; } });
    if (names) rs.getRange(2, nc, m, 1).setValues(names);
    rs.getRange(2, ec, m, 1).setValues(mails);
  }
  if (vals2) {
    vals2.forEach(function (r) { r[0] = anon(r[0]); });
    ps.getRange(2, ec2, m2, 1).setValues(vals2);
  }
  // 作文（説明文を書く）: メールを同じ番号に、本文の2行目（原稿用紙の決まりで名前を書く行）を空に。
  // 本文のほかの場所やコメントに書いた名前は見分けられないので消えない（画面と設計書 §28 に書く）
  if (wm) {
    wm.forEach(function (r, i) {
      if (String(r[0]).indexOf('@') < 0) return;
      r[0] = anon(r[0]);
      if (wt) { var ls = String(wt[i][0]).split('\n'); if (ls.length > 1) ls[1] = ''; wt[i][0] = ls.join('\n'); }
    });
    if (wt) ws.getRange(2, wtc, m3, 1).setValues(wt);
    ws.getRange(2, wec, m3, 1).setValues(wm);
  }
  var remaining = archAnonRemaining_(year);
  if (remaining === 0) {
    ss.deleteSheet(ms); // 対応表は個人情報を含むため残せない
    setSetting_('archLog:' + year, JSON.stringify({ year: year, at: new Date().toISOString(), count: n, by: me.email }));
  }
  return { remaining: remaining };
}

// 児童画面のボタンのオン・オフ（設定のキー gates:<学級>。オフにしたボタンのキーを「,」で並べる）。
// 授業中に先生が切り替えたものを、開いたままの児童画面へ届けるため、児童はメニューを出すたびと30秒ごとに api_gates を呼ぶ。
// 30人分の呼び出しでシートを読まないよう、学級の値と児童の学級を CacheService に置く（先生が保存した時はすぐ上書き）
var GATE_CACHE_SEC_ = 600;
function gates_(klass) { return Sched.normGates(setting_('gates:' + klass)); }
function api_setGates(klass, list) {
  requireClass_(klass);
  list = Sched.normGates(list);
  setSetting_('gates:' + klass, list.join(','), function () {
    // キャッシュの上書きもシート更新と同じ順番で（ロックの外に置くと、同時保存でキャッシュだけ逆順に残る）
    cache_().put('gates:' + klass, list.join(','), GATE_CACHE_SEC_);
  });
  return list;
}
function api_gates() {
  var me = begin_();
  if (me.role !== 'student') throw new Error('児童のアカウントではありません');
  var cache = cache_(), kk = 'klass:' + me.email, klass = cache.get(kk);
  if (klass === null) { klass = classOf_(me.email); if (!klass) return []; cache.put(kk, klass, GATE_CACHE_SEC_); }
  var v = cache.get('gates:' + klass);
  if (v === null) { v = gates_(klass).join(','); cache.put('gates:' + klass, v, GATE_CACHE_SEC_); }
  return Sched.normGates(v);
}

// ぶんかいの自作問題（学級ごと）。届け方はゲートと同じ: 設定シートの bunkai:<学級> にJSONで保存し、児童はキャッシュ経由で読む
function bunkai_(klass) { return Sched.normBunkai(setting_('bunkai:' + klass)); }
function api_setBunkai(klass, json) {
  requireClass_(klass);
  var v = Sched.normBunkai(JSON.parse(json || 'null'));
  setSetting_('bunkai:' + klass, v ? JSON.stringify(v) : '', function () {
    cache_().put('bunkai:' + klass, v ? JSON.stringify(v) : '', GATE_CACHE_SEC_);
  });
  return v;
}
function api_bunkai() {
  var me = begin_();
  if (me.role !== 'student') throw new Error('児童のアカウントではありません');
  var cache = cache_(), kk = 'klass:' + me.email, klass = cache.get(kk);
  if (klass === null) { klass = classOf_(me.email); if (!klass) return []; cache.put(kk, klass, GATE_CACHE_SEC_); }
  var v = cache.get('bunkai:' + klass);
  if (v === null) { v = JSON.stringify(bunkai_(klass)); cache.put('bunkai:' + klass, v, GATE_CACHE_SEC_); }
  return Sched.normBunkai(v ? JSON.parse(v) : null);
}

// ---- 説明文を書く（設計書 §28）。シート「作文」に 1作品＝1行。
// 児童が書く列（学級・本文・型・見せる・更新）と 先生が書く列（コメント）を分け、保存は自分の列だけを書く
// （同じ行を児童と先生が同時に書いても、相手の列を古い値で上書きしない: 要件 W5）。行は消さない（型を del にする）。
// 児童が読めるのは自分の作品と、先生が「読み合う」を開いている間の 同じ学級の「見せる」作品の本文だけ（§1 の例外・§28）。
var SAKU_HEAD_ = ['作品', 'メール', '学級', '本文', '型', '見せる', 'コメント', '更新', 'なおし'];
var SAKU_COL_ = { id: 1, email: 2, klass: 3, text: 4, mode: 5, show: 6, comments: 7, updated: 8, fixes: 9 };
// なおし（先生の修正案）の列は後から足した。前の版で作ったシートには見出しを足す
function sakuSheet_() {
  var sh = sheet_('作文', SAKU_HEAD_);
  return memo_('sakuHead', function () {
    if (sh.getLastColumn() < SAKU_HEAD_.length) sh.getRange(1, SAKU_COL_.fixes).setValue('なおし');
    return sh;
  });
}
// 消した作品（型 del）も含めた全行。消した行は { id, email, row, del: true } だけ（本文などは消してある）
function sakuAll_() {
  return memo_('saku', function () {
    var sh = sakuSheet_(), n = sh.getLastRow() - 1, out = [];
    if (n < 1) return out;
    sh.getRange(2, 1, n, SAKU_HEAD_.length).getValues().forEach(function (r, i) {
      if (!r[0]) return;
      if (String(r[4]) === 'del') { out.push({ id: String(r[0]), email: String(r[1]).toLowerCase(), row: i + 2, del: true }); return; }
      var cm = {}, fx = []; try { cm = JSON.parse(r[6] || '{}') || {}; } catch (e) {} try { fx = JSON.parse(r[8] || '[]') || []; } catch (e) {}
      var w = Genko.normWork({ id: r[0], text: r[3], mode: r[4], show: r[5] === true || String(r[5]) === '1' || String(r[5]).toUpperCase() === 'TRUE', comments: cm, fixes: fx, updated: r[7] instanceof Date ? r[7].getTime() : r[7] });
      w.row = i + 2; w.email = String(r[1]).toLowerCase();
      // 学級はいまの名簿から決める（名簿にいなければ列の値）。列の値は、スプレッドシートが "3-1" を日付（3月1日）に読みかえていることがあるので戻す
      w.klass = classOf_(w.email) || sakuKlassCell_(r[2]);
      out.push(w);
    });
    return out;
  });
}
function sakuRows_() { return sakuAll_().filter(function (w) { return !w.del; }); }
// 作品を消す: 行は残し（行番号がずれると同時に書いている人の行を取り違えるため）、型を del にして 本文・コメント・なおし を空にする
function sakuErase_(row) { sakuSheet_().getRange(row, SAKU_COL_.text, 1, 6).setValues([['', 'del', false, '', new Date(), '']]); }
// 学級の列の値を "学年-組" に戻す（日付に読みかえられた値・先頭の ' を直す）
function sakuKlassCell_(v) {
  if (v instanceof Date) return (v.getMonth() + 1) + '-' + v.getDate();
  return String(v).replace(/^'/, '');
}
// 学級を書く時は先頭に ' を付けて文字として入れる（付けないと "3-1" が日付になり、先生画面・友だちの文から作品が消えた: 2026-11）
function sakuKlassText_(klass) { return "'" + klass; }
function sakuOut_(w) { var o = Genko.normWork(w); return o; } // 行番号・メールを外して返す
function sakuShare_(klass) { return String(setting_('sakuShare:' + klass)) === '1'; }
function sakuStudent_() {
  var me = begin_();
  if (me.role !== 'student') throw new Error('児童のアカウントではありません');
  var klass = classOf_(me.email);
  if (!klass) throw new Error('名簿に あなたが 入っていません（先生に いってください）');
  me.klass = klass;
  return me;
}
// 児童: 自分の作品の一覧と、読み合いが開いているか
function api_sakuMine() {
  var me = sakuStudent_();
  var all = sakuAll_().filter(function (w) { return w.email === me.email; });
  // deleted: 消した作品の番号（端末に残っている控えを捨てさせる。先生が消した作品が 控えから送り直されて戻らないように）
  return JSON.stringify({ share: sakuShare_(me.klass), works: all.filter(function (w) { return !w.del; }).map(sakuOut_), deleted: all.filter(function (w) { return w.del; }).map(function (w) { return w.id; }) });
}
// 児童: 作品を保存（新しい作品は行を足す）。見せる作品は1人1つ（利用者の指定）なので、見せるにしたら自分のほかの作品を外す
function api_sakuSave(json) {
  var raw = JSON.parse(json || '{}'), me = sakuStudent_(), w = Genko.normWork(raw);
  // 段落の順番を入れかえた時は、先生のコメントの付け先も同じように移す（{ もとの行: 新しい行 }。コメントの列はロックの中で読み直して書く）
  var remap = null;
  if (raw.remap && typeof raw.remap === 'object') { remap = {}; for (var rk in raw.remap) { var a = Number(rk), b = Number(raw.remap[rk]); if (a >= 2 && a < 400 && b >= 2 && b < 400) remap[a] = b; } }
  if (!/^w[0-9a-z]{4,30}$/.test(w.id)) throw new Error('作品の番号が正しくありません');
  var lock = LockService.getScriptLock(); // 先生のコメントの書き込みと同じ行を扱うので、学級をまたいだスクリプトロックで順番にする
  lock.waitLock(20000);
  try {
    delete MEMO_.saku;
    var sh = sakuSheet_(), rows = sakuRows_(), mine = rows.filter(function (x) { return x.email === me.email; });
    var gone = sakuAll_().filter(function (x) { return x.del && x.id === w.id; })[0];
    if (gone) { if (gone.email !== me.email) throw new Error('ほかの人の作品は 書きかえられません'); return JSON.stringify({ id: w.id, deleted: true }); } // 消した作品は戻さない
    var cur = rows.filter(function (x) { return x.id === w.id; })[0];
    if (cur && cur.email !== me.email) throw new Error('ほかの人の作品は 書きかえられません');
    if (!cur && mine.length >= 30) throw new Error('作品は 30こまでです');
    var now = new Date();
    if (cur) sh.getRange(cur.row, SAKU_COL_.klass, 1, 4).setValues([[sakuKlassText_(me.klass), w.text, w.mode, w.show]]);
    else sh.appendRow([w.id, me.email, sakuKlassText_(me.klass), w.text, w.mode, w.show, '{}', now, '[]']);
    if (cur) sh.getRange(cur.row, SAKU_COL_.updated).setValue(now);
    if (cur && remap && Object.keys(cur.comments).length) { cur.comments = Genko.remapComments(cur.comments, remap); sh.getRange(cur.row, SAKU_COL_.comments).setValue(JSON.stringify(cur.comments)); }
    // 先生の修正案: 段落の入れかえに合わせて移し、児童が「なおす」「そのまま」で済ませたもの（fixDone）を外す（なおしの列だけを書く）
    if (cur && cur.fixes.length && (remap || (Array.isArray(raw.fixDone) && raw.fixDone.length))) {
      var done = (raw.fixDone || []).map(String);
      cur.fixes = Genko.remapFixes(cur.fixes, remap).filter(function (f) { return done.indexOf(f.id) < 0; });
      sh.getRange(cur.row, SAKU_COL_.fixes).setValue(JSON.stringify(cur.fixes));
    }
    if (w.show) mine.forEach(function (x) { if (x.id !== w.id && x.show) sh.getRange(x.row, SAKU_COL_.show).setValue(false); });
    w.updated = now.getTime(); w.fixes = cur ? cur.fixes : []; if (cur) w.comments = cur.comments;
    return JSON.stringify(sakuOut_(w));
  } finally { lock.releaseLock(); }
}
// 児童: 作品を消す（行は残し、型を del にする）
function api_sakuDelete(id) {
  var me = sakuStudent_();
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    delete MEMO_.saku;
    var cur = sakuRows_().filter(function (x) { return x.id === String(id) && x.email === me.email; })[0];
    if (cur) sakuErase_(cur.row);
    return true;
  } finally { lock.releaseLock(); }
}
// 児童: 先生のコメントを「よんだ」にする（コメントの列だけを書く）
function api_sakuRead(id, line) {
  var me = sakuStudent_();
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    delete MEMO_.saku;
    var cur = sakuRows_().filter(function (x) { return x.id === String(id) && x.email === me.email; })[0];
    if (!cur || !cur.comments[line]) return false;
    cur.comments[line].read = true;
    sakuSheet_().getRange(cur.row, SAKU_COL_.comments).setValue(JSON.stringify(cur.comments));
    return true;
  } finally { lock.releaseLock(); }
}
// 児童: 友だちの文（先生が開いている間だけ。同じ学級の「見せる」作品の本文だけ。コメント・字数・メールは返さない）
function api_sakuFriends() {
  var me = sakuStudent_();
  if (!sakuShare_(me.klass)) return JSON.stringify({ share: false, works: [] });
  var no = {}; roster_().forEach(function (x) { no[x.email] = Number(x.no) || 999; });
  var list = sakuRows_().filter(function (w) { return w.klass === me.klass && w.show && w.email !== me.email && w.email in no && classOf_(w.email) === me.klass; })
    .sort(function (a, b) { return no[a.email] - no[b.email]; })
    .map(function (w) { return { id: w.id, text: w.text }; });
  return JSON.stringify({ share: true, works: list });
}
// 先生: 担当学級の作品の一覧（児童ごと。名簿の番号順）と、読み合いが開いているか
function api_sakuTeacher(klass) {
  requireClass_(klass);
  var kids = roster_().filter(function (x) { return x.klass === klass; }).sort(function (a, b) { return (Number(a.no) || 999) - (Number(b.no) || 999); });
  var by = {}; sakuRows_().forEach(function (w) { if (w.klass === klass) (by[w.email] = by[w.email] || []).push(sakuOut_(w)); });
  return JSON.stringify({ share: sakuShare_(klass), students: kids.map(function (k) { return { no: k.no, name: k.name, works: (by[k.email] || []).sort(function (a, b) { return b.updated - a.updated; }) }; }) });
}
// 先生: 段落（行番号）ごとのコメントを付ける・消す（text が空なら消す）。担当学級の作品だけ
function api_sakuComment(klass, id, line, text) {
  requireClass_(klass);
  line = Number(line);
  if (!(line >= 0 && line < 400)) throw new Error('段落の番号が正しくありません');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    delete MEMO_.saku;
    var cur = sakuRows_().filter(function (x) { return x.id === String(id) && x.klass === klass; })[0];
    if (!cur) throw new Error('作品が見つかりません');
    text = String(text || '').trim().slice(0, 200);
    if (text) cur.comments[line] = { t: text, read: false, at: Date.now() }; else delete cur.comments[line];
    sakuSheet_().getRange(cur.row, SAKU_COL_.comments).setValue(JSON.stringify(cur.comments));
    return JSON.stringify(cur.comments);
  } finally { lock.releaseLock(); }
}
// 先生: 読み合いを開く・閉じる（学級ごと。設定のキー sakuShare:<学級>）
function api_sakuShare(klass, on) {
  requireClass_(klass);
  setSetting_('sakuShare:' + klass, on ? '1' : '');
  return !!on;
}
// 先生: 修正案を足す（{ line, start, from, to }）。もとの字が いまの本文に無ければ足さない
function api_sakuFix(klass, id, json) {
  requireClass_(klass);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    delete MEMO_.saku;
    var cur = sakuRows_().filter(function (x) { return x.id === String(id) && x.klass === klass; })[0];
    if (!cur) throw new Error('作品が見つかりません');
    var f = Genko.normFixes([JSON.parse(json || '{}')])[0];
    if (!f) throw new Error('なおす字が正しくありません');
    if (!Genko.fixLocate(cur.text, f)) throw new Error('児童が文を書きかえたので、もう一度 えらんでください');
    if (cur.fixes.length >= 100) throw new Error('修正案は 100こまでです');
    f.id = 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); f.at = Date.now();
    cur.fixes.push(f);
    sakuSheet_().getRange(cur.row, SAKU_COL_.fixes).setValue(JSON.stringify(cur.fixes));
    return JSON.stringify(cur.fixes);
  } finally { lock.releaseLock(); }
}
// 先生: 修正案を取り消す
function api_sakuFixDel(klass, id, fixId) {
  requireClass_(klass);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    delete MEMO_.saku;
    var cur = sakuRows_().filter(function (x) { return x.id === String(id) && x.klass === klass; })[0];
    if (!cur) throw new Error('作品が見つかりません');
    cur.fixes = cur.fixes.filter(function (f) { return f.id !== String(fixId); });
    sakuSheet_().getRange(cur.row, SAKU_COL_.fixes).setValue(JSON.stringify(cur.fixes));
    return JSON.stringify(cur.fixes);
  } finally { lock.releaseLock(); }
}
// 先生: 担当学級の作品を消す（本文・コメント・なおし も消す。もとに戻せない）
function api_sakuTeacherDelete(klass, id) {
  requireClass_(klass);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    delete MEMO_.saku;
    var cur = sakuRows_().filter(function (x) { return x.id === String(id) && x.klass === klass; })[0];
    if (!cur) throw new Error('作品が見つかりません');
    sakuErase_(cur.row);
    return true;
  } finally { lock.releaseLock(); }
}

return {
  "doGet": (typeof doGet === 'function' ? doGet : undefined),
  "apiCall": (typeof lbApi_ === 'function' ? lbApi_ : undefined),
  "setup": (typeof setup === 'function' ? setup : undefined),
  "ready": (typeof lbReady_ === 'function' ? lbReady_ : undefined)
};
})(); } catch (e) { console.error("アプリ kanzi を読み込めません: " + (e && e.message || e)); return { broken: String(e && e.message || e) }; } })();
