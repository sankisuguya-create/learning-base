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

  /** 名簿の見出し。左が正規名、右が受け付ける別名（今の算数TAハブの英語見出しも読む） */
  var ROSTER_HEAD = {
    mail: ['メール', 'email', 'mail'], grade: ['学年'], cls: ['組'], no: ['番号'],
    sei: ['姓'], mei: ['名'], seiKana: ['せい'], meiKana: ['めい'], name: ['氏名', '名前']
  };
  var TEACHER_HEAD = {
    mail: ['メール', 'email', 'mail'], sei: ['姓'], mei: ['名'], seiKana: ['せい'], meiKana: ['めい'],
    grade: ['学年'], cls: ['組']
  };

  /* ---------- ハブ ---------- */

  /**
   * ハブのスプレッドシート。スクリプトのプロパティ HUB_ID があればそれを開き、
   * 無ければ自分（このGASが付いているスプレッドシート）がハブだとみなす。
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
    var s = hub().getSheetByName(name);
    if (!s) {
      if (year === cur) throw new Error('ハブに名簿のシート「' + SHEET.ROSTER + '」がありません');
      return [];
    }
    var rows = readRoster(s.getDataRange().getValues());
    cachePut(key, rows);
    return rows;
  }

  function readRoster(v) {
    if (!v.length) return [];
    var col = headerIndex(v[0], ROSTER_HEAD);
    if (col.mail < 0) throw new Error('名簿の見出しに「メール」がありません');
    var out = [], seen = {};
    for (var i = 1; i < v.length; i++) {
      var mail = cell(v[i], col.mail).toLowerCase();
      if (!mail || mail.indexOf('@') < 0) continue;
      var sei = cell(v[i], col.sei), mei = cell(v[i], col.mei), full = cell(v[i], col.name);
      if (!sei && !mei && full) {
        var parts = full.split(/[\s　]+/);
        sei = parts[0]; mei = parts.slice(1).join(' ');
      }
      var r = {
        mail: mail, grade: Number(cell(v[i], col.grade)) || 0, cls: normCls(cell(v[i], col.cls)),
        no: Number(cell(v[i], col.no)) || 0, sei: sei, mei: mei,
        seiKana: cell(v[i], col.seiKana), meiKana: cell(v[i], col.meiKana)
      };
      r.name = (sei + (sei && mei ? ' ' : '') + mei).trim();
      if (seen[mail] === undefined) { seen[mail] = out.length; out.push(r); }
      else if (!out[seen[mail]].name && r.name) out[seen[mail]] = r;
    }
    return out;
  }

  /** 名簿にあって名前のある児童。無ければ null */
  function child(mail, year) {
    mail = String(mail || '').trim().toLowerCase();
    if (!mail) return null;
    var rows = roster(year);
    for (var i = 0; i < rows.length; i++) if (rows[i].mail === mail && rows[i].name) return rows[i];
    return null;
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

  function isOwner(mail) {
    try { return SpreadsheetApp.getActiveSpreadsheet().getOwner().getEmail().toLowerCase() === mail; }
    catch (e) { return false; }
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
    keys.forEach(function (k) {
      var n = Number(c.get(PREFIX + k)) || 0, del = [PREFIX + k];
      for (var i = 0; i < n; i++) del.push(PREFIX + k + ':' + i);
      c.removeAll(del);
    });
  }

  return {
    VER: VER, TEACHER_DOMAIN: TEACHER_DOMAIN, CHILD_DOMAIN: CHILD_DOMAIN,
    hub: hub, hubId: hubId, setHub: setHub,
    fy: fy, fyOf: fyOf,
    email: email, domainOf: domainOf, isTeacherDomain: isTeacherDomain, isChildDomain: isChildDomain, me: me,
    roster: roster, child: child, classKey: classKey, normCls: normCls,
    teachers: teachers, teacher: teacher, canSeeClass: canSeeClass,
    clearCache: clearCache,
    _readRoster: readRoster   // 検査用
  };
})();

/** エディタから実行：ハブを設定する（引数の代わりに下の行を書き換えて実行してもよい） */
function baseSetHub(urlOrId) { return Base.setHub(urlOrId); }
/** エディタから実行：名簿・担当の保存分を消す */
function baseClearCache() { Base.clearCache(); }
