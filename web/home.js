/**
 * home.js — 学習BASE のホーム（学習BASE → 教科 → ページ）
 *
 * 正本は learning-base。jsDelivr から読み込む画面のプログラム。
 * サーバーとのやりとりは window.LB_PLATFORM に任せる（本番は GAS、見本は web/demo.html の模擬）。
 *   LB_PLATFORM.call(関数名, 引数…) → Promise   … homeBoot / homeSetPublish / homeResetPublish / homeSetNow
 *   LB_PLATFORM.fetchJson(url)       → Promise   … ページの目録（jsDelivr）
 *   LB_PLATFORM.open(url)                       … ページを開く
 *   LB_PLATFORM.baseUrl                         … 学習BASE の URL（…/exec）
 *
 * 児童の画面：いまの学習（教師が選んだ最大3件）を最上部に大きく、その下に教科。教科を押すと単元ごとのページ。
 * 教師の画面：同じ画面の上に帯（学級・先生モード・代わりに取り組む）。先生モードでは、児童が見るカードの上で
 *   公開（✓ みせる／✕ かくす）と いまの学習（★）を押して切り替える。押すたびに保存し、保存したら知らせる。
 *   名前をかくす：児童の名前を記号〔k3m〕で出す（画面を撮って AI に見せる時）。下に「学習BASE への気づき」、所有者には「改善用に書き出す」。
 */
