// dist/core.js — 学習BASE の共通部品と振り分け（tools/bundle.cjs が作る。直接直さない）
var LB_MODULES = (typeof LB_MODULES !== "undefined" && LB_MODULES) || {};
var LB_PLATFORM_TRIGGERS = true;   // 自動実行は読み込み係が置く（アプリは置かない）
var LB_APP_IDS = ["tamath","kanzi","taiiku"];   // 載っている教科（アプリ）
var LB_APP_READY = {"kanzi":"KANZI_SS_ID"};   // 準備に要るスクリプトのプロパティ

// ===== gas/Sheets.gs =====
/**
 * Sheets.gs — ハブのシートを読み書きする共通の部品（LbSheets）
 *
 * 正本は learning-base。共通部品の一番先に読み込む（他の部品はこれを使う）。
 * スプレッドシートは書いた文字を勝手に変える：「3-1」→ 3月1日、「2026-11-10」→ 日付、「=」「+」で始まる文字 → 数式。
 * そこで、学級・日付・週を書く列は文字の書式にし（textCol）、読む時も日付に化けた値を元の形に戻す（clsCell・ymd）。
 * 手で直した行・書式を付ける前の行があるので、読む時の戻しは書式を付けた後も外さない。
 */
var LbSheets = (function () {
  var TZ = 'Asia/Tokyo';
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** 'YYYY-MM-DD'（日本時間）。d を省略すると今日 */
  function day(d) {
    d = d || new Date();
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /** 学級の欄（'3-1'）。日付に化けていれば月-日に戻す */
  function clsCell(v) { return isDate(v) ? (v.getMonth() + 1) + '-' + v.getDate() : String(v == null ? '' : v).trim(); }
  /** 日付・週の欄（'2026-11-10'）。日付に化けていれば文字に戻す */
  function ymd(v) { return isDate(v) ? day(v) : String(v == null ? '' : v).trim(); }

  /** その列を文字の書式にする（行の数は最低1000行分） */
  function textCol(sh, col) { sh.getRange(1, col, Math.max(sh.getMaxRows ? sh.getMaxRows() : 1000, 1000), 1).setNumberFormat('@'); }
  /**
   * 表を用意する。無ければ作って見出しを書き、textCols（1から数える列の番号）を文字の書式にする。
   * opts.always：既にある表にも毎回文字の書式を付け直す（手で列を足した表のため）
   */
  function sheet(ss, name, head, textCols, opts) {
    var sh = ss.getSheetByName(name), made = false;
    if (!sh) { sh = ss.insertSheet(name); made = true; }
    if (made || (opts && opts.always)) (textCols || []).forEach(function (c) { textCol(sh, c); });
    if (made) sh.getRange(1, 1, 1, head.length).setValues([head]);
    return sh;
  }
  /** 見出しの2行目以降を読む（無ければ []）。cols を省略すると見出しの列の数 */
  function rows(ss, name, cols) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues();
  }

  return { TZ: TZ, isDate: isDate, day: day, clsCell: clsCell, ymd: ymd, textCol: textCol, sheet: sheet, rows: rows };
})();

// ===== gas/Base.gs =====
/**
 * Base.gs — 学習アプリの共通部品（learning-base）
 *
 * 各アプリの GAS に、このファイルをそのまま貼る。正本は learning-base リポジトリ。
 * 設計：`-` リポジトリ principles/learning-app-foundation.md
 *
 * 持つもの（段階1）：版・ハブの場所・年度・本人確認と役割・名簿・教師の担当
 * 名前はすべて Base. の下に置く（アプリの大域名とぶつけない）。
 *
 * 前提：デプロイは「次のユーザーとして実行：自分」「アクセス：ドメイン内の全員」。
 */
// 「ハブ」＝学習BASE のデータのスプレッドシート（もとは算数TA のハブだったので、この名前が残っている。中身は学習BASE のもの。README）
var Base = (function () {
  var VER = 1;   // やりとりの形を変えたら上げる。アプリは Base.VER を見て貼り忘れを知らせる

  /* ---------- 設定 ---------- */

  /**
   * 教師のドメイン。@ の右側の完全一致でだけ判定する。
   * 児童は kyoiku.edu.nishi.or.jp で、教師ドメインのサブドメインになっている。
   * 「含む」で判定すると児童が全員教師になる（算数TA Core.gs の注記と同じ）。
   */
  var TEACHER_DOMAIN = 'edu.nishi.or.jp';
  var CHILD_DOMAIN = 'kyoiku.edu.nishi.or.jp';
  var STRICT_SCOPE = false;   // true にすると、教師ドメインの人も teachers シートの担当の学級だけを見られる

  var SHEET = { ROSTER: 'roster', TEACHERS: 'teachers' };
  var TTL = 6 * 60 * 60;          // 名簿の保存時間（秒）。CacheService の上限
  var CHUNK = 30 * 1000;          // CacheService の1件は100KBまで。日本語は1字3バイトなので3万字で切る
  var PREFIX = 'base:';
  var RELOAD_SEC = 600;           // 名簿にない人が開いた時に名簿を読み直す間隔の下限（秒）

  /** 名簿の見出し。左が正規名、右が受け付ける別名（今の算数TAハブの英語見出しも読む） */
  var ROSTER_HEAD = {
    lid: ['学習者ID', 'lid'], mail: ['メール', 'email', 'mail'], grade: ['学年'], cls: ['組'], no: ['番号'],
    sei: ['姓'], mei: ['名'], seiKana: ['せい'], meiKana: ['めい'], name: ['氏名', '名前']
  };
  var LID_HEAD = '学習者ID';
  var LID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';   // 紛らわしい 0 O o 1 l I i を除く
  var TEACHER_HEAD = {
    mail: ['メール', 'email', 'mail'], sei: ['姓'], mei: ['名'], seiKana: ['せい'], meiKana: ['めい'],
    grade: ['学年'], cls: ['組']
  };

  /* ---------- ハブ ---------- */

  /**
   * BASEシート（学習BASE の本体のスプレッドシート）。BASEシートに付けた GAS では、付いているスプレッドシートがそれ（設定は要らない）。
   * スクリプトのプロパティ HUB_ID があればそれを開く（前の形：算数TA のハブを使っていた GAS。移転するまで）。
   * 同じ実行の中で開き直しても 2ms 程度（実測 2026-11-05）なので、使い回しはしない。
   */
  function hub() {
    var id = hubId();
    return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  }
  function hubId() {
    return String(PropertiesService.getScriptProperties().getProperty('HUB_ID') || '').trim();
  }
  /** アプリの設置時に1回だけ実行する（ハブのURLかIDを渡す） */
  function setHub(urlOrId) {
    var s = String(urlOrId || '').trim();
    var m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    var id = m ? m[1] : s;
    if (!/^[a-zA-Z0-9_-]{20,}$/.test(id)) throw new Error('ハブのURLかIDを入れてください: ' + s);
    SpreadsheetApp.openById(id);   // 開けなければここで止まる（共有・IDの誤り）
    PropertiesService.getScriptProperties().setProperty('HUB_ID', id);
    clearCache();
    return id;
  }

  /* ---------- 年度（4/1 はじまり） ---------- */

  /** その時刻の年度。月はスクリプトのタイムゾーンで見る。読めなければ 0。年度の境目の正本 */
  function fyOf(ts) {
    if (!ts) return 0;
    var d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return 0;
    var tz = Session.getScriptTimeZone();
    var y = Number(Utilities.formatDate(d, tz, 'yyyy')), m = Number(Utilities.formatDate(d, tz, 'M'));
    return m >= 4 ? y : y - 1;
  }
  function fy() { return fyOf(new Date()); }

  /* ---------- 本人 ---------- */

  function email() {
    var e = Session.getActiveUser().getEmail();
    return e ? String(e).trim().toLowerCase() : '';
  }
  function domainOf(mail) {
    var s = String(mail || ''), at = s.lastIndexOf('@');
    return at < 0 ? '' : s.slice(at + 1).toLowerCase();
  }
  function isTeacherDomain(mail) { return domainOf(mail) === TEACHER_DOMAIN; }
  function isChildDomain(mail) { return domainOf(mail) === CHILD_DOMAIN; }

  /**
   * 開いた人の役割。
   *   { email, role: 'teacher' | 'child' | 'guest' | 'none', child, teacher }
   * - teacher：教師ドメイン、または teachers シートに載っている人（支援員など別ドメインの口）
   * - child  ：名簿に載っていて、姓か氏名がある児童。記録・分析の対象
   * - guest  ：ログインしているが名簿にない（転入直後など）。おためしで使えるが記録しない
   * - none   ：メールが取れない（デプロイの設定が違う）
   */
  function me() {
    var mail = email();
    if (!mail) return { email: '', role: 'none', child: null, teacher: null };
    var t = teacher(mail);
    if (t || isTeacherDomain(mail)) {
      return { email: mail, role: 'teacher', child: null, teacher: t || { mail: mail, scopes: [] } };
    }
    var c = child(mail);
    if (c) return { email: mail, role: 'child', child: c, teacher: null };
    return { email: mail, role: 'guest', child: null, teacher: null };
  }

  /* ---------- 名簿 ---------- */

  /**
   * 名簿の行。{ mail, grade, cls, no, sei, mei, seiKana, meiKana, name } の配列。
   * fy を省略すると現在年度（ハブの roster）。過去年度は roster_<fy>（無ければ []）。
   * - 見出しの名前で列を探す（列の並べ替え・追加に強くする）
   * - '@' を含まない行（途中に混ざった見出し・空行）は捨てる
   * - 同じメールが2行あれば先の行。ただし先の行に名前が無く後の行にあれば後の行
   * - 旧形式（氏名だけ）は空白で姓・名に分ける。空白が無ければ全体を姓に入れる
   */
  function roster(year) {
    var cur = fy();
    if (year === undefined || year === null) year = cur;
    var key = 'roster:' + year;
    var hit = cacheGet(key);
    if (hit) return hit;
    var name = year === cur ? SHEET.ROSTER : SHEET.ROSTER + '_' + year;
    var ss = hub(), s = ss.getSheetByName(name);
    if (!s) {
      if (year === cur) throw new Error('ハブに名簿のシート「' + SHEET.ROSTER + '」がありません');
      return [];
    }
    var v = s.getDataRange().getValues();
    if (year === cur && fillIds(ss, s, v, year)) v = s.getDataRange().getValues();
    var rows = readRoster(v);
    cachePut(key, rows);
    return rows;
  }

  /**
   * 学習者ID：児童ごとの、記録をつなぐための内部の番号。
   * - 乱数で作る（名前・年齢・メール・出席番号など、外の人が知りうる情報からは導けない）
   * - メールが割り当てられていない転入生にも付く。後でメールを書き足しても同じ ID のまま（記録がつながる）
   * - 名簿に「学習者ID」の列が無ければ作り、空の行に書き足す。前の年度の名簿に同じメールがあれば、その ID を引き継ぐ
   * - 教師は ID を書き換えない（書き換えると、その児童の記録が別人になる）
   * 返す：書き足したか
   */
  function fillIds(ss, sheet, v, year) {
    if (v.length < 2) return false;
    var col = headerIndex(v[0], ROSTER_HEAD), need = [];
    for (var i = 1; i < v.length; i++) if (isChildRow(v[i], col) && !cell(v[i], col.lid)) need.push(i);
    if (!need.length) return false;
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      v = sheet.getDataRange().getValues();             // ロックの中で読み直す
      col = headerIndex(v[0], ROSTER_HEAD);
      if (col.lid < 0) { col.lid = v[0].length; sheet.getRange(1, col.lid + 1).setValue(LID_HEAD); }
      var used = {}, prev = previousIds(ss, year), wrote = false;
      for (var j = 1; j < v.length; j++) { var x = cell(v[j], col.lid); if (x) used[x] = true; }
      for (var k = 1; k < v.length; k++) {
        if (!isChildRow(v[k], col) || cell(v[k], col.lid)) continue;
        var mail = cell(v[k], col.mail).toLowerCase(), id = mail && prev[mail] && !used[prev[mail]] ? prev[mail] : newId(used);
        used[id] = true;
        sheet.getRange(k + 1, col.lid + 1).setValue(id);
        wrote = true;
      }
      return wrote;
    } finally { lock.releaseLock(); }
  }
  /** 前の年度の名簿（roster_<年度-1>）の メール → 学習者ID */
  function previousIds(ss, year) {
    var out = {}, s = ss.getSheetByName(SHEET.ROSTER + '_' + (year - 1));
    if (!s) return out;
    var v = s.getDataRange().getValues();
    if (!v.length) return out;
    var col = headerIndex(v[0], ROSTER_HEAD);
    if (col.lid < 0 || col.mail < 0) return out;
    for (var i = 1; i < v.length; i++) { var m = cell(v[i], col.mail).toLowerCase(), id = cell(v[i], col.lid); if (m && id) out[m] = id; }
    return out;
  }
  function newId(used) {
    for (var tries = 0; tries < 100; tries++) {
      var hex = Utilities.getUuid().replace(/-/g, ''), id = 'L';
      for (var i = 0; i < 10; i++) id += LID_CHARS.charAt(parseInt(hex.substr(i * 2, 2), 16) % LID_CHARS.length);
      if (!used[id]) return id;
    }
    throw new Error('学習者IDを作れません');
  }
  /** 児童の行か（見出しの混入・空行ではない）。メールがある行、またはメールが空で名前と学年がある行（転入直後） */
  function isChildRow(r, col) {
    var mail = cell(r, col.mail);
    if (mail) return mail.indexOf('@') >= 0;
    return !!(cell(r, col.sei) || cell(r, col.mei) || cell(r, col.name)) && Number(cell(r, col.grade)) > 0;
  }

  function readRoster(v) {
    if (!v.length) return [];
    var col = headerIndex(v[0], ROSTER_HEAD);
    if (col.mail < 0) throw new Error('名簿の見出しに「メール」がありません');
    var out = [], seen = {};
    for (var i = 1; i < v.length; i++) {
      if (!isChildRow(v[i], col)) continue;
      var mail = cell(v[i], col.mail).toLowerCase();
      var sei = cell(v[i], col.sei), mei = cell(v[i], col.mei), full = cell(v[i], col.name);
      if (!sei && !mei && full) {
        var parts = full.split(/[\s　]+/);
        sei = parts[0]; mei = parts.slice(1).join(' ');
      }
      var r = {
        lid: cell(v[i], col.lid), mail: mail, provisional: !mail, grade: Number(cell(v[i], col.grade)) || 0, cls: normCls(cell(v[i], col.cls)),
        no: Number(cell(v[i], col.no)) || 0, sei: sei, mei: mei,
        seiKana: cell(v[i], col.seiKana), meiKana: cell(v[i], col.meiKana)
      };
      r.name = (sei + (sei && mei ? ' ' : '') + mei).trim();
      var dk = mail || ('lid:' + r.lid) || ('row:' + i);   // メールの無い転入生は学習者IDで見分ける
      if (!mail && !r.lid) dk = 'row:' + i;
      if (seen[dk] === undefined) { seen[dk] = out.length; out.push(r); }
      else if (!out[seen[dk]].name && r.name) out[seen[dk]] = r;
    }
    return out;
  }

  /**
   * 名簿にあって名前のある児童。無ければ null。
   * 今年度の名簿で見つからない時は、保存分を使わずにハブの名簿を読み直す（転入生を足した日に6時間待たせない）。
   * 読み直しは10分に1回まで（名簿にない人が何度開いても、ハブを読みに行き続けない）。
   */
  function child(mail, year) {
    mail = String(mail || '').trim().toLowerCase();
    if (!mail) return null;
    var hit = find(roster(year), mail);
    if (hit || (year != null && year !== fy())) return hit;
    var c = CacheService.getScriptCache();
    if (c.get(PREFIX + 'roster-reload')) return null;
    c.put(PREFIX + 'roster-reload', '1', RELOAD_SEC);
    dropCache('roster:' + fy());
    return find(roster(), mail);
  }
  function find(rows, mail) {
    for (var i = 0; i < rows.length; i++) if (rows[i].mail && rows[i].mail === mail && rows[i].name) return rows[i];
    return null;
  }

  /** 学習者IDで児童を引く（メールの無い転入生も引ける）。名前の無い行・知らない ID は null */
  function learner(lid, year) {
    lid = String(lid || '').trim();
    if (!lid) return null;
    var rows = roster(year);
    for (var i = 0; i < rows.length; i++) if (rows[i].lid === lid && rows[i].name) return rows[i];
    return null;
  }

  /** 学級の児童（番号順）。教師が「だれが やる？」を選ぶ画面に使う */
  function members(grade, cls, year) {
    var g = Number(grade), c = normCls(cls);
    return roster(year).filter(function (r) { return r.grade === g && r.cls === c && r.name; })
      .sort(function (a, b) { return a.no - b.no || (a.name < b.name ? -1 : 1); });
  }

  /**
   * 教師が児童の代わりに取り組む（メールの無い転入生・端末の故障など）。
   * 開いた人が教師で、その児童の学級を見てよい時だけ、その児童を返す。記録には操作した教師も残す（by）。
   */
  function actAs(lid) {
    var m = me();
    if (m.role !== 'teacher') throw new Error('児童の代わりに取り組めるのは教師だけです');
    var r = learner(lid);
    if (!r) throw new Error('名簿にいない児童です: ' + lid);
    if (!canSeeClass(m.email, r.grade, r.cls)) throw new Error('担当していない学級の児童です');
    return { learner: r, by: m.email };
  }

  /** 学級のキー「学年-組」。全アプリでこの形に揃える */
  function classKey(grade, cls) { return Number(grade) + '-' + normCls(cls); }

  /** 組の表記ゆれ（「1組」「１」）を「1」に揃える。数字でない組（A・B）はそのまま */
  function normCls(x) {
    var s = String(x == null ? '' : x).trim()
      .replace(/[０-９]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) - 0xFEE0); })
      .replace(/組$/, '').trim();
    return /^\d+$/.test(s) ? String(Number(s)) : s;
  }

  /* ---------- 教師の担当 ---------- */

  /**
   * teachers シートの行を人ごとにまとめる。{ mail, sei, mei, seiKana, meiKana, scopes: [{grade, cls}] }
   * 組が空の行は、その学年の全学級（学年主任など）。学年も空なら全校。
   */
  function teachers() {
    var hit = cacheGet('teachers');
    if (hit) return hit;
    var s = hub().getSheetByName(SHEET.TEACHERS);
    var out = [];
    if (s) {
      var v = s.getDataRange().getValues();
      if (v.length) {
        var col = headerIndex(v[0], TEACHER_HEAD), by = {};
        if (col.mail < 0) throw new Error('teachers の見出しに「メール」がありません');
        for (var i = 1; i < v.length; i++) {
          var mail = cell(v[i], col.mail).toLowerCase();
          if (!mail || mail.indexOf('@') < 0) continue;
          var t = by[mail];
          if (!t) {
            t = by[mail] = { mail: mail, sei: cell(v[i], col.sei), mei: cell(v[i], col.mei),
              seiKana: cell(v[i], col.seiKana), meiKana: cell(v[i], col.meiKana), scopes: [] };
            out.push(t);
          }
          t.scopes.push({ grade: Number(cell(v[i], col.grade)) || 0, cls: normCls(cell(v[i], col.cls)) });
        }
      }
    }
    cachePut('teachers', out);
    return out;
  }

  function teacher(mail) {
    mail = String(mail || '').trim().toLowerCase();
    var list = teachers();
    for (var i = 0; i < list.length; i++) if (list[i].mail === mail) return list[i];
    return null;
  }

  /**
   * その教師がその学級を児童名つきで見てよいか。
   * - スプレッドシートの所有者：全学級
   * - 教師ドメインの人：全学級（決定 2026-11-05：今の算数TA と同じ。担当を書かなくても困らない）
   * - それ以外（支援員など別ドメイン）：teachers シートの担当だけ（学年0＝全校、組''＝その学年の全学級）
   * 担当で絞る運用に変える時は、STRICT_SCOPE を true にする（教師ドメインの人も担当だけになる）。
   */
  function canSeeClass(mail, grade, cls) {
    mail = String(mail || '').trim().toLowerCase();
    if (!mail) return false;
    if (isOwner(mail)) return true;
    if (!STRICT_SCOPE && isTeacherDomain(mail)) return true;
    var t = teacher(mail);
    if (!t) return false;
    var g = Number(grade), c = normCls(cls);
    for (var i = 0; i < t.scopes.length; i++) {
      var s = t.scopes[i];
      if (!s.grade) return true;
      if (s.grade === g && (!s.cls || s.cls === c)) return true;
    }
    return false;
  }

  var ownerMemo = null;
  /** BASEシートの所有者か（1回の実行で1回だけ調べる） */
  function isOwner(mail) {
    if (ownerMemo === null) { try { ownerMemo = String(hub().getOwner().getEmail() || '').toLowerCase(); } catch (e) { ownerMemo = ''; } }
    return !!ownerMemo && ownerMemo === mail;
  }

  /* ---------- 下請け ---------- */

  function headerIndex(head, spec) {
    var norm = head.map(function (h) { return String(h == null ? '' : h).trim().toLowerCase(); });
    var col = {};
    for (var k in spec) {
      col[k] = -1;
      for (var j = 0; j < spec[k].length && col[k] < 0; j++) col[k] = norm.indexOf(spec[k][j].toLowerCase());
    }
    return col;
  }
  function cell(row, i) { return i < 0 || row[i] == null ? '' : String(row[i]).trim(); }

  /** CacheService に分けて置く（1件100KBの上限を越える名簿のため） */
  function cachePut(key, obj) {
    var c = CacheService.getScriptCache(), s = JSON.stringify(obj), n = Math.ceil(s.length / CHUNK) || 1, m = {};
    for (var i = 0; i < n; i++) m[PREFIX + key + ':' + i] = s.slice(i * CHUNK, (i + 1) * CHUNK);
    m[PREFIX + key] = String(n);
    try { c.putAll(m, TTL); } catch (e) { /* 保存できなくても動く（毎回読むだけ） */ }
  }
  function cacheGet(key) {
    var c = CacheService.getScriptCache(), n = Number(c.get(PREFIX + key));
    if (!n) return null;
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(PREFIX + key + ':' + i);
    var got = c.getAll(keys), s = '';
    for (var j = 0; j < n; j++) { if (got[keys[j]] == null) return null; s += got[keys[j]]; }
    try { return JSON.parse(s); } catch (e) { return null; }
  }
  /** 名簿・担当を直した後に実行する（6時間待たずに反映させる） */
  function clearCache() {
    var c = CacheService.getScriptCache(), cur = fy(), keys = ['teachers'];
    for (var y = cur - 6; y <= cur; y++) keys.push('roster:' + y);
    keys.forEach(dropCache);
    c.remove(PREFIX + 'roster-reload');
  }
  function dropCache(k) {
    var c = CacheService.getScriptCache(), n = Number(c.get(PREFIX + k)) || 0, del = [PREFIX + k];
    for (var i = 0; i < n; i++) del.push(PREFIX + k + ':' + i);
    c.removeAll(del);
  }

  return {
    VER: VER, TEACHER_DOMAIN: TEACHER_DOMAIN, CHILD_DOMAIN: CHILD_DOMAIN,
    hub: hub, hubId: hubId, setHub: setHub, sheet: hub,   // sheet＝BASEシート（hub は前の名前。読み込み係・アプリが使うので残す）
    fy: fy, fyOf: fyOf,
    email: email, domainOf: domainOf, isTeacherDomain: isTeacherDomain, isChildDomain: isChildDomain, me: me,
    roster: roster, child: child, learner: learner, members: members, actAs: actAs, classKey: classKey, normCls: normCls,
    teachers: teachers, teacher: teacher, canSeeClass: canSeeClass,
    clearCache: clearCache,
    _readRoster: readRoster   // 検査用
  };
})();

