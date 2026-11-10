// dist/server.js — 学習BASE のサーバー側のコード（tools/bundle.cjs が作る。直接直さない）
var LB_MODULES = (typeof LB_MODULES !== "undefined" && LB_MODULES) || {};
var LB_PLATFORM_TRIGGERS = true;   // 自動実行は読み込み係が置く（アプリは置かない）

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
    hub: hub, hubId: hubId, setHub: setHub,
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
    combine: combine, stats: stats, recent: recent, state: state, ingest: ingest, rebuild: rebuild, read: read };
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
 *     … 別の GAS で動くもの。開く先の URL は公開の目録に書かず、ハブの links シートの id=linkId の行の url を使う
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
      if (p.kind === 'app') { if (!/^[a-z][a-z0-9-]*$/.test(String(p.app || ''))) e.push(w + ' の app が不正'); }
      else if (p.kind === 'page') {
        var s = p.src || {};
        if (!s.repo || !s.path || !/^[0-9a-f]{7,40}$|^v[\w.\-]+$/.test(String(s.ver || ''))) e.push(w + ' の src は repo・path・ver（コミットかタグ）');
      } else if (p.kind === 'link') {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(String(p.linkId || ''))) e.push(w + ' の linkId（ハブの links シートの id）が不正');
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
  function readSettings(hubSs, classKey) {
    var out = { publish: {}, now: [] };
    var ps = hubSs.getSheetByName(PUB_SHEET);
    if (ps && ps.getLastRow() > 1) ps.getRange(2, 1, ps.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (clsCell(r[0]) === classKey && r[1]) out.publish[String(r[1])] = r[2] === true || String(r[2]).toUpperCase() === 'TRUE';
    });
    var ns = hubSs.getSheetByName(NOW_SHEET);
    if (ns && ns.getLastRow() > 1) ns.getRange(2, 1, ns.getLastRow() - 1, 5).getValues().forEach(function (r) {
      if (clsCell(r[0]) === classKey && r[1]) out.now.push({ page: String(r[1]), order: Number(r[2]) || 0, from: ymd(r[3]), to: ymd(r[4]) });
    });
    return out;
  }
  /**
   * スプレッドシートは「3-1」を日付（3月1日）に、「2026-11-10」を日付に変えてしまう。書く列は文字の書式にしてあるが、
   * 手で直した行・書式を付ける前の行のために、読む時も日付を元の形に戻す（算数TA の clsCell_ と同じ考え方）
   */
  function clsCell(v) {
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) return (v.getMonth() + 1) + '-' + v.getDate();
    return String(v == null ? '' : v).trim();
  }
  function ymd(v) {
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
      if (typeof Utilities !== 'undefined' && Utilities.formatDate) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
      return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
    }
    return String(v || '');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** 公開を切り替える（押すたびに保存）。その学級・そのページの行を書き換える（無ければ足す） */
  function setPublish(hubSs, classKey, pageId, on, by) {
    var sh = sheet(hubSs, PUB_SHEET, PUB_HEAD), v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (clsCell(v[i][0]) === classKey && String(v[i][1]) === pageId) { sh.getRange(i + 1, 1, 1, 5).setValues([[classKey, pageId, !!on, new Date(), by || '']]); return; }
    }
    sh.appendRow([classKey, pageId, !!on, new Date(), by || '']);
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

  /** 表を用意する。学級（1列目）と日付の列は文字の書式にする（「3-1」が日付に化けないように） */
  function sheet(ss, name, head) {
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, head.length).setValues([head]); }
    textCols(sh, head);
    return sh;
  }
  function textCols(sh, head) {
    var rows = Math.max(sh.getMaxRows ? sh.getMaxRows() : 1000, 1000);
    head.forEach(function (h, i) { if (h === '学級' || h === 'から' || h === 'まで') sh.getRange(1, i + 1, rows, 1).setNumberFormat('@'); });
  }

  return { SUBJECTS: SUBJECTS, NOW_MAX: NOW_MAX, validate: validate, isOn: isOn, inPeriod: inPeriod, home: home, teacherView: teacherView,
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

  function today() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }
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
   * ハブの links シート（算数TA のハブのリンク一覧。列：id / title / subtitle / url / grades / color / visible / order / sheet / place）。
   * ページの色（先生が選んだ色）と、別の GAS で動くページ（kind: link）の URL をここから取る。{ id: { url, color, subtitle } }
   */
  function hubLinks() {
    var sh = Base.hub().getSheetByName('links'), out = {};
    if (!sh || sh.getLastRow() < 2) return out;
    sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(function (r) {
      var id = String(r[0] || '').trim();
      if (id) out[id] = { url: String(r[3] || '').trim(), color: String(r[5] || '').trim(), subtitle: String(r[2] || '').trim() };
    });
    return out;
  }

  /**
   * ホームを開いた時の情報。
   * - 児童：本人の名前・学年・学級と、学級の設定（公開・いまの学習）
   * - 教師：扱える学級の一覧、選んだ学級の設定と児童の一覧（代わりに取り組む児童を選ぶため）
   * - 名簿にない人：おためし（学年を選んで見られる。記録はしない）
   */
  function boot(opt) {
    opt = opt || {};
    var m = Base.me(), out = { role: m.role, today: today(), pagesUrl: pagesUrl(), subjects: LbPages.SUBJECTS };
    try { out.links = hubLinks(); } catch (e) { out.links = {}; }
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
      var pick = cls.filter(function (x) { return x.key === opt.classKey; })[0] || cls[0];
      if (pick) {
        out.classKey = pick.key;
        out.settings = LbPages.readSettings(Base.hub(), pick.key);
        out.members = Base.members(pick.grade, pick.cls).map(function (r) {
          return { lid: r.lid, no: r.no, name: r.name, provisional: !!r.provisional };
        });
      }
      return out;
    }
    out.message = m.role === 'none' ? '学校のアカウントで ひらいてください' : 'なまえが まだ とうろく されていません。せんせいに つたえてね';
    return out;
  }

  function setPublish(classKey, pageId, on) {
    var m = requireClass(classKey);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(pageId))) throw new Error('ページの名前が不正です');
    LbPages.setPublish(Base.hub(), classKey, String(pageId), !!on, m.email);
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

  return { boot: boot, setPublish: setPublish, resetPublish: resetPublish, setNow: setNow, classesFor: classesFor, pagesUrl: pagesUrl };
})();

/* 画面（google.script.run）から呼ぶ入口 */
function homeBoot(opt) { return LbHome.boot(opt); }
function homeSetPublish(classKey, pageId, on) { return LbHome.setPublish(classKey, pageId, on); }
function homeResetPublish(classKey) { return LbHome.resetPublish(classKey); }
function homeSetNow(classKey, list) { return LbHome.setNow(classKey, list); }

// ===== アプリ tamath（sankisuguya-create/arithmetic-timeattack@0f1af68） =====
LB_MODULES["tamath"] = (function () {
var LB_APP_QUERY = "app=tamath";
var LB_RESOLVE_ = function (n) { return /^[A-Za-z][A-Za-z0-9]*$/.test(n) ? eval('typeof ' + n + " === 'function' ? " + n + ' : undefined') : undefined; };
// --- dist/multi/Core.gs ---
/**
 * Core.gs — 算数タイムアタック 共通エンジン
 *
 * 単元固有の知識をここに書かないこと。
 * 「この単元のときだけ」という分岐が現れたら、それは Unit.gs に置くべきもの。
 *
 * 必要なもの: 同じプロジェクトに UNIT を定義した Unit.gs があること。
 */

var SHEETS = {
  CONFIG: 'config', ROSTER: 'roster', CLASS: 'class_config',
  LOG: 'log', DAILY: 'daily', SUMMARY: 'summary',
  WCHILD: 'weak_child', WCLASS: 'weak_class',
  COOP: 'coop', COOPLOG: 'coop_log', COOPSAVE: 'coop_save',
  MISTAKES: 'mistakes', USED: 'used'
};

/**
 * log シートの列。[キー, ヘッダ名] の並びが正本 — 添字が列の位置（15列）。
 * 書き込み（submitSession の appendRow）・読み取り（集計・過年度・誤答展開）・
 * 1行目のヘッダ宣言（ensureSheets_ の defs）は全部ここから引く。
 * ハブ側には Core.gs が無いので、Analysis.gs の AN_LOG_COL_ / AN_LOG_WIDTH_ と
 * Archive.gs の AR_LOG_COL_ / AR_SHEETS_ が写しを持つ
 * — 一致は tests/analysis.test.cjs / past.test.cjs が検査する。
 * 列の挿入・並べ替えは既存の記録と写しを壊すので、単元・ハブ・テストを揃えて行うこと。
 */
var LOG_DEF_ = [
  ['TS', 'ts'], ['MAIL', 'email'], ['GRADE', '学年'], ['CLS', '組'], ['NO', '番号'], ['NAME', '氏名'],
  ['MODE', 'mode'], ['MNAME', 'モード名'], ['LIM', 'limit_sec'], ['CORRECT', 'correct'],
  ['ATTEMPTS', 'attempts'], ['MISS', 'miss_items'], ['SLOW', 'slow_items'], ['TSTAT', 'type_stats'], ['WRONG', 'wrong_items']
];
var LOG_COL_ = {}, LOG_HEAD_ = [];
LOG_DEF_.forEach(function (d, i) { LOG_COL_[d[0]] = i; LOG_HEAD_[i] = d[1]; });
var LOG_WIDTH_ = LOG_DEF_.length;

/** 全単元で共通の既定値。UNIT.defaults で上書きできる */
var BASE_DEFAULTS = {
  limit_sec: 60,      // 制限時間（秒）
  miss_limit: 3,      // 何回誤答したら正答を提示して次へ
  key_gap: 8,         // 画面キーの横間隔(px)
  teachers: '',       // 教師のメールアドレス（カンマ区切り）

  // 「遅い」は秒数の閾値で決めない。同じ学年・同じ型の児童の平均想起時間の
  // 分布（平均と標準偏差）と比べる（slowNorm_ / slowBand_）。
  // 秒の閾値は単元・型ごとに打鍵数と難しさが違うため1つに決まらず、
  // 決めた値も学級の実態と無関係な当てずっぽうになっていた。

  // 想起時間のばらつきの閾値（%）。標準偏差 ÷ 平均。
  // 秒ではなく比にするのは、閾値が単元の速さに依存しないようにするため
  // （九九と単位換算では平均が倍ちがうので、秒で決めるとどちらかで必ず外れる）。
  // 想起が自動化していれば 20〜30%程度。想起と計数が混ざると 50%を超える。
  wobble_pct: 40,

  // weak_child / weak_class の集計に使う期間（日）。0 なら全期間。
  // 全期間平均にすると、年間数百試行に対して直近の変化が1%程度に薄まり、
  // 伸びも落ちも見えなくなる。
  window_days: 30,

  // 協力プレイの見返し（児童画面の「前回の協力プレイ」）に「じぶん ○もん」を
  // 出すか。既定は出さない（「みんなで ○もん」だけ。教師画面の協力プレイタブで切り替え）。
  coop_mine: 0,

  // 児童の見返しに出す保存データ（クラスごと）。"クラス=保存ID" をカンマでつなぐ（例 "3-1=s0123abcd45"）。
  // 書かないクラスは、そのクラスの直前の回を出す（教師画面の協力プレイタブ「見返す回」で選ぶ。coopSetReview）
  coop_rv: '',

  // モードごとの育ちの倍率（背景の床と協力プレイの図形）。"モード:倍率" をカンマでつなぐ（例 "3:2,7:1.5"）。
  // 書かないモードは単元の UNIT.growWeights、それも無ければ1倍。0.5〜3倍に丸める（growWeights_）
  grow_w: ''
};

var TTL = { config: 60, roster: 300, session: 21600, index: 30 };
var QN = 200;                              // 1セッションの出題数
var SCHEMA_VERSION = 7;                    // 2 = kind/best_count / 3 = モード名列・見やすい表示 / 4 = roster 注記（名簿外はおためし） / 5 = 年度ロールオーバー用トリガー / 6 = 協力モードのシート / 7 = 記録済み token の used シート
var STAR_MAX = 99;                         // 個人内評価（自己ベスト更新回数）の上限

/**
 * Core.gs と共通画面（index.html / teacher.html）の間の版の番号。
 * Core が画面に新しい関数や返却値を要求されたとき、または画面が Core の
 * 新しい応答を前提にするときに1ずつ上げる。画面側は同じ番号を WANT_VER として持ち、
 * 食い違いがあれば「貼り直し」を画面に出す（片方だけ古いまま動き続けるのを防ぐ）。
 */
var ENGINE_VER = 10;   // 10 = 別記録版モード（modes[].pair）・図なし切り替え / 9 = 正答回数の図（unit.menuFigure・floor.tcm/gw） / 8 = 特殊枠・素数選択・順不同採点 / 7 = 筆算の並べ方（col） / 6 = 署名つき token（キャッシュが消えても採点できる） / 2 = 「遅い」を学年・型の分布との比較に（slowTk をやめ、型ごとに段階 b を返す） / 3 = 協力モード
                      // 3 = 協力モード（boot/startSession が coop を返す。教師API coop*）
                      // 4 = coopPeek（児童画面の定期確認。開いたままの画面に印をすぐ出す）
                      // 5 = getPastYears（教師画面の過年度タブ）
/**
 * 教師のドメイン。ここに属するアカウントは、名簿になくても教師として扱う。
 *
 * **児童は @kyoiku.edu.nishi.or.jp で、教師ドメインのサブドメインになっている。**
 * 「edu.nishi.or.jp を含む」で判定すると児童が全員教師になり、
 * weak_child（誰がどの型で遅いか）まで児童の画面から開けてしまう。
 * @ の右側の完全一致でだけ判定すること。
 */
var TEACHER_DOMAIN = 'edu.nishi.or.jp';

function defaults_() {
  var d = {};
  for (var k in BASE_DEFAULTS) d[k] = BASE_DEFAULTS[k];
  var u = UNIT.defaults || {};
  for (var k2 in u) d[k2] = u[k2];
  return d;
}

/* ============================================================
 *  基盤
 * ============================================================ */

function ss_() { return isMulti_() ? unitSpreadsheet_() : SpreadsheetApp.getActiveSpreadsheet(); }
function cache_() { return isMulti_() ? nsCache_(UNIT.id) : CacheService.getScriptCache(); }
/** スクリプトのプロパティ。全単元をまとめたプロジェクトでは、名前の頭に単元の id を付けて分ける */
function props_() { return isMulti_() ? nsProps_(UNIT.id) : PropertiesService.getScriptProperties(); }

/* ============================================================
 *  全単元を1つの GAS にまとめる（UNIT_DEFS に2単元以上がある時）
 *
 *  単元が1つだけのプロジェクト（今までの設置）では、ここは何もしない。
 *  まとめたプロジェクトでは：
 *    - URL の ?unit=<id> で単元を選ぶ（doGet）
 *    - 画面からの呼び出しは apiCall(<id>, 関数名, 引数) を通り、呼ぶ前に UNIT を差し替える
 *    - 記録は単元ごとのスプレッドシート（今までの単元のスプレッドシートをそのまま使う）
 *    - 一時保存・プロパティの名前は単元ごとに分ける
 *    - 毎晩・毎朝の処理は全単元について回す（*All）
 * ============================================================ */

function isMulti_() {
  return typeof UNIT_DEFS !== 'undefined' && Object.keys(UNIT_DEFS).length > 1;
}

/** この実行で使う単元を決める。知らない id なら止める */
function useUnit_(id) {
  id = String(id || '');
  if (typeof UNIT_DEFS === 'undefined' || !Object.prototype.hasOwnProperty.call(UNIT_DEFS, id)) {
    throw new Error('単元がありません: ' + id);
  }
  UNIT = UNIT_DEFS[id];
  return UNIT;
}

function unitIds_() { return typeof UNIT_DEFS === 'undefined' ? [] : Object.keys(UNIT_DEFS); }
/** 検査用（学習BASE の中で apiCall が包んだ中の関数を見つけられるかを確かめる）。単元の id の一覧を返すだけ */
function unitIdsForTest() { return unitIds_(); }

/** 単元のスプレッドシートの ID を置く場所（単元で分けない、プロジェクト共通のプロパティ） */
function unitSheetKey_(id) { return 'unit_sheet:' + id; }

var UNIT_SS_MEMO_ = {};
/**
 * いまの単元のスプレッドシート。登録が無ければ新しく作って登録する。
 * 同じ実行の中で開き直しても 2ms 程度（実測 2026-11-05）だが、1回の実行で何十回も呼ぶので覚えておく。
 */
function unitSpreadsheet_() {
  var id = UNIT.id;
  if (UNIT_SS_MEMO_[id]) return UNIT_SS_MEMO_[id];
  var gp = PropertiesService.getScriptProperties(), sid = gp.getProperty(unitSheetKey_(id));
  var ss;
  if (sid) {
    ss = SpreadsheetApp.openById(sid);
  } else {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      sid = gp.getProperty(unitSheetKey_(id));
      if (sid) ss = SpreadsheetApp.openById(sid);
      else {
        ss = SpreadsheetApp.create('算数TA ' + (UNIT.teacherTitle || UNIT.title || id) + '（' + id + '）');
        gp.setProperty(unitSheetKey_(id), ss.getId());
        clearUnitReady_(id);
      }
    } finally { lock.releaseLock(); }
  }
  UNIT_SS_MEMO_[id] = ss;
  return ss;
}

/**
 * 移行：今までの単元のスプレッドシートを、まとめたプロジェクトに登録する（エディタから単元ごとに1回）。
 * 例：registerUnitSheet('kuku', 'https://docs.google.com/spreadsheets/d/xxxx/edit')
 * 記録はそのスプレッドシートに書き続ける（移し替えない）。
 */
function registerUnitSheet(id, urlOrId) {
  ownerOnly_();
  useUnit_(id);
  var s = String(urlOrId || '').trim(), m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/), sid = m ? m[1] : s;
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(sid)) throw new Error('スプレッドシートのURLかIDを入れてください: ' + s);
  var ss = SpreadsheetApp.openById(sid);   // 開けなければここで止まる
  PropertiesService.getScriptProperties().setProperty(unitSheetKey_(id), sid);
  delete UNIT_SS_MEMO_[id];
  clearUnitReady_(id);
  return id + ' → ' + ss.getName();
}

/**
 * 移行：ハブの links シートの sheet 列（単元の記録スプレッドシート）から、全単元をまとめて登録する（エディタから1回）。
 * links の id が単元の id と一致する行だけを使う。結果の一覧を返す（登録できなかった単元も書く）。
 */
function importUnitSheetsFromHub() {
  ownerOnly_();
  var v = hubLinks_(), out = [], done = {};
  for (var i = 1; i < v.length; i++) {
    var id = String(v[i][0]).trim(), sheet = String(v[i][8] || '').trim();
    if (!id || !Object.prototype.hasOwnProperty.call(UNIT_DEFS, id)) continue;
    if (!sheet) { out.push(id + '\t× links の sheet 列が空'); continue; }
    try { out.push(id + '\t○ ' + registerUnitSheet(id, sheet)); done[id] = true; }
    catch (e) { out.push(id + '\t× ' + e.message); }
  }
  unitIds_().forEach(function (id) { if (!done[id] && !out.some(function (l) { return l.indexOf(id + '\t') === 0; })) out.push(id + '\t- links に行が無い（最初に開いた時に新しいスプレッドシートを作る）'); });
  console.log(out.join('\n'));   // エディタから実行した時は、返り値ではなくこのログだけが見える
  return out.join('\n');
}

/**
 * 移行：ハブの links シートの url 列を、まとめたプロジェクトの ?unit=<id> に書き換える（エディタから1回）。
 * 書き換える前の links シートを links_backup に写して残す。戻す時は restoreHubLinks。
 */
function switchHubLinks() {
  ownerOnly_();
  var hub = Base.hub(), sh = hub.getSheetByName('links');
  if (!sh) throw new Error('ハブに links シートがありません');
  var v = sh.getDataRange().getValues();
  if (hub.getSheetByName('links_backup')) throw new Error('links_backup が既にあります（戻すなら restoreHubLinks、やり直すなら links_backup を消してから）');
  var bk = hub.insertSheet('links_backup');
  bk.getRange(1, 1, v.length, v[0].length).setValues(v);
  var base = ScriptApp.getService().getUrl(), out = [];
  if (!base) throw new Error('先にこのプロジェクトをウェブアプリとしてデプロイしてください');
  for (var i = 1; i < v.length; i++) {
    var id = String(v[i][0]).trim();
    if (!Object.prototype.hasOwnProperty.call(UNIT_DEFS, id)) continue;
    var u = unitHref_(base, id);
    sh.getRange(i + 1, 4).setValue(u);
    out.push(id + '\t' + u);
  }
  var msg = out.join('\n') + '\n（ハブの links の保存は最大1分で切り替わる）';
  console.log(msg);
  return msg;
}

/** switchHubLinks を取り消す：links_backup の url 列を links に戻す */
function restoreHubLinks() {
  ownerOnly_();
  var hub = Base.hub(), sh = hub.getSheetByName('links'), bk = hub.getSheetByName('links_backup');
  if (!sh || !bk) throw new Error('links または links_backup がありません');
  var b = bk.getDataRange().getValues(), cur = sh.getDataRange().getValues(), byId = {}, n = 0;
  for (var i = 1; i < b.length; i++) byId[String(b[i][0]).trim()] = b[i][3];
  for (var j = 1; j < cur.length; j++) {
    var id = String(cur[j][0]).trim();
    if (Object.prototype.hasOwnProperty.call(byId, id)) { sh.getRange(j + 1, 4).setValue(byId[id]); n++; }
  }
  console.log(n + ' 行の url を戻した（links_backup は残してある）');
  return n + ' 行の url を戻した（links_backup は残してある）';
}

function hubLinks_() {
  if (!hubRoster_()) throw new Error('先にスクリプトのプロパティ HUB_ID にハブのスプレッドシートの ID を入れてください');
  var sh = Base.hub().getSheetByName('links');
  if (!sh) throw new Error('ハブに links シートがありません');
  return sh.getDataRange().getValues();
}

/**
 * setup が作ってしまった空のスプレッドシートの登録を外す（エディタから実行）。
 * 外すのは「今までの単元のスプレッドシート」ではないもの、つまりハブの links の sheet 列と違う登録だけ。
 * 外した後、ドライブの「算数TA …（<id>）」は手で消してよい。
 */
function forgetCreatedUnitSheets() {
  ownerOnly_();
  var v = hubLinks_(), want = {}, gp = PropertiesService.getScriptProperties(), out = [];
  for (var i = 1; i < v.length; i++) {
    var m = String(v[i][8] || '').match(/\/d\/([a-zA-Z0-9_-]{20,})/), raw = String(v[i][8] || '').trim();
    want[String(v[i][0]).trim()] = m ? m[1] : raw;
  }
  unitIds_().forEach(function (id) {
    var sid = gp.getProperty(unitSheetKey_(id));
    if (sid && sid !== want[id]) { gp.deleteProperty(unitSheetKey_(id)); clearUnitReady_(id); out.push(id + '\t登録を外した（' + sid + '）'); }
  });
  var msg = out.length ? out.join('\n') : '外す登録はなかった';
  console.log(msg);
  return msg;
}

/** 登録の一覧（エディタから実行して確かめる） */
function listUnitSheets() {
  ownerOnly_();
  var gp = PropertiesService.getScriptProperties();
  var msg = unitIds_().map(function (id) {
    var sid = gp.getProperty(unitSheetKey_(id));
    if (!sid) return id + '\t（未登録：最初に開いた時に新しく作る）';
    var name = '';
    try { name = SpreadsheetApp.openById(sid).getName(); } catch (e) { name = '× 開けません'; }
    return id + '\t' + name + '\t' + sid;
  }).join('\n');
  console.log(msg);
  return msg;
}

/**
 * エディタ用の関数は、名前が _ で終わらないので画面（google.script.run）からも直接呼べてしまう。
 * 所有者がエディタで実行した時だけ動かす（「自分として実行」では、開いた人と所有者が違う）。
 */
function ownerOnly_() {
  var a = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var e = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!a || a !== e) throw new Error('この関数は、スプレッドシートの所有者が Apps Script のエディタから実行してください');
}

/**
 * 単元の「準備済み」の印を消す。登録するスプレッドシートを付け替えた時に呼ぶ。
 * 印は単元ごとに持つので、消さないと新しいスプレッドシートにシートを作らないまま「準備済み」と見なす
 * （2026-11-06 本番：付け替えた後の九九で「シートが見つかりません: config」）。
 */
function clearUnitReady_(id) {
  nsProps_(id).deleteProperty(READY_KEY);
  nsCache_(id).remove('ready');
}

/* ------------------------------------------------------------
 *  学習BASE（learning-base の読み込み係）の中で動く時
 *  読み込み係は、このファイルを関数の中に包んで実行し、次の大域の名前を用意する。単体の GAS ではどれも未定義で、今までどおり動く。
 *    LB_FILES        画面のファイル（'tamath/index' など）。GAS のファイルの代わりにここから読む
 *    LB_APP_QUERY    URL に付ける 'app=tamath'（学習BASE の URL は1つなので、どのアプリかを示す）
 *    LB_PLATFORM_TRIGGERS  true なら自動実行は読み込み係が置く（ここでは置かない）
 *  包んだ関数の中の LB_RESOLVE_ は、画面から呼ぶ関数を名前で探す（包むと関数が globalThis に載らないため）
 * ------------------------------------------------------------ */
function lbFile_(name) {
  return (typeof LB_FILES !== 'undefined' && LB_FILES && LB_FILES['tamath/' + name] != null) ? LB_FILES['tamath/' + name] : null;
}
function tplFromFile_(name) {
  var src = lbFile_(name);
  var t = src != null ? HtmlService.createTemplate(src) : HtmlService.createTemplateFromFile(name);
  // テンプレートの <?!= ?> は大域の名前しか見えない。学習BASE ではこのファイルが関数の中に包まれて
  // UNIT などが大域に出ないので、テンプレートが使う名前をテンプレートに直接渡す（単体の GAS でも害はない）。
  // 2026-11-10 本番：渡さなかったため「UNIT is not defined」。multiShim_ は typeof で確かめているので、
  // 渡さないとエラーにならずに差し替えが抜け、画面からサーバーを呼べなくなる
  t.UNIT = UNIT;
  t.include = include;
  t.floorGenForTeacher_ = floorGenForTeacher_;
  t.multiShim_ = multiShim_;
  return t;
}
function appQuery_() { return typeof LB_APP_QUERY !== 'undefined' && LB_APP_QUERY ? String(LB_APP_QUERY) : ''; }
function unitHref_(base, id) { var a = appQuery_(); return base + '?' + (a ? a + '&' : '') + 'unit=' + encodeURIComponent(id); }

/* ------------------------------------------------------------
 *  学習BASE の新しい形の記録（LbSession）・技能の目録（LbCatalog）
 *  学習BASE の中（LbSession・Base がある時）だけ書く。単体の GAS では何もしない。
 * ------------------------------------------------------------ */
/** 技能のキー：math/<単元>/<型>（型は Unit.gs の types のキー） */
function lbSkill_(t) { return 'math/' + UNIT.id + '/' + t; }
/**
 * 1問ぶん。ok は「一度で正答したか」（やり直して当たったものは正答に数えない。type_stats と同じ基準）。
 * 時間は一度で正答した問題の「最初のキーまで」だけ（間違えた問題の時間は想起の速さを表さない）
 */
function lbItem_(it, qq, hist, hit, firstTry) {
  var last = hist.length ? hist[hist.length - 1] : null, tk = Number(it.tk) || 0;
  var o = { i: Number(it.i), q: String(qq.tag), t: String(qq.t), a: last ? last.join('/') : '', tries: hist.length, hit: !!hit, ok: !!firstTry, skill: lbSkill_(qq.t) };
  if (firstTry && tk > 0) o.first = tk;
  return o;
}
function lbWriteSession_(s, mail, isPractice, items) {
  if (typeof LbSession === 'undefined' || typeof Base === 'undefined' || !hubRoster_()) return false;
  var learner = ACT_.learner || Base.child(mail);
  if (!learner || !learner.lid) return false;                     // 名簿にない人（おためし）は書かない
  return LbSession.write(ss_(), {
    ts: new Date(), lid: learner.lid, mail: learner.mail || '', app: 'tamath', activity: UNIT.id + '/' + s.mode,
    context: isPractice ? 'practice' : 'live', ver: String(ENGINE_VER), items: items
  }, { learner: learner, by: ACT_.by || '', catalog: tamathCatalog_() }).ok;
}
/** 単元を決めて新しい形の記録を書く（学習BASE の検査が使う。名前が _ で終わるので画面からは呼べない） */
function lbWriteForUnit_(unit, s, mail, isPractice, items) { useUnit_(unit); return lbWriteSession_(s, mail, isPractice, items); }
/** 算数TA の技能の目録（全単元の型）。到達の基準の初期値は正答率90%・20問以上（単元ごとに Unit.gs の mastery で直せる） */
function tamathCatalog_() {
  var skills = [];
  unitIds_().forEach(function (id) {
    var u = UNIT_DEFS[id], types = u.types || {};
    Object.keys(types).forEach(function (t) {
      var sk = { key: 'math/' + id + '/' + t, label: (u.title ? String(u.title).replace(/\s*タイムアタック.*$/, '') + '：' : '') + String(types[t]), grade: Number(u.grade) || 0 };
      if (u.mastery) sk.mastery = u.mastery;
      skills.push(sk);
    });
  });
  return { app: 'tamath', title: '算数タイムアタック', version: ENGINE_VER, skills: skills, mastery: { minN: 20, acc: 0.9, gmMs: 0, windowWeeks: 4 }, directives: [] };
}
/** 集計が読む記録先（登録済みの単元のスプレッドシート）。学習BASE の夜の処理が使う */
function lbSessionSources_() {
  var gp = PropertiesService.getScriptProperties(), out = [];
  unitIds_().forEach(function (id) {
    var sid = gp.getProperty(unitSheetKey_(id));
    if (!sid) return;
    try { out.push({ app: 'tamath', key: 'tamath:' + id, ss: SpreadsheetApp.openById(sid) }); } catch (e) { console.error(id + ' を開けません: ' + e.message); }
  });
  return out;
}

/** 名前の頭に単元の id を付ける CacheService（今までの呼び方 get/put/remove/…All をそのまま使える） */
function nsCache_(id) {
  var c = CacheService.getScriptCache(), p = 'u:' + id + ':';
  function pre(keys) { return keys.map(function (k) { return p + k; }); }
  return {
    get: function (k) { return c.get(p + k); },
    put: function (k, v, t) { return t === undefined ? c.put(p + k, v) : c.put(p + k, v, t); },
    remove: function (k) { return c.remove(p + k); },
    getAll: function (keys) {
      var got = c.getAll(pre(keys)), out = {};
      keys.forEach(function (k) { if (got[p + k] != null) out[k] = got[p + k]; });
      return out;
    },
    putAll: function (m, t) { var o = {}; for (var k in m) o[p + k] = m[k]; return t === undefined ? c.putAll(o) : c.putAll(o, t); },
    removeAll: function (keys) { return c.removeAll(pre(keys)); }
  };
}

/** 名前の頭に単元の id を付ける ScriptProperties */
function nsProps_(id) {
  var g = PropertiesService.getScriptProperties(), p = 'u:' + id + ':';
  return {
    getProperty: function (k) { return g.getProperty(p + k); },
    setProperty: function (k, v) { g.setProperty(p + k, v); return this; },
    deleteProperty: function (k) { g.deleteProperty(p + k); return this; }
  };
}

/**
 * 画面からの呼び出しの入口（まとめたプロジェクトだけで使う）。
 * 画面の google.script.run.xxx(…) は、画面側の差し替え（multiShim_）でここに来る。
 * 呼べるのは、今まで画面から直接呼べた関数（プロジェクトに書いた、名前が _ で終わらない大域の関数）と同じ範囲。
 * 組み込みの関数（eval など）は呼ばせない（呼べると、画面から任意のコードを所有者の権限で動かせてしまう）。
 */
var API_DENY_ = { apiCall: 1, doGet: 1, setup: 1, registerUnitSheet: 1, listUnitSheets: 1,
  nightlyAggregate: 1, rolloverRoster: 1, resetDaily: 1, nightlyAggregateAll: 1, rolloverRosterAll: 1, resetDailyAll: 1,
  continueAll: 1, include: 1, checkUnit: 1, baseSetHub: 1, baseClearCache: 1,
  importUnitSheetsFromHub: 1, switchHubLinks: 1, restoreHubLinks: 1, forgetCreatedUnitSheets: 1 };
function apiCall(unitId, name, args) {
  var uk = parseUnitKey_(unitId);
  useUnit_(uk.unit);
  if (uk.as) setActAs_(uk.as);
  name = String(name || '');
  var fn = typeof LB_RESOLVE_ === 'function' ? LB_RESOLVE_(name) : globalThis[name];
  // 組み込みの関数（eval・Function など）は呼ばせない。GAS が画面から呼ばせるのも、プロジェクトに書いた関数だけ
  var native = typeof fn === 'function' && /\[native code\]/.test(Function.prototype.toString.call(fn));
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || API_DENY_[name] || typeof fn !== 'function' || native) {
    throw new Error('呼べない関数です: ' + name);
  }
  return fn.apply(null, Array.isArray(args) ? args : []);
}

/**
 * 画面の google.script.run を、apiCall を通るものに差し替える小さな script。
 * index.html / teacher.html の head でテンプレートとして埋め込む。単元が1つのプロジェクトでは空。
 * withSuccessHandler / withFailureHandler / withUserObject のつなぎ方は今までどおり使える。
 */
function multiShim_() {
  if (!isMulti_()) return '';
  return '<script>(function(){' +
    'if(typeof google==="undefined"||!google.script||!google.script.run)return;' +
    'var real=google.script.run,KEY=' + JSON.stringify(String(UNIT.id) + (ACT_.lid ? '|as=' + ACT_.lid : '')) + ';' +
    'var W={withSuccessHandler:1,withFailureHandler:1,withUserObject:1};' +
    'function mk(h){return new Proxy({},{get:function(t,k){' +
    'if(W[k])return function(f){var n={};for(var x in h)n[x]=h[x];n[k]=f;return mk(n);};' +
    'return function(){var r=real;for(var x in h)r=r[x](h[x]);' +
    'return r.apiCall(KEY,k,Array.prototype.slice.call(arguments));};}});}' +
    'try{Object.defineProperty(google.script,"run",{value:mk({}),configurable:true,writable:true});}' +
    'catch(e){google.script.run=mk({});}})();</script>';
}

/** この単元の画面の URL。まとめたプロジェクトでは ?unit=<id> を付ける */
function unitUrl_(extra) {
  var u = '';
  try { u = ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
  if (!u) return '';
  var q = [];
  if (appQuery_()) q.push(appQuery_());
  if (isMulti_()) q.push('unit=' + encodeURIComponent(UNIT.id));
  if (extra) q.push(extra);
  return q.length ? u + (u.indexOf('?') >= 0 ? '&' : '?') + q.join('&') : u;
}

/**
 * 毎晩・毎朝の処理を全単元について回す。1単元が失敗しても他は続ける。
 * 1回の実行は6分で止められる（GAS の上限）。単元ごとのプロジェクトでは単元ごとに6分あったが、
 * まとめると全単元で6分になる。そこで4分半を越えたら残りの単元をプロパティに残し、
 * 1分後に continueAll で続きを回す（残りが無くなるまで繰り返す）。
 */
var ALL_BUDGET_MS_ = 270 * 1000;
var ALL_TODO_KEY_ = 'all_todo';
var ALL_JOBS_ = {
  nightlyAggregate: function () { nightlyAggregate(); },
  rolloverRoster: function () { rolloverRoster(new Date()); },
  resetDaily: function () { resetDaily(); }
};
function runAll_(job, ids) {
  var gp = PropertiesService.getScriptProperties(), start = Date.now(), errs = [];
  ids = (ids || unitIds_()).slice();
  while (ids.length) {
    if (Date.now() - start > ALL_BUDGET_MS_) {
      var todo = {};
      try { todo = JSON.parse(gp.getProperty(ALL_TODO_KEY_) || '{}'); } catch (e) {}
      todo[job] = ids;
      gp.setProperty(ALL_TODO_KEY_, JSON.stringify(todo));
      ScriptApp.newTrigger('continueAll').timeBased().after(60 * 1000).create();
      break;
    }
    var id = ids.shift();
    // スプレッドシートが未登録の単元（まだ誰も開いていない）は飛ばす。夜の処理で空のスプレッドシートを作らない
    if (!gp.getProperty(unitSheetKey_(id))) continue;
    try { useUnit_(id); ALL_JOBS_[job](); }
    catch (e) { errs.push(id + ': ' + (e && e.message || e)); console.error(job + ' ' + id + ' 失敗: ' + (e && e.message || e)); }
  }
  return errs;
}
function nightlyAggregateAll() { return runAll_('nightlyAggregate'); }
function rolloverRosterAll() { return runAll_('rolloverRoster'); }
function resetDailyAll() { return runAll_('resetDaily'); }
/** 時間切れで残った単元の続き（runAll_ が1回だけの自動実行で呼ぶ） */
function continueAll() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'continueAll') ScriptApp.deleteTrigger(t);
  });
  var gp = PropertiesService.getScriptProperties(), todo = {};
  try { todo = JSON.parse(gp.getProperty(ALL_TODO_KEY_) || '{}'); } catch (e) {}
  gp.deleteProperty(ALL_TODO_KEY_);
  var errs = [];
  Object.keys(todo).forEach(function (job) {
    if (ALL_JOBS_[job]) errs = errs.concat(runAll_(job, todo[job].filter(function (id) { return unitIds_().indexOf(id) >= 0; })));
  });
  return errs;
}

/** 名簿をハブから Base.gs で読むか（Base.gs が貼られ、ハブが設定されている時） */
function hubRoster_() {
  try { return typeof Base !== 'undefined' && !!Base.hubId(); } catch (e) { return false; }
}

/** 全単元をまとめたプロジェクトで、単元を選ばずに開いた時の一覧 */
function unitIndexPage_() {
  var base = '';
  try { base = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  var items = unitIds_().map(function (id) {
    var u = UNIT_DEFS[id];
    return '<li><a href="' + unitHref_(base, id) + '">' + String(u.title || id).replace(/[<>&]/g, '') + '</a></li>';
  }).join('');
  return HtmlService.createHtmlOutput('<base target="_top"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<div style="font-family:sans-serif;font-size:20px;line-height:2;padding:16px"><ul>' + items + '</ul></div>').setTitle('算数タイムアタック');
}

function sh_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) throw new Error('シートが見つかりません: ' + name);
  return s;
}

function email_() {
  // 教師が児童の代わりに取り組んでいる時は、その児童として振る舞う（setActAs_ で確かめた後だけ）。
  // メールの無い転入生は 'lid:<学習者ID>' を本人のメールの代わりに使う（今の記録の列に入る）
  if (ACT_.learner) return ACT_.learner.mail || ('lid:' + ACT_.learner.lid);
  var e = Session.getActiveUser().getEmail();
  return e ? e.toLowerCase() : '';
}

/* ------------------------------------------------------------
 *  代わりに取り組む（学習BASE の中だけ）
 *  教師が学習BASE で児童を選ぶと、URL に &as=<学習者ID> が付く。画面からの呼び出しでは、単元の欄に
 *  'kuku|as=<学習者ID>' として載る（読み込み係の呼び出しの形を変えずに運ぶため）。
 *  実行のたびに Base.actAs で「開いた人が教師で、その学級を見てよいか」を確かめ、通った時だけ児童として振る舞う。
 * ------------------------------------------------------------ */
var ACT_ = { lid: '', learner: null, by: '' };
function setActAs_(lid) {
  lid = String(lid || '').trim();
  if (!lid) return;
  if (typeof Base === 'undefined' || !hubRoster_()) throw new Error('代わりに取り組むは、学習BASE の中でだけ使えます');
  var r = Base.actAs(lid);                   // 教師でない・担当外・名簿にいない なら止まる
  ACT_ = { lid: lid, learner: r.learner, by: r.by };
}
/** 'kuku|as=L…' を { unit, as } に分ける */
function parseUnitKey_(k) {
  var s = String(k || ''), i = s.indexOf('|as=');
  return i < 0 ? { unit: s, as: '' } : { unit: s.slice(0, i), as: s.slice(i + 4) };
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** log の ts を数値時刻にする。読めなければ 0（＝期間窓で捨てない側に倒す） */
function rowTime_(x) {
  if (x instanceof Date) return x.getTime();
  var d = new Date(x);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/** シートが日付を Date に変換していても文字列比較できるようにする */
function dstr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v);
}

function domainOf_(mail) {
  var at = String(mail || '').lastIndexOf('@');
  return at < 0 ? '' : String(mail).slice(at + 1);
}

function isTeacherDomain_(mail) { return domainOf_(mail) === TEACHER_DOMAIN; }

/**
 * 名簿になくても試用できる（記録しない＝分析の対象にもならない）。
 * 教師ドメインに限らず、ログインしている全員。
 * 名簿にない児童は「おためし」として全モードを使える。記録されないので、
 * 転入直後や他学年の児童が触っても分析は濁らない。
 */
function isGuest_(mail) { return !!mail; }

function toBool_(x) {
  if (x === true) return true;
  if (x === false || x === '' || x == null) return false;
  var s = String(x).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes' || s === '○';
}

function config_() {
  var hit = cache_().get('config');
  if (hit) return JSON.parse(hit);

  var def = defaults_(), c = {};
  for (var k in def) c[k] = def[k];
  var v = sh_(SHEETS.CONFIG).getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    var key = String(v[i][0]).trim();
    if (!key) continue;
    c[key] = (typeof def[key] === 'number') ? Number(v[i][1]) : v[i][1];
  }
  cache_().put('config', JSON.stringify(c), TTL.config);
  return c;
}

function isTeacher_(mail) {
  if (!mail) return false;
  if (isTeacherDomain_(mail)) return true;          // 設定を読まずに済むので先に見る
  try { if (mail === ss_().getOwner().getEmail().toLowerCase()) return true; } catch (e) {}
  // config.teachers は例外の口。別ドメインの教師（支援員・非常勤など）を1件ずつ足す
  var list = String(config_().teachers || '').toLowerCase().split(',');
  for (var i = 0; i < list.length; i++) if (list[i].trim() === mail) return true;
  return false;
}

/** いまの年度（4月始まり）を返す */
function curSchoolYear_() { return fyOfTime_(Date.now()); }

/** その時刻が属する年度（4月始まり。月の境目はスクリプトのタイムゾーンで見る）。読めなければ 0。年度の境目の正本 */
function fyOfTime_(ts) {
  if (!ts) return 0;
  var d = new Date(ts), tz = Session.getScriptTimeZone();
  var y = Number(Utilities.formatDate(d, tz, 'yyyy')), m = Number(Utilities.formatDate(d, tz, 'M'));
  return m >= 4 ? y : y - 1;
}

/** 年度のはじめ（4/1 0:00）の時刻。年度の境目はここと fyOfTime_ の2箇所にだけ書く */
function fyStartMs_(fy) { return new Date(fy, 3, 1).getTime(); }

/**
 * 名簿の行を正規化して返す。{ mail, grade, cls, no, name } の配列。
 *
 * fy を省略すると現在年度（roster シート）。fy を渡すとその年度の名簿:
 *   - fy === 現在年度      → roster（ライブ。新しい児童がすぐ乗る）
 *   - 過去年度で roster_<fy> あり → そのシート（年度アーカイブ）
 *   - 過去年度で roster_<fy> なし → []（呼び出し側が log の行から組み立てる）
 *
 * 学年ごとのハブから複数の IMPORTRANGE を縦積みで取り込むと、
 * 各ソースのヘッダ行が途中に混ざるので、'@' を含まない行（ヘッダ・空行）を除く。
 * 氏名の有無はここでは見ない（見るのは呼び出し側）。
 */
function rosterRows_(fy) {
  if (fy === undefined) fy = curSchoolYear_();
  if (hubRoster_()) {
    // ハブの名簿を Base.gs で読む（IMPORTRANGE をやめる）。過去年度はハブの roster_<年度>、
    // 無ければ今までどおり単元のスプレッドシートの roster_<年度>（4/1 に単元ごとに残していた分）
    var hr = Base.roster(fy).map(function (r) { return { mail: r.mail || (r.lid ? 'lid:' + r.lid : ''), grade: r.grade, cls: r.cls, no: r.no, name: r.name }; })
      .filter(function (r) { return r.mail; });   // メールの無い転入生は 'lid:<学習者ID>'（代わりに取り組んだ記録の本人）
    if (hr.length || fy === curSchoolYear_()) return hr;
  }
  var s;
  if (fy === curSchoolYear_()) {
    s = sh_(SHEETS.ROSTER);                    // 現在年度は常にライブの roster
  } else {
    s = ss_().getSheetByName('roster_' + fy); // 過去年度は年度名簿だけ（無ければ無い）
    if (!s) return [];
  }
  var v = s.getDataRange().getValues();
  var out = [], seen = {};
  for (var i = 1; i < v.length; i++) {
    var mail = String(v[i][0] || '').trim().toLowerCase();
    if (!mail || mail.indexOf('@') < 0) continue;
    var r = { mail: mail, grade: Number(v[i][1]),
              cls: String(v[i][2] || '').trim(), no: Number(v[i][3]),
              name: String(v[i][4] || '').trim() };
    // 同じ児童が複数のハブの名簿に載っていると、縦積みで行が重複する。
    // 正本は先に出てきた行。ただし先の行が氏名なし・後の行が氏名ありなら
    // 後の行を使う（記録・分析の対象になる児童を消さないため）
    if (seen[mail] === undefined) { seen[mail] = out.length; out.push(r); }
    else if (!out[seen[mail]].name && r.name) out[seen[mail]] = r;
  }
  return out;
}

function child_(mail) {
  if (!mail) return null;
  var key = 'roster_' + mail;
  var hit = cache_().get(key);
  if (hit) return JSON.parse(hit);

  var rows = rosterRows_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].mail === mail) {
      // 氏名の無い登録は記録・分析の対象にしない。本人はゲストとして使える
      var r = rows[i];
      if (!r.name) continue;
      var c = { email: mail, grade: r.grade, cls: r.cls, no: r.no, name: r.name };
      cache_().put(key, JSON.stringify(c), TTL.roster);
      return c;
    }
  }
  return null;   // 未登録はキャッシュしない（名簿追加が即反映されるように）
}

/**
 * 名簿に email と氏名の両方がある児童のメール集合。{ mail: true }
 * 記録が書き込めるのはこの児童だけだが、集計側でも同じ条件で絞る。
 * 名簿から氏名を消した児童の過去分まで weak_child に残ると、
 * 「分析の対象は名簿にある児童だけ」という約束が画面上で破れるため。
 */
function namedMails_() {
  var set = {};
  rosterRows_().forEach(function (r) {
    if (r.name) set[r.mail] = true;
  });
  return set;
}

function classKey_(c) { return c.grade + '-' + c.cls; }

/* ---- モードの解禁フラグ（学年既定 + クラスごとの上書き） ---- */

/**
 * クラスごとの公開設定。{ '3-1': { modes: {1:true,2:false,...}, seqOff: false } }
 *
 * 公開はモード単位で持つ。以前は「フラグ」（かけ算の拡張・計算モードなど）を単元が
 * 宣言し、複数のモードが1つのフラグを共有していた。その形では
 * 「わり算9×16 だけ閉じる」ができず、`flag: null` のモードは閉じる手段が無かった。
 * 20モードのうち単独で閉じられるものが1つも無い状態だったので、モード単位にした。
 */
/**
 * class_config の1列目（クラス名「学年-組」）を文字列に戻す。
 * スプレッドシートは「3-1」を日付（3月1日）として受け取ってしまい、読むと Date が返る。
 * そのままだと名簿のクラス（"3-1"）と一致せず、公開したモードが児童に1つも出ない。
 * Date なら月-日に読み替えて元の「学年-組」に戻す（保存時は列を文字列の書式にして、そもそも化けないようにする）。
 */
function clsCell_(x) {
  if (Object.prototype.toString.call(x) === '[object Date]' && !isNaN(x.getTime())) {
    return (x.getMonth() + 1) + '-' + x.getDate();
  }
  return String(x == null ? '' : x).trim();
}

function classConfig_(fresh) {
  // 教師画面は fresh で呼ぶ。設定した本人が見る画面が、
  // 最大60秒古い写しを見せると「保存できていない」と区別がつかない。
  // 児童側は毎回シートを読むと重いので、これまでどおりキャッシュを使う。
  if (!fresh) {
    var hit = cache_().get('classcfg');
    if (hit) return JSON.parse(hit);
  }
  var map = {};
  var sh = ss_().getSheetByName(SHEETS.CLASS);
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getDataRange().getValues();
    var head = v[0].map(String);
    for (var i = 1; i < v.length; i++) {
      var ck = clsCell_(v[i][0]);
      if (!ck) continue;
      var row = { modes: {}, seqOff: false };
      modeIds_().forEach(function (id) {
        var col = head.indexOf('mode_' + id);
        if (col >= 0) row.modes[id] = toBool_(v[i][col]);
      });
      var sc = head.indexOf('seq_off');
      if (sc >= 0) row.seqOff = toBool_(v[i][sc]);
      var nc = head.indexOf('n_unlock');
      if (nc >= 0) row.nUnlock = toBool_(v[i][nc]);
      map[ck] = row;
    }
  }
  cache_().put('classcfg', JSON.stringify(map), TTL.config);
  return map;
}

/**
 * そのクラスで公開されているモード。{ modeId: true/false }
 *
 * 学年による既定は持たない。教師が class_config で明示したものだけを開ける。
 * 「学年が3以上なら自動で開く」は、担任が触っていないのに開いている状態を作る。
 * どのモードを出すかは進度の判断なので、既定で開けない側に倒す。
 */
function openFor_(grade, cls) {
  var over = classConfig_()[grade + '-' + cls];
  var out = {};
  modeIds_().forEach(function (id) { out[id] = !!(over && over.modes[id]); });
  // pair のあるモード（図なし等の別記録版）は、相方の公開設定に従う。class_config に列を持たない
  UNIT.modes.forEach(function (m) { if (m.pair) out[m.id] = !!out[m.pair]; });
  return out;
}

/** そのクラスが順次開放を外しているか */
function seqOffFor_(grade, cls) {
  var over = classConfig_()[grade + '-' + cls];
  return !!(over && over.seqOff);
}

/** gateN：段階解放を使うクラスなら児童の正答回数 N、使わないなら null（nGateFor_） */
function modeAllowed_(mode, open, seqOff, tries, gateN) {
  var m = modeDef_(mode);
  if (!m) return false;
  if (!open[m.id]) return false;
  if (!nMet_(m, gateN)) return false;
  return needsMet_(m, seqOff, tries);
}

/*
 * 正答回数による段階解放（UNIT.nUnlock = { モード: 必要な正答回数 }）。
 * 正答回数 N はメニューの「正答回数の図」と同じ数（モードごとの本番の正答 × 育ちの倍率、切り捨ての合計）。
 * 児童が画面で見ている数で開くので、次がいつ開くかを自分で見通せる。
 * 成績（1回の正答数）ではなく累計なので、遅い子も続ければ必ず届く（needsMet_ の注記と同じ理由）。
 * クラスごとに class_config の n_unlock で入れる。pair のモードは相方の閾値に従う。
 */
function hasNUnlock_() { return !!(UNIT.nUnlock && Object.keys(UNIT.nUnlock).length); }
function nNeed_(m) { var t = UNIT.nUnlock || {}; return Number(t[m.pair || m.id]) || 0; }
function nMet_(m, gateN) { return gateN == null || nNeed_(m) <= gateN; }
function nUnlockFor_(grade, cls) {
  var over = classConfig_()[grade + '-' + cls];
  return hasNUnlock_() && !!(over && over.nUnlock);
}
/** 正答回数 N（index.html の menuFigCount_ と同じ式） */
function figCount_(tcm) {
  var gw = growWeights_(), n = 0;
  Object.keys(tcm || {}).forEach(function (m) { n += Math.floor((Number(tcm[m]) || 0) * (Number(gw[m]) || 1)); });
  return n;
}
function nGateFor_(c, mail) {
  if (!nUnlockFor_(c.grade, c.cls)) return null;
  var e = summaryIndex_(config_().limit_sec)[mail] || {};
  return figCount_(e.tcm);
}

/**
 * 順次開放。前のモードを規定回数やるまで、次のモードを開けない。
 *
 *   modes: [{ id: 2, needs: { mode: 1, tries: 3 } }]
 *
 * 条件を「回数」にしてあるのは、成績（正答数）にすると閾値の適正値が学級ごとに違い、
 * 下位層が最後のモードに永久に到達しないため。README が到達バッジを却下したのと
 * 同型の欠陥で、それを個人内評価ではなく解禁の顔をして持ち込むことになる。
 * 回数なら遅い子でも必ず到達し、順序だけが担保される。
 *
 * class_config の seq_off にチェックを入れると、そのクラスだけ順序を外せる
 * （授業で全員に同じモードをやらせる場面のため）。
 *
 * tries が無いとき（名簿にない試用者）は開けておく。記録が無いので条件を判定できず、
 * 閉じる側に倒すと試用そのものができなくなる。
 */
function needsMet_(m, seqOff, tries) {
  var nd = m.needs || (m.pair && (modeDef_(m.pair) || {}).needs);
  if (!nd) return true;
  if (!tries) return true;
  if (seqOff) return true;
  return (Number(tries[nd.mode]) || 0) >= Number(nd.tries);
}

/**
 * まだ開いていないモードに、開け方の案内文を付ける。{ モードid: 文言 }
 * 教師が非公開にしたモードはここに入れない（画面から消えるので案内する相手がいない）。
 */
function lockNotes_(open, seqOff, tries, gateN) {
  var out = {};
  UNIT.modes.forEach(function (m) {
    if (!open[m.id]) return;
    if (!nMet_(m, gateN)) { out[m.id] = 'せいかいの かいすうが ' + nNeed_(m) + ' に なると あきます'; return; }
    if (needsMet_(m, seqOff, tries)) return;
    var nd = m.needs || modeDef_(m.pair).needs;
    out[m.id] = '「' + modeName_(nd.mode) + '」を ' +
                nd.tries + 'かい やると あきます';
  });
  return out;
}

/** 順次開放を使う単元か。教師画面に「じゅんばん解除」の列を出すかの判定に使う */
function hasNeeds_() {
  for (var i = 0; i < UNIT.modes.length; i++) if (UNIT.modes[i].needs) return true;
  return false;
}

function modeDef_(id) {
  for (var i = 0; i < UNIT.modes.length; i++) if (UNIT.modes[i].id === Number(id)) return UNIT.modes[i];
  return null;
}

function modeIds_() { return UNIT.modes.map(function (m) { return m.id; }); }

/** class_config で公開を決めるモード（pair のあるモードは相方に従うので除く） */
function cfgModeIds_() { return UNIT.modes.filter(function (m) { return !m.pair; }).map(function (m) { return m.id; }); }

/** class_config の見出し。class | mode_1 … mode_n | seq_off（順次開放を使う単元だけ） */
function classHead_() {
  var head = ['class'].concat(cfgModeIds_().map(function (id) { return 'mode_' + id; }));
  if (hasNeeds_()) head.push('seq_off');
  if (hasNUnlock_()) head.push('n_unlock');
  return head;
}

/** シート上で mode 番号の意味が分かるように、名前も並べて記録する */
function modeName_(m) { var d = modeDef_(m); return d ? d.name : ('mode' + m); }

/* ============================================================
 *  出題 — 生成はサーバーだけが行う
 * ============================================================ */

function rng_(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function ri_(rand, lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); }
function pick_(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }

/**
 * そのモードに出る問題型を、gen を実際に回して求める。
 * Unit.gs に pool を別途宣言させると gen と二重管理になり、
 * 片方だけ直したときに「練習の選択肢」と「実際に出る問題」がずれる。
 * 出題の正本は gen ひとつだけ、を保つために derive する。
 *
 * 300回引く。プールが4型なら取りこぼす確率は事実上ゼロ。
 * 極端に出現率の低い型（1%未満）を作った単元では取りこぼしうる。
 */
function typesInMode_(mode) {
  var rand = rng_(20260903), seen = {}, out = [];
  for (var i = 0; i < 300; i++) {
    var t = UNIT.gen(rand, Number(mode)).t;
    if (t && !seen[t]) { seen[t] = true; out.push(t); }
  }
  return out;
}

function typesByMode_() {
  var hit = cache_().get('typesbymode');
  if (hit) return JSON.parse(hit);
  var out = {};
  modeIds_().forEach(function (m) { out[m] = typesInMode_(m); });
  cache_().put('typesbymode', JSON.stringify(out), 3600);
  return out;
}

/** 直前3問と同じ問題を避けながら n 問作る */
function genQueue_(seed, mode, n) {
  var rand = rng_(seed);
  if (typeof UNIT.queue === 'function') return UNIT.queue(rand, Number(mode), n);
  var out = [], recent = [];
  for (var i = 0; i < n; i++) {
    var it, guard = 0;
    do { it = UNIT.gen(rand, Number(mode)); guard++; }
    while (recent.indexOf(it.tag) >= 0 && guard < 8);
    recent.push(it.tag); if (recent.length > 3) recent.shift();
    out.push(it);
  }
  return out;
}

/**
 * キュー項目（1問分の送信用の配列）の位置づけ。
 *   Q: 出題トークン, F: 欄, ANS: 答え（F の順）, RULER: まきじゃく,
 *   T: 問題型, DIAL: はかりの文字盤, ROWS: 並べ方, VEIL: 覆い, FIG: 図
 *
 * 書き込みは packQueue_、読み取りは index.html の2箇所（begin/beginPractice）と
 * tests/divmod.test.cjs。同じ1問をオブジェクトで組み立てるのが
 * nextPracticeItem と index.html の pFetch（キーはここの小文字）。
 * 添字・キーを変えるときは両側を同じこの表で揃えること
 * （配列の並び自体は送信中データとの互換なので変えない）。
 */
var QI_ = { Q:0, F:1, ANS:2, RULER:3, T:4, DIAL:5, ROWS:6, VEIL:7, FIG:8, COL:9 };

/**
 * 送信用に切り詰める（配列の並びは QI_）。
 *
 * 並べ方（rows）と覆い（veil）を問題ごとに載せるのは、まきじゃくや文字盤と同じ理由。
 * 単元が「この問題はこう並べる」と決められないと、共通画面が単元ごとの形を
 * 知ることになり、依存が逆流する。
 */
function packQueue_(q) {
  return q.map(function (x) {
    var it = [];
    it[QI_.Q] = x.q;
    it[QI_.F] = x.f;
    it[QI_.ANS] = x.f.map(function (k) { return x.ans[k]; });
    it[QI_.RULER] = x.ruler || null;
    it[QI_.T] = x.t;
    it[QI_.DIAL] = x.dial || null;
    it[QI_.ROWS] = x.rows || null;
    it[QI_.VEIL] = (x.veil == null ? null : x.veil);
    it[QI_.FIG] = x.fig || null;
    it[QI_.COL] = x.col ? 1 : 0;
    return it;
  });
}

/* ============================================================
 *  ルーティング
 * ============================================================ */

function include(name) {
  var src = lbFile_(name);
  if (src != null) return src;
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function doGet(e) {
  if (isMulti_()) {
    var uid = (e && e.parameter && e.parameter.unit) || '';
    if (!uid || !Object.prototype.hasOwnProperty.call(UNIT_DEFS, uid)) return unitIndexPage_();
    useUnit_(uid);
    if (e.parameter.as) setActAs_(e.parameter.as);
  }
  ensureReady_();
  var page = (e && e.parameter && e.parameter.page) || '';
  if (page === 'teacher') {
    if (!isTeacher_(email_())) {
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">この画面を開く権限がありません。</p>');
    }
    var t = tplFromFile_('teacher');
    // ハブの「協力プレイ↗」は ?page=teacher&tab=coop で来る。最初に開くタブ（知らない値は既定のタブ）
    t.startTab = ['mode', 'coop', 'set', 'ana', 'past'].indexOf(e.parameter.tab) >= 0 ? e.parameter.tab : '';
    return t.evaluate()
      .setTitle(UNIT.teacherTitle)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return tplFromFile_('index').evaluate()
    .setTitle(UNIT.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ============================================================
 *  児童用 API
 * ============================================================ */

function boot() {
  var mail = email_();
  if (!mail) return { ok: false, msg: 'ログイン情報を取得できません。学校のアカウントで開いてください。' };
  var cfg = config_();
  var c = child_(mail);

  // 単元が UNIT.settings で宣言した設定だけを児童画面に渡す。
  // Core はキーの意味を知らない（何に使うかは単元と index.html の描画側の取り決め）。
  var uset = {};
  (UNIT.settings || []).forEach(function (s) {
    var v = cfg[s.key];
    uset[s.key] = (s.type === 'text') ? v : Number(v);
  });

  var base = {
    ok: true,
    ver: ENGINE_VER,               // 画面側は WANT_VER と比べて版ずれを検知する
    // digitCap は「宣言」なので、そのままクライアントへ渡してよい（答えは含まない）。
    // 渡さないと index.html の digitCap_() が宣言を読めず、自動確定も欄移動も動かない。
    // gen は絶対に渡さない（クライアントに出題ロジックを持たせない）。
    unit: { id: UNIT.id, title: UNIT.title, titleRuby: UNIT.titleRuby || null, modes: UNIT.modes,
            // 学年の進みの色・まちがいの赤・「？」の印の色。画面は色の値を持たず、ここから受け取る
            grade: UNIT.grade, category: UNIT.category || 'grade', interaction: UNIT.interaction || null, menuFigure: UNIT.menuFigure || '', colDir: !!UNIT.colDir, nUnlock: UNIT.nUnlock || null, accent: gradeAccent_(), alert: ALERT_COLOR_, q: questionColor_(),
            units: UNIT.units || {}, digitCap: UNIT.digitCap || {},
            // 型を絞った練習の選択肢。ラベルは types、どの型がどのモードに出るかは gen から導出
            types: UNIT.types || {}, typesByMode: typesByMode_(),
            // 合計で判定するときの換算率。index.html が単位名を決め打ちしないために渡す
            scale: UNIT.scale || {},
            // 欄ごとの数字の字形（九九の「八九72」を漢数字で見せるなど）。
            // digitCap と同じく「宣言」であって、答えは含まない
            glyph: UNIT.glyph || {},
            // 目立たせる欄の色。これも宣言で、答えは含まない
            slotColor: UNIT.slotColor || {},
            // 背景の床（成長する図形）の第二の色。第一の色は accent（学年の色）
            floor2: floorColor_(),
            // 床の図形（design リポジトリ growing-figures の生成器の id）。宣言が無ければペンローズ
            floorPattern: UNIT.floorPattern || 'penrose' },
    settings: uset,
    limitSec: cfg.limit_sec, missLimit: cfg.miss_limit, keyGap: Number(cfg.key_gap)
  };

  // 教師が児童画面から教師画面へ移れるようにする。
  // 児童のアカウントではこの2つが入らないので、リンク自体が描かれない
  base.teacher = isTeacher_(mail);
  if (base.teacher) base.teacherUrl = teacherUrl_();

  if (!c) {
    if (!isGuest_(mail)) {
      return { ok: false, msg: '名簿に登録がありません。担任の先生に伝えてください。' };
    }
    var allOn = {};
    modeIds_().forEach(function (m) { allOn[m] = true; });
    base.guest = true; base.name = ''; base.grade = 0;
    base.open = allOn;                // 名簿外の試用者。記録されないので全モード出す
    base.locked = {};                 // 記録が無いので順次開放は判定できない。開けておく
    base.best = {}; base.practiceBest = {}; base.stars = {}; base.medals = {};
    base.floor = { min: 0, pace: floorPace_(null) };   // 記録が無いので床は育たない（summary も読まない）
    modeIds_().forEach(function (m) {
      base.best[m] = 0; base.practiceBest[m] = 0; base.stars[m] = 0; base.medals[m] = '';
    });
    return base;
  }

  base.guest = false; base.name = c.name; base.grade = c.grade;
  base.open = openFor_(c.grade, c.cls);
  var b = bests_(mail, cfg.limit_sec);
  base.best = b.best; base.practiceBest = b.practiceBest; base.stars = b.stars;
  base.floor = b.floor;
  base.nGate = nUnlockFor_(c.grade, c.cls);   // 段階解放のクラス。画面は本番の後に正答回数で開け直す（nUnlockRelock_）
  base.locked = lockNotes_(base.open, seqOffFor_(c.grade, c.cls), b.tries,
                           base.nGate ? figCount_(b.floor.tcm) : null);
  base.medals = medals_(classKey_(c), mail, cfg.limit_sec);
  base.coop = coopForChild_(c);   // 協力モード中なら自分の色（なければ active:false）
  return base;
}

/**
 * 記録しない練習（むせいげん）の1問。クライアントに出題ロジックを持たせないため、
 * ここで1問ずつ作って返す。記録しないので token もシードも要らない。
 */
function nextPracticeItem(mode, type) {
  var mail = email_();
  var c = child_(mail);
  if (!c && !isGuest_(mail)) return { ok: false };
  mode = Number(mode);
  if (modeIds_().indexOf(mode) < 0) return { ok: false };
  if (c && !modeAllowed_(mode, openFor_(c.grade, c.cls),
                         seqOffFor_(c.grade, c.cls), triesForGate_(mail), nGateFor_(c, mail))) return { ok: false };

  var rand = rng_(Math.floor(Math.random() * 2147483647));
  var it = UNIT.gen(rand, mode);

  // 型を絞った練習。gen を引き直して当たりを待つ（棄却法）。
  // 型ごとの生成関数を Unit.gs に足させると gen と二重管理になるので、
  // 出題の正本は gen のままにしておく。プールが4型なら平均4回で当たる。
  // 60回引いても当たらなければ、そのまま返す（画面が止まるよりはよい）。
  if (type) {
    for (var i = 0; i < 60 && it.t !== type; i++) it = UNIT.gen(rand, mode);
  }

  // 返す形は packQueue_ の配列と同じ1問を、QI_ の小文字のキーで渡す
  return {
    ok: true, q: it.q, f: it.f,
    ans: it.f.map(function (k) { return it.ans[k]; }),
    ruler: it.ruler || null, t: it.t || null, dial: it.dial || null,
    rows: it.rows || null, veil: (it.veil == null ? null : it.veil),
    fig: it.fig || null, col: it.col ? 1 : 0
  };
}

function startSession(mode, practice) {
  var mail = email_();
  var c = child_(mail);
  var cfg = config_();
  mode = Number(mode);
  if (modeIds_().indexOf(mode) < 0) return { ok: false, msg: 'モードが不正です。' };

  if (!c) {
    if (!isGuest_(mail)) return { ok: false, msg: '名簿に登録がありません。' };
    return {
      ok: true, guest: true, token: '',
      limitSec: cfg.limit_sec, missLimit: cfg.miss_limit,
      qs: packQueue_(genQueue_(Math.floor(Math.random() * 2147483647), mode, QN))
    };
  }

  if (!modeAllowed_(mode, openFor_(c.grade, c.cls),
                    seqOffFor_(c.grade, c.cls), triesForGate_(mail), nGateFor_(c, mail))) {
    return { ok: false, msg: 'このモードは まだ つかえません。' };
  }

  var seed = Math.floor(Math.random() * 2147483647);
  var sess = { n: Utilities.getUuid(), seed: seed, mode: mode, mail: mail, t: Date.now(),
               lim: Number(cfg.limit_sec), p: !!practice };
  var token = makeToken_(sess);
  // キャッシュは「まだ記録していない」の速い印。消えていても token だけで採点できる
  cache_().put('sess_' + sess.n, '1', TTL.session);

  return {
    ok: true, token: token,
    limitSec: cfg.limit_sec, missLimit: cfg.miss_limit,
    qs: packQueue_(genQueue_(seed, mode, QN)),
    // 協力モード中なら自分の色を教える（なければ active:false）
    coop: coopForChild_(c, Number(cfg.limit_sec) || 60)
  };
}

/**
 * items = [{i:出題index, a:[解答の履歴], ms:最初の解答までのミリ秒}, ...]
 * サーバーがシードから問題列を再生成して採点し直す。点数は受け取らない。
 */
function submitSession(token, items) {
  var mail = email_();
  // 署名つき token はそれ自体が回の情報を持つ。旧形式（UUID）はキャッシュに回の情報がある
  var s = readToken_(token), ckey;
  if (s) {
    if (Date.now() - Number(s.t) > TOKEN_DAYS_ * 86400000) {
      return { ok: false, code: 'gone', msg: 'きろくの きげんが きれました。' };
    }
    ckey = 'sess_' + s.n;
  } else {
    ckey = 'sess_' + token;
    var raw = cache_().get(ckey);
    if (!raw) return { ok: false, code: 'gone', msg: 'この記録は すでに ほぞんされています。' };
    s = JSON.parse(raw);
  }
  if (s.mail !== mail) return { ok: false, code: 'bad', msg: '不正なリクエストです。' };

  var cfg = config_();
  var c = child_(mail);
  if (!c) return { ok: false, code: 'bad', msg: '名簿に登録がありません。' };
  var limSec = Number(s.lim) || Number(cfg.limit_sec);

  if (!itemsValid_(items)) {
    return { ok: false, code: 'bad', msg: '記録できませんでした。' };
  }
  var sumMs = 0;
  for (var n = 0; n < items.length; n++) sumMs += Number(items[n].ms) || 0;
  if (sumMs > (limSec + 5) * 1000) {
    return { ok: false, code: 'bad', msg: '時間が合いません。記録できませんでした。' };
  }

  var q = genQueue_(s.seed, s.mode, QN);
  var correct = 0, attempts = 0, lbItems = [];
  var miss = [], slow = [], wrong = [], stat = {}, msByType = {};

  for (var i = 0; i < items.length; i++) {
    var it = items[i], qq = q[it.i];
    if (!qq) continue;
    var hist = it.a || [];
    attempts += hist.length;

    var byTotal = UNIT.byTotal ? !!UNIT.byTotal(qq) : false;
    var want = qq.f.map(function (u) { return qq.ans[u]; });
    var last = hist.length ? hist[hist.length - 1] : null;
    var hit = !!last && match_(last, qq, byTotal);
    var firstTry = hist.length === 1 && hit;

    if (hit) correct++;
    lbItems.push(lbItem_(it, qq, hist, hit, firstTry));
    if (!hit || hist.length > 1) {
      miss.push(qq.t + ':' + qq.tag);
      // 誤答明細シート用に、正しい答えと最初に間違えた値をセットで残す
      for (var w = 0; w < hist.length; w++) {
        if (!match_(hist[w], qq, byTotal)) {
          wrong.push(qq.t + '|' + qq.tag + '|' + want.join('/') + '|' + hist[w].join('/'));
          break;
        }
      }
    }
    if (firstTry) {
      // [試行数, Σ送信まで, 初打鍵が取れた数, Σ初打鍵まで, Σ(初打鍵まで)^2, Σln(初打鍵まで), Σln(初打鍵まで)^2]
      // 二乗和まで持つのは、平均だけでは「毎回同じ速さで遅い子」と
      // 「想起と計数を行き来していて時々速い子」が区別できないため。
      // 前者は手続きの短縮、後者は想起そのものの練習が要る。
      // 対数の和を持つのは、反応時間の分布が遅い側に長く裾を引くため。代表値は
      // 対数の平均（幾何平均）で取る（Ratcliff 1993。docs/ARCHITECTURE.md「遅いの判定」）
      if (!stat[qq.t]) stat[qq.t] = [0, 0, 0, 0, 0, 0, 0];
      var tk = Number(it.tk) || 0;
      stat[qq.t][0]++; stat[qq.t][1] += Number(it.ms) || 0;
      if (tk > 0) {
        var lt = Math.log(tk);
        stat[qq.t][2]++; stat[qq.t][3] += tk; stat[qq.t][4] += tk * tk;
        stat[qq.t][5] += lt; stat[qq.t][6] += lt * lt;
      }
      (msByType[qq.t] || (msByType[qq.t] = [])).push({ tag: qq.tag, ms: Number(it.ms) || 0 });
    }
  }

  // slow_items：この回の同じ型の中で、対数時間が 中央値＋2.5×MAD を超えた問題（5問以上ある型だけ）。
  // 平均±SDは外れ値そのものに引っぱられて外れ値を見落とす（Leys et al. 2013）。学年との比較は集計側で行う
  Object.keys(msByType).forEach(function (t) {
    var xs = msByType[t].filter(function (x) { return x.ms > 0; });
    if (xs.length < 5) return;
    var nm = robustNorm_(xs.map(function (x) { return Math.log(x.ms); }));
    if (!(nm.s > 0)) return;
    xs.forEach(function (x) {
      if ((Math.log(x.ms) - nm.med) / nm.s > SLOW_ITEM_Z_) slow.push(t + ':' + x.tag + ':' + Math.round(x.ms));
    });
  });

  var statStr = Object.keys(stat).map(function (k) {
    return k + ':' + stat[k].map(function (v, j) { return j >= 5 ? Math.round(v * 1000) / 1000 : v; }).join(':');
  }).join(',');

  var isPractice = !!s.p;
  var rank = 0, res = { best: correct, star: 0, updated: false };

  /*
   * 記録は直列に書く（同じ行を読んで書き換えるため）。
   * 待ち時間を30秒から10秒に縮めてある。40人が同じ1分の終わりに送ると、
   * 待っている実行が同時実行の枠（1ユーザーあたり30）を埋めたまま居座り、
   * その間、他の児童の boot と startSession が実行されない。
   * 教室で最初に壊れるのは記録ではなく「始められないこと」なので、
   * 混んでいるときは記録を諦めて枠を空ける。
   *
   * 諦めても失われない。token をキャッシュから消すのはロックの内側なので、
   * ここで抜けた回は何も書いていない。端末は未送信として持ち続け、
   * 数秒〜十数秒ばらけた間を置いて自分から送り直す（index.html の pendRetry_）。
   * 協力プレイは終了から10分以内に届いた回しか数えないので、次の起動まで待つと間に合わない。
   */
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { ok: false, msg: 'こんでいます。あとで おくりなおします。' };
  }
  try {
    if (s.n) {
      // キャッシュの印が残っていれば未記録。消えていたら used シートで二重記録を確かめる
      if (!cache_().get(ckey) && tokenUsed_(s.n)) {
        return { ok: false, code: 'gone', msg: 'この記録は すでに ほぞんされています。' };
      }
      sh_(SHEETS.USED).appendRow([s.n, new Date()]);
    }
    cache_().remove(ckey);

    if (!isPractice) {
      // 本番だけ log に残す。練習を混ぜると分析が濁る（列の位置は LOG_COL_）
      var lr = [];
      lr[LOG_COL_.TS] = new Date();
      lr[LOG_COL_.MAIL] = mail;
      lr[LOG_COL_.GRADE] = c.grade;
      lr[LOG_COL_.CLS] = c.cls;
      lr[LOG_COL_.NO] = c.no;
      lr[LOG_COL_.NAME] = c.name;
      lr[LOG_COL_.MODE] = s.mode;
      lr[LOG_COL_.MNAME] = modeName_(s.mode);
      lr[LOG_COL_.LIM] = limSec;
      lr[LOG_COL_.CORRECT] = correct;
      lr[LOG_COL_.ATTEMPTS] = attempts;
      lr[LOG_COL_.MISS] = miss.join(',');
      lr[LOG_COL_.SLOW] = slow.join(',');
      lr[LOG_COL_.TSTAT] = statStr;
      lr[LOG_COL_.WRONG] = wrong.join(',');
      sh_(SHEETS.LOG).appendRow(lr);
    }
    res = updateSummary_(mail, s.mode, limSec, isPractice ? 'p' : 'r', correct, attempts);
    if (!isPractice) rank = updateDaily_(classKey_(c), s.mode, limSec, mail, correct);
    // 索引を作り直させる。次に起動した児童が古いベストを見ないように
    cache_().remove('sumidx_' + limSec);
    if (!isPractice) cache_().remove('top3_' + classKey_(c) + '_' + limSec);
    // 協力モード：本番の提出だけを、終了時刻までに届いた分だけ数える。
    // 協力モードは表示だけの仕組みなので、ここで失敗しても採点の記録（上で書き終えている）は成功として返す。
    // catch の外へ投げると「記録に失敗しました」になり、token を消した後なので再送も 'gone' になって結果が出ない
    if (!isPractice) { try { coopNote_(c, s.mode, correct, s); } catch (eCoop) {} }
  } catch (err) {
    return { ok: false, msg: '記録に失敗しました。' };   // code 無し = 再送する
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
  // 学習BASE の新しい形の記録（学習者ID・全問）。今の記録（log）と採点の結果はここまでで確定している。
  // ここで失敗しても結果は返す（新しい形が欠けるだけ。今の記録には影響しない）
  try { lbWriteSession_(s, mail, isPractice, lbItems); } catch (eLb) { console.error('新しい形の記録に失敗: ' + (eLb && eLb.message || eLb)); }

  return {
    ok: true, mode: s.mode, limitSec: limSec, practice: isPractice,
    score: correct, attempts: attempts,
    best: res.best, star: res.star, updated: res.updated, rank: rank,
    medal: (!isPractice && rank >= 1 && rank <= 3) ? ['🥇', '🥈', '🥉'][rank - 1] : ''
  };
}

/*
 * 署名つき token。回の情報（出題の種・モード・メール・開始時刻・制限時間・練習か）を
 * サーバーだけが持つ鍵で署名して児童の端末に持たせる。CacheService は保存を保証しないので、
 * 回の情報をキャッシュだけに置くと、消えた回は採点できずに記録が失われていた。
 * 形は "s2.<本体>.<署名>"（どちらも URL 安全な base64）。
 */
var TOKEN_DAYS_ = 7;                       // 端末に退避した記録を受け付ける日数。used シートもこの日数より古い行を消す
var SIGN_KEY_ = 'sign_key';

function signKey_() {
  var props = props_();
  var k = props.getProperty(SIGN_KEY_);
  if (!k) {
    // 通常は ensureReady_ がロックの中で作る。ここは作られていなかったときの保険
    k = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(SIGN_KEY_, k);
  }
  return k;
}

function sign_(body) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, signKey_()));
}

function makeToken_(sess) {
  var body = Utilities.base64EncodeWebSafe(JSON.stringify(sess), Utilities.Charset.UTF_8);
  return 's2.' + body + '.' + sign_(body);
}

/** 署名が合えば回の情報を返す。旧形式・改竄・壊れた token は null */
function readToken_(token) {
  var p = String(token || '').split('.');
  if (p.length !== 3 || p[0] !== 's2' || !p[1] || p[2] !== sign_(p[1])) return null;
  try {
    var s = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(p[1])).getDataAsString('UTF-8'));
    return (s && s.n) ? s : null;
  } catch (e) { return null; }
}

/** 記録済みか。キャッシュの印が消えた回でだけ呼ぶ（シートを読むので遅い） */
function tokenUsed_(n) {
  var sh = sh_(SHEETS.USED);
  var last = sh.getLastRow();
  if (last < 2) return false;
  var v = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < v.length; i++) if (String(v[i][0]) === n) return true;
  return false;
}

/** used シートから受付期限を過ぎた行を消す（resetDaily から呼ぶ） */
function pruneUsed_() {
  var sh = ss_().getSheetByName(SHEETS.USED);
  if (!sh || sh.getLastRow() < 2) return;
  var v = sh.getDataRange().getValues();
  var lim = Date.now() - (TOKEN_DAYS_ + 1) * 86400000, keep = [v[0]];
  for (var i = 1; i < v.length; i++) if (rowTime_(v[i][1]) >= lim) keep.push(v[i]);
  if (keep.length === v.length) return;
  sh.clearContents();
  sh.getRange(1, 1, keep.length, 2).setValues(keep);
}

/**
 * 送られた解答列の形を検査する。正答は児童側に配っているので、同じ正解の1問を
 * 何度も送れば点数を水増しできてしまう（学級のメダル・順位が埋まる）。
 * 出題番号は 0〜QN-1 の整数で重複なし、ms・tk は 0 以上、解答の履歴は配列の配列に限る。
 * ms を負にすると合計時間の検査をすり抜けられるので、ここで止める。
 */
function itemsValid_(items) {
  if (!items || !items.length || items.length > QN) return false;
  var seen = {};
  for (var n = 0; n < items.length; n++) {
    var it = items[n];
    if (!it) return false;
    var i = it.i;
    if (typeof i !== 'number' || i !== Math.floor(i) || i < 0 || i >= QN || seen[i]) return false;
    seen[i] = true;
    if (!(Number(it.ms) >= 0) || (it.tk != null && !(Number(it.tk) >= 0))) return false;
    var a = it.a || [];
    if (!Array.isArray(a)) return false;
    for (var w = 0; w < a.length; w++) if (!Array.isArray(a[w])) return false;
  }
  return true;
}

/** 空欄は 0 とみなす。byTotal なら合計で、そうでなければ欄ごとに比べる。
 *  答え a[i] は qq.f[i] の順で届く（QI_.ANS と同じ並び。児童側は currentAns が f.map で作る） */
function match_(a, qq, byTotal) {
  if (!a || a.length !== qq.f.length) return false;
  if (UNIT.answerOrder === 'unordered') {
    var actual = a.map(Number).sort(function(x,y){ return x-y; });
    var expected = qq.f.map(function(k){ return Number(qq.ans[k]); }).sort(function(x,y){ return x-y; });
    return actual.every(function(v,i){ return isFinite(v) && v === expected[i]; });
  }
  var got = 0, want = 0;
  for (var i = 0; i < qq.f.length; i++) {
    var u = qq.f[i];
    var v = (a[i] === '' || a[i] === null || a[i] === undefined) ? 0 : Number(a[i]);
    if (isNaN(v)) return false;
    if (byTotal) {
      // 宣言（UNIT.scale）を正とする。unitScale(関数) は旧単元との互換のため残す
      var k = (UNIT.scale && UNIT.scale[u]) || (UNIT.unitScale ? UNIT.unitScale(u) : 1);
      got += v * k; want += Number(qq.ans[u]) * k;
    } else {
      if (v !== Number(qq.ans[u])) return false;
    }
  }
  return byTotal ? (got === want) : true;
}

/* ============================================================
 *  summary / daily（制限時間ごとに別の記録として持つ）
 * ============================================================ */

/**
 * summary: email | mode | limit_sec | kind | tries | total_correct | total_attempts | best | best_count
 *   kind … 'r' 本番 / 'p' 練習（時間制限あり・ランダムのみ）
 *   best_count … 自己ベストを塗り替えた回数。個人内評価の★になる
 */
var SUM = { MAIL:0, MODE:1, NAME:2, LIM:3, KIND:4, TRIES:5, TC:6, TA:7, BEST:8, COUNT:9 };

/**
 * summary をメール別に畳んだ索引。1回の読み取りを学級全体で分け合う。
 *
 * 帯活動では40人が同じ1分に起動する。児童ごとに summary 全体を読んでいると、
 * 同じ内容を40回読むことになり、実行時間がそのまま同時実行の枠を埋める。
 * 索引にすれば、シートを読むのは最初の1つの実行だけになる。
 *
 * TTL は30秒。自分の記録は submitSession の戻り値でその場で画面に入るので、
 * ここが数十秒古くても児童には見えない（送信時に該当キーは落とす）。
 */
function summaryIndex_(limitSec) {
  var key = 'sumidx_' + limitSec;
  var hit = cache_().get(key);
  if (hit) return JSON.parse(hit);

  var v = sh_(SHEETS.SUMMARY).getDataRange().getValues();
  var idx = {};
  for (var i = 1; i < v.length; i++) {
    var mail = String(v[i][SUM.MAIL]).toLowerCase().trim();
    if (!mail) continue;
    var e = idx[mail];
    if (!e) e = idx[mail] = { best: {}, prac: {}, stars: {}, tries: {}, tcm: {} };
    var m = Number(v[i][SUM.MODE]);
    // 順次開放に使う試行回数だけは、制限時間も本番／練習も問わずに合算する。
    // 「何回やったか」の条件なので、条件を満たす道を制限時間の設定で塞がない。
    e.tries[m] = (e.tries[m] || 0) + (Number(v[i][SUM.TRIES]) || 0);
    // 背景の床（成長する図形）に使う累計正答と、そのサイト全体の「1分あたりの正答」。
    // 本番だけを、モードごとに・全制限時間で合算する。練習を入れないのは ★ と同じ理由
    // （記録しない場で増えると意味が薄れる）。詳細は floorPace_
    if (String(v[i][SUM.KIND]) !== 'p') {
      var tcv = Number(v[i][SUM.TC]) || 0, sec = (Number(v[i][SUM.TRIES]) || 0) * (Number(v[i][SUM.LIM]) || 0);
      e.tcm[m] = (e.tcm[m] || 0) + tcv;
      if (!idx['*']) idx['*'] = { tc: {}, sec: {} };
      idx['*'].tc[m] = (idx['*'].tc[m] || 0) + tcv;
      idx['*'].sec[m] = (idx['*'].sec[m] || 0) + sec;
    }
    if (Number(v[i][SUM.LIM]) !== Number(limitSec)) continue;
    if (String(v[i][SUM.KIND]) === 'p') {
      e.prac[m] = Number(v[i][SUM.BEST]) || 0;
    } else {
      e.best[m] = Number(v[i][SUM.BEST]) || 0;
      e.stars[m] = Math.min(Number(v[i][SUM.COUNT]) || 0, STAR_MAX);
    }
  }
  // キャッシュ1件は100KBまで。児童数が多い年は入らないので、その時は素で読む
  var json = JSON.stringify(idx);
  if (json.length < 90000) cache_().put(key, json, TTL.index);
  return idx;
}

function bests_(mail, limitSec) {
  var idx = summaryIndex_(limitSec), e = idx[mail] || {};
  var real = {}, prac = {}, stars = {}, tries = {}, pace = floorPace_(idx), floorMin = 0;
  modeIds_().forEach(function (m) {
    floorMin += (Number((e.tcm || {})[m]) || 0) / pace[m];
    real[m]  = Number((e.best  || {})[m]) || 0;
    prac[m]  = Number((e.prac  || {})[m]) || 0;
    stars[m] = Number((e.stars || {})[m]) || 0;
    tries[m] = Number((e.tries || {})[m]) || 0;
  });
  return { best: real, practiceBest: prac, stars: stars, tries: tries,
           floor: { min: Math.round(floorMin * 100) / 100, pace: pace,
                    // モードごとの本番の正答の累計と育ちの倍率。メニューに「正答回数の図」を出す単元（UNIT.menuFigure）が使う
                    tcm: e.tcm || {}, gw: growWeights_() } };
}

/**
 * 背景の床の「育ちやすさ」を、そのサイトの解きやすさで揃える。
 *
 * 床は正答の数ではなく「標準の分数」で育てる。標準の分数とは、
 * そのサイトの児童が平均的な速さで解いたとして、その正答数を取るのに要る時間（分）。
 *   標準の分数 ＝ Σ（モードごとの累計正答 ÷ そのモードの1分あたりの平均正答）
 * 床の枚数 ＝ 標準の分数 × 20 × 教師が決める「1正答あたりの育ち」（floor_per_answer）。
 * 20 は基準の速さ（1分20問）。つまり「1分に20問解ける速さのモードの1正答」がちょうど floor_per_answer 枚になり、
 * 1正答の枚数 ＝ floor_per_answer × 20 ÷ そのモードの1分あたりの平均正答。
 * 解きにくい問題（1分で取れる正答が少ない）を載せたサイト・モードほど1問で多く染まる
 * （九九で1分30問なら1問 0.67倍、単位換算で1分8問なら 2.5倍）。平均的な速さなら1分の練習でどのサイトも同じだけ育つ。
 * 基準をサイトの平均ではなく固定の20にするのは、サイトをまたいで「解きにくいほど染まりやすい」を保つため
 * （サイトの平均を基準にすると、どのサイトでも平均の1問が同じ枚数になり、サイト間の差が消える）。
 *
 * 1分あたりの平均正答は、summary の本番の行（全児童・全制限時間）から出す：
 *   （累計正答 ＋ 事前の正答）÷（遊んだ分数 ＋ 事前の分数）
 * 「事前」は記録の少ない年度初めに値が暴れないための下駄（1分20問を10分ぶん）。
 * 記録が増えるほど実際の速さに寄る。単元が floorPrior で別の事前値を宣言してもよい。
 *
 * 注意：平均が変わると標準の分数も少し変わる（学級全体が速くなると、同じ正答の重みが少し減る）。
 */
/*
 * モードごとの育ちの倍率 { モード: 倍率 }。床（floorPace_）と協力プレイ（回に写して持つ gw）の両方に効く。
 * 床は速さで自動に揃えた上に掛ける（倍率2なら、そのモードの1正答が2倍の枚数）。最も練習させたいモードを高くする使い方。
 * 教師画面の全般設定で変える（config の grow_w）。単元が UNIT.growWeights で既定を宣言してもよい
 */
var GROW_W_MIN_ = 0.5, GROW_W_MAX_ = 3;
function growWeights_() {
  var out = {}, base = UNIT.growWeights || {};
  modeIds_().forEach(function (m) { out[m] = Number(base[m]) || 1; });
  var raw = '';
  try { raw = String(config_().grow_w || ''); } catch (e) { /* 設定が読めない時は単元の既定（無ければ1倍）で続ける */ }
  raw.split(',').forEach(function (kv) {
    var p = kv.split(':'), m = Number(p[0]), w = Number(p[1]);
    if (out[m] !== undefined && w > 0) out[m] = w;
  });
  for (var m in out) out[m] = Math.max(GROW_W_MIN_, Math.min(GROW_W_MAX_, Math.round(out[m] * 10) / 10));
  return out;
}

var FLOOR_PRIOR_ = { perMin: 20, min: 10 };
var FLOOR_REF_PER_MIN_ = 20;   // 「1正答あたりの育ち」の基準の速さ。index.html の FLOOR_REF と同じ値にする
function floorPace_(idx) {
  var st = (idx && idx['*']) || { tc: {}, sec: {} }, pr = UNIT.floorPrior || {}, out = {}, gw = growWeights_();
  modeIds_().forEach(function (m) {
    var perMin = Number(pr[m]) || FLOOR_PRIOR_.perMin;
    var tc = (Number(st.tc[m]) || 0) + perMin * FLOOR_PRIOR_.min;
    var min = (Number(st.sec[m]) || 0) / 60 + FLOOR_PRIOR_.min;
    // 育ちの倍率で割る：1正答の「標準の分数」が倍率ぶん大きくなる（倍率2のモードは1問で2倍育つ）。
    // 児童の画面はこの値で割って足すだけなので、倍率を知らなくてよい
    out[m] = Math.max(0.1, Math.round(Math.max(1, tc / min) / gw[m] * 100) / 100);
  });
  return out;
}

/**
 * 順次開放の判定だけに使う。boot は bests_ が返す tries を使い、ここは通らない。
 *
 * needs を持たない単元（九九・長さ・おもさ）では判定そのものが不要なので読まない。
 * 以前は単元を問わず呼んでいて、児童が1回始めるたびに summary 全体を読んでいた。
 * 40人が同時に始める帯活動では、これが同時実行の枠を埋める側に回る。
 */
function triesForGate_(mail) { return hasNeeds_() ? triesByMode_(mail) : null; }

function triesByMode_(mail) {
  var v = sh_(SHEETS.SUMMARY).getDataRange().getValues();
  var out = {};
  modeIds_().forEach(function (m) { out[m] = 0; });
  for (var i = 1; i < v.length; i++) {
    if (String(v[i][SUM.MAIL]).toLowerCase() !== mail) continue;
    var m = Number(v[i][SUM.MODE]);
    if (out[m] !== undefined) out[m] += Number(v[i][SUM.TRIES]) || 0;
  }
  return out;
}

/**
 * 記録を更新して { best, star, updated } を返す。
 * star は本番だけ増える（練習で増やすと個人内評価の意味が薄れる）。
 */
/*
 * summary の行の位置の覚え書き（キー：メール・モード・制限秒・kind → 行番号）。
 * 提出はロックの内側で summary を書き換える。以前は毎回シート全体を読んで行を探しており、
 * 名簿×モード×種類で行が増えるほど、1人あたりのロックの時間が伸びていた。
 * 一斉に送る協力プレイでは、その時間の積み重ねが10秒の待ちを越え、後ろに並んだ児童の記録が弾かれていた。
 * 覚えた行は、読んだ1行がキーと一致する時だけ使う（並べ替え・年度の切り替えで位置が変わっても、ずれた行には書かない）。
 */
function sumRowKey_(mail, mode, limitSec, kind) { return 'sumrow_' + mail + '_' + mode + '_' + Number(limitSec) + '_' + kind; }
function sumRowIs_(r, mail, mode, limitSec, kind) {
  return String(r[SUM.MAIL]).toLowerCase() === mail && Number(r[SUM.MODE]) === mode &&
         Number(r[SUM.LIM]) === Number(limitSec) && String(r[SUM.KIND]) === kind;
}

function updateSummary_(mail, mode, limitSec, kind, correct, attempts) {
  var sh = sh_(SHEETS.SUMMARY);
  var key = sumRowKey_(mail, mode, limitSec, kind);
  var row = Number(cache_().get(key)) || 0, r = null;
  if (row >= 2 && row <= sh.getLastRow()) {
    r = sh.getRange(row, 1, 1, SUM.COUNT + 1).getValues()[0];
    if (!sumRowIs_(r, mail, mode, limitSec, kind)) r = null;
  }
  if (!r) {
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (sumRowIs_(v[i], mail, mode, limitSec, kind)) { row = i + 1; r = v[i]; break; }
    }
  }
  if (r) {
    var prev = Number(r[SUM.BEST]) || 0;
    var updated = correct > prev;
    var star = Number(r[SUM.COUNT]) || 0;
    if (updated && kind === 'r') star = Math.min(star + 1, STAR_MAX);
    sh.getRange(row, SUM.TRIES + 1, 1, 5).setValues([[
      Number(r[SUM.TRIES]) + 1,
      Number(r[SUM.TC]) + correct,
      Number(r[SUM.TA]) + attempts,
      Math.max(prev, correct),
      star
    ]]);
    cache_().put(key, String(row), TTL.session);
    return { best: Math.max(prev, correct), star: star, updated: updated };
  }
  var first = (kind === 'r') ? 1 : 0;      // 初回の記録も「自己ベスト更新」と数える
  sh.appendRow([mail, mode, modeName_(mode), Number(limitSec), kind, 1, correct, attempts, correct, first]);
  cache_().put(key, String(sh.getLastRow()), TTL.session);
  return { best: correct, star: first, updated: true };
}

/** 当日・同一学級・同一モード・同一制限時間の中での順位。同点は先着優先 */
function rankOf_(rows, ck, mode, limitSec, mail) {
  var td = today_(), pool = [];
  for (var i = 1; i < rows.length; i++) {
    if (dstr_(rows[i][0]) === td && String(rows[i][1]) === ck &&
        Number(rows[i][2]) === mode && Number(rows[i][4]) === Number(limitSec)) {
      pool.push({ mail: String(rows[i][5]).toLowerCase(), s: Number(rows[i][6]), t: Number(rows[i][7]) });
    }
  }
  pool.sort(function (a, b) { return b.s - a.s || a.t - b.t; });
  for (var k = 0; k < pool.length; k++) if (pool[k].mail === mail) return k + 1;
  return 0;
}

function updateDaily_(ck, mode, limitSec, mail, score) {
  var sh = sh_(SHEETS.DAILY);
  var v = sh.getDataRange().getValues();
  var td = today_();
  limitSec = Number(limitSec);

  var row = -1;
  for (var i = 1; i < v.length; i++) {
    if (dstr_(v[i][0]) === td && String(v[i][1]) === ck &&
        Number(v[i][2]) === mode && Number(v[i][4]) === limitSec &&
        String(v[i][5]).toLowerCase() === mail) { row = i; break; }
  }
  var now = new Date();   // 内部の並び替え用。Date型にすると daily を開いたときも読める
  if (row < 0) {
    var line = [td, ck, mode, modeName_(mode), limitSec, mail, score, now];
    sh.appendRow(line); v.push(line);
  } else if (score > Number(v[row][6])) {
    sh.getRange(row + 1, 7, 1, 2).setValues([[score, now]]);
    v[row][6] = score; v[row][7] = now;
  }
  return rankOf_(v, ck, mode, limitSec, mail);
}

/**
 * そのクラス・その制限時間の、当日の上位3名。{ モードid: [1位, 2位, 3位] }
 * 児童に見えるのは自分がメダル圏内かどうかだけなので、3人ぶんで足りる。
 * summary と同じ理由で、daily の読み取りも学級で1回にまとめる。
 */
function top3_(ck, limitSec) {
  var key = 'top3_' + ck + '_' + limitSec;
  var hit = cache_().get(key);
  if (hit) return JSON.parse(hit);

  var v = sh_(SHEETS.DAILY).getDataRange().getValues();
  var td = today_(), out = {};
  modeIds_().forEach(function (m) {
    var pool = [];
    for (var i = 1; i < v.length; i++) {
      if (dstr_(v[i][0]) === td && String(v[i][1]) === ck &&
          Number(v[i][2]) === m && Number(v[i][4]) === Number(limitSec)) {
        pool.push({ mail: String(v[i][5]).toLowerCase(), s: Number(v[i][6]), t: Number(v[i][7]) });
      }
    }
    pool.sort(function (a, b) { return b.s - a.s || a.t - b.t; });   // 同点は先着優先
    out[m] = pool.slice(0, 3).map(function (x) { return x.mail; });
  });
  cache_().put(key, JSON.stringify(out), TTL.index);
  return out;
}

function medals_(ck, mail, limitSec) {
  var t = top3_(ck, limitSec), out = {};
  modeIds_().forEach(function (m) {
    var k = (t[m] || []).indexOf(mail);
    out[m] = k >= 0 ? ['🥇', '🥈', '🥉'][k] : '';
  });
  return out;
}

/**
 * 年度替わり（4/1）の名簿引き継ぎ。毎朝のトリガーから呼び、4/1だけ動く。
 * roster の中身を roster_<前年度> に「値」で退避（IMPORTRANGEの結果を固める）し、
 * roster は新年度用に戻す。A1に式（IMPORTRANGE）があれば式を戻すので、
 * ハブ側が新年度になれば名簿はそのまま流れ替わる。
 * roster_<前年度> がすでにあれば何もしない（冪等）。
 */
function rolloverRoster(now) {
  now = (now instanceof Date) ? now : new Date();   // トリガー呼び出しはイベントobjが来る
  var tz = Session.getScriptTimeZone();
  if (Utilities.formatDate(now, tz, 'MMdd') !== '0401') return;
  if (hubRoster_()) return;                              // 名簿の年度保存はハブが行う（単元の roster は使っていない）
  var ss = ss_();
  var rs = ss.getSheetByName(SHEETS.ROSTER);
  if (!rs) return;
  var archName = 'roster_' + (Number(Utilities.formatDate(now, tz, 'yyyy')) - 1);   // 4/1の年度は新年度。残すのは1つ前
  if (ss.getSheetByName(archName)) return;             // 済み

  var v = rs.getDataRange().getValues();
  var hasKids = v.some(function (r) { return String(r[0]).indexOf('@') >= 0; });
  if (!hasKids) return;                                // 空の名簿は残さない（初めての年度など）

  var arch = ss.insertSheet(archName);
  arch.getRange(1, 1, v.length, v[0].length).setValues(v);   // 値だけ（式は残さない）
  arch.setTabColor('#93C47D');

  var a1 = rs.getRange(1, 1).getFormula();
  var head = rs.getRange(1, 1, 1, 5).getValues()[0];
  rs.clearContents();
  if (a1) {
    rs.getRange(1, 1).setFormula(a1);                  // IMPORTRANGEを戻す
  } else {
    rs.getRange(1, 1, 1, 5).setValues([head[0] ? head : ['email', '学年', '組', '番号', '氏名']]);
  }
}

/** 時間主導トリガー。前日以前の行を落とすだけ */
function resetDaily() {
  try { pruneUsed_(); } catch (e) { console.error('pruneUsed_ 失敗: ' + e.message); }   // 失敗しても日々の順位は消す
  var sh = sh_(SHEETS.DAILY);
  var v = sh.getDataRange().getValues();
  if (v.length <= 1) return;
  var td = today_(), keep = [v[0]];
  for (var i = 1; i < v.length; i++) if (dstr_(v[i][0]) === td) keep.push(v[i]);
  sh.clearContents();
  sh.getRange(1, 1, keep.length, 8).setValues(keep);
  sh.getRange('A:A').setNumberFormat('@');
}

/* ============================================================
 *  教師用 API
 * ============================================================ */

/**
 * いまどの写しを操作しているか。教師画面の見出しに出す。
 *
 * 版を入れ替えた直後は、古い写しと新しい写しが両方開ける状態になる
 * （ゴミ箱に入れただけのスプレッドシートも、履歴やブックマークから開ける）。
 * 教師が古い方で公開し、児童が新しい方を開いていると、
 * 症状は「公開したのに反映されない」になり、どちらの画面を見ても原因が出ない。
 * 名前とURLを画面に出しておけば、取り違えはその場で分かる。
 */
/** 教師画面の URL。いま動いているデプロイに ?page=teacher を付ける */
function teacherUrl_() { return unitUrl_('page=teacher'); }

function where_() {
  var out = { file: '', id: '', url: '', sheetUrl: '' };
  try { out.file = ss_().getName(); } catch (e) {}
  try { out.sheetUrl = ss_().getUrl(); } catch (e) {}
  // 名前は写しても同じになる。取り違えを確かめられるのは ID のほうで、
  // スプレッドシートの URL の /d/ と /edit のあいだにある文字列と突き合わせる
  try { out.id = ss_().getId(); } catch (e) {}
  out.url = unitUrl_('');
  return out;
}

function getConfigForUI() {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  writeMeta_();   // ハブの横断分析が読む。中身が同じなら書かない
  return { config: config_(), where: where_(), ver: ENGINE_VER,
           warnings: unitCheck_(),
           unit: { id: UNIT.id, title: UNIT.title,
           modes: UNIT.modes, types: UNIT.types,
           settings: UNIT.settings || [],
           tips: UNIT.tips || '',
           growW: growWeights_(),   // モードごとの育ちの倍率（今の設定。単元の既定込み）
           // 床のプレビュー（教師画面）に使う。児童の画面と同じ図形・同じ2色
           floor: { pattern: UNIT.floorPattern || 'penrose', c1: gradeAccent_(), c2: floorColor_(), ref: FLOOR_REF_PER_MIN_ },
           menuFigure: UNIT.menuFigure || '',   // 'factor' の単元は、協力プレイの図形も「正答数の図」にする
           // 協力モードの図形の選択肢。宣言できるのは画面に写した生成器と同じ id だけ
           coopPatterns: FLOOR_PATTERNS_ } };
}

/**
 * 教師画面の床のプレビューに、児童の画面（index.html）と同じ生成器を渡す。
 * 生成器の写しは index.html の 'FLOOR_GEN_BEGIN';〜'FLOOR_GEN_END';（何もしない文）の間の1か所だけに置き、ここで切り出して埋め込む
 * （teacher.html に2つ目の写しを置くと、片方だけ直して図形が食い違う。貼るファイルも増やさない）。
 * その直後の 'FLOOR_UI_BEGIN';〜'FLOOR_UI_END'; には、描画に使う定数・計算（色の系統・3層の進み・菱形のパス）を置く。
 * こちらも同じものを埋め込み、教師画面に2つ目の実装を持たせない。
 * 印が見つからなければ空を返し、教師画面はプレビューの欄に「読み込めません」と出す。
 */
function floorGenSource_(html) {
  // 印はコメントではなく「何もしない文」。HtmlService の getContent() は JS のコメントを消して返すため、
  // コメントの印（旧 /* FLOOR_GEN_BEGIN */）はサーバーからは見えなかった（len が約2.7万字減り、印が -1 になる）
  var seg_ = function (begin, end) {
    var a = html.indexOf(begin), b = html.indexOf(end);
    return (a < 0 || b < a) ? '' : html.slice(a, b);
  };
  var gen = seg_("'FLOOR_GEN_BEGIN';", "'FLOOR_GEN_END';"), ui = seg_("'FLOOR_UI_BEGIN';", "'FLOOR_UI_END';");
  if (!gen || !ui) return '';
  return (gen + ui).replace(/<\/script/gi, '<\\/script');   // 念のため：埋め込み先の script を閉じさせない
}
function floorGenForTeacher_() {
  // 失敗しても evaluate() ごと倒さず、埋め込み側の try/catch（teacher.html）が拾える断片を返す。
  // ここで握りつぶすと原因が分からず「読み込めません」だけが残る。
  try {
    var html = include('index');
    var src = floorGenSource_(html);
    if (!src) return "throw new Error('index.html 内に FLOOR_GEN_BEGIN / FLOOR_GEN_END / FLOOR_UI_BEGIN / FLOOR_UI_END の印が見つかりません（index を最新の版に貼り直す。読めた長さ " + html.length + "）')";
    return src;
  } catch (e) {
    return "throw new Error('index ファイルを読めません（" + String(e.message || e).replace(/'/g, '') + "）')";
  }
}

function saveConfig(obj) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var sh = sh_(SHEETS.CONFIG);
  var v = sh.getDataRange().getValues();
  for (var key in obj) {
    var found = false;
    for (var i = 1; i < v.length; i++) {
      if (String(v[i][0]).trim() === key) { sh.getRange(i + 1, 2).setValue(obj[key]); found = true; break; }
    }
    if (!found) sh.appendRow([key, obj[key]]);
  }
  cache_().remove('config'); cache_().remove('classcfg');
  return config_();
}

function listClasses() {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var over = classConfig_(true);
  var classes = listClassesCore_(over);

  /*
   * class_config にあるのに、名簿から作られるクラスと一致しない行を拾う。
   *
   * 公開の判定は「学年-組」の文字列一致だけで決まる（openFor_）。
   * 名簿の組が「1」で class_config が「1組」なら、シートには TRUE が入っているのに
   * 児童には1つも開かない。この食い違いはどちらの画面にも出ないので、
   * 「保存したのに反映されない」としか見えない。名前を並べて出す。
   */
  var known = {};
  classes.forEach(function (c) { known[c.cls] = true; });
  var orphans = [];
  for (var k in over) if (!known[k]) orphans.push(k);

  return { classes: classes, modes: UNIT.modes.filter(function (m) { return !m.pair; }), hasNeeds: hasNeeds_(), nUnlock: UNIT.nUnlock || null,
           orphans: orphans, where: where_() };
}

function saveClassConfig(rows) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var sh = ss_().getSheetByName(SHEETS.CLASS) || ss_().insertSheet(SHEETS.CLASS);
  sh.clear();
  var head = classHead_();
  var ids = cfgModeIds_();
  var out = [head];
  (rows || []).forEach(function (r) {
    var line = [String(r.cls)].concat(ids.map(function (id) { return !!(r.modes && r.modes[id]); }));
    if (hasNeeds_()) line.push(!!r.seqOff);
    if (hasNUnlock_()) line.push(!!r.nUnlock);
    out.push(line);
  });
  sh.getRange(1, 1, out.length, 1).setNumberFormat('@');   // クラス名の列は文字列。「3-1」が日付に化けないように
  sh.getRange(1, 1, out.length, head.length).setValues(out);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  cache_().remove('classcfg');

  /*
   * 書いたら読み戻して照合する。
   *
   * 「保存しました」とだけ返していると、書けていない時に教師は児童側を疑い、
   * 原因のない場所を探し続けることになる（実際そうなった）。
   * 保存が通ったかどうかは、保存の瞬間に教師の画面で分かるべきもの。
   *
   * 読み戻しは classConfig_ を通す。児童の公開判定が読むのと同じ経路なので、
   * ここが一致していれば「教師が見ている状態＝児童に効く状態」が保証される。
   */
  var back = classConfig_(true);
  var bad = [];
  (rows || []).forEach(function (r) {
    var b = back[String(r.cls)];
    var same = ids.every(function (id) {
      return !!(b && b.modes[id]) === !!(r.modes && r.modes[id]);
    });
    if (!same) bad.push(String(r.cls));
  });
  if (bad.length) {
    throw new Error('保存できていません（' + bad.join('・') +
                    '）。class_config シートが編集中でないか確かめてください。');
  }
  return { msg: '保存しました（' + (out.length - 1) + ' クラス）',
           classes: listClassesCore_(back) };
}

/**
 * class_config の内容を、教師画面の表と同じ形にして返す。
 * listClasses と保存後の読み戻しで同じ組み立てを使う
 * （別々に書くと、保存直後の表示と再読み込み後の表示がずれる）。
 */
function listClassesCore_(over) {
  var seen = {}, out = [];
  rosterRows_().forEach(function (r) {
    var grade = r.grade, cls = r.cls;
    if (!grade || !cls) return;
    var ck = grade + '-' + cls;
    if (seen[ck]) { seen[ck].n++; return; }
    var o = over[ck];
    var row = { cls: ck, grade: grade, room: cls, n: 1,
                modes: {}, seqOff: !!(o && o.seqOff), nUnlock: !!(o && o.nUnlock) };
    cfgModeIds_().forEach(function (id) { row.modes[id] = !!(o && o.modes[id]); });
    seen[ck] = row; out.push(row);
  });
  out.sort(function (a, b) { return a.grade - b.grade || (a.room < b.room ? -1 : 1); });
  return out;
}

/* ============================================================
 *  協力モード
 *
 *  クラス全員の本番の正答で、教師画面の図形がいっしょに育つモード。
 *
 *  数えるもの：提出が確定した本番（practice ではない）の正答だけ。
 *  集計はその単元サイト上の、クラスが一致する提出だけ。
 *  締め切りは「遊び終えた時刻」。協力の終わり（＋10秒）までに遊び終えた回だけ数え、送り直しは終わりから10分まで待つ。
 *  次の協力を始めても、直前の協力の送り直しはその10分の間は直前の方に数える（coop_prev）。
 *  同時に動くセッションは1つ（coopStart が進行中を拒む）。
 *
 *  「エラーに見える」ところは画面に理由を出す（数え方の規則は変えない）：
 *    教師画面 … 最初の1回が終わるまで何も増えない／残り1分から始めた回は数えない／締め切り後の送り直しを待っている／参加人数
 *    児童画面 … 残り1分を切ってから始めた本番は、印を「この回は数えません」にする（counts=false）
 *
 *  シート:
 *    coop       … セッションの履歴（1開始＝1行）。live の行は status='run'
 *    coop_log   … イベント列（1提出＝1行: session, t_ms, email, correct, mode）
 *    coop_save  … 教師が名付けて保存した再生データ（payload=JSON）
 * ============================================================ */
var COOP_DEF_MIN = 10;
var COOP_GN_MAX = 10;
var COOP_SLACK_MS = 10000;    // 遊び終えた時刻の、終了の後ろ側の余裕（時計のずれと通信の遅れ）
var COOP_COUNTDOWN_MS = 4000;  // 応答から協力が始まるまで（モニターで よーい…(1秒)→3→2→1→スタート を出す間。送信中も「よーい…」）
var COOP_EARLY_MS = 5000;     // 協力の始まりより前に始めてよい幅。遊び終えた時刻が「始まり＋(制限秒−5秒)」より前の回は数えない
var COOP_LATE_MS = 600000;    // 送り直しを数える上限：協力の終了から10分（混雑で弾かれた回は次の起動で送り直される）
var COOP_FLUSH_AT = 40;       // シートへ書いていない分がこの件数を超えたら、提出の側でもまとめ書きする（教師画面が閉じている間の備え）

/**
 * 進行中（または最後に開いていた）セッション。終了しても coopStop されるまで残す。
 * キャッシュは期限前に消えることがある（CacheService は保存を保証しない）。消えたら coop シートの最後の行から
 * 組み直す（児童の並びは名簿から、合計は coop_log から）。セッションが1つも無いときは null を置いて、
 * 起動のたびにシートを読みに行かないようにする（boot と startSession が毎回ここを通る）
 */
function coopLive_() {
  var h = cache_().get('coop_live');
  if (h) return JSON.parse(h);
  var s = coopFromSheet_();
  cache_().put('coop_live', JSON.stringify(s), TTL.session);
  return s;
}
function coopFromSheet_() {
  var sh = ss_().getSheetByName(SHEETS.COOP);
  if (!sh || sh.getLastRow() < 2) return null;
  return coopFromRow_(sh.getRange(sh.getLastRow(), 1, 1, 17).getValues()[0]);
}
/** coop シートの1行からセッションを組み立てる（児童の並びは今の名簿、合計は coop_log） */
function coopFromRow_(r) {
  var id = String(r[0] || '');
  if (!id) return null;
  function ms(v) { return v instanceof Date ? v.getTime() : new Date(v).getTime(); }
  function arr(v) { try { var a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  var cls = String(r[1] || ''), kids = coopKids_(cls), map = {}, order = [];
  kids.forEach(function (k, i) { map[k.mail] = i; order.push(k.mail); });
  var start = ms(r[9]), end = ms(r[10]);
  var s = { id: id, cls: cls, pat: String(r[2] || 'penrose'), seed: Number(r[3]) || 1,
            mode: String(r[4]) === 'group' ? 'group' : 'child', gn: Number(r[5]) || 6,
            minutes: Math.max(1, Math.round((end - start) / 60000)),
            start: start, end: end, status: String(r[11] || 'done') === 'run' ? 'run' : 'done', total: 0,
            kids: map, order: order, names: arr(r[7]), nos: arr(r[8]), gi: arr(r[6]),
            skip: coopSkip_(cls), org: Number(r[14]) || 1 };
  try { s.orgPts = coopOrgPts_(JSON.parse(String(r[15] || 'null')), s.org); } catch (e) { s.orgPts = null; }
  try { s.gw = coopGw_(JSON.parse(String(r[16] || 'null'))); } catch (e) { s.gw = null; }
  try { var pr = JSON.parse(String(r[13] || 'null')); if (pr && pr.ev) s.prior = pr; } catch (e) {}
  s.total = coopEvents_(s).reduce(function (a, e) { return a + (Number(e[2]) || 0); }, 0);
  return s;
}

/**
 * 教師の操作（開始・終了・組の編集・時刻での打ち切り）は、提出（submitSession）と同じロックの内側で行う。
 * どちらも coop_live を読んで書き戻すので、重なると後から書いた方が前の変更を消す
 * （提出が教師の組の編集を古い組で上書きする、打ち切った状態を 'run' に戻す、など）
 */
function coopLocked_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, msg: '混んでいます。少し待ってから、もう一度押してください。' };
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}
function coopPutLive_(s) { cache_().put('coop_live', JSON.stringify(s), TTL.session); }

/**
 * 名簿からそのクラスの児童（氏名あり）を番号順に並べる。
 * 色・組・タイルの割り当ては、この順の index で決まる。
 */
function coopKids_(ck) {
  var kids = [];
  rosterRows_().forEach(function (r) {
    if (!r.name) return;
    if (r.grade + '-' + r.cls !== ck) return;
    kids.push({ mail: r.mail, no: r.no, name: r.name });
  });
  kids.sort(function (a, b) { return a.no - b.no || (a.mail < b.mail ? -1 : 1); });
  return kids;
}
/** 名簿にそのクラスの行はあるが氏名が空の児童の数（協力には数えない。教師画面に人数だけ出す） */
function coopSkip_(ck) {
  var n = 0;
  rosterRows_().forEach(function (r) { if (!r.name && r.grade + '-' + r.cls === ck) n++; });
  return n;
}

/** セッションのイベント列 [[t_ms, 児童index, 正答数], …]。キャッシュを欠いたら coop_log から組み直す */
function coopEvents_(s) {
  var key = 'coop_ev_' + s.id;
  var hit = cache_().get(key);
  if (hit) return JSON.parse(hit);
  var ev = [], seen = {};
  var sh = ss_().getSheetByName(SHEETS.COOPLOG);
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (String(v[i][0]) !== s.id) continue;
      var idx = s.kids[String(v[i][2])];
      if (idx === undefined) continue;
      // まとめ書き（coopFlush_）が重なって同じ行が2度書かれていても、1件として数える
      var k = v[i][1] + '|' + v[i][2] + '|' + v[i][3];
      if (seen[k]) continue;
      seen[k] = 1;
      ev.push([Number(v[i][1]) || 0, idx, Number(v[i][3]) || 0, Number(v[i][4]) || 0]);
    }
  }
  cache_().put(key, JSON.stringify(ev), TTL.session);
  cache_().put('coop_fl_' + s.id, String(ev.length), TTL.session);   // シートから読んだ分は書き済み
  return ev;
}

/** 教師画面へ返す形（個人情報は名札に必要な氏名と番号まで。mail は出さない） */
function coopPub_(s, since) {
  var ev = coopEvents_(s), n = ev.length;
  return { id: s.id, cls: s.cls, pat: s.pat, seed: s.seed, mode: s.mode, gn: s.gn, org: s.org || 1, orgPts: s.orgPts || null, gw: s.gw || null,
           start: s.start, end: s.end, status: s.status, total: s.total,
           names: s.names, nos: s.nos, gi: s.gi,
           // 画面の案内に使う：1回の制限秒（残りがこれを切ると、これから始める回は数えない）・送り直しの締め切り・氏名のない児童の数
           lim: Number(config_().limit_sec) || 60, slack: COOP_SLACK_MS, lateUntil: s.end + COOP_LATE_MS, skip: s.skip || 0,
           pace: s.pace || FLOOR_PRIOR_.perMin, minutes: s.minutes,   // minutes：「おわる」で早く閉じても枚数の計算は予定の時間で
           evN: n, ev: ev.slice(Math.max(0, Number(since) || 0)),
           // 続きからの回：前の回までの正答。差分の問い合わせ（since>0）では送らない（画面が持っている）
           prior: (Number(since) || 0) > 0 ? undefined : (s.prior || null) };
}

/**
 * 「次の開始」で live から外れた直前のセッション。終了から COOP_LATE_MS の間だけ置き、
 * その間に届いた直前の回の送り直しをこちらに数える（開始を押した瞬間に前の回の取りこぼしが出ないように）
 */
/*
 * グループ分け（開始前に教師が作っておく編成）。クラスごとに1つだけ、スクリプトプロパティ coop_grp_<クラス> に持つ。
 *   { gn: グループ数, by: { email: グループ番号(0〜) } }
 * グループ数は編成そのものが決める（教師画面のグループ数の欄とは別に持たない）。
 *
 * 以前は単元のスプレッドシートの「グループ分け」シートに、クラス×グループ数ごとの塊で持っていた。
 * 欄のグループ数を変えると別の塊（無ければ番号順の等分）を読むので、「4人ずつにしたのに番号順になる」
 * 「シートの値と画面の値が食い違う」が起きていた。シートはもう読まない（残っていても消してよい）。
 * 教師画面では、編成を文字で貼り付けて読み取り、文字で写し取れる（コピー・貼り付けで持ち運ぶ）。
 */
var COOP_GRP_KEY = 'coop_grp_';
function coopGrpLoad_(cls) {
  try {
    var p = JSON.parse(props_().getProperty(COOP_GRP_KEY + cls) || 'null');
    var gn = Number(p && p.gn);
    if (!p || !p.by || !(gn >= 2 && gn <= COOP_GN_MAX)) return null;
    return { gn: gn, by: p.by };
  } catch (e) { return null; }
}
function coopPlanDefault_(gn, kids) {
  return kids.map(function (k, i) { return Math.min(gn - 1, Math.floor(i * gn / kids.length)); });
}
/**
 * 保存した編成を児童の並び（kids）に合わせる。{ gn, gi } か、保存が無ければ null。
 * 編成に無い児童（転入など）は、その時いちばん人数の少ないグループに入れる
 */
function coopPlanGet_(cls, kids) {
  var p = coopGrpLoad_(cls);
  if (!p) return null;
  var gi = kids.map(function (k) {
    var g = Number(p.by[k.mail]);
    return (g >= 0 && g < p.gn && g === Math.floor(g)) ? g : -1;
  });
  var cnt = []; for (var g = 0; g < p.gn; g++) cnt.push(0);
  gi.forEach(function (x) { if (x >= 0) cnt[x]++; });
  gi = gi.map(function (x) {
    if (x >= 0) return x;
    var m = 0; for (var j = 1; j < p.gn; j++) if (cnt[j] < cnt[m]) m = j;
    cnt[m]++; return m;
  });
  return { gn: p.gn, gi: gi };
}
/** 編成を保存する。gi が null なら消す（番号順の等分に戻す） */
function coopPlanPut_(cls, gn, order, gi) {
  var props = props_();
  if (!gi) { props.deleteProperty(COOP_GRP_KEY + cls); return; }
  var by = {};
  order.forEach(function (m, i) { by[m] = gi[i]; });
  props.setProperty(COOP_GRP_KEY + cls, JSON.stringify({ gn: gn, by: by }));
}
function coopGnOf_(gn) { return Math.max(2, Math.min(COOP_GN_MAX, Number(gn) || 6)); }

/** 開始前の編成を読む。保存が無ければ、欄のグループ数（gn）で番号順の等分 */
function coopPlan(cls, gn) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  cls = String(cls || ''); gn = coopGnOf_(gn);
  var kids = coopKids_(cls);
  if (!kids.length) return { ok: false, msg: 'そのクラスの児童が名簿にありません。' };
  var plan = coopPlanGet_(cls, kids);
  return { ok: true, cls: cls, gn: plan ? plan.gn : gn, gi: plan ? plan.gi : coopPlanDefault_(gn, kids), saved: !!plan,
           names: kids.map(function (k) { return k.name; }), nos: kids.map(function (k) { return k.no; }) };
}

/** 開始前の編成を保存する。gi は coopPlan が返した児童の並びに合わせる。reset なら消して番号順の等分（gn）に戻す */
function coopSavePlan(cls, gn, gi, reset) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  cls = String(cls || ''); gn = coopGnOf_(gn);
  var kids = coopKids_(cls);
  if (reset) { coopPlanPut_(cls, gn, null, null); return coopPlan(cls, gn); }
  if (!Array.isArray(gi) || gi.length !== kids.length) {
    return { ok: false, msg: '名簿が変わりました。画面を開き直してください。' };
  }
  coopPlanPut_(cls, gn, kids.map(function (k) { return k.mail; }),
    gi.map(function (g) { return Math.max(0, Math.min(gn - 1, Math.round(Number(g) || 0))); }));
  return { ok: true };
}

function coopPrev_() {
  var h = cache_().get('coop_prev');
  if (!h) return null;
  var p = JSON.parse(h);
  return Date.now() > p.end + COOP_LATE_MS ? null : p;
}

/** coop の行の合計を、キャッシュの合計に追いつかせる（締め切り後の送り直しで合計が増えるため） */
function coopSyncTotal_(s) {
  if (!s || s.status === 'run') return;
  var key = 'coop_rt_' + s.id;
  if (cache_().get(key) === String(s.total)) return;
  coopRowWrite_(s.id, { total: s.total });
  cache_().put(key, String(s.total), TTL.session);
}

/**
 * 提出1件を協力セッションに数える。submitSession のロック内から呼ぶ（直列前提）。
 * 呼ぶ前に練習は弾いてある（!isPractice の中だけ）。game は startSession が置いた回の記録（t＝開始時刻、lim＝制限秒）。
 *
 * 締め切りは「届いた時刻」ではなく「遊び終えた時刻」（開始時刻＋制限時間）で見る。
 * クラス全員が同じ1分の終わりに送るので、提出はロックを待ちきれずに弾かれることがある。弾かれた回は
 * 次の起動で送り直されるが、届いた時刻で見ると協力の終了後になって数えられず、混んだ瞬間に送った子に片寄る。
 * 協力の時間内に遊び終えた回なら、終了から COOP_LATE_MS（10分）以内に届いたものまで数える。
 *
 * ロックの内側では、キャッシュのイベント列に足すだけにする（シートは coopFlush_ がまとめて書く）。
 * シートへの1行の書き込みが、混む瞬間の提出1件ごとのロックの時間を延ばしていたため。
 */
function coopNote_(c, mode, correct, game) {
  if (!c) return;
  var now = Date.now();
  // 回の記録が無い呼び出し（古い経路）は届いた時刻で見る。余裕（カウントダウン分）は回の記録があるときだけ
  var known = !!(game && game.t);
  var limMs = (Number(game && game.lim) || 60) * 1000;
  var played = known ? Number(game.t) + limMs : now;
  // 始まりより前に始めておいて、始まった直後に正答をまとめて数えさせる回を弾く：
  // 遊び終えた時刻が「始まり＋(制限秒−5秒)」より前（＝始まりの5秒より前に始めた回）は数えない。
  // 5秒は「よーい…」の間に押した回と、モニターの表示の遅れを数えるための幅
  var early = known ? Math.max(0, limMs - COOP_EARLY_MS) : 0;
  function fits(x) {
    return !!x && played >= x.start + early && played <= x.end + (known ? COOP_SLACK_MS : 0) &&   // 協力の時間の外で遊び終えた回は数えない
      now <= x.end + COOP_LATE_MS &&                                                      // 送り直しが遅すぎる
      classKey_(c) === x.cls && x.kids[c.email] !== undefined;
  }
  var s = coopLive_(), live = true;
  if (!fits(s)) { s = coopPrev_(); live = false; if (!fits(s)) return; }   // 直前のセッションの送り直し
  var i = s.kids[c.email];
  // 画面の時間軸は届いた時刻（終了後に届いた回は終了の時点に置く。再生の順が崩れないように）
  var t = Math.min(now, s.end) - s.start;
  var ev = coopEvents_(s);
  ev.push([t, i, correct, mode]);
  cache_().put('coop_ev_' + s.id, JSON.stringify(ev), TTL.session);
  s.total = (s.total || 0) + correct;
  if (live) coopPutLive_(s); else cache_().put('coop_prev', JSON.stringify(s), TTL.session);
  // 教師画面が閉じていると、まとめ書きが起きずキャッシュにだけ溜まる。溜まりすぎたらここで書く（ロックは持っている）
  if (ev.length - Number(cache_().get('coop_fl_' + s.id) || 0) >= COOP_FLUSH_AT) coopFlush_(s, true);
}

/**
 * キャッシュのイベント列のうち、まだシート（coop_log）に書いていない分をまとめて1回で書く。
 * 教師画面の問い合わせ（3秒ごと）・終了・保存・次の開始のときに呼ぶ。
 * 書き込みは提出と同じロックの内側（coop_log の同じ行に2人の教師が書かないように）。混んでいれば
 * 0.5秒で諦めて次の回に回す（提出を待たせない）。haveLock＝呼ぶ側がすでにロックを持っている。
 * キャッシュが消えると、まだ書いていない分（最大で問い合わせ1回分）は失われる
 */
function coopFlush_(s, haveLock) {
  if (!s) return;
  var key = 'coop_fl_' + s.id, ev = coopEvents_(s);
  if (Number(cache_().get(key) || 0) >= ev.length) return;
  var lock = null;
  if (!haveLock) { lock = LockService.getScriptLock(); if (!lock.tryLock(500)) return; }
  try {
    ev = coopEvents_(s);
    var done = Number(cache_().get(key) || 0);
    if (done >= ev.length) return;
    var sh = ss_().getSheetByName(SHEETS.COOPLOG);
    if (!sh) return;
    var rows = ev.slice(done).map(function (e) { return [s.id, e[0], s.order[e[1]] || '', e[2], e[3] || '']; });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
    cache_().put(key, String(ev.length), TTL.session);
  } catch (e) {
    // 書けなくてもキャッシュには残っているので、次の回にもう一度書く
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e2) {} }
  }
}

/** coop の行を id で探して status/total/gi を更新する */
function coopRowWrite_(id, patch) {
  var sh = ss_().getSheetByName(SHEETS.COOP);
  if (!sh || sh.getLastRow() < 2) return;
  var v = sh.getDataRange().getValues();
  for (var i = v.length - 1; i >= 1; i--) {
    if (String(v[i][0]) !== id) continue;
    if (patch.gi !== undefined) sh.getRange(i + 1, 7).setValue(JSON.stringify(patch.gi));
    if (patch.end !== undefined) sh.getRange(i + 1, 11).setValue(new Date(patch.end));
    if (patch.status !== undefined) sh.getRange(i + 1, 12).setValue(patch.status);
    if (patch.total !== undefined) sh.getRange(i + 1, 13).setValue(patch.total);
    return;
  }
}

/**
 * 協力プレイを開始する。{cls, pat, minutes, mode('child'|'group'), gn}
 * リセットもここに来る（新しいセッションとして切り直す。旧分は coop_log に残る）。
 */
function coopStart(o) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  // 解く速さは summary を読むので、ロック（児童の提出と共有）の外で先に出しておく
  var pace = coopPace_();
  return coopLocked_(function () { return coopStart_(o, pace); });
}

/**
 * 協力の「1正答の枚数」の自動計算に使う、このサイトの本番の1分あたりの平均正答（全モード・全児童をまとめて）。
 * 協力は生の正答数で育つので、モードごとではなくサイト全体の速さを1つだけ渡す。
 * 記録の少ない年度初めに暴れないよう、床と同じ下駄（1分20問を10分ぶん。単元の floorPrior があればその平均）をはかせる。
 * 読めなければ下駄の値を返す（開始は止めない）。
 */
function coopPace_() {
  var pr = UNIT.floorPrior || {}, ms = modeIds_(), priorPerMin = 0;
  ms.forEach(function (m) { priorPerMin += Number(pr[m]) || FLOOR_PRIOR_.perMin; });
  priorPerMin = ms.length ? priorPerMin / ms.length : FLOOR_PRIOR_.perMin;
  var tc = priorPerMin * FLOOR_PRIOR_.min, min = FLOOR_PRIOR_.min;
  try {
    var st = summaryIndex_(Number(config_().limit_sec) || 60)['*'];
    if (st) ms.forEach(function (m) { tc += Number(st.tc[m]) || 0; min += (Number(st.sec[m]) || 0) / 60; });
  } catch (e) { /* 下駄の値で続ける */ }
  return Math.max(1, Math.round(tc / min * 10) / 10);
}
function coopMinOf_(m) { return Math.max(1, Math.min(30, Math.round(Number(m) || COOP_DEF_MIN))); }
/*
 * 起点の数（1〜児童数、グループの色づかいでは1〜組数）。起点ごとに担当が決まり、
 * 児童 i（グループなら組 g）の正答は起点 (i mod 起点の数) から育つ。1 なら今までどおり1つの図形。
 * 起点の数を児童数にすると、児童ごとの島の大きさがその子の正答数になる（モニターでも見返しでも見える）
 */
function coopOrgOf_(v, max) { return Math.max(1, Math.min(Math.max(1, max), Math.round(Number(v) || 1))); }
/*
 * 起点の位置（教師が見本の上で動かしたもの）。[[u, v], ...]：最初の画面（縮尺1）の左上を (0, 0)、右下を (1, 1) とした割合。
 * 画面の大きさ（箱・全画面・児童の画面）が違っても同じ所に来る。範囲は最小の縮尺の画面の中（u −0.3〜2.8、v −1.6〜1.45）。
 * 数が起点の数と合わなければ使わない（既定の格子に戻る）。どの起点を誰が担当するかは位置を決めてもシードで混ぜる
 */
/** 回に写した育ちの倍率 { モード: 倍率 } を確かめる（読めなければ null＝すべて1倍として描く） */
function coopGw_(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  var out = {}, n = 0;
  for (var k in v) {
    var w = Number(v[k]);
    if (!isFinite(w) || w <= 0) continue;
    out[k] = Math.max(GROW_W_MIN_, Math.min(GROW_W_MAX_, w)); n++;
  }
  return n ? out : null;
}
function coopOrgPts_(v, org) {
  if (!Array.isArray(v) || v.length !== org || org > 60) return null;
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var p = v[i];
    if (!Array.isArray(p) || !isFinite(Number(p[0])) || !isFinite(Number(p[1]))) return null;
    out.push([Math.round(Math.max(-0.3, Math.min(2.8, Number(p[0]))) * 1000) / 1000,
              Math.round(Math.max(-1.6, Math.min(1.45, Number(p[1]))) * 1000) / 1000]);
  }
  return out;
}

/*
 * 続きから（prior）。引き継ぐ前の回の正答を、1本の時間軸に並べ直して新しいセッションに持たせる。
 *   prior = { dur: 前の回までの合計ms, ev: [[t, 児童index, 正答, mode], ...]（新しい名簿の並び）,
 *             segs: [{ end: その回の終わり（累計ms）, minutes, n, lim, pace, total }, ...] }
 * segs は画面が「1正答の枚数」を回ごとに決め直すため（前の回の枚数は前の回の条件で、続きの回は残りの余白で決める）。
 * 前の回が続きからの回なら、その prior も含めて引き継ぐ（何回でも続けられる）。
 * 児童の並びは名簿で変わりうるので、メールで照らし直す（メールを持たない古い保存データは番号と氏名で照らす）。いない児童の分は落とす。
 */
function coopContBase_(cont, prev) {
  var src = null, ev = null, keys = null;
  if (String(cont).indexOf('save:') === 0) {
    var r = coopLoadRaw_(String(cont).slice(5));
    if (!r.ok) return { err: r.msg };
    src = r.payload; ev = src.ev || [];
  } else {
    if (!prev) return { err: '続ける協力プレイがありません。' };
    if (prev.status === 'run') return { err: '進行中の協力プレイがあります。「終了」を押してから続けてください。' };
    src = prev; ev = coopEvents_(prev);
  }
  var n = (src.names || []).length;
  keys = [];
  for (var i = 0; i < n; i++) {
    keys.push(src.order && src.order[i] ? 'm:' + src.order[i] : 'n:' + (src.nos || [])[i] + '|' + (src.names || [])[i]);
  }
  var pin = src.prior || { dur: 0, ev: [], segs: [] };
  var dur = Math.max(0, Number(src.end) - Number(src.start));
  var all = (pin.ev || []).slice();
  var tot = 0;
  ev.forEach(function (e) {
    tot += Number(e[2]) || 0;
    all.push([pin.dur + Math.min(Math.max(0, Number(e[0]) || 0), dur), e[1], Number(e[2]) || 0, Number(e[3]) || 0]);
  });
  var segs = (pin.segs || []).concat([{ end: pin.dur + dur, minutes: Number(src.minutes) || Math.max(1, Math.round(dur / 60000)),
    n: Math.max(1, n - (src.skip || 0)), lim: Number(src.lim) || Number(config_().limit_sec) || 60,
    pace: Number(src.pace) || FLOOR_PRIOR_.perMin, total: tot }]);
  return { cls: String(src.cls), pat: String(src.pat), seed: Number(src.seed) || 1,
           mode: src.mode === 'group' ? 'group' : 'child', gn: Number(src.gn) || 6, org: Number(src.org) || 1, orgPts: src.orgPts || null, gw: src.gw || null,
           keys: keys, order: src.order || null, gi: src.gi || null,   // 続きの回のグループは前の回の編成のまま
           prior: { dur: pin.dur + dur, ev: all, segs: segs } };
}
/** 引き継いだ正答の児童 index を、新しいセッションの名簿の並びへ付け替える */
function coopContRemap_(base, kids) {
  var to = {};
  kids.forEach(function (k, i) { to['m:' + k.mail] = i; to['n:' + k.no + '|' + k.name] = i; });
  var ev = [];
  base.prior.ev.forEach(function (e) {
    var key = base.keys[e[1]], j = key === undefined ? undefined : to[key];
    if (j !== undefined) ev.push([e[0], j, e[2], e[3]]);
  });
  return { dur: base.prior.dur, ev: ev, segs: base.prior.segs };
}
/** coop シートの14列目に置く（キャッシュが消えても続きの部分を失わない）。セルの上限を超えるときは置かない */
function coopPriorCell_(prior) {
  if (!prior) return '';
  var j = JSON.stringify(prior);
  return j.length < 45000 ? j : '';
}

function coopStart_(o, pace) {
  var prev = coopLive_();
  if (prev && prev.status === 'run' && !(o && o.reset)) {
    return { ok: false, msg: '進行中の協力プレイがあります。「終了」を押してから始めてください。' };
  }
  var old = prev || {};
  // 続きから：前の回（いま映している終わった回、または保存データ）の図形と正答を引き継ぐ。
  // 図形・色（シード）・クラス・色づかいは前の回に合わせる（変えると、引き継いだ部分の見え方が変わる）
  var base = null;
  if (o && o.cont) {
    base = coopContBase_(o.cont, prev);
    if (base.err) return { ok: false, msg: base.err };
  }
  var cls = String(base ? base.cls : ((o && o.cls) || old.cls || ''));
  var kids = coopKids_(cls);
  if (!kids.length) return { ok: false, msg: 'そのクラスの児童が名簿にありません。' };
  var pat = String(base ? base.pat : ((o && o.pat) || old.pat || UNIT.floorPattern || 'penrose'));
  if (FLOOR_PATTERNS_.indexOf(pat) < 0) pat = 'penrose';
  var minutes = coopMinOf_((o && o.minutes) || old.minutes || COOP_DEF_MIN);
  var mode = base ? base.mode : (((o && o.mode) || old.mode) === 'group' ? 'group' : 'child');
  // グループ数：保存した編成があればその数（欄の値より優先。欄と編成が食い違って番号順に戻るのを防ぐ）
  var plan = (!base && mode === 'group') ? coopPlanGet_(cls, kids) : null;
  var gn = coopGnOf_(base ? base.gn : plan ? plan.gn : ((o && o.gn) || old.gn || 6));
  var seed = base ? base.seed : Math.floor(Math.random() * 2147483647);
  // 起点の数：続きからは前の回のまま（変えると引き継いだ部分の形が変わる）。名簿・組数が減っていれば上限で切る
  var org = coopOrgOf_(base ? base.org : ((o && o.org) || old.org || 1), mode === 'group' ? gn : kids.length);
  // 起点の位置：続きからは前の回のまま。画面が送ってきた時はそれ（null＝既定の格子）、送らない時（リセット・古い画面）は前の回のまま
  var orgPts = coopOrgPts_(base ? base.orgPts : (o && 'orgPts' in o ? o.orgPts : old.orgPts), org);
  // 育ちの倍率は開始の時点の設定を回に写す（あとで設定を変えても、その回の再生・見返し・続きからの形は変わらない）。続きからは前の回のまま
  var gw = (base && coopGw_(base.gw)) || growWeights_();
  var kidsMap = {}, order = [], gi = [];
  // グループは保存した編成。無ければ番号順の等分。
  // 続きからの回は前の回の編成を引き継ぐ（メールで照らす。前の回にいない児童は番号順の等分の位置）
  var bmap = {};
  if (base && base.order && base.gi) base.order.forEach(function (m, i) { bmap[m] = Number(base.gi[i]); });
  kids.forEach(function (k, i) {
    kidsMap[k.mail] = i; order.push(k.mail);
    var bg = bmap[k.mail];
    gi.push(plan ? plan.gi[i]
         : (bg >= 0 && bg < gn) ? bg
         : Math.min(gn - 1, Math.floor(i * gn / kids.length)));
  });
  var prior = base ? coopContRemap_(base, kids) : null;
  var id = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  var now = Date.now();
  // countdown 付きの開始は、始まりを今から COOP_COUNTDOWN_MS 後に置く。教師画面はこの start に合わせて数える。
  // 始まりをサーバーが先に決めるので、混雑で開始に失敗しても「スタート」を出す前に分かる
  var start = now + (o && o.countdown ? COOP_COUNTDOWN_MS : 0);
  var s = { id: id, cls: cls, pat: pat, seed: seed, mode: mode, gn: gn, minutes: minutes,
            start: start, end: start + minutes * 60000, status: 'run', total: 0,
            kids: kidsMap, order: order,
            names: kids.map(function (k) { return k.name; }),
            nos: kids.map(function (k) { return k.no; }),
            gi: gi, skip: coopSkip_(cls), prior: prior, org: org, orgPts: orgPts, gw: gw,
            pace: Number(pace) || old.pace || FLOOR_PRIOR_.perMin };   // 画面が「1正答の枚数」を自動で決めるのに使う
  sh_(SHEETS.COOP).appendRow([id, cls, pat, seed, mode, gn, JSON.stringify(gi),
    JSON.stringify(s.names), JSON.stringify(s.nos), new Date(start), new Date(s.end), 'run', 0, coopPriorCell_(prior), org, orgPts ? JSON.stringify(orgPts) : '', JSON.stringify(gw)]);
  cache_().put('coop_ev_' + id, '[]', TTL.session);
  cache_().put('coop_fl_' + id, '0', TTL.session);
  if (prev) {
    // リセットで途中から切り直したときは、前のセッションの終わりをいまにする（これから遊び終える回は新しい方へ）
    prev.status = 'done'; prev.end = Math.min(prev.end, now);
    coopFlush_(prev, true);
    coopRowWrite_(prev.id, { status: 'done', total: prev.total, end: prev.end });
    cache_().put('coop_rt_' + prev.id, String(prev.total), TTL.session);
    cache_().put('coop_prev', JSON.stringify(prev), TTL.session);
  }
  coopPutLive_(s);
  return { ok: true, session: coopPub_(s, 0), now: Date.now() };   // now：教師画面がカウントダウンを時計のずれ込みで数える
}

/** 進行中のセッションの様子。since 以降のイベントだけ返す（差分ポーリング用） */
function coopState(since) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var s = coopLive_();
  if (!s) return { ok: true, status: 'none' };
  var now = Date.now();
  if (s.status === 'run' && now > s.end) {    // 時刻で打ち切り。おわるの押し忘れでも閉じる
    // 3秒ごとに呼ばれるので、ロックは閉じるときだけ取る。取れなければ次の呼び出しで閉じる（提出は時刻で弾かれている）
    var lock = LockService.getScriptLock();
    if (lock.tryLock(3000)) {
      try {
        var cur = coopLive_();
        if (cur && cur.id === s.id && cur.status === 'run') {
          cur.status = 'done'; coopPutLive_(cur);
          coopRowWrite_(cur.id, { status: 'done', total: cur.total });
          cache_().put('coop_rt_' + cur.id, String(cur.total), TTL.session);
        }
        s = cur || s;
      } finally { try { lock.releaseLock(); } catch (e) {} }
    }
  }
  coopFlush_(s, false);
  coopSyncTotal_(s);
  var p = coopPrev_();               // 直前のセッションに届いた送り直しも書いておく
  if (p) { coopFlush_(p, false); coopSyncTotal_(p); }
  var r = coopPub_(s, since);
  r.ok = true; r.now = now; r.ended = now > s.end;
  return r;
}

/** 打ち切り：これ以降の提出は数えず、画面は終了表示になる */
function coopStop() {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  return coopLocked_(function () {
    var s = coopLive_();
    if (!s) return { ok: false, msg: '協力プレイはありません。' };
    s.status = 'done'; s.end = Math.min(s.end, Date.now());
    coopPutLive_(s);
    coopFlush_(s, true);
    coopRowWrite_(s.id, { status: 'done', total: s.total, end: s.end });
    cache_().put('coop_rt_' + s.id, String(s.total), TTL.session);
    return { ok: true, session: coopPub_(s, 0) };
  });
}

/** 図形を消して同じ設定で始め直す（新しいセッション。前の分は履歴に残る）。o.countdown で開始と同じく数えてから始める */
function coopReset(o) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  return coopStart({ reset: true, countdown: !!(o && o.countdown) });
}

/** 組の編成を一括で書き換える。gi = 児童indexごとの組番号（0〜gn-1） */
function coopSetGroups(gi) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  return coopLocked_(function () {
    var s = coopLive_();
    if (!s) return { ok: false, msg: '協力プレイはありません。' };
    if (!Array.isArray(gi) || gi.length !== s.names.length) {
      return { ok: false, msg: 'グループの数が名簿と合いません。' };
    }
    s.gi = gi.map(function (g) { return Math.max(0, Math.min(s.gn - 1, Math.round(Number(g) || 0))); });
    coopPutLive_(s);
    coopRowWrite_(s.id, { gi: s.gi });
    // 遊んでいる途中の編集も編成に残す（次の開始で同じグループから始められるように）
    if (s.order) { try { coopPlanPut_(s.cls, s.gn, s.order, s.gi); } catch (e) {} }
    return { ok: true };
  });
}

/**
 * 保存した編成を、進行中（映している）回の児童の並びに合わせて読む。回には書かない。
 * 教師画面はこれを窓に読み込み、「保存」（coopSetGroups）で回に効かせる。
 */
function coopLivePlan() {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var s = coopLive_();
  if (!s || s.mode !== 'group' || !s.order) return { ok: false, msg: 'グループの協力プレイがありません。' };
  var kids = s.order.map(function (m, i) { return { mail: m, no: s.nos[i] }; });
  var plan = coopPlanGet_(s.cls, kids);
  if (plan && plan.gn !== s.gn) return { ok: false, msg: '保存した編成は' + plan.gn + 'グループで、この回（' + s.gn + 'グループ）と数が違います。' };
  return { ok: true, gi: plan ? plan.gi : coopPlanDefault_(s.gn, kids), saved: !!plan };
}

/** いまのセッションを再生データとして保存する。終了前でもその時点までを保存 */
function coopSave(name) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var s = coopLive_();
  if (!s) return { ok: false, msg: '保存する協力プレイがありません。' };
  coopFlush_(s, false);
  // pace・lim・skip は再生で「1正答の枚数」を開始時と同じに自動計算するため（無い古い保存は既定値で計算する）
  var payload = { v: 1, cls: s.cls, pat: s.pat, seed: s.seed, mode: s.mode, gn: s.gn, org: s.org || 1, orgPts: s.orgPts || null, gw: s.gw || null,
                  start: s.start, end: s.end, total: s.total,
                  pace: s.pace || FLOOR_PRIOR_.perMin, minutes: s.minutes, lim: Number(config_().limit_sec) || 60, skip: s.skip || 0,
                  names: s.names, nos: s.nos, gi: s.gi, ev: coopEvents_(s),
                  order: s.order, prior: s.prior || null };   // order：続きから始める時に児童をメールで照らす
  var sid = 's' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  var nm = String(name || '').trim() ||
    (s.cls.replace('-', '年') + '組 ' +
     Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d H:mm'));
  var pj = JSON.stringify(payload);
  if (pj.length > 49000 && payload.prior) {
    // セルの上限（5万字）を超える：前の回までの分を外して保存する（この回の分は残る）
    payload.prior = null; pj = JSON.stringify(payload);
  }
  sh_(SHEETS.COOPSAVE).appendRow([sid, nm, new Date(), s.id, pj]);
  return { ok: true, id: sid, name: nm };
}

/** 保存済みの一覧（payload は返さない。読むときは coopLoad） */
function coopList() {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var sh = ss_().getSheetByName(SHEETS.COOPSAVE), out = [];
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (!v[i][0]) continue;
      // クラスは payload の先頭近くにある。一覧のために全体を JSON.parse しない
      var mc = String(v[i][4] || '').match(/"cls":"([^"]*)"/);
      out.push({ id: String(v[i][0]), name: String(v[i][1]), saved: dstr_(v[i][2]), cls: mc ? mc[1] : '' });
    }
  }
  out.reverse();
  return { ok: true, saves: out, rv: coopRvMap_() };
}

/** 保存データを読む（再生用。live のセッションは動かさない） */
function coopLoad(id) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var r = coopLoadRaw_(id);
  // 画面にはメールアドレスを渡さない（order は続きから始める時にサーバーの中だけで使う）
  if (r.ok && r.payload) delete r.payload.order;
  return r;
}
function coopLoadRaw_(id) {
  var sh = ss_().getSheetByName(SHEETS.COOPSAVE);
  if (!sh || sh.getLastRow() < 2) return { ok: false, msg: '保存データがありません。' };
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    if (String(v[i][0]) !== String(id)) continue;
    return { ok: true, name: String(v[i][1]), payload: JSON.parse(v[i][4]) };
  }
  return { ok: false, msg: '保存データが見つかりません。' };
}

/* ---- 児童の見返しに出す回（教師が保存データを選ぶ。選ばなければそのクラスの直前の回） ---- */
/** config の coop_rv（"3-1=s0123abcd45,3-2=…"）を { クラス: 保存ID } に */
function coopRvMap_() {
  var m = {};
  String(config_().coop_rv || '').split(',').forEach(function (kv) {
    var p = kv.split('='); var k = String(p[0] || '').trim(), id = String(p[1] || '').trim();
    if (k && /^s[0-9a-f]{10}$/.test(id)) m[k] = id;
  });
  return m;
}
/**
 * 選ばれた保存データの、児童の判定に要る分だけ（クラス・図形・合計・児童の並び）。
 * coopPeek は開いている児童画面から何度も呼ばれるので、payload 全体ではなくこの小さい控えをキャッシュから読む。
 * 保存データが消えていれば null（直前の回に戻る）
 */
function coopRvHead_(id) {
  var key = 'coop_rvh_' + id, hit = cache_().get(key);
  if (hit) return JSON.parse(hit);
  var r = coopLoadRaw_(id);
  var h = null;
  if (r.ok && r.payload) {
    var p = r.payload, tot = Number(p.total) || 0;   // 続きからの回は前の回までの正答も見返しに入る
    ((p.prior && p.prior.ev) || []).forEach(function (e) { tot += Number(e[2]) || 0; });
    h = { cls: String(p.cls || ''), pat: p.pat, total: tot, order: p.order || [] };
  }
  cache_().put(key, JSON.stringify(h), TTL.session);
  return h;
}
/** 教師画面：そのクラスの見返しに出す保存データを選ぶ。id が空なら「直前の回」に戻す */
function coopSetReview(cls, id) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  cls = String(cls || '').trim(); id = String(id || '').trim();
  if (!cls) return { ok: false, msg: 'クラスを選んでください。' };
  if (id) {
    cache_().remove('coop_rvh_' + id);
    var h = coopRvHead_(id);
    if (!h) return { ok: false, msg: '保存データが見つかりません。' };
    if (h.cls !== cls) return { ok: false, msg: 'この保存データは別のクラスの回です。' };
  }
  var m = coopRvMap_(), parts = [];
  if (id) m[cls] = id; else delete m[cls];
  for (var k in m) parts.push(k + '=' + m[k]);
  saveConfig({ coop_rv: parts.join(',') });
  return { ok: true, rv: m };
}

/**
 * 児童画面用：協力モード中なら自分の色に必要な分だけ（他の児童の情報は出さない）。
 * lim（制限秒）を渡すと、いま始める回が協力の終わりまでに遊び終わるか（counts）も返す。
 * 残り1分を切ってから始めた回は数えないので、印を「数えません」に切り替えるため
 */
function coopForChild_(c, lim) {
  var s = coopLive_();
  if (!s || s.status !== 'run' || Date.now() > s.end || !c || classKey_(c) !== s.cls) {
    // 終わった回を見返せるか。キャッシュだけを見る軽い判定。正答が1つも無い回（試しに開始して終えた回など）は見せない
    //  - 教師が保存データを選んだクラス：その回に自分がいれば
    //  - 選んでいないクラス：最後の回が自分のクラスの回で、自分が名簿にいれば
    if (!c) return { active: false };
    var ck = classKey_(c);
    var pick = coopRvMap_()[ck], h = pick ? coopRvHead_(pick) : null;
    if (h && h.cls === ck) {
      return (h.total > 0 && h.order.indexOf(c.email) >= 0) ? { active: false, review: true, rid: 'sv:' + pick, pat: h.pat } : { active: false };
    }
    var rv = !!(s && ck === s.cls && s.kids[c.email] !== undefined && (s.status !== 'run' || Date.now() > s.end) && s.total > 0);
    return rv ? { active: false, review: true, rid: s.id, pat: s.pat } : { active: false };
  }
  var i = s.kids[c.email];
  if (i === undefined) return { active: false };
  var r = { active: true, i: i, n: s.order.length, seed: s.seed, pat: s.pat, mode: s.mode };
  if (lim) r.counts = Date.now() + Number(lim) * 1000 <= s.end + COOP_SLACK_MS && Date.now() >= s.start - COOP_EARLY_MS;
  if (s.mode === 'group') { r.g = s.gi[i]; r.gn = s.gn; }
  return r;
}

/**
 * 児童画面の定期確認用。boot よりはるかに軽い応答だけ返す（キャッシュ読み2つ程度）。
 * 開いたままの画面に「協力プレイ中」の印をすぐ出すため、児童側が間を置いて聞き続ける
 */
function coopPeek(lim) {
  return coopForChild_(child_(email_()), Number(lim) || 0);
}

/*
 * 児童が、終わった協力プレイの図形を見返す（児童画面の左上の「前回の協力プレイ」）。
 * できるのは自分（グループなら自分の組）の色を目立たせることだけ。他の児童の色を選んで目立たせる手段は作らない
 * （誰の正答が少ないかを児童どうしで見つけられないようにするため）。応答には名前・番号・メール・組の一覧（gi）を入れない。
 * 色は教師画面（モニター）と同じ（index はそのまま）。色の割り当ては回ごとのシードで決まり、新しく始めるたびに変わる（続きからの回だけ前の回と同じ）。
 * 組の色づかいでは、各正答にその児童の組番号だけを付ける（組の合計はモニターにも出ている）。
 */
function coopReview() {
  var c = child_(email_());
  if (!c) return { ok: false, msg: 'めいぼに とうろくが ありません。' };
  var ck = classKey_(c), s = coopLive_();
  var running = s && s.status === 'run' && Date.now() <= s.end;
  if (running && s.cls === ck) return { ok: false, msg: 'まだ 見られる 協力プレイが ありません。' };
  var none = { ok: false, msg: 'まだ 見られる 協力プレイが ありません。' };
  var notMine = { ok: false, msg: 'この 協力プレイには あなたの きろくが ありません。' };
  // 教師が保存データを選んだクラスはその回（消えていれば直前の回に戻る）
  var pick = coopRvMap_()[ck], raw = pick ? coopLoadRaw_(pick) : null, p = raw && raw.ok ? raw.payload : null;
  if (p && String(p.cls) === ck) {
    var pm = (p.order || []).indexOf(c.email);
    if (pm < 0) return notMine;
    return coopRvOut_({ pat: p.pat, seed: p.seed, mode: p.mode, gn: p.gn, gi: p.gi || [], gw: p.gw, org: p.org, orgPts: p.orgPts,
                        n: (p.names || []).length, prior: p.prior, minutes: p.minutes, pace: p.pace, skip: p.skip, end: p.end },
                      pm, p.ev || []) || none;
  }
  if (!s || s.cls !== ck || running) s = coopLastDone_(ck);
  if (!s) return none;
  var me = s.kids[c.email];
  if (me === undefined) return notMine;
  return coopRvOut_({ pat: s.pat, seed: s.seed, mode: s.mode, gn: s.gn, gi: s.gi || [], gw: s.gw, org: s.org, orgPts: s.orgPts,
                      n: (s.names || []).length, prior: s.prior, minutes: s.minutes, pace: s.pace, skip: s.skip, end: s.end },
                    me, coopEvents_(s)) || none;
}
/** 見返しの応答を組む（直前の回・保存データで共通）。ev はこの回の [時刻, 児童 index, 正答数, モード]。正答が1つも無ければ null */
function coopRvOut_(s, me, evNow) {
  var group = s.mode === 'group', pri = (s.prior && s.prior.dur) || 0, gn = s.gn || 1;
  function gOf(i) { return Math.max(0, Math.min(gn - 1, Number(s.gi[i]) || 0)); }
  // 各正答：[時刻, 児童 index, 正答数, 組番号（児童ごとの回は 0）, 育ちの倍率]。正答数は生のまま（「じぶん N もん」に使う）
  var gw = s.gw || {}, ws = [];
  for (var gk in gw) ws.push(Number(gw[gk]) || 1);
  function out(e, shift) {
    return [Number(e[0]) + shift, Number(e[1]) || 0, Number(e[2]) || 0, group ? gOf(e[1]) : 0, Number(gw[e[3]]) || 1];
  }
  var ev = ((s.prior && s.prior.ev) || []).map(function (e) { return out(e, 0); })
    .concat((evNow || []).map(function (e) { return out(e, pri); }));
  var total = ev.reduce(function (a, e) { return a + e[2]; }, 0);
  if (!total) return null;   // 正答が1つも無い回（試しに開始して終えた回など）は見せない
  return { ok: true, pat: s.pat, seed: s.seed, mode: s.mode, gn: s.gn, org: s.org || 1, orgPts: s.orgPts || null, n: s.n, me: me,
           mine: toBool_(config_().coop_mine),   // 教師の設定で「じぶん」の数を出さないこともできる（出すだけ。他の児童の数は出ない）
           g: group ? gOf(me) : null,
           ev: ev, total: total, pri: pri, segs: (s.prior && s.prior.segs) || [],
           wm: ws.length ? ws.reduce(function (a, w) { return a + w; }, 0) / ws.length : 1,   // 倍率の平均（自動の枚数の見込みに使う。教師画面と同じ）
           minutes: s.minutes, lim: Number(config_().limit_sec) || 60, pace: s.pace || FLOOR_PRIOR_.perMin, skip: s.skip || 0,
           end: s.end };
}
/** そのクラスの最後に終わった回（キャッシュに無い時は coop シートから） */
function coopLastDone_(ck) {
  var sh = ss_().getSheetByName(SHEETS.COOP);
  if (!sh || sh.getLastRow() < 2) return null;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 17).getValues(), now = Date.now();
  for (var i = v.length - 1; i >= 0; i--) {
    if (String(v[i][1]) !== ck) continue;
    var end = v[i][10] instanceof Date ? v[i][10].getTime() : new Date(v[i][10]).getTime();
    if (String(v[i][11]) === 'run' && now <= end) return null;   // そのクラスはいま遊んでいる
    return coopFromRow_(v[i]);
  }
  return null;
}

/* ---- 集計 ---- */

function aggregate() {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  return aggregateCore_();
}

function nightlyAggregate() {
  try { aggregateCore_(); } catch (e) { console.error('nightlyAggregate 失敗: ' + e.message); }
}

function typeOrder_() { return Object.keys(UNIT.types); }

function aggregateCore_() {
  var cfg = config_();
  var v = sh_(SHEETS.LOG).getDataRange().getValues();
  var child = {}, typeMiss = {}, wrongCnt = {};
  var named = namedMails_();   // 分析の対象は、名簿に email と氏名の両方がある児童だけ

  function slot(mail, row) {
    if (!child[mail]) {
      child[mail] = { name: row[LOG_COL_.NAME], grade: row[LOG_COL_.GRADE], cls: row[LOG_COL_.CLS], no: row[LOG_COL_.NO], t: {}, miss: 0 };
    }
    return child[mail];
  }

  // 期間窓。全期間平均にすると直近の変化が薄まって伸びが見えなくなる。
  var days = Number(cfg.window_days) || 0;
  var cutoff = days > 0 ? (Date.now() - days * 86400000) : 0;
  var used = 0;

  for (var i = 1; i < v.length; i++) {
    var mail = String(v[i][LOG_COL_.MAIL]).toLowerCase();
    if (!mail || !named[mail]) continue;
    var row = v[i];

    if (cutoff) {
      var ts = rowTime_(row[LOG_COL_.TS]);
      if (ts && ts < cutoff) continue;    // 読めない ts は残す（見落としを避ける）
    }
    used++;

    String(row[LOG_COL_.TSTAT] || '').split(',').forEach(function (t) {
      if (!t) return;
      var p = t.split(':');
      if (p.length < 3) return;
      var c = slot(mail, row);
      if (!c.t[p[0]]) c.t[p[0]] = [0, 0, 0, 0, 0, 0, 0];
      c.t[p[0]][0] += Number(p[1]) || 0;
      c.t[p[0]][1] += Number(p[2]) || 0;
      var x = typeStat_(t);               // 初打鍵を記録するようになってからの行
      if (x) {
        c.t[p[0]][2] += x.ntk; c.t[p[0]][3] += x.tk; c.t[p[0]][4] += x.tk2;
        c.t[p[0]][5] += x.ln;  c.t[p[0]][6] += x.ln2;
      }
    });

    String(row[LOG_COL_.MISS] || '').split(',').forEach(function (t) {
      if (!t) return;
      var ty = t.split(':')[0];
      if (!ty) return;
      typeMiss[ty] = (typeMiss[ty] || 0) + 1;
      slot(mail, row).miss++;
    });

    String(row[LOG_COL_.WRONG] || '').split(',').forEach(function (t) {
      if (!t || t.indexOf('|') < 0) return;
      wrongCnt[t] = (wrongCnt[t] || 0) + 1;
    });
  }

  writeWeakChild_(child, cfg);
  writeWeakClass_(typeMiss, wrongCnt);
  writeMistakes_(v, named);

  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
  var span = days > 0 ? ('直近' + days + '日') : '全期間';
  try {
    sh_(SHEETS.WCHILD).getRange(1, typeOrder_().length + 9)
      .setValue('最終集計: ' + stamp + '（' + span + '）').setFontColor('#888888');
  } catch (e) {}
  return '集計しました（' + span + ' ' + used + ' 試行 / 全 ' + (v.length - 1) + ' 試行 / ' + stamp + '）';
}

/**
 * "1/200" と問題型から "1km200m" のような単位つき表示を作る。
 * UNIT.fieldsByType が無い単元（九九など、答えが単一値でよい単元）では素の値を返す。
 */
function fmtByType_(type, joined) {
  var vals = String(joined).split('/');
  // 欄の順と読みの順が違う単元（筆算は一の位から打つ）は、単元が読める形に直す
  if (typeof UNIT.fmtAnswer === 'function') { try { return String(UNIT.fmtAnswer(type, vals)); } catch (e) {} }
  var fields = UNIT.fieldsByType && UNIT.fieldsByType[type];
  if (!fields || fields.length !== vals.length) return vals.join(' ');
  return vals.map(function (v, i) { return v + fields[i]; }).join('');
}

/**
 * 誰が・どの問題を・何と間違えたかを1行1件で並べる。
 * log の wrong_items を展開する。新しい記録ほど上に来る。直近2000件まで。
 * 旧形式（型｜出題｜誤答 の3分割）にも後方互換で対応する（正答欄は空欄になる）。
 * named が渡されたときは、その集合に無い児童の記録を除く（名簿外は分析対象外）。
 */
function writeMistakes_(logRows, named) {
  var sh = ss_().getSheetByName(SHEETS.MISTAKES) || ss_().insertSheet(SHEETS.MISTAKES);
  sh.clear(); sh.setConditionalFormatRules([]);

  var head = ['日時', '学年', '組', '番号', '氏名', 'モード', '問題型', 'もんだい', '正しい答え', 'こたえた値'];
  var body = [];

  for (var i = 1; i < logRows.length; i++) {
    var row = logRows[i];
    if (named && !named[String(row[LOG_COL_.MAIL] || '').toLowerCase()]) continue;
    var wrongStr = String(row[LOG_COL_.WRONG] || '');
    if (!wrongStr) continue;
    wrongStr.split(',').forEach(function (entry) {
      var p = entry.split('|');
      if (p.length < 3) return;
      var type = p[0], tag = p[1], correct, wrong;
      if (p.length >= 4) { correct = fmtByType_(type, p[2]); wrong = fmtByType_(type, p[3]); }
      else { correct = ''; wrong = fmtByType_(type, p[2]); }   // 旧形式
      body.push([row[LOG_COL_.TS], row[LOG_COL_.GRADE], row[LOG_COL_.CLS], row[LOG_COL_.NO],
                 row[LOG_COL_.NAME], row[LOG_COL_.MNAME], type, tag, correct, wrong]);
    });
  }
  body.reverse();
  if (body.length > 2000) body = body.slice(0, 2000);

  var out = [head].concat(body);
  sh.getRange(1, 1, out.length, head.length).setValues(out);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (body.length) sh.getRange(2, 1, body.length, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  else sh.getRange(2, 1).setValue('まだ誤答のデータがありません（この機能を入れる前の記録は対象外です）。');

  sh.getRange('A1').setNote(
    '誰が・どの問題を・何と間違えたかを1行1件で並べたものです。新しい記録ほど上にあります。\n' +
    '個別に声をかけるときの参考にしてください。全体の傾向を見るなら weak_class を見てください。'
  );
  sh.setTabColor('#93C47D');
}

function writeWeakChild_(child, cfg) {
  var sh = sh_(SHEETS.WCHILD);
  sh.clear(); sh.setConditionalFormatRules([]);
  var order = typeOrder_();

  var wobble = Number(cfg.wobble_pct) || 40;

  // 「遅い」は同じ学年・同じ型の児童の分布と比べる（秒の固定閾値は使わない）
  var norms = gradeNorms_(Object.keys(child).map(function (k) {
    var c = child[k], t = {};
    Object.keys(c.t).forEach(function (ty) {
      var x = c.t[ty];
      if (x && x[2]) t[ty] = { n: x[2], ms: Math.exp(x[5] / x[2]) };
    });
    return { grade: c.grade, t: t };
  }));
  var BAND_BG = { 2: '#F8C9C9', 3: '#EE8E8E' };
  var bgs = [];

  var head = ['学年', '組', '番号', '氏名'];
  order.forEach(function (t) { head.push(UNIT.types[t]); });
  head.push('ゆらぎ', 'ゆらぎの型', '誤答数');

  var rows = [head];
  Object.keys(child).sort(function (a, b) {
    var x = child[a], y = child[b];
    return x.grade - y.grade || (x.cls < y.cls ? -1 : x.cls > y.cls ? 1 : 0) || x.no - y.no;
  }).forEach(function (k) {
    var c = child[k], r = [c.grade, c.cls, c.no, c.name], bg = [];
    var wMax = 0, wType = '';
    order.forEach(function (t) {
      var x = c.t[t];
      if (!x || !x[2]) { r.push(''); bg.push(null); return; }   // 初打鍵のデータが無い型は空欄
      var n = x[2], mean = x[3] / n, gm = Math.exp(x[5] / n);
      r.push(Math.round(gm / 100) / 10);         // 表示は秒。代表値は幾何平均（判定と同じ値）
      // 回数が少ない型は平均が不安定なので色を付けない（分布にも入れていない）
      var band = n >= SLOW_MIN_TRIES_ ? slowBand_(gm, (norms[c.grade] || {})[t]) : -1;
      bg.push(BAND_BG[band] || null);

      // ばらつきは 標準偏差÷平均（%）。試行が少ないと不安定なので5回以上の型だけ候補にする
      if (n >= 5 && mean > 0) {
        var vr = x[4] / n - mean * mean;
        var cv = Math.round((vr > 0 ? Math.sqrt(vr) : 0) / mean * 100);
        if (cv > wMax) { wMax = cv; wType = UNIT.types[t]; }
      }
    });
    r.push(wMax || '', wType, c.miss);
    rows.push(r); bgs.push(bg);
  });

  sh.getRange(1, 1, rows.length, head.length).setValues(rows);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold');
  sh.setFrozenRows(1); sh.setFrozenColumns(4);

  if (rows.length > 1) {
    var n = rows.length - 1, wob = 5 + order.length;   // ゆらぎ列 / その右が型名 / さらに右が誤答数
    sh.getRange(2, 5, n, order.length).setNumberFormat('0.0"秒"');
    sh.getRange(2, wob, n, 1).setNumberFormat('0"%"');
    sh.getRange(2, wob + 2, n, 1).setNumberFormat('0"回"');
    // 基準が学年×型ごとに違うので、条件付き書式ではなくセルごとに色を塗る
    if (order.length) sh.getRange(2, 5, n, order.length).setBackgrounds(bgs);
    sh.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenNumberGreaterThan(wobble).setBackground('#FDE4B8')
        .setRanges([sh.getRange(2, wob, n, 1)]).build()
    ]);
  }
  sh.getRange('A1').setNote(
    (UNIT.tips ? UNIT.tips.replace(/<[^>]+>/g, '') + '\n\n' : '') +
    '各型の数字は「問題が出てから最初のキーを押すまで」の代表値（幾何平均）です（想起にかかった時間）。\n' +
    'ときどき大きく遅れた回に引っぱられにくいよう、ふつうの平均ではなく幾何平均にしています。\n' +
    '打鍵にかかる時間を含まないので、答えの桁数が違う型どうしを比べられます。\n' +
    '赤いセルは、同じ学年・同じ型の児童の中央より 1σ以上遅い（濃い赤は2σ以上）。\n' +
    'σは中央値からの絶対偏差（MAD）を標準偏差の目盛りにそろえたもので、時間は対数に直して比べています\n' +
    '（時間は遅い側に裾が長く、ふつうの平均と標準偏差は数人の極端な値に引っぱられるため）。\n' +
    '秒の固定の基準は使っていません（型ごとに打つ数や手順が違うため）。\n' +
    'その型を ' + SLOW_MIN_TRIES_ + ' 回以上やった児童が ' + SLOW_MIN_KIDS_ + ' 人未満の学年・型、' + SLOW_MIN_TRIES_ + ' 回未満の児童には色を付けません。\n\n' +
    '「ゆらぎ」は、その子がいちばん不安定だった型の ばらつき（標準偏差÷平均）です（' + wobble + '%超で色）。\n' +
    '平均が基準内でもここが大きい子は、想起できる時と数えている時が混ざっています。\n' +
    '平均だけを見ていると、この子は「基準内」に見えて素通りします。\n' +
    '平均が遅い子は手続きの短縮、ゆらぎが大きい子は想起そのものの練習が要ります。\n\n' +
    '空欄は、この期間にその型のデータが無いという意味です。\n' +
    '（初打鍵の記録は途中から始めたため、それ以前の記録しかない子は空欄になります）'
  );
  sh.setTabColor('#93C47D');
}

function writeWeakClass_(typeMiss, wrongCnt) {
  var sh = sh_(SHEETS.WCLASS);
  sh.clear(); sh.setConditionalFormatRules([]);

  var rows = [['問題型', '説明', '誤答数']];
  typeOrder_().forEach(function (t) { rows.push([t, UNIT.types[t], typeMiss[t] || 0]); });
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  sh.getRange(1, 1, 1, 3).setFontWeight('bold');

  var start = rows.length + 2;
  sh.getRange(start, 1).setValue('よくある誤答（多い順）').setFontWeight('bold');
  sh.getRange(start + 1, 1, 1, 5)
    .setValues([['問題型', '出題', '正しい答え', 'こたえた値', '回数']]).setFontWeight('bold');

  var list = Object.keys(wrongCnt).map(function (k) {
    var p = k.split('|');
    var type = p[0], tag = p[1], correct, wrong;
    if (p.length >= 4) { correct = fmtByType_(type, p[2]); wrong = fmtByType_(type, p[3]); }
    else { correct = ''; wrong = fmtByType_(type, p[2]); }   // 旧形式（正答が無い）
    return [type, tag, correct, wrong, wrongCnt[k]];
  }).sort(function (a, b) { return b[4] - a[4]; }).slice(0, 40);

  if (list.length) sh.getRange(start + 2, 1, list.length, 5).setValues(list);
  else sh.getRange(start + 2, 1).setValue('データなし');
  sh.setColumnWidth(2, 150); sh.setColumnWidth(3, 130); sh.setColumnWidth(4, 130);

  sh.getRange('A1').setNote(
    '学級全体で、どの型の問題がよく間違えられているかの一覧です。\n' +
    '下の「よくある誤答」は、正しい答えと実際の誤答を並べたものです。\n' +
    '一斉指導でどの型を扱うか決めるときに使ってください。'
  );
  sh.setTabColor('#93C47D');
}

/* ---- 教師画面「ぶんせき」タブ ----
 * weak_child / weak_class と同じ期間窓（window_days）と名簿条件で
 * log を1回だけ読み、クラス別・児童別・日別の集計をまとめて返す。
 * シートには書き込まない（weak_* は従来どおり nightly 集計が作る）。
 * 年度替わり（4/1）を越える記録は分析に混ぜない。クラス替えの履歴が
 * 新しいクラスに混入するのを防ぐためで、log の行自体は履歴として残る。
 */

/**
 * miss_items / wrong_items は ',' 区切りだが、円と球の初版ではタグ自体に ',' が入っていた
 * （例 'B:chord,rad,short,off'。現在は '-' 区切りで、tag の ',' は契約検査で禁止）。過去の行のために残す。
 * 「既知の型名 + ':' または '|'」で始まる断片だけを
 * 新しい要素として切り、それ以外は直前の要素のタグの続きとして連結して戻す。
 */
function splitCellItems_(cell, typeSet) {
  var out = [];
  String(cell || '').split(',').forEach(function (f) {
    if (!f) return;
    var c0 = f.indexOf(':'), c1 = f.indexOf('|');
    var cut = c0 < 0 ? c1 : (c1 < 0 ? c0 : Math.min(c0, c1));
    var head = cut < 0 ? '' : f.slice(0, cut);
    if (head && typeSet[head]) out.push(f);
    else if (out.length) out[out.length - 1] += ',' + f;
    else out.push(f);   // 先頭が壊れていても落とさない（見落としを避ける）
  });
  return out;
}
function getAnalysis(fresh, fyear) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var fy = Number(fyear) || 0;
  var key = 'analysis_' + fy;
  if (!fresh) {
    var hit = cache_().get(key);
    if (hit) return JSON.parse(hit);
  }
  var out = buildAnalysis_(fy);
  var json = JSON.stringify(out);
  if (json.length < 90000) cache_().put(key, json, 120);
  return out;
}

/* ============================================================
 *  過年度（教師画面の「過年度」タブ）
 *
 *  log を年度（4/1〜翌3/31）ごとに畳み、型ごと・問題ごとに
 *  「どこで時間がかかり、どこで誤答が多かったか」を出す。個人は出さない（集団の値だけ）。
 *
 *  問題ごとの出題数は log に残っていない（残るのは誤答・遅かった問題だけ）。
 *  そこで出題の正本 UNIT.gen を回して「モードごとの各問題の出やすさ」を求め、
 *  その年度の回ごとの解いた数（attempts）に掛けて出題数を推定する（推定出題数）。
 *  genQueue_ は直前3問の重複を避けるので、実際の出題とは少しずれる（推定と明記して出す）。
 *
 *  個人情報の消去（児童001などへの置き換え）はハブの「過年度」タブで全単元まとめて行う。
 *  単元ごとに振ると、同じ児童が単元ごとに別の番号になるため（apps/hub/Archive.gs）。
 * ============================================================ */

var PAST_FREQ_DRAWS_ = 3000;   // モードごとに gen を回す回数。1%の問題で相対誤差 約±18%（二項分布の標準誤差）
var PAST_ITEM_MIN_ = 20;       // 推定出題数がこれ未満の問題は誤答率の順位に入れない（an_min_trials と同じ値）
var PAST_ITEM_TOP_ = 15;

/** モードごとの各問題の出やすさ { mode: { 't|tag': 確率 } }。gen は決定的なのでシードを固定すれば毎回同じ */
function tagFreq_() {
  var hit = cache_().get('tagfreq');
  if (hit) return JSON.parse(hit);
  var out = {};
  modeIds_().forEach(function (m) {
    var rand = rng_(20250401 + Number(m)), cnt = {}, f = {};
    for (var i = 0; i < PAST_FREQ_DRAWS_; i++) {
      var it = UNIT.gen(rand, m), k = (it.t || '') + '|' + it.tag;
      cnt[k] = (cnt[k] || 0) + 1;
    }
    Object.keys(cnt).forEach(function (k) { f[k] = cnt[k] / PAST_FREQ_DRAWS_; });
    out[m] = f;
  });
  var j = JSON.stringify(out);
  if (j.length < 90000) cache_().put('tagfreq', j, 21600);
  return out;
}

/**
 * log の行 → 年度ごとの集計（純粋。tests/past.test.cjs が叩く）。
 * rows: log の値（見出し行を含む）。fyOf: 時刻 → 年度。freq: tagFreq_() の形。order: 型の並び。
 */
function pastStats_(rows, fyOf, freq, order) {
  var typeSet = {};
  order.forEach(function (t) { typeSet[t] = true; });
  var Y = {};
  function yr(fy) {
    return Y[fy] || (Y[fy] = { fy: fy, trials: 0, kids: {}, pii: {}, types: {}, items: {} });
  }
  function item(y, k) { return y.items[k] || (y.items[k] = { miss: 0, slow: 0, est: 0 }); }

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i], ts = rowTime_(row[LOG_COL_.TS]);
    var fy = ts ? fyOf(ts) : 0;
    if (!fy) continue;
    var y = yr(fy), mail = String(row[LOG_COL_.MAIL] || '').trim().toLowerCase();
    y.trials++;
    if (mail) y.kids[mail] = true;
    if (mail.indexOf('@') >= 0) y.pii[mail] = true;   // 消去前の児童（メールが残っている）

    String(row[LOG_COL_.TSTAT] || '').split(',').forEach(function (e) {
      var p = String(e).split(':');
      if (p.length < 6 || !typeSet[p[0]]) return;
      var a = y.types[p[0]] || (y.types[p[0]] = { n: 0, miss: 0, ntk: 0, ln: 0 });
      a.n += Number(p[1]) || 0;                        // 1回目で正答した問題の数
      var x = typeStat_(e);
      if (x && x.ntk > 0 && x.ln) { a.ntk += x.ntk; a.ln += x.ln; }
    });
    splitCellItems_(row[LOG_COL_.MISS], typeSet).forEach(function (e) {
      var c = e.indexOf(':'), t = e.slice(0, c);
      if (c < 0 || !typeSet[t]) return;
      var a = y.types[t] || (y.types[t] = { n: 0, miss: 0, ntk: 0, ln: 0 });
      a.miss++;
      item(y, t + '|' + e.slice(c + 1)).miss++;
    });
    splitCellItems_(row[LOG_COL_.SLOW], typeSet).forEach(function (e) {
      // "型:タグ:ms"。タグに ':' は入らない（契約）が、念のため最後の ':' で切る
      var c = e.indexOf(':'), l = e.lastIndexOf(':');
      if (c < 0 || l <= c) return;
      item(y, e.slice(0, c) + '|' + e.slice(c + 1, l)).slow++;
    });
    var f = freq[String(row[LOG_COL_.MODE])] || freq[Number(row[LOG_COL_.MODE])];
    var att = Number(row[LOG_COL_.ATTEMPTS]) || 0;
    if (f && att) Object.keys(f).forEach(function (k) { item(y, k).est += att * f[k]; });
  }

  return Object.keys(Y).map(Number).sort(function (a, b) { return b - a; }).map(function (fy) {
    var y = Y[fy], types = {}, items = [];
    order.forEach(function (t) {
      var a = y.types[t];
      if (!a) return;
      var tot = a.n + a.miss;
      types[t] = { n: tot, miss: a.miss,
                   rate: tot ? Math.round(1000 * a.miss / tot) / 10 : null,       // 誤答率（%）
                   ms: a.ntk ? Math.round(Math.exp(a.ln / a.ntk)) : null };       // 初打鍵までの幾何平均
    });
    Object.keys(y.items).forEach(function (k) {
      var o = y.items[k];
      if (!o.miss && !o.slow) return;
      var p = k.indexOf('|');
      var est = Math.round(o.est);
      items.push({ t: k.slice(0, p), tag: k.slice(p + 1), miss: o.miss, slow: o.slow, est: est,
                   rate: est >= PAST_ITEM_MIN_ ? Math.round(1000 * Math.min(o.miss, est) / est) / 10 : null });
    });
    function topBy(key) {
      return items.filter(function (o) { return key === 'rate' ? (o.rate != null && o.miss > 0) : o.slow > 0; })
        .sort(function (a, z) { return (z[key] - a[key]) || (z.miss - a.miss); }).slice(0, PAST_ITEM_TOP_);
    }
    return { fy: fy, trials: y.trials, kids: Object.keys(y.kids).length, pii: Object.keys(y.pii).length,
             types: types, missTop: topBy('rate'), slowTop: topBy('slow') };
  });
}

function getPastYears(fresh) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var key = 'past_' + today_();
  if (!fresh) {
    var hit = cache_().get(key);
    if (hit) return JSON.parse(hit);
  }
  var v = sh_(SHEETS.LOG).getDataRange().getValues();
  var order = typeOrder_(), cur = curSchoolYear_(), freq = tagFreq_();
  // 「過年度すべて」は今年度より前の行を1つの年度（番号 1）として畳み直す。年度ごとの上位表を足し合わせると、
  // 上位に入らなかった年度の分が抜けて誤答率がゆがむため
  var all = pastStats_(v, function (ts) { var f = fyOfTime_(ts); return (f && f < cur) ? 1 : 0; }, freq, order);
  var out = { cur: cur, order: order, types: UNIT.types, itemMin: PAST_ITEM_MIN_,
              years: pastStats_(v, fyOfTime_, freq, order), allPast: all[0] || null,
              rosters: ss_().getSheets().map(function (s) { return s.getName(); })
                .filter(function (n) { return /^roster_\d{4}$/.test(n); }) };
  var j = JSON.stringify(out);
  if (j.length < 90000) cache_().put(key, j, 600);
  return out;
}

/* ============================================================
 *  「遅い」の判定
 *
 *  根拠と選択の理由は docs/ARCHITECTURE.md「遅いの判定」。要点だけ:
 *  - 想起時間は遅い側に長く裾を引く（反応時間の一般的な性質）。対数に直してから扱う
 *    （Ratcliff 1993）。児童の代表値は対数の平均＝幾何平均
 *  - 学年の分布の中心と広がりは、平均・SD ではなく 中央値・MAD（×1.4826）で取る。
 *    平均・SD は数人の極端な値に引っぱられる（Leys et al. 2013）
 *  - 比べるのは同じ学年・同じ型だけ。型をまたぐと打鍵数・手順の数の差が混ざる
 * ============================================================ */

/** MAD を正規分布の標準偏差と同じ目盛りにそろえる係数（Leys et al. 2013） */
var MAD_K_ = 1.4826;
/** 比べる児童がこれより少ない学年・型は判定しない（中央値・MADが数人で決まってしまう）。根拠なしの保守的な値 */
var SLOW_MIN_KIDS_ = 10;
/** 児童の代表値を分布に入れる・色を付けるのに要る、その型の初打鍵の回数。根拠なし（ゆらぎの判定と同じ5にそろえた） */
var SLOW_MIN_TRIES_ = 5;
/** slow_items（1回の中で飛びぬけて遅い問題）のしきい値。Leys et al. 2013 の既定 2.5 */
var SLOW_ITEM_Z_ = 2.5;
/** 本人の中で苦手な型：本人の偏差値の中央値より、この値以上低い型（かつ誤差の2倍を超える） */
var SELF_GAP_DV_ = 10;

function median_(xs) {
  var a = xs.slice().sort(function (p, q) { return p - q; }), n = a.length;
  if (!n) return 0;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** 頑健な中心と広がり。xs は対数時間。{ n, med, s }（s は MAD×1.4826＝SD相当） */
function robustNorm_(xs) {
  var med = median_(xs);
  var mad = median_(xs.map(function (x) { return Math.abs(x - med); }));
  return { n: xs.length, med: med, s: mad * MAD_K_ };
}

/** 児童ごとの代表値（ms）の列 → 学年・型の分布（対数で中央値・MAD） */
function slowNorm_(msList) {
  return robustNorm_(msList.filter(function (x) { return x > 0; }).map(Math.log));
}

/** 分布の中での位置（頑健なz。＋が遅い）。判定できなければ null */
function slowZ_(ms, nm) {
  if (!(ms > 0) || !nm || nm.n < SLOW_MIN_KIDS_ || !(nm.s > 0)) return null;
  return (Math.log(ms) - nm.med) / nm.s;
}

/**
 * 段階：-1 判定なし／0 中央値以下／1 〜＋1σ／2 ＋1σ超（遅い）／3 ＋2σ超
 * σ は MAD×1.4826（正規分布なら SD と一致する）。
 */
function slowBand_(ms, nm) {
  var z = slowZ_(ms, nm);
  if (z === null) return -1;
  return z <= 0 ? 0 : z <= 1 ? 1 : z <= 2 ? 2 : 3;
}

/**
 * 学年×型ごとの分布。kids は [{ grade, t: { 型: { n, ms } } }]（ms は児童の幾何平均）。
 * 回数が SLOW_MIN_TRIES_ 未満の児童は分布に入れない（代表値が不安定）。
 * 返り値 { 学年: { 型: { n, med, s } } }
 */
function gradeNorms_(kids) {
  var xs = {};
  kids.forEach(function (k) {
    Object.keys(k.t || {}).forEach(function (ty) {
      var o = k.t[ty];
      if (!o || o.n < SLOW_MIN_TRIES_ || !(o.ms > 0)) return;
      var g = xs[k.grade] || (xs[k.grade] = {});
      (g[ty] || (g[ty] = [])).push(o.ms);
    });
  });
  var out = {};
  Object.keys(xs).forEach(function (g) {
    out[g] = {};
    Object.keys(xs[g]).forEach(function (ty) { out[g][ty] = slowNorm_(xs[g][ty]); });
  });
  return out;
}

/* ============================================================
 *  抜け一覧（教師画面の分析タブの先頭）
 *
 *  判断は「どの児童の、どこに理解の抜けがあるか」。集団の図表ではなく、児童ごとに
 *  最大 GAP_MAX_ 件の「抜け」を言葉で出す。基準は本人の中での比較（学年との比較だと、
 *  全体に低い子は全部の型が該当して、一覧から何も読めない）。
 *
 *  抜けの種類（強い順）
 *    wrong … 同じ誤概念の誤答を GAP_WRONG_MIN_ 回以上（UNIT.wrongLabel のある単元だけ）
 *    miss  … 本人の誤答率の中央値より GAP_RATE_ 以上高く、その差が誤答率の標準誤差の2倍を超える型
 *    slow  … ◆（本人の他の型より遅い。markSelfSlow_）
 *  状態
 *    few  … 判定できる型（GAP_MIN_N_ 問以上）が無い
 *    flat … 本人の誤答率の中央値が GAP_FLAT_ 以上（どの型も誤答が多く、型の差では読めない）
 *    ok   … それ以外（抜けが0件なら「目立つ抜けなし」）
 * ============================================================ */
var GAP_MIN_N_ = 10;     // 型ごとの問題数（1回目正答＋誤答）の下限。10問で誤答率の標準誤差は最大±0.16。根拠なし（仮の値）
var GAP_RATE_ = 0.2;     // 本人の中央値からの差。根拠なし（仮の値）
var GAP_FLAT_ = 0.3;     // 中央値の誤答率がこれ以上なら「全体に誤答が多い」。根拠なし（仮の値）
var GAP_WRONG_MIN_ = 2;  // 同じ誤概念を選んだ回数。1回は押し間違いと区別できない
var GAP_MAX_ = 3;

/**
 * 純粋。tok/tm: { 型: 1回目正答数／誤答数 }、wl: { '型|誤概念': 回数 }、t: 児童の型ごとの想起（self 付き）。
 * 返り値 { st: 'ok'|'few'|'flat', items: [{ t, k: 'wrong'|'miss'|'slow', txt, n, rate }] }
 */
function gapsOf_(tok, tm, wl, t, order) {
  tok = tok || {}; tm = tm || {}; wl = wl || {}; t = t || {};
  var rates = {}, elig = [];
  order.forEach(function (ty) {
    var m = tm[ty] || 0, N = (tok[ty] || 0) + m;
    if (N >= GAP_MIN_N_) { rates[ty] = { r: m / N, N: N, m: m }; elig.push(ty); }
  });
  var items = [];
  Object.keys(wl).forEach(function (k) {
    if (wl[k] < GAP_WRONG_MIN_) return;
    var i = k.indexOf('|');
    items.push({ t: k.slice(0, i), k: 'wrong', txt: k.slice(i + 1), n: wl[k], s: 100 + wl[k] });
  });
  var center = elig.length ? median_(elig.map(function (ty) { return rates[ty].r; })) : 0;
  elig.forEach(function (ty) {
    var o = rates[ty], gap = o.r - center, se = Math.sqrt(Math.max(o.r * (1 - o.r), 0.01) / o.N);
    if (elig.length >= 2 && gap >= GAP_RATE_ && gap > 2 * se) {
      items.push({ t: ty, k: 'miss', txt: '', n: o.m, rate: Math.round(o.r * 100), s: 50 + gap * 10 });
    }
  });
  order.forEach(function (ty) {
    if (t[ty] && t[ty].self) items.push({ t: ty, k: 'slow', txt: '', n: t[ty].n, s: 10 });
  });
  items.sort(function (a, z) { return z.s - a.s; });
  items = items.slice(0, GAP_MAX_).map(function (x) { delete x.s; return x; });
  var stt = !elig.length && !items.length ? 'few' : (elig.length && center >= GAP_FLAT_ ? 'flat' : 'ok');
  return { st: stt, items: items, med: Math.round(center * 100) };
}

/**
 * 本人の中で遅い型（◆）。学年との比較だけだと、全体に遅い子は行全体が「遅い」になり、
 * その子がとくに苦手な型が読めない。
 *
 * 個人内の差（得意・不得意の型）は、差をとる2つの値の誤差が両方乗るので、
 * 見かけの凸凹が出やすい（下位検査のプロフィール分析への批判：McDermott et al. 1990 ほか）。
 * そのため次の3つを満たす型だけに付ける。
 *   1. 偏差値（dv）のある型が3つ以上（中心を決められる）
 *   2. 本人の dv の中央値より SELF_GAP_DV_ 以上低い
 *   3. その差が、その型の dv の標準誤差（se）の2倍を超える（回数が少なく揺れているだけの型を除く）
 */
function markSelfSlow_(t) {
  var tys = Object.keys(t).filter(function (ty) { return t[ty].dv != null; });
  if (tys.length < 3) return;
  var center = median_(tys.map(function (ty) { return t[ty].dv; }));
  tys.forEach(function (ty) {
    var gap = center - t[ty].dv;
    if (gap >= SELF_GAP_DV_ && gap > 2 * (t[ty].se || 0)) t[ty].self = true;
  });
}

/**
 * log の type_stats の1要素を読む。
 * "型:試行数:Σ送信まで:初打鍵あり数:Σ初打鍵まで:Σ(初打鍵まで)^2[:Σln:Σln^2]"
 * 対数の和が無い古い行は、平均の対数で代用する（その行の中のばらつきは0として扱う）。
 * 初打鍵の無いさらに古い行は null。
 */
function typeStat_(e) {
  var p = String(e).split(':');
  if (p.length < 6 || !p[0]) return null;
  var o = { t: p[0], ntk: Number(p[3]) || 0, tk: Number(p[4]) || 0, tk2: Number(p[5]) || 0, ln: 0, ln2: 0 };
  if (p.length >= 8) { o.ln = Number(p[6]) || 0; o.ln2 = Number(p[7]) || 0; }
  else if (o.ntk > 0 && o.tk > 0) { var l = Math.log(o.tk / o.ntk); o.ln = o.ntk * l; o.ln2 = o.ntk * l * l; }
  return o;
}

/**
 * 型ごとの想起時間の畳み込み。{ ntk, tk, tk2, ln, ln2 } → { n, ms, cv, sl }
 * ms は代表値＝幾何平均（初打鍵まで）。cv は標準偏差÷平均（%、ゆらぎ）。sl は対数時間の標準偏差。
 */
function recallOut_(acc, miss) {
  if (!acc || !acc.ntk) return { n: 0, ms: 0, cv: 0, sl: 0, miss: miss || 0 };
  var mean = acc.tk / acc.ntk;
  var vr = acc.tk2 / acc.ntk - mean * mean;
  var cv = mean > 0 ? Math.round((vr > 0 ? Math.sqrt(vr) : 0) / mean * 100) : 0;
  var lm = acc.ln / acc.ntk, lv = acc.ln2 / acc.ntk - lm * lm;
  return { n: acc.ntk, ms: Math.round(Math.exp(lm)), cv: cv,
           sl: Math.round((lv > 0 ? Math.sqrt(lv) : 0) * 1000) / 1000, miss: miss || 0 };
}

/**
 * fyear: 参照したい年度の開始年（2025年度なら2025）。0/未指定で今年度。
 * 今年度は「window_days 日前」と年度始まり（4/1）の遅い方を窓の下端にする。
 * 過去年度はその年度の4/1〜翌3/31の全体を参考用に集計する。
 */
function newAcc_() { return { ntk: 0, tk: 0, tk2: 0, ln: 0, ln2: 0, miss: 0 }; }
function addAcc_(a, x) { a.ntk += x.ntk; a.tk += x.tk; a.tk2 += x.tk2; a.ln += x.ln; a.ln2 += x.ln2; }

function buildAnalysis_(fyear) {
  var cfg = config_();
  var days = Number(cfg.window_days) || 0;

  var curFy = curSchoolYear_();
  var viewFy = (fyear > 0 && fyear < curFy) ? fyear : curFy;
  var now = new Date();

  var cutoff, until = 0, span;
  if (viewFy === curFy) {
    // 今年度: 年度の切り替わりでリセット。進級・編入で所属が変わった児童の
    // 過去分が新クラスに混ざるのを防ぐ（log の行は履歴として残る）
    var win = days > 0 ? (now.getTime() - days * 86400000) : 0;
    var fyStart = fyStartMs_(curFy);
    cutoff = Math.max(win, fyStart);
    span = win > fyStart ? ('直近' + days + '日') : '4/1以降';
  } else {
    cutoff = fyStartMs_(viewFy);
    until = fyStartMs_(viewFy + 1);
    span = viewFy + '年度';
  }

  var order = typeOrder_();
  var typeSet = {};
  order.forEach(function (t) { typeSet[t] = true; });
  var wobble = Number(cfg.wobble_pct) || 40;

  // 名簿。記録・分析の対象は email と氏名の両方がある児童だけ。
  // 表示年度の名簿を読む（過去年度は roster_<年度>。無ければ空で、
  // log 行が持つ「記録時点の学年・組・氏名」からその年度の名簿を組み立てる——
  // 進級した児童が旧年度で新しいクラスに混ざるのを防ぐ）
  var roster = {}, classes = {}, hasYearRoster = false;
  rosterRows_(viewFy).forEach(function (rr) {
    if (!rr.name) return;
    hasYearRoster = true;
    var ck = rr.grade + '-' + rr.cls;
    roster[rr.mail] = { ck: ck, no: rr.no, name: rr.name };
    if (!classes[ck]) classes[ck] = { cls: ck, label: rr.grade + '年' + rr.cls + '組', grade: rr.grade, room: rr.cls, n: 0, trials: 0 };
    classes[ck].n++;
  });

  // ck -> { trials, types: {t: {ntk,tk,tk2,miss}}, daily: {date: n}, wrong: {entry: n}, kids: {mail: stu} }
  var perCls = {};
  function bag(ck) {
    var b = perCls[ck];
    if (!b) b = perCls[ck] = { trials: 0, types: {}, daily: {}, wrong: {}, kids: {} };
    return b;
  }

  var v = sh_(SHEETS.LOG).getDataRange().getValues();
  var minTs = 0;   // 年度選択肢を出すための最古の記録時刻
  for (var i2 = 1; i2 < v.length; i2++) {
    var row = v[i2], m = String(row[LOG_COL_.MAIL]).toLowerCase();
    var ts = rowTime_(row[LOG_COL_.TS]);
    if (!ts) continue;
    // 年度選択肢のために最古の記録を追う。記録が残っていれば、卒業した児童の
    // 分（現行名簿に無い）も年度リストに出せる。氏名の無い行は対象外
    if (String(row[LOG_COL_.NAME] || '').trim() && (!minTs || ts < minTs)) minTs = ts;
    if (ts < cutoff || (until && ts >= until)) continue;

    var rc = roster[m];
    if (!rc && !hasYearRoster && String(row[LOG_COL_.NAME] || '').trim()) {
      // 年度名簿が無い過去年度: log 行の所属（その時点の学年・組）を名簿にする
      var g = Number(row[LOG_COL_.GRADE]), rm = String(row[LOG_COL_.CLS]).trim();
      var ck = g + '-' + rm;
      rc = roster[m] = { ck: ck, no: Number(row[LOG_COL_.NO]), name: String(row[LOG_COL_.NAME]).trim() };
      if (!classes[ck]) classes[ck] = { cls: ck, label: g + '年' + rm + '組', grade: g, room: rm, n: 0, trials: 0 };
      classes[ck].n++;
    }
    if (!rc) continue;

    var b = bag(rc.ck);
    b.trials++;
    if (classes[rc.ck]) classes[rc.ck].trials++;
    var d = dstr_(row[LOG_COL_.TS]);
    b.daily[d] = (b.daily[d] || 0) + 1;

    var st = b.kids[m];
    if (!st) st = b.kids[m] = { name: rc.name, no: rc.no, tries: 0, miss: 0, t: {}, tok: {}, tm: {}, wl: {} };
    st.tries++;

    // type_stats … "型:試行数:Σ送信まで:初打鍵あり数:Σ初打鍵まで:Σ(初打鍵まで)^2"
    String(row[LOG_COL_.TSTAT] || '').split(',').forEach(function (e) {
      var p0 = String(e).split(':');
      if (typeSet[p0[0]] && p0.length >= 2) st.tok[p0[0]] = (st.tok[p0[0]] || 0) + (Number(p0[1]) || 0);   // 1回目で正答した数（抜け一覧の分母）
      var x = typeStat_(e);
      if (!x) return;                          // 初打鍵の無い古い行は想起の集計に入れない
      var ty = x.t;
      var acc = b.types[ty] || (b.types[ty] = newAcc_());
      var sa = st.t[ty] || (st.t[ty] = newAcc_());
      addAcc_(acc, x); addAcc_(sa, x);
    });

    splitCellItems_(row[LOG_COL_.MISS], typeSet).forEach(function (e) {
      var ty = e.split(':')[0];
      if (!ty) return;
      var acc = b.types[ty] || (b.types[ty] = newAcc_());
      acc.miss++;
      st.miss++;
      st.tm[ty] = (st.tm[ty] || 0) + 1;
    });

    splitCellItems_(row[LOG_COL_.WRONG], typeSet).forEach(function (e) {
      if (e.indexOf('|') < 0) return;
      b.wrong[e] = (b.wrong[e] || 0) + 1;
      // 誤答の値から誤概念を読める単元（UNIT.wrongLabel）は、児童ごとに数える（抜け一覧）
      var wp = e.split('|');
      if (typeof UNIT.wrongLabel === 'function' && wp.length >= 4) {
        var lb = UNIT.wrongLabel(wp[0], wp[1], wp[2], wp[3]);
        if (lb) { var lk = wp[0] + '|' + lb; st.wl[lk] = (st.wl[lk] || 0) + 1; }
      }
    });
  }

  // 「全体」= 全クラスの合算。クラス別と同じ形にして画面側の分岐を減らす
  var all = { trials: 0, types: {}, daily: {}, wrong: {} };
  Object.keys(perCls).forEach(function (ck) {
    var b = perCls[ck];
    all.trials += b.trials;
    Object.keys(b.types).forEach(function (ty) {
      var a = all.types[ty] || (all.types[ty] = newAcc_());
      var x = b.types[ty];
      addAcc_(a, x); a.miss += x.miss;
    });
    Object.keys(b.daily).forEach(function (dd) { all.daily[dd] = (all.daily[dd] || 0) + b.daily[dd]; });
    Object.keys(b.wrong).forEach(function (k) { all.wrong[k] = (all.wrong[k] || 0) + b.wrong[k]; });
  });

  function scopeOut(b) {
    var types = {}, wrongTop = [];
    order.forEach(function (ty) { types[ty] = recallOut_(b.types[ty], b.types[ty] ? b.types[ty].miss : 0); });
    Object.keys(b.wrong).forEach(function (k) {
      var p = k.split('|'), ty = p[0];
      wrongTop.push({
        t: ty, tag: p[1] || '',
        ok: p.length >= 4 ? fmtByType_(ty, p[2]) : '',
        ng: fmtByType_(ty, p.length >= 4 ? p[3] : p[2]),   // 旧形式（正答なし）は3分割
        n: b.wrong[k]
      });
    });
    wrongTop.sort(function (a, z) { return z.n - a.n; });
    var daily = Object.keys(b.daily).sort().map(function (dd) { return [dd, b.daily[dd]]; });
    return { trials: b.trials, types: types, wrongTop: wrongTop.slice(0, 12), daily: daily };
  }

  var scopes = { all: scopeOut(all) };
  Object.keys(perCls).forEach(function (ck) { scopes[ck] = scopeOut(perCls[ck]); });

  // 児童別。名簿の児童は記録がなくても行を出す（「まだやっていない」が見えるように）。
  // 期間内の記録が1件も無いクラスも同じ形で出す（未実施児童が全員 '–' の表になる）。
  var students = {};
  Object.keys(classes).forEach(function (ck) {
    var bk = (perCls[ck] || { kids: {} }).kids, kids = [];
    Object.keys(roster).forEach(function (m) {
      if (roster[m].ck !== ck) return;
      var st = bk[m] || { name: roster[m].name, no: roster[m].no, tries: 0, miss: 0, t: {}, tok: {}, tm: {}, wl: {} };
      var wMax = 0, wType = '', t = {};
      order.forEach(function (ty) {
        var o = recallOut_(st.t[ty]);
        if (!o.n) return;
        t[ty] = { n: o.n, ms: o.ms, cv: o.cv, sl: o.sl };
        // 試行が少ないとばらつきが不安定なので、weak_child と同じく5回以上の型だけ候補にする
        if (o.n >= 5 && o.cv > wMax) { wMax = o.cv; wType = ty; }
      });
      kids.push({ no: st.no, name: st.name, tries: st.tries, miss: st.miss,
                  wobble: wMax, wobbleType: wType ? (UNIT.types[wType] || wType) : '', t: t,
                  _tok: st.tok, _tm: st.tm, _wl: st.wl });
    });
    kids.sort(function (a, z) { return a.no - z.no; });
    students[ck] = kids;
  });

  // 「遅い」の段階（b）。同じ学年・同じ型の児童の分布と比べる（秒の固定閾値は使わない）
  var flat = [];
  Object.keys(students).forEach(function (ck) {
    students[ck].forEach(function (k) { flat.push({ grade: classes[ck].grade, t: k.t }); });
  });
  var norms = gradeNorms_(flat);
  Object.keys(students).forEach(function (ck) {
    var nm = norms[classes[ck].grade] || {};
    students[ck].forEach(function (k) {
      Object.keys(k.t).forEach(function (ty) {
        var o = k.t[ty];
        o.b = o.n >= SLOW_MIN_TRIES_ ? slowBand_(o.ms, nm[ty]) : -1;
        // 偏差値。速いほど高い（50−10×頑健z）。se は偏差値の標準誤差（その子の対数時間のばらつき÷√回数）
        if (o.b >= 0) {
          o.dv = Math.round(50 - 10 * slowZ_(o.ms, nm[ty]));
          o.se = Math.round(10 * (o.sl / Math.sqrt(o.n)) / nm[ty].s * 10) / 10;
        }
      });
      markSelfSlow_(k.t);
      k.gap = gapsOf_(k._tok, k._tm, k._wl, k.t, order);
      delete k._tok; delete k._tm; delete k._wl;
    });
  });
  // クラス・全体の型平均も同じ分布に当てる。全体は学年が1つのときだけ（学年をまたぐ分布は無い）
  var grades = {};
  Object.keys(classes).forEach(function (ck) { grades[classes[ck].grade] = true; });
  Object.keys(scopes).forEach(function (sk) {
    var g = sk === 'all' ? (Object.keys(grades).length === 1 ? Object.keys(grades)[0] : null)
                         : (classes[sk] ? classes[sk].grade : null);
    var nm = g != null ? (norms[g] || {}) : {};
    Object.keys(scopes[sk].types).forEach(function (ty) {
      var o = scopes[sk].types[ty];
      o.b = o.n ? slowBand_(o.ms, nm[ty]) : -1;
    });
  });

  var clsList = Object.keys(classes).map(function (k) { return classes[k]; })
    .sort(function (a, b) {
      return a.grade - b.grade ||
        (a.room < b.room ? -1 : a.room > b.room ? 1 : 0);
    });

  // 年度選択肢: 最古の記録が属する年度から今年度まで（記録がなければ今年度のみ）
  var years = [curFy];
  if (minTs) {
    var firstFy = fyOfTime_(minTs);
    for (var y = curFy - 1; y >= firstFy; y--) years.push(y);
  }

  return {
    span: span,
    fy: viewFy,
    years: years,
    days: days,
    at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d H:mm'),
    wobble: wobble, slowMinKids: SLOW_MIN_KIDS_, slowMinTries: SLOW_MIN_TRIES_,
    norms: norms, selfGap: SELF_GAP_DV_,
    order: order, types: UNIT.types,
    classes: clsList,
    scopes: scopes,
    students: students
  };
}

/* ============================================================
 *  用語モード（教師画面の「ようご」タブ）
 *
 *  毎時間の定例として教室モニターに映し、全員で声をそろえて読む。
 *  ① 図だけを映す → ② 押すと名前が出る、の2段階。
 *
 *  台帳 TERMS_ は全単元共通で、並びは学習の順（学年→単元の順）。
 *  単元は UNIT.terms で自分の用語を宣言する。台帳でその単元の最初の用語より前にある用語は既習とみなし、
 *  毎回 TERM_PAST_N_ 個まで、しばらく出していないものから混ぜる（間隔をあけた復習）。
 *  図は Core.gs の中で描く（単元のプロジェクトをまたいで既習の用語を描くため）。
 * ============================================================ */
var TERM_PAST_N_ = 2;       // 1回に混ぜる既習の用語の数。根拠なし（1〜2分に収める仮の値）
var TERM_FIGS_ = 4;         // 1語あたりに用意する図の向きの数（毎回向きを変え、典型図への固着を避ける）
var TERM_KEY_ = 'terms_seen';

var TM_LINE_ = '#8C93AC';
var TM_INK_ = '#FFFFFF';

function tmSvg_(body) {
  return '<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">' + body + '</svg>';
}
function tmAt_(cx, cy, r, th) { return [Math.round(cx + r * Math.cos(th)), Math.round(cy - r * Math.sin(th))]; }
function tmCircle_(r, stroke, w) {
  return '<circle cx="200" cy="150" r="' + r + '" fill="none" stroke="' + stroke + '" stroke-width="' + w + '"/>';
}
function tmDot_(p, c) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="9" fill="' + c + '"/>'; }
function tmSeg_(p, q, c) {
  return '<line x1="' + p[0] + '" y1="' + p[1] + '" x2="' + q[0] + '" y2="' + q[1] +
         '" stroke="' + c + '" stroke-width="9" stroke-linecap="round"/>';
}

/**
 * 用語の台帳（学習の順）。fig(rand, hi) は図の SVG。hi は名称が指すところの色（学年の色）。
 * 指すところだけを hi で塗り、ほかは輪郭の灰にする（何を言う図なのかを1つに絞る）。
 */
var TERMS_ = [
  { id: 'circle', grade: 3, unit: 'circle', name: '円', yomi: 'えん',
    fig: function (rand, hi) { return tmSvg_(tmCircle_(110, hi, 9)); } },
  { id: 'center', grade: 3, unit: 'circle', name: '中心', yomi: 'ちゅうしん',
    fig: function (rand, hi) { return tmSvg_(tmCircle_(110, TM_LINE_, 5) + tmDot_([200, 150], hi)); } },
  { id: 'radius', grade: 3, unit: 'circle', name: '半径', yomi: 'はんけい',
    fig: function (rand, hi) {
      var th = rand() * Math.PI * 2;
      return tmSvg_(tmCircle_(110, TM_LINE_, 5) + tmSeg_([200, 150], tmAt_(200, 150, 110, th), hi) + tmDot_([200, 150], TM_INK_));
    } },
  { id: 'diameter', grade: 3, unit: 'circle', name: '直径', yomi: 'ちょっけい',
    fig: function (rand, hi) {
      var th = rand() * Math.PI;
      return tmSvg_(tmCircle_(110, TM_LINE_, 5) + tmSeg_(tmAt_(200, 150, 110, th), tmAt_(200, 150, 110, th + Math.PI), hi) +
                    tmDot_([200, 150], TM_INK_));
    } },
  { id: 'sphere', grade: 3, unit: 'circle', name: '球', yomi: 'きゅう',
    fig: function (rand, hi) {
      var ry = 22 + Math.round(rand() * 14);
      return tmSvg_('<circle cx="200" cy="150" r="110" fill="' + hi + '" fill-opacity=".28" stroke="' + hi + '" stroke-width="7"/>' +
        '<ellipse cx="200" cy="150" rx="110" ry="' + ry + '" fill="none" stroke="' + TM_LINE_ + '" stroke-width="4" stroke-dasharray="10 8"/>' +
        '<ellipse cx="160" cy="105" rx="26" ry="16" fill="#FFFFFF" fill-opacity=".35"/>');
    } }
];

function termById_(id) {
  for (var i = 0; i < TERMS_.length; i++) if (TERMS_[i].id === id) return TERMS_[i];
  return null;
}

/**
 * 今日の用語の束（純粋。tests/terms.test.cjs が叩く）。
 * cur: この単元の用語 id、seen: { id: { n: 出した回数, at: 最後に出した時刻 } }。
 * 返り値 [{ id, name, yomi, cur, n, figs: [svg...] }]。この単元の用語が先、既習が後。
 */
function termDeck_(cur, seen, grade, rand) {
  cur = (cur || []).filter(function (id) { return !!termById_(id); });
  seen = seen || {};
  var hi = GRADE_ACCENT_[grade] || GRADE_ACCENT_[3];
  var first = TERMS_.length;
  cur.forEach(function (id) { first = Math.min(first, TERMS_.indexOf(termById_(id))); });
  if (!cur.length) {   // 用語を宣言していない単元：下の学年の用語だけを既習とする
    first = 0;
    while (first < TERMS_.length && TERMS_[first].grade < grade) first++;
  }
  var past = TERMS_.slice(0, first).filter(function (x) { return cur.indexOf(x.id) < 0 && x.grade <= grade; })
    .sort(function (a, z) { return ((seen[a.id] || {}).at || 0) - ((seen[z.id] || {}).at || 0); })
    .slice(0, TERM_PAST_N_);
  function out(x, isCur) {
    var figs = [];
    for (var i = 0; i < TERM_FIGS_; i++) figs.push(x.fig(rand, hi));
    var n = (seen[x.id] || {}).n || 0;
    return { id: x.id, name: x.name, yomi: x.yomi, cur: isCur, n: n, figs: figs };
  }
  return cur.map(function (id) { return out(termById_(id), true); })
    .concat(past.map(function (x) { return out(x, false); }));
}

function termSeen_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(TERM_KEY_) || '{}') || {}; }
  catch (e) { return {}; }
}

/** 教師画面：今日の用語の束 */
function getTermDeck() {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var seed = Math.floor(Math.random() * 1e9);
  return { deck: termDeck_(UNIT.terms || [], termSeen_(), UNIT.grade, rng_(seed)), declared: (UNIT.terms || []).length };
}

/** 教師画面：最後まで映し終えた用語を記録する（既習の用語の出す順に使う） */
function termDone(ids) {
  if (!isTeacher_(email_())) throw new Error('権限がありません');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false };
  try {
    var seen = termSeen_(), now = Date.now();
    (ids || []).forEach(function (id) {
      if (!termById_(String(id))) return;
      var o = seen[id] || (seen[id] = { n: 0, at: 0 });
      o.n++; o.at = now;
    });
    PropertiesService.getScriptProperties().setProperty(TERM_KEY_, JSON.stringify(seen));
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/* ============================================================
 *  Unit.gs の契約検査
 *
 *  新しい単元を増やしたとき、宣言の漏れや形のずれをここが拾う。
 *  setup() の末尾と、教師画面の読み込み（getConfigForUI）で呼ばれる。
 *  検査は宣言と gen の実働の両方を見る。宣言だけ合っていても、
 *  実際に gen が返す形がずれていれば画面は壊れるため。
 * ============================================================ */

/* ============================================================
 *  学年の色（全単元共通の配色の正本）
 *
 *  学年ごとに「進みの色」を1色持つ（タイマーの帯・せいかい数・いま打つ欄）。
 *  どの学年も背景 #101728 の黒で、まちがい・注意は共通の赤 #FF1A30 を使う。
 *  7色は check-palette.mjs で、背景・白文字・赤と見分けられることを実測して決めた。
 *
 *  単元がもう1色使いたいとき（units の単位色、slotColor）は、別の学年の色を使う。
 *  ただし自分の学年の色と色覚タイプによって同じに見える組があるので、
 *  使ってよい色は GRADE_EXTRA_ に限る（validateUnit_ が検査する）。
 * ============================================================ */
var GRADE_ACCENT_ = { 1: '#F1B1E4', 2: '#49B9DF', 3: '#35D0A5', 4: '#8A6CE5', 5: '#D4D454', 6: '#E4B195' };
var ALERT_COLOR_ = '#FF1A30';
/**
 * 学年ごとに、もう1色として使ってよい別学年の色。
 * 自分の学年の色と、一般・1型・2型・3型のどれでも色差18以上、
 * または明るさの比1.25以上（その場合は文字や形が別であること）の組だけを残した。
 * 例：3年はからし（1型で色差16）・そら（3型で4）・あんず（1型で4）が落ちる。
 */
var GRADE_EXTRA_ = {
  1: ['#49B9DF', '#35D0A5', '#8A6CE5'],
  2: ['#F1B1E4', '#8A6CE5', '#D4D454', '#E4B195'],
  3: ['#F1B1E4', '#8A6CE5'],
  4: ['#F1B1E4', '#49B9DF', '#35D0A5', '#D4D454', '#E4B195'],
  5: ['#49B9DF', '#8A6CE5'],
  6: ['#49B9DF', '#8A6CE5']
};
function gradeAccent_() { return UNIT.category === 'special' && UNIT.grade === null ? '#85ADFF' : (GRADE_ACCENT_[UNIT.grade] || GRADE_ACCENT_[3]); }

/**
 * 「？」（問われている位置を示す印）の色。
 * 赤はまちがい・注意に予約するので使わない。進みの色と混ざらないよう
 * GRADE_EXTRA_ の先頭から取る（各学年とも進みの色・赤・背景と見分けられる組だけを残してある）。
 */
function questionColor_() {
  var ex = GRADE_EXTRA_[UNIT.grade] || [];
  return ex[0] || '#FFFFFF';
}

/**
 * 背景の床（成長する図形）の第二の色。第一の色は学年の色。
 * 第二の色はサイト（単元）ごとに変え、どのサイトの床かが色で分かるようにする。
 * 単元が UNIT.floorColor で FLOOR_GEMS_ の中から1色を宣言する（validateUnit_ が検査する）。
 * 割り当ての台帳は design リポジトリの growing-figures/COLORS.md が正本。
 *
 * 床の色は薄く塗る背景で、意味を伝える色（進み・まちがい・？の印）ではない。
 * そのため GRADE_EXTRA_（見分けの検査を通した組）には縛らず、宝石の名の8色から選ぶ。
 * 学年の色と同じ色だけは禁止（2つの層が見分けられなくなる）。
 */
/** 床の図形として選べる生成器（common/index.html に写した generators.js の id） */
var FLOOR_PATTERNS_ = ['penrose','octagon','heptagon','dodecagon','sunflower','whirl','flower','mandala','decagon','petals','tape','clockstar','pascal','chair','fibgrid','farey','padovan','decimal','scaleswirl','scalefib','circlesphere','carry','borrow','factor720','kake1','kake2'];

var FLOOR_GEMS_ = {
  amethyst:   '#8A6CE5',   // すみれ
  sapphire:   '#3D6FD6',   // 青
  topaz:      '#E0A43A',   // こはく
  peridot:    '#8DC63F',   // 若葉
  aquamarine: '#49B9DF',   // 空
  rose:       '#E27DB0',   // 桃
  garnet:     '#B5476B',   // えんじ
  citrine:    '#D4C04A'    // からし
};
function floorColor_() {
  var c = String(UNIT.floorColor || '');
  if (FLOOR_GEMS_[c]) return FLOOR_GEMS_[c];
  var ex = GRADE_EXTRA_[UNIT.grade] || [];
  return ex[1] || ex[0] || FLOOR_GEMS_.amethyst;
}

/**
 * UNIT が共通エンジンの契約に合っているかを調べる。
 * 問題点の文字列の配列を返す（空なら合格）。
 * エディタからは checkUnit() で手動確認できる。
 */
function validateUnit_() {
  var probs = [];
  if (typeof UNIT !== 'object' || !UNIT) {
    return ['UNIT が定義されていません（Unit.gs が読み込まれていない）'];
  }
  if (!UNIT.id) probs.push('UNIT.id がありません');
  if (!UNIT.title) probs.push('UNIT.title がありません');
  if (!UNIT.teacherTitle) probs.push('UNIT.teacherTitle がありません');
  // 学年はプレビューのメニューとリポジトリの置き場（apps/grade<学年>/）の分類に使う
  if (!(UNIT.category === 'special' && UNIT.grade === null) && !(UNIT.grade >= 1 && UNIT.grade <= 6 && UNIT.grade % 1 === 0)) probs.push('UNIT.grade（1〜6、または category:special と grade:null）がありません');
  if (UNIT.answerOrder && UNIT.answerOrder !== 'unordered') probs.push('answerOrder が不正です');
  // 単元が足す色（単位の色・目立たせる欄の色）は、別学年の色のうち GRADE_EXTRA_ にあるものだけ
  var extraOk = GRADE_EXTRA_[UNIT.grade] || [];
  function checkColor(where, c) {
    if (!c) return;
    if (extraOk.indexOf(String(c).toUpperCase()) < 0) {
      probs.push(where + ' の色 ' + c + ' は ' + UNIT.grade + '年で使えません（使える色: ' + extraOk.join(' ') + '）');
    }
  }
  Object.keys(UNIT.units || {}).forEach(function (k) { checkColor('units.' + k, UNIT.units[k]); });
  Object.keys(UNIT.slotColor || {}).forEach(function (k) { checkColor('slotColor.' + k, UNIT.slotColor[k]); });
  if (typeof UNIT.gen !== 'function') probs.push('UNIT.gen がありません');
  if (UNIT.terms != null) {
    if (!Array.isArray(UNIT.terms)) probs.push('UNIT.terms は用語 id の配列にしてください');
    else UNIT.terms.forEach(function (id) { if (!termById_(id)) probs.push('UNIT.terms の ' + id + ' が用語の台帳（TERMS_）にありません'); });
  }
  if (UNIT.wrongLabel != null && typeof UNIT.wrongLabel !== 'function') probs.push('UNIT.wrongLabel は関数にしてください');

  // モードの宣言
  var modeIds = [];
  if (!Array.isArray(UNIT.modes) || !UNIT.modes.length) {
    probs.push('UNIT.modes が空です');
  } else {
    var seenMode = {};
    UNIT.modes.forEach(function (m) {
      if (m.id == null || !m.name) {
        probs.push('モードの宣言に id または name がありません');
        return;
      }
      if (seenMode[m.id]) probs.push('モード id ' + m.id + ' が重複しています');
      seenMode[m.id] = true;
      modeIds.push(m.id);
    });
  }

  // 解放条件の参照先とループ
  (UNIT.modes || []).forEach(function (m) {
    if (!m.needs) return;
    if (!(m.needs.mode > 0)) { probs.push('モード ' + m.id + ' の needs.mode がありません'); return; }
    if (modeIds.indexOf(m.needs.mode) < 0) probs.push('モード ' + m.id + ' の needs.mode=' + m.needs.mode + ' は存在しません');
    if (!(m.needs.tries > 0)) probs.push('モード ' + m.id + ' の needs.tries がありません');
  });
  // 別記録版（pair）の参照先。相方は pair を持たない実在のモード
  (UNIT.modes || []).forEach(function (m) {
    if (!m.pair) return;
    var b = null;
    UNIT.modes.forEach(function (x) { if (x.id === m.pair) b = x; });
    if (!b) probs.push('モード ' + m.id + ' の pair=' + m.pair + ' は存在しません');
    else if (b.pair) probs.push('モード ' + m.id + ' の pair 先 ' + m.pair + ' も pair を持っています');
    if (m.needs) probs.push('モード ' + m.id + ' は pair を持つので needs は相方に書いてください');
  });
  // 段階解放の閾値は、pair を持たない実在のモードに書く
  Object.keys(UNIT.nUnlock || {}).forEach(function (k) {
    var b = null;
    (UNIT.modes || []).forEach(function (x) { if (String(x.id) === String(k)) b = x; });
    if (!b) probs.push('UNIT.nUnlock のモード ' + k + ' は modes にありません');
    else if (b.pair) probs.push('UNIT.nUnlock のモード ' + k + ' は pair を持つので、相方に書いてください');
    else if (!(Number(UNIT.nUnlock[k]) > 0)) probs.push('UNIT.nUnlock のモード ' + k + ' の値は正の数にしてください');
  });
  // ループ検出（AがB、BがA を必要とする形だと永遠に開かない）
  modeIds.forEach(function (id) {
    var cur = id, hops = 0;
    while (cur && hops < 10) {
      var m = null;
      UNIT.modes.forEach(function (x) { if (x.id === cur) m = x; });
      if (!m || !m.needs) break;
      cur = m.needs.mode; hops++;
      if (cur === id) { probs.push('モード ' + id + ' の解放条件がループしています'); break; }
    }
  });

  if (!UNIT.types || !Object.keys(UNIT.types).length) probs.push('UNIT.types が空です');
  if (!UNIT.digitCap) probs.push('注意：UNIT.digitCap がありません（自動確定の桁数が決められません）');

  if (UNIT.floorColor !== undefined) {
    if (!FLOOR_GEMS_[UNIT.floorColor]) probs.push('UNIT.floorColor は ' + Object.keys(FLOOR_GEMS_).join('/') + ' のどれかにしてください');
    else if (FLOOR_GEMS_[UNIT.floorColor].toUpperCase() === String(gradeAccent_()).toUpperCase()) probs.push('UNIT.floorColor が学年の色と同じです（床の2つの層が見分けられません）');
  }
  if (UNIT.floorPattern !== undefined && FLOOR_PATTERNS_.indexOf(UNIT.floorPattern) < 0) {
    probs.push('UNIT.floorPattern は ' + FLOOR_PATTERNS_.join('/') + ' のどれかにしてください');
  }
  if (UNIT.floorPrior !== undefined) {
    Object.keys(UNIT.floorPrior).forEach(function (m) {
      if (!(Number(UNIT.floorPrior[m]) > 0)) probs.push('UNIT.floorPrior のモード ' + m + ' は正の数（1分あたりの正答）にしてください');
    });
  }

  // 育ちの倍率の既定：単元のモードの id に、0.5〜3 の数
  if (UNIT.growWeights !== undefined) {
    var gmIds = modeIds_().map(String);
    Object.keys(UNIT.growWeights).forEach(function (m) {
      var w = Number(UNIT.growWeights[m]);
      if (gmIds.indexOf(String(m)) < 0) probs.push('UNIT.growWeights のモード ' + m + ' は modes にありません');
      else if (!(w >= GROW_W_MIN_ && w <= GROW_W_MAX_)) probs.push('UNIT.growWeights のモード ' + m + ' は ' + GROW_W_MIN_ + '〜' + GROW_W_MAX_ + ' の数にしてください');
    });
  }

  // 設定キーは defaults に宣言があること（無いと config_() が拾えず保存も効かない）
  (UNIT.settings || []).forEach(function (s) {
    if (!s.key) { probs.push('UNIT.settings に key の無い項目があります'); return; }
    if (BASE_DEFAULTS[s.key] !== undefined) probs.push('UNIT.settings のキー ' + s.key + ' は共通の設定名と重なっています');
    if ((UNIT.defaults || {})[s.key] === undefined) probs.push('UNIT.settings のキー ' + s.key + ' が UNIT.defaults にありません');
    if (s.type !== undefined && s.type !== 'text' && s.type !== 'number' && s.type !== 'onoff') probs.push('UNIT.settings のキー ' + s.key + ' の type は text/number/onoff のどれかにしてください');
    if (s.type === 'onoff' && [0, 1].indexOf(Number((UNIT.defaults || {})[s.key])) < 0) probs.push('UNIT.settings のキー ' + s.key + ' は onoff なので、既定値は 0 か 1 にしてください');
    if (s.type !== 'text' && s.type !== 'onoff' && (s.min == null || s.max == null)) probs.push('注意：UNIT.settings のキー ' + s.key + ' に min/max がありません');
  });

  // gen の実働検査。モードごとに固定シードで引いて、返す形を見る
  // 同じ指摘を60回分並べないよう、重複は1件にまとめる
  var seenTypes = {}, said = {};
  function say(msg) { if (!said[msg]) { said[msg] = true; probs.push(msg); } }
  function warn(msg) { say('注意：' + msg); }
  if (typeof UNIT.gen === 'function') {
    modeIds.forEach(function (mid) {
      var rand = rng_(20260903 + Number(mid));
      for (var i = 0; i < 60; i++) {
        var it;
        try { it = UNIT.gen(rand, Number(mid)); }
        catch (e) { say('gen(モード' + mid + ') が例外: ' + e.message); break; }
        if (!it || typeof it !== 'object') { say('gen(モード' + mid + ') が問題を返しませんでした'); break; }
        if (!it.t || !UNIT.types[it.t]) say('gen(モード' + mid + ') の型 ' + it.t + ' が UNIT.types にありません');
        else seenTypes[it.t] = true;
        if (typeof it.tag !== 'string' || !it.tag) say('gen(モード' + mid + ') の tag が文字列ではありません');
        // ',' は log の miss_items / wrong_items の区切り。含むと mistakes シートと誤り数の集計で1件が割れる
        else if (/[|\n",]/.test(it.tag)) say('gen(モード' + mid + ') の tag に | ・,・改行・" が含まれています: ' + it.tag);
        // q が空でも、まきじゃく・はかり・図で問う型は正しい
        if (!Array.isArray(it.q)) say('gen(モード' + mid + ') の q が配列ではありません');
        else if (!it.q.length && !it.ruler && !it.dial && !it.fig) say('gen(モード' + mid + ') の q が空です（図や道具での出題なら正しい）');
        else if (it.q.some(function (x) { return x === undefined || (typeof x === 'number' && isNaN(x)); })) say('gen(モード' + mid + ') の q に undefined/NaN があります');
        if (!Array.isArray(it.f) || !it.f.length) say('gen(モード' + mid + ') の f が空です');
        else {
          var seenF = {};
          it.f.forEach(function (f) {
            if (seenF[f]) say('gen(モード' + mid + ') の f に重複があります');
            seenF[f] = true;
            var a = it.ans ? it.ans[f] : undefined;
            if (a === undefined || a === null || isNaN(Number(a))) say('gen(モード' + mid + ') の ans[' + f + '] が数値ではありません');
            else {
              var dc = (UNIT.digitCap || {})[it.t] || (UNIT.digitCap || {})[mid];
              // 欄の宣言が無いと答えの桁数がそのまま確定タイミングになる（桁数がヒントとして漏れる）
              if (!dc) warn('digitCap に型 ' + it.t + '（またはモード ' + mid + '）の宣言がありません');
              else if (dc[f] === undefined) warn('digitCap の型 ' + it.t + ' に欄 ' + f + ' の宣言がありません（答えの桁数で確定されます）');
              else if (dc[f] < String(a).length) say('digitCap の ' + f + ' = ' + dc[f] + ' が答え ' + a + ' の桁数より小さいです（モード' + mid + '、型 ' + it.t + '）');
            }
            // byTotal の単位は scale の換算率が無いと合計が合わない
            if (UNIT.byTotal && UNIT.byTotal(it)) {
              var k = (UNIT.scale || {})[f];
              if (!k) say('UNIT.scale に欄 ' + f + ' の換算率がありません（byTotal の判定に必要）');
            }
          });
        }
        // 採点の合計判定は、児童側（index.html の isRight）が ruler/dial の有無、
        // サーバー側（match_）が UNIT.byTotal で切り替える。両者がずれると
        // 正しく答えた児童が「まちがい」になるので、一致をここで検査する
        var wantsTotal = UNIT.byTotal ? !!UNIT.byTotal(it) : false;
        if (wantsTotal !== !!(it.ruler || it.dial)) say('gen(モード' + mid + ') の型 ' + it.t + ': byTotal=' + wantsTotal + ' ですが ruler/dial 出題が ' + !!(it.ruler || it.dial) + ' です（児童側は ruler/dial で合計判定するため正答が誤採点になります）');
        if (it.rows !== undefined) {
          var us = String(it.rows).split('').filter(function (c) { return c === '_'; }).length;
          if (us !== (it.f || []).length) say('gen(モード' + mid + ') の rows の空欄数 ' + us + ' が f の数 ' + (it.f || []).length + ' と合いません');
        }
        if (it.veil !== undefined && it.veil !== null) {
          if (!(it.veil > 0) || it.veil > (it.f || []).length) say('gen(モード' + mid + ') の veil ' + it.veil + ' が f の範囲外です');
        }
        if (it.fig !== undefined && it.fig !== null) {
          var fs = String(it.fig);
          if (fs.indexOf('<svg') !== 0 || fs.slice(-6) !== '</svg>') say('gen(モード' + mid + ') の fig が <svg>...</svg> ではありません');
          if (fs.length > 4000) say('gen(モード' + mid + ') の fig が大きすぎます（' + fs.length + '字）');
          if (/NaN|undefined/.test(fs)) say('gen(モード' + mid + ') の fig に NaN/undefined が含まれています');
        }
      }
    });
    // 宣言した型が1つも出ないと、練習の選択肢に現れても実際には出ない
    Object.keys(UNIT.types || {}).forEach(function (t) {
      if (!seenTypes[t]) warn('型 ' + t + ' は全モードで出題されませんでした（宣言だけ残っている可能性）');
    });
    // 同じシードで同じ並びが出ること（児童が「同じ問題が出る」と迷わないため）
    var r1 = rng_(7), r2 = rng_(7);
    try {
      var tags1 = [], tags2 = [];
      for (var j = 0; j < 50; j++) { tags1.push(UNIT.gen(r1, Number(modeIds[0])).tag); }
      for (var k2 = 0; k2 < 50; k2++) { tags2.push(UNIT.gen(r2, Number(modeIds[0])).tag); }
      if (JSON.stringify(tags1) !== JSON.stringify(tags2)) probs.push('gen がシードに対して決定的ではありません');
    } catch (e2) { /* gen の例外は上で拾う */ }
  }
  return probs;
}

/** 検査結果をキャッシュする（教師画面の読み込みで毎回 gen 60回×モード数を回さないため） */
function unitCheck_() {
  var hit = cache_().get('unitcheck');
  if (hit) return JSON.parse(hit);
  var probs;
  try { probs = validateUnit_(); } catch (e) { probs = ['単元の検査中に失敗: ' + e.message]; }
  cache_().put('unitcheck', JSON.stringify(probs), TTL.roster);
  return probs;
}

/** エディタから手動で走らせる確認口。問題があれば文字列で列挙して返す */
function checkUnit() {
  var probs = validateUnit_();
  return probs.length ? ('Unit.gs の確認:\n- ' + probs.join('\n- ')) : 'Unit.gs: 問題ありません';
}

/* ============================================================
 *  自動セットアップ（手動実行は不要）
 * ============================================================ */

/**
 * 準備が要るのは設置直後と版を上げた直後だけ。通常はプロパティを1つ読んで終わる。
 *
 * 以前は「済んだ印」をスクリプトキャッシュに置いていた。キャッシュは消えるので、
 * 消えた直後に40人が同時に開くと、40の実行が同じシート操作を並行に走らせる。
 * ensureSheets_ は書き込みを含み、ensureSchema_ は30秒待つロックを取るので、
 * 実行は直列化したまま同時実行の枠（1ユーザーあたり30）を埋め、
 * その間に来た boot / startSession が実行できなくなる。
 * 「40人中1人だけ動いた」の主因はここ。
 *
 * 印は消えないプロパティに持ち、ロックは取れなければ待たずに諦める。
 * 準備は誰か1つの実行がやれば足りる。待つ側に回るくらいなら、
 * その実行はそのまま先へ進めたほうがよい（シートは既にあることがほとんど）。
 */
var READY_KEY = 'ready_schema';

function ensureReady_() {
  // 速い順に見る。キャッシュは消えるので判断の正本ではないが、
  // 消えていない間はプロパティの読み取り（毎回100ms前後かかることがある）を省ける
  if (cache_().get('ready') === String(SCHEMA_VERSION)) return;

  var props = props_();
  if (props.getProperty(READY_KEY) === String(SCHEMA_VERSION)) {
    cache_().put('ready', String(SCHEMA_VERSION), 3600);
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;              // 誰かが準備中。待たない
  try {
    if (props.getProperty(READY_KEY) === String(SCHEMA_VERSION)) return;
    ensureSheets_();
    ensureSchema_();
    ensureTriggers_();
    signKey_();                              // 署名の鍵はロックの中で1回だけ作る（同時に作ると鍵が割れる）
    props.setProperty(READY_KEY, String(SCHEMA_VERSION));
    cache_().put('ready', String(SCHEMA_VERSION), 3600);
  } catch (e) {
    console.error('ensureReady_ 失敗: ' + e.message);   // 印を立てない＝次回再挑戦
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/**
 * スキーマの自動移行。手動実行は不要。
 * 呼ぶのは ensureReady_ だけで、そこで排他ロックを取っている。
 */
function ensureSchema_() {
  var props = props_();
  if (Number(props.getProperty('schema_version')) >= SCHEMA_VERSION) return;
  migrateSummaryV2_();
  migrateModeNameAndWrong_();
  props.setProperty('schema_version', String(SCHEMA_VERSION));
}

/** v1 (kind / best_count なし) から v2 へ。既存データは本番・更新1回として扱う */
function migrateSummaryV2_() {
  var sh = ss_().getSheetByName(SHEETS.SUMMARY);
  if (!sh || sh.getLastRow() === 0) return;
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  if (head.indexOf('kind') >= 0) return;                 // 既に v2

  sh.insertColumnAfter(3);
  sh.getRange(1, 4).setValue('kind').setFontWeight('bold');
  var n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 4, n, 1).setValue('r');

  var last = sh.getLastColumn() + 1;
  sh.getRange(1, last).setValue('best_count').setFontWeight('bold');
  if (n > 0) sh.getRange(2, last, n, 1).setValue(1);      // 少なくとも1回は達成している
}

/**
 * log / summary / daily に「モード名」列を追加する。
 * 既存データの「モード名」は、その行の mode 番号から逆引きして埋める。
 * 各シートの見た目（タブ色・A1の注記）もここで整える。冪等。
 */
function migrateModeNameAndWrong_() {
  function insertModeName(sh, modeCol) {
    if (!sh || sh.getLastRow() === 0) return;
    var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    if (head.indexOf('モード名') >= 0) return;               // 済み
    sh.insertColumnAfter(modeCol);
    sh.getRange(1, modeCol + 1).setValue('モード名').setFontWeight('bold');
    var n = sh.getLastRow() - 1;
    if (n > 0) {
      var modes = sh.getRange(2, modeCol, n, 1).getValues();
      var names = modes.map(function (r) { return [modeName_(Number(r[0])) || '']; });
      sh.getRange(2, modeCol + 1, n, 1).setValues(names);
    }
  }

  insertModeName(ss_().getSheetByName(SHEETS.LOG), LOG_COL_.MODE + 1);   // mode 列（1始まり）の直後に入れる
  insertModeName(ss_().getSheetByName(SHEETS.SUMMARY), 2);
  insertModeName(ss_().getSheetByName(SHEETS.DAILY), 3);

  applyFriendlyStyling_();
}

/**
 * どのシートを見ればよいか一目で分かるよう、タブに色をつけ、
 * 直接編集しないほうがよいシートには A1 に注記を入れる。冪等。
 */
function applyFriendlyStyling_() {
  var ss = ss_();
  var technical = { config: '#B7B7B7', class_config: '#B7B7B7', roster: '#4A86E8',
                     log: '#B7B7B7', daily: '#B7B7B7',
                     coop: '#B7B7B7', coop_log: '#B7B7B7', coop_save: '#B7B7B7' };
  var friendly = { summary: '#93C47D', weak_child: '#93C47D', weak_class: '#93C47D' };

  Object.keys(technical).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) sh.setTabColor(technical[name]);
  });
  Object.keys(friendly).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) sh.setTabColor(friendly[name]);
  });

  var notes = {
    roster: 'ここに児童を登録します（email／学年／組／番号／氏名）。\n学年・組の表記はそろえてください（「2」に統一。「2組」などを混ぜない）。\n記録・分析（weak_child など）の対象になるのは、email と氏名の両方が入っている児童だけです。\n名簿にないアカウントも「おためし」として全モードを使えますが、記録は一切されません。',
    config: '各種設定です。通常は教師用ページ（?page=teacher）から変更してください。\n直接編集した場合、児童への反映は最大1分遅れます（教師用ページから保存すると即時）。',
    class_config: 'クラスごとに、どのモードを児童に見せるかの設定です。チェックの無いモードは表示されません。\n' +
                  'A列は roster の「学年」「組」から作る「学年-組」と1文字も違ってはいけません（例: 3-1）。\n' +
                  '通常は教師用ページ（?page=teacher）から操作してください。直接編集した場合、児童への反映は最大1分遅れます。',
    log: '1回のプレイ（1試行）を1行で記録した内部データです。直接は読まなくてよいシートです。\n個々の誤答を読みたいときは mistakes シートを、傾向を見たいときは weak_child / weak_class を見てください。',
    daily: '当日の学級内ランキングを計算するための内部データです。直接は見なくてよいシートです。',
    summary: '児童ごと・モードごと・制限時間ごとの累計成績とハイスコアです。kind列は r=本番／p=練習です。',
    coop: '協力モードのセッション履歴です（1開始＝1行）。教師用ページの「きょうりょく」から操作してください。',
    coop_log: '協力モードの提出記録（内部データ）です。直接は読まなくてよいシートです。',
    coop_save: '協力モードの保存データです（再生用のスナップショット）。教師用ページの「きょうりょく」から読み込みます。'
  };
  Object.keys(notes).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) sh.getRange('A1').setNote(notes[name]);
  });
}

function ensureSheets_() {
  var ss = ss_(), defs = {};
  defs[SHEETS.CONFIG] = ['key', 'value'];
  defs[SHEETS.ROSTER] = ['email', '学年', '組', '番号', '氏名'];
  defs[SHEETS.CLASS] = classHead_();
  defs[SHEETS.LOG] = LOG_HEAD_;
  defs[SHEETS.DAILY] = ['date', 'class', 'mode', 'モード名', 'limit_sec', 'email', 'best', 'ts'];
  defs[SHEETS.SUMMARY] = ['email', 'mode', 'モード名', 'limit_sec', 'kind',
                          'tries', 'total_correct', 'total_attempts', 'best', 'best_count'];
  defs[SHEETS.WCHILD] = [];
  defs[SHEETS.WCLASS] = [];
  defs[SHEETS.COOP] = ['id', 'class', 'pattern', 'seed', 'mode', 'gn', 'groups',
                       'names', 'nos', 'start', 'end', 'status', 'total', 'prior', 'origins', 'origin_pos', 'grow_w'];
  defs[SHEETS.COOPLOG] = ['session', 't', 'email', 'correct', 'mode'];
  defs[SHEETS.COOPSAVE] = ['save_id', 'name', 'saved', 'session', 'payload'];
  defs[SHEETS.USED] = ['token', 'ts'];

  // 旧形式の class_config（フラグ単位の allow_* 列）が残っていると、
  // 列がずれたまま読み込んで公開設定を誤読する。見出しごと作り直す。
  // モード単位に変えた時点で中身は読めないので、残しても意味がない。
  var made = false, reset = {};
  var cls = ss.getSheetByName(SHEETS.CLASS);
  if (cls && cls.getLastRow() > 0) {
    var h0 = cls.getRange(1, 1, 1, cls.getLastColumn()).getValues()[0].map(String);
    var hasMode = h0.some(function (x) { return x.indexOf('mode_') === 0; });
    // 作り直したら made を立てる。キャッシュに旧形式の読み取り結果が残ったままだと、
    // 消した直後の最大60秒、公開設定を古い列のまま返し続ける。
    if (!hasMode) {
      cls.clear();
      // clear() の直後に getLastRow() が0を返すとは限らない（保留中の変更が
      // 反映される保証が無い）。見出しを書くかどうかをそこに賭けると、
      // 見出しの無い class_config が残り、公開設定が全部オフのまま読まれる。
      // 消したことは自分で覚えておく。
      reset[SHEETS.CLASS] = true;
      made = true;
    }
  }

  for (var name in defs) {
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); made = true; }
    if (defs[name].length && (reset[name] || sh.getLastRow() === 0)) {
      sh.getRange(1, 1, 1, defs[name].length).setValues([defs[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }
  // 書式の指定は書き込み。毎回やると、開いただけの実行が全部シートに書きに行く
  if (made) ss.getSheetByName(SHEETS.DAILY).getRange('A:A').setNumberFormat('@');

  var cf = ss.getSheetByName(SHEETS.CONFIG);
  if (cf.getLastRow() <= 1) {
    var def = defaults_(), rows = [];
    for (var k in def) rows.push([k, def[k]]);
    cf.getRange(2, 1, rows.length, 2).setValues(rows);
    made = true;
  }
  if (made) {
    cache_().remove('config'); cache_().remove('classcfg');
    applyFriendlyStyling_();
  }
  return made;
}

function ensureTriggers_() {
  if (typeof LB_PLATFORM_TRIGGERS !== 'undefined' && LB_PLATFORM_TRIGGERS) return;   // 学習BASE の読み込み係が置く
  // まとめたプロジェクトでは、全単元を回す *All を1つずつ置く（単元ごとには置かない）
  var want = isMulti_() ? { nightlyAggregateAll: 23, rolloverRosterAll: 2, resetDailyAll: 3 }
                        : { nightlyAggregate: 23, rolloverRoster: 2, resetDaily: 3 }, have = {};
  ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
  for (var fn in want) {
    if (!have[fn]) ScriptApp.newTrigger(fn).timeBased().atHour(want[fn]).everyDays(1).create();
  }
}

/**
 * 単元の自己紹介を meta シートに書く。ハブの横断分析（apps/hub/Analysis.gs）がこれを読む。
 * ハブは別プロジェクトなので UNIT.types を直接は読めない。型の定義の正本は Unit.gs のままにし、
 * ハブへはデータとして渡す（依存の向きを保つ。docs/ANALYSIS_REQUIREMENTS.md「データの取り方」）。
 *
 * 書くのは setup と教師画面を開いたときだけ。児童の起動では書かない（「開いただけの実行で書き込まない」）。
 * 中身が同じなら書かない。
 */
var META_SHEET = 'meta';
function writeMeta_() {
  var rows = [
    ['unit_id', String(UNIT.id)],
    ['grade', Number(UNIT.grade) || 0],
    ['title', String(UNIT.teacherTitle || UNIT.title || UNIT.id)],
    ['engine_ver', ENGINE_VER],
    ['types', JSON.stringify(UNIT.types || {})],
    ['modes', JSON.stringify((UNIT.modes || []).map(function (m) { return { id: m.id, name: m.name }; }))]
  ];
  try {
    var ss = ss_(), sh = ss.getSheetByName(META_SHEET);
    if (sh && sh.getLastRow() === rows.length) {
      var cur = sh.getRange(1, 1, rows.length, 2).getValues();
      var same = cur.every(function (r, i) { return String(r[0]) === String(rows[i][0]) && String(r[1]) === String(rows[i][1]); });
      if (same) return false;
    }
    if (!sh) sh = ss.insertSheet(META_SHEET);
    sh.clear();
    sh.getRange(1, 1, rows.length, 2).setValues(rows);
    return true;
  } catch (e) {
    console.error('writeMeta_ 失敗: ' + e.message);
    return false;
  }
}

/** 承認のために最初に1度だけ実行する */
function setup() {
  if (isMulti_()) {
    ownerOnly_();
    var gp = PropertiesService.getScriptProperties();
    // スプレッドシートが未登録の単元は飛ばす（ここで作らない。児童か教師が初めて開いた時に作る）
    var cat = '';
    if (typeof LbCatalog !== 'undefined' && hubRoster_()) {
      try { cat = '技能の目録：' + (LbCatalog.publish(Base.hub(), tamathCatalog_()) ? 'ハブに書いた' : '変わりなし') + '\n\n'; }
      catch (eC) { cat = '技能の目録：× ' + eC.message + '\n\n'; }
    }
    var msg = cat + unitIds_().map(function (id) {
      if (!gp.getProperty(unitSheetKey_(id))) return '【' + id + '】未登録のため飛ばした';
      useUnit_(id);
      try { return '【' + id + '】' + setupOne_(); } catch (e) { return '【' + id + '】× ' + e.message; }
    }).join('\n\n');
    console.log(msg);
    return msg;
  }
  return setupOne_();
}
function setupOne_() {
  props_().deleteProperty(READY_KEY);
  cache_().remove('ready');
  cache_().remove('unitcheck');
  ensureReady_();
  writeMeta_();
  return 'セットアップ完了（シート・トリガーを確認しました）\n' + checkUnit();
}

// --- dist/multi/AllUnits.gs ---
// AllUnits.gs — 全単元の Unit.gs をつないだもの（tools/bundle/build.cjs が作る。直接直さない）
// 単元: bai, bignum, circle, decimal, divmod, factor, hiku, kakehissan, kuku, length, operation-choice, tasu, volume, weight

// ===== apps/grade3/bai/Unit.gs =====
/**
 * Unit.gs — 何倍でしょう（3年：倍の第1〜第3用法、a×b×c）
 *
 * モードは前提スキルの依存順。型の混在は最後の「ぜんぶ」だけ。
 *
 *   ① もとにする大きさ  「赤は 青の 4倍」→ もとにする大きさは どちら？（タップ）
 *   ② ずに かく         文と図（テープ図／関係図）→ 図の ア に入る数は？
 *   ③ しきを えらぶ      文 → ① 24×4 ② 24÷4 ③ 24＋4 から選ぶ（計算はさせない）
 *   ④ なんばい けいさん  第1・第2・第3用法を 1:1:1
 *   ⑤ ばいの ばい        2倍の3倍は何倍？／3つの数のかけ算の場面
 *   ⑥ ぜんぶ            ①〜⑤をまぜる
 *
 * 【語順は①から混ぜる】数が出てくる順と計算の順がそろう文だけで練習すると、
 * 「出てきた順に式を立てる」方略でも正解できてしまい、その誤り（N2）を練習が強める。
 * 各型の半分は、数の出てくる順が計算の順と逆になる文にする。tag の o/r がその区別
 * （o＝そろう、r＝逆）。同じ児童の o と r の正答率の差が、N2 の手がかりになる。
 *
 * 【③は選ぶだけ】演算を決める力と計算の速さを分けて測る。計算の速さは九九・わり算の
 * タイムアタックで測れる。誤りの選択肢は「倍ならかける」（N1）と「倍を差とみる」（N3）。
 *
 * 【④⑤は Enter で確定】第1・第3用法の答えは1桁、第2用法は2桁になる。1桁で自動確定
 * すると、かけてしまった児童（N1）の2桁目が切られ、誤答の値が記録に残らない。
 * 「何倍」は九九の範囲なので全問2桁にもそろえられない。digitCap は2で宣言し、
 * 1桁の答えは Enter で確定する（正しい答えは打った時点で通る）。
 *
 * 【②はテープ図と関係図を半々】同じ場面を両方の図で出し、tag に図の種類を残す。
 * 片方の図だけで誤る児童は、倍の概念ではなく図の読み方（N6）でつまずいている。
 *
 * 文は図（fig）の中に書く。式の欄の大きな字で文を出すと、2行に折り返して図と欄が押し出される。
 */

var BA_INK = '#FFFFFF';
var BA_SUB = '#C9D1E8';
var BA_LINE = '#8C93AC';
var BA_MARK = ['①', '②', '③'];
var BA_NAMES = [['赤', '青'], ['白', '黄'], ['ながい', 'みじかい']];

// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['bai'] = {
  id: 'bai',
  grade: 3,                 // 学年（1〜6）。置き場 apps/grade3/ と一致させる（tests/contract が照合する）
  title: '何倍でしょう タイムアタック！',
  teacherTitle: '何倍でしょう 設定・分析',

  units: { cm: '', '倍': '' },

  modes: [
    { id: 1, name: 'もとにする大きさ', desc: '赤は 青の 4倍 → もとにする大きさは？（タップ）' },
    { id: 2, name: 'ずに かく', desc: 'テープ図・関係図の ア に入る数', needs: { mode: 1, tries: 3 },
      help: 'Enter で こたえあわせ' },
    { id: 3, name: 'しきを えらぶ', desc: '24×4 ／ 24÷4 ／ 24＋4 から選ぶ', needs: { mode: 2, tries: 3 } },
    { id: 4, name: 'なんばい けいさん', desc: '第1・第2・第3用法', needs: { mode: 3, tries: 3 },
      help: 'Enter で こたえあわせ' },
    { id: 5, name: 'ばいの ばい', desc: '2倍の3倍は？／a×b×c の場面', needs: { mode: 4, tries: 3 },
      help: 'Enter で こたえあわせ' },
    { id: 6, name: 'ぜんぶ', desc: '①〜⑤をまぜて出す', needs: { mode: 5, tries: 3 },
      help: 'Enter で こたえあわせ' }
  ],

  types: {
    A: 'もとにする大きさ',
    D: 'ず テープ', E: 'ず 関係図',
    S: 'しき えらび',
    F: '何倍（第1）', G: 'くらべる量（第2）', H: 'もとにする量（第3）',
    I: '倍の倍', J: 'a×b×c'
  },

  digitCap: {
    A: { '': 1 }, S: { '': 1 },
    D: { cm: 2, '倍': 2 }, E: { cm: 2, '倍': 2 },
    F: { '倍': 2 }, G: { cm: 2 }, H: { cm: 2 },
    I: { '倍': 2 }, J: { cm: 2 }
  },

  tips: 'tag の o は「数の出てくる順＝計算の順」の文、r は逆順の文。' +
        'r だけで誤る児童は、出てきた順に式を立てている可能性がある。' +
        '第3用法（H）の誤答が正答×倍×倍（くらべる量×倍）なら「倍ならかける」、' +
        '倍の倍（I）の誤答が2つの倍の和なら、倍を足している。' +
        'しき えらび（S）の誤りは、tag の並び（例 S:mul-div-add）と答えた番号で読む。',

  gen: function (rand, mode) {
    switch (mode) {
      case 1: return baBase_(rand);
      case 2: return baDiagram_(rand);
      case 3: return baPick_(rand);
      case 4: return baCalc_(rand);
      case 5: return baTwice_(rand);
      case 6: return UNIT_DEFS['bai'].gen(rand, ri_(rand, 1, 5));   // 全単元をまとめた時も自分の gen を呼ぶ
    }
    throw new Error('mode ' + mode);
  }
};

/* ============================================================
 *  場面（数と文）
 * ============================================================ */

/**
 * 1つの場面：くらべる量 c ＝ もとにする量 m × 倍 k。
 * m・k は 2〜9（c は九九の範囲）。u は 1〜3（第1〜第3用法＝何を問うか）、
 * ord は 'o'（数の出てくる順＝計算の順）か 'r'（逆順）。
 */
function baScene_(rand, u) {
  var nm = pick_(rand, BA_NAMES), m = ri_(rand, 2, 9), k = ri_(rand, 2, 9);
  return { big: nm[0], small: nm[1], m: m, k: k, c: m * k, u: u, ord: rand() < 0.5 ? 'o' : 'r' };
}

/**
 * 場面を文にする（行の配列）。関係の文は常に「<くらべる>は <もと>の k倍」。
 * 「の」の前がもとにする量、という読み方だけで判定できるようにする。
 *
 *   第1用法（何倍）  そろう: c → m（c÷m）   逆: m → c
 *   第2用法（くらべる量）かけ算なので順は答えに影響しない。関係の文を先か後かで分ける
 *   第3用法（もとにする量）そろう: c → k（c÷k） 逆: k → c
 */
function baText_(s) {
  var B = s.big, S = s.small, rel = B + 'は ' + S + 'の ' + s.k + '倍です。';
  var cLine = B + 'は ' + s.c + 'cmです。', mLine = S + 'は ' + s.m + 'cmです。';
  if (s.u === 1) {
    return s.ord === 'o' ? [cLine, mLine, B + 'は ' + S + 'の 何倍？']
                         : [mLine, cLine, B + 'は ' + S + 'の 何倍？'];
  }
  if (s.u === 2) {
    return s.ord === 'o' ? [mLine, rel, B + 'は 何cm？'] : [rel, mLine, B + 'は 何cm？'];
  }
  return s.ord === 'o' ? [cLine, rel, S + 'は 何cm？'] : [rel, cLine, S + 'は 何cm？'];
}

function baTag_(s) {
  return 'u' + s.u + s.ord + ' m' + s.m + ' k' + s.k;
}

/* ============================================================
 *  図（SVG 文字列）
 * ============================================================ */

function baR_(x) { return Math.round(x); }

function baShuffle_(rand, arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function baSvg_(w, h, body) {
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" ' +
         'font-family="sans-serif" font-weight="800">' + body + '</svg>';
}
function baText1_(x, y, s, size, fill, anchor, cls) {
  return '<text' + (cls ? ' class="' + cls + '"' : '') + ' x="' + baR_(x) + '" y="' + baR_(y) + '" font-size="' + (size || 44) +
         '" fill="' + (fill || BA_INK) + '" text-anchor="' + (anchor || 'start') +
         '" dominant-baseline="middle">' + s + '</text>';
}
/** 文の行を上から並べる。返り値は次に描ける y */
function baLines_(lines, y0) {
  var body = '', y = y0;
  lines.forEach(function (ln) { body += baText1_(40, y, ln, 44); y += 62; });
  return { svg: body, y: y };
}
function baRect_(x, y, w, h, fill) {
  return '<rect x="' + baR_(x) + '" y="' + baR_(y) + '" width="' + baR_(w) + '" height="' + baR_(h) +
         '" fill="' + (fill || 'none') + '" stroke="' + BA_LINE + '" stroke-width="4"/>';
}
function baLine_(x1, y1, x2, y2, color, w) {
  return '<line x1="' + baR_(x1) + '" y1="' + baR_(y1) + '" x2="' + baR_(x2) + '" y2="' + baR_(y2) +
         '" stroke="' + (color || BA_LINE) + '" stroke-width="' + (w || 4) + '"/>';
}

/** 文だけの図（④⑤）。選択肢があれば下に1行で並べる */
function baPlain_(lines, choices) {
  var W = 960, t = baLines_(lines, 50), body = t.svg, y = t.y + 10;
  if (choices) {
    var boxW = choices.length === 2 ? 330 : 260, boxH = 96, gap = choices.length === 2 ? 80 : 60;
    var x = (W - (choices.length * boxW + (choices.length - 1) * gap)) / 2;
    choices.forEach(function (c, i) {
      body += '<g data-pick="' + (i + 1) + '">' +
              '<rect class="pkb" x="' + baR_(x) + '" y="' + baR_(y) + '" width="' + boxW + '" height="' + boxH +
              '" rx="6" fill="#000" fill-opacity="0" stroke="' + BA_LINE + '" stroke-width="3"/>' +
              baText1_(x + 22, y + boxH / 2, BA_MARK[i], 40, BA_SUB) +
              baText1_(x + boxW / 2 + 24, y + boxH / 2, c, 48, BA_SUB, 'middle', 'pkv') +
              '</g>';
      x += boxW + gap;
    });
    y += boxH + 10;
  }
  return baSvg_(W, y, body);
}

/**
 * テープ図。上＝もとにする量（1つ分）、下＝くらべる量（k つ分に区切る）。
 * 数の欄は vals（'ア' '？' や数）で受け、図は数の大きさに比例させない
 * （比例させると長さの比から答えが読めてしまう）。倍は下のテープの右に書く。
 */
/** '？'や'ア'の問い印なら「？」の色（Core.gs の questionColor_）、数なら既定色 */
function baQfill_(v) { return (v === '？' || v === 'ア') ? questionColor_() : BA_INK; }

function baTape_(s, vals, y0) {
  var x0 = 170, full = 620, one = full / s.k, h = 50, body = '';
  var yS = y0, yB = y0 + 90;
  body += baText1_(40, yS + h / 2, s.small, 40, BA_SUB) + baText1_(40, yB + h / 2, s.big, 40, BA_SUB);
  body += baRect_(x0, yS, one, h, 'rgba(255,255,255,.12)');
  body += baRect_(x0, yB, full, h, 'rgba(255,255,255,.12)');
  for (var i = 1; i < s.k; i++) body += baLine_(x0 + one * i, yB, x0 + one * i, yB + h, BA_LINE, 3);
  body += baText1_(x0 + one + 16, yS + h / 2, vals.m + 'cm', 40, baQfill_(vals.m));
  body += baText1_(x0 + full + 16, yB + h / 2, vals.c + 'cm', 40, baQfill_(vals.c));
  body += baText1_(x0 + full / 2, yB + h + 40, '（' + vals.k + '倍）', 40, baQfill_(vals.k), 'middle');
  return { svg: body, y: yB + h + 80 };
}

/** 関係図。[もとにする量] —×倍→ [くらべる量]。矢印の向きは常に もと→くらべる */
function baRel_(s, vals, y0) {
  var bw = 240, bh = 80, xL = 60, xR = 660, y = y0, body = '';
  body += baRect_(xL, y, bw, bh) + baRect_(xR, y, bw, bh);
  body += baText1_(xL + bw / 2, y + bh / 2, vals.m + 'cm', 44, baQfill_(vals.m), 'middle');
  body += baText1_(xR + bw / 2, y + bh / 2, vals.c + 'cm', 44, baQfill_(vals.c), 'middle');
  body += baText1_(xL + bw / 2, y + bh + 34, s.small, 36, BA_SUB, 'middle');
  body += baText1_(xR + bw / 2, y + bh + 34, s.big, 36, BA_SUB, 'middle');
  var ay = y + bh / 2;
  body += baLine_(xL + bw + 10, ay, xR - 20, ay, BA_INK, 5) +
          '<path d="M' + (xR - 10) + ' ' + ay + ' L' + (xR - 34) + ' ' + (ay - 14) + ' L' + (xR - 34) + ' ' + (ay + 14) + ' Z" fill="' + BA_INK + '"/>';
  body += baText1_((xL + bw + xR) / 2, ay - 36, '×' + vals.k, 44, baQfill_(vals.k), 'middle');
  return { svg: body, y: y + bh + 70 };
}

/* ============================================================
 *  ① もとにする大きさ
 * ============================================================ */

function baBase_(rand) {
  var s = baScene_(rand, 1 + Math.floor(rand() * 3));
  // 関係の文だけを2通りの語順で出す：「赤は 青の k倍」／「青の k倍が 赤」
  var form = rand() < 0.5 ? 'o' : 'r';
  var rel = form === 'o' ? s.big + 'は ' + s.small + 'の ' + s.k + '倍です。'
                         : s.small + 'の ' + s.k + '倍が ' + s.big + 'です。';
  var order = baShuffle_(rand, ['small', 'big']);
  var fig = baPlain_([rel], order.map(function (x) { return s[x]; }));
  return {
    t: 'A', q: ['もとにする 大きさは？'], f: [''], ans: { '': order.indexOf('small') + 1 },
    tag: 'A:' + form + ' ' + order.join('-'), fig: fig
  };
}

/* ============================================================
 *  ② ずに かく（テープ図／関係図）
 * ============================================================ */

function baDiagram_(rand) {
  var s = baScene_(rand, 1 + Math.floor(rand() * 3));
  var unknown = ['k', 'c', 'm'][s.u - 1];               // 第1＝倍、第2＝くらべる、第3＝もと
  var known = unknown === 'k' ? ['m', 'c'] : unknown === 'c' ? ['m', 'k'] : ['c', 'k'];
  var ask = pick_(rand, known);
  var vals = { m: s.m, c: s.c, k: s.k };
  vals[unknown] = '？';
  vals[ask] = 'ア';
  var tape = rand() < 0.5, t = tape ? 'D' : 'E';
  var head = baLines_(baText_(s).slice(0, 2), 50);
  var fig = tape ? baTape_(s, vals, head.y + 10) : baRel_(s, vals, head.y + 10);
  var f = ask === 'k' ? '倍' : 'cm', ans = {};
  ans[f] = s[ask];
  return {
    t: t, q: ['ア に 入る 数は'], f: [f], ans: ans,
    tag: t + ':' + baTag_(s) + ' ア=' + ask,
    fig: baSvg_(960, fig.y, head.svg + fig.svg)
  };
}

/* ============================================================
 *  ③ しきを えらぶ
 * ============================================================ */

function baPick_(rand) {
  var s = baScene_(rand, 1 + Math.floor(rand() * 3));
  // 文に出てくる2つの数。式は大きい数を先に書く（÷が3年で読める形になる）
  var nums = s.u === 1 ? [s.c, s.m] : s.u === 2 ? [s.m, s.k] : [s.c, s.k];
  var a = Math.max(nums[0], nums[1]), b = Math.min(nums[0], nums[1]);
  var right = s.u === 2 ? 'mul' : 'div';
  var exp = { mul: a + '×' + b, div: a + '÷' + b, add: a + '＋' + b };
  var order = baShuffle_(rand, ['mul', 'div', 'add']);
  return {
    t: 'S', q: ['しきは どれ？'], f: [''], ans: { '': order.indexOf(right) + 1 },
    tag: 'S:' + order.join('-') + ' ' + baTag_(s),
    fig: baPlain_(baText_(s), order.map(function (x) { return exp[x]; }))
  };
}

/* ============================================================
 *  ④ なんばい けいさん
 * ============================================================ */

function baCalc_(rand) {
  var u = 1 + Math.floor(rand() * 3), s = baScene_(rand, u);
  var t = ['F', 'G', 'H'][u - 1];
  var f = u === 1 ? '倍' : 'cm', ans = {};
  ans[f] = u === 1 ? s.k : u === 2 ? s.c : s.m;
  return { t: t, q: ['こたえは'], f: [f], ans: ans, tag: t + ':' + baTag_(s), fig: baPlain_(baText_(s)) };
}

/* ============================================================
 *  ⑤ ばいの ばい
 * ============================================================ */

function baTwice_(rand) {
  var nm = pick_(rand, [['赤', '青', '白'], ['黄', '白', '青']]);
  var a = ri_(rand, 2, 5), b = ri_(rand, 2, 4), ord = rand() < 0.5 ? 'o' : 'r';
  // C → B（b倍）→ A（a倍）。A は C の a×b 倍
  var l1 = nm[1] + 'は ' + nm[2] + 'の ' + b + '倍です。';
  var l2 = nm[0] + 'は ' + nm[1] + 'の ' + a + '倍です。';
  var rel = ord === 'o' ? [l1, l2] : [l2, l1];
  if (rand() < 0.5) {
    return { t: 'I', q: ['こたえは'], f: ['倍'], ans: { '倍': a * b },
             tag: 'I:' + ord + ' a' + a + ' b' + b,
             fig: baPlain_(rel.concat([nm[0] + 'は ' + nm[2] + 'の 何倍？'])) };
  }
  var m = ri_(rand, 2, 4);   // m×a×b ≦ 4×5×4 ＝ 80（2桁に収める）
  return { t: 'J', q: ['こたえは'], f: ['cm'], ans: { cm: m * a * b },
           tag: 'J:' + ord + ' m' + m + ' a' + a + ' b' + b,
           fig: baPlain_([nm[2] + 'は ' + m + 'cmです。'].concat(rel, [nm[0] + 'は 何cm？'])) };
}

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['bai'];

// ===== apps/grade3/bignum/Unit.gs =====
/** 大きな数TA。万・億・兆の位取りを、各欄4桁以内で練習する。 */
// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['bignum'] = {
  id: 'bignum',
  grade: 3,                 // 学年（1〜6）。置き場 apps/grade3/ と一致させる（tests/contract が照合する）
  title: '大きな数 タイムアタック！',
  teacherTitle: '大きな数 設定・分析',
  units: { '万': '#F1B1E4', '億': '#8A6CE5', '兆': '', 'こ': '' },
  modes: [
    { id: 1, name: '万に わける', desc: '30506 → 3万506（1〜9万の範囲）', help: 'つぎの欄は →、こたえあわせは Enter' },
    { id: 2, name: '億・兆に わける', desc: '300040000 → 3億4万 ／ 3000400000000 → 3兆4億', help: 'つぎの欄は →、こたえあわせは Enter' },
    { id: 3, name: '位の 数字', desc: '大きな数の、指定された位の数字（0も出題）' },
    { id: 4, name: 'いくつ分', desc: '3500000 は 10000 が 350こ', help: 'Enter で こたえあわせ' },
    { id: 5, name: '10倍・100倍', desc: '35万 × 10 = 350万', help: 'Enter で こたえあわせ' },
    { id: 6, name: '10分の1・100分の1', desc: '350万 ÷ 10 = 35万', help: 'Enter で こたえあわせ' }
  ],
  types: {
    splitMan: '万と残り', splitOku: '億と万', splitCho: '兆と億',
    digitMan: '万のまとまりの位', digitOku: '億のまとまりの位', digitCho: '一兆の位',
    countSen: '千がいくつ', countMan: '一万がいくつ', countOku: '一億がいくつ',
    times10: '10倍', times100: '100倍', divide10: '10分の1', divide100: '100分の1'
  },
  digitCap: {
    splitMan: { '万': 1, '': 4 }, splitOku: { '億': 1, '万': 4 }, splitCho: { '兆': 1, '億': 4 },
    3: { '': 1 }, 4: { 'こ': 4 }, 5: { '万': 4, '億': 4 }, 6: { '万': 4, '億': 4 }
  },
  fieldsByType: {
    splitMan: ['万', ''], splitOku: ['億', '万'], splitCho: ['兆', '億'],
    countSen: ['こ'], countMan: ['こ'], countOku: ['こ']
  },
  tips: '万・億・兆は4桁ずつのまとまり。0のある問題の誤答も確認してください。<br>' +
    '位の数字、いくつ分、10倍と10分の1を分けて見ると、指導する内容を選べます。<br>' +
    '初打鍵までの時間には読む時間や操作への慣れも含まれます。遅さだけで未定着とは判断せず、誤答や授業中の様子と合わせてください。',

  gen: function (rand, mode) {
    var high, low, names, ans, q, t, n, unit, factor;
    if (mode === 1 || mode === 2) {
      // 上位は1桁。下位は0や途中の0を含む4桁のまとまり。
      // 下位を1000以上に絞ると、位を埋める0の練習ができない。
      high = ri_(rand, 1, 9);
      low = ri_(rand, 0, 9999);
      var level = mode === 1 ? 0 : ri_(rand, 1, 2);
      names = [['万', ''], ['億', '万'], ['兆', '億']][level];
      t = ['splitMan', 'splitOku', 'splitCho'][level];
      n = (high * 10000 + low) * Math.pow(10000, level);
      ans = {}; ans[names[0]] = high; ans[names[1]] = low;
      return { t: t, q: [String(n)], f: names, ans: ans, tag: t + ':' + n };
    }
    if (mode === 3) {
      // 各位を同じ頻度で選ぶ。文字列で作って途中の0も保持する。
      var pos = ri_(rand, 4, 12);
      var places = ['一万', '十万', '百万', '千万', '一億', '十億', '百億', '千億', '一兆'];
      var width = Math.min(13, pos + 2);
      var digits = [String(ri_(rand, 1, 9))];
      for (var i = 1; i < width; i++) digits.push(String(ri_(rand, 0, 9)));
      n = digits.join('');
      t = pos < 8 ? 'digitMan' : (pos < 12 ? 'digitOku' : 'digitCho');
      return { t: t, q: [n, 'の', places[pos - 4] + 'の位の数字'], f: [''],
        ans: { '': Number(digits[width - pos - 1]) }, tag: n + ':place' + pos };
    }
    if (mode === 4) {
      var ix = ri_(rand, 0, 2);
      unit = [1000, 10000, 100000000][ix];
      n = ri_(rand, 1, 9999);
      return { t: ['countSen', 'countMan', 'countOku'][ix],
        q: [String(n * unit), 'は', String(unit) + 'が'], f: ['こ'],
        ans: { 'こ': n }, tag: (n * unit) + ':groups' + unit };
    }
    if (mode !== 5 && mode !== 6) throw new Error('大きな数: モードが不正です');
    factor = pick_(rand, [10, 100]);
    unit = pick_(rand, ['万', '億']);
    // 積も被除数も9999以下。除算は整数になり、全回答が4桁欄に収まる。
    n = ri_(rand, 1, Math.floor(9999 / factor));
    var divide = mode === 6;
    t = (divide ? 'divide' : 'times') + factor;
    q = [String(divide ? n * factor : n), unit, divide ? '÷' : '×', String(factor)];
    ans = {}; ans[unit] = divide ? n : n * factor;
    return { t: t, q: q, f: [unit], ans: ans, tag: t + ':' + n + unit };
  }
};

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['bignum'];

// ===== apps/grade3/circle/Unit.gs =====
/**
 * Unit.gs — 円と球（3年）
 *
 * モードは前提スキルの依存順に並べ、土台に近いものを先に置く。
 * 型の混在（ランダム出題）は最後の「ぜんぶ」だけ。
 *
 *   ① ちゅうしん・はんけい  中心はどれ／半径はどれ（タップで答える）
 *   ② ちょっけい            直径はどれ（タップで答える）
 *   ③ はんけい⇄ちょっけい   半径→直径／直径→半径（同じモードに両向きを混ぜる）
 *   ④ きゅう                いちばん大きい切り口はどれ／球の半径⇄直径
 *   ⑤ ならんだ まる          箱に並んだボールの長さ（1列・たてよこ・逆算）
 *   ⑥ ぜんぶ                ①〜⑤を混ぜる
 *
 * 図の向きは①から毎問ランダムに回す。向きを固定して練習すると
 * 「半径は右向きの1本」「直径は横の端から端」という典型図への固着を
 * 練習がかえって強める（推定）。「ランダムは最後」は型の混在のことで、図の向きのことではない。
 *
 * タップで答える問いの誤答の選択肢は、誤概念ごとに1つずつ置く。
 * 並びは毎問入れ替わるので、答えた番号だけでは何を選んだか分からない。
 * tag に並び（例 'B:chord-rad-short-off'）を入れておき、mistakes シートの
 * 「もんだい」と「こたえた値」から、どの誤りの選択肢を選んだかを読めるようにしている。
 *
 *   A 中心    center＝正答 near/mid/edge＝中心からずれた点（内側の点ならどれでも中心、とみなす誤り）
 *   B 半径    rad＝正答 short＝円周まで届かない chord＝半径と同じ長さの弦（「半分の長さ＝半径」）
 *             off＝中心以外から円周へ
 *   C 直径    dia＝正答 hchord＝中心を通らない横の弦（「横の端から端＝直径」） rad＝半径
 *             part＝中心を通るが円周まで届かない
 *   F 切り口  mid＝正答 up/top/down＝中心を通らない切り口（「切り口はどれも同じ大きさ」）
 *
 * 長さの答えはすべて2桁（10〜99）にそろえる。桁数が確定のタイミングとして漏れないため
 * （docs/ADD_UNIT.md 3章）。半径を答える問いは直径を偶数に限る（小数は未習）。
 */

var CI_MARK = ['①', '②', '③', '④'];
/** タップの問いの誤答の選択肢 → 誤概念（UNIT.wrongLabel）。並びの意味は先頭の注記の表と同じ */
var CI_WRONG_ = {
  'A:near': '中心からずれた点を中心とみる', 'A:mid': '中心からずれた点を中心とみる', 'A:edge': '中心からずれた点を中心とみる',
  'B:short': '円周まで届かない線を半径とみる', 'B:chord': '半分の長さの線（弦）を半径とみる', 'B:off': '中心を通らない線を半径とみる',
  'C:hchord': '横の端から端（中心を通らない）を直径とみる', 'C:rad': '半径を直径とみる', 'C:part': '円周まで届かない線を直径とみる',
  'F:up': '中心を通らない切り口を最大とみる', 'F:top': '中心を通らない切り口を最大とみる', 'F:down': '中心を通らない切り口を最大とみる'
};
var CI_LINE = '#8C93AC';    // 円の輪郭（背景の図）
var CI_INK = '#FFFFFF';     // 選ぶ対象の線・点
var CI_LABEL = '#C9D1E8';   // 長さの字

// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['circle'] = {
  id: 'circle',
  grade: 3,                 // 学年（1〜6）。置き場 apps/grade3/ と一致させる（tests/contract が照合する）
  title: '円と球 タイムアタック！',
  teacherTitle: '円と球 設定・分析',

  defaults: {
    // 最初のメニューの背景に敷く「成長する図形」（docs/ARCHITECTURE.md「背景の床」）
    floor_on: 1,
    floor_per_answer: 0.75
  },

  /** 教師画面に出す単元固有の設定欄（Core も teacher.html もキーの意味を知らず、ここの宣言だけを見て欄を描く） */
  settings: [
    { key: 'floor_on', label: 'メニューの背景の図形', type: 'onoff',
      note: '正答を重ねるほど育つ模様。表示しないと無地になる' },
    { key: 'floor_per_answer', label: '1正答あたりの図形の育ち',
      note: '1分に20問解ける速さの問題を1問正解したときに増えるタイルの枚数。解きにくい問題（1分で解ける数が少ない）ほど1問で多く育つ（速さはこのサイトの記録から自動で出す）。0.75 なら、1分20問の速さでおよそ3,700問で全部そろう',
      min: 0.05, max: 10, step: 0.05 }
  ],

  /**
   * 床の図形と第二の色。このサイトは「円と球」：起点が2つで、左下（縦長の画面では上）から円の模様（鱗のピルの渦）、
   * 反対側の隅寄りから球の模様（フィボナッチ球）が、どのモードの正答でも同じ割合ずつ交互に育つ。
   * 球は床の上に乗っている見え方。台帳は design リポジトリの growing-figures/COLORS.md
   */
  floorPattern: 'circlesphere',
  floorColor: 'amethyst',

  units: { cm: '' },

  modes: [
    { id: 1, name: 'ちゅうしん・はんけい', desc: '中心はどれ？／半径はどれ？（タップ）' },
    { id: 2, name: 'ちょっけい', desc: '直径はどれ？（タップ）', needs: { mode: 1, tries: 3 } },
    { id: 3, name: 'はんけい⇄ちょっけい', desc: '半径12cm → 直径は？', needs: { mode: 2, tries: 3 } },
    { id: 4, name: 'きゅう', desc: 'いちばん大きい切り口／球の半径⇄直径', needs: { mode: 3, tries: 3 } },
    { id: 5, name: 'ならんだ まる', desc: '箱に並んだボールの長さ', needs: { mode: 4, tries: 3 } },
    { id: 6, name: 'ぜんぶ', desc: '①〜⑤をまぜて出す', needs: { mode: 5, tries: 3 } }
  ],

  types: {
    A: '中心', B: '半径', C: '直径',
    D: '半径→直径', E: '直径→半径',
    F: '切り口', G: '球 半径→直径', H: '球 直径→半径',
    I: 'ならび 1れつ', J: 'ならび 1こ分', K: 'ならび たてよこ'
  },

  digitCap: {
    A: { '': 1 }, B: { '': 1 }, C: { '': 1 }, F: { '': 1 },
    D: { cm: 2 }, E: { cm: 2 }, G: { cm: 2 }, H: { cm: 2 },
    I: { cm: 2 }, J: { cm: 2 }, K: { cm: 2 }
  },

  tips: 'タップの問い（中心・半径・直径・切り口）の誤りは mistakes シートで読む。' +
        '「もんだい」の欄が選択肢の並び（例 B:chord-rad-short-off）で、' +
        '「こたえた値」が3なら③の short（円周まで届かない線）を選んだ、と読む。' +
        'ならび（I・J）で答えが正答のちょうど半分なら、ボール1こ分を半径で数えている可能性がある。',

  /** 用語モード（教師画面の「ようご」）に出す用語。台帳は Core.gs の TERMS_ */
  terms: ['circle', 'center', 'radius', 'diameter', 'sphere'],

  /**
   * 誤答 → 誤概念（教師画面の抜け一覧）。tag と、正しい答え・最初に間違えた値（文字列）から読む。
   * 読めない誤り（単なる計算違い）は '' を返す。
   */
  wrongLabel: function (t, tag, want, got) {
    var g = Number(got), w = Number(want);
    if (/^[ABCF]$/.test(t)) {
      var kinds = String(tag).split(':')[1];
      var k = kinds ? kinds.split('-')[g - 1] : '';
      return CI_WRONG_[t + ':' + k] || '';
    }
    if (/^[DEGH]$/.test(t) && g && (g * 2 === w || g === w * 2)) return '半径と直径を取りちがえる';
    if (/^[IJK]$/.test(t) && g && (g * 2 === w || g === w * 2)) return 'ボール1こ分を半径で数える';
    return '';
  },

  gen: function (rand, mode) {
    switch (mode) {
      case 1: return rand() < 0.5 ? ciCenter_(rand) : ciRadius_(rand);
      case 2: return ciDiameter_(rand);
      case 3: return ciConvert_(rand);
      case 4: return rand() < 0.4 ? ciCut_(rand) : ciSphere_(rand);
      case 5: return ciRow_(rand);
      case 6: return UNIT_DEFS['circle'].gen(rand, ri_(rand, 1, 5));   // 全単元をまとめた時も自分の gen を呼ぶ
    }
    throw new Error('mode ' + mode);
  }
};

/* ============================================================
 *  図の部品（SVG 文字列）
 * ============================================================ */

function ciR_(x) { return Math.round(x); }

/** rand で並べ替える（Math.random を使うとサーバーの再採点と食い違う） */
function ciShuffle_(rand, arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 中心 (cx,cy)、半径 r、角 th（ラジアン、上向きが正）の点 */
function ciAt_(cx, cy, r, th) {
  return [cx + r * Math.cos(th), cy - r * Math.sin(th)];
}

function ciSvg_(w, h, body) {
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" ' +
         'font-family="sans-serif" font-weight="800">' + body + '</svg>';
}
function ciCircle_(cx, cy, r, stroke, width, className) {
  return '<circle cx="' + ciR_(cx) + '" cy="' + ciR_(cy) + '" r="' + ciR_(r) +
         '" fill="none" stroke="' + (stroke || CI_LINE) + '" stroke-width="' + (width || 4) +
         '"' + (className ? ' class="' + className + '"' : '') + '/>';
}
function ciDot_(p) {
  return '<circle cx="' + ciR_(p[0]) + '" cy="' + ciR_(p[1]) + '" r="6" fill="' + CI_INK + '"/>';
}
function ciSeg_(p, q) {
  return '<line x1="' + ciR_(p[0]) + '" y1="' + ciR_(p[1]) + '" x2="' + ciR_(q[0]) + '" y2="' + ciR_(q[1]) +
         '" stroke="' + CI_INK + '" stroke-width="6" stroke-linecap="round"/>';
}
function ciText_(x, y, s, size, fill) {
  return '<text x="' + ciR_(x) + '" y="' + ciR_(y) + '" font-size="' + (size || 30) +
         '" fill="' + (fill || CI_LABEL) + '" text-anchor="middle" dominant-baseline="middle">' + s + '</text>';
}
/** 線分 p→q の中点から、線に垂直に d だけずらした位置に長さを書く */
function ciLenLabel_(p, q, s, d) {
  var mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
  var dx = q[0] - p[0], dy = q[1] - p[1], L = Math.sqrt(dx * dx + dy * dy) || 1;
  var nx = -dy / L, ny = dx / L;
  if (ny > 0) { nx = -nx; ny = -ny; }   // 上側に書く
  // 縦に近い線では字の横幅（「40cm」で約70画素）が線に掛かるので、横へのずれを足す
  var k = (d || 26) + Math.abs(nx) * 40;
  return ciText_(mx + nx * k, my + ny * k, s, 30);
}

/**
 * タップで答える問い。4つの小さな図を横に並べる。
 * draw(kind, cx, cy, r) が1枚分の図を返す。
 */
function ciChoice_(rand, t, ask, kinds, right, draw) {
  var order = ciShuffle_(rand, kinds);
  var W = 240, H = 220, r = 78, body = '';
  order.forEach(function (k, i) {
    var cx = i * W + W / 2, cy = H / 2 + 12;
    body += '<g data-pick="' + (i + 1) + '">' +
            '<rect x="' + (i * W) + '" y="0" width="' + W + '" height="' + H + '" fill="none" stroke="none" pointer-events="all"/>' +
            ciText_(i * W + 22, 24, CI_MARK[i], 32) + draw(k, cx, cy, r) + '</g>';
  });
  return {
    t: t, q: ask, f: [''], ans: { '': order.indexOf(right) + 1 },
    tag: t + ':' + order.join('-'),   // ',' は記録の区切りなので使わない
    fig: ciSvg_(W * 4, H, body)
  };
}

function ciAngle_(rand) { return rand() * Math.PI * 2; }

/* ============================================================
 *  ① ちゅうしん・はんけい
 * ============================================================ */

function ciCenter_(rand) {
  var off = { center: 0, near: 0.32, mid: 0.5, edge: 0.7 };
  return ciChoice_(rand, 'A', ['ちゅうしんは', 'どれ？'], ['center', 'near', 'mid', 'edge'], 'center',
    function (k, cx, cy, r) {
      return ciCircle_(cx, cy, r, CI_LINE, 4, 'pkb') + ciDot_(ciAt_(cx, cy, r * off[k], ciAngle_(rand)));
    });
}

function ciRadius_(rand) {
  return ciChoice_(rand, 'B', ['はんけいは', 'どれ？'], ['rad', 'short', 'chord', 'off'], 'rad',
    function (k, cx, cy, r) {
      var th = ciAngle_(rand), c = [cx, cy], s = '';
      if (k === 'rad') s = ciSeg_(c, ciAt_(cx, cy, r, th));
      else if (k === 'short') s = ciSeg_(c, ciAt_(cx, cy, r * 0.55, th));
      else if (k === 'chord') s = ciSeg_(ciAt_(cx, cy, r, th), ciAt_(cx, cy, r, th + Math.PI / 3));
      else s = ciSeg_(ciAt_(cx, cy, r * 0.45, th), ciAt_(cx, cy, r, th + Math.PI / 2));
      return ciCircle_(cx, cy, r, CI_LINE, 4, 'pkb') + s + ciDot_(c);
    });
}

/* ============================================================
 *  ② ちょっけい
 * ============================================================ */

function ciDiameter_(rand) {
  return ciChoice_(rand, 'C', ['ちょっけいは', 'どれ？'], ['dia', 'hchord', 'rad', 'part'], 'dia',
    function (k, cx, cy, r) {
      var th = ciAngle_(rand), c = [cx, cy], s = '';
      if (k === 'dia') s = ciSeg_(ciAt_(cx, cy, r, th), ciAt_(cx, cy, r, th + Math.PI));
      else if (k === 'hchord') {
        // 中心を通らない横の弦。中心から上か下へ 0.35r ずらす
        var y = cy + (rand() < 0.5 ? -1 : 1) * r * 0.35, hw = r * Math.sqrt(1 - 0.35 * 0.35);
        s = ciSeg_([cx - hw, y], [cx + hw, y]);
      } else if (k === 'rad') s = ciSeg_(c, ciAt_(cx, cy, r, th));
      else s = ciSeg_(ciAt_(cx, cy, r * 0.6, th), ciAt_(cx, cy, r * 0.6, th + Math.PI));
      return ciCircle_(cx, cy, r, CI_LINE, 4, 'pkb') + s + ciDot_(c);
    });
}

/* ============================================================
 *  ③ はんけい⇄ちょっけい
 * ============================================================ */

/** 半径 r（5〜20）→ 直径、または 直径 d（20〜40 の偶数）→ 半径。答えは常に2桁 */
function ciPair_(rand) {
  return rand() < 0.5 ? { give: 'r', r: ri_(rand, 5, 20) } : { give: 'd', r: ri_(rand, 10, 20) };
}

function ciConvert_(rand) {
  var p = ciPair_(rand), W = 420, H = 300, cx = W / 2, cy = H / 2 + 8, R = 120;
  var th = ciAngle_(rand), c = [cx, cy], body = ciCircle_(cx, cy, R), a, b, t, ask, ans, label;
  if (p.give === 'r') {
    a = c; b = ciAt_(cx, cy, R, th);
    t = 'D'; ask = ['ちょっけいは']; ans = p.r * 2; label = p.r + 'cm';
  } else {
    a = ciAt_(cx, cy, R, th + Math.PI); b = ciAt_(cx, cy, R, th);
    t = 'E'; ask = ['はんけいは']; ans = p.r; label = (p.r * 2) + 'cm';
  }
  body += ciSeg_(a, b) + ciDot_(c) + ciLenLabel_(a, b, label, 28);
  return { t: t, q: ask, f: ['cm'], ans: { cm: ans }, tag: t + ':' + label, fig: ciSvg_(W, H, body) };
}

/* ============================================================
 *  ④ きゅう
 * ============================================================ */

/** 球（輪郭）と、高さ h（-1〜1、上が正）の水平な切り口 */
function ciBall_(cx, cy, r, h, className) {
  var rx = r * Math.sqrt(1 - h * h), ry = Math.max(4, rx * 0.28), y = cy - h * r;
  return ciCircle_(cx, cy, r, CI_LINE, 4, className) +
         '<ellipse cx="' + ciR_(cx) + '" cy="' + ciR_(y) + '" rx="' + ciR_(rx) + '" ry="' + ciR_(ry) +
         '" fill="rgba(255,255,255,.18)" stroke="' + CI_INK + '" stroke-width="5"/>';
}

function ciCut_(rand) {
  var h = { mid: 0, up: 0.5, top: 0.8, down: -0.6 };
  return ciChoice_(rand, 'F', ['いちばん大きい', 'きり口は？'], ['mid', 'up', 'top', 'down'], 'mid',
    function (k, cx, cy, r) { return ciBall_(cx, cy, r, h[k], 'pkb'); });
}

/** 球を中心で切った切り口に、半径か直径を引いて長さを書く */
function ciSphere_(rand) {
  var p = ciPair_(rand), W = 420, H = 300, cx = W / 2, cy = H / 2 + 8, R = 120, ry = R * 0.28;
  var body = ciBall_(cx, cy, R, 0), c = [cx, cy], a, b, t, ask, ans, label;
  if (p.give === 'r') {
    a = c; b = [cx + R, cy];
    t = 'G'; ask = ['この きゅうの', 'ちょっけいは']; ans = p.r * 2; label = p.r + 'cm';
  } else {
    a = [cx - R, cy]; b = [cx + R, cy];
    t = 'H'; ask = ['この きゅうの', 'はんけいは']; ans = p.r; label = (p.r * 2) + 'cm';
  }
  body += ciSeg_(a, b) + ciDot_(c) + ciText_((a[0] + b[0]) / 2, cy + ry + 30, label, 30);
  return { t: t, q: ask, f: ['cm'], ans: { cm: ans }, tag: t + ':' + label, fig: ciSvg_(W, H, body) };
}

/**
 * p から q までの長さを示す括弧（｛ を横倒しにした形）。side は括弧の張り出す向き（+1/-1、
 * p→q の進行方向に対して右が +1）。返り値の tip は括弧の先端（字を置く位置の手前）。
 *
 * 点線（線分）で示すと、図の中の半径・直径の線と同じ「線」に見え、
 * 「箱の辺に線が引いてある＝その線の長さ」と、長さを線そのものと取り違えさせる。
 * 括弧は「ここからここまで」という範囲の記号で、線分の仲間に見えない。
 * 色も選ぶ対象の線（白）と分けて、長さの字と同じ色にする。
 */
function ciBrace_(p, q, side) {
  var dx = q[0] - p[0], dy = q[1] - p[1], L = Math.sqrt(dx * dx + dy * dy);
  var ux = dx / L, uy = dy / L, nx = -uy * side, ny = ux * side, k = 14;
  function pt(t, o) { return ciR_(p[0] + ux * t + nx * o) + ' ' + ciR_(p[1] + uy * t + ny * o); }
  var m = L / 2;
  var d = 'M' + pt(0, 0) + ' Q' + pt(0, k) + ' ' + pt(k, k) +
          ' L' + pt(m - k, k) + ' Q' + pt(m, k) + ' ' + pt(m, 2 * k) +
          ' Q' + pt(m, k) + ' ' + pt(m + k, k) +
          ' L' + pt(L - k, k) + ' Q' + pt(L, k) + ' ' + pt(L, 0);
  return {
    svg: '<path d="' + d + '" fill="none" stroke="' + CI_LABEL + '" stroke-width="4" stroke-linejoin="round"/>',
    tip: [p[0] + ux * m + nx * 2 * k, p[1] + uy * m + ny * 2 * k]
  };
}

/* ============================================================
 *  ⑤ ならんだ まる（箱に入ったボール）
 * ============================================================ */

/**
 * rows×cols に並べたボールと箱を描く。
 * give: 'd'（1こに直径を引く）/'r'（1こに半径を引く）/'box'（箱のよこに長さ）/null
 * ask:  'w'（よこに？の寸法線）/'h'（たてに？）/null
 */
function ciBox_(rows, cols, d, give, ask, boxLen) {
  // ボール1こ分を120画素に固定し、図の外枠を中身に合わせて切る。
  // 外枠を固定幅にすると、ボールが少ない図ほど余白ばかりになり、表示が縮んで長さの字が読めない
  var u = 120, pad = 90;
  var bw = u * cols, bh = u * rows, x0 = pad, y0 = pad;
  var W = bw + pad * 2, H = bh + pad * 2;
  var body = '<rect x="' + ciR_(x0) + '" y="' + ciR_(y0) + '" width="' + ciR_(bw) + '" height="' + ciR_(bh) +
             '" fill="none" stroke="' + CI_LINE + '" stroke-width="5"/>';
  for (var i = 0; i < rows; i++) for (var j = 0; j < cols; j++) {
    body += ciCircle_(x0 + u * (j + 0.5), y0 + u * (i + 0.5), u / 2, CI_LINE, 3);
  }
  // 長さを示すのは左上のボール（向きは横に固定：箱の辺と平行で、比べる向きがそろう）
  var c = [x0 + u / 2, y0 + u / 2];
  if (give === 'd') {
    body += ciSeg_([x0, c[1]], [x0 + u, c[1]]) + ciDot_(c) + ciText_(c[0], c[1] - 26, d + 'cm', 34);
  } else if (give === 'r') {
    body += ciSeg_(c, [x0 + u, c[1]]) + ciDot_(c) + ciText_(c[0] + u / 4, c[1] - 26, (d / 2) + 'cm', 34);
  } else if (give === 'box') {
    var bt = ciBrace_([x0, y0 - 6], [x0 + bw, y0 - 6], -1);   // 箱の上、上へ張り出す
    body += bt.svg + ciText_(bt.tip[0], bt.tip[1] - 22, boxLen + 'cm', 36);
  }
  if (ask === 'w') {
    var bw_ = ciBrace_([x0, y0 + bh + 6], [x0 + bw, y0 + bh + 6], 1);   // 箱の下、下へ
    body += bw_.svg + ciText_(bw_.tip[0], bw_.tip[1] + 24, '？', 38, questionColor_());
  } else if (ask === 'h') {
    var bh_ = ciBrace_([x0 + bw + 6, y0], [x0 + bw + 6, y0 + bh], -1);   // 箱の右、右へ
    body += bh_.svg + ciText_(bh_.tip[0] + 24, bh_.tip[1], '？', 38, questionColor_());
  }
  return ciSvg_(W, H, body);
}

function ciRow_(rand) {
  var k = rand();
  if (k < 0.4) {
    // I：1列に n こ、1こ分の長さ（直径か半径）から箱のよこを出す。答え 10〜99
    var n = ri_(rand, 2, 5), d = 2 * ri_(rand, Math.ceil(5 / n), Math.floor(49 / n));
    var give = rand() < 0.5 ? 'd' : 'r';
    return { t: 'I', q: ['はこの', 'よこは'], f: ['cm'], ans: { cm: n * d },
             tag: 'I:' + n + 'こ ' + (give === 'd' ? 'ちょっけい' + d : 'はんけい' + (d / 2)),
             fig: ciBox_(1, n, d, give, 'w') };
  }
  if (k < 0.7) {
    // J：箱のよこ L と個数 n から、1こ分の直径か半径を出す。答え 10〜20台
    var n2 = ri_(rand, 2, 4), wantR = rand() < 0.5;
    var d2 = wantR ? 2 * ri_(rand, 10, Math.floor(49 / n2)) : ri_(rand, 10, Math.floor(99 / n2));
    return { t: 'J', q: ['ボール1この', wantR ? 'はんけいは' : 'ちょっけいは'], f: ['cm'],
             ans: { cm: wantR ? d2 / 2 : d2 },
             tag: 'J:' + n2 + 'こ ' + (n2 * d2) + (wantR ? '→はんけい' : '→ちょっけい'),
             fig: ciBox_(1, n2, d2, 'box', null, n2 * d2) };
  }
  // K：たて rows × よこ cols に並べ、たてかよこを問う。直径で与える
  var rows = ri_(rand, 2, 3), cols = ri_(rand, 2, 4), side = rand() < 0.5 ? 'w' : 'h';
  var cnt = side === 'w' ? cols : rows;
  var d3 = ri_(rand, Math.ceil(10 / cnt), Math.floor(99 / cnt));
  return { t: 'K', q: ['はこの', side === 'w' ? 'よこは' : 'たては'], f: ['cm'], ans: { cm: cnt * d3 },
           tag: 'K:' + rows + 'x' + cols + ' ちょっけい' + d3 + (side === 'w' ? ' よこ' : ' たて'),
           fig: ciBox_(rows, cols, d3, 'd', side) };
}

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['circle'];

// ===== apps/grade3/decimal/Unit.gs =====
/** 小数TA。小数を整数化して生成し、浮動小数の丸め誤差を採点に持ち込まない。 */
// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['decimal'] = {
  id: 'decimal',
  grade: 3,                 // 学年（1〜6）。置き場 apps/grade3/ と一致させる（tests/contract が照合する）
  title: '小数 タイムアタック！',
  teacherTitle: '小数 設定・分析',
  units: { 'こ': '' },
  modes: [
    { id: 1, name: '0.1の いくつ分', desc: '3.7 は 0.1 が 37こ' },
    { id: 2, name: '0.01の いくつ分', desc: '3.70 は 0.01 が 370こ' },
    { id: 3, name: '位の 数字', desc: '4.08 の 百分の一の位' },
    { id: 4, name: '10倍・100倍', desc: '0.36 × 10 をした数の 一の位' },
    { id: 5, name: '10分の1・100分の1', desc: '36 ÷ 100 をした数の 十分の一の位' }
  ],
  types: {
    countTenth: '0.1がいくつ', countHundredth: '0.01がいくつ',
    digitOnes: '一の位', digitTenth: '十分の一の位', digitHundredth: '百分の一の位',
    times10Ones: '10倍後の一の位', times10Tenth: '10倍後の十分の一の位',
    times100Tens: '100倍後の十の位', times100Ones: '100倍後の一の位',
    divide10Ones: '10分の1後の一の位', divide10Tenth: '10分の1後の十分の一の位',
    divide100Tenth: '100分の1後の十分の一の位',
    divide100Hundredth: '100分の1後の百分の一の位'
  },
  digitCap: {
    countTenth: { 'こ': 2 }, countHundredth: { 'こ': 3 },
    digitOnes: { '': 1 }, digitTenth: { '': 1 }, digitHundredth: { '': 1 },
    times10Ones: { '': 1 }, times10Tenth: { '': 1 },
    times100Tens: { '': 1 }, times100Ones: { '': 1 },
    divide10Ones: { '': 1 }, divide10Tenth: { '': 1 },
    divide100Tenth: { '': 1 }, divide100Hundredth: { '': 1 }
  },
  fieldsByType: { countTenth: ['こ'], countHundredth: ['こ'] },
  tips: 'いくつ分、位の数字、10倍・100倍とその逆を分けて見ると、つまずきを絞れます。<br>' +
    '初打鍵までの時間だけで理解を決めず、正答率と誤答も合わせて確認してください。',

  /** 百分の一を1とする整数を、末尾の0を保った小数にする。 */
  decimal_: function (n) {
    var whole = Math.floor(n / 100);
    var fraction = String(n % 100);
    if (fraction.length < 2) fraction = '0' + fraction;
    return whole + '.' + fraction;
  },

  /** 十分の一を1とする整数を、小数第1位まで表示する。 */
  tenth_: function (n) {
    return Math.floor(n / 10) + '.' + (n % 10);
  },

  gen: function (rand, mode) {
    var n, type, place, answer, factor;
    if (mode === 1) {
      n = ri_(rand, 10, 99);
      return { t: 'countTenth', q: [this.tenth_(n), 'は', '0.1 が'],
        f: ['こ'], ans: { 'こ': n }, tag: 'tenth:' + n };
    }
    if (mode === 2) {
      n = ri_(rand, 100, 999);
      return { t: 'countHundredth', q: [this.decimal_(n), 'は', '0.01 が'],
        f: ['こ'], ans: { 'こ': n }, tag: 'hundredth:' + n };
    }
    if (mode === 3) {
      n = ri_(rand, 100, 999);
      place = ri_(rand, 0, 2);
      type = ['digitOnes', 'digitTenth', 'digitHundredth'][place];
      answer = [Math.floor(n / 100), Math.floor(n / 10) % 10, n % 10][place];
      return { t: type, q: [this.decimal_(n), 'の',
        ['一の位の数字', '十分の一の位の数字', '百分の一の位の数字'][place]],
        f: [''], ans: { '': answer }, tag: 'digit:' + n + ':' + place };
    }
    if (mode === 4) {
      // 0.ab を10倍／100倍し、移動先の2つの位から一つを問う。
      n = ri_(rand, 10, 99);
      factor = pick_(rand, [10, 100]);
      place = ri_(rand, 0, 1);
      if (factor === 10) {
        type = place === 0 ? 'times10Ones' : 'times10Tenth';
      } else {
        type = place === 0 ? 'times100Tens' : 'times100Ones';
      }
      answer = place === 0 ? Math.floor(n / 10) : n % 10;
      return { t: type, q: [this.decimal_(n), '×', String(factor), 'をした数の',
        factor === 10 ? (place === 0 ? '一の位' : '十分の一の位')
                      : (place === 0 ? '十の位' : '一の位')],
        f: [''], ans: { '': answer }, tag: 'times:' + n + ':' + factor + ':' + place };
    }
    if (mode === 5) {
      // ab を10分の1／100分の1にし、移動先の2つの位から一つを問う。
      n = ri_(rand, 10, 99);
      factor = pick_(rand, [10, 100]);
      place = ri_(rand, 0, 1);
      if (factor === 10) {
        type = place === 0 ? 'divide10Ones' : 'divide10Tenth';
      } else {
        type = place === 0 ? 'divide100Tenth' : 'divide100Hundredth';
      }
      answer = place === 0 ? Math.floor(n / 10) : n % 10;
      return { t: type, q: [String(n), '÷', String(factor), 'をした数の',
        factor === 10 ? (place === 0 ? '一の位' : '十分の一の位')
                      : (place === 0 ? '十分の一の位' : '百分の一の位')],
        f: [''], ans: { '': answer }, tag: 'divide:' + n + ':' + factor + ':' + place };
    }
    throw new Error('小数: モードが不正です');
  }
};

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['decimal'];

// ===== apps/grade3/divmod/Unit.gs =====
/**
 * Unit.gs — あまりのあるわり算（3年）
 *
 * 九九タイムアタックが測るのは「1回の想起の速さ」。
 * こちらが測るのは「あまりを出す手続きが1手で出るか、数え上げているか」。
 * 同じ児童を並べると「わり切れるわり算は速いのに、あまりが出ると遅い」が見える。
 *
 * ③が遅い児童がいても、現行の型だけでは原因が絞れない。
 * 九九の逆が出ないのか、上限つきの探索ができないのか、引き算で止まるのか、
 * 商とあまりの同時表記で落ちるのか——候補が4つあって弁別できない。
 * そこで手続きを分解し、1段階＝1モードにしてある。
 *
 *   ① くくのあな   四□32               九九の となえの 空き（積から、かけた数）
 *   ② 九九さがし   64まで ／ 七□□      こえない最大の九九（かけた数と積）
 *   ③ あといくつ   73−72 → 1           差を出す（あまりの決定）
 *   ④ ひとつなぎ   73÷8＝／八【九】【72】／73−72＝【1】  ②③を同じ数値で通す
 *   ⑤ あってる？   32÷9＝2あまり14      示された式を確かめて正しい答えを書く
 *   ⑥ わり算      32÷9                 あまりのあるわり算
 *
 * ④は2段組みで、1段目を正答するまで2段目を覚っておく。
 * 覚いが無いと「73−72」の72を先に読めてしまい、
 * 九九を探す手続きを飛ばして引き算だけで答えが出る。
 *
 * ①②は九九の唱えの形（「四八32」）で出し、埋める字を欄にしてある。
 * 「4のだん 32」と書くと、段と積を読んでから唱えに翻訳する一手が挟まる。
 * 唱えの形のまま出せば、探すもの（□）と唱えが同じ並びになる。
 * ①は積が示してあり埋めるのは かけた数だけ、②は上限だけが示してあり
 * かけた数と積の両方を埋める。差は「ぴったりの数」か「こえない数」かで、
 * その差がそのまま わり切れる場合とあまりが出る場合の差になる。
 *
 * ②の1行目は「64まで」だけにしてある。「いちばん大きい」は
 * モード名（こえない 九九さがし）と help が持つ。式の場に文を置くと、
 * 大きな字で2行に折り返して、探す対象の「七□□」が画面の下に押される。
 *
 * 混合モードは置いていない。モードは6つまで（児童の数字キー1〜6）で、
 * この6段階で枠が埋まるため。
 */

/**
 * 数字 → 漢数字。④の商の表示と、④の1段目に置く「わる数」の両方で使う。
 * 九九は唱えで覚えるので、「八 九 72」と漢数字で並べると唱え（はちく72）に重なる。
 * 「8 9 72」だと、かけ算の式にも読めて唱えに乗らない。
 */
var DM_KANJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['divmod'] = {
  id: 'divmod',
  grade: 3,                 // 学年（1〜6）。置き場 apps/grade3/ と一致させる（tests/contract が照合する）
  title: 'あまりのあるわり算 タイムアタック！',
  teacherTitle: 'あまりのあるわり算 設定・分析',

  // 「遅い」は秒の閾値ではなく、同じ学年・同じ型の児童の分布と比べる（Core の slowBand_）。
  // 以前は単元で1つの slow_ms を⑤に合わせて持っていたため、①③は赤が出にくかった。

  /** 「あまり」は答えの欄のあいだに出る。q の中にも同じトークンで出す */
  units: { 'あまり': '' },

  /**
   * モードidは据え置いてある。①③を 5・6 にしたのは、既存の log / summary が
   * mode=1〜4 で記録済みで、idを振り直すと過去の行が別モードの記録に混ざるため。
   * 児童が見る番号は表示順（index.html の cardTop が idx+1 を振る）なので、
   * 配列を学習順に並べておけば画面では 1〜5 の連番になる。
   *
   * id=4 の「ぜんぶまぜ」は外した。枠が6つしかなく、分解した5段階で埋まる。
   * 保持の面では混合練習のほうがよい（docs/ADD_UNIT.md 7章）ので、
   * 混ぜたいときは⑤の「むせいげん」を型を絞らずに回す運用で代える。
   */
  modes: [
    { id: 5, name: 'くくの あな', desc: '四□32',
      help: '九九の となえに なるように、□に かずを 入れよう' },

    { id: 1, name: 'こえない 九九さがし', desc: '64まで ／ 七□□',
      needs: { mode: 5, tries: 3 },
      help: 'その かずを こえない、いちばん 大きい 九九。□は かける かずと こたえ' },

    { id: 6, name: 'あと いくつ', desc: '73−72',
      needs: { mode: 1, tries: 3 },
      help: 'ひいた のこりが、そのまま あまりに なる' },

    { id: 7, name: 'ひとつなぎ', desc: '73÷8＝ ／ 八□□ ／ 73−72＝□',
      needs: { mode: 6, tries: 3 },
      help: '上の くくが あったら、したの しきが 見える' },

    { id: 2, name: 'あってる？', desc: '32÷9＝2あまり14',
      needs: { mode: 7, tries: 3 },
      help: '上の しきを たしかめて、正しい こたえを 書こう' },

    { id: 3, name: 'あまりのある わり算', desc: '32÷9',
      needs: { mode: 2, tries: 3 } }
  ],

  /**
   * 分析の軸。段別（2〜9の段）に割らない。
   * 段の想起は九九タイムアタックが既に測っていて、ここで8列作ると二重計測になり、
   * weak_child が読めない幅になる。ここで見たいのは段ではなく手続きの段階。
   *
   * ④を「正しい式」と「誤りの式」に分けてあるのは、
   * 正しい式まで直してしまう過剰修正（あまりを見ずに解き直す子）を切り分けるため。
   */
  types: {
    K:  '①くくのあな',
    P:  '②九九さがし',
    D:  '③あといくつ',
    C:  '④ひとつなぎ',
    Jo: '⑤はんだん(正しい式)',
    Jx: '⑤はんだん(あまりが大)',
    R:  '⑥あまりのあるわり算'
  },

  /**
   * ①③は1打、⑤⑥は2打（商1桁＋あまり1桁）、②は3打（かける数1桁＋積2桁）、
   * ④は4打。モードの中では打鍵数が揃うので、モード内の児童間比較は成立する。
   * 揃わないのは型をまたいだときで、①③と②④⑤⑥を直接くらべてはいけない
   * （docs/ARCHITECTURE.md「自動判定と情報漏れ」。tips にも書いてある）。
   *
   * ①③の答えは必ず1桁。②のかける数は必ず1桁（積を2桁に絞ってあるので
   * かける数は2〜9）、積は必ず2桁なので、宣言と実際の桁数は食い違わない。
   */
  /**
   * 教師が調整する設定。最初のメニューの背景に敷く「成長する図形」（九九と同じ仕組み）。
   * 本番の正答を「標準の分数」（そのモードの1分あたり平均正答で割った値）に直して積み、
   * 無地 → 輪郭 → 学年の色 → 第二の色 と画面全体を覆うたびに次の層へ進む。
   * このサイトはペンローズ（5回対称：太い菱形と細い菱形）。色1＝太い菱形、色2＝細い菱形。
   * 表示だけに効き、出題にも採点にも関わらない。仕様の正本は design リポジトリの growing-figures/
   */
  defaults: {
    floor_on: 1,
    floor_per_answer: 0.75
  },
  settings: [
    { key: 'floor_on', label: 'メニューの背景の図形', type: 'onoff',
      note: '練習を重ねるほど育つ模様。表示しないと無地になる' },
    { key: 'floor_per_answer', label: '1正答あたりの図形の育ち',
      note: '1分に20問解ける速さの問題を1問正解したときに増えるタイルの枚数。解きにくい問題（1分で解ける数が少ない）ほど1問で多く育つ（速さはこのサイトの記録から自動で出す）。0.75 なら、1分20問の速さでおよそ6,000問（約5時間の練習）で全部そろう',
      min: 0.05, max: 10, step: 0.05 }
  ],

  /** 床の図形と第二の色。サイトごとに変える（台帳は design リポジトリの growing-figures/COLORS.md） */
  floorPattern: 'penrose',
  floorColor: 'sapphire',

  /** 育ちの倍率の既定（教師画面の全般設定で変えられる）。単元の仕上げの「あまりのある わり算」をいちばん練習させたいので2倍 */
  growWeights: { 3: 2 },

  digitCap: {
    K:  { 'かける': 1 },
    P:  { 'かける': 1, 'つみ': 2 },
    D:  { '': 1 },
    C:  { 'しょう': 1, 'つみ': 2, 'のこり': 1 },
    Jo: { 'あまり': 1, '': 1 },
    Jx: { 'あまり': 1, '': 1 },
    R:  { 'あまり': 1, '': 1 }
  },

  /**
   * 欄ごとの数字の字形。九九の唱えの位置にある欄だけ、打った数字を漢数字で描く。
   * ①②の「かける」と④の「しょう」がそれで、どちらも唱えの2字目に当たる。
   * 共通画面はこの表の意味を知らず、宣言された欄の数字を引き当てるだけ。
   *
   * 欄キー '' には宣言しないこと。③⑤⑥のあまりの欄が '' なので、
   * 宣言するとあまりまで漢数字になる。
   */
  glyph: { 'かける': DM_KANJI, 'しょう': DM_KANJI },

  /**
   * ④で目立たせる欄。商とあまり＝そのまま「73÷8」の答えになる2つだけを色で示し、
   * 途中の積（つみ）は白のままにする。手続きの断片と答えを見分けるため。
   *
   * 色は 4年の すみれ #8A6CE5（別学年の色をもう1色として使う決まり。Core.gs の GRADE_EXTRA_）。
   * 実測（check-palette.mjs、背景 #101728）：白との ΔE00 は最小 38.4、赤 #FF1A30 とは 41.0、
   * 3年のミントとは 3型で 13.9 に下がるが明るさの比 2.0 が残る。背景とのコントラスト 4.6。
   *
   * 色だけに意味を持たせない。色を宣言した欄は共通画面が下線も太くし、薄く塗るので、
   * 色相が潰れる見え方でも太さと塗りが残る。
   *
   * ①②の欄には宣言しない。この2つは全部の欄が答えで、分ける対象が無い。
   * 分けるもののないところに色を足すと、④の紫（途中の積と最終の答えを分ける）が
   * 何を指しているのか読めなくなる。
   */
  slotColor: { 'しょう': '#8A6CE5', 'のこり': '#8A6CE5' },

  /** 誤答を「3あまり5」の形で出す。欄キーがそのまま後ろに付く */
  fieldsByType: {
    K:  ['かける'],
    P:  ['かける', 'つみ'],
    D:  [''],
    C:  ['しょう', 'つみ', 'のこり'],
    Jo: ['あまり', ''],
    Jx: ['あまり', ''],
    R:  ['あまり', '']
  },

  tips:
    '<b>weak_child</b>：児童ごと・型ごとの平均想起時間(秒)。同じ学年・同じ型の児童の平均より標準偏差1つ分以上遅いと赤。<br>' +
    '測っているのは想起の速さではなく、あまりを出す手続きが1手で出るかどうか。<br>' +
    '⑥までの手続きを①〜④に分解してあるので、⑥が遅い原因をどこか1つに絞れる。<br><br>' +
    '・①が赤 → 九九の逆（積から、かけた数）が出ない。九九タイムアタックの段別を見る<br>' +
    '・①は緑で②が赤 → 逆は出るが、こえない最大をさがす手続きで止まっている<br>' +
    '・③が赤 → 引き算で止まっている。あまりの意味の前に、くり下がりの手当てが要る<br>' +
    '・①②③が緑で⑥が赤 → 部品はあるが、つなげて1手にできていない。④の反復へ<br>' +
    '・④で1段目のまちがいが多い → 部品は出るが、同じ数値で通すところで落ちている<br>' +
    '・⑤が⑥より遅い → 示された答えを確かめられず、一から解き直している<br>' +
    '・Jo（正しい式）だけ誤答が多い → あまりを見ずに直す過剰修正。「たしかめ」の指導へ<br>' +
    '・Jx（あまりが大）だけ誤答が多い → あまり＜わる数 が条件として入っていない<br>' +
    '・ゆらぎが大きい → 想起と数え上げを行き来している。手続きの短縮より想起の練習<br><br>' +
    '<b>型をまたいで秒数をくらべないこと。</b> 打つ数が型ごとに違う' +
    '（①③は1打、⑤⑥は2打、②は3打、④は4打）。差の打鍵ぶんは想起ではない。' +
    'くらべるのは同じ型の中の児童どうし、または同じ児童の同じ型の推移。<br>' +
    '赤は型ごとに学年の分布と比べて付くので、打つ数の違う型どうしでも赤の有無はくらべてよい。<br>' +
    '<b>④の秒数は1段目までしか測っていない。</b> 所要msは提示から最初の打鍵までなので、' +
    '2段目の引き算にかかった時間は入らない。④は連結の練習用で、引き算の速さは③で見る。',

  /**
   * 1問作る。
   *
   * ①の積と②の答えは2桁（10〜81）、③の答えは1桁（1〜8）、
   * ④⑤は商1桁・あまり1〜(わる数-1)、わられる数は2桁（10〜89）に揃えてある。
   *
   * あまり0（わり切れる）を④⑤で出さないのは2つ理由がある。
   * 1つは指導との整合で、3年ではわり切れるとき「あまり0」とは書かない。
   * もう1つは画面の仕様で、index.html は空欄を0として扱い、
   * 全欄が正解と一致した瞬間に自動送信する。あまり0の問題を出すと、
   * 商を打った時点（あまり欄は空＝0）で正解と一致してしまい、
   * あまりを書かせないまま次の問題へ進む。
   *
   * ①はわり切れる場合そのものだが、欄が1つで「あまり」が無いので
   * この事故は起きない。むしろ①と②を並べることで、
   * ぴったり分けられる場合と そうでない場合の差が型として見える。
   */
  gen: function (rand, mode) {
    if (mode === 5) return dmFactor_(rand);
    if (mode === 1) return dmSearch_(rand);
    if (mode === 6) return dmGap_(rand);
    if (mode === 7) return dmChain_(rand);
    if (mode === 2) return dmJudge_(rand);
    if (mode === 3) return dmDivide_(rand);
    // 知らないモードでは落とす。既定を⑤にすると、modes と gen が食い違ったときに
    // 「なぜか全部わり算が出る」という形でしか表に出ず、原因にたどり着けない。
    throw new Error('divmod: 知らないモード ' + mode);
  }
};

/**
 * ①「四□32」＝ 四八32 の となえの 2字目を埋める → 8（欄は漢数字で「八」と出る）。
 *
 * 唱えの形のまま出す。「4のだん　32」だと、段と積を読んでから唱えに翻訳する
 * 一手が挟まり、測っているものに翻訳の時間が乗る。
 * 欄が式の途中に入るので rows を使う（既定の経路は欄を右端にまとめてしまう）。
 * 覆いは要らないので veil は載せない。
 *
 * ②と同じ並び（漢数字の段 → 欄）にしてある。違いは、積が示してあるか
 * 上限だけが示してあるかで、その差が ぴったりの数（わり切れる）と
 * こえない数（あまりが出る）の対比になる。
 *
 * 積を2桁（10〜81）に絞るのは、1桁の積（二一2）が混ざると
 * 同じ型の中で難度が割れるため。答えは必ず1桁なので桁数は漏れない。
 */
function dmFactor_(rand) {
  var a = ri_(rand, 2, 9);                               // だん
  var b = ri_(rand, Math.ceil(10 / a), 9);               // かけた数＝答え（積を2桁に）
  return {
    t: 'K',
    q: [DM_KANJI[a], '□', String(a * b)],                // 記録用。画面は rows で描く
    rows: [[DM_KANJI[a], '_', String(a * b)]],
    f: ['かける'], ans: { 'かける': b },
    tag: 'K' + a + '*' + b
  };
}

/**
 * ②「64まで ／ 七□□」＝ 64 をこえない 七の段の九九のうち いちばん大きいもの
 * → 七九63（欄は「九」と「63」）。
 *
 * ①から変えたのは、埋める字を1つ増やしたところ。
 * 積だけを書かせると、九九の唱えを通さずに「64に近い7の倍数」を
 * 引き算で当てにいく経路が残る。かける数を先に置くと、唱えを通す順になり、
 * 主指標（提示から初打鍵まで）が「何をかけるか」の決定時刻を指す。
 * これは④の1段目（八□□）と同じ形で、②が④の部品であることが見た目で伝わる。
 *
 * 1行目は「64まで」だけ。「いちばん大きい」はモード名と help が持つ
 * （式の場は字が大きく、文を置くと折り返して問題本体が下へ押される）。
 *
 * 基準数は必ず「その段の倍数ではない数」にする（dmFit_ の あまりが1以上）。
 * 倍数を出すと、教科書の「64より小さい」と手続き上の「64以下」で答えが割れ、
 * 同じ問題文が2通りに読めてしまう。
 */
function dmSearch_(rand) {
  var x = dmFit_(rand);
  return {
    t: 'P',
    q: [String(x.n), 'まで', DM_KANJI[x.a], '□', '□'],   // 記録用。画面は rows で描く
    rows: [
      [String(x.n), 'まで'],
      [DM_KANJI[x.a], '_', '_']
    ],
    f: ['かける', 'つみ'], ans: { 'かける': x.b, 'つみ': x.p },
    tag: x.n + '<' + x.a
  };
}

/**
 * ④「73÷8＝ ／ 八 □ □ ／ 73−72＝□」＝ 商・積・あまりを、同じ数値のまま順に通す。
 *
 * 0段目は解いている式そのもの。欄が無いので覆いはかからず、最後まで出したままにする。
 * 何の問題を解いているかが見えていないと、下の2段が手続きの断片にしか見えない。
 * 1段目は九九の唱え。わる数（八）は出してあり、児童が埋めるのは
 * かけた数（九＝商）と答え（72＝積）。商だけ漢数字で出るのは glyph の宣言による。
 * 2段目は覆いの下にあり、1段目を両方とも正解するまで見えない（veil: 2）。
 *
 * 覆いが要るのは、2段目に「73−72」と書いてあるため。
 * 先に読めてしまうと、九九を探す手続きを飛ばして引き算だけで答えが出る。
 * ②と③を別々に通せる児童が、つなげて通せるかを見るのがこの型の目的なので、
 * 順番を飛ばせる状態にすると測るものが変わる。
 *
 * 値域は②と同じ dmFit_。積を2桁に揃えてあるので、
 * 「つみ」の欄は常に2桁で、宣言した桁数と食い違わない。
 */
function dmChain_(rand) {
  var x = dmFit_(rand);
  return {
    t: 'C',
    q: [String(x.n), '÷', String(x.a)],
    rows: [
      [String(x.n), '÷', String(x.a), '='],
      [DM_KANJI[x.a], '_', '_'],
      [String(x.n), '-', String(x.p), '=', '_']
    ],
    veil: 2,
    f: ['しょう', 'つみ', 'のこり'],
    ans: { 'しょう': x.b, 'つみ': x.p, 'のこり': x.r },
    tag: 'C' + x.n + '/' + x.a
  };
}

/**
 * ②④が共有する値域。わる数 2〜9、積は2桁（10〜81）、
 * あまり 1〜(わる数−1)、わられる数 11〜89。
 *
 * 基準数は必ず「その段の倍数ではない数」になる（あまりが1以上だから）。
 * 倍数を出すと、教科書の「29より小さい」と手続き上の「29以下」で答えが割れ、
 * 同じ問題文が2通りに読めてしまう。
 *
 * 積を2桁に絞ってあるので、商は必ず1桁になる（積が2桁になる最小の
 * かける数が2以上のため）。④の桁数の宣言はこれに依っている。
 */
function dmFit_(rand) {
  var a = ri_(rand, 2, 9);
  var b = ri_(rand, Math.ceil(10 / a), 9);
  var r = ri_(rand, 1, a - 1);
  return { a: a, b: b, r: r, p: a * b, n: a * b + r };
}

/**
 * ③「73−72」＝ 1。②で見つけた積を引いて、あまりを出す段階。
 *
 * ただの2桁−2桁ではなく、④⑤に実際に出てくる組だけを引く。
 * 引かれる数は わられる数、引く数は その段の こえない最大の積で、
 * 差は必ず 1〜(わる数−1)＝1〜8 になる。くり下がりのある組（42−35）も
 * そのまま出る。ここで止まる児童は、あまりの意味以前に引き算で止まっている。
 */
function dmGap_(rand) {
  var x = dmParts_(rand);
  return {
    t: 'D',
    q: [String(x.n), '-', String(x.a * x.b)],
    f: [''], ans: { '': x.r },
    tag: x.n + '-' + (x.a * x.b)
  };
}

/**
 * ④示された式を確かめて、正しい商とあまりを書く。
 *
 * ○×の2択にしていない。スコアは正答数だけで誤答に減点が無く、
 * miss_limit 回まちがえると正答が出る作りなので、2択は連打が最適戦略になり、
 * 順位と weak_child の想起時間が同時に壊れる。
 *
 * 誤りは「商が1小さく、あまりが わる数だけ大きい」の1種類だけ。
 * 商を1大きくするとあまりが負になるので、3年の範囲で作れる誤りはこの向きしかない。
 * 正しい式を3問に1問まぜ、「いつも直せばよい」戦略を潰す。
 */
function dmJudge_(rand) {
  var x = dmParts_(rand);
  var ok = (ri_(rand, 1, 3) === 1);
  var sb = ok ? x.b : x.b - 1;                           // 示された商
  var sr = ok ? x.r : x.r + x.a;                         // 示されたあまり
  return {
    t: ok ? 'Jo' : 'Jx',
    q: [String(x.n), '÷', String(x.a), '=', String(sb), 'あまり', String(sr)],
    f: ['あまり', ''], ans: { 'あまり': x.b, '': x.r },
    tag: x.n + '/' + x.a + '>' + sb + 'a' + sr
  };
}

/** ⑤あまりのあるわり算 */
function dmDivide_(rand) {
  var x = dmParts_(rand);
  return {
    t: 'R',
    q: [String(x.n), '÷', String(x.a)],
    f: ['あまり', ''], ans: { 'あまり': x.b, '': x.r },
    tag: x.n + '/' + x.a
  };
}

/**
 * ③④⑤が共有する値域。わる数 2〜9、商 2〜9、あまり 1〜(わる数-1)、
 * わられる数は2桁（10〜89）。
 * 商が2以上なのは、④の誤り式（商を1小さくする）が作れるようにするため。
 */
function dmParts_(rand) {
  var a = ri_(rand, 2, 9);
  var r = ri_(rand, 1, a - 1);
  var b = ri_(rand, Math.max(2, Math.ceil((10 - r) / a)), 9);
  return { a: a, b: b, r: r, n: a * b + r };
}

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['divmod'];

// ===== apps/special/factor/Unit.gs =====
/** 素因数分解。学年に属さない特殊枠。出題・再採点の正本。 */
// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['factor'] = {
  id: 'factor', category: 'special', grade: null,
  title: '素因数分解タイムアタック！',
  // 児童メニューのタイトルのふりがな。[漢字, 読み] か、読みの要らない文字列を並べる（つなぐと title と同じ文字列になる）
  titleRuby: [['素','そ'],['因','いん'],['数','すう'],['分','ぶん'],['解','かい'],'タイムアタック！'], teacherTitle: '素因数分解 設定・分析',
  units: {}, answerOrder: 'unordered',
  interaction: { kind: 'prime-division', keys: factorPrimes_(179) },   // 既定。今は全モードが keys を持つ（そのモードに出る素数の上限までのキーだけ出す）
  modes: [
    { id: 1, name: '16まで', desc: '4〜16の合成数', diagram: true, keys: factorPrimes_(7) },
    { id: 2, name: '九九まで', desc: '九九に現れる合成数', diagram: true, keys: factorPrimes_(7) },
    { id: 3, name: '360まで(素数〜13)', desc: '360までの合成数で、素因数が2・3・5・7・11・13だけのもの', diagram: true, keys: factorPrimes_(13) },
    { id: 4, name: '360まで(素数〜97)', desc: '360までの合成数で、最大の素因数が97以下のもの', diagram: true, keys: factorPrimes_(97) },
    // 画面では5・6番目。id 5・6 は旧「図なし」の記録をそのまま引き継ぐために図なし側へ回したので、7・8にする。
    // 1024＝2の10乗は、このモードで最も長い分解（因数10個）
    { id: 7, name: '1024まで(素数〜13)', desc: '1024までの合成数で、素因数が2・3・5・7・11・13だけのもの', diagram: true, keys: factorPrimes_(13) },
    { id: 8, name: '1024まで(素数〜97)', desc: '1024までの合成数で、最大の素因数が97以下のもの', diagram: true, keys: factorPrimes_(97) },
    // 図なし。pair のモードと同じ出題範囲・同じ公開設定で、記録だけ分ける。メニューでは左下の切り替えで出す。
    // 5・6 は旧モード5「九九まで（図なし）」・旧モード6「360まで（図なし）」の id。既存の記録をそのまま使う
    { id: 11, name: '16まで（図なし）', desc: 'モード1と同じ出題範囲', diagram: false, pair: 1, keys: factorPrimes_(7) },
    { id: 5, name: '九九まで（図なし）', desc: 'モード2と同じ出題範囲', diagram: false, pair: 2, keys: factorPrimes_(7) },
    { id: 13, name: '360まで(素数〜13)（図なし）', desc: 'モード3と同じ出題範囲', diagram: false, pair: 3, keys: factorPrimes_(13) },
    { id: 6, name: '360まで(素数〜97)（図なし）', desc: 'モード4と同じ出題範囲', diagram: false, pair: 4, keys: factorPrimes_(97) },
    { id: 17, name: '1024まで(素数〜13)（図なし）', desc: 'モード7と同じ出題範囲', diagram: false, pair: 7, keys: factorPrimes_(13) },
    { id: 18, name: '1024まで(素数〜97)（図なし）', desc: 'モード8と同じ出題範囲', diagram: false, pair: 8, keys: factorPrimes_(97) }
  ],
  // 正答回数による段階解放の閾値（画面の番号 2〜6）。教師画面のクラス設定で「段階解放」を入れたクラスだけに効く。
  // 図なしは相方の閾値に従う
  nUnlock: { 2: 20, 3: 40, 4: 80, 7: 160, 8: 320 },
  // 図なしは図形の育ちを3倍にする（倍率の上限。教師画面の全般設定で変えられる）
  growWeights: { 11: 3, 5: 3, 13: 3, 6: 3, 17: 3, 18: 3 },
  types: factorTypes_(),
  digitCap: factorCaps_(),
  // メニューの背景の床は使わない（menuFigure の「正答回数の図」に置き換え）。床の表示・育ちの設定欄は置かない
  defaults: {},
  settings: [],
  floorPattern: 'factor720', floorColor: 'amethyst',
  /** メニューの背景の図形の代わりに、モードの左へ「正答回数の数の図」（素因数で入れ子にした円）を出す。
   *  正答回数＝モードごとの本番の正答 × 育ちの倍率（小数点以下切り捨て）の合計。10000で止める */
  menuFigure: 'factor',
  tips: '図あり・図なしは別モード（5・6・11・13・17・18が図なし。5・6は旧「図なし」の記録を引き継ぐ）で記録します。公開は図ありのモードの設定に従います。初打鍵は最初の素数を選ぶまでの時間で、分解全体の想起時間ではありません。完成時間には素数キーの選択・縦スクロール・複数回の入力が含まれます。型は素因数の個数（重複を含む）です。',
  fmtAnswer: function (type, vals) { return vals.filter(function(v){ return Number(v) > 0; }).join(' × '); },
  gen: function (rand, mode) {
    var pool = factorPool_(mode);
    return factorItem_(pool[Math.floor(rand() * pool.length)], mode);
  },
  // 同じ問題は一巡するまで再出題しない。rand は署名されたシード由来。
  queue: function (rand, mode, count) {
    var out = [], last = 0;
    while (out.length < count) {
      var bag = factorPool_(mode).slice();
      for (var i = bag.length - 1; i > 0; i--) {
        var j = Math.floor(rand() * (i + 1)), v = bag[i]; bag[i] = bag[j]; bag[j] = v;
      }
      if (bag[0] === last) { var t = bag[0]; bag[0] = bag[1]; bag[1] = t; }
      for (var k = 0; k < bag.length && out.length < count; k++) out.push(factorItem_(bag[k], mode));
      last = bag[bag.length - 1];
    }
    return out;
  }
};
// UNIT の宣言より前に評価されるよう、変数ではなく関数で持つ
function factorModes_() { return [1, 2, 3, 4, 7, 8, 11, 5, 13, 6, 17, 18]; }
/** 図なしのモードを、出題範囲の元になる図ありのモードに写す */
function factorBase_(mode) { return { 11: 1, 5: 2, 13: 3, 6: 4, 17: 7, 18: 8 }[mode] || Number(mode); }
function factorPrimes_(max) {
  var out = [];
  for (var n = 2; n <= max; n++) {
    var ok = true;
    for (var d = 2; d * d <= n; d++) if (n % d === 0) { ok = false; break; }
    if (ok) out.push(n);
  }
  return out;
}
function factorParts_(n) {
  var out = [];
  for (var p = 2; p * p <= n; p++) while (n % p === 0) { out.push(p); n /= p; }
  if (n > 1) out.push(n);
  return out;
}
function factorPool_(mode) {
  var base = factorBase_(mode);
  var max = {1:16, 2:81, 3:360, 4:360, 7:1024, 8:1024}[base], maxP = {3:13, 4:97, 7:13, 8:97}[base] || 0;
  if (!max) throw new Error('不正なモード');
  var out = [], kuku = base === 2;
  for (var n = 4; n <= max; n++) {
    var parts = factorParts_(n);
    if (parts.length < 2) continue;
    if (maxP && parts[parts.length - 1] > maxP) continue;   // 大きな素数を因数に持つ数は出さない
    if (kuku) {
      var inTable = false;
      for (var a = 1; a <= 9; a++) if (n % a === 0 && n / a <= 9) { inTable = true; break; }
      if (!inTable) continue;
    }
    out.push(n);
  }
  return out;
}
function factorItem_(n, mode) {
  var parts = factorParts_(n), f = [], ans = {};
  parts.forEach(function(p, i){ var key = 'p' + i; f.push(key); ans[key] = p; });
  return { t: 'm' + mode + 'p' + Math.min(6, parts.length), q: [String(n)], f: f, ans: ans, tag: String(n) };
}
function factorCaps_() {
  var out = {};
  factorModes_().forEach(function (m) { out[m] = {}; for (var i = 0; i < 10; i++) out[m]['p' + i] = 3; });
  return out;
}

function factorTypes_() {
  var out = {}, names = { 1: '16まで', 2: '九九まで', 3: '360まで(素数〜13)', 4: '360まで(素数〜97)', 7: '1024まで(素数〜13)', 8: '1024まで(素数〜97)' };
  // 実際に出題される型だけを宣言する（出ない型を宣言すると教師画面に「宣言だけ残っている」注意が出る）
  factorModes_().forEach(function (m) { factorPool_(m).forEach(function(n){ var p=Math.min(6,factorParts_(n).length); var b=factorBase_(m); out['m'+m+'p'+p]=names[b]+(b!==m?'（図なし）':'')+'・'+p+(p===6?'個以上':'個')+'の素因数'; }); });
  return out;
}

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['factor'];

// ===== apps/grade2/hiku/Unit.gs =====
/**
 * ひきざん あんざんTA。中身は2けたの筆算で、画面も筆算の形に並べる。
 * 児童には暗算の練習として出す。答えは一の位から打つ（f の順＝打つ順。画面の並びは rows の '_0' '_1'）。
 *
 * 頭の中で位ごとに引くやり方は、くり下がりで「大きい数から小さい数を引く」誤り（52−37=25）を
 * 生みやすいと報告されている（Beishuizen 1993, JRME 24(4)）。誤答明細でこの形が出ていないかを見る。
 */
// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['hiku'] = {
  id: 'hiku',
  grade: 2,                 // 学習指導要領 2年 A(2) 2位数の加法の逆の減法。置き場 apps/grade2/ と一致させる
  title: '暗算(ひき算) タイムアタック！',
  teacherTitle: '暗算(ひき算) 設定・分析',

  /**
   * 教師が調整する設定。最初のメニューの背景に敷く「成長する図形」。このサイトはくり下がりの三角（三角のマスごとに m−j の筆算。くり下がるマスが第二の色）。
   * 本番の正答を「標準の分数」に直して積み、無地 → 輪郭 → 学年の色 → 第二の色 と育つ。表示だけで、出題にも採点にも関わらない。
   */
  defaults: { limit_sec: 60, floor_on: 1, floor_per_answer: 0.75 },
  settings: [
    { key: 'floor_on', label: 'メニューの背景の図形', type: 'onoff',
      note: '正答を重ねるほど育つ模様。表示しないと無地になる' },
    { key: 'floor_per_answer', label: '1正答あたりの図形の育ち',
      note: '1分に20問解ける速さの問題を1問正解したときに増えるタイルの枚数。解きにくい問題（1分で解ける数が少ない）ほど1問で多く育つ（速さはこのサイトの記録から自動で出す）',
      min: 0.05, max: 10, step: 0.05 }
  ],
  /** 床の図形と第二の色（台帳は design リポジトリの growing-figures/COLORS.md） */
  floorPattern: 'borrow',
  floorColor: 'garnet',

  // 筆算の形の答えを、右（一の位）から打つか左から打つか、児童がすうじキーせっていで選べる（index.html の COLDIR）
  colDir: true,
  units: {},
  modes: [
    { id: 1, name: '1けたの くりさがり', desc: '16−9' },
    { id: 2, name: 'くりさがり なし', desc: '87−52（筆算の形）',
      needs: { mode: 1, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true },
    { id: 3, name: 'くりさがり', desc: '52−37',
      needs: { mode: 2, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true },
    { id: 4, name: 'こたえが 1けた・0の ある かず', desc: '52−47 ／ 60−24',
      needs: { mode: 3, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true },
    { id: 5, name: 'ぜんぶ いり', desc: '1〜4 を同じ割合で',
      needs: { mode: 4, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true }
  ],
  types: { K: '1けた くりさがり', D: 'くりさがりなし', E: 'くりさがり', F: 'こたえ1けた・0のある数' },

  // 1けたは答えが必ず1けた（1〜9）。2けたは十・一の欄が毎回2つ
  digitCap: { K: { '': 1 }, D: { '一': 1, '十': 1 }, E: { '一': 1, '十': 1 }, F: { '一': 1, '十': 1 } },

  tips: '型Eと型Fの誤答を見てください。52−38 なら、「大きい数から小さい数を引く」は 26、' +
    '「くりさがりを忘れる（十の位を1へらさない）」は 24 になります（正しくは 14）。<br>' +
    '型K（1けた）が遅い児童は、2けたより先に1けたを練習させてください。<br>' +
    '初打鍵までの時間は「一の位を出すまで」の時間です。',

  fmtAnswer: function (type, vals) {
    if (type === 'K') return vals.join('');
    return String(Number(vals[1] || 0) * 10 + Number(vals[0] || 0));
  },

  gen: function (rand, mode) {
    var t = mode === 5 ? pick_(rand, ['K', 'D', 'E', 'F']) : ['', 'K', 'D', 'E', 'F'][mode];
    if (!t) throw new Error('ひきざん: モードが不正です');
    if (t === 'K') {          // 10〜18 − 1けた で、一の位からは引けないもの
      var x = ri_(rand, 0, 8), y = ri_(rand, x + 1, 9);
      return { t: 'K', q: [String(10 + x), '-', String(y)], f: [''], ans: { '': 10 + x - y }, tag: 'K' + (10 + x) + '-' + y };
    }
    var a1, a0, b1, b0;
    if (t === 'D') {          // 一の位はそのまま引ける。十の位は ひく数より大きい（答えは2けた）
      a0 = ri_(rand, 0, 9); b0 = ri_(rand, 0, a0);
      a1 = ri_(rand, 2, 9); b1 = ri_(rand, 1, a1 - 1);
    } else if (t === 'E') {   // くりさがり。ひかれる数の一の位は0でなく、答えは2けた
      a0 = ri_(rand, 1, 8); b0 = ri_(rand, a0 + 1, 9);
      a1 = ri_(rand, 3, 9); b1 = ri_(rand, 1, a1 - 2);
    } else if (rand() < 0.5) { // F：答えが1けた（52−47 ／ 58−52）
      a1 = ri_(rand, 2, 9);
      if (rand() < 0.5) { a0 = ri_(rand, 0, 8); b0 = ri_(rand, a0 + 1, 9); b1 = a1 - 1; }
      else { a0 = ri_(rand, 1, 9); b0 = ri_(rand, 0, a0 - 1); b1 = a1; }
    } else {                  // F：ひかれる数の一の位が0（60−24）。答えは2けた
      a0 = 0; b0 = ri_(rand, 1, 9);
      a1 = ri_(rand, 3, 9); b1 = ri_(rand, 1, a1 - 2);
    }
    var a = a1 * 10 + a0, b = b1 * 10 + b0, d = a - b;
    return {
      t: t, q: [String(a), '-', String(b)],
      rows: [['', String(a1), String(a0)], ['-', String(b1), String(b0)], ['', '_1', '_0']],
      col: true,
      f: ['一', '十'], ans: { '一': d % 10, '十': Math.floor(d / 10) },
      tag: t + a + '-' + b
    };
  }
};

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['hiku'];

// ===== apps/grade3/kakehissan/Unit.gs =====
/**
 * かけ算の筆算(1けた) タイムアタック。3年「1けたをかけるかけ算の筆算」（11時間）。
 * (何十・何百)×(1位数)、(2位数)×(1位数)、(3位数)×(1位数) を筆算の形に並べて出す。
 *
 * 答えは筆算と同じく一の位から打つ（f の順＝打つ順。画面の並びは rows の '_0' '_1' … が決める）。
 * colDir: true なので、児童が「すうじキーせってい」で左から打つ（ふつうの数の順）にも切り替えられる。
 *
 * 欄の数は型で固定する（2けた×1けた は百・十・一の3欄、3けた×1けた と 何百×1けた は千・百・十・一の4欄）。
 * 実際の答えの桁数で欄を減らすと、欄の数が答えの大きさのヒントになる（docs/ADD_UNIT.md 3章）。
 * 上の位が 0 の欄は空けたまま「こたえあわせ」でよい（空欄は 0 とみなす。Core の match_）。
 */
// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['kakehissan'] = {
  id: 'kakehissan',
  grade: 3,                 // 学習指導要領 3年 A(3) 2位数や3位数に1位数をかける乗法。置き場 apps/grade3/ と一致させる
  title: 'かけ算の筆算(1けた) タイムアタック！',
  teacherTitle: 'かけ算の筆算(1けた) 設定・分析',

  defaults: { limit_sec: 60, floor_on: 1, floor_per_answer: 0.75 },
  settings: [
    { key: 'floor_on', label: 'メニューの背景の図形', type: 'onoff',
      note: '正答を重ねるほど育つ模様。表示しないと無地になる' },
    { key: 'floor_per_answer', label: '1正答あたりの図形の育ち',
      note: '1分に20問解ける速さの問題を1問正解したときに増えるタイルの枚数。解きにくい問題（1分で解ける数が少ない）ほど1問で多く育つ（速さはこのサイトの記録から自動で出す）',
      min: 0.05, max: 10, step: 0.05 }
  ],
  /** 床の図形と第二の色（台帳は design リポジトリの growing-figures/COLORS.md。3年の他サイトと図形を変える） */
  floorPattern: 'kake1',   // かけ算の渦（1けた・腕1本）。2けたをかけるサイトは kake2（腕2本）で一組
  floorColor: 'amethyst',

  // 筆算の形の答えを、右（一の位）から打つか左から打つか、児童がすうじキーせっていで選べる（index.html の COLDIR）
  colDir: true,
  units: {},
  modes: [
    { id: 1, name: 'なんじゅう・なんびゃく', desc: '20×3 ／ 300×4（第1時。筆算でなく ふつうの式）',
      help: 'うったら こたえあわせ', enterKey: true },
    { id: 2, name: '2けた くりあがり なし', desc: '12×4（第2・3時）',
      needs: { mode: 1, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true },
    { id: 3, name: '2けた くりあがり', desc: '24×3 ／ 32×4 ／ 43×6（第4〜6時）',
      needs: { mode: 2, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true },
    { id: 4, name: '3けた', desc: '212×3 ／ 387×4 ／ 406×7（第8・9時）',
      needs: { mode: 3, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true },
    { id: 5, name: 'ぜんぶ いり', desc: '1〜4 を同じ割合で',
      needs: { mode: 4, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true }
  ],
  types: {
    N: '何十×1けた', M: '何百×1けた',
    A: '2けた くりあがりなし', B: '一の位から くりあがり', C: '百の位へ くりあがり', D: 'くりあがり2回',
    E: '3けた くりあがりなし', F: '3けた くりあがり', G: '3けた 空位（十の位が0）'
  },

  // 欄は各1けた。欄の数は型で決まり、答えの大きさでは変わらない
  digitCap: {
    N: { '': 3 },                     // 何十×1けた はふつうの式。答えは最大 90×9=810 の3けた
    A: { '一': 1, '十': 1, '百': 1 }, B: { '一': 1, '十': 1, '百': 1 },
    C: { '一': 1, '十': 1, '百': 1 }, D: { '一': 1, '十': 1, '百': 1 },
    M: { '': 4 },                     // 何百×1けた。最大 900×9=8100 の4けた
    E: { '一': 1, '十': 1, '百': 1, '千': 1 }, F: { '一': 1, '十': 1, '百': 1, '千': 1 },
    G: { '一': 1, '十': 1, '百': 1, '千': 1 }
  },

  tips: '型B〜D・F・Gの誤答を見てください。24×3 なら、「くりあがりを たし忘れる」は 62、' +
    '「くりあがりの数を先に たしてから かける」（(2+1)×3）は 92 になります（正しくは 72）。<br>' +
    '406×7 で 322 は「空位の0を飛ばして 46×7 と計算した」誤りです（指導書は 282 も誤答例に挙げています）。<br>' +
    '型N・Mが遅い児童は九九の想起から遅い可能性があります。九九TAの記録と合わせて見てください。<br>' +
    '初打鍵までの時間は、右から打つ設定では「一の位を出すまで」、左から打つ設定では「いちばん上の位を出すまで」の時間です（同じ児童でも設定で意味が変わります）。',

  // 誤答明細は欄の順（一/十/百/千）で届く。教師には普通の数で見せる
  fmtAnswer: function (type, vals) {
    if (type === 'N' || type === 'M') return vals.join('');
    var s = 0;
    for (var i = vals.length - 1; i >= 0; i--) s = s * 10 + Number(vals[i] || 0);
    return String(s);
  },

  gen: function (rand, mode) {
    var pools = { 1: ['N', 'M'], 2: ['A'], 3: ['B', 'C', 'D'], 4: ['E', 'F', 'G'] };
    var t;
    if (mode === 5) {
      // モード1〜4を同じ割合で選び、その中で型を選ぶ
      t = pick_(rand, pools[pick_(rand, [1, 2, 3, 4])]);
    } else if (pools[mode]) {
      t = pick_(rand, pools[mode]);
    } else {
      throw new Error('かけ算の筆算: モードが不正です');
    }

    var b = ri_(rand, 2, 9), d;   // d：かけられる数の位（d[0]=一の位）
    if (t === 'N') d = [0, ri_(rand, 1, 9)];
    else if (t === 'M') d = [0, 0, ri_(rand, 1, 9)];
    else {
      // 条件を満たすまで引き直す（どの型も満たす組が多く、数回で当たる）
      for (var guard = 0; guard < 500; guard++) {
        b = ri_(rand, 2, 9);
        if (t === 'A' || t === 'B' || t === 'C' || t === 'D') d = [ri_(rand, 1, 9), ri_(rand, 1, 9)];
        else if (t === 'G') d = [ri_(rand, 1, 9), 0, ri_(rand, 1, 9)];
        else d = [ri_(rand, 1, 9), ri_(rand, 1, 9), ri_(rand, 1, 9)];
        if (kakeKind_(d, b) === t) break;
      }
      if (kakeKind_(d, b) !== t) throw new Error('かけ算の筆算: 型 ' + t + ' の問題が作れません');
    }

    if (t === 'N' || t === 'M') {
      // 第1時は「10や100のいくつ分」で九九に帰着させる。筆算の形にせず、ふつうの式で出す
      var a0 = d[d.length - 1] * Math.pow(10, d.length - 1);
      return { t: t, q: [String(a0), '×', String(b)], f: [''], ans: { '': a0 * b }, tag: t + a0 + 'x' + b };
    }
    var a = 0;
    for (var i = d.length - 1; i >= 0; i--) a = a * 10 + d[i];
    var p = a * b;
    var n = (t === 'N' || t === 'A' || t === 'B' || t === 'C' || t === 'D') ? 3 : 4;   // 答えの欄の数
    var keys = ['一', '十', '百', '千'].slice(0, n), ans = {};
    keys.forEach(function (k, j) { ans[k] = Math.floor(p / Math.pow(10, j)) % 10; });

    // 升目は左から [演算子, (千,) 百, 十, 一]。かけられる数・かける数・答えを位でそろえる
    var row1 = [''], row2 = ['×'], row3 = [''];
    for (var c = n - 1; c >= 0; c--) {
      row1.push(c < d.length ? String(d[c]) : '');
      row2.push(c === 0 ? String(b) : '');
      row3.push('_' + c);
    }
    return {
      t: t, q: [String(a), '×', String(b)],
      rows: [row1, row2, row3],
      col: true,
      f: keys, ans: ans,
      tag: t + a + 'x' + b
    };
  }
};

/** かけられる数の位 d（一の位から）とかける数 b から、型を決める（gen の棄却法と検査で使う） */
function kakeKind_(d, b) {
  var c = 0, carries = [];
  for (var i = 0; i < d.length; i++) {
    var v = d[i] * b + c;
    carries.push(v >= 10);
    c = Math.floor(v / 10);
  }
  var any = carries.some(function (x) { return x; });
  if (d.length === 2) {
    if (!carries[0] && !carries[1]) return 'A';
    if (carries[0] && !carries[1]) return 'B';
    if (!carries[0] && carries[1]) return 'C';
    return 'D';
  }
  if (d[1] === 0) return any ? 'G' : 'E0';   // 空位でくりあがり無しは出さない
  return any ? 'F' : 'E';
}

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['kakehissan'];

// ===== apps/grade3/kuku/Unit.gs =====
/**
 * Unit.gs — 九九・わり算
 *
 * Core.gs が期待する形に合わせるだけ。共通の仕組みには触れない。
 */

// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['kuku'] = {
  id: 'kuku',
  grade: 3,                 // 学年（1〜6）。置き場 apps/grade3/ と一致させる（tests/contract が照合する）
  title: '九九表タイムアタック！',
  teacherTitle: '九九トレーニング 設定・分析',

  /** 答えが整数1つなので単位は出ない */
  units: {},

  /** どのモードを児童に見せるかは、教師がクラスごとに指定する（class_config） */
  modes: [
    { id: 1, name: 'かけ算 9×9',  desc: '2×6 のような九九' },
    { id: 2, name: 'かけ算 9×16', desc: '9×14 まで広げる' },
    { id: 3, name: 'わり算 9×9',  desc: '48÷6 のようなわり切れるわり算' },
    { id: 4, name: 'わり算 9×16', desc: '126÷9 まで広げる' }
  ],

  /** 分析の軸。段ごとに見る */
  types: {
    x1: '1の段', x2: '2の段', x3: '3の段', x4: '4の段', x5: '5の段',
    x6: '6の段', x7: '7の段', x8: '8の段', x9: '9の段'
  },

  tips:
    '<b>weak_child</b>：児童ごと・段ごとの平均想起時間(秒)。同じ学年の児童の平均より標準偏差1つ分以上遅いと赤。<br>' +
    '九九は既習なので正答率では差が出ない。差が出るのは想起の速さ。<br><br>' +
    '・同じ段がかけ算・わり算の両方で赤 → 想起そのものが未定着<br>' +
    '・わり算だけ赤 → 逆算への変換が課題<br>' +
    '・全段が均等に赤 → 打鍵速度か閾値設定を疑う（下の桁数差は補正済み）<br>' +
    '・誤答計だけ突出 → 当てずっぽう連打を疑い、log の ms を確認',

  /**
   * 自動確定に使う桁数（欄キーは '' 固定）。
   * モードごとに答えが取りうる最大桁数を宣言する。この問題の答え(ans)は
   * 一切参照しない — 参照すると「早く確定する／しない」が桁数のヒントになる
   * （docs/ARCHITECTURE.md「自動判定と情報漏れ」参照）。
   *
   * 積は1〜144と桁数が問題ごとにバラつくため、以前は答えの桁数をそのまま
   * 見て確定させていた。1桁の答え（1×1〜9×9の28%）は1打で確定し、
   * 2〜3桁の答えは2〜3打かかる。これは「その段の想起が遅い」のではなく
   * 「積が大きい段は入力に打鍵が余計にかかる」だけの差で、
   * 主指標である所要msに段ごとの下駄を履かせていた。
   * 宣言する桁数を「そのモードの最大値」に固定し、全問題を同じ確定タイミング
   * で揃えることでこの下駄を消す。
   *   モード1 かけ算9×9：積は最大81 → 2桁
   *   モード2 かけ算9×16：積は最大144 → 3桁
   *   モード3 わり算9×9：商は割る数と同じ1〜9 → 常に1桁（構造的に均一）
   *   モード4 わり算9×16：商は1〜16 → 2桁
   */
  /**
   * 教師が調整する設定。最初のメニューの背景に敷く「成長する図形」。このサイトは八角の星（8回対称：正方形と45°の菱形）。色1＝正方形、色2＝菱形。
   * 本番の正答を「標準の分数」（そのモードの1分あたり平均正答で割った値）に直して積み、無地 → 輪郭 → 学年の色 → 第二の色 と
   * 画面全体を覆うたびに次の層へ進む。表示だけに効き、出題にも採点にも関わらない。
   */
  defaults: {
    floor_on: 1,
    floor_per_answer: 0.75
  },
  settings: [
    { key: 'floor_on', label: 'メニューの背景の図形', type: 'onoff',
      note: '正答を重ねるほど育つ模様。表示しないと無地になる' },
    { key: 'floor_per_answer', label: '1正答あたりの図形の育ち',
      note: '1分に20問解ける速さの問題を1問正解したときに増えるタイルの枚数。解きにくい問題（1分で解ける数が少ない）ほど1問で多く育つ（速さはこのサイトの記録から自動で出す）。0.75 なら、1分20問の速さでおよそ6,000問（約5時間の練習）で全部そろう',
      min: 0.05, max: 10, step: 0.05 }
  ],

  /** 床の第二の色。サイトごとに変える（台帳は design リポジトリの growing-figures/COLORS.md） */
  floorPattern: 'octagon',
  floorColor: 'amethyst',

  digitCap: {
    1: { '': 2 },
    2: { '': 3 },
    3: { '': 1 },
    4: { '': 2 }
  },

  /** 1問作る。答えは整数1つなので欄は1つ、単位ラベルは空 */
  gen: function (rand, mode) {
    var maxB = (mode === 2 || mode === 4) ? 16 : 9;
    var div  = (mode >= 3);
    var a = ri_(rand, 1, 9);
    var b = ri_(rand, 1, maxB);
    if (div) {
      return { t: 'x' + a, q: [String(a * b), '÷', String(a)],
               f: [''], ans: { '': b }, tag: (a * b) + '/' + a };
    }
    return { t: 'x' + a, q: [String(a), '×', String(b)],
             f: [''], ans: { '': a * b }, tag: a + 'x' + b };
  }
};

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['kuku'];

// ===== apps/grade3/length/Unit.gs =====
/**
 * Unit.gs — 長さのたんい（km と m、まきじゃく）
 * 3年「長さ」第1〜3時に対応する。
 */

// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['length'] = {
  id: 'length',
  grade: 3,                 // 学年（1〜6）。置き場 apps/grade3/ と一致させる（tests/contract が照合する）
  title: '長さのたんい タイムアタック！',
  teacherTitle: '長さのたんい 設定・分析',

  defaults: {
    // まきじゃくの見た目。表示だけで、出題（span・at の値域）には触らない。
    // 教室のプロジェクタや端末の画面サイズに合わせて担任が調整するための値。
    ruler_width:  100,   // 画面幅に対する横幅(%)
    ruler_tape:   128,   // テープの太さ(px)
    ruler_font:    44,   // 目盛りの数字の大きさ(px)
    ruler_offset:   0,   // 上下位置の調整(px)。+で下がる
    // 最初のメニューの背景に敷く「成長する図形」（九九と同じ仕組み。docs/ARCHITECTURE.md「背景の床」）
    floor_on: 1,
    floor_per_answer: 0.75
  },

  /**
   * 教師画面に出す単元固有の設定欄。Core も teacher.html もキーの意味を知らず、
   * ここでの宣言だけを見て欄を描く（九九の教師画面にこの欄は出ない）。
   * 表示範囲(span)を入れていないのは、span が出題側の at の値域と結合していて、
   * 教師が変えると矢印が窓の外に出るため。変えるなら gen の作り直しが要る。
   */
  settings: [
    { key: 'ruler_width',  label: 'まきじゃくの横幅',
      note: '画面幅に対する%。50〜100', min: 50, max: 100, step: 1 },
    { key: 'ruler_tape',   label: 'テープの太さ',
      note: 'px。60〜200。太いほど目盛りが読みやすい', min: 60, max: 200, step: 4 },
    { key: 'ruler_font',   label: '目盛りの数字の大きさ',
      note: 'px。24〜72', min: 24, max: 72, step: 2 },
    { key: 'ruler_offset', label: '上下の位置',
      note: 'px。+で下、−で上に動く。−60〜120', min: -60, max: 120, step: 4 },
    { key: 'floor_on', label: 'メニューの背景の図形', type: 'onoff',
      note: '正答を重ねるほど育つ模様。表示しないと無地になる' },
    { key: 'floor_per_answer', label: '1正答あたりの図形の育ち',
      note: '1分に20問解ける速さの問題を1問正解したときに増えるタイルの枚数。解きにくい問題（1分で解ける数が少ない）ほど1問で多く育つ（速さはこのサイトの記録から自動で出す）。0.75 なら、1分20問の速さでおよそ3,200問で全部そろう',
      min: 0.05, max: 10, step: 0.05 }
  ],

  /**
   * 床の図形と第二の色。このサイトは巻き尺の渦（一定幅の帯が渦を巻き、1目盛りずつ区切る。10目盛りごとに色が替わる）。
   * 台帳は design リポジトリの growing-figures/COLORS.md
   */
  floorPattern: 'tape',
  floorColor: 'amethyst',

  /** 出題に出る単位と、その表示色（空文字は既定のグレー） */
  units: { km: '#F1B1E4', m: '', cm: '#8A6CE5' },

  modes: [
    { id: 1, name: 'かんさん きほん',   desc: '3km=□m ／ 7000m=□km' },
    { id: 2, name: 'かんさん ぜんぶ',   desc: '1200m=□km□m もあり' },
    { id: 3, name: 'けいさん たしざん', desc: '1km700m + 600m' },
    { id: 4, name: 'けいさん ひきざん', desc: '2km100m − 1km700m' },
    { id: 5, name: 'めもり きほん', wide: true,     desc: 'まきじゃく 1mまで' },
    { id: 6, name: 'めもり ぜんぶ', wide: true,     desc: 'まきじゃく 1mより長い',
      help: 'Enter で こたえあわせ' }   // 答えの桁数が 1〜3 と変わり自動確定できない
  ],

  types: {
    C: 'km→m', D: 'm→km', A: 'm→km m', B: 'km m→m',
    E: 'たしざん', F: 'ひきざん', G: 'めもり(1m以内)', H: 'めもり(1m超)'
  },

  /**
   * 自動確定に使う桁数（宣言のみ。この問題の答え(ans)は参照しない）。
   * 問題型ごとに宣言する。モードキーだと「かんさん ぜんぶ」で
   * A の m（km m の下位、3桁）と B・C の m（合計、4桁）が同じ m キーで衝突する。
   * A〜F は以前は未宣言で、実際の答えの桁数で確定していた（＝桁数がヒントとして漏れ、
   * 打鍵数の差が所要msに乗っていた）。値は gen の値域設計から一意に決まる。
   */
  digitCap: {
    C: { m: 4 },            // k*1000（k=1〜9） → 1000〜9000
    D: { km: 1 },           // k（1〜9）
    A: { km: 1, m: 3 },     // km=1〜9、m=100〜900（100の倍数）
    B: { m: 4 },            // k*1000+m（m=50〜900） → 1050〜9900
    E: { km: 1, m: 3 },     // 繰り上がり後も km=1〜9、m部は0を避けた100〜900
    F: { km: 1, m: 3 },     // km=0〜4（0も1桁）、m部は100〜900
    G: { cm: 2 },           // めもり：10〜78cm の範囲内なので常に2桁
    H: { m: 1, cm: 3 }      // めもり：at=101〜260cm なので m は常に1桁。cm欄だけで「187」と答える書き方も認めるため cm は3桁固定
  },

  tips:
    '<b>weak_child</b>：児童ごと・問題型ごとの平均想起時間(秒)＝出題から<b>最初のキーを押すまで</b>。<br>' +
    '打鍵の時間を含まないので、答えの桁数が違う型どうしを並べて比べてよい' +
    '（km→m は4桁、m→km は1桁なので、送信までの時間で比べると桁数の差がそのまま乗る）。<br>' +
    '・km→m と m→km だけ遅い → 1000倍の関係そのものが未定着<br>' +
    '・m→km m が遅い → 位取りで分ける操作につまずいている<br>' +
    '・たしざんよりひきざんが極端に遅い → 繰り下がりが課題<br>' +
    '・平均は基準内なのに<b>ゆらぎ</b>が大きい → 覚えている時と数えている時が混ざっている。' +
    '平均だけを見ていると素通りする層で、必要なのは手続きの練習ではなく想起の練習<br><br>' +
    '<b>weak_class</b> の下段が<b>よくある誤答の一覧</b>。' +
    '1200m を「12km 0m」とする<b>1000倍のずれ</b>や、' +
    '3km50m を「350」とする<b>位取りの崩れ</b>が、実際の答えとして見える。',

  /** めもりは合計で判定する（1m87cm も 187 も正解にする） */
  byTotal: function (item) { return item.t === 'G' || item.t === 'H'; },
  /** 合計判定に使う換算率（cm 換算）。関数ではなく宣言にしてあるのは、
   *  同じ値を児童画面にも渡して、index.html が単位名を決め打ちしないで済むようにするため */
  scale: { m: 100, cm: 1 },

  /** weak_class / mistakes で「1/200」を「1km200m」のように表示するための単位マップ */
  fieldsByType: {
    C: ['m'], D: ['km'], A: ['km', 'm'], B: ['m'],
    E: ['km', 'm'], F: ['km', 'm'], G: ['cm'], H: ['m', 'cm']
  },

  gen: function (rand, mode) {
    var pool;
    if (mode === 1) pool = ['C', 'D'];
    else if (mode === 2) pool = ['A', 'B', 'C', 'D'];
    else if (mode === 3) pool = ['E'];
    else if (mode === 4) pool = ['F'];
    else if (mode === 5) pool = ['G'];
    else pool = ['H'];
    return this.item(rand, pick_(rand, pool));
  },

  item: function (rand, type) {
    var k, m, m2, sum, a, b, res;

    if (type === 'C') {                        // 3km = □m
      k = ri_(rand, 1, 9);
      return { t: 'C', q: [String(k), 'km'], f: ['m'], ans: { m: k * 1000 }, tag: k + 'km' };
    }
    if (type === 'D') {                        // 7000m = □km
      k = ri_(rand, 1, 9);
      return { t: 'D', q: [String(k * 1000), 'm'], f: ['km'], ans: { km: k }, tag: (k * 1000) + 'm' };
    }
    if (type === 'A') {                        // 1200m = □km□m（m部は3桁固定＝桁数が漏れない）
      k = ri_(rand, 1, 9); m = ri_(rand, 1, 9) * 100;
      return { t: 'A', q: [String(k * 1000 + m), 'm'], f: ['km', 'm'],
               ans: { km: k, m: m }, tag: (k * 1000 + m) + 'm' };
    }
    if (type === 'B') {                        // 1km500m = □m（答えは常に4桁）
      k = ri_(rand, 1, 9);
      m = pick_(rand, [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
      return { t: 'B', q: [String(k), 'km', String(m), 'm'], f: ['m'],
               ans: { m: k * 1000 + m }, tag: k + 'km' + m + 'm' };
    }
    if (type === 'E') {                        // 1km700m + 600m = □km□m
      k = ri_(rand, 1, 8); m = ri_(rand, 1, 9) * 100; m2 = ri_(rand, 1, 9) * 100;
      sum = k * 1000 + m + m2;
      if (sum % 1000 === 0) { m2 += 100; sum += 100; }      // m部が0になるのを避ける
      return { t: 'E', q: [String(k), 'km', String(m), 'm', '+', String(m2), 'm'],
               f: ['km', 'm'], ans: { km: Math.floor(sum / 1000), m: sum % 1000 },
               tag: k + 'km' + m + 'm+' + m2 + 'm' };
    }
    if (type === 'G') {                        // まきじゃく 1m以内
      // 窓を 85cm に狭めて1cmあたりの表示幅を稼ぐ（読みやすさを範囲より優先）。
      // 10〜78cm に限るのは、1桁の答えを混ぜると桁数が定まらず自動確定できなくなるため。
      var g = ri_(rand, 10, 78);
      return { t: 'G', ruler: { from: 0, span: 85, at: g },
               q: [], f: ['cm'], ans: { cm: g }, tag: g + 'cm' };
    }
    if (type === 'H') {                        // まきじゃく 1m超
      // 答えを先に決めてから窓を合わせる。窓を先に決めると答えが1m台に偏る。
      // at は 101cm 以上に限る。モード名が「1mより長い」である以上、
      // 1m未満（40〜99cm）が出るのはモードの説明と出題内容が食い違う不具合。
      var span = 90;
      var at = ri_(rand, 101, 260);
      var lo = Math.max(0, at - (span - 10)), hi = Math.max(0, at - 10);
      var from = Math.round(ri_(rand, lo, hi) / 10) * 10;
      if (from > at - 6) from = Math.max(0, from - 10);
      return { t: 'H', ruler: { from: from, span: span, at: at },
               q: [], f: ['m', 'cm'],
               ans: { m: Math.floor(at / 100), cm: at % 100 }, tag: at + 'cm' };
    }

    // F: ひきざん。答えを先に決めてから引く数を作る。
    // 引かれる数を先に決めると、答えの km 部が 0〜1 に偏る。
    // res(答えのm部)は100〜4900、b(引く数)は1100〜4900なので a=res+bは常に1200〜9800。
    // 桁あふれ・繰り上がりは値域の設計自体で構造的に起きない（到達しない補正は置かない）。
    res = ri_(rand, 0, 4) * 1000 + ri_(rand, 1, 9) * 100;
    b = ri_(rand, 1, 4) * 1000 + ri_(rand, 1, 9) * 100;
    a = res + b;

    var qa = (a % 1000 === 0) ? [String(a / 1000), 'km']
           : [String(Math.floor(a / 1000)), 'km', String(a % 1000), 'm'];
    var qb = (b % 1000 === 0) ? [String(b / 1000), 'km']
           : [String(Math.floor(b / 1000)), 'km', String(b % 1000), 'm'];
    return { t: 'F', q: qa.concat(['-'], qb), f: ['km', 'm'],
             ans: { km: Math.floor((a - b) / 1000), m: (a - b) % 1000 },
             tag: a + '-' + b };
  }
};

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['length'];

// ===== apps/grade3/operation-choice/Unit.gs =====
/**
 * 文の手がかりと演算を分けて見られるよう、c/i を半数ずつ混ぜる。
 * 式は演算だけを選ばせ、数の計算は求めない。
 */
var OC_INK = '#FFFFFF';
var OC_SUB = '#C9D1E8';
var OC_LINE = '#8C93AC';
var OC_MARK = ['①', '②', '③', '④'];
var OC_OPS = ['+', '−', '×', '÷'];

// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['operation-choice'] = {
  id: 'operation-choice',
  grade: 3,
  title: 'なに算？ タイムアタック！',
  teacherTitle: '演算決定（なに算？） 設定・分析',
  units: {},
  modes: [
    { id: 1, name: 'えらぶ', desc: '文を読んで ＋−×÷ を選ぶ' },
    { id: 2, name: 'しきを えらぶ', desc: '文とテープ図から式を選ぶ', needs: { mode: 1, tries: 3 } },
    { id: 3, name: 'ふたつの しき', desc: '2つの式で解く問題の、1つ目か2つ目の式を選ぶ', needs: { mode: 2, tries: 3 } }
  ],
  types: {
    A: 'たし算',
    B: 'ひき算',
    C: 'かけ算',
    D: 'わり算（等分）',
    E: 'わり算（包含）',
    S: '2つの式'
  },
  digitCap: {
    1: { '': 1 },
    2: { '': 1 },
    3: { '': 1 }
  },
  tips: 'tag の c は「全部で→たし算」「のこり→ひき算」などの言葉の手がかりどおりに解ける文、i は手がかりと逆になる文。i だけで誤る児童は、言葉だけで演算を決めている可能性がある。D（等分）と E（包含）はどちらもわり算。E だけ誤る児童は「いくつ分」を求める場面をかけ算・ひき算と取り違えている。S は2つの式で解く問題で、s1＝はじめの式、s2＝つぎの式。倍の場面（倍ならかける）は「何倍でしょう」TAで扱う。',
  gen: function (rand, mode) {
    if (mode === 1) return ocOp_(rand);
    if (mode === 2) return ocExpr_(rand);
    if (mode === 3) return ocTwo_(rand);
    throw new Error('mode ' + mode);
  }
};

function ocEsc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ocText_(x, y, text, size, anchor, color, useAccent) {
  return '<text x="' + x + '" y="' + y + '" font-size="' + size + '" text-anchor="' + (anchor || 'start') +
    '" dominant-baseline="middle" fill="' + (color || OC_INK) + '"' +
    (useAccent ? ' style="fill:var(--acc)"' : '') + '>' + ocEsc_(text) + '</text>';
}

function ocSvg_(body, height) {
  return '<svg viewBox="0 0 1040 ' + (height + 16) +
    '" xmlns="http://www.w3.org/2000/svg" lang="ja" ' +
    'font-family="system-ui,-apple-system,\'Noto Sans JP\',\'Hiragino Sans\',sans-serif" font-weight="800">' +
    body + '</svg>';
}

function ocPickBox_(x, y, w, h, i, label, size, centeredLabel) {
  return '<g data-pick="' + (i + 1) + '">' +
    '<rect class="pkb" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
    '" rx="6" fill="#000" fill-opacity="0" stroke="' + OC_LINE + '" stroke-width="3"/>' +
    ocText_(x + 24, y + h / 2, OC_MARK[i], 32, 'start', '#35D0A5', true) +
    ocText_(centeredLabel ? x + w / 2 : x + w / 2 + 24, y + h / 2, label, size, 'middle', OC_INK) +
    '</g>';
}

function ocOperatorChoices_(y) {
  var body = '', x;
  for (var i = 0; i < 4; i++) {
    x = 35 + i * 250;
    body += ocPickBox_(x, y, 220, 96, i, OC_OPS[i], 48, true);
  }
  return body;
}

function ocExprChoices_(choices, y) {
  var body = '', xs = [70, 540], ys = [y, y + 104];
  for (var i = 0; i < 4; i++) {
    body += ocPickBox_(xs[i % 2], ys[Math.floor(i / 2)], 430, 88, i, choices[i], 36, false);
  }
  return body;
}

function ocLines_(lines, size) {
  var body = '', y = 56;
  lines.forEach(function (line) {
    body += ocText_(42, y, line, size);
    y += 48;
  });
  return { body: body, lastY: y - 48 };
}

function ocFormula_(x, y, op) {
  var b = Math.max(x, y), s = Math.min(x, y);
  if (op === '+') return b + '+' + s;
  if (op === '−') return b + '−' + s;
  if (op === '×') return b + '×' + s;
  return b + '÷' + s;
}

function ocValues_(x, y) {
  var b = Math.max(x, y), s = Math.min(x, y);
  return [b + s, b - s, b * s, b / s];
}

function ocValidPair_(x, y, op) {
  if (x === y) return false;
  var answer = OC_OPS.indexOf(op), values = ocValues_(x, y), correct = values[answer];
  for (var i = 0; i < values.length; i++) {
    if (i !== answer && Math.abs(values[i] - correct) < 1e-9) return false;
  }
  return true;
}

function ocTypeOp_(type) {
  return type === 'A' ? '+' : type === 'B' ? '−' : type === 'C' ? '×' : '÷';
}

function ocTemplate_(rand) {
  var type = pick_(rand, ['A', 'B', 'C', 'D']);
  if (type === 'D' && rand() < 0.5) type = 'E';
  return { type: type, n: ri_(rand, 1, 4), op: ocTypeOp_(type) };
}

function ocScene_(rand, type, n) {
  var id = type + n, a, b, m, k, q, d, count, total, scene;
  for (var attempt = 0; attempt < 50; attempt++) {
    scene = { type: type, n: n, id: id, cue: n <= 2 ? 'c' : 'i', op: ocTypeOp_(type) };
    if (type === 'A') {
      if (n === 1) { a = ri_(rand, 12, 48); b = ri_(rand, 11, 39); }
      else if (n === 2) { a = ri_(rand, 12, 38); b = ri_(rand, 5, 19); }
      else if (n === 3) { a = ri_(rand, 12, 40); b = ri_(rand, 5, 19); }
      else { a = ri_(rand, 12, 40); b = ri_(rand, 11, 29); }
      scene.a = a; scene.b = b; scene.x = a; scene.y = b;
      if (n === 1) scene.lines = ['赤い花が ' + a + '本、白い花が ' + b + '本 あります。', '花は 全部で 何本？'];
      if (n === 2) scene.lines = ['子どもが ' + a + '人 います。' + b + '人 来ました。', '子どもは 何人に なりましたか？'];
      if (n === 3) scene.lines = ['赤い紙は ' + a + 'まい です。', '赤い紙は 青い紙より ' + b + 'まい 少ないです。', '青い紙は 何まい？'];
      if (n === 4) scene.lines = ['シールを ' + b + 'まい 使ったので、', 'のこりが ' + a + 'まいに なりました。', 'はじめに 何まい ありましたか？'];
    } else if (type === 'B') {
      if (n === 1) { a = ri_(rand, 35, 80); b = ri_(rand, 11, a - 6); }
      else if (n === 2) { a = ri_(rand, 25, 48); b = ri_(rand, 11, a - 6); }
      else if (n === 3) { a = ri_(rand, 30, 60); b = ri_(rand, 11, a - 6); }
      else { a = ri_(rand, 25, 48); b = ri_(rand, 5, 19); }
      scene.a = a; scene.b = b; scene.x = a; scene.y = b;
      if (n === 1) scene.lines = ['シールが ' + a + 'まい あります。' + b + 'まい 使いました。', 'のこりは 何まい？'];
      if (n === 2) scene.lines = ['赤い花が ' + a + '本、白い花が ' + b + '本 あります。', 'ちがいは 何本？'];
      if (n === 3) scene.lines = ['花が 全部で ' + a + '本 あります。', 'そのうち 赤い花は ' + b + '本です。', '白い花は 何本？'];
      if (n === 4) scene.lines = ['青い紙は ' + a + 'まい です。', '青い紙は 赤い紙より ' + b + 'まい 多いです。', '赤い紙は 何まい？'];
    } else if (type === 'C') {
      m = ri_(rand, 3, 9); k = ri_(rand, 2, m - 1);
      scene.m = m; scene.k = k; scene.x = m; scene.y = k;
      if (n === 1) scene.lines = ['1箱に えんぴつが ' + m + '本ずつ 入っています。', k + '箱では 全部で 何本？'];
      if (n === 2) scene.lines = ['1人に 紙を ' + m + 'まいずつ 配ります。', k + '人に 配ると、何まい いりますか？'];
      if (n === 3) scene.lines = ['えんぴつを 1人に ' + m + '本ずつ 分けたら、', 'ちょうど ' + k + '人に 分けられました。', 'えんぴつは 何本 ありましたか？'];
      if (n === 4) scene.lines = ['あめを ' + k + '人で 同じ数ずつ 分けたら、', '1人分が ' + m + 'こに なりました。', 'あめは 何こ ありましたか？'];
    } else if (type === 'D') {
      q = ri_(rand, 2, 9); d = ri_(rand, 2, 9); total = q * d;
      scene.q = q; scene.d = d; scene.nTotal = total; scene.x = total; scene.y = d;
      if (n === 1) scene.lines = ['えんぴつ ' + total + '本を ' + d + '人に 同じ数ずつ 分けます。', '1人分は 何本？'];
      if (n === 2) scene.lines = ['あめが ' + total + 'こ あります。', d + '人で 同じ数ずつ 分けると、1人 何こ？'];
      if (n === 3) scene.lines = [d + '人に 同じ数ずつ 配ったら、', '全部で ' + total + 'まい いりました。', '1人 何まいずつ 配りましたか？'];
      if (n === 4) scene.lines = ['えんぴつが 全部で ' + total + '本 あります。', d + '箱に 同じ数ずつ 入れると、1箱 何本？'];
    } else {
      m = ri_(rand, 2, 9); q = ri_(rand, 2, 9); total = m * q;
      scene.m = m; scene.q = q; scene.nTotal = total; scene.x = total; scene.y = m;
      if (n === 1) scene.lines = ['えんぴつ ' + total + '本を 1人に ' + m + '本ずつ 分けます。', '何人に 分けられますか？'];
      if (n === 2) scene.lines = ['あめ ' + total + 'こを ' + m + 'こずつ ふくろに 分けます。', 'ふくろは 何まい いりますか？'];
      if (n === 3) scene.lines = ['1箱に ' + m + 'こずつ 入れたら、', '全部で ' + total + 'こ 入りました。', '箱は いくつ ありますか？'];
      if (n === 4) scene.lines = ['1人に ' + m + 'まいずつ 配ったら、', '全部で ' + total + 'まい いりました。', '何人に 配りましたか？'];
    }
    if (ocValidPair_(scene.x, scene.y, scene.op)) return scene;
  }
  throw new Error('50回で数を決められません: ' + id);
}

function ocTapeRect_(x, y, w, h, dash) {
  return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
    '" fill="none" stroke="' + OC_LINE + '" stroke-width="3"' +
    (dash ? ' stroke-dasharray="8 6"' : '') + '/>';
}

function ocTapeLine_(x1, y1, x2, y2) {
  return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
    '" stroke="' + OC_LINE + '" stroke-width="3"/>';
}

function ocBracket_(y0, whole) {
  var y = y0 + 30;
  return ocText_(520, y0 + 14, whole, 28, 'middle') +
    ocTapeLine_(130, y, 910, y) + ocTapeLine_(130, y, 130, y0 + 44) + ocTapeLine_(910, y, 910, y0 + 44);
}

function ocTapeLabel_(x, y, label) {
  return ocText_(x, y, label, 28, 'middle', OC_INK);
}

function ocPw_(y0, whole, parts) {
  var y = y0 + 56, body = ocBracket_(y0, whole) + ocTapeRect_(130, y, 780, 56);
  body += ocTapeLine_(600, y, 600, y + 56);
  body += ocTapeLabel_(365, y + 28, parts[0]) + ocTapeLabel_(755, y + 28, parts[1]);
  return { body: body, bottom: y + 56 };
}

function ocCmp_(y0, top, bottom, diff) {
  var body = ocTapeRect_(130, y0 + 20, 780, 50);
  body += ocTapeLabel_(520, y0 + 45, top);
  body += ocTapeRect_(130, y0 + 96, 470, 50);
  body += ocTapeRect_(600, y0 + 96, 310, 50, true);
  body += ocTapeLabel_(365, y0 + 121, bottom) + ocTapeLabel_(755, y0 + 121, diff);
  return { body: body, bottom: y0 + 146 };
}

function ocEq_(y0, cell, count, whole, divisions) {
  var y = y0 + 56, body = ocBracket_(y0, whole) + ocTapeRect_(130, y, 780, 56);
  var parts = divisions === 'unknown' ? 5 : divisions, width = 780 / parts;
  for (var i = 1; i < parts; i++) body += ocTapeLine_(130 + width * i, y, 130 + width * i, y + 56);
  body += ocTapeLabel_(130 + width / 2, y + 28, cell);
  if (divisions === 'unknown') body += ocText_(130 + width * 3.5, y + 28, '…', 28, 'middle', OC_INK);
  var countY = y0 + 56 + 56 + 30;
  body += ocText_(520, countY, count, 26, 'middle', OC_SUB);
  return { body: body, bottom: countY + 14 };
}

function ocExpressionList_(x, y) {
  var b = Math.max(x, y), s = Math.min(x, y);
  return [b + '+' + s, b + '−' + s, b + '×' + s, b + '÷' + s];
}

function ocDiagram_(scene, y0) {
  var type = scene.type, n = scene.n;
  if (type === 'A' && n === 1) return ocPw_(y0, '？本', ['赤 ' + scene.a + '本', '白 ' + scene.b + '本']);
  if (type === 'A' && n === 2) return ocPw_(y0, '？人', ['はじめ ' + scene.a + '人', '来た ' + scene.b + '人']);
  if (type === 'A' && n === 3) return ocCmp_(y0, '青 ？まい', '赤 ' + scene.a + 'まい', scene.b + 'まい');
  if (type === 'A') return ocPw_(y0, '？まい', ['使った ' + scene.b + 'まい', 'のこり ' + scene.a + 'まい']);
  if (type === 'B' && n === 1) return ocPw_(y0, scene.a + 'まい', ['使った ' + scene.b + 'まい', 'のこり ？まい']);
  if (type === 'B' && n === 2) return ocCmp_(y0, '赤 ' + scene.a + '本', '白 ' + scene.b + '本', '？本');
  if (type === 'B' && n === 3) return ocPw_(y0, scene.a + '本', ['赤 ' + scene.b + '本', '白 ？本']);
  if (type === 'B') return ocCmp_(y0, '青 ' + scene.a + 'まい', '赤 ？まい', scene.b + 'まい');
  if (type === 'C') {
    var cCount = n === 1 ? scene.k + '箱分' : scene.k + '人分';
    return ocEq_(y0, scene.m + (n === 2 ? 'まい' : n === 4 ? 'こ' : '本'),
      cCount,
      '？' + (n === 2 ? 'まい' : n === 4 ? 'こ' : '本'), scene.k);
  }
  if (type === 'D') {
    var dCell = n === 2 ? '？こ' : n === 3 ? '？まい' : '？本';
    var dWhole = scene.nTotal + (n === 2 ? 'こ' : n === 3 ? 'まい' : '本');
    var dCount = scene.d + (n === 4 ? '箱分' : '人分');
    return ocEq_(y0, dCell, dCount, dWhole, scene.d);
  }
  var eCell = scene.m + (n === 2 ? 'こ' : n === 3 ? 'こ' : n === 4 ? 'まい' : '本');
  var eWhole = scene.nTotal + (n === 2 || n === 3 ? 'こ' : n === 4 ? 'まい' : '本');
  var eCount = n === 1 ? '？人分' : n === 2 ? '？ふくろ分' : n === 3 ? '？箱分' : '？人分';
  return ocEq_(y0, eCell, eCount, eWhole, 'unknown');
}

function ocItem_(type, question, answer, tag, body, bottom) {
  return {
    t: type,
    q: [question],
    f: [''],
    ans: { '': answer },
    tag: tag,
    fig: ocSvg_(body, bottom)
  };
}

function ocOp_(rand) {
  var selected = ocTemplate_(rand), scene = ocScene_(rand, selected.type, selected.n);
  var lines = ocLines_(scene.lines, 34), y = lines.lastY + 52;
  return ocItem_(scene.type, 'なに算？', OC_OPS.indexOf(scene.op) + 1, 'op ' + scene.id + scene.cue,
    lines.body + ocOperatorChoices_(y), y + 96);
}

function ocExpr_(rand) {
  var selected = ocTemplate_(rand), scene = ocScene_(rand, selected.type, selected.n);
  var lines = ocLines_(scene.lines, 32), y0 = lines.lastY + 30, diagram = ocDiagram_(scene, y0);
  var choicesY = diagram.bottom + 32, body = lines.body + diagram.body;
  var expressions = ocExpressionList_(scene.x, scene.y);
  return ocItem_(scene.type, 'あう しきは？', OC_OPS.indexOf(scene.op) + 1, 'ex ' + scene.id + scene.cue,
    body + ocExprChoices_(expressions, choicesY), choicesY + 104 + 88);
}

function ocTwoValues_(rand, type) {
  var m, k, r, g, d, q, a, b, n, x1, y1, op1, x2, y2, op2, lines, first;
  for (var attempt = 0; attempt < 50; attempt++) {
    if (type === 'T1' || type === 'T2') {
      m = ri_(rand, 4, 9); k = ri_(rand, 2, m - 1); r = m * k;
      g = type === 'T1' ? ri_(rand, 2, Math.min(9, r - 2)) : ri_(rand, 2, 9);
      x1 = m; y1 = k; op1 = '×'; x2 = r; y2 = g; op2 = type === 'T1' ? '−' : '+';
      lines = type === 'T1'
        ? ['1ふくろに クッキーが ' + m + 'まい 入っています。', k + 'ふくろ 買って、' + g + 'まい 食べました。', 'のこりは 何まい？']
        : ['えんぴつが ' + m + '本ずつ 入った 箱が ' + k + '箱と、', 'ばらの えんぴつが ' + g + '本 あります。', 'えんぴつは 全部で 何本？'];
      first = ocFormula_(m, k, '×');
    } else if (type === 'T3') {
      d = ri_(rand, 2, 9); q = ri_(rand, 2, 9); r = d * q;
      if (r < 6) continue;
      a = ri_(rand, 2, r - 2); b = r - a;
      x1 = a; y1 = b; op1 = '+'; x2 = r; y2 = d; op2 = '÷';
      lines = ['赤い花が ' + a + '本、白い花が ' + b + '本 あります。', '全部の 花を ' + d + '人で 同じ数ずつ 分けると、', '1人 何本？'];
      first = ocFormula_(a, b, '+');
    } else {
      m = ri_(rand, 2, 9); q = ri_(rand, 2, 9); r = m * q;
      g = ri_(rand, 2, 9); n = r + g;
      x1 = n; y1 = g; op1 = '−'; x2 = r; y2 = m; op2 = '÷';
      lines = ['あめが ' + n + 'こ あります。' + g + 'こ 食べて、', 'のこりを ' + m + 'こずつ ふくろに 入れます。', 'ふくろは 何まい いりますか？'];
      first = ocFormula_(n, g, '−');
    }
    if (ocValidPair_(x1, y1, op1) && ocValidPair_(x2, y2, op2)) {
      return { type: type, m: m, k: k, r: r, g: g, d: d, q: q, a: a, b: b, n: n,
        x1: x1, y1: y1, op1: op1, x2: x2, y2: y2, op2: op2, lines: lines, first: first };
    }
  }
  throw new Error('50回で数を決められません: ' + type);
}

function ocTwo_(rand) {
  var type = 'T' + ri_(rand, 1, 4), scene = ocTwoValues_(rand, type);
  var step = rand() < 0.5 ? 1 : 2;
  var x = step === 1 ? scene.x1 : scene.x2;
  var y = step === 1 ? scene.y1 : scene.y2;
  var op = step === 1 ? scene.op1 : scene.op2;
  var lines = ocLines_(scene.lines, 32), body = lines.body;
  var lastY = lines.lastY;
  if (step === 2) {
    body += ocText_(42, lastY + 48, 'はじめの しき　' + scene.first + '＝' + scene.r, 32, 'start', OC_SUB);
    lastY += 48;
  }
  var choicesY = lastY + 40, expressions = ocExpressionList_(x, y);
  return ocItem_('S', step === 1 ? 'はじめの しきは？' : 'つぎの しきは？',
    OC_OPS.indexOf(op) + 1, 'S ' + type + ' s' + step,
    body + ocExprChoices_(expressions, choicesY), choicesY + 104 + 88);
}

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['operation-choice'];

// ===== apps/grade2/tasu/Unit.gs =====
/**
 * たしざん あんざんTA。中身は2けたの筆算で、画面も筆算の形に並べる。
 * 児童には暗算の練習として出す。「頭の中で筆算をすればよい」という意図で、
 * 答えは一の位から打つ（f の順＝打つ順。画面の並びは rows の '_0' '_1' '_2' が決める）。
 * 一の位を先に打てば画面に残るので、頭に持つのはくり上がりの1と十の位だけで済む。
 */
// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['tasu'] = {
  id: 'tasu',
  grade: 2,                 // 学習指導要領 2年 A(2) 2位数の加法。置き場 apps/grade2/ と一致させる
  title: '暗算(たし算) タイムアタック！',
  teacherTitle: '暗算(たし算) 設定・分析',

  /**
   * 教師が調整する設定。最初のメニューの背景に敷く「成長する図形」。このサイトはくり上がりの六角（六角のマスごとに k＋(n−k) の筆算。くり上がるマスが第二の色）。
   * 本番の正答を「標準の分数」に直して積み、無地 → 輪郭 → 学年の色 → 第二の色 と育つ。表示だけで、出題にも採点にも関わらない。
   */
  defaults: { limit_sec: 60, floor_on: 1, floor_per_answer: 0.75 },
  settings: [
    { key: 'floor_on', label: 'メニューの背景の図形', type: 'onoff',
      note: '正答を重ねるほど育つ模様。表示しないと無地になる' },
    { key: 'floor_per_answer', label: '1正答あたりの図形の育ち',
      note: '1分に20問解ける速さの問題を1問正解したときに増えるタイルの枚数。解きにくい問題（1分で解ける数が少ない）ほど1問で多く育つ（速さはこのサイトの記録から自動で出す）',
      min: 0.05, max: 10, step: 0.05 }
  ],
  /** 床の図形と第二の色（台帳は design リポジトリの growing-figures/COLORS.md） */
  floorPattern: 'carry',
  floorColor: 'topaz',

  // 筆算の形の答えを、右（一の位）から打つか左から打つか、児童がすうじキーせっていで選べる（index.html の COLDIR）
  colDir: true,
  units: {},
  modes: [
    { id: 1, name: '1けたの くりあがり', desc: '9+7' },
    { id: 2, name: 'くりあがり なし', desc: '34+52（筆算の形）',
      needs: { mode: 1, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true },
    { id: 3, name: 'くりあがり', desc: '47+38',
      needs: { mode: 2, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true },
    { id: 4, name: '百を こえる', desc: '67+58 ／ 75+30',
      needs: { mode: 3, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true },
    { id: 5, name: 'ぜんぶ いり', desc: '1〜4 を同じ割合で',
      needs: { mode: 4, tries: 3 }, help: 'いちの くらいから うとう', enterKey: true }
  ],
  types: { K: '1けた くりあがり', A: 'くりあがりなし', B: 'くりあがり', C: '百をこえる' },

  // 1けたは答えが必ず2けた（10〜18）。2けたは百・十・一の欄が毎回3つあり、各1けた。
  // 欄の数が型の中で変わらないので、確定の早さから答えの大きさは漏れない
  digitCap: { K: { '': 2 }, A: { '一': 1, '十': 1, '百': 1 }, B: { '一': 1, '十': 1, '百': 1 }, C: { '一': 1, '十': 1, '百': 1 } },

  tips: '型Bと型Cの誤答を見てください。「くりあがりを忘れる」（47+38=75）は十の位が1小さく、' +
    '「一の位に2けたを書く」は打てない形なので、十の位の欄の誤りとして出ます。<br>' +
    '型K（1けた）が遅い児童は、2けたの遅さの多くがそこから来ている可能性があります。2けたより先に1けたを練習させてください。<br>' +
    '初打鍵までの時間は「一の位を出すまで」の時間です。',

  // 誤答明細は欄の順（一/十/百）で届く。教師には普通の数で見せる
  fmtAnswer: function (type, vals) {
    if (type === 'K') return vals.join('');
    return String(Number(vals[2] || 0) * 100 + Number(vals[1] || 0) * 10 + Number(vals[0] || 0));
  },

  gen: function (rand, mode) {
    var t = mode === 5 ? pick_(rand, ['K', 'A', 'B', 'C']) : ['', 'K', 'A', 'B', 'C'][mode];
    if (!t) throw new Error('たしざん: モードが不正です');
    if (t === 'K') {
      var x = ri_(rand, 1, 9), y = ri_(rand, 10 - x, 9);
      return { t: 'K', q: [String(x), '+', String(y)], f: [''], ans: { '': x + y }, tag: 'K' + x + '+' + y };
    }
    var a1, a0, b1, b0;
    if (t === 'A') {          // 一の位も十の位も10未満。一の位の0（30+45）も出す
      a0 = ri_(rand, 0, 9); b0 = ri_(rand, 0, 9 - a0);
      a1 = ri_(rand, 1, 8); b1 = ri_(rand, 1, 9 - a1);
    } else if (t === 'B') {   // 一の位でくり上がり、和は99まで
      a0 = ri_(rand, 1, 9); b0 = ri_(rand, 10 - a0, 9);
      a1 = ri_(rand, 1, 7); b1 = ri_(rand, 1, 8 - a1);
    } else if (rand() < 0.5) { // C：十の位だけでくり上がる（75+30）
      a0 = ri_(rand, 0, 9); b0 = ri_(rand, 0, 9 - a0);
      a1 = ri_(rand, 1, 9); b1 = ri_(rand, Math.max(1, 10 - a1), 9);
    } else {                  // C：一の位と十の位の両方でくり上がる（67+58）
      a0 = ri_(rand, 1, 9); b0 = ri_(rand, 10 - a0, 9);
      a1 = ri_(rand, 1, 9); b1 = ri_(rand, Math.max(1, 9 - a1), 9);
    }
    var a = a1 * 10 + a0, b = b1 * 10 + b0, s = a + b;
    return {
      t: t, q: [String(a), '+', String(b)],
      // 左から [演算子, 百, 十, 一]。答えの段は百・十・一の順に見せ、一の位から打つ
      rows: [['', '', String(a1), String(a0)], ['+', '', String(b1), String(b0)], ['', '_2', '_1', '_0']],
      col: true,
      f: ['一', '十', '百'], ans: { '一': s % 10, '十': Math.floor(s / 10) % 10, '百': Math.floor(s / 100) },
      tag: t + a + '+' + b
    };
  }
};

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['tasu'];

// ===== apps/grade5/volume/Unit.gs =====
/**
 * Unit.gs — 体積（5年）
 *
 * モードは前提スキルの依存順。型の混在（ランダム出題）は最後の「ぜんぶ」だけ。
 *
 *   ① つみき      積んだ 1cm³ の立方体の数（図を見て数える）
 *   ② こうしき    直方体・立方体の体積／体積から辺の長さを逆に出す
 *   ③ たんい      m³・cm³・L・mL の関係（4択）
 *   ④ ふくごう    L字・凹字の立体（分けて足す／大きく取って引く）
 *   ⑤ ようせき    板の厚さを引いて内のりから容積（cm³／L）
 *   ⑥ ぜんぶ      ①〜⑤を混ぜる
 *
 * 数値はすべて整数（小数×小数は体積の単元の後で習うため）。
 *
 * 誤答から読める誤概念（mistakes シートの「もんだい」＝tag と「こたえた値」で読む）
 *   M1 見える立方体だけを数える（Battista & Clements 1996）
 *      → A の答えが tag の「みえる」の数と一致する
 *   M2 m³⇄cm³ を長さ・面積の倍率で換える（1m³=100cm³ / 10000cm³）
 *      → ③の4択。誤りの選択肢は誤概念ごとに1つ。並びは tag に残す
 *   M3 体積を縦×横で止める（面積との混同）
 *      → B・C の答えが tag の2辺の積と一致する
 *   M4 複合図形で重なりを2回足す／高さを取り違える → F・G の tag の寸法と照合
 *   M5 容積に外のりを使う → H・I の答えが外のりの積と一致する
 *
 * 答えの桁数は型ごとに固定する（docs/ADD_UNIT.md 3章）。
 *   A 2桁 / B・F・G・H 3桁（cm³） / C 2桁（cm） / 4択 1桁 / I 1桁（L）
 */

var VO_MARK = ['①', '②', '③', '④'];
var VO_LINE = '#8C93AC';    // 立体の辺
var VO_INK = '#FFFFFF';     // 強調する線
var VO_LABEL = '#C9D1E8';   // 長さの字
var VO_DIM = '#D4D454';     // 引き出し線（5年の進みの色）。へこみの内側の辺と長さの字をつなぐ
// 正面・上面・側面。重ね描きで奥の面を隠すので、半透明にせず背景 #101728 と混ぜた不透明色にする
var VO_FACE = ['#282E3E', '#454A57', '#1A2031'];

// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['volume'] = {
  id: 'volume',
  grade: 5,
  title: '体積 タイムアタック！',
  teacherTitle: '体積 設定・分析',

  units: { 'cm³': '', cm: '', 'こ': '', L: '' },

  modes: [
    { id: 1, name: 'つみき', desc: '1cm³の立方体は何こ？（見えない所も）' },
    { id: 2, name: 'こうしき', desc: '直方体・立方体の体積／体積から辺', needs: { mode: 1, tries: 3 } },
    { id: 3, name: 'たんい', desc: '1m³=□cm³ などを4つからえらぶ', needs: { mode: 2, tries: 3 } },
    { id: 4, name: 'ふくごう', desc: 'L字・へこんだ形の体積', needs: { mode: 3, tries: 3 } },
    { id: 5, name: 'ようせき', desc: '板の厚さをひいて入れ物の容積', needs: { mode: 4, tries: 3 } },
    { id: 6, name: 'ぜんぶ', desc: '①〜⑤をまぜて出す', needs: { mode: 5, tries: 3 } }
  ],

  types: {
    A: 'つみき',
    B: '直方体', C: '立方体', D: '体積→辺',
    E: 'm³→cm³', J: 'L⇄cm³', K: 'mL→cm³', N: 'm³→L',
    F: 'L字', G: 'へこみ',
    H: '容積 cm³', I: '容積 L'
  },

  digitCap: {
    A: { 'こ': 2 },
    B: { 'cm³': 3 }, C: { 'cm³': 3 }, D: { cm: 2 },
    E: { '': 1 }, J: { '': 1 }, K: { '': 1 }, N: { '': 1 },
    F: { 'cm³': 3 }, G: { 'cm³': 3 },
    H: { 'cm³': 3 }, I: { L: 1 }
  },

  tips: 'つみき（A）で答えが tag の「みえる」の数なら、見えている立方体だけを数えている。' +
        '直方体・立方体（B・C）で答えが2辺の積なら、高さをかけ忘れている（面積との混同）。' +
        'たんい（E・J・K・N）は tag に選択肢の並びが残る。「こたえた値」が3なら③を選んだ、と読む。' +
        '1m³=100cm³ や 10000cm³ を選ぶのは、長さや面積の倍率で換えている。' +
        '容積（H・I）で答えが外のりの積に近いなら、板の厚さを引いていない。',

  gen: function (rand, mode) {
    switch (mode) {
      case 1: return voBlocks_(rand);
      case 2: var k = rand(); return k < 0.45 ? voCuboid_(rand) : k < 0.7 ? voCube_(rand) : voInverse_(rand);
      case 3: return voUnit_(rand);
      case 4: return rand() < 0.5 ? voLshape_(rand) : voNotch_(rand);
      case 5: return rand() < 0.6 ? voCapacity_(rand) : voLiter_(rand);
      case 6: return UNIT_DEFS['volume'].gen(rand, ri_(rand, 1, 5));   // 全単元をまとめた時も自分の gen を呼ぶ
    }
    throw new Error('mode ' + mode);
  }
};

/* ============================================================
 *  図の部品（SVG 文字列）
 *  立体は斜投影：奥行き z を右上へ 0.5 倍・30°で倒す
 * ============================================================ */

function voR_(x) { return Math.round(x); }

/** rand で並べ替える（Math.random を使うとサーバーの再採点と食い違う） */
function voShuffle_(rand, arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 図の座標系。s＝1cm あたりの画素、(ox, oy)＝原点（左下手前）の画面位置 */
function voView_(w, h, d, maxPx, topPad) {
  var kx = 0.5 * Math.cos(Math.PI / 6), ky = 0.5 * Math.sin(Math.PI / 6);
  var s = Math.min(maxPx / (w + d * kx), maxPx * 0.8 / (h + d * ky));
  var pad = 120;
  // topPad：図の上に足す余白。画面の左上（右手用は右上）に「せいかい」の数が重なるので、
  // 図の上の外に字を出す図（へこみ）はその高さぶん下げる
  var W = (w + d * kx) * s + pad * 2, H = (h + d * ky) * s + pad * 2 + (topPad || 0);
  return {
    s: s, kx: kx, ky: ky, W: W, H: H,
    p: function (x, y, z) { return [pad + (x + z * kx) * s, H - pad - (y + z * ky) * s]; }
  };
}

function voSvg_(w, h, body) {
  return '<svg viewBox="0 0 ' + voR_(w) + ' ' + voR_(h) + '" xmlns="http://www.w3.org/2000/svg" ' +
         'font-family="sans-serif" font-weight="800">' + body + '</svg>';
}
function voPts_(pts) { return pts.map(function (p) { return voR_(p[0]) + ',' + voR_(p[1]); }).join(' '); }
function voPoly_(pts, fill, stroke, width) {
  return '<polygon points="' + voPts_(pts) + '" fill="' + fill + '" stroke="' + (stroke || VO_LINE) +
         '" stroke-width="' + (width || 4) + '" stroke-linejoin="round"/>';
}
function voText_(x, y, s, size, cls) {
  return '<text' + (cls ? ' class="' + cls + '"' : '') + ' x="' + voR_(x) + '" y="' + voR_(y) + '" font-size="' + (size || 30) +
         '" fill="' + VO_LABEL + '" text-anchor="middle" dominant-baseline="middle">' + s + '</text>';
}

/**
 * 正面の多角形 poly（[x,y] の列、反時計回り）を奥行き d だけ押し出した立体。
 * 上か右を向く面だけを描き、最後に正面を重ねる。
 * 上向きの面と右向きの面は画面上で重ならない。上向きどうしは高いほうが手前、右向きどうしは右のほうが手前。
 */
function voPrism_(v, poly, d) {
  var faces = [], n = poly.length;
  for (var i = 0; i < n; i++) {
    var a = poly[i], b = poly[(i + 1) % n];
    var nx = b[1] - a[1], ny = a[0] - b[0];   // 反時計回りの外向き法線
    if (nx <= 0 && ny <= 0) continue;
    // 手前ほど x・y が大きい。面の中心の (x·kx + y·ky) が小さい（奥の）面から描く
    faces.push({ up: ny > 0, at: ((a[0] + b[0]) / 2) * v.kx + ((a[1] + b[1]) / 2) * v.ky,
                 pts: [v.p(a[0], a[1], 0), v.p(b[0], b[1], 0), v.p(b[0], b[1], d), v.p(a[0], a[1], d)] });
  }
  // へこんだ形では、へこみの底や壁が手前の柱の奥に隠れる。奥の面から描いて上書きさせる
  faces.sort(function (p, q) { return p.at - q.at; });
  var body = faces.map(function (f) { return voPoly_(f.pts, f.up ? VO_FACE[1] : VO_FACE[2]); }).join('');
  return body + voPoly_(poly.map(function (q) { return v.p(q[0], q[1], 0); }), VO_FACE[0]);
}

/**
 * 長さの字だけを、辺 p→q の中点から図の外向き o（画面の単位ベクトル）へ dist 離して書く。
 * 外周の辺は字の位置だけで対応が分かるので、線は引かない（線を足すと図の辺と混ざる）。
 */
function voDim_(p, q, o, dist, str) {
  // 横へ出す字は字の幅ぶん、斜め（奥行き）はその中間だけ離す
  var k = Math.abs(o[0]) > 0.7 ? 34 : o[0] !== 0 ? 26 : 12;
  return voText_((p[0] + q[0]) / 2 + o[0] * (dist + k), (p[1] + q[1]) / 2 + o[1] * (dist + k), str, 30);
}

function voCurve_(a, c, b) {
  return '<path d="M' + voR_(a[0]) + ' ' + voR_(a[1]) + ' Q' + voR_(c[0]) + ' ' + voR_(c[1]) + ' ' +
         voR_(b[0]) + ' ' + voR_(b[1]) + '" fill="none" stroke="' + VO_DIM +
         '" stroke-width="4" stroke-linecap="round"/>';
}

/**
 * へこみの深さ（縦の内側の辺 p→q）。中点から左上へ斜めに引き出し、図の上の外（y＝topY）に字を書く。
 * 縦に引き出すと、引き出し線そのものが長さ（辺）に見える。
 */
function voLeadUp_(p, q, topY, str) {
  var m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  var end = [m[0] - Math.max(60, (m[1] - topY) * 0.45), topY];
  return voCurve_(m, [end[0] + 12, m[1] - (m[1] - topY) * 0.25], end) + voText_(end[0], end[1] - 24, str, 30);
}

/** へこみの幅（横の内側の辺 p→q）。例外として図の中、辺のすぐ下に短い引き出し線つきで書く */
function voLeadDown_(p, q, str) {
  var m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], end = [m[0] + 16, m[1] + 34];
  return voCurve_(m, [m[0], m[1] + 28], end) + voText_(end[0] + 42, end[1], str, 30);
}

/** 奥行きの辺（右下）に対する外向き：辺の向き (cos30°, -sin30°) に垂直で下向き */
var VO_OUT_D = [0.5, 0.866];

/** 直方体 w×h×d の図と、たて（奥行き）・よこ・高さの3辺の長さ。labels は {w,h,d} の表示文字（空なら書かない） */
function voBoxFig_(w, h, d, labels, extra) {
  var v = voView_(w, h, d, 380);
  var body = voPrism_(v, [[0, 0], [w, 0], [w, h], [0, h]], d);
  if (labels.w) body += voDim_(v.p(0, 0, 0), v.p(w, 0, 0), [0, 1], 16, labels.w);
  if (labels.h) body += voDim_(v.p(0, 0, 0), v.p(0, h, 0), [-1, 0], 16, labels.h);
  if (labels.d) body += voDim_(v.p(w, 0, 0), v.p(w, 0, d), VO_OUT_D, 16, labels.d);
  return voSvg_(v.W, v.H, body + (extra ? extra(v) : ''));
}

/* ============================================================
 *  ① つみき
 * ============================================================ */

/** a×b×c に積んだ立方体の、見えている数（手前・上・右の3面） */
function voVisible_(a, b, c) { return a * b * c - (a - 1) * (b - 1) * (c - 1); }

function voBlocks_(rand) {
  var a, b, c;
  do { a = ri_(rand, 2, 5); b = ri_(rand, 2, 4); c = ri_(rand, 2, 4); } while (a * b * c < 10 || a * b * c > 99);
  var v = voView_(a, c, b, 360), body = voPrism_(v, [[0, 0], [a, 0], [a, c], [0, c]], b), grid = '';
  function ln(p, q) { grid += 'M' + voR_(p[0]) + ' ' + voR_(p[1]) + 'L' + voR_(q[0]) + ' ' + voR_(q[1]); }
  var i;
  for (i = 1; i < a; i++) { ln(v.p(i, 0, 0), v.p(i, c, 0)); ln(v.p(i, c, 0), v.p(i, c, b)); }
  for (i = 1; i < c; i++) { ln(v.p(0, i, 0), v.p(a, i, 0)); ln(v.p(a, i, 0), v.p(a, i, b)); }
  for (i = 1; i < b; i++) { ln(v.p(0, c, i), v.p(a, c, i)); ln(v.p(a, 0, i), v.p(a, c, i)); }
  body += '<path d="' + grid + '" stroke="' + VO_LINE + '" stroke-width="3" fill="none"/>';
  return {
    t: 'A', q: ['1cm³の つみきは', 'なんこ？'], f: ['こ'], ans: { 'こ': a * b * c },
    tag: 'A:' + a + 'x' + b + 'x' + c + ' みえる' + voVisible_(a, b, c),
    fig: voSvg_(v.W, v.H, body)
  };
}

/* ============================================================
 *  ② こうしき
 * ============================================================ */

function voCuboid_(rand) {
  var w, h, d;
  do { w = ri_(rand, 3, 12); h = ri_(rand, 2, 10); d = ri_(rand, 2, 9); }
  while (w * h * d < 100 || w * h * d > 999 || w === h || h === d || w === d);
  return {
    t: 'B', q: ['たいせきは'], f: ['cm³'], ans: { 'cm³': w * h * d },
    tag: 'B:よこ' + w + ' たて' + d + ' たかさ' + h,
    fig: voBoxFig_(w, h, d, { w: w + 'cm', h: h + 'cm', d: d + 'cm' })
  };
}

function voCube_(rand) {
  var e = ri_(rand, 5, 9);
  return {
    t: 'C', q: ['りっぽうたいの', 'たいせきは'], f: ['cm³'], ans: { 'cm³': e * e * e },
    tag: 'C:1ぺん' + e,
    fig: voBoxFig_(e, e, e, { w: e + 'cm' })
  };
}

/** 体積と2辺から残りの1辺。答えは 10〜30cm の2桁 */
function voInverse_(rand) {
  var x = ri_(rand, 10, 30), a = ri_(rand, 2, 9), b = ri_(rand, 2, 9), which = ri_(rand, 0, 2);
  // よこ・たて・たかさ の順。which の位置が求める辺
  var dims = which === 0 ? [x, a, b] : which === 1 ? [a, x, b] : [a, b, x];
  var V = a * b * x, lab = { w: dims[0] + 'cm', d: dims[1] + 'cm', h: dims[2] + 'cm' };
  var key = ['w', 'd', 'h'][which];
  lab[key] = '？';
  return {
    t: 'D', q: ['たいせき ' + V + 'cm³', '？は'], f: ['cm'], ans: { cm: x },
    tag: 'D:' + V + ' ' + a + 'x' + b,
    fig: voBoxFig_(dims[0], dims[2], dims[1], lab)
  };
}

/* ============================================================
 *  ③ たんい（4択）
 *  誤りの選択肢は誤概念ごとに1つ。並びは tag に残す
 * ============================================================ */

function voUnit_(rand) {
  var n = ri_(rand, 2, 9), k = ri_(rand, 0, 6), t, ask, right, wrong;
  switch (k) {
    case 0: t = 'E'; ask = ['1m³は', 'なんcm³？']; right = 1000000; wrong = [100, 10000, 1000]; break;
    case 1: t = 'E'; ask = [n + 'm³は', 'なんcm³？']; right = n * 1000000; wrong = [n * 100, n * 10000, n * 1000]; break;
    case 2: t = 'J'; ask = ['1Lは', 'なんcm³？']; right = 1000; wrong = [10, 100, 10000]; break;
    case 3: t = 'J'; ask = [n * 1000 + 'cm³は', 'なんL？']; right = n; wrong = [n * 10, n * 100, n * 1000]; break;
    case 4: t = 'K'; ask = ['1mLは', 'なんcm³？']; right = 1; wrong = [10, 100, 1000]; break;
    case 5: t = 'K'; ask = [n * 100 + 'mLは', 'なんcm³？']; right = n * 100; wrong = [n, n * 10, n * 1000]; break;
    default: t = 'N'; ask = ['1m³は', 'なんL？']; right = 1000; wrong = [10, 100, 1000000]; break;
  }
  var order = voShuffle_(rand, [right].concat(wrong));
  // 2×2 に並べる。横1列だと図が横長になり、数字が小さく縮む
  var W = 360, H = 140, body = '';
  order.forEach(function (val, i) {
    var x = (i % 2) * W, y = Math.floor(i / 2) * H;
    body += '<g data-pick="' + (i + 1) + '">' +
            '<rect class="pkb" x="' + (x + 20) + '" y="' + (y + 20) + '" width="' + (W - 40) + '" height="' + (H - 40) +
            '" rx="6" fill="#000" fill-opacity="0" stroke="' + VO_LINE + '" stroke-width="3"/>' +
            voText_(x + 64, y + H / 2, VO_MARK[i], 40) +
            voText_(x + W / 2 + 24, y + H / 2, String(val), 48, 'pkv') + '</g>';
  });
  return {
    t: t, q: ask, f: [''], ans: { '': order.indexOf(right) + 1 },
    tag: t + ':' + ask[0] + ' ' + order.join('-'),
    fig: voSvg_(W * 2, H * 2, body)
  };
}

/* ============================================================
 *  ④ ふくごう
 * ============================================================ */

/** L字：左が高い。分けて足す／大きく取って引く、の2通りで出せる */
function voLshape_(rand) {
  var W, H, w2, h1, d, V;
  do {
    W = ri_(rand, 6, 12); H = ri_(rand, 5, 10); w2 = ri_(rand, 2, W - 3); h1 = ri_(rand, 2, H - 3); d = ri_(rand, 2, 6);
    V = d * (w2 * H + (W - w2) * h1);
  } while (V < 100 || V > 999);
  var poly = [[0, 0], [W, 0], [W, h1], [w2, h1], [w2, H], [0, H]];
  var v = voView_(W, H, d, 380), body = voPrism_(v, poly, d);
  var top = d * v.ky * v.s;   // 上面が正面より上へはみ出す高さ
  body += voDim_(v.p(0, 0, 0), v.p(W, 0, 0), [0, 1], 16, W + 'cm') +
          voDim_(v.p(0, 0, 0), v.p(0, H, 0), [-1, 0], 16, H + 'cm') +
          voDim_(v.p(0, H, 0), v.p(w2, H, 0), [0, -1], top + 16, w2 + 'cm') +
          voDim_(v.p(W, 0, d), v.p(W, h1, d), [1, 0], 16, h1 + 'cm') +
          voDim_(v.p(W, 0, 0), v.p(W, 0, d), VO_OUT_D, 16, d + 'cm');
  return {
    t: 'F', q: ['たいせきは'], f: ['cm³'], ans: { 'cm³': V },
    tag: 'F:よこ' + W + ' たかさ' + H + ' うえ' + w2 + ' だん' + h1 + ' おく' + d,
    fig: voSvg_(v.W, v.H, body)
  };
}

/** 凹字：上のまん中をへこませた形。大きく取って引くのが近道 */
function voNotch_(rand) {
  var W, H, n, m, x0, d, V;
  do {
    W = ri_(rand, 7, 12); H = ri_(rand, 4, 9); n = ri_(rand, 2, W - 4); m = ri_(rand, 2, H - 2);
    x0 = ri_(rand, 2, W - n - 2); d = ri_(rand, 2, 6);
    V = d * (W * H - n * m);
  } while (V < 100 || V > 999);
  var poly = [[0, 0], [W, 0], [W, H], [x0 + n, H], [x0 + n, H - m], [x0, H - m], [x0, H], [0, H]];
  var v = voView_(W, H, d, 380, 90), body = voPrism_(v, poly, d);
  // へこみの幅と深さは図の内側の辺なので、引き出し線（学年の色）で示す。
  // 深さは左の壁の中点から左上へ斜めに図の外へ、幅は底の辺のすぐ下（図の中）へ
  var topY = v.p(0, H, d)[1] - 16;
  body += voDim_(v.p(0, 0, 0), v.p(W, 0, 0), [0, 1], 16, W + 'cm') +
          voDim_(v.p(0, 0, 0), v.p(0, H, 0), [-1, 0], 16, H + 'cm') +
          voLeadDown_(v.p(x0, H - m, 0), v.p(x0 + n, H - m, 0), n + 'cm') +
          voLeadUp_(v.p(x0, H - m, 0), v.p(x0, H, 0), topY, m + 'cm') +
          voDim_(v.p(W, 0, 0), v.p(W, 0, d), VO_OUT_D, 16, d + 'cm');
  return {
    t: 'G', q: ['たいせきは'], f: ['cm³'], ans: { 'cm³': V },
    tag: 'G:よこ' + W + ' たかさ' + H + ' へこみ' + n + 'x' + m + ' おく' + d,
    fig: voSvg_(v.W, v.H, body)
  };
}

/* ============================================================
 *  ⑤ ようせき（厚さ1cmの板で作った、ふたの無い入れ物）
 * ============================================================ */

/** 外のり w×h×d の箱。上の口に内のりの縁を描き、「あつさ1cm」と書く */
function voTubFig_(w, h, d) {
  return voBoxFig_(w, h, d, { w: w + 'cm', h: h + 'cm', d: d + 'cm' }, function (v) {
    var rim = [v.p(1, h, 1), v.p(w - 1, h, 1), v.p(w - 1, h, d - 1), v.p(1, h, d - 1)];
    return voPoly_(rim, 'rgba(0,0,0,.35)', VO_INK, 3) +
           voText_(v.W / 2, 28, 'いたの あつさ 1cm', 28);
  });
}

function voCapacity_(rand) {
  var a, b, c;   // 内のり（よこ・たて・深さ）
  do { a = ri_(rand, 4, 12); b = ri_(rand, 3, 10); c = ri_(rand, 3, 10); } while (a * b * c < 100 || a * b * c > 999);
  var w = a + 2, d = b + 2, h = c + 1;
  return {
    t: 'H', q: ['ようせきは'], f: ['cm³'], ans: { 'cm³': a * b * c },
    tag: 'H:そと' + w + 'x' + d + 'x' + h + ' そとのせき' + w * d * h,
    fig: voTubFig_(w, h, d)
  };
}

/** 内のりの積が 1000 の倍数（1〜9L）になる組 */
var VO_LITER_ = (function () {
  var s = [5, 10, 15, 20, 25, 30, 40], out = [];
  s.forEach(function (a) { s.forEach(function (b) { s.forEach(function (c) {
    var p = a * b * c;
    if (p % 1000 === 0 && p / 1000 >= 1 && p / 1000 <= 9) out.push([a, b, c]);
  }); }); });
  return out;
})();

function voLiter_(rand) {
  var t = pick_(rand, VO_LITER_), a = t[0], b = t[1], c = t[2];
  var w = a + 2, d = b + 2, h = c + 1;
  return {
    t: 'I', q: ['ようせきは', 'なんL？'], f: ['L'], ans: { L: a * b * c / 1000 },
    tag: 'I:そと' + w + 'x' + d + 'x' + h,
    fig: voTubFig_(w, h, d)
  };
}

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['volume'];

// ===== apps/grade3/weight/Unit.gs =====
/**
 * Unit.gs — おもさ（g・kg の換算、たし算・ひき算）
 * 3年「重さ」に対応する。
 */

// 単元の登録。1つの GAS に全単元をまとめても名前がぶつからないよう、UNIT_DEFS['<id>'] に置く。
// 下の行（ファイルの最後）で、単元が1つだけのプロジェクトでは UNIT にもなる（今までの設置と同じに動く）。
var UNIT_DEFS = UNIT_DEFS || {};
UNIT_DEFS['weight'] = {
  id: 'weight',
  grade: 3,                 // 学年（1〜6）。置き場 apps/grade3/ と一致させる（tests/contract が照合する）
  title: 'おもさ タイムアタック！',
  teacherTitle: 'おもさ 設定・分析',

  defaults: {
    dial_size: 64,      // はかりの文字盤・拡大窓の大きさの上限（画面の高さに対する%）
    // 最初のメニューの背景に敷く「成長する図形」（九九と同じ仕組み。docs/ARCHITECTURE.md「背景の床」）
    floor_on: 1,
    floor_per_answer: 0.75
  },

  /** 表示だけの設定。出題（dial の max / step / at）には触れない */
  settings: [
    { key: 'dial_size', label: 'はかりの大きさ',
      note: '画面の高さに対する%の上限。20〜70。既定では画面の空き高さのほうが先に効くので、'
          + '小さくしたいときだけ下げる。既存の設定が44のままだと図が縮むので64に上げる',
      min: 20, max: 70, step: 2 },
    { key: 'floor_on', label: 'メニューの背景の図形', type: 'onoff',
      note: '正答を重ねるほど育つ模様。表示しないと無地になる' },
    { key: 'floor_per_answer', label: '1正答あたりの図形の育ち',
      note: '1分に20問解ける速さの問題を1問正解したときに増えるタイルの枚数。解きにくい問題（1分で解ける数が少ない）ほど1問で多く育つ（速さはこのサイトの記録から自動で出す）。0.75 なら、1分20問の速さでおよそ6,600問で全部そろう',
      min: 0.05, max: 10, step: 0.05 }
  ],

  /**
   * 床の図形と第二の色。このサイトは円弧の曼荼羅（正方形のマスに四分円の弧、4回対称）。
   * 台帳は design リポジトリの growing-figures/COLORS.md
   */
  floorPattern: 'mandala',
  floorColor: 'amethyst',

  /** 出題に出る単位と、その表示色（空文字は既定のグレー） */
  units: { kg: '#F1B1E4', g: '' },

  modes: [
    { id: 1, name: 'かんさん きほん',   desc: '3kg=□g ／ 5000g=□kg' },
    { id: 2, name: 'かんさん ぜんぶ',   desc: '1200g=□kg□g もあり' },
    { id: 3, name: 'けいさん たしざん', desc: '1kg300g + 500g' },
    { id: 4, name: 'けいさん ひきざん', desc: '2kg100g − 1kg700g' },
    { id: 5, name: 'めもり きほん', wide: true,     desc: '1kgのはかり（1目もり5g）' },
    { id: 6, name: 'めもり ぜんぶ', wide: true,     desc: '2kgのはかり（1目もり10g）' }
  ],

  types: {
    C: 'kg→g', D: 'g→kg', A: 'g→kg g', B: 'kg g→g',
    E: 'たしざん', F: 'ひきざん',
    G: 'めもり 1kg', H: 'めもり 2kg'
  },

  /**
   * 自動確定に使う桁数（宣言のみ。この問題の答え(ans)は参照しない）。
   * 問題型ごとに宣言する。モードキーにすると「かんさん ぜんぶ」で
   * A の g（kg g の下位、3桁）と B・C の g（合計、4桁）が同じ g キーで衝突し、
   * どちらかが必ず壊れる。型キーならこの衝突は起きない。
   * 値は gen の値域設計から一意に決まる（下の item を参照）。
   */
  digitCap: {
    C: { g: 4 },            // k*1000（k=1〜9） → 1000〜9000 で常に4桁
    D: { kg: 1 },           // k（1〜9） → 常に1桁
    A: { kg: 1, g: 3 },     // kg=1〜9、g=100〜900（100の倍数）
    B: { g: 4 },            // k*1000+m（m=100〜900） → 1100〜9900 で常に4桁
    E: { kg: 1, g: 3 },     // 繰り上がり後も kg=1〜9、g部は0を避けた100〜900
    F: { kg: 1, g: 3 },     // kg=0〜4（0も1桁）、g部は100〜900
    G: { g: 3 },            // 1kgのはかり：100〜980g に限るので常に3桁
    H: { kg: 1, g: 3 }      // 2kgのはかり：kg=1、g部は110〜990
  },

  tips:
    '<b>weak_child</b>：児童ごと・問題型ごとの平均想起時間(秒)＝出題から<b>最初のキーを押すまで</b>。<br>' +
    '打鍵の時間を含まないので、答えの桁数が違う型どうしを並べて比べてよい' +
    '（kg→g は4桁、g→kg は1桁なので、送信までの時間で比べると桁数の差がそのまま乗る）。<br>' +
    '・kg→g と g→kg だけ遅い → 1000倍の関係そのものが未定着<br>' +
    '・g→kg g が遅い → 位取りで分ける操作につまずいている<br>' +
    '・たしざんよりひきざんが極端に遅い → 繰り下がりが課題<br>' +
    '・平均は基準内なのに<b>ゆらぎ</b>が大きい → 覚えている時と数えている時が混ざっている。' +
    '平均だけを見ていると素通りする層で、必要なのは手続きの練習ではなく想起の練習<br><br>' +
    '<b>weak_class</b> の下段が<b>よくある誤答の一覧</b>。' +
    '1200g を「12kg 0g」とする<b>1000倍のずれ</b>や、' +
    '3kg50g を「350」とする<b>位取りの崩れ</b>が、実際の答えとして見える。',

  /** めもりは合計で判定する（1kg500g も 1500 も正解にする） */
  byTotal: function (item) { return item.t === 'G' || item.t === 'H'; },
  /** 合計判定に使う換算率（g 換算）。児童画面にもそのまま渡る */
  scale: { kg: 1000, g: 1 },

  /** weak_class / mistakes で「1/200」を「1kg200g」のように単位つきで表示するための単位マップ */
  fieldsByType: {
    C: ['g'], D: ['kg'], A: ['kg', 'g'], B: ['g'],
    E: ['kg', 'g'], F: ['kg', 'g'],
    G: ['g'], H: ['kg', 'g']
  },

  gen: function (rand, mode) {
    var pool;
    if (mode === 1) pool = ['C', 'D'];
    else if (mode === 2) pool = ['A', 'B', 'C', 'D'];
    else if (mode === 3) pool = ['E'];
    else if (mode === 4) pool = ['F'];
    else if (mode === 5) pool = ['G'];
    else pool = ['H'];
    return this.item(rand, pick_(rand, pool));
  },

  item: function (rand, type) {
    var k, m, m2, sum, a, b, res;

    if (type === 'C') {                        // 3kg = □g
      k = ri_(rand, 1, 9);
      return { t: 'C', q: [String(k), 'kg'], f: ['g'], ans: { g: k * 1000 }, tag: k + 'kg' };
    }
    if (type === 'D') {                        // 5000g = □kg
      k = ri_(rand, 1, 9);
      return { t: 'D', q: [String(k * 1000), 'g'], f: ['kg'], ans: { kg: k }, tag: (k * 1000) + 'g' };
    }
    if (type === 'A') {                        // 1200g = □kg□g（g部は3桁固定＝桁数が漏れない）
      k = ri_(rand, 1, 9); m = ri_(rand, 1, 9) * 100;
      return { t: 'A', q: [String(k * 1000 + m), 'g'], f: ['kg', 'g'],
               ans: { kg: k, g: m }, tag: (k * 1000 + m) + 'g' };
    }
    if (type === 'B') {                        // 1kg500g = □g（答えは常に4桁）
      k = ri_(rand, 1, 9);
      m = pick_(rand, [100, 200, 300, 400, 500, 600, 700, 800, 900]);
      return { t: 'B', q: [String(k), 'kg', String(m), 'g'], f: ['g'],
               ans: { g: k * 1000 + m }, tag: k + 'kg' + m + 'g' };
    }
    if (type === 'G') {                        // 1kgのはかり。1目もり5g、100gごとに数字
      // 100〜980g に限るのは、1〜2桁の答えを混ぜると桁数が定まらず自動確定できないため。
      // 教科書のはかりに合わせて、1目もりは5g（0gと100gの間に20目もり）。
      var g1 = ri_(rand, 20, 196) * 5;
      return { t: 'G',
               dial: { max: 1000, step: 5, label: 100, at: g1,
                       unit: 'g', big: 1000, bigUnit: 'kg' },
               q: [], f: ['g'], ans: { g: g1 }, tag: g1 + 'g' };
    }
    if (type === 'H') {                        // 2kgのはかり。1目もり10g、200gごとに数字
      // 1kgを超えた位置だけを出し「何kg何g」で答えさせる。kg欄は常に1になるが、
      // 2kgのはかりで1kg超を読めば必ずそうなる（教科書の問題も 1kg200g / 1kg500g）。
      // 答えの桁数を揃えるため g部は110〜990に限る。
      var g2 = ri_(rand, 11, 99) * 10;
      return { t: 'H',
               dial: { max: 2000, step: 10, label: 200, at: 1000 + g2,
                       unit: 'g', big: 1000, bigUnit: 'kg' },
               q: [], f: ['kg', 'g'], ans: { kg: 1, g: g2 }, tag: (1000 + g2) + 'g' };
    }
    if (type === 'E') {                        // 1kg300g + 500g = □kg□g
      k = ri_(rand, 1, 8); m = ri_(rand, 1, 9) * 100; m2 = ri_(rand, 1, 9) * 100;
      sum = k * 1000 + m + m2;
      if (sum % 1000 === 0) { m2 += 100; sum += 100; }      // g部が0になるのを避ける
      return { t: 'E', q: [String(k), 'kg', String(m), 'g', '+', String(m2), 'g'],
               f: ['kg', 'g'], ans: { kg: Math.floor(sum / 1000), g: sum % 1000 },
               tag: k + 'kg' + m + 'g+' + m2 + 'g' };
    }

    // F: ひきざん。答えを先に決めてから引く数を作る。
    // 引かれる数を先に決めると、答えの kg 部が 0〜1 に偏る。
    // res(答えのg部)は100〜4900、b(引く数)は1100〜4900なので a=res+bは常に1200〜9800。
    // 桁あふれ・繰り上がりは値域の設計自体で構造的に起きない（到達しない補正は置かない）。
    res = ri_(rand, 0, 4) * 1000 + ri_(rand, 1, 9) * 100;
    b = ri_(rand, 1, 4) * 1000 + ri_(rand, 1, 9) * 100;
    a = res + b;

    var qa = (a % 1000 === 0) ? [String(a / 1000), 'kg']
           : [String(Math.floor(a / 1000)), 'kg', String(a % 1000), 'g'];
    var qb = (b % 1000 === 0) ? [String(b / 1000), 'kg']
           : [String(Math.floor(b / 1000)), 'kg', String(b % 1000), 'g'];
    return { t: 'F', q: qa.concat(['-'], qb), f: ['kg', 'g'],
             ans: { kg: Math.floor((a - b) / 1000), g: (a - b) % 1000 },
             tag: a + '-' + b };
  }
};

// 単元が1つだけのプロジェクト・テスト・プレビューでは、この単元が UNIT になる。
// 全単元をまとめたプロジェクトでは、呼び出しごとに Core が UNIT を差し替える。
var UNIT = UNIT || UNIT_DEFS['weight'];

return {
  "doGet": (typeof doGet === 'function' ? doGet : undefined),
  "apiCall": (typeof apiCall === 'function' ? apiCall : undefined),
  "setup": (typeof setup === 'function' ? setup : undefined),
  "nightly": (typeof nightlyAggregateAll === 'function' ? nightlyAggregateAll : undefined),
  "daily": (typeof resetDailyAll === 'function' ? resetDailyAll : undefined),
  "rollover": (typeof rolloverRosterAll === 'function' ? rolloverRosterAll : undefined),
  "continueAll": (typeof continueAll === 'function' ? continueAll : undefined),
  "sessionSources": (typeof lbSessionSources_ === 'function' ? lbSessionSources_ : undefined),
  "writeForUnit": (typeof lbWriteForUnit_ === 'function' ? lbWriteForUnit_ : undefined)
};
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
  /** 学習BASE の画面から呼べる関数（lbCall の mod・name）。ここに無いものは呼べない */
  var API = {
    home: { boot: function (o) { return LbHome.boot(o); }, setPublish: function (k, p, on) { return LbHome.setPublish(k, p, on); },
      resetPublish: function (k) { return LbHome.resetPublish(k); }, setNow: function (k, l) { return LbHome.setNow(k, l); } }
  };

  function doGet(e) {
    var p = (e && e.parameter) || {};
    var app = p.app || (p.unit ? 'tamath' : '');
    if (p.doc && !app) return message('このページは じゅんび中です');
    if (app) {
      var m = LB_MODULES[app];
      if (!m) return message('アプリが見つかりません: ' + app);
      LB_LOADER.files();                      // アプリの画面のファイルを読む（LB_FILES）
      return m.doGet(e);
    }
    return homePage();
  }

  function call(mod, name, args) {
    var api = API[String(mod)];
    if (!api || !Object.prototype.hasOwnProperty.call(api, String(name))) throw new Error('呼べない関数です: ' + mod + '.' + name);
    return api[name].apply(null, Array.isArray(args) ? args : []);
  }
  function appApi(app, unit, name, args) {
    var m = LB_MODULES[app];
    if (!m || !m.apiCall) throw new Error('アプリが見つかりません: ' + app);
    return m.apiCall(unit, name, args);
  }

  /** 自動実行：各アプリの夜・朝の処理。1つのアプリが失敗しても他は続ける */
  function each(job) {
    var errs = [];
    Object.keys(LB_MODULES).forEach(function (k) {
      var m = LB_MODULES[k];
      if (typeof m[job] !== 'function') return;
      try { m[job](); } catch (e) { errs.push(k + ': ' + (e && e.message || e)); console.error(job + ' ' + k + ' 失敗: ' + (e && e.message || e)); }
    });
    return errs;
  }
  /** 全アプリの新しい形の記録を「児童×技能×週」に足す（ハブの facts_<年度>）。時間切れなら残りは次の夜 */
  function facts() {
    var sources = [];
    Object.keys(LB_MODULES).forEach(function (k) {
      var m = LB_MODULES[k];
      if (typeof m.sessionSources === 'function') { try { sources = sources.concat(m.sessionSources()); } catch (e) { console.error(k + ' の記録先: ' + e.message); } }
    });
    if (!sources.length) return [];
    try { var r = LbFacts.ingest(Base.hub(), sources); console.log('集計：' + r.read + ' 行' + (r.more ? '（続きは次回）' : '')); return []; }
    catch (e) { console.error('集計 失敗: ' + e.message); return ['facts: ' + e.message]; }
  }

  function setup() {
    return Object.keys(LB_MODULES).map(function (k) {
      var m = LB_MODULES[k];
      if (typeof m.setup !== 'function') return k + '：準備は要らない';
      try { return k + '：' + m.setup(); } catch (e) { return k + '：× ' + e.message; }
    }).join('\n');
  }

  /** 学習BASE のホーム。画面のプログラムは jsDelivr から（読み込み係と同じ版） */
  function homePage() {
    var base = 'https://cdn.jsdelivr.net/gh/' + LB_LOADER.repo + '@' + LB_LOADER.ver() + '/web/';
    var url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
    var html = '<!DOCTYPE html><html lang="ja"><head><base target="_top"><meta charset="utf-8">' +
      '<link rel="stylesheet" href="' + base + 'home.css"></head><body style="margin:0;background:#fff">' +
      '<main id="lb" class="lb"><div class="lb-msg">よみこみ中…</div></main>' +
      '<script>' + platformScript(url) + '<\/script>' +
      '<script src="' + base + 'pages.js" onerror="lbLoadFail()"><\/script>' +
      '<script src="' + base + 'home.js" onerror="lbLoadFail()"><\/script></body></html>';
    return HtmlService.createHtmlOutput(html).setTitle('学習BASE').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  /** 画面の Platform 層（本番）：google.script.run.lbCall を Promise にする */
  function platformScript(baseUrl) {
    return 'window.LB_PLATFORM={baseUrl:' + JSON.stringify(baseUrl) + ',' +
      'call:function(name){var a=Array.prototype.slice.call(arguments,1);' +
      'var map={homeBoot:"boot",homeSetPublish:"setPublish",homeResetPublish:"resetPublish",homeSetNow:"setNow"};' +
      'return new Promise(function(ok,ng){google.script.run.withSuccessHandler(ok).withFailureHandler(ng).lbCall("home",map[name]||name,a);});},' +
      'fetchJson:function(u){return fetch(u).then(function(r){if(!r.ok)throw new Error("目録 "+r.status);return r.json();});},' +
      'open:function(u){window.open(u,"_top");}};' +
      'function lbLoadFail(){var m=document.getElementById("lb");if(m)m.innerHTML=\'<div class="lb-msg" style="padding:24px;font-size:20px">いま ひらけません。すこし まってから、ページを ひらきなおしてね。</div>\';}';
  }
  function message(text) {
    return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width, initial-scale=1"><div lang="ja" style="font-family:\'BIZ UDPGothic\',\'Noto Sans CJK JP\',sans-serif;font-size:20px;padding:24px">' +
      String(text).replace(/[<>&]/g, '') + '</div>').setTitle('学習BASE');
  }

  return { doGet: doGet, call: call, appApi: appApi, setup: setup,
    nightly: function () { var e = each('nightly'); return e.concat(facts()); }, daily: function () { return each('daily'); },
    rollover: function () { return each('rollover'); }, continueAll: function () { return each('continueAll'); } };
})();