(function () {
  'use strict';
  document.documentElement.lang = 'ja';
  var P = window.LB_PLATFORM;
  if (!window.LbPages) throw new Error('pages.js（Pages.gs の写し）を先に読み込んでください');
  var root = document.getElementById('lb');
  var S = { boot: null, cat: null, view: 'home', subject: null, edit: false, as: null, grade: 0, busy: false, hide: store('lb-hide') === '1', fb: '', exp: null };
  /** この端末だけの覚え（名前をかくす・前回の往復の時間）。使えない時（シークレットなど）は覚えないだけ */
  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, String(v)); } catch (e) { return null; }
    return null;
  }

  /* ---------- 教科の絵（線だけ。色では見分けない） ---------- */
  var ICONS = {
    kokugo: '<path d="M12 6h18l6 6v30H12z"/><path d="M30 6v6h6M18 20h12M18 26h12M18 32h8"/>',
    shakai: '<circle cx="24" cy="24" r="16"/><path d="M8 24h32M24 8c-6 6-6 26 0 32M24 8c6 6 6 26 0 32"/>',
    sansu: '<path d="M10 14h12M16 8v12M28 14h10M10 34h12M28 30h10M28 38h10M12 40l8-8M20 40l-8-8"/>',
    rika: '<path d="M19 6h10M21 6v12L10 38a3 3 0 003 4h22a3 3 0 003-4L27 18V6"/><path d="M15 30h18"/>',
    seikatsu: '<path d="M24 42V22M24 24c0-8-6-12-14-12 0 8 6 12 14 12zM24 28c0-8 6-12 14-12 0 8-6 12-14 12z"/>',
    ongaku: '<path d="M18 36V10l20-4v26"/><circle cx="13" cy="36" r="5"/><circle cx="33" cy="32" r="5"/>',
    zuko: '<path d="M24 8a16 16 0 100 32c3 0 3-4 1-6s0-6 4-6h5a6 6 0 006-6c0-8-7-14-16-14z"/><circle cx="16" cy="22" r="2.5"/><circle cx="22" cy="15" r="2.5"/><circle cx="31" cy="16" r="2.5"/>',
    katei: '<path d="M10 22h28v14a6 6 0 01-6 6H16a6 6 0 01-6-6zM6 22h36M18 14c0-3 2-3 2-6M26 14c0-3 2-3 2-6"/>',
    taiiku: '<circle cx="24" cy="24" r="16"/><path d="M14 12c6 6 6 18 0 24M34 12c-6 6-6 18 0 24"/>',
    gaikokugo: '<path d="M8 36l7-24 7 24M11 28h8M28 12h6a5 5 0 010 10h-6zM28 22h7a6 6 0 010 12h-7z"/>',
    dotoku: '<path d="M24 40S8 30 8 19a8 8 0 0116-2 8 8 0 0116 2c0 11-16 21-16 21z"/>',
    sogo: '<circle cx="21" cy="21" r="11"/><path d="M29 29l11 11"/>',
    other: '<circle cx="12" cy="24" r="3"/><circle cx="24" cy="24" r="3"/><circle cx="36" cy="24" r="3"/>'
  };
  function icon(id, cls) {
    return '<svg class="' + (cls || 'lb-ico') + '" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[id] || ICONS.other) + '</svg>';
  }
  /**
   * タイルの色（算数TA のハブ apps/hub/Code.gs の COLORS と同じ30色）。どのページを何色にするかは、
   * 先生がハブの links シートの color 列で選んだもの（児童が見慣れた色のまま探せる）。色だけで見分けさせない（題を必ず出す）
   */
  var TILE = {
    mint: ['#12C48B', '#052A1F'], blue: ['#2B4CF2', '#F0F3FF'], amber: ['#FFC400', '#2E2200'], red: ['#FF5C38', '#2C0A02'],
    purple: ['#6D4AE0', '#F3EEFF'], gray: ['#4A5568', '#EEF1F6'], lavender: ['#D3C9FB', '#1C152F'], olive: ['#696713', '#F6F6EB'],
    wine: ['#900D2A', '#F7F7F7'], cyan: ['#0DA2C6', '#1A1A1A'], rose: ['#DE5F99', '#2C101C'], teal: ['#13745F', '#EBF9F4'],
    brown: ['#964D0C', '#FEF3EC'], peach: ['#FCC1B6', '#2E100C'], lime: ['#9EB919', '#181E01'], aqua: ['#2CECF2', '#1A1A1A'],
    plum: ['#80146F', '#FCF1F9'], periwinkle: ['#6B89F9', '#121932'], ochre: ['#CB7E19', '#1A1A1A'], sky: ['#A8D8FB', '#001D2F'],
    orchid: ['#CE88F7', '#22132B'], peacock: ['#1C6E80', '#EBF8FC'], green: ['#057918', '#EFF8EF'], pink: ['#FEA4D2', '#2B101F'],
    mustard: ['#AA9117', '#1A1A1A'], leaf: ['#97EB79', '#0E2007'], apricot: ['#FDB171', '#2B1401'], coral: ['#FB8087', '#2E1012'],
    turquoise: ['#16A7A3', '#1A1A1A'], cobalt: ['#1468A3', '#EDF6FF']
  };
  /** ハブの links シートの行（ページの params.unit・linkId・id の順で探す） */
  function hubLink(p) {
    var L = (S.boot && S.boot.links) || {};
    return L[(p.params && p.params.unit) || ''] || L[p.linkId || ''] || L[p.id] || null;
  }
  function tileColor(p) { var h = hubLink(p), k = (h && h.color) || p.color || 'mint'; return TILE[k] || TILE.mint; }
  var PLAY = '<svg class="lb-btn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';

  /* ---------- 文字（学年で読み方を変える） ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function subjectInfo(id) { return (S.boot.subjects || []).filter(function (s) { return s.id === id; })[0] || { id: id, label: id, ruby: '', low: id }; }
  /** 教科名：1・2年はひらがな、3・4年はふりがな付き、5・6年は漢字だけ */
  function subjectName(s) {
    if (S.grade <= 2) return esc(s.low);
    if (S.grade <= 4) return '<ruby class="lb-rb">' + esc(s.label) + '<rt>' + esc(s.ruby) + '</rt></ruby>';
    return esc(s.label);
  }
  /** ページの題：1・2年は読み（ひらがな）を主に、3年は上に小さく読み、4年以上は題だけ */
  function pageTitle(p) {
    if (S.grade <= 2 && p.ruby) return '<span class="lb-title">' + esc(p.ruby) + '</span>';
    if (S.grade === 3 && p.ruby && p.ruby !== p.title) return '<span class="lb-title"><span class="lb-reading">' + esc(p.ruby) + '</span>' + esc(p.title) + '</span>';
    return '<span class="lb-title">' + esc(p.title) + '</span>';
  }
  /** 教科のタイルに出すページの題（1・2年は読み） */
  function directTitle(p) { return esc(S.grade <= 2 && p.ruby ? p.ruby : p.title); }
  function kindLabel(p) { return p.kind === 'app' ? (S.grade <= 2 ? 'れんしゅう' : '練習') : (S.grade <= 2 ? 'きょうざい' : '教材'); }

  /* ---------- 表示 ---------- */
  function settings() { return S.boot.settings || { publish: {}, now: [] }; }
  function home() { return LbPagesView.home(S.cat, S.grade, settings(), S.boot.today); }
  function isOn(p) { return LbPagesView.isOn(p, settings()); }
  function nowIds() { return (settings().now || []).filter(function (n) { return LbPagesView.inPeriod(n, S.boot.today); }).map(function (n) { return n.page; }); }
  // LbPagesView は下で window.LbPages を指す（関数の中でだけ使うので、宣言の位置は問題にならない）

  function render() {
    if (!S.boot) { root.innerHTML = '<div class="lb-msg">よみこみ中…</div>'; return; }
    if (S.boot.message && S.boot.role !== 'teacher') { root.innerHTML = top() + '<div class="lb-msg">' + esc(S.boot.message) + '</div>'; return; }
    if (!S.cat) { root.innerHTML = top() + '<div class="lb-msg">よみこみ中…</div>'; return; }
    root.classList.toggle('lb-edit', !!S.edit);
    root.innerHTML = top() + teacherBar() + (S.view === 'subject' ? subjectView() : homeView());
    if (S.view === 'subject') {
      loadMincho(Array.prototype.map.call(root.querySelectorAll('.lb-mincho'), function (e) { return e.textContent; }).join(''));
      fitTiles();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTiles);
    }
  }
  function top() {
    var who = '';
    if (S.boot.role === 'child') who = esc(S.boot.learner.mei || S.boot.learner.name) + ' さん';
    if (S.boot.role === 'teacher') who = '先生';
    return '<header class="lb-top"><h1 class="lb-brand">学習BASE</h1><span class="lb-who">' + who + '</span><span class="lb-spacer"></span></header>';
  }
  function teacherBar() {
    if (S.boot.role !== 'teacher') return '';
    var opts = (S.boot.classes || []).map(function (c) {
      return '<option value="' + esc(c.key) + '"' + (c.key === S.boot.classKey ? ' selected' : '') + '>' + esc(c.grade + '年' + c.cls + '組') + '</option>';
    }).join('');
    var mem = '<option value="">（先生として見る）</option>' + (S.boot.members || []).map(function (m) {
      return '<option value="' + esc(m.lid) + '"' + (S.as && S.as.lid === m.lid ? ' selected' : '') + '>' + esc(m.no + ' ' + who(m) + (m.provisional ? '（メールなし）' : '')) + '</option>';
    }).join('');
    var off = S.cat ? S.cat.pages.filter(function (p) { return p.grades.indexOf(S.grade) >= 0 && !isOn(p); }).length : 0;
    var status = S.edit ? '<span class="lb-tstatus">かくしている：' + off + '件　いまの学習：' + nowIds().length + '／3件</span>' +
      (off ? '<button class="lb-link" data-act="reset">ぜんぶ みせる に もどす</button>' : '') : '';
    var as = S.as ? '<div class="lb-as" role="status"><strong>代わりに取り組む：</strong>' + esc(who(S.as)) + '　の記録になります <button class="lb-link" data-act="as-clear">やめる</button></div>' : '';
    return '<div class="lb-tbar"><label>学級 <select id="lb-class" aria-label="学級">' + opts + '</select></label>' +
      '<button class="lb-toggle" data-act="edit" aria-pressed="' + S.edit + '">先生モード</button>' +
      '<button class="lb-toggle" data-act="hide" aria-pressed="' + S.hide + '">名前をかくす</button>' +
      (canActAs() ? '<label>代わりに取り組む <select id="lb-as" aria-label="代わりに取り組む児童">' + mem + '</select></label>' : '') + status + '</div>' + as;
  }
  /**
   * 代わりに取り組む（児童の記録にする）に対応しているページ（目録の actAs: true）が1つでもある時だけ、欄を出す。
   * 対応していないページを「〇〇の記録になります」と言って開くと、実際には記録されず、気づかないまま記録が欠けるため
   */
  /** 児童の名前（名前をかくす時は記号。記号がまだ無い児童は「？」：記号は改善用の書き出しを1回すると全員に付く） */
  function who(m) { return S.hide ? '〔' + (m.code || '？') + '〕' : m.name; }
  function canActAs() { return !!(S.cat && S.cat.pages.some(function (p) { return p.actAs === true; })); }
  function chips(p) {
    if (!S.edit) return '';
    var on = isOn(p), star = nowIds().indexOf(p.id) >= 0;
    return '<span class="lb-chips"><button class="lb-chip' + (on ? '' : ' off') + '" data-act="pub" data-id="' + esc(p.id) + '" aria-pressed="' + on + '">' + (on ? '✓ みせる' : '✕ かくす') + '</button>' +
      '<button class="lb-chip star' + (star ? ' on' : '') + '" data-act="now" data-id="' + esc(p.id) + '" aria-pressed="' + star + '" aria-label="いまの学習">★' + (star ? ' いま' : '') + '</button></span>';
  }
  /**
   * 今週の3件（先生だけ）。いまの学習より上に置く：先生がこの画面で最初にすることは「次に手を打つ相手を知る」だから。
   * 種類は記号と語で示す（色だけで伝えない）。押すと判断の記録が残り、その項目は消える
   */
  function now3View() {
    if (S.boot.role !== 'teacher') return '';
    var list = S.boot.now3 || [];
    var html = '<h2 class="lb-h">今週の3件</h2>';
    if (!list.length) return html + '<div class="lb-nownone">今週は ありません（毎晩、記録から計算します）</div>';
    return html + '<div class="lb-alerts">' + list.map(function (a) {
      return '<div class="lb-alert" data-kind="' + esc(a.kind) + '"><div class="lb-alert-head"><span class="lb-alert-kind">' + esc(a.label) + '</span>' +
        '<span class="lb-alert-skill">' + esc(a.app) + '・' + esc(a.skill) + '</span></div>' +
        '<div class="lb-alert-who">' + (S.hide ? (a.codes || []).map(function (c) { return '〔' + esc(c) + '〕'; }) : a.names.map(esc)).join('、') + '</div><div class="lb-alert-text">' + esc(a.text) + '</div>' +
        '<div class="lb-alert-acts"><button class="lb-abtn" data-tier="main" data-act="decide" data-how="changed" data-key="' + esc(a.key) + '">判断が変わった</button>' +
        '<button class="lb-abtn sub" data-tier="small" data-act="decide" data-how="seen" data-key="' + esc(a.key) + '">見た</button></div></div>';
    }).join('') + '</div>';
  }
  /**
   * 学習BASE への気づき（先生）。ホームの一番下：毎日使う物の邪魔をしない。所有者には書き出しのボタンも
   */
  function feedbackView() {
    if (S.boot.role !== 'teacher') return '';
    return '<section class="lb-fb"><h2 class="lb-h">学習BASE への気づき</h2>' +
      '<p class="lb-fbnote">使いにくい所、今週の3件が当たっていた・外れていた例などを短く。学習BASE を直すのに使います（児童の名前は記号に置き換えてから書き出します）。</p>' +
      '<textarea id="lb-fbtext" rows="3" maxlength="1000" aria-label="学習BASE への気づき">' + esc(S.fb) + '</textarea>' +
      '<div class="lb-fbacts"><button class="lb-abtn" data-act="fb">気づきを送る</button></div>' +
      (S.boot.owner ? '<div class="lb-fbowner"><button class="lb-link" data-act="export">改善用に書き出す（所有者だけ）</button></div>' : '') + '</section>';
  }
  /** 改善用の書き出しの結果。機械の確かめで止めた時は、文を出さずに理由だけ */
  function exportView() {
    var x = S.exp;
    if (!x) return '';
    var html = '<section class="lb-export" aria-label="改善用の書き出し"><div class="lb-exphead"><h2 class="lb-h">改善用の書き出し</h2><button class="lb-link" data-act="export-close">閉じる</button></div>';
    if (x.busy) return html + '<p>作っています…（30秒ほど かかることがあります）</p></section>';
    if (!x.ok) return html + '<p class="lb-expng">書き出しを止めました：' + esc((x.problems || []).join('／') || x.error || '') + '</p></section>';
    html += '<p class="lb-fbnote">名前・メール・学習者ID が無いことを機械で確かめました。下の「目で確かめる」がある時は、読んでから使ってください。</p>';
    if ((x.notes || []).length) html += '<ul class="lb-expnotes">' + x.notes.map(function (n) { return '<li>目で確かめる：' + esc(n) + '</li>'; }).join('') + '</ul>';
    return html + '<textarea id="lb-exptext" rows="12" readonly aria-label="書き出した文">' + esc(x.text) + '</textarea>' +
      '<div class="lb-fbacts"><button class="lb-abtn" data-act="export-copy">コピーする</button></div></section>';
  }
  function homeView() {
    var h = home(), html = exportView() + now3View();
    html += '<h2 class="lb-h">' + (S.grade <= 2 ? 'いまの がくしゅう' : 'いまの学習') + '</h2>';
    if (h.now.length) {
      html += '<div class="lb-now">' + h.now.map(function (p) {
        var s = subjectInfo(p.subject);
        return '<button class="lb-nowcard" data-act="open" data-id="' + esc(p.id) + '"><span class="lb-badge" data-subject="' + esc(p.subject) + '">' + icon(p.subject) + '</span>' +
          '<span><span class="lb-sub">' + subjectName(s) + '</span><br>' + pageTitle(p) + '</span><span class="lb-go">▶ はじめる</span></button>';
      }).join('') + '</div>';
    } else html += '<div class="lb-nownone">' + (S.boot.role === 'teacher' ? '先生モードで ★ を押すと、ここに出ます（3件まで）' : 'きょうは ありません') + '</div>';
    html += '<h2 class="lb-h">' + (S.grade <= 2 ? 'きょうか' : '教科') + '</h2>';
    var subs = h.subjects;
    if (S.edit) {   // 先生モードでは、かくしたページしかない教科も出す（戻せるように）
      var all = LbPagesView.home(S.cat, S.grade, { publish: allOn(), now: [] }, S.boot.today).subjects;
      subs = all.map(function (s) { var v = h.subjects.filter(function (x) { return x.id === s.id; })[0]; return v || { id: s.id, label: s.label, ruby: s.ruby, low: s.low, count: 0, hidden: true }; });
    }
    html += '<div class="lb-subjects">' + subs.map(function (s) {
      // ページが1つだけの教科は、タイルがそのページを直接開く（教科名の下に題と ▶）。先生モードでは切り替えのため教科の画面へ
      if (s.only && !S.edit) {
        return '<button class="lb-tile is-direct" data-act="open" data-subject="' + esc(s.id) + '" data-id="' + esc(s.only.id) + '">' + icon(s.id) +
          '<span class="lb-name">' + subjectName(s) + '</span><span class="lb-direct">▶ ' + directTitle(s.only) + '</span></button>';
      }
      return '<button class="lb-tile' + (s.hidden ? ' is-off' : '') + '" data-act="subject" data-subject="' + esc(s.id) + '" data-id="' + esc(s.id) + '">' + icon(s.id) +
        '<span class="lb-name">' + subjectName(s) + '</span><span class="lb-count">' + s.count + (S.grade <= 2 ? ' こ' : '件') + '</span></button>';
    }).join('') + '</div>';
    return html + feedbackView();
  }
  function allOn() { var o = {}; (S.cat.pages || []).forEach(function (p) { o[p.id] = true; }); return o; }
  /**
   * 教科の中。算数TA のハブの児童用ページ（apps/hub/links.html）と同じ作り：紙の地に、色の大きなタイル（高さ固定）、
   * 題は明朝で2行まで（収まらなければ字を縮める）、右端に補足（ハブの links の subtitle）。
   */
  function subjectView() {
    var s = subjectInfo(S.subject);
    var units = S.edit ? LbPagesView.home(S.cat, S.grade, { publish: allOn(), now: [] }, S.boot.today).bySubject[S.subject] : home().bySubject[S.subject];
    var html = '<div class="lb-paper"><div class="lb-shead" data-subject="' + esc(S.subject) + '"><button class="lb-back" data-act="back">← もどる</button>' +
      icon(S.subject) + '<h2 class="lb-mincho">' + subjectName(s) + '</h2></div>';
    var pages = [];
    (units || []).forEach(function (u) { pages = pages.concat(u.pages); });
    if (!pages.length) return html + '<div class="lb-msg">いまは ありません</div></div>';
    html += '<div class="lb-hgrid">' + pages.map(function (p) {
      var c = tileColor(p), h = hubLink(p), sub = (h && h.subtitle) || '';
      return '<div class="lb-cell"><button class="lb-htile' + (isOn(p) ? '' : ' is-off') + '" data-act="open" data-id="' + esc(p.id) + '" style="background:' + c[0] + ';color:' + c[1] + '">' +
        '<span class="t lb-mincho">' + esc(S.grade <= 2 && p.ruby ? p.ruby : p.title) + '</span>' + (sub ? '<span class="s">' + esc(sub) + '</span>' : '') +
        '</button>' + chips(p) + '</div>';
    }).join('') + '</div></div>';
    return html;
  }
  /** 題を2行に収める（ハブと同じ段の大きさを上から試す。実際の描画の高さで判定する） */
  var STEPS = [2.35, 2.0, 1.7, 1.45, 1.25, 1.1];
  function fitTiles() {
    var list = root.querySelectorAll('.lb-htile .t');
    for (var i = 0; i < list.length; i++) {
      var el = list[i], tile = el.parentNode, cs = getComputedStyle(tile);
      var avail = tile.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      for (var k = 0; k < STEPS.length; k++) {
        el.style.fontSize = STEPS[k] + 'rem';
        el.style.letterSpacing = STEPS[k] >= 1.7 ? '.07em' : '.03em';
        if (el.scrollHeight <= el.clientHeight + 1 && el.offsetHeight <= avail + 1) break;
      }
    }
  }
  /** 明朝は題に使う字だけを読む（日本語の明朝は全体だと数MB。LTE 機で遅れる。ハブと同じ） */
  var minchoLoaded = {};
  function loadMincho(text) {
    var u = Array.from(new Set(String(text).replace(/\s/g, '').split(''))).filter(function (ch) { return !minchoLoaded[ch]; });
    if (!u.length) return;
    u.forEach(function (ch) { minchoLoaded[ch] = true; });
    var l = document.createElement('link'); l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Zen+Old+Mincho:wght@900&display=swap&text=' + encodeURIComponent(u.join(''));
    document.head.appendChild(l);
  }

  /* ---------- 操作 ---------- */
  function pageById(id) { return S.cat.pages.filter(function (p) { return p.id === id; })[0]; }
  function urlFor(p) {
    if (p.kind === 'link') { var h = hubLink(p); return h && h.url ? h.url : ''; }
    var q = [];
    if (p.kind === 'app') { q.push('app=' + encodeURIComponent(p.app)); for (var k in (p.params || {})) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(p.params[k])); }
    else q.push('doc=' + encodeURIComponent(p.id));   // page= はアプリが使う（算数TA の教師画面）
    if (S.as) q.push('as=' + encodeURIComponent(S.as.lid));
    return P.baseUrl + (P.baseUrl.indexOf('?') >= 0 ? '&' : '?') + q.join('&');
  }
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'lb-toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 1800);
  }
  function save(fn, args, msg) {
    return P.call.apply(null, [fn].concat(args)).then(function (st) { S.boot.settings = st; render(); toast(msg); })
      .catch(function (e) { toast('保存できませんでした：' + (e && e.message || e)); });
  }

  root.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (act === 'pub' || act === 'now') ev.stopPropagation();
    if (act === 'subject') { S.view = 'subject'; S.subject = id; render(); window.scrollTo(0, 0); return; }
    if (act === 'back') { S.view = 'home'; render(); return; }
    if (act === 'edit') { S.edit = !S.edit; render(); return; }
    if (act === 'hide') { S.hide = !S.hide; store('lb-hide', S.hide ? '1' : '0'); render(); return; }
    if (act === 'fb') {
      var text = (document.getElementById('lb-fbtext') || {}).value || '';
      if (!text.trim()) { toast('気づきを書いてから送ってください'); return; }
      P.call('homeFeedback', S.boot.classKey || '', 'home', text).then(function () { S.fb = ''; render(); toast('気づきを送りました。ありがとうございます'); })
        .catch(function (e) { toast('送れませんでした：' + (e && e.message || e)); });
      return;
    }
    if (act === 'export') {
      S.exp = { busy: true }; render(); window.scrollTo(0, 0);
      P.call('homeExport').then(function (r) { S.exp = r; render(); })
        .catch(function (e) { S.exp = { ok: false, error: String(e && e.message || e) }; render(); });
      return;
    }
    if (act === 'export-close') { S.exp = null; render(); return; }
    if (act === 'export-copy') {
      var ta = document.getElementById('lb-exptext');
      var done = function () { toast('コピーしました'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand('copy'); done(); });
      else { ta.select(); document.execCommand('copy'); done(); }
      return;
    }
    if (act === 'as-clear') { S.as = null; render(); return; }
    if (act === 'decide') {
      var key = b.getAttribute('data-key'), how = b.getAttribute('data-how');
      P.call('homeDecide', S.boot.classKey, key, how, '').then(function (list) {
        S.boot.now3 = list; render(); toast(how === 'changed' ? '「判断が変わった」を記録しました' : '「見た」を記録しました');
      }).catch(function (e) { toast('記録できませんでした：' + (e && e.message || e)); });
      return;
    }
    if (act === 'reset') { save('homeResetPublish', [S.boot.classKey], 'ぜんぶ みせる に もどしました'); return; }
    if (act === 'pub') {
      var p = pageById(id), on = !isOn(p);
      S.boot.settings.publish[id] = on; render();                     // すぐ画面に返す
      save('homeSetPublish', [S.boot.classKey, id, on], (on ? 'みせる' : 'かくす') + ' にしました（児童の画面には次に開いた時に出ます）');
      return;
    }
    if (act === 'now') {
      var cur = nowIds(), list;
      if (cur.indexOf(id) >= 0) list = cur.filter(function (x) { return x !== id; });
      else if (cur.length >= 3) { toast('いまの学習は3件までです。どれかの ★ を外してください'); return; }
      else list = cur.concat([id]);
      save('homeSetNow', [S.boot.classKey, list.map(function (x) { return { page: x }; })], 'いまの学習を ' + list.length + '件 にしました');
      return;
    }
    if (act === 'open') {
      if (S.edit) return;                                           // 先生モードでは開かない（切り替えの押し間違いで遷移しない）
      var pg = pageById(id);
      if (pg.kind === 'link' && !urlFor(pg)) {
        toast(S.boot.role === 'teacher' ? 'ハブの links シートに、id「' + pg.linkId + '」の行（url）を足してください' : 'まだ ひらけません。せんせいに つたえてね');
        return;
      }
      if (S.as && pg.actAs !== true) { toast('このページは まだ 代わりに取り組めません（' + S.as.name + ' の記録になりません）'); return; }
      P.open(urlFor(pg));
    }
  });
  root.addEventListener('input', function (ev) { if (ev.target.id === 'lb-fbtext') S.fb = ev.target.value; });   // 書きかけを描き直しで消さない
  root.addEventListener('change', function (ev) {
    if (ev.target.id === 'lb-class') { load({ classKey: ev.target.value }); return; }
    if (ev.target.id === 'lb-as') {
      var lid = ev.target.value;
      S.as = lid ? (S.boot.members || []).filter(function (m) { return m.lid === lid; })[0] || null : null;
      render();
    }
  });

  function gradeOf(b) {
    if (b.role === 'child') return Number(b.learner.grade);
    if (b.role === 'teacher' && b.classKey) return Number(String(b.classKey).split('-')[0]);
    return 0;
  }
  function load(opt) {
    S.boot = S.boot && opt ? S.boot : null; render();
    var keepEdit = S.edit, t0 = Date.now(), o = {};
    for (var k in (opt || {})) o[k] = opt[k];
    o.lastMs = Number(store('lb-rt')) || 0;          // 前回の往復の時間を送る（使われ方の記録。呼び出しは増やさない）
    var stage = 'boot';
    return P.call('homeBoot', o).then(function (b) {
      store('lb-rt', Date.now() - t0);
      S.boot = b; S.grade = gradeOf(b); S.as = null; S.edit = keepEdit && b.role === 'teacher';
      if (!b.settings) b.settings = { publish: {}, now: [] };
      render();
      stage = 'cat';
      return S.cat || P.fetchJson(b.pagesUrl).then(function (c) { S.cat = c; });
    }).then(render).catch(function (e) {
      try { P.call('homeReport', stage === 'cat' ? 'catfail' : 'bootfail').catch(function () {}); } catch (x) {}
      root.innerHTML = '<div class="lb-msg">よみこめませんでした。ページを ひらきなおしてね（' + esc(e && e.message || e) + '）</div>';
    });
  }

  /* ---------- 目録の判定：サーバーと同じ Pages.gs を web/pages.js として読み込んで使う（規則を1か所に） ---------- */
  var LbPagesView = window.LbPages;
  window.LbHomeView = { state: S, judge: LbPagesView };   // 検査用

  var rt;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(fitTiles, 120); });
  load();
})();