/**
 * エディタから実行する関数は、名前が _ で終わらないので画面（google.script.run）からも呼べてしまう。
 * 所有者がエディタで実行した時だけ動かす（児童・他の教師がハブを付け替えられないように）。
 * 「自分として実行」のウェブアプリでは、開いた人（getActiveUser）と所有者（getEffectiveUser）が違う。
 */
function baseOwnerOnly_() {
  var a = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var e = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!a || a !== e) throw new Error('この関数は、スプレッドシートの所有者が Apps Script のエディタから実行してください');
}
/** エディタから実行：ハブを設定する（引数の代わりに下の行を書き換えて実行してもよい） */
function baseSetHub(urlOrId) { baseOwnerOnly_(); return Base.setHub(urlOrId); }
/** エディタから実行：名簿・担当の保存分を消す */
function baseClearCache() { baseOwnerOnly_(); Base.clearCache(); }

// ===== gas/Stores.gs =====
/**
 * Stores.gs — 教科の記録のスプレッドシートの台帳（LbStores）
 *
 * 正本は learning-base。BASEシートの app_sheets シートが、「どの教科・単元が、どのスプレッドシートに記録を貯めるか」を持つ。
 * 教科ごとに GAS は作らない。学習BASE の GAS 1つが、台帳の ID でそれぞれのスプレッドシートを開いて読み書きする
 * （スプレッドシートに GAS が付いている必要はない）。
 *
 *   app_sheets：アプリ | 単元 | スプレッドシート（URL） | 状態 | 作成
 *     - 単元：算数TA は単元の id（kuku など）。単元を持たない教科（国語など）は空
 *     - 状態：空＝使う。「止める」と書くと、その行は読まない（集計にも入らない）
 *     - 行が無い教科・単元は、アプリが頼んだ時に学習BASE がスプレッドシートを作り、BASEシートと同じフォルダに置いて行を足す
 *
 * 前の形（スクリプトのプロパティに ID を持っていた：算数TA の unit_sheet:<id>・漢字の森の KANZI_SS_ID）は、
 * 台帳に写す（syncLegacy。lbSetup と移転の時に1回だけ）。写した後もプロパティは消さない（前の版に戻した時のため）が、もう読まない。
 *   → 台帳の行を消す＝次にその教科・単元が使われた時に新しいスプレッドシートを作る／「止める」＝使わない
 *
 * 速さ：台帳は一時保存に10分置く（練習は1問ごとに呼ぶので、毎回シートを読まない）。手で直した時は lbReload で消える
 */
var LbStores = (function () {
  var SHEET = 'app_sheets', HEAD = ['アプリ', '単元', 'スプレッドシート', '状態', '作成'];
  var CACHE_KEY = 'lb:stores', TTL = 600, DONE_KEY = 'LB_STORES_LEGACY_DONE';
  /** 前の形のプロパティ → 台帳の行 */
  var LEGACY = [
    { re: /^unit_sheet:([a-z0-9_-]+)$/, app: 'tamath', unit: function (m) { return m[1]; } },
    { re: /^KANZI_SS_ID$/, app: 'kanzi', unit: function () { return ''; } }
  ];
  var memo = null;

  function idOf(v) {
    var s = String(v == null ? '' : v).trim(), m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(s);
    if (m) return m[1];
    return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
  }
  function urlOf(id) { return 'https://docs.google.com/spreadsheets/d/' + id + '/edit'; }
  function key(app, unit) { return String(app || '') + '|' + String(unit || ''); }

  /** 台帳の全行 [{ app, unit, id, on }] */
  function list() {
    if (memo) return memo;
    var c = CacheService.getScriptCache(), hit = null;
    try { hit = c.get(CACHE_KEY); } catch (e) {}
    if (hit) { try { return (memo = JSON.parse(hit)); } catch (e) {} }
    var out = LbSheets.rows(Base.hub(), SHEET, 4).map(function (r) {
      return { app: String(r[0] || '').trim(), unit: String(r[1] || '').trim(), id: idOf(r[2]), on: String(r[3] || '').trim() !== '止める' };
    }).filter(function (r) { return r.app; });
    try { c.put(CACHE_KEY, JSON.stringify(out), TTL); } catch (e) {}
    return (memo = out);
  }
  function forget() { memo = null; try { CacheService.getScriptCache().remove(CACHE_KEY); } catch (e) {} }
  function find(app, unit) {
    var k = key(app, unit), rows = list();
    for (var i = 0; i < rows.length; i++) if (key(rows[i].app, rows[i].unit) === k) return rows[i];
    return null;
  }

  /** 台帳に1行足す（同じアプリ・単元が既にあれば足さない）。返す：足したか */
  function add(app, unit, id, note) {
    var hub = Base.hub(), sh = LbSheets.sheet(hub, SHEET, HEAD, [1, 2, 5]);   // アプリ・単元・作成日は文字（単元名・日付が日付や数式に化けないように）
    forget();
    if (find(app, unit)) return false;
    sh.appendRow([app, unit || '', urlOf(id), '', note || LbSheets.day()]);
    forget();
    return true;
  }

  /**
   * その教科・単元の記録のスプレッドシートの ID。無ければ ''。
   *   opts.legacyProp：前の形のプロパティの名前（台帳に無くてプロパティにあれば、台帳に写して使う）
   *   opts.create   ：台帳にもプロパティにも無い時に作るスプレッドシートの名前（省略すると作らない）
   *   opts.peek     ：台帳に書かない（ホームを開くたびに呼ぶ所で使う）
   * 「止める」の行があれば ''（プロパティにあっても使わない：先生が止めたものを勝手に戻さない）
   */
  function id(app, unit, opts) {
    opts = opts || {};
    var r = find(app, unit);
    if (r) return r.on ? r.id : '';
    var props = PropertiesService.getScriptProperties();
    // 前の形のプロパティは、台帳へ写し終えるまでだけ読む（写した後に先生が消した行を、プロパティから勝手に戻さない）
    var legacy = opts.legacyProp && !props.getProperty(DONE_KEY) ? idOf(props.getProperty(opts.legacyProp)) : '';
    if (legacy) { if (!opts.peek) add(app, unit, legacy, '前の形から写した'); return legacy; }
    if (!opts.create || opts.peek) return '';
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      forget();
      r = find(app, unit);
      if (r) return r.on ? r.id : '';
      var ss = SpreadsheetApp.create(String(opts.create));
      besideBase(ss.getId());
      add(app, unit, ss.getId(), LbSheets.day());
      return ss.getId();
    } finally { lock.releaseLock(); }
  }
  function open(app, unit, opts) { var i = id(app, unit, opts); return i ? SpreadsheetApp.openById(i) : null; }
  /** そのアプリの使う行（止めたものを除く） */
  function ofApp(app) { return list().filter(function (r) { return r.app === app && r.on && r.id; }); }

  /** 作ったスプレッドシートを BASEシートと同じフォルダへ（動かせなければマイドライブのまま。権限は Loader の lbScopes_） */
  function besideBase(fileId) {
    try {
      var parents = DriveApp.getFileById(Base.hubId() || Base.hub().getId()).getParents();
      if (parents.hasNext()) DriveApp.getFileById(fileId).moveTo(parents.next());
    } catch (e) { console.error('記録のスプレッドシートを BASEシートのフォルダへ動かせません（マイドライブにあります）: ' + e.message); }
  }

  /**
   * 前の形のプロパティを台帳に写す（1回だけ。写し終えたら印 LB_STORES_LEGACY_DONE を置き、以後はプロパティを読まない）。
   * 返す：写した行の数
   */
  /** 台帳のシートを用意する（行が1つも無くても、見出しだけのシートを置く。先生が「どこに書くか」を探さずに済むように） */
  function ensure() { return LbSheets.sheet(Base.hub(), SHEET, HEAD, [1, 2, 5]); }
  function syncLegacy() {
    var P = PropertiesService.getScriptProperties();
    if (P.getProperty(DONE_KEY)) return 0;
    var props = P.getProperties(), n = 0;
    Object.keys(props).sort().forEach(function (k) {
      LEGACY.forEach(function (L) {
        var m = L.re.exec(k), sid = m && idOf(props[k]);
        if (sid && add(L.app, L.unit(m), sid, '前の形から写した')) n++;
      });
    });
    P.setProperty(DONE_KEY, LbSheets.day());
    return n;
  }

  return { SHEET: SHEET, HEAD: HEAD, LEGACY: LEGACY, list: list, find: find, id: id, open: open, ofApp: ofApp, add: add,
    syncLegacy: syncLegacy, ensure: ensure, forget: forget, idOf: idOf, urlOf: urlOf };
})();

