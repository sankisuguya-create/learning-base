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
    var t0 = Date.now(), out = bootInner(opt), ev = ['boot', LbTune.speed('srv', Date.now() - t0)];
    if (Number(opt.lastMs) > 0) ev.push(LbTune.speed('rt', opt.lastMs));   // 前回開いた時の往復（画面が覚えて次に送る。呼び出しを増やさない）
    LbTune.count(out.role, ev);
    return out;
  }
  function bootInner(opt) {
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
      out.owner = isOwnerView();
      var pick = cls.filter(function (x) { return x.key === opt.classKey; })[0] || cls[0];
      if (pick) {
        out.classKey = pick.key;
        out.settings = LbPages.readSettings(Base.hub(), pick.key);
        var code = {};
        try { code = LbTune.codeOf(Base.hub(), Base.fy()); } catch (e) { code = {}; }
        out.members = Base.members(pick.grade, pick.cls).map(function (r) {
          return { lid: r.lid, no: r.no, name: r.name, code: code[r.lid] || '', provisional: !!r.provisional };
        });
        try { out.now3 = now3(pick.key); } catch (e) { out.now3 = []; console.error('今週の3件を読めません: ' + e.message); }
      }
      return out;
    }
    out.message = m.role === 'none' ? '学校のアカウントで ひらいてください' : 'なまえが まだ とうろく されていません。せんせいに つたえてね';
    return out;
  }

  /** 今週の3件（名前・技能の名前・根拠の一文を付ける）。名前は教師にだけ渡す。codes は「名前をかくす」の時に出す記号 */
  function now3(classKey) {
    var hub = Base.hub(), cats = LbCatalog.readAll(hub), code = {};
    try { code = LbTune.codeOf(hub, Base.fy()); } catch (e) { code = {}; }
    return LbAlerts.read(hub, classKey).map(function (x) {
      var cat = cats[x.app], sk = cat ? LbCatalog.index(cat)[x.skill] : null;
      return { key: x.key, kind: x.kind, label: LbAlerts.LABEL[x.kind] || x.kind, skill: sk ? sk.label : x.skill, app: cat ? cat.title : x.app,
        names: x.lids.map(function (l) { var r = Base.learner(l); return r ? r.name : '（名簿にない）'; }),
        codes: x.lids.map(function (l) { return code[l] || '？'; }), text: LbAlerts.describe(x) };
    });
  }
  /** 判断の記録（判断が変わった／見た）。押した項目は今週の3件から消える */
  function decide(classKey, key, action, memo) {
    var m = requireClass(classKey);
    var item = LbAlerts.read(Base.hub(), classKey).filter(function (x) { return x.key === String(key); })[0];
    if (!item) throw new Error('もう ない項目です（ページを開き直してください）');
    LbAlerts.decide(Base.hub(), classKey, item, action === 'changed' ? 'changed' : 'seen', memo, m.email);
    LbTune.count('teacher', 'act:decide-' + (action === 'changed' ? 'changed' : 'seen'));
    return now3(classKey);
  }

  function setPublish(classKey, pageId, on) {
    var m = requireClass(classKey);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(pageId))) throw new Error('ページの名前が不正です');
    LbPages.setPublish(Base.hub(), classKey, String(pageId), !!on, m.email);
    LbTune.count('teacher', 'act:' + (on ? 'show' : 'hide'));
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
    LbTune.count('teacher', 'act:now');
    return LbPages.readSettings(Base.hub(), classKey);
  }

  /* ---------- 直すための材料（Tune.gs） ---------- */

  /** 所有者が開いているか（「自分として実行」では、開いた人＝所有者の時だけ getActiveUser と getEffectiveUser が同じ） */
  function isOwnerView() {
    try {
      var a = String(Session.getActiveUser().getEmail() || '').toLowerCase(), e = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
      return !!a && a === e;
    } catch (err) { return false; }
  }
  /** 先生の気づき（学習BASE の使い勝手・今週の3件の当たり外れ）。ハブの feedback シートに1行 */
  function feedback(classKey, view, text) {
    var m = Base.me();
    if (m.role !== 'teacher') throw new Error('先生だけが送れます');
    var ck = '';
    if (classKey) { requireClass(classKey); ck = String(classKey); }
    LbTune.saveFeedback(Base.hub(), m.email, ck, view, text);
    LbTune.count('teacher', 'act:feedback');
    return true;
  }
  /** 画面の失敗を数える（画面のファイルが読めない・ホームの情報が取れない・目録が取れない） */
  var REPORT = { loadfail: 1, bootfail: 1, catfail: 1 };
  function report(kind) {
    if (!REPORT[kind]) return false;
    var role = '-';
    try { role = Base.me().role; } catch (e) {}
    LbTune.count(role, 'client:' + kind);
    return true;
  }
  /** 改善用の書き出し（所有者だけ）。{ ok, text, problems, notes } */
  function exportForTuning() {
    if (!isOwnerView()) throw new Error('改善用の書き出しは、スプレッドシートの所有者だけが使えます');
    var hub = Base.hub(), fy = Base.fy(), roster = Base.roster(), t = today();
    var settings = classesFor(String(Session.getActiveUser().getEmail() || '').toLowerCase()).map(function (c) {
      var st = LbPages.readSettings(hub, c.key), hidden = 0;
      Object.keys(st.publish || {}).forEach(function (k) { if (st.publish[k] === false) hidden++; });
      return { classKey: c.key, hidden: hidden, now: (st.now || []).filter(function (n) { return LbPages.inPeriod(n, t); }).length };
    });
    var ver = '';
    try { ver = typeof LB_LOADER !== 'undefined' ? LB_LOADER.ver() : ''; } catch (e) {}
    var r = LbTune.exportText({ hub: hub, fy: fy, today: t, ver: ver, roster: roster, teachers: Base.teachers(), acc: LbFacts.read(hub, fy), cats: LbCatalog.readAll(hub), settings: settings });
    LbTune.count('teacher', 'act:export');
    return r;
  }

  return { boot: boot, feedback: feedback, report: report, exportForTuning: exportForTuning, isOwnerView: isOwnerView, decide: decide, now3: now3, setPublish: setPublish, resetPublish: resetPublish, setNow: setNow, classesFor: classesFor, pagesUrl: pagesUrl };
})();

/* 画面（google.script.run）から呼ぶ入口 */
function homeBoot(opt) { return LbHome.boot(opt); }
function homeSetPublish(classKey, pageId, on) { return LbHome.setPublish(classKey, pageId, on); }
function homeResetPublish(classKey) { return LbHome.resetPublish(classKey); }
function homeSetNow(classKey, list) { return LbHome.setNow(classKey, list); }
function homeDecide(classKey, key, action, memo) { return LbHome.decide(classKey, key, action, memo); }
function homeFeedback(classKey, view, text) { return LbHome.feedback(classKey, view, text); }
function homeReport(kind) { return LbHome.report(kind); }
function homeExport() { return LbHome.exportForTuning(); }
