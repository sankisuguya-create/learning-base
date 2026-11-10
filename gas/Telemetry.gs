/**
 * Telemetry.gs — 観察では見えないものを自動で集める（LbTelemetry）
 *
 * 正本は learning-base。設計：`-` リポジトリ principles/learning-app-foundation.md §15、手順：docs/tuning-log.md
 * 改善の入力の主役は観察の報告と画面写真（撮影用）。ここで集めるのは次だけ（決定 2026-11-10）：
 *   - 失敗：サーバーの失敗と画面の JavaScript の失敗（どこで・エラー文。メール・ID・長い数字は伏せる）
 *   - 実機の速さ：サーバーの処理時間と、開いてから表示までの往復（端末のメモリ 4GB以下／8GB 別）
 *   - 始めるまで：児童がホームを開いてから最初のページを開くまでの時間と経路、教科の行き止まり（直した時に効いたかを比べる）
 * 1つ起きるたびにスクリプトのプロパティに足す（シートに書くと遅いので）。プロパティは日付と番号（0〜15、くじ）ごとに分け、
 * 同じ瞬間に2人が同じ所へ書く確率を下げる（重なると1回分落ちる。目安の数）。毎晩、前日までの分を usage シートに1日1行でまとめる。
 */
var LbTelemetry = (function () {
  var PFX = 'LB_U|', SHARDS = 16;
  var USAGE = 'usage', USAGE_HEAD = ['日付', '区分', '出来事', '回数'];
  var SPEED = { srv: [[1000, '1秒未満'], [2000, '1〜2秒'], [4000, '2〜4秒'], [Infinity, '4秒以上']],
    rt: [[2000, '2秒未満'], [4000, '2〜4秒'], [8000, '4〜8秒'], [Infinity, '8秒以上']],
    start: [[5000, '5秒未満'], [10000, '5〜10秒'], [20000, '10〜20秒'], [Infinity, '20秒以上']] };
  var PATHS = { now: 'いまの学習', tile: '教科のタイル', subject: '教科の中' };
  var MAX_KEYS = 80;   // 1つのプロパティに置く出来事の種類の上限（エラー文が大量に違う時、9KB を越えないように）

  var day = LbSheets.day, ymd = LbSheets.ymd, sheet = LbSheets.sheet;
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

  /** 直近7日の失敗の件数（月曜のメールに1行） */
  function errorCount(hub, today) {
    var since = day(new Date(new Date((today || day()) + 'T12:00:00+09:00').getTime() - 6 * 86400000)), u = usage(hub, since), n = 0;
    Object.keys(u).forEach(function (d) { Object.keys(u[d]).forEach(function (e) { if (/\|(err|js|client):/.test(e)) n += u[d][e]; }); });
    return n;
  }

  return { cleanName: cleanName, count: count, speed: speed, err: err, errText: errText, memClass: memClass, bootEvents: bootEvents, errorCount: errorCount,
    pending: pending, flush: flush, usage: usage };
})();