// ===== gas/Move.gs =====
/**
 * Move.gs — 学習BASE を新しい BASEシートへ移す（LbMove。決定 2026-11-23：算数TA のハブを本体にせず、BASEシートを本体にする）
 *
 * 正本は learning-base。手順は README「BASEシートへの移転」。
 *   1. 旧GAS（今の学習BASE）で lbMoveOut(新しいBASEシートのURL) … out()
 *        - 学習BASE のシートだけを新しいシートへ写す（算数TA の名残り＝links などは写さない。links の開く先は pages に移す）
 *        - 前の形のプロパティを台帳 app_sheets に写してから写す（教科の記録のスプレッドシートの紐付け）
 *        - スクリプトのプロパティを、新しいシートの _移転 シートに一時的に置く（新しい GAS が読んだら消す）
 *        - 旧ハブの platform シートに「移転先シート」を書き、旧GAS の自動実行を消す
 *   2. 新しいBASEシートに付けた GAS で lbSetup … take()（_移転 を読んでプロパティに入れ、シートを消す）
 *   3. デプロイ後にもう一度 lbSetup … pointOld()（旧ハブの platform に「移転先URL」を書く。旧URL を開いた人に新しい URL を見せる）
 * 旧GAS は、platform に「移転先シート」がある間は夜の処理をせず、開いた人に移転を知らせる（moved()）
 */
var LbMove = (function () {
  var KEEP = ['roster', 'teachers', 'pages', 'class_pages', 'now_learning', 'class_order', 'class_colors', 'catalog', 'facts_cursor',
    'now3', 'now3_log', 'decisions', 'rules', 'directives', 'usage', 'feedback', 'platform', 'app_sheets'];
  var KEEP_RE = /^(roster|teachers|facts|pseudo)_\d{4}$/;
  var TAKE = '_移転';
  var SKIP_PROPS = { HUB_ID: 1, LB_MOVED_FROM: 1 };
  var MOVED_KEY = 'lb:moved';

  function keepSheet(name) { return KEEP.indexOf(name) >= 0 || KEEP_RE.test(name); }

  /** platform シートの値（A列＝名前、B列＝値）。無ければ '' */
  function platformGet(ss, k) {
    var sh = ss.getSheetByName('platform');
    if (!sh || !sh.getLastRow()) return '';
    var v = sh.getDataRange().getValues();
    for (var i = 0; i < v.length; i++) if (String(v[i][0]).trim() === k) return String(v[i][1] == null ? '' : v[i][1]).trim();
    return '';
  }
  function platformSet(ss, k, val) {
    var sh = ss.getSheetByName('platform') || ss.insertSheet('platform');
    var n = sh.getLastRow(), v = n ? sh.getRange(1, 1, n, 1).getValues() : [];
    for (var i = 0; i < v.length; i++) if (String(v[i][0]).trim() === k) { sh.getRange(i + 1, 2).setValue(val); return; }
    sh.getRange(n + 1, 1, 1, 2).setValues([[k, val]]);
  }

  /** 1. 旧GAS で実行。返す：報告の文 */
  function out(urlOrId) {
    var dstId = LbStores.idOf(urlOrId);
    if (!dstId) throw new Error('新しいBASEシートの URL か ID を入れてください: ' + urlOrId);
    var src = Base.hub();
    if (src.getId() === dstId) throw new Error('今のハブと同じスプレッドシートです。新しく作ったスプレッドシートの URL を入れてください');
    var dst = SpreadsheetApp.openById(dstId);
    if (dst.getSheetByName(TAKE)) throw new Error('新しいシートに ' + TAKE + ' が残っています（前の移転の途中）。新しいシートの GAS で lbSetup を実行してから、もう一度');
    var msg = [];

    // 教科の記録の紐付けを台帳に（前の形のプロパティから）
    LbStores.ensure();   // 紐付けが0件でも台帳のシートを写す
    msg.push('台帳 app_sheets に写した紐付け：' + LbStores.syncLegacy() + ' 件');

    // 学習BASE のシートを写す。同じ名前のシートが新しい側にあれば写さない（上書きしない）
    var copied = [], skipped = [], left = [];
    src.getSheets().forEach(function (sh) {
      var name = sh.getName();
      if (!keepSheet(name)) { left.push(name); return; }
      if (dst.getSheetByName(name)) { skipped.push(name); return; }
      sh.copyTo(dst).setName(name);
      copied.push(name);
    });
    msg.push('写したシート：' + (copied.join('・') || 'なし'));
    if (skipped.length) msg.push('新しい側に既にあるので写さなかった：' + skipped.join('・'));
    if (left.length) msg.push('写さなかった（学習BASE のものでない）：' + left.join('・'));
    formulaWarnings(src, copied, left).forEach(function (w) { msg.push('【要確認】' + w); });

    // links（算数TA の開く先）のうち pages に無いものを pages へ
    msg.push('links から pages に移した開く先：' + linksToPages(src, dst) + ' 件');

    // 新しいスプレッドシートが最初から持つ空のシートを消す
    dst.getSheets().forEach(function (sh) {
      if (dst.getSheets().length > 1 && !keepSheet(sh.getName()) && sh.getName() !== TAKE && sh.getLastRow() === 0) dst.deleteSheet(sh);
    });

    // スクリプトのプロパティ（算数TA の学級の設定・署名の鍵など）を、新しい GAS に渡す。値の頭に # を付ける（数式にしない）
    var props = PropertiesService.getScriptProperties().getProperties(), rows = [['#from', '#' + src.getId()]];
    Object.keys(props).sort().forEach(function (k) { if (!SKIP_PROPS[k]) rows.push(['#' + k, '#' + props[k]]); });
    var t = dst.insertSheet(TAKE);
    t.getRange(1, 1, rows.length, 2).setNumberFormat('@').setValues(rows);
    msg.push('新しい GAS に渡すプロパティ：' + (rows.length - 1) + ' 件（新しいシートの GAS で lbSetup を実行すると取り込まれ、' + TAKE + ' シートは消えます）');

    // 旧ハブに移転先を書き、旧GAS の自動実行を止める
    platformSet(src, '移転先シート', dstId);
    try { CacheService.getScriptCache().removeAll([MOVED_KEY, 'lb:ver']); } catch (e) {}
    var n = 0;
    ScriptApp.getProjectTriggers().forEach(function (tr) { ScriptApp.deleteTrigger(tr); n++; });
    msg.push('旧GAS の自動実行を止めた：' + n + ' 件');

    // 共有は写らない（新しいシートは所有者だけ）。旧ハブを編集できた人を知らせる（共有するかは所有者が決める）
    try {
      var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
      var eds = src.getEditors().map(function (u) { return String(u.getEmail() || '').toLowerCase(); }).filter(function (m) { return m && m !== me; });
      msg.push(eds.length ? '【要確認】旧ハブを編集できた人（新しいシートには共有していません。名簿を直してもらうなら共有する）：' + eds.join('・') : '旧ハブを編集できた人：所有者だけ');
    } catch (e) { msg.push('旧ハブの共有を調べられません: ' + e.message); }
    return msg.join('\n');
  }

  /**
   * 写したシートの数式のうち、新しいシートでそのままでは動かないもの。
   * - 他のファイルを読む数式（IMPORTRANGE など）：新しいシートでは「アクセスを許可」を押すまで #REF!（名簿なら全員が「名簿にない人」になる）
   * - 写さなかったシートを指す数式：#REF! になる
   */
  function formulaWarnings(src, copied, left) {
    var out = [];
    copied.forEach(function (name) {
      var sh = src.getSheetByName(name), f = [];
      try { f = [].concat.apply([], sh.getDataRange().getFormulas()).filter(function (x) { return x; }); } catch (e) { return; }
      if (!f.length) return;
      if (f.some(function (x) { return /\bIMPORT(RANGE|DATA|XML|HTML|FEED)\s*\(/i.test(x); })) out.push(name + ' に他のファイルを読む数式があります。新しいシートでそのシートを開き、セルの「アクセスを許可」を押してください');
      var bad = left.filter(function (l) { return f.some(function (x) { return x.indexOf(l + '!') >= 0 || x.indexOf("'" + l + "'!") >= 0; }); });
      if (bad.length) out.push(name + ' に、写さなかったシート（' + bad.join('・') + '）を指す数式があります。新しいシートでは #REF! になるので、値に直してください');
    });
    return out;
  }

  function linksToPages(src, dst) {
    var lk = src.getSheetByName('links');
    if (!lk || lk.getLastRow() < 2) return 0;
    var sh = LbSheets.sheet(dst, 'pages', ['キー', 'URL', '色', '補足', '更新'], [1, 2]);
    var have = {};
    LbSheets.rows(dst, 'pages', 1).forEach(function (r) { have[String(r[0] || '').trim()] = 1; });
    var add = [];
    lk.getRange(2, 1, lk.getLastRow() - 1, 6).getValues().forEach(function (r) {
      var id = String(r[0] || '').trim();
      if (!id || have[id]) return;
      have[id] = 1;
      add.push([id, String(r[3] || '').trim(), String(r[5] || '').trim(), String(r[2] || '').trim(), new Date()]);
    });
    if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 5).setValues(add);
    return add.length;
  }

  /** 2. 新しい GAS の lbSetup から。_移転 シートがあればプロパティに入れて消す。返す：報告の文（何も無ければ ''） */
  function take() {
    var ss = Base.hub(), t = ss.getSheetByName(TAKE);
    if (!t) return '';
    var props = PropertiesService.getScriptProperties(), have = props.getProperties(), put = {}, n = 0, kept = 0, from = '';
    t.getDataRange().getValues().forEach(function (r) {
      var k = String(r[0]).replace(/^#/, ''), v = String(r[1]).replace(/^#/, '');
      if (!k) return;
      if (k === 'from') { from = v; return; }
      if (SKIP_PROPS[k]) return;
      if (have[k] != null && have[k] !== '') { kept++; return; }   // 新しい側で既に入れたものは残す
      put[k] = v; n++;
    });
    if (from) put.LB_MOVED_FROM = from;
    props.setProperties(put, false);
    ss.deleteSheet(t);
    return '旧GAS のプロパティを取り込んだ：' + n + ' 件' + (kept ? '（新しい側に既にあったので残した：' + kept + ' 件）' : '');
  }

  /** 3. 新しい GAS の lbSetup から（デプロイ後）。旧ハブに移転先の URL を書く */
  function pointOld() {
    var from = String(PropertiesService.getScriptProperties().getProperty('LB_MOVED_FROM') || '');
    if (!from) return '';
    var url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
    if (!url) return '旧URL の案内：まだ（デプロイしてから、もう一度 lbSetup を実行すると、旧URL を開いた人に新しい URL が出ます）';
    try {
      var old = SpreadsheetApp.openById(from);
      if (platformGet(old, '移転先URL') === url) return '旧URL の案内：済み';
      platformSet(old, '移転先URL', url);
      return '旧URL の案内：旧ハブに新しい URL を書いた（旧URL を開くと新しい URL が出ます）';
    } catch (e) { return '旧URL の案内：× 旧ハブを開けません（' + e.message + '）'; }
  }

  /**
   * 旧GAS か（このハブの platform に「移転先シート」がある）。{ to, url } か null。5分覚える
   * （夜の処理・ホームを開くたびに呼ぶので、毎回シートを読まない）
   */
  function moved() {
    // 新しい読み込み係は、版と一緒に platform シートを読んでいる（一時保存への往復を増やさない）
    if (typeof LB_LOADER !== 'undefined' && typeof LB_LOADER.moved === 'function') return LB_LOADER.moved();
    var c = CacheService.getScriptCache(), hit = null;
    try { hit = c.get(MOVED_KEY); } catch (e) {}
    if (hit != null) return hit !== '0' ? JSON.parse(hit) : null;
    var out = null;
    try {
      var ss = Base.hub(), to = platformGet(ss, '移転先シート');
      if (to && to !== ss.getId()) out = { to: to, url: platformGet(ss, '移転先URL') };
    } catch (e) { return null; }
    try { c.put(MOVED_KEY, out ? JSON.stringify(out) : '0', 300); } catch (e) {}
    return out;
  }

  return { KEEP: KEEP, keepSheet: keepSheet, out: out, take: take, pointOld: pointOld, moved: moved, TAKE: TAKE };
})();

// ===== gas/Pseudo.gs =====
/**
 * Pseudo.gs — 名前を記号に置き換える（Gemini・NotebookLM に渡す前）
 *
 * 正本は learning-base。設計：`-` リポジトリ principles/learning-app-foundation.md §8
 * 画面も保存も持たない（純粋な計算だけ）。確認画面と書き出しはハブが持つ。
 *
 *   var t = LbPseudo.table(people, { existing: 保存した記号表 });   // 初めては existing なし
 *   var r = LbPseudo.replace(text, t);   // { text, hits, skipped1, warn }
 *   LbPseudo.restore(r.text, t);          // 記号を名前に戻す（1人に決まる記号だけ）
 *
 * people: [{ id, sei, mei, seiKana, meiKana }]（id は学習者ID。教師はメール。児童も教師も入れる）
 *
 * 規則（決定 2026-11）
 * - 1人につき 姓・名・姓名 × 漢字／ひらがな／カタカナ（姓名は空白あり・なし）。あだ名は対象外
 * - 照合の前に揃える：NFKC（全角半角）・異体字（髙→高 など）・カタカナ→ひらがな
 * - 長い表記から先に。重ならないように左から
 * - 姓だけ・名だけの表記が複数の人に当たる時は、誰か1人の記号にせず共通の記号〔共n〕にする
 * - 1文字の姓・名は単独では置き換えない。直後に敬称（さん・くん・ちゃん・君・先生・せんせい）がある時だけ置き換える。
 *   置き換えなかった箇所は skipped1 に返す（教師が目で確かめる）
 * - 敬称は残す（はなこさん → 〔z8〕さん）
 * - 2文字以下のひらがなの名（まい・ゆう）は一般語の中で多く当たるので warn に件数を返す
 */
var LbPseudo = (function () {
  var OPEN = '〔', CLOSE = '〕';
  var HONORIFIC = ['さん', 'くん', 'ちゃん', '君', '先生', 'せんせい', 'さま', '様'];
  // 名前に使われる主な異体字 → 通用字体（照合の時だけ使う。元の文は変えない）
  var ITAIJI = {
    '髙': '高', '﨑': '崎', '嵜': '崎', '碕': '崎', '邉': '辺', '邊': '辺', '濵': '浜', '濱': '浜',
    '齋': '斎', '齊': '斉', '斎': '斎', '澤': '沢', '櫻': '桜', '廣': '広', '國': '国', '眞': '真',
    '藪': '薮', '槇': '槙', '德': '徳', '惠': '恵', '曻': '昇', '瀨': '瀬', '冨': '富', '桒': '桑',
    '鄕': '郷', '條': '条', '圓': '円', '龍': '竜', '彌': '弥', '壽': '寿', '實': '実', '淸': '清', '靜': '静'
  };
  // 記号に使う文字（紛らわしい 0 O o 1 l I i を除く）
  var LETTERS = 'abcdefghjkmnpqrstuvwxyz'.split('');
  var DIGITS = '23456789'.split('');

  /* ---------- 文字を揃える ---------- */

  function normChar(c) {
    var s = c.normalize ? c.normalize('NFKC') : c;
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      ch = ITAIJI[ch] || ch;
      var code = ch.charCodeAt(0);
      if (code >= 0x30A1 && code <= 0x30F6) ch = String.fromCharCode(code - 0x60);   // カタカナ → ひらがな
      out += ch;
    }
    return out;
  }
  /** 揃えた文字列と、揃えた後の各文字が元の何文字目から来たかの対応 */
  function normalize(text) {
    var out = '', map = [];
    var chars = Array.from(String(text == null ? '' : text));
    var pos = 0;
    for (var i = 0; i < chars.length; i++) {
      var n = normChar(chars[i]);
      for (var j = 0; j < n.length; j++) { out += n.charAt(j); map.push(pos); }
      pos += chars[i].length;
    }
    map.push(pos);   // 末尾
    return { text: out, map: map };
  }
  function normName(s) { return normalize(String(s || '').replace(/[\s　]+/g, '')).text; }

  /* ---------- 記号表 ---------- */

  function pool(len) {
    var p = [];
    if (len === 2) LETTERS.forEach(function (l) { DIGITS.forEach(function (d) { p.push(l + d); }); });
    else LETTERS.forEach(function (l) { DIGITS.forEach(function (d) { LETTERS.forEach(function (l2) { p.push(l + d + l2); }); }); });
    return p;
  }
  /** 0 以上 1 未満の乱数。GAS では UUID（暗号論的な乱数）から作る */
  function defaultRandom() {
    if (typeof Utilities !== 'undefined' && Utilities.getUuid) {
      var hex = Utilities.getUuid().replace(/-/g, '');
      return parseInt(hex.slice(0, 12), 16) / 281474976710656;
    }
    return Math.random();
  }

  /**
   * 記号表を作る。
   * - 記号は乱数で振る。名前・年齢・メール・ID・出席番号など、外の人が知りうる情報からは導けない
   *   （計算で求める方式にしない。種を知られても、ID と記号の対応を再現できない）
   * - そのため記号表は保存して使い続ける：opts.existing（{ id: 記号 }、ハブに保存した今年度の記号表）を渡すと、
   *   その記号をそのまま使い、まだ記号の無い人（転入生）にだけ空いている記号を振る
   * - id は学習者ID（メールではない。メールの無い転入生にも付き、後でメールが付いても変わらない）
   * - 記号の長さ：人数が 90 人以下なら2文字（z8）、それより多ければ3文字（k3m）。existing があればその長さ
   * 返す：{ people: [{ id, code, name }], variants, codeOf: {id: code}, byCode: {code: name} }
   */
  function table(people, opts) {
    opts = opts || {};
    var random = opts.random || defaultRandom;
    var list = (people || []).filter(function (p) { return p && p.id; });
    var existing = opts.existing || {};
    var exCodes = Object.keys(existing).map(function (k) { return existing[k]; });
    var len = exCodes.length ? exCodes[0].length : (list.length <= 90 ? 2 : 3);
    var P = pool(len);
    if (list.length > P.length * 0.9) { len = 3; P = pool(3); }
    var used = {}, codeOf = {};
    list.forEach(function (p) { if (existing[p.id]) { codeOf[p.id] = existing[p.id]; used[existing[p.id]] = true; } });
    var free = P.filter(function (c) { return !used[c]; });
    list.forEach(function (p) {
      if (codeOf[p.id]) return;
      if (!free.length) throw new Error('記号が足りません');
      var k = Math.floor(random() * free.length);
      codeOf[p.id] = free[k];
      free.splice(k, 1);
    });
    var byCode = {}, out = [];
    list.forEach(function (p) {
      var name = [p.sei, p.mei].filter(Boolean).join(' ');
      byCode[codeOf[p.id]] = name;
      out.push({ id: p.id, code: codeOf[p.id], name: name });
    });

    // 表記 → その表記を持つ人
    var vmap = {};
    function add(raw, id, part) {
      var key = normName(raw);
      if (!key) return;
      var v = vmap[key] || (vmap[key] = { key: key, len: key.length, ids: {}, part: part });
      v.ids[id] = true;
      if (part === 'full') v.part = 'full';
    }
    list.forEach(function (p) {
      var sei = String(p.sei || ''), mei = String(p.mei || ''), sk = String(p.seiKana || ''), mk = String(p.meiKana || '');
      if (sei) add(sei, p.id, 'sei');
      if (mei) add(mei, p.id, 'mei');
      if (sei && mei) add(sei + mei, p.id, 'full');
      if (sk) add(sk, p.id, 'sei');
      if (mk) add(mk, p.id, 'mei');
      if (sk && mk) add(sk + mk, p.id, 'full');
      if (sei && mk) add(sei + mk, p.id, 'full');   // 「田中はなこ」のような混ぜ書き
      if (sk && mei) add(sk + mei, p.id, 'full');
    });
    var variants = Object.keys(vmap).map(function (k) {
      var v = vmap[k];
      return { key: v.key, len: v.len, ids: Object.keys(v.ids), part: v.part };
    }).sort(function (a, b) { return b.len - a.len || (a.key < b.key ? -1 : 1); });

    // 複数の人に当たる表記に共通の記号を振る（表の中で安定した番号）
    var shared = 0;
    variants.forEach(function (v) {
      if (v.ids.length > 1) { shared++; v.code = '共' + shared; }
      else v.code = codeOf[v.ids[0]];
    });
    return { people: out, variants: variants, codeOf: codeOf, byCode: byCode };
  }

  /* ---------- 置き換え ---------- */

  function isHira(s) { return /^[ぁ-ゖー]+$/.test(s); }

  /**
   * 文の中の名前を記号に置き換える。
   * 返す：{ text, hits: [{ from, to, code, start, end }], skipped1: [{ name, start, end }], warn: [{ name, count }] }
   * start / end は元の文での位置（UTF-16 の添字）。確認画面で色を付けるのに使う。
   */
  function replace(text, tbl) {
    text = String(text == null ? '' : text);
    var nz = normalize(text), s = nz.text;
    // 先頭の文字 → その文字で始まる表記（長い順）
    var byFirst = {};
    tbl.variants.forEach(function (v) { (byFirst[v.key.charAt(0)] = byFirst[v.key.charAt(0)] || []).push(v); });
    // 空白をはさんだ姓名（「田中 はなこ」）も1つの表記として当てる
    function matchAt(i, v) {
      var k = 0, j = i;
      while (k < v.key.length && j < s.length) {
        if (s.charAt(j) === v.key.charAt(k)) { j++; k++; continue; }
        if (v.part === 'full' && k > 0 && /[\s]/.test(s.charAt(j))) { j++; continue; }
        return -1;
      }
      return k === v.key.length ? j : -1;
    }
    function honorificAt(j) {
      for (var h = 0; h < HONORIFIC.length; h++) if (s.substr(j, HONORIFIC[h].length) === normName(HONORIFIC[h])) return true;
      return false;
    }
    var hits = [], skipped1 = [], warnCount = {};
    var i = 0;
    while (i < s.length) {
      var cands = byFirst[s.charAt(i)], done = false;
      if (cands) {
        for (var c = 0; c < cands.length; c++) {
          var v = cands[c], end = matchAt(i, v);
          if (end < 0) continue;
          if (v.len === 1 && v.part !== 'full') {
            if (!honorificAt(end)) { skipped1.push({ name: text.slice(nz.map[i], nz.map[end]), start: nz.map[i], end: nz.map[end] }); continue; }
          }
          if (v.part !== 'full' && v.len <= 2 && isHira(v.key)) warnCount[v.key] = (warnCount[v.key] || 0) + 1;
          hits.push({ from: text.slice(nz.map[i], nz.map[end]), to: OPEN + v.code + CLOSE, code: v.code, start: nz.map[i], end: nz.map[end] });
          i = end; done = true; break;
        }
      }
      if (!done) i++;
    }
    // 後ろから置き換える（位置がずれないように）
    var out = text;
    for (var h = hits.length - 1; h >= 0; h--) out = out.slice(0, hits[h].start) + hits[h].to + out.slice(hits[h].end);
    var warn = Object.keys(warnCount).map(function (k) { return { name: k, count: warnCount[k] }; });
    return { text: out, hits: hits, skipped1: skipped1, warn: warn };
  }

  /** 名簿の中で、照合の前に件数を見せるべき名（2文字以下のひらがなの姓・名） */
  function riskyNames(tbl) {
    return tbl.variants.filter(function (v) { return v.part !== 'full' && v.len <= 2 && isHira(v.key); }).map(function (v) { return v.key; });
  }

  /** 記号を名前に戻す。共通の記号〔共n〕は戻さない（誰か1人に決まらないため） */
  function restore(text, tbl) {
    return String(text == null ? '' : text).replace(/〔([a-z0-9]{2,3})〕/g, function (m, code) {
      return Object.prototype.hasOwnProperty.call(tbl.byCode, code) ? tbl.byCode[code] : m;
    });
  }

  return { table: table, replace: replace, restore: restore, riskyNames: riskyNames, _normalize: normalize };
})();

