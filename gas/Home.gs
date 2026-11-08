/**
 * Home.gs — 学習BASE のホーム（児童・教師）の窓口
 *
 * 正本は learning-base。画面（web/home.js）が google.script.run で呼ぶ関数を持つ。
 * 名前が _ で終わらない大域の関数は画面から呼べる。ここに置くのは画面から呼んでよいものだけで、
 * 中で必ず「誰が開いたか」と「その学級を扱ってよいか」を確かめる。
 */
var LbHome = (function () {
  // ページの目録の置き場（公開リポジトリ）。版はスクリプトのプロパティ PAGES_VER で切り替える（コミットかタグ）
  var PAGES_REPO = 'sankisuguya-create/learning-base';
  var PAGES_PATH = 'catalog/pages.json';
  var PAGES_VER_DEFAULT = 'main';

  function today() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }
  function pagesUrl() {
    var v = String(PropertiesService.getScriptProperties().getProperty('PAGES_VER') || PAGES_VER_DEFAULT);
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
   * ホームを開いた時の情報。
   * - 児童：本人の名前・学年・学級と、学級の設定（公開・いまの学習）
   * - 教師：扱える学級の一覧、選んだ学級の設定と児童の一覧（代わりに取り組む児童を選ぶため）
   * - 名簿にない人：おためし（学年を選んで見られる。記録はしない）
   */
  function boot(opt) {
    opt = opt || {};
    var m = Base.me(), out = { role: m.role, today: today(), pagesUrl: pagesUrl(), subjects: LbPages.SUBJECTS };
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
