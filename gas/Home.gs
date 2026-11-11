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
      var pick = cls.filter(function (x) { return x.key === opt.classKey; })[0] || cls[0];
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
  var API = { boot: boot, beat: beat, setLink: setLink, decide: decide, setPublish: setPublish, resetPublish: resetPublish, setNow: setNow, setOrder: setOrder, setColor: setColor,
    feedback: feedback, report: report, 'export': exportForTuning, tuning: tuning, tryRules: tryRules, saveRules: saveRules,
    direct: direct, endDirective: endDirective, seeResult: seeResult };

  return { API: API, boot: boot, feedback: feedback, report: report, exportForTuning: exportForTuning, isOwnerView: isOwnerView, tuning: tuning, tryRules: tryRules, saveRules: saveRules, decide: decide, now3: now3, setPublish: setPublish, resetPublish: resetPublish, setNow: setNow, classesFor: classesFor, pagesUrl: pagesUrl };
})();