// ===== gas/Catalog.gs =====
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

// ===== gas/LbSession.gs =====
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

// ===== gas/Facts.gs =====
/**
 * Facts.gs — 全アプリのセッションを「児童 × 技能 × 週」に集計する（計算の方法はここに1つだけ）
 *
 * 正本は learning-base。アプリは集計の計算を書かない。セッションを書けば、ここが毎晩まとめる。
 *
 * 集計の行（ハブの facts_<年度>）：
 *   週（月曜の日付）| 学習者ID | 学年 | 組 | 番号 | アプリ | 技能 | 件数 | 正答 | 時間のある件数 | 対数時間の和 | 二乗和 | 誤答の型 | セッション数
 * 状態（未着手・練習中・到達）は、目録の基準で、直近の数週をまとめて判定する（state）。
 */
var LbFacts = (function () {
  var HEAD = ['week', 'lid', 'grade', 'cls', 'no', 'app', 'skill', 'n', 'ok', 'tn', 'sl', 'sl2', 'mis', 'sess'];
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

  function key(week, lid, app, skill) { return week + '|' + lid + '|' + app + '|' + skill; }
  function blank(week, s, app, skill) {
    return { week: week, lid: s.lid, grade: s.grade, cls: s.cls, no: s.no, app: app, skill: skill, n: 0, ok: 0, tn: 0, sl: 0, sl2: 0, mis: {}, sess: 0 };
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
    if (!week || !s.lid) return acc;            // 学習者IDの無い行（おためしを書いた行）は集計しない
    for (var skill in (s.skills || {})) {
      var k = key(week, s.lid, s.app, skill);
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
      return [f.week, f.lid, f.grade, f.cls, f.no, f.app, f.skill, f.n, f.ok, f.tn, f.sl, f.sl2, JSON.stringify(f.mis), f.sess];
    });
  }
  function fromRows(rows) {
    var acc = {};
    rows.forEach(function (r) {
      if (!r[0] || !r[1]) return;
      var week = r[0] instanceof Date ? weekOf(r[0]) : String(r[0]);
      var mis = {}; try { mis = JSON.parse(String(r[12] || '{}')); } catch (e) {}
      acc[key(week, r[1], r[5], r[6])] = { week: week, lid: String(r[1]), grade: Number(r[2]) || 0, cls: String(r[3]), no: Number(r[4]) || 0,
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
  function recent(acc, lid, app, skill, endWeek, weeks) {
    var from = addWeeks(endWeek, -(weeks - 1)), out = [];
    for (var k in acc) {
      var f = acc[k];
      if (f.lid === lid && f.app === app && f.skill === skill && f.week >= from && f.week <= endWeek) out.push(f);
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
   * sources: [{ app, key, ss }]（アプリの id・記録先の名前・記録のスプレッドシート）。hubSs：ハブ。
   *   key は読んだ位置を覚える名前（省略時は app）。同じアプリが記録先を複数持つ時（算数TA は単元ごと）は別の key にする
   * 練習（context が practice）の行は集計に入れない（opts.contexts で集計に入れる文脈を変えられる）
   * 読んだ位置（facts_cursor）を覚えるので、同じセッションを2回足さない。
   * 4分を越えたら途中でやめ、続きは次の実行で読む。返す：{ read, more }
   * 集計を書いた後・位置を書く前に止まると二重に足しうる。その時は rebuild で作り直す。
   */
  function ingest(hubSs, sources, opts) {
    opts = opts || {};
    var fy = opts.fy || Base.fyOf(new Date()), start = Date.now(), budget = opts.budgetMs || BUDGET_MS;
    var cur = readCursor(hubSs), add = {}, read = 0, more = false, touched = {};
    var skipCtx = opts.excludeContexts || ['practice'];
    sources.forEach(function (src) {
      LbSession.sheetNames(src.ss, fy).forEach(function (name) {
        if (more) return;
        var sh = src.ss.getSheetByName(name), last = sh.getLastRow(), ck = (src.key || src.app) + '|' + name;
        var from = Math.max(2, (cur[ck] || 1) + 1);
        while (from <= last) {
          if (Date.now() - start > budget) { more = true; break; }
          var n = Math.min(BATCH, last - from + 1);
          var nh = LbSession.COL.items;                                              // 問題の欄は読まない
          var head = sh.getRange(from, 1, n, nh).getValues();
          var sk = sh.getRange(from, LbSession.COL.skills + 1, n, 1).getValues();
          for (var i = 0; i < n; i++) {
            var s = LbSession.fromRow(head[i].concat(['', sk[i][0], '']));
            if (s.lid && skipCtx.indexOf(s.context) < 0) addSession(add, s);
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
    sources.forEach(function (src) { LbSession.sheetNames(src.ss, fy).forEach(function (n) { delete cur[(src.key || src.app) + '|' + n]; }); });
    writeCursor(hubSs, cur, true);
    return ingest(hubSs, sources, opts);
  }

  /**
   * セッションの形（{ ts, lid, grade, cls, no, app, context, skills }）の配列を集計に足す。
   * 過去の記録（アプリの log など、新しい形の記録が無い頃の分）の取り込みに使う。練習（practice）は足さない
   */
  function mergeSessions(hubSs, fy, sessions) {
    var add = {};
    (sessions || []).forEach(function (s) { if (s.lid && s.context !== 'practice' && Base.fyOf(s.ts) === fy) addSession(add, s); });
    if (!Object.keys(add).length) return 0;
    var name = 'facts_' + fy, sh = hubSs.getSheetByName(name) || hubSs.insertSheet(name);
    var old = sh.getLastRow() > 1 ? fromRows(sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.length).getValues()) : {};
    writeFacts(sh, merge(old, add));
    return Object.keys(add).length;
  }
  /** 読んだ位置の表に「済み」の印を置く・見る（過去の記録を1回だけ取り込むため） */
  function marked(hubSs, key) { return !!readCursor(hubSs)[key]; }
  function mark(hubSs, key) { var c = readCursor(hubSs); c[key] = 1; writeCursor(hubSs, c); }
  /** その記録先の最初の新しい形の記録の時刻（無ければ null）。過去の記録はこれより前だけを取り込む */
  function firstSessionTs(ss, fy) {
    var names = LbSession.sheetNames(ss, fy);
    for (var i = 0; i < names.length; i++) {
      var sh = ss.getSheetByName(names[i]);
      if (sh && sh.getLastRow() >= 2) return sh.getRange(2, 1, 1, 1).getValues()[0][0];
    }
    return null;
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
    // 週（'2026-11-09'）が日付に化けないよう、1列目を文字の書式にする
    sh.getRange(1, 1, Math.max(rows.length + 1, sh.getMaxRows ? sh.getMaxRows() : 1000), 1).setNumberFormat('@');
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
    combine: combine, stats: stats, recent: recent, state: state, ingest: ingest, rebuild: rebuild, read: read,
    mergeSessions: mergeSessions, marked: marked, mark: mark, firstSessionTs: firstSessionTs };
})();

// ===== gas/Alerts.gs =====
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

// ===== gas/Directives.gs =====
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

// ===== gas/Telemetry.gs =====
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

// ===== gas/Tuning.gs =====
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

// ===== gas/Export.gs =====
/**
 * Export.gs — 先生の気づきと「失敗と速さ」の書き出し（LbExport）
 *
 * 正本は learning-base。所有者がコピーして Claude（私用 PC）に渡す。渡すのは学習BASE の使い勝手・機能性だけで、児童の学習状態は入れない。
 * 児童の名前・メール・学習者ID を書かない：気づきの名前は記号に置き換え（記号表はハブの pseudo_<年度> にだけある）、
 * 全文にも置き換えをかけ、最後に機械で確かめ、残っていれば文を返さない。先生のメールは「先生n」、学級は学年だけ。
 */
var LbExport = (function () {
  var FB = 'feedback', FB_HEAD = ['日時', '教師', '学級', '画面', '本文'];
  var CODE_HEAD = ['学習者ID・メール', '記号'];
  var day = LbSheets.day, sheet = LbSheets.sheet, usage = LbTelemetry.usage, cleanName = LbTelemetry.cleanName;

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
  return { saveFeedback: saveFeedback, readFeedback: readFeedback, codes: codes, guard: guard, exportText: exportText };
})();

// ===== gas/Pages.gs =====
/**
 * Pages.gs — 学習BASE の入口（学習BASE → 教科 → ページ）と「いまの学習」
 *
 * 正本は learning-base。設計：`-` リポジトリ principles/learning-app-foundation.md §14「入口の階層」
 *
 * - ページの目録（catalog/pages.json）はリポジトリに置く。Claude が足す。教師はスプレッドシートで目録を作らない
 * - 教師が決めるのは学級ごとの「公開」と「いまの学習」だけ（ハブのシートに保存）
 * - 目録は公開のリポジトリにあり、児童名を含まない。画面（ブラウザ）が jsDelivr から直接読む
 * - このファイルは画面でも使う（web/pages.js は tools/build.cjs が作るこのファイルの写し）。
 *   判定の部分（validate・isOn・inPeriod・home・teacherView）は GAS の機能を使わずに書く（ブラウザでも動くように）
 *
 * 目録の形：
 * { version: 1, pages: [
 *   { id: 'tamath-kuku', subject: 'sansu', grades: [3], unit: 'かけ算', title: '九九 タイムアタック', ruby: 'くく タイムアタック',
 *     kind: 'app', app: 'tamath', params: { unit: 'kuku' }, order: 10, defaultOn: true },
 *   { id: 'sakubun-1', subject: 'kokugo', grades: [3, 4], unit: '作文', title: '…', kind: 'page',
 *     src: { repo: 'sankisuguya-create/worksheet-platform', path: 'pages/sakubun-1.js', ver: '<コミット>' } },
 *   { id: 'toi-board', subject: 'sogo', grades: [3], title: 'といボード', kind: 'link', linkId: 'toi-board' }
 *     … 別の GAS で動くもの。開く先の URL は公開の目録に書かず、学習BASE のデータの pages シート（キー＝linkId）の URL を使う
 * ] }
 */
var LbPages = (function () {
  /** 教科（並び順もこの順）。色では見分けない（教科は10以上あり、色で区別できるのは4つまで）。絵と名前で見分ける */
  var SUBJECTS = [
    { id: 'kokugo', label: '国語', ruby: 'こくご', low: 'こくご' },
    { id: 'shakai', label: '社会', ruby: 'しゃかい', low: 'しゃかい' },
    { id: 'sansu', label: '算数', ruby: 'さんすう', low: 'さんすう' },
    { id: 'rika', label: '理科', ruby: 'りか', low: 'りか' },
    { id: 'seikatsu', label: '生活', ruby: 'せいかつ', low: 'せいかつ' },
    { id: 'ongaku', label: '音楽', ruby: 'おんがく', low: 'おんがく' },
    { id: 'zuko', label: '図工', ruby: 'ずこう', low: 'ずこう' },
    { id: 'katei', label: '家庭', ruby: 'かてい', low: 'かてい' },
    { id: 'taiiku', label: '体育', ruby: 'たいいく', low: 'たいいく' },
    { id: 'gaikokugo', label: '外国語', ruby: 'がいこくご', low: 'えいご' },
    { id: 'dotoku', label: '道徳', ruby: 'どうとく', low: 'どうとく' },
    { id: 'sogo', label: '総合', ruby: 'そうごう', low: 'そうごう' },
    { id: 'other', label: 'その他', ruby: 'そのほか', low: 'そのほか' }
  ];
  var SUBJECT_IDS = SUBJECTS.map(function (s) { return s.id; });
  var NOW_MAX = 3;                       // いまの学習は3件まで（多いと「いま」が分からなくなる）
  var PUB_SHEET = 'class_pages', PUB_HEAD = ['学級', 'ページ', '公開', '更新', '教師'];
  var NOW_SHEET = 'now_learning', NOW_HEAD = ['学級', 'ページ', '順', 'から', 'まで', '更新', '教師'];
  var ORDER_SHEET = 'class_order', ORDER_HEAD = ['学級', '教科', '並び', '更新', '教師'];   // 先生モードでドラッグした教科の中の並び
  var COLOR_SHEET = 'class_colors', COLOR_HEAD = ['学級', 'ページ', '色', '更新', '教師'];   // 先生モードで選んだタイルの色
  /** 単元ボタンの文字（学級ごと）：大きさ（m 自動＝既定・枠に収まる大きさ／s 小／l 大／xl 特大）と、改行する位置（題の何文字目の後ろか。3か所まで） */
  var STYLE_SHEET = 'class_styles', STYLE_HEAD = ['学級', 'ページ', '大きさ', '改行', '更新', '教師'];
  var TEXT_SIZES = ['s', 'm', 'l', 'xl'];
  /** 改行の位置を整える（1〜60 の整数・重ならない・小さい順・3か所まで） */
  function cleanBreaks(br) {
    var seen = {};
    return (Array.isArray(br) ? br : String(br || '').split(',')).map(Number)
      .filter(function (n) { if (!(n >= 1 && n <= 60) || n !== Math.floor(n) || seen[n]) return false; seen[n] = 1; return true; })
      .sort(function (a, b) { return a - b; }).slice(0, 3);
  }
  /**
   * タイルの色（算数TA のハブ apps/hub/Code.gs の COLORS と同じ30色）：名前 → [地の色, 文字の色]。
   * 先生が学級ごとに選べる（無ければ学習BASE のデータの pages、移る間は算数TA の links の色）。色だけで見分けさせない（題を必ず出す）
   */
  var TILE_COLORS = {
    mint: ['#12C48B', '#052A1F'], blue: ['#2B4CF2', '#F0F3FF'], amber: ['#FFC400', '#2E2200'], red: ['#FF5C38', '#2C0A02'],
    purple: ['#6D4AE0', '#F3EEFF'], gray: ['#4A5568', '#EEF1F6'], lavender: ['#D3C9FB', '#1C152F'], olive: ['#696713', '#F6F6EB'],
    wine: ['#900D2A', '#F7F7F7'], cyan: ['#0DA2C6', '#1A1A1A'], rose: ['#DE5F99', '#2C101C'], teal: ['#13745F', '#EBF9F4'],
    brown: ['#964D0C', '#FEF3EC'], peach: ['#FCC1B6', '#2E100C'], lime: ['#9EB919', '#181E01'], aqua: ['#2CECF2', '#1A1A1A'],
    plum: ['#80146F', '#FCF1F9'], periwinkle: ['#6B89F9', '#121932'], ochre: ['#CB7E19', '#1A1A1A'], sky: ['#A8D8FB', '#001D2F'],
    orchid: ['#CE88F7', '#22132B'], peacock: ['#1C6E80', '#EBF8FC'], green: ['#057918', '#EFF8EF'], pink: ['#FEA4D2', '#2B101F'],
    mustard: ['#AA9117', '#1A1A1A'], leaf: ['#97EB79', '#0E2007'], apricot: ['#FDB171', '#2B1401'], coral: ['#FB8087', '#2E1012'],
    turquoise: ['#16A7A3', '#1A1A1A'], cobalt: ['#1468A3', '#EDF6FF']
  };

  /* ---------- 目録 ---------- */

  function validate(cat) {
    var e = [];
    if (!cat || !Array.isArray(cat.pages)) return ['pages がありません'];
    var seen = {};
    cat.pages.forEach(function (p, i) {
      var w = 'pages[' + i + ']（' + (p && p.id) + '）';
      if (!p || !/^[a-z0-9][a-z0-9-]*$/.test(String(p.id || ''))) { e.push(w + ' の id は英小文字・数字・-'); return; }
      if (seen[p.id]) e.push('id が重複: ' + p.id);
      seen[p.id] = true;
      if (SUBJECT_IDS.indexOf(p.subject) < 0) e.push(w + ' の教科が不明: ' + p.subject);
      if (!Array.isArray(p.grades) || !p.grades.length || p.grades.some(function (g) { return !(g >= 1 && g <= 6); })) e.push(w + ' の grades は 1〜6 の配列');
      if (!p.title) e.push(w + ' に title がありません');
      if (p.kind === 'app') {
        if (!/^[a-z][a-z0-9-]*$/.test(String(p.app || ''))) e.push(w + ' の app が不正');
        // linkId：アプリの準備ができるまでの開く先（移る間。pages シートのキー）
        if (p.linkId !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(String(p.linkId))) e.push(w + ' の linkId が不正');
      }
      else if (p.kind === 'page') {
        var s = p.src || {};
        if (!s.repo || !s.path || !/^[0-9a-f]{7,40}$|^v[\w.\-]+$/.test(String(s.ver || ''))) e.push(w + ' の src は repo・path・ver（コミットかタグ）');
      } else if (p.kind === 'link') {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(String(p.linkId || ''))) e.push(w + ' の linkId（pages シートのキー）が不正');
      } else e.push(w + ' の kind は app・page・link');
      if (p.actAs != null && typeof p.actAs !== 'boolean') e.push(w + ' の actAs は true / false（代わりに取り組むに対応しているか）');
    });
    return e;
  }

  /* ---------- 学級の設定（教師が決める） ---------- */

  /**
   * 学級の設定。{ publish: { ページ: true/false }, now: [{ page, order, from, to }] }
   * 公開：書かれていないページは目録の defaultOn（省略時 true）に従う
   */
  function isOn(page, settings) {
    var v = settings && settings.publish ? settings.publish[page.id] : undefined;
    if (v === true || v === false) return v;
    return page.defaultOn !== false;
  }
  /** 'YYYY-MM-DD' の範囲に today が入るか（from・to は空なら無制限） */
  function inPeriod(n, today) {
    return (!n.from || String(n.from) <= today) && (!n.to || today <= String(n.to));
  }

  /**
   * 児童のホームに出すもの。
   * 返す：{ now: [ページ], subjects: [{ id, label, ruby, low, count }], bySubject: { 教科: [{ unit, pages: [ページ] }] } }
   * - その学年のページだけ・公開のページだけ
   * - いまの学習：期間内のもの・公開しているもの・学年が合うものを順に最大3件
   * - 教科：その学年に公開のページがある教科だけ。ページが1つだけの教科は only にそのページ（タイルから直接開く）
   */
  function home(cat, grade, settings, today) {
    var g = Number(grade);
    var vis = (cat.pages || []).filter(function (p) { return p.grades.indexOf(g) >= 0 && isOn(p, settings); });
    var byId = {}; vis.forEach(function (p) { byId[p.id] = p; });
    var now = ((settings && settings.now) || []).filter(function (n) { return byId[n.page] && inPeriod(n, today); })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
      .slice(0, NOW_MAX).map(function (n) { return byId[n.page]; });
    var bySubject = {};
    vis.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0) || (a.title < b.title ? -1 : 1); }).forEach(function (p) {
      var units = bySubject[p.subject] || (bySubject[p.subject] = []);
      var u = units.filter(function (x) { return x.unit === (p.unit || ''); })[0];
      if (!u) { u = { unit: p.unit || '', pages: [] }; units.push(u); }
      u.pages.push(p);
    });
    var subjects = SUBJECTS.filter(function (s) { return bySubject[s.id]; }).map(function (s) {
      var count = bySubject[s.id].reduce(function (t, u) { return t + u.pages.length; }, 0);
      var o = { id: s.id, label: s.label, ruby: s.ruby, low: s.low, count: count };
      // 見せるページが1つだけの教科は、教科の画面を挟まずにそのページを開く（押す回数を1回減らす）
      if (count === 1) o.only = bySubject[s.id][0].pages[0];
      return o;
    });
    return { now: now, subjects: subjects, bySubject: bySubject };
  }

  /** 教師画面：その学年の全ページ（公開していないものも）と、いまの状態 */
  function teacherView(cat, grade, settings, today) {
    var g = Number(grade);
    var nowIds = ((settings && settings.now) || []).filter(function (n) { return inPeriod(n, today); }).map(function (n) { return n.page; });
    return (cat.pages || []).filter(function (p) { return p.grades.indexOf(g) >= 0; }).map(function (p) {
      return { page: p, on: isOn(p, settings), now: nowIds.indexOf(p.id) >= 0 };
    });
  }

  /* ---------- 保存（ハブのシート） ---------- */

  /** その学級の設定を読む */
  /**
   * 教科の中のページを、先生が並べた順にする（純粋な計算。画面でも使う）。
   * ids：先生が並べたページの id の並び。そこに無いページ（後で目録に足したものなど）は、元の順のまま後ろに付ける
   */
  function sortByOrder(pages, ids) {
    if (!ids || !ids.length) return pages.slice();
    var pos = {}; ids.forEach(function (id, i) { pos[id] = i; });
    return pages.map(function (p, i) { return { p: p, i: i }; }).sort(function (a, b) {
      var x = pos.hasOwnProperty(a.p.id) ? pos[a.p.id] : ids.length + a.i, y = pos.hasOwnProperty(b.p.id) ? pos[b.p.id] : ids.length + b.i;
      return x - y;
    }).map(function (o) { return o.p; });
  }

  function readSettings(hubSs, classKey) {
    var out = { publish: {}, now: [], order: {}, colors: {}, styles: {} };
    var ps = hubSs.getSheetByName(PUB_SHEET);
    if (ps && ps.getLastRow() > 1) ps.getRange(2, 1, ps.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (clsCell(r[0]) === classKey && r[1]) out.publish[String(r[1])] = r[2] === true || String(r[2]).toUpperCase() === 'TRUE';
    });
    var ns = hubSs.getSheetByName(NOW_SHEET);
    if (ns && ns.getLastRow() > 1) ns.getRange(2, 1, ns.getLastRow() - 1, 5).getValues().forEach(function (r) {
      if (clsCell(r[0]) === classKey && r[1]) out.now.push({ page: String(r[1]), order: Number(r[2]) || 0, from: ymd(r[3]), to: ymd(r[4]) });
    });
    var os = hubSs.getSheetByName(ORDER_SHEET);
    if (os && os.getLastRow() > 1) os.getRange(2, 1, os.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (clsCell(r[0]) === classKey && r[1]) out.order[String(r[1])] = String(r[2] || '').split(',').filter(Boolean);
    });
    var cs = hubSs.getSheetByName(COLOR_SHEET);
    if (cs && cs.getLastRow() > 1) cs.getRange(2, 1, cs.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (clsCell(r[0]) === classKey && r[1] && TILE_COLORS[String(r[2])]) out.colors[String(r[1])] = String(r[2]);
    });
    var ss = hubSs.getSheetByName(STYLE_SHEET);
    if (ss && ss.getLastRow() > 1) ss.getRange(2, 1, ss.getLastRow() - 1, 4).getValues().forEach(function (r) {
      if (clsCell(r[0]) !== classKey || !r[1]) return;
      var size = TEXT_SIZES.indexOf(String(r[2])) >= 0 ? String(r[2]) : '', br = cleanBreaks(r[3]);
      if (size || br.length) out.styles[String(r[1])] = { size: size, br: br };
    });
    return out;
  }
  // 学級・日付が日付に化けた値を戻す（Sheets.gs。保存の関数の中でだけ使う：画面の写し web/pages.js では呼ばれない）
  function clsCell(v) { return LbSheets.clsCell(v); }
  function ymd(v) { return LbSheets.ymd(v); }

  /** 公開を切り替える（押すたびに保存）。その学級・そのページの行を書き換える（無ければ足す） */
  function setPublish(hubSs, classKey, pageId, on, by) {
    var sh = sheet(hubSs, PUB_SHEET, PUB_HEAD), v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (clsCell(v[i][0]) === classKey && String(v[i][1]) === pageId) { sh.getRange(i + 1, 1, 1, 5).setValues([[classKey, pageId, !!on, new Date(), by || '']]); return; }
    }
    sh.appendRow([classKey, pageId, !!on, new Date(), by || '']);
  }

  /** 教科の中の並びを保存する（その学級・その教科の行を置き換える）。ids が空なら行を消す（目録の順に戻る） */
  function setOrder(hubSs, classKey, subject, ids, by) {
    if (SUBJECT_IDS.indexOf(subject) < 0) throw new Error('知らない教科です: ' + subject);
    var clean = (ids || []).map(String).filter(function (id) { return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id); });
    var sh = sheet(hubSs, ORDER_SHEET, ORDER_HEAD), v = sh.getDataRange().getValues(), keep = [v[0]];
    for (var i = 1; i < v.length; i++) {
      if (clsCell(v[i][0]) === classKey && String(v[i][1]) === subject) continue;
      var row = v[i].slice(0, ORDER_HEAD.length); row[0] = clsCell(row[0]); while (row.length < ORDER_HEAD.length) row.push(''); keep.push(row);
    }
    if (clean.length) keep.push([classKey, subject, clean.join(','), new Date(), by || '']);
    sh.clearContents();
    sh.getRange(1, 1, keep.length, ORDER_HEAD.length).setValues(keep);
    return clean;
  }

  /** タイルの色を選ぶ（その学級・そのページ）。color が空ならハブの links の色に戻す */
  function setColor(hubSs, classKey, pageId, color, by) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(pageId))) throw new Error('ページの名前が不正です');
    color = String(color || '');
    if (color && !TILE_COLORS[color]) throw new Error('知らない色です: ' + color);
    var sh = sheet(hubSs, COLOR_SHEET, COLOR_HEAD), v = sh.getDataRange().getValues(), keep = [v[0]];
    for (var i = 1; i < v.length; i++) {
      if (clsCell(v[i][0]) === classKey && String(v[i][1]) === pageId) continue;
      var row = v[i].slice(0, COLOR_HEAD.length); row[0] = clsCell(row[0]); while (row.length < COLOR_HEAD.length) row.push(''); keep.push(row);
    }
    if (color) keep.push([classKey, pageId, color, new Date(), by || '']);
    sh.clearContents();
    sh.getRange(1, 1, keep.length, COLOR_HEAD.length).setValues(keep);
  }

  /** 単元ボタンの文字（その学級・そのページ）。大きさが空（＝中）で改行も無ければ行を消す（目録のまま） */
  function setStyle(hubSs, classKey, pageId, size, br, by) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(pageId))) throw new Error('ページの名前が不正です');
    size = String(size || ''); if (size === 'm') size = '';
    if (size && TEXT_SIZES.indexOf(size) < 0) throw new Error('知らない大きさです: ' + size);
    br = cleanBreaks(br);
    var sh = sheet(hubSs, STYLE_SHEET, STYLE_HEAD), v = sh.getDataRange().getValues(), keep = [v[0]];
    for (var i = 1; i < v.length; i++) {
      if (clsCell(v[i][0]) === classKey && String(v[i][1]) === pageId) continue;
      var row = v[i].slice(0, STYLE_HEAD.length); row[0] = clsCell(row[0]); row[3] = String(row[3] == null ? '' : row[3]); while (row.length < STYLE_HEAD.length) row.push(''); keep.push(row);
    }
    if (size || br.length) keep.push([classKey, pageId, size, br.join(','), new Date(), by || '']);
    sh.clearContents();
    sh.getRange(1, 1, keep.length, STYLE_HEAD.length).setValues(keep);
  }

  /** その学級の公開を全部、目録の既定に戻す */
  function resetPublish(hubSs, classKey) {
    if (!hubSs.getSheetByName(PUB_SHEET)) return 0;
    var sh = sheet(hubSs, PUB_SHEET, PUB_HEAD);
    var v = sh.getDataRange().getValues(), keep = [v[0]], n = 0;
    for (var i = 1; i < v.length; i++) { var row = v[i].slice(); row[0] = clsCell(row[0]); if (row[0] === classKey) n++; else keep.push(row); }
    sh.clearContents();
    sh.getRange(1, 1, keep.length, PUB_HEAD.length).setValues(keep.map(function (r) { return pad5(r); }));
    return n;
  }
  function pad5(r) { var o = r.slice(0, PUB_HEAD.length); while (o.length < PUB_HEAD.length) o.push(''); return o; }

  /**
   * いまの学習を置き換える（その学級の分を list で丸ごと入れ替える）。list：[{ page, from, to }]（順は並びのとおり）
   * 3件を越える分は捨てる
   */
  function setNow(hubSs, classKey, list, by) {
    var sh = sheet(hubSs, NOW_SHEET, NOW_HEAD), v = sh.getDataRange().getValues(), keep = [v[0]];
    for (var i = 1; i < v.length; i++) {
      if (clsCell(v[i][0]) === classKey) continue;
      var row = v[i].slice(); row[0] = clsCell(row[0]); row[3] = ymd(row[3]); row[4] = ymd(row[4]); keep.push(row);
    }
    (list || []).slice(0, NOW_MAX).forEach(function (n, k) { keep.push([classKey, n.page, k + 1, n.from || '', n.to || '', new Date(), by || '']); });
    sh.clearContents();
    sh.getRange(1, 1, keep.length, NOW_HEAD.length).setValues(keep.map(function (r) { var o = r.slice(0, NOW_HEAD.length); while (o.length < NOW_HEAD.length) o.push(''); return o; }));
  }

  /** 表を用意する。学級と日付の列は毎回文字の書式にする（「3-1」が日付に化けないように） */
  function sheet(ss, name, head) {
    var cols = [];
    head.forEach(function (h, i) { if (h === '学級' || h === 'から' || h === 'まで' || h === '改行') cols.push(i + 1); });   // 改行（3,5）も数に化けないように
    return LbSheets.sheet(ss, name, head, cols, { always: true });
  }

  return { SUBJECTS: SUBJECTS, NOW_MAX: NOW_MAX, TILE_COLORS: TILE_COLORS, setColor: setColor, setStyle: setStyle, TEXT_SIZES: TEXT_SIZES, cleanBreaks: cleanBreaks, validate: validate, isOn: isOn, inPeriod: inPeriod, home: home, teacherView: teacherView, sortByOrder: sortByOrder, setOrder: setOrder,
    readSettings: readSettings, setPublish: setPublish, resetPublish: resetPublish, setNow: setNow };
})();

