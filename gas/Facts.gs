/**
 * Facts.gs — 全アプリのセッションを「児童 × 技能 × 週」に集計する（計算の方法はここに1つだけ）
 *
 * 正本は learning-base。アプリは集計の計算を書かない。セッションを書けば、ここが毎晩まとめる。
 *
 * 集計の行（ハブの facts_<年度>）：
 *   週（月曜の日付）| メール | 学年 | 組 | 番号 | アプリ | 技能 | 件数 | 正答 | 時間のある件数 | 対数時間の和 | 二乗和 | 誤答の型 | セッション数
 * 状態（未着手・練習中・到達）は、目録の基準で、直近の数週をまとめて判定する（state）。
 */
var LbFacts = (function () {
  var HEAD = ['week', 'mail', 'grade', 'cls', 'no', 'app', 'skill', 'n', 'ok', 'tn', 'sl', 'sl2', 'mis', 'sess'];
  var CURSOR_SHEET = 'facts_cursor', CURSOR_HEAD = ['app', 'sheet', 'row', 'updated'];
  var BATCH = 5000, BUDGET_MS = 240 * 1000;
  var DAY = 86400000;

  /* ---------- 純粋な計算 ---------- */

  /** その時刻が属する週の月曜（日本時間）。'YYYY-MM-DD' */
  function weekOf(ts) {
    var ms = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
    if (!isFinite(ms)) return '';
    var d = new Date(ms + 9 * 3600000);              // 日本時間（夏時間なし）
    var back = (d.getUTCDay() + 6) % 7;              // 月曜まで戻る日数
    var m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - back * DAY);
    return m.getUTCFullYear() + '-' + pad(m.getUTCMonth() + 1) + '-' + pad(m.getUTCDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function addWeeks(week, k) {
    var p = week.split('-');
    var m = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + k * 7 * DAY);
    return m.getUTCFullYear() + '-' + pad(m.getUTCMonth() + 1) + '-' + pad(m.getUTCDate());
  }

  function key(week, mail, app, skill) { return week + '|' + mail + '|' + app + '|' + skill; }
  function blank(week, s, app, skill) {
    return { week: week, mail: s.mail, grade: s.grade, cls: s.cls, no: s.no, app: app, skill: skill, n: 0, ok: 0, tn: 0, sl: 0, sl2: 0, mis: {}, sess: 0 };
  }
  function addInto(f, st) {
    f.n += st.n || 0; f.ok += st.ok || 0; f.tn += st.tn || 0;
    f.sl = round(f.sl + (st.sl || 0)); f.sl2 = round(f.sl2 + (st.sl2 || 0));
    for (var m in (st.mis || {})) f.mis[m] = (f.mis[m] || 0) + st.mis[m];
  }
  function round(x) { return Math.round(x * 1e6) / 1e6; }

  /** セッション（LbSession.fromRow の形）を集計に足す。acc は { キー: 行 } */
  function addSession(acc, s) {
    var week = weekOf(s.ts);
    if (!week || !s.mail) return acc;
    for (var skill in (s.skills || {})) {
      var k = key(week, s.mail, s.app, skill);
      var f = acc[k] || (acc[k] = blank(week, s, s.app, skill));
      addInto(f, s.skills[skill]);
      f.sess++;
      f.grade = s.grade; f.cls = s.cls; f.no = s.no;     // 週の中で所属が変わったら後の値
    }
    return acc;
  }

  function merge(a, b) {
    for (var k in b) {
      if (!a[k]) { a[k] = JSON.parse(JSON.stringify(b[k])); continue; }
      addInto(a[k], b[k]); a[k].sess += b[k].sess;
      a[k].grade = b[k].grade; a[k].cls = b[k].cls; a[k].no = b[k].no;
    }
    return a;
  }

  function toRows(acc) {
    return Object.keys(acc).sort().map(function (k) {
      var f = acc[k];
      return [f.week, f.mail, f.grade, f.cls, f.no, f.app, f.skill, f.n, f.ok, f.tn, f.sl, f.sl2, JSON.stringify(f.mis), f.sess];
    });
  }
  function fromRows(rows) {
    var acc = {};
    rows.forEach(function (r) {
      if (!r[0] || !r[1]) return;
      var week = r[0] instanceof Date ? weekOf(r[0]) : String(r[0]);
      var mis = {}; try { mis = JSON.parse(String(r[12] || '{}')); } catch (e) {}
      acc[key(week, r[1], r[5], r[6])] = { week: week, mail: String(r[1]), grade: Number(r[2]) || 0, cls: String(r[3]), no: Number(r[4]) || 0,
        app: String(r[5]), skill: String(r[6]), n: +r[7] || 0, ok: +r[8] || 0, tn: +r[9] || 0, sl: +r[10] || 0, sl2: +r[11] || 0, mis: mis, sess: +r[13] || 0 };
    });
    return acc;
  }

  /** 複数の行を1つにまとめる（週をまたいで足すなど） */
  function combine(list) {
    var f = { n: 0, ok: 0, tn: 0, sl: 0, sl2: 0, mis: {}, sess: 0, weeks: 0 };
    list.forEach(function (x) { addInto(f, x); f.sess += x.sess || 0; f.weeks++; });
    return f;
  }

  /** 正答率・幾何平均の時間（ms）・ゆらぎ（対数時間の標準偏差） */
  function stats(f) {
    if (!f || !f.n) return { n: 0, acc: null, gmMs: null, sdLog: null };
    var mean = f.tn ? f.sl / f.tn : null;
    var sd = f.tn > 1 ? Math.sqrt(Math.max(0, f.sl2 / f.tn - mean * mean)) : null;
    return { n: f.n, acc: f.ok / f.n, gmMs: mean == null ? null : Math.exp(mean), sdLog: sd };
  }

  /** その児童・技能の、endWeek を含む直近 weeks 週の行 */
  function recent(acc, mail, app, skill, endWeek, weeks) {
    var from = addWeeks(endWeek, -(weeks - 1)), out = [];
    for (var k in acc) {
      var f = acc[k];
      if (f.mail === mail && f.app === app && f.skill === skill && f.week >= from && f.week <= endWeek) out.push(f);
    }
    return out;
  }

  /**
   * 状態。rule は LbCatalog.mastery の返り値 { minN, acc, gmMs, windowWeeks }
   * 未着手＝記録なし／到達＝件数が minN 以上・正答率が acc 以上・（gmMs が 0 でなければ）幾何平均の時間が gmMs 以下／それ以外は練習中
   */
  function state(f, rule) {
    var s = stats(f);
    if (!s.n) return '未着手';
    if (s.n >= rule.minN && s.acc >= rule.acc && (!rule.gmMs || (s.gmMs != null && s.gmMs <= rule.gmMs))) return '到達';
    return '練習中';
  }

  /* ---------- シートとの読み書き ---------- */

  /**
   * 新しいセッションだけを読んで集計に足す（毎晩）。
   * sources: [{ app, ss }]（アプリの id と記録のスプレッドシート）。hubSs：ハブ。
   * 読んだ位置（facts_cursor）を覚えるので、同じセッションを2回足さない。
   * 4分を越えたら途中でやめ、続きは次の実行で読む。返す：{ read, more }
   * 集計を書いた後・位置を書く前に止まると二重に足しうる。その時は rebuild で作り直す。
   */
  function ingest(hubSs, sources, opts) {
    opts = opts || {};
    var fy = opts.fy || Base.fyOf(new Date()), start = Date.now(), budget = opts.budgetMs || BUDGET_MS;
    var cur = readCursor(hubSs), add = {}, read = 0, more = false, touched = {};
    sources.forEach(function (src) {
      LbSession.sheetNames(src.ss, fy).forEach(function (name) {
        if (more) return;
        var sh = src.ss.getSheetByName(name), last = sh.getLastRow(), ck = src.app + '|' + name;
        var from = Math.max(2, (cur[ck] || 1) + 1);
        while (from <= last) {
          if (Date.now() - start > budget) { more = true; break; }
          var n = Math.min(BATCH, last - from + 1);
          var head = sh.getRange(from, 1, n, 10).getValues();                       // 問題の欄（11列目）は読まない
          var sk = sh.getRange(from, LbSession.COL.skills + 1, n, 1).getValues();
          for (var i = 0; i < n; i++) {
            var r = head[i].concat(['', sk[i][0], '']);
            var s = LbSession.fromRow(r);
            if (s.mail && s.mail.indexOf('@') >= 0) addSession(add, s);
          }
          read += n; from += n; cur[ck] = from - 1; touched[ck] = true;
        }
      });
    });
    if (read) {
      var name = 'facts_' + fy, sh = hubSs.getSheetByName(name) || hubSs.insertSheet(name);
      var old = sh.getLastRow() > 1 ? fromRows(sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues()) : {};
      writeFacts(sh, merge(old, add));
      writeCursor(hubSs, cur);
    }
    return { read: read, more: more };
  }

  /** その年度の集計を、全セッションから作り直す（位置を消して ingest をやり直す） */
  function rebuild(hubSs, sources, opts) {
    opts = opts || {};
    var fy = opts.fy || Base.fyOf(new Date());
    var sh = hubSs.getSheetByName('facts_' + fy);
    if (sh) sh.clearContents();
    var cur = readCursor(hubSs);
    sources.forEach(function (src) { LbSession.sheetNames(src.ss, fy).forEach(function (n) { delete cur[src.app + '|' + n]; }); });
    writeCursor(hubSs, cur, true);
    return ingest(hubSs, sources, opts);
  }

  /** 集計を読む（年度・絞り込み）。{ キー: 行 } */
  function read(hubSs, fy, filter) {
    var sh = hubSs.getSheetByName('facts_' + fy);
    if (!sh || sh.getLastRow() < 2) return {};
    var acc = fromRows(sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues());
    if (!filter) return acc;
    var out = {};
    for (var k in acc) if (filter(acc[k])) out[k] = acc[k];
    return out;
  }

  function writeFacts(sh, acc) {
    var rows = toRows(acc);
    sh.clearContents();
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]);
    if (rows.length) sh.getRange(2, 1, rows.length, HEAD.length).setValues(rows);
  }
  function readCursor(hubSs) {
    var sh = hubSs.getSheetByName(CURSOR_SHEET), out = {};
    if (!sh || sh.getLastRow() < 2) return out;
    sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) { if (r[0]) out[r[0] + '|' + r[1]] = Number(r[2]) || 1; });
    return out;
  }
  function writeCursor(hubSs, cur) {
    var sh = hubSs.getSheetByName(CURSOR_SHEET) || hubSs.insertSheet(CURSOR_SHEET);
    var rows = Object.keys(cur).sort().map(function (k) { var i = k.indexOf('|'); return [k.slice(0, i), k.slice(i + 1), cur[k], new Date()]; });
    sh.clearContents();
    sh.getRange(1, 1, 1, CURSOR_HEAD.length).setValues([CURSOR_HEAD]);
    if (rows.length) sh.getRange(2, 1, rows.length, CURSOR_HEAD.length).setValues(rows);
  }

  return { HEAD: HEAD, weekOf: weekOf, addWeeks: addWeeks, addSession: addSession, merge: merge, toRows: toRows, fromRows: fromRows,
    combine: combine, stats: stats, recent: recent, state: state, ingest: ingest, rebuild: rebuild, read: read };
})();