// ===== gas/Home.gs =====
/**
 * Home.gs — 学習BASE のホーム（児童・教師）の窓口
 *
 * 正本は learning-base。画面（web/home.js）が google.script.run で呼ぶ関数を持つ。
 * 名前が _ で終わらない大域の関数は画面から呼べる。ここに置くのは画面から呼んでよいものだけで、
 * 中で必ず「誰が開いたか」と「その学級を扱ってよいか」を確かめる。
 */
var LbHome = (function () {
  // ページの目録の置き場（公開リポジトリ）。版は読み込み係と同じ版（ハブの platform シートの 版）。
  // スクリプトのプロパティ PAGES_VER があればそれを使う（目録だけ先に変えたい時）。@main は使わない（jsDelivr が古い中身を返すことがある）
  var PAGES_REPO = 'sankisuguya-create/learning-base';
  var PAGES_PATH = 'catalog/pages.json';

  function today() { return LbSheets.day(); }
  function pagesUrl() {
    var v = String(PropertiesService.getScriptProperties().getProperty('PAGES_VER') || (typeof LB_LOADER !== 'undefined' ? LB_LOADER.ver() : '') || '');
    if (!v) throw new Error('ページの目録の版が決まりません（読み込み係の版も PAGES_VER もない）');
    return 'https://cdn.jsdelivr.net/gh/' + PAGES_REPO + '@' + v + '/' + PAGES_PATH;
  }

  /** 教師が扱える学級（名簿にある学級のうち、canSeeClass が通るもの）。番号順 */
  function classesFor(mail) {
    var seen = {}, out = [];
    Base.roster().forEach(function (r) {
      var k = Base.classKey(r.grade, r.cls);
      if (seen[k] || !Base.canSeeClass(mail, r.grade, r.cls)) return;
      seen[k] = true;
      out.push({ key: k, grade: r.grade, cls: r.cls });
    });
    return out.sort(function (a, b) { return a.grade - b.grade || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0); });
  }
  function parseKey(k) { var i = String(k).indexOf('-'); return { grade: Number(String(k).slice(0, i)), cls: String(k).slice(i + 1) }; }
  function requireClass(classKey) {
    var m = Base.me();
    if (m.role !== 'teacher') throw new Error('先生だけが変えられます');
    var c = parseKey(classKey);
    if (!c.grade || !Base.canSeeClass(m.email, c.grade, c.cls)) throw new Error('担当していない学級です: ' + classKey);
    return m;
  }

  /**
   * ページの設定（開く先の URL・既定の色・補足）。学習BASE のデータの pages シートが持ち主。
   *   pages：キー（算数TA の単元の id・目録の linkId・ページの id）／URL／色／補足
   * 移る間は、算数TA のハブの links シートの値も読み、pages に同じキーがあれば pages を使う（links は読むだけ。書かない）。
   * 返す：{ キー: { url, color, subtitle } }
   */
  var PAGES_SHEET = 'pages', PAGES_HEAD = ['キー', 'URL', '色', '補足', '更新'];
  function hubLinks() {
    var hub = Base.hub(), out = {};
    var lk = hub.getSheetByName('links');
    if (lk && lk.getLastRow() >= 2) lk.getRange(2, 1, lk.getLastRow() - 1, 6).getValues().forEach(function (r) {
      var id = String(r[0] || '').trim();
      if (id) out[id] = { url: String(r[3] || '').trim(), color: String(r[5] || '').trim(), subtitle: String(r[2] || '').trim() };
    });
    LbSheets.rows(hub, PAGES_SHEET, 4).forEach(function (r) {
      var id = String(r[0] || '').trim();
      if (!id) return;
      var o = out[id] || (out[id] = { url: '', color: '', subtitle: '' });
      o.url = String(r[1] || '').trim();                            // pages に行があれば、URL は pages のもの（空なら「無い」。所有者が消した時）
      if (String(r[2] || '').trim()) o.color = String(r[2]).trim();
      if (String(r[3] || '').trim()) o.subtitle = String(r[3]).trim();
    });
    return out;
  }
  /** 別の GAS のページとして受け付ける URL（Apps Script のウェブアプリだけ。学校のドメインの /a/macros/… も） */
  //   https://script.google.com/macros/s/<ID>/exec  または  https://script.google.com/a/macros/<学校のドメイン>/s/<ID>/exec
  var LINK_URL = /^https:\/\/script\.google\.com\/(a\/macros\/[A-Za-z0-9.\-]+|macros)\/s\/[A-Za-z0-9_\-]+\/exec(\?[A-Za-z0-9_=&%.\-]*)?$/;
  /**
   * 別の GAS のページ（目録の kind: link）の開く先を、学習BASE のデータの pages シートに書く（所有者だけ）。
   * 全校の児童が開く先なので、所有者以外は変えられない。算数TA のハブの links シートには書かない
   */
  function setLink(linkId, url, title) {
    requireOwner();
    linkId = String(linkId || ''); url = String(url || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(linkId)) throw new Error('リンクの名前が不正です');
    if (url && !LINK_URL.test(url)) throw new Error('Apps Script のウェブアプリの URL（https://script.google.com/…/exec）を貼ってください');
    var hub = Base.hub(), sh = LbSheets.sheet(hub, PAGES_SHEET, PAGES_HEAD, [1, 2]);
    var n = sh.getLastRow(), ids = n >= 2 ? sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return String(r[0] || '').trim(); }) : [];
    var i = ids.indexOf(linkId);
    if (i >= 0) { sh.getRange(i + 2, 2).setValue(url); sh.getRange(i + 2, 5).setValue(new Date()); }
    else sh.appendRow([linkId, url, '', '', new Date()]);
    void title;
    return hubLinks();
  }

  /**
   * ホームを開いた時の情報。
   * - 児童：本人の名前・学年・学級と、学級の設定（公開・いまの学習）
   * - 教師：扱える学級の一覧、選んだ学級の設定と児童の一覧（代わりに取り組む児童を選ぶため）
   * - 名簿にない人：おためし（学年を選んで見られる。記録はしない）
   */
  function boot(opt) {
    opt = opt || {};
    var t0 = Date.now(), out = bootInner(opt), ev = ['boot', LbTelemetry.speed('srv', Date.now() - t0)];
    // 前回分（往復の時間・端末のメモリ・始めるまで・行き止まり）は画面が覚えて次に送る（呼び出しを増やさない）
    LbTelemetry.count(out.role, ev.concat(LbTelemetry.bootEvents(out.role, out.learner ? out.learner.grade : 0, opt)));
    return out;
  }
  function bootInner(opt) {
    var m = Base.me(), out = { role: m.role, today: today(), pagesUrl: pagesUrl(), subjects: LbPages.SUBJECTS };
    try { out.links = hubLinks(); } catch (e) { out.links = {}; }
    // アプリが使える状態か（まだ準備ができていないアプリのページは、目録の linkId の開く先があればそちらを開く）
    try { out.apps = typeof LbPlatform !== 'undefined' ? LbPlatform.appsReady() : {}; } catch (e) { out.apps = {}; }
    if (m.role === 'child') {
      var c = m.child;
      out.learner = { name: c.name, mei: c.mei, grade: c.grade, cls: c.cls };
      out.classKey = Base.classKey(c.grade, c.cls);
      out.settings = LbPages.readSettings(Base.hub(), out.classKey);
      return out;
    }
    if (m.role === 'teacher') {
      var cls = classesFor(m.email);
      out.classes = cls;
      out.owner = isOwnerView();
      out.kinds = { names: LbAlerts.KIND_NAME, labels: LbAlerts.LABEL };   // 今週の3件の種類の名前（Alerts.gs の1か所から）
      // 開く学級：画面で選んだ学級 → teachers シートのその先生の学級（最初の行）→ 先頭の学級
      var want = opt.classKey || homeClassKey(m.email, cls);
      var pick = cls.filter(function (x) { return x.key === want; })[0] || cls[0];
      if (pick) {
        out.classKey = pick.key;
        out.settings = LbPages.readSettings(Base.hub(), pick.key);
        out.members = Base.members(pick.grade, pick.cls).map(function (r) {
          return { lid: r.lid, no: r.no, name: r.name, provisional: !!r.provisional };
        });
        try { out.now3 = now3(pick.key); } catch (e) { out.now3 = []; console.error('今週の3件を読めません: ' + e.message); }
        try { var dv = directiveView(pick.key); out.directives = dv.directives; out.results = dv.results; }
        catch (e) { out.directives = []; out.results = []; console.error('指示を読めません: ' + e.message); }
      }
      return out;
    }
    out.message = m.role === 'none' ? '学校のアカウントで ひらいてください' : 'なまえが まだ とうろく されていません。せんせいに つたえてね';
    return out;
  }

  /**
   * その先生が開いた時の学級。teachers シートの、その先生の行を上から見て、最初に名簿にある学級。
   * 学年だけの行（組が空）はその学年の最初の学級。全校の行（学年も空）は飛ばす。無ければ ''（先頭の学級を開く）
   */
  function homeClassKey(mail, cls) {
    var t = null;
    try { t = Base.teacher(mail); } catch (e) { return ''; }
    if (!t) return '';
    for (var i = 0; i < t.scopes.length; i++) {
      var s = t.scopes[i];
      if (!s.grade) continue;
      var hit = cls.filter(function (x) { return x.grade === s.grade && (!s.cls || Base.normCls(x.cls) === s.cls); })[0];
      if (hit) return hit.key;
    }
    return '';
  }

  /** 今週の3件（名前・技能の名前・根拠の一文を付ける）。名前は教師にだけ渡す */
  function now3(classKey) {
    var hub = Base.hub(), cats = LbCatalog.readAll(hub);
    return LbAlerts.read(hub, classKey).map(function (x) {
      var cat = cats[x.app], sk = cat ? LbCatalog.index(cat)[x.skill] : null;
      return { key: x.key, kind: x.kind, label: LbAlerts.LABEL[x.kind] || x.kind, skill: sk ? sk.label : x.skill, app: cat ? cat.title : x.app,
        names: x.lids.map(function (l) { var r = Base.learner(l); return r ? r.name : '（名簿にない）'; }), text: LbAlerts.describe(x),
        canDirect: !!(cat && (cat.directives || []).indexOf('weight') >= 0) };   // その技能のアプリが指示（練習の重み）を受け取れるか
    });
  }

  /* ---------- 指示（Directives.gs） ---------- */

  /** その学級の、いま効いている指示と、まだ見ていない結果（名前・技能の名前を付ける。名前は教師にだけ） */
  function directiveView(classKey) {
    var hub = Base.hub(), cats = LbCatalog.readAll(hub), t = today();
    function dress(d) {
      var cat = cats[d.app], sk = cat ? LbCatalog.index(cat)[d.skill] : null;
      return { id: d.id, skill: sk ? sk.label : d.skill, app: cat ? cat.title : d.app, from: d.from, to: d.to, show: d.show,
        names: d.lids.map(function (l) { var r = Base.learner(l); return r ? r.name : '（名簿にない）'; }), text: LbDirectives.describe(d.result) };
    }
    return { directives: LbDirectives.active(hub, classKey, t).map(dress),
      results: LbDirectives.results(hub, classKey, t, LbAlerts.decidedKeys(hub)).map(dress) };
  }
  function afterDirective(classKey) { var dv = directiveView(classKey); return { now3: now3(classKey), directives: dv.directives, results: dv.results }; }
  /**
   * 今週の3件の項目から指示を作る（手を打つ）。days：7 か 14、show：児童に「★ おすすめ」を見せるか。
   * 作ると、その項目には「判断が変わった」も記録する（2回押させない）
   */
  function direct(classKey, key, days, show) {
    var m = requireClass(classKey), hub = Base.hub();
    var item = LbAlerts.read(hub, classKey).filter(function (x) { return x.key === String(key); })[0];
    if (!item) throw new Error('もう ない項目です（ページを開き直してください）');
    var cat = LbCatalog.readAll(hub)[item.app];
    if (!cat || (cat.directives || []).indexOf('weight') < 0) throw new Error('このアプリは まだ 指示を受け取れません');
    var d = LbDirectives.create(hub, { classKey: classKey, lids: item.lids, app: item.app, skill: item.skill, days: days, show: !!show, fromKey: item.key }, m.email, today());
    LbAlerts.decide(hub, classKey, item, 'changed', '指示 ' + d.id, m.email);
    return afterDirective(classKey);
  }
  function endDirective(classKey, id) {
    requireClass(classKey);
    LbDirectives.end(Base.hub(), id, classKey);
    return afterDirective(classKey);
  }
  /** 結果を見た（結果の欄から消える）。again が 7 か 14 なら、同じ対象・技能でもう1期間続ける */
  function seeResult(classKey, id, again) {
    var m = requireClass(classKey), hub = Base.hub(), d = LbDirectives.find(hub, id);
    if (!d || d.classKey !== String(classKey)) throw new Error('この学級の指示ではありません');
    LbAlerts.decide(hub, classKey, { key: 'result|' + d.id, kind: 'result' }, again ? 'changed' : 'seen', again ? '続ける' : '', m.email);
    if (again) LbDirectives.create(hub, { classKey: classKey, lids: d.lids, app: d.app, skill: d.skill, days: again, show: d.show, fromKey: 'result|' + d.id }, m.email, today());
    return afterDirective(classKey);
  }
  /** 判断の記録（判断が変わった／見た）。押した項目は今週の3件から消える */
  function decide(classKey, key, action, memo) {
    var m = requireClass(classKey);
    var item = LbAlerts.read(Base.hub(), classKey).filter(function (x) { return x.key === String(key); })[0];
    if (!item) throw new Error('もう ない項目です（ページを開き直してください）');
    LbAlerts.decide(Base.hub(), classKey, item, action === 'changed' ? 'changed' : 'seen', memo, m.email);
    return now3(classKey);
  }

  function setPublish(classKey, pageId, on) {
    var m = requireClass(classKey);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(pageId))) throw new Error('ページの名前が不正です');
    LbPages.setPublish(Base.hub(), classKey, String(pageId), !!on, m.email);
    return LbPages.readSettings(Base.hub(), classKey);
  }
  /** 教科の中の並び（先生モードでドラッグ）。ids が空なら目録の順に戻す */
  function setOrder(classKey, subject, ids) {
    var m = requireClass(classKey);
    LbPages.setOrder(Base.hub(), classKey, String(subject), Array.isArray(ids) ? ids : [], m.email);
    return LbPages.readSettings(Base.hub(), classKey);
  }
  /** タイルの色（学級ごと）。color が空ならハブの links の色に戻す */
  function setColor(classKey, pageId, color) {
    var m = requireClass(classKey);
    LbPages.setColor(Base.hub(), classKey, String(pageId), String(color || ''), m.email);
    return LbPages.readSettings(Base.hub(), classKey);
  }
  /** 単元ボタンの文字（学級ごと）：大きさ（s／m／l／xl）と改行の位置（題の何文字目の後ろか） */
  function setStyle(classKey, pageId, size, br) {
    var m = requireClass(classKey);
    LbPages.setStyle(Base.hub(), classKey, String(pageId), String(size || ''), br, m.email);
    return LbPages.readSettings(Base.hub(), classKey);
  }
  function resetPublish(classKey) {
    requireClass(classKey);
    LbPages.resetPublish(Base.hub(), classKey);
    return LbPages.readSettings(Base.hub(), classKey);
  }
  function setNow(classKey, list) {
    var m = requireClass(classKey);
    var clean = (Array.isArray(list) ? list : []).map(function (n) {
      return { page: String(n.page || ''), from: /^\d{4}-\d{2}-\d{2}$/.test(n.from || '') ? n.from : '', to: /^\d{4}-\d{2}-\d{2}$/.test(n.to || '') ? n.to : '' };
    }).filter(function (n) { return /^[a-z0-9][a-z0-9-]*$/.test(n.page); });
    LbPages.setNow(Base.hub(), classKey, clean, m.email);
    return LbPages.readSettings(Base.hub(), classKey);
  }

  /* ---------- 直すための材料（Telemetry.gs・Tuning.gs・Export.gs） ---------- */

  /** 所有者が開いているか（「自分として実行」では、開いた人＝所有者の時だけ getActiveUser と getEffectiveUser が同じ） */
  function isOwnerView() {
    try {
      var a = String(Session.getActiveUser().getEmail() || '').toLowerCase(), e = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
      return !!a && a === e;
    } catch (err) { return false; }
  }
  /** 先生の気づき（学習BASE の使い勝手・機能。児童の学習のようすは書かない）。ハブの feedback シートに1行 */
  function feedback(classKey, view, text) {
    var m = Base.me();
    if (m.role !== 'teacher') throw new Error('先生だけが送れます');
    var ck = '';
    if (classKey) { requireClass(classKey); ck = String(classKey); }
    LbExport.saveFeedback(Base.hub(), m.email, ck, view, text);
    return true;
  }
  /**
   * 前回分の記録（往復・端末のメモリ・始めるまで・行き止まり）。ホームの情報をページの枠に入れて返す時は、
   * 画面が表示の後にこれで送る（表示は待たせない）
   */
  function beat(o) {
    var m = Base.me();
    LbTelemetry.count(m.role, LbTelemetry.bootEvents(m.role, m.child ? m.child.grade : 0, o || {}));
    return true;
  }
  /**
   * 画面の失敗を数える。loadfail：画面のファイルが読めない／bootfail：ホームの情報が取れない／catfail：目録が取れない／
   * jserror：画面の JavaScript の失敗（detail にエラー文。メール・ID・長い数は伏せて記録）
   */
  var REPORT = { loadfail: 1, bootfail: 1, catfail: 1, jserror: 1 };
  function report(kind, detail) {
    if (!REPORT[kind]) return false;
    var role = '-';
    try { role = Base.me().role; } catch (e) {}
    LbTelemetry.count(role, kind === 'jserror' ? 'js:' + LbTelemetry.errText(detail) : 'client:' + kind);
    return true;
  }
  function requireOwner() { if (!isOwnerView()) throw new Error('スプレッドシートの所有者だけが使えます'); }
  /** 失敗と速さの書き出し（所有者だけ。観察では見えないものだけ・学習状態は入れない）。{ ok, text, problems, notes } */
  function exportForTuning() {
    requireOwner();
    var hub = Base.hub(), fy = Base.fy(), roster = Base.roster(), t = today();
    var settings = classesFor(String(Session.getActiveUser().getEmail() || '').toLowerCase()).map(function (c) {
      var st = LbPages.readSettings(hub, c.key), hidden = 0;
      Object.keys(st.publish || {}).forEach(function (k) { if (st.publish[k] === false) hidden++; });
      return { classKey: c.key, hidden: hidden, now: (st.now || []).filter(function (n) { return LbPages.inPeriod(n, t); }).length };
    });
    var ver = '';
    try { ver = typeof LB_LOADER !== 'undefined' ? LB_LOADER.ver() : ''; } catch (e) {}
    var r = LbExport.exportText({ hub: hub, fy: fy, today: t, ver: ver, roster: roster, teachers: Base.teachers(), settings: settings });
    return r;
  }

  /* 閾値を見直す（所有者だけ・学校の中だけ。児童の学習状態を扱うので書き出しには入れない） */
  function tuningInput() { var hub = Base.hub(), fy = Base.fy(); return { hub: hub, today: today(), roster: Base.roster(), acc: LbFacts.read(hub, fy), cats: LbCatalog.readAll(hub) }; }
  function tuning() {
    requireOwner();
    return LbTuning.tuning(tuningInput());
  }
  /** 入れた値で数える（保存しない）。values：{ 項目: 値 }（元の値。0.15 など） */
  function tryRules(values) {
    requireOwner();
    var o = tuningInput();
    return LbTuning.tryRules(o.acc, o.roster, o.cats, o.today, LbAlerts.active(o.hub), values || {});
  }
  /** 値を保存する（翌晩から効く）。now が true なら今週の3件をすぐ計算し直す。返す：見直す画面の材料 */
  function saveRules(values, now) {
    requireOwner();
    var o = tuningInput();
    LbAlerts.saveValues(o.hub, values || {}, String(Session.getActiveUser().getEmail() || ''));
    if (now) LbTuning.logAlerts(o.hub, LbAlerts.refresh(o.hub, Base.fy(), o.roster, o.cats, o.today), o.today);
    return LbTuning.tuning(o);
  }

  /**
   * 画面から呼べる関数の表（ここが唯一の登録場所）。Platform.gs はこの表だけを lbCall で通し、
   * 画面は LB_PLATFORM.call('homeXxx', …) で呼ぶ（'home' を外して頭を小文字にした名前でこの表を引く）。
   * 中で必ず「誰が開いたか」と「その学級・その操作をしてよいか」を確かめる関数だけを置く
   */
  var API = { boot: boot, beat: beat, setLink: setLink, decide: decide, setPublish: setPublish, resetPublish: resetPublish, setNow: setNow, setOrder: setOrder, setColor: setColor, setStyle: setStyle,
    feedback: feedback, report: report, 'export': exportForTuning, tuning: tuning, tryRules: tryRules, saveRules: saveRules,
    direct: direct, endDirective: endDirective, seeResult: seeResult };

  return { API: API, boot: boot, feedback: feedback, report: report, exportForTuning: exportForTuning, isOwnerView: isOwnerView, tuning: tuning, tryRules: tryRules, saveRules: saveRules, decide: decide, now3: now3, setPublish: setPublish, resetPublish: resetPublish, setNow: setNow, classesFor: classesFor, pagesUrl: pagesUrl };
})();

// ===== gas/Platform.gs =====
/**
 * Platform.gs — 学習BASE の入口の振り分け（読み込み係 Loader.gs が jsDelivr から取ってきて実行する）
 *
 * 正本は learning-base。dist/server.js の最後に入る（共通部品と各アプリの後）。
 *
 * URL
 *   …/exec                        学習BASE のホーム（web/home.js）
 *   …/exec?app=tamath&unit=kuku   算数タイムアタック（アプリの doGet に渡す）
 *   …/exec?unit=kuku              同上（今までの算数TA の URL との互換）
 *   …/exec?doc=<id>               教材・授業ページ（準備中）。page= はアプリが使う（算数TA の教師画面 page=teacher）ので使わない
 *   &as=<学習者ID>                教師が児童の代わりに取り組む（アプリの対応は段階C）
 *
 * アプリ（LB_MODULES）は、各アプリのサーバー側のコードを関数の中に包んだもの（tools/bundle.cjs が作る）。
 * 包むので、アプリの関数（doGet・apiCall など）は大域に出ず、読み込み係の入口を上書きしない。
 */
var LbPlatform = (function () {
  /** 学習BASE の画面から呼べる関数（lbCall の mod・name）。ここに無いものは呼べない。表の中身は各窓口が持つ（LbHome.API） */
  var API = { home: LbHome.API };
  function roleNow() { try { return Base.me().role; } catch (e) { return '-'; } }

  /**
   * アプリ（教科）を、要る時だけ読み込む。新しい読み込み係（LB_LOADER.app がある）は dist/app-<id>.js をその時に取ってくる。
   * 古い読み込み係は dist/server.js で全アプリを最初に読み込んでいるので、そのまま使う
   */
  function appIds() { return typeof LB_APP_IDS !== 'undefined' ? LB_APP_IDS.slice() : Object.keys(LB_MODULES); }
  function appMod(id) {
    if (appIds().indexOf(String(id)) < 0) return null;
    if (!LB_MODULES[id] && typeof LB_LOADER !== 'undefined' && typeof LB_LOADER.app === 'function') {
      try { LB_LOADER.app(id); } catch (e) { LB_MODULES[id] = { broken: String(e && e.message || e) }; console.error('アプリ ' + id + ' を取ってこられません: ' + (e && e.message || e)); }
    }
    return LB_MODULES[id] || null;
  }
  function eachApp(fn) { appIds().forEach(function (k) { var m = appMod(k); if (m) fn(k, m); }); }

  function doGet(e) {
    var p = (e && e.parameter) || {};
    var app = p.app || (p.unit ? 'tamath' : '');
    var mv = LbMove.moved();
    if (mv) return movedPage(mv);
    if (p.doc && !app) return message('このページは じゅんび中です');
    if (app) {
      var m = appMod(app);
      if (!m) return message('アプリが見つかりません: ' + app);
      if (m.broken) { LbTelemetry.count(roleNow(), LbTelemetry.err(app + '.load', m.broken)); return message('いまは ひらけません。すこし まってから、ひらきなおしてね'); }
      LB_LOADER.files(app);                   // そのアプリの画面のファイルを読む（LB_FILES。古い読み込み係は全アプリ分）
      try { return m.doGet(e); } catch (err) { LbTelemetry.count(roleNow(), LbTelemetry.err(app + '.doGet', err)); throw err; }
    }
    return homePage();
  }

  function call(mod, name, args) {
    // 'app:<id>'：アプリの画面からの呼び出し（アプリの apiCall(名前, 引数) へ。呼べる関数はアプリが表で決める）。算数TA は今までの入口（Loader の apiCall）
    var am = /^app:([a-z][a-z0-9-]*)$/.exec(String(mod));
    if (am) {
      var m = appMod(am[1]);
      if (m && m.broken) throw new Error('いまは つかえません（' + am[1] + ' を読み込めません）');
      if (!m || typeof m.apiCall !== 'function') throw new Error('アプリが見つかりません: ' + am[1]);
      try { return m.apiCall(String(name), Array.isArray(args) ? args : []); }
      catch (e) { LbTelemetry.count(roleNow(), LbTelemetry.err(am[1] + '.' + String(name).slice(0, 40), e)); throw e; }
    }
    var api = API[String(mod)];
    if (!api || !Object.prototype.hasOwnProperty.call(api, String(name))) throw new Error('呼べない関数です: ' + mod + '.' + name);
    try { return api[name].apply(null, Array.isArray(args) ? args : []); }
    catch (e) { LbTelemetry.count(roleNow(), LbTelemetry.err(mod + '.' + name, e)); throw e; }
  }
  function appApi(app, unit, name, args) {
    var m = appMod(app);
    if (m && m.broken) throw new Error('いまは つかえません（' + app + ' を読み込めません）');
    if (!m || !m.apiCall) throw new Error('アプリが見つかりません: ' + app);
    try { return m.apiCall(unit, name, args); }
    catch (e) { LbTelemetry.count(roleNow(), LbTelemetry.err(app + '.' + String(name).slice(0, 40), e)); throw e; }
  }

  /** 自動実行：各アプリの夜・朝の処理。1つのアプリが失敗しても他は続ける */
  function each(job) {
    var errs = [];
    eachApp(function (k, m) {
      if (typeof m[job] !== 'function') return;
      try { m[job](); } catch (e) { errs.push(k + ': ' + (e && e.message || e)); console.error(job + ' ' + k + ' 失敗: ' + (e && e.message || e)); }
    });
    return errs;
  }
  /**
   * 過去の記録を1回だけ集計に取り込む（アプリが legacySources・legacySessions を持つ時）。
   * 記録先ごとに「済み」の印を置き、新しい形の記録が始まった時刻より前の分だけを足す（二重に数えない）
   */
  function legacy() {
    var hub = Base.hub(), fy = Base.fy(), errs = [];
    eachApp(function (k, m) {
      if (typeof m.legacySources !== 'function' || typeof m.legacySessions !== 'function') return;
      var srcs = []; try { srcs = m.legacySources(); } catch (e) { errs.push(k + ': ' + e.message); return; }
      var ss = {}; try { (m.sessionSources ? m.sessionSources() : []).forEach(function (s) { ss[s.key] = s.ss; }); } catch (e) {}
      srcs.forEach(function (src) {
        var flag = 'legacy|' + src.key + '|' + fy;
        if (LbFacts.marked(hub, flag)) return;
        try {
          var before = ss[src.key] ? LbFacts.firstSessionTs(ss[src.key], fy) : null;
          var n = LbFacts.mergeSessions(hub, fy, m.legacySessions(src.unit, before || new Date()));
          LbFacts.mark(hub, flag);
          console.log('過去の記録を取り込んだ：' + src.key + '（' + n + ' 行）');
        } catch (e) { errs.push(src.key + ': ' + e.message); }
      });
    });
    return errs;
  }

  /** 今週の3件を計算してハブに置く */
  function alerts() {
    try {
      var hub = Base.hub(), fy = Base.fy();
      var today = LbSheets.day();
      var by = LbAlerts.refresh(hub, fy, Base.roster(), LbCatalog.readAll(hub), today);   // 所有者が変えた閾値（rules シート）で
      console.log('今週の3件：' + Object.keys(by).reduce(function (t, c) { return t + by[c].length; }, 0) + ' 件（初めて出た ' + LbTuning.logAlerts(hub, by, today) + ' 件）');
      return [];
    } catch (e) { console.error('今週の3件 失敗: ' + e.message); return ['alerts: ' + e.message]; }
  }

  /**
   * 月曜の朝：学級の担当の先生（teachers シート）と所有者に「今週の3件」の件数を知らせる。
   * 児童の名前はメールに書かない（名前は学習BASE の画面の中だけ）。
   * 所有者には、直近7日の失敗の件数も1行（今週の3件が無い週でも、失敗があれば送る）
   */
  function weekly() {
    var hub = Base.hub(), url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
    var owner = ''; try { owner = Session.getEffectiveUser().getEmail(); } catch (e) {}
    var ne = 0; try { ne = LbTelemetry.errorCount(hub); } catch (e) {}
    var errLine = ne ? '直近7日の失敗：' + ne + ' 件。学習BASE の一番下「失敗と速さを見る・書き出す」で確かめてください。' : '';
    var sh = hub.getSheetByName('now3');
    var count = {};
    var done = LbAlerts.decidedKeys(hub);
    if (sh && sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
      var cls = LbSheets.clsCell(r[0]);
      if (done[r[2]]) return;
      var c = count[cls] || (count[cls] = {}); c[r[3]] = (c[r[3]] || 0) + 1;
    });
    var classes = Object.keys(count);
    if (!classes.length) {
      if (!errLine || !owner) return 0;
      MailApp.sendEmail({ to: owner, subject: '学習BASE：失敗の件数', body: errLine + '\n' + url });
      return 1;
    }
    var to = {};
    function addTo(mail, cls) { if (mail) (to[mail] = to[mail] || []).push(cls); }
    classes.forEach(function (cls) {
      var i = cls.indexOf('-'), g = Number(cls.slice(0, i)), c = cls.slice(i + 1);
      Base.teachers().forEach(function (t) { if (t.scopes.some(function (s) { return !s.grade || (s.grade === g && (!s.cls || s.cls === c)); })) addTo(t.mail, cls); });
      addTo(owner, cls);
    });
    var name = LbAlerts.KIND_NAME, sent = 0;
    Object.keys(to).forEach(function (mail) {
      var lines = to[mail].filter(function (v, i, a) { return a.indexOf(v) === i; }).sort().map(function (cls) {
        var c = count[cls], i = cls.indexOf('-');
        return cls.slice(0, i) + '年' + cls.slice(i + 1) + '組：' + Object.keys(c).map(function (k) { return name[k] + ' ' + c[k]; }).join('・');
      });
      MailApp.sendEmail({ to: mail, subject: '学習BASE：今週の3件', body: '今週、目を向けるとよい相手がいます。\n\n' + lines.join('\n') +
        '\n\n学習BASE（先生の画面の一番上）で確かめてください。\n' + url + (mail === owner && errLine ? '\n\n（所有者へ）' + errLine : '') + '\n\n（このメールには児童の名前を書いていません）' });
      sent++;
    });
    return sent;
  }

  /** 期間が終わった指示の結果を出す（本番の記録＝集計から） */
  function directives() {
    try {
      var hub = Base.hub();
      console.log('指示の結果：' + LbDirectives.evaluate(hub, LbFacts.read(hub, Base.fy()), Base.roster(), LbSheets.day()) + ' 件');
      return [];
    } catch (e) { console.error('指示の結果 失敗: ' + e.message); return ['directives: ' + e.message]; }
  }

  /** 前日までの使われ方を usage シートへ（1日×区分×出来事で1行） */
  function usage() {
    try { console.log('使われ方：' + LbTelemetry.flush(Base.hub()) + ' 行'); return []; }
    catch (e) { console.error('使われ方 失敗: ' + e.message); return ['usage: ' + e.message]; }
  }

  /** 全アプリの新しい形の記録を「児童×技能×週」に足す（ハブの facts_<年度>）。時間切れなら残りは次の夜 */
  function facts() {
    var sources = [];
    eachApp(function (k, m) {
      if (typeof m.sessionSources === 'function') { try { sources = sources.concat(m.sessionSources()); } catch (e) { console.error(k + ' の記録先: ' + e.message); } }
    });
    if (!sources.length) return [];
    try { var r = LbFacts.ingest(Base.hub(), sources); console.log('集計：' + r.read + ' 行' + (r.more ? '（続きは次回）' : '')); return []; }
    catch (e) { console.error('集計 失敗: ' + e.message); return ['facts: ' + e.message]; }
  }

  function setup() {
    var pre = [];
    try { var tk = LbMove.take(); if (tk) pre.push(tk); } catch (e) { pre.push('移転の取り込み：× ' + e.message); }
    try {   // 先生の担当（開いた時の学級・支援員の見られる学級）。無ければ見出しだけ置く。直した分は保存（6時間）を消してすぐ反映
      var tsh = LbSheets.sheet(Base.hub(), 'teachers', ['メール', '姓', '名', 'せい', 'めい', '学年', '組'], []);
      Base.clearCache();
      pre.push('先生の担当 teachers：' + Math.max(tsh.getLastRow() - 1, 0) + ' 行');
    } catch (e) { pre.push('先生の担当 teachers：× ' + e.message); }
    try { LbStores.forget(); LbStores.ensure(); pre.push('台帳 app_sheets：前の形から写した ' + LbStores.syncLegacy() + ' 件・登録 ' + LbStores.list().length + ' 件'); } catch (e) { pre.push('台帳 app_sheets：× ' + e.message); }
    try { var po = LbMove.pointOld(); if (po) pre.push(po); } catch (e) { pre.push('旧URL の案内：× ' + e.message); }
    return pre.concat(appIds().map(function (k) {
      var m = appMod(k) || { broken: '見つかりません' };
      if (m.broken) return k + '：× 読み込めません（' + m.broken + '）';
      if (typeof m.setup !== 'function') return k + '：準備は要らない';
      try { return k + '：' + m.setup(); } catch (e) { return k + '：× ' + e.message; }
    })).join('\n');
  }

  /** 学習BASE のホーム。画面のプログラムは jsDelivr から（読み込み係と同じ版） */
  function homePage() {
    var base = 'https://cdn.jsdelivr.net/gh/' + LB_LOADER.repo + '@' + LB_LOADER.ver() + '/web/';
    var url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
    // ホームの情報をページの枠に入れて返す（画面からもう一度 GAS を呼ぶ往復 1.6〜4.0 秒を無くす）。失敗したら画面が今まで通り頼む
    var boot = null;
    try { boot = LbHome.boot({}); } catch (e) { console.error('ホームの情報を枠に入れられません: ' + (e && e.message || e)); }
    var html = '<!DOCTYPE html><html lang="ja"><head><base target="_top"><meta charset="utf-8">' +
      '<link rel="stylesheet" href="' + base + 'home.css">' +
      // ページの目録は、画面のプログラムと同時に取り始める（ホームの情報を待たない）
      (boot && /^https:\/\/cdn\.jsdelivr\.net\/[\w@.\/-]+$/.test(String(boot.pagesUrl)) ? '<link rel="preload" href="' + boot.pagesUrl + '" as="fetch" crossorigin="anonymous">' : '') +
      '</head><body style="margin:0;background:#E9EDF2">' +
      '<style>.ldots{display:inline-block;width:1.6em;text-align:left}.ldots::after{content:\'\';animation:ldots 1.2s steps(1,end) infinite}@keyframes ldots{0%{content:\'\'}25%{content:\'.\'}50%{content:\'..\'}75%{content:\'...\'}}@media (prefers-reduced-motion:reduce){.ldots::after{animation:none;content:\'...\'}}</style>' + // 待ちの点（home.css の版が古くても回るよう枠に直接書く）
      '<main id="lb" class="lb"><div class="lb-msg">よみこみ中<span class="ldots" aria-hidden="true"></span></div></main>' +
      '<script>' + platformScript(url) + (boot ? 'window.LB_BOOT=' + safeJson(boot) + ';' : '') + '<\/script>' +
      '<script src="' + base + 'pages.js" onerror="lbLoadFail()"><\/script>' +
      '<script src="' + base + 'home.js" onerror="lbLoadFail()"><\/script></body></html>';
    return HtmlService.createHtmlOutput(html).setTitle('学習BASE').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  /** <script> の中に置く JSON（名前などに </script> や行区切りの文字があっても、そこで終わらないように） */
  function safeJson(o) { return JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
  /** 画面の Platform 層（本番）：google.script.run.lbCall を Promise にする */
  function platformScript(baseUrl) {
    return 'window.LB_PLATFORM={baseUrl:' + JSON.stringify(baseUrl) + ',' +
      'call:function(name){var a=Array.prototype.slice.call(arguments,1);' +
      'var fn=String(name).replace(/^home(.)/,function(m,c){return c.toLowerCase();});' +   // homeSetNow → setNow（LbHome.API の名前）
      'return new Promise(function(ok,ng){google.script.run.withSuccessHandler(ok).withFailureHandler(ng).lbCall("home",fn,a);});},' +
      'app:function(mod,name,a){return new Promise(function(ok,ng){google.script.run.withSuccessHandler(ok).withFailureHandler(ng).lbCall(mod,name,a);});},' +   // アプリの窓口（lbCall('app:<id>')）
      'fetchJson:function(u){return fetch(u).then(function(r){if(!r.ok)throw new Error("目録 "+r.status);return r.json();});},' +
      'open:function(u,nt){window.open(u,nt?"_blank":"_top");}};' +
      'function lbLoadFail(){if(window.lbFailed)return;window.lbFailed=1;try{google.script.run.lbCall("home","report",["loadfail"]);}catch(e){}var m=document.getElementById("lb");if(m)m.innerHTML=\'<div class="lb-msg" style="padding:24px;font-size:20px">いま ひらけません。すこし まってから、ページを ひらきなおしてね。</div>\';}';
  }
  /** 旧GAS（移転した後）の URL を開いた人へ。新しい URL があればリンクを出す */
  function movedPage(mv) {
    var url = /^https:\/\/script\.google\.com\/[\w\/.\-]+\/exec$/.test(String(mv.url || '')) ? mv.url : '';
    return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width, initial-scale=1"><base target="_top"><div lang="ja" style="font-family:\'BIZ UDPGothic\',\'Noto Sans CJK JP\',sans-serif;font-size:20px;padding:24px;line-height:1.8">' +
      '学習BASE は あたらしい ばしょに ひっこしました。<br>' +
      (url ? '<a href="' + url + '" style="display:inline-block;margin-top:12px;padding:12px 20px;border-radius:10px;background:#1f6f5c;color:#fff;text-decoration:none">あたらしい 学習BASE を ひらく</a>' +
        '<br><small style="color:#616870">（先生へ：ブックマーク・Classroom のリンクを、この新しい URL に差し替えてください）</small>'
        : '先生に あたらしい URL を きいてね。') + '</div>').setTitle('学習BASE');
  }
  function message(text) {
    return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width, initial-scale=1"><div lang="ja" style="font-family:\'BIZ UDPGothic\',\'Noto Sans CJK JP\',sans-serif;font-size:20px;padding:24px">' +
      String(text).replace(/[<>&]/g, '') + '</div>').setTitle('学習BASE');
  }

  /** アプリが使える状態か（{ id: true/false }）。ready を持たないアプリは使える扱い。読み込めなかったアプリは false */
  function appsReady() {
    // ホームを開くたびに呼ぶので、アプリを読み込まずに決める：準備に要るプロパティ（apps.lock.json の readyProp → LB_APP_READY）が入っていれば使える
    var out = {}, need = typeof LB_APP_READY !== 'undefined' ? LB_APP_READY : {};
    appIds().forEach(function (k) {
      var m = LB_MODULES[k];
      if (m && m.broken) { out[k] = false; return; }
      // 準備ができている＝台帳 app_sheets にそのアプリの行がある（台帳に無ければ前の形のプロパティ）
      try { out[k] = need[k] ? !!LbStores.id(k, '', { legacyProp: need[k], peek: true }) : (m && typeof m.ready === 'function' ? !!m.ready() : true); } catch (e) { out[k] = false; }
    });
    return out;
  }

  /** 自動実行：移転した後の旧GAS では何もしない（新しい GAS が同じ記録を扱うので、二重に処理しない） */
  function job(fn) { return function () { if (LbMove.moved()) { console.log('移転ずみの旧GAS なので処理しません'); return []; } return fn(); }; }

  return { appsReady: appsReady, doGet: doGet, call: call, appApi: appApi, setup: setup,
    nightly: job(function () { var e = each('nightly'); e = e.concat(legacy()); e = e.concat(facts()); e = e.concat(directives()); e = e.concat(alerts()); return e.concat(usage()); }),
    weekly: job(weekly), daily: job(function () { return each('daily'); }),
    rollover: job(function () { return each('rollover'); }), continueAll: job(function () { return each('continueAll'); }) };
})();
