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

  function doGet(e) {
    var p = (e && e.parameter) || {};
    var app = p.app || (p.unit ? 'tamath' : '');
    if (p.doc && !app) return message('このページは じゅんび中です');
    if (app) {
      var m = LB_MODULES[app];
      if (!m) return message('アプリが見つかりません: ' + app);
      LB_LOADER.files();                      // アプリの画面のファイルを読む（LB_FILES）
      try { return m.doGet(e); } catch (err) { LbTelemetry.count(roleNow(), LbTelemetry.err(app + '.doGet', err)); throw err; }
    }
    return homePage();
  }

  function call(mod, name, args) {
    var api = API[String(mod)];
    if (!api || !Object.prototype.hasOwnProperty.call(api, String(name))) throw new Error('呼べない関数です: ' + mod + '.' + name);
    try { return api[name].apply(null, Array.isArray(args) ? args : []); }
    catch (e) { LbTelemetry.count(roleNow(), LbTelemetry.err(mod + '.' + name, e)); throw e; }
  }
  function appApi(app, unit, name, args) {
    var m = LB_MODULES[app];
    if (!m || !m.apiCall) throw new Error('アプリが見つかりません: ' + app);
    try { return m.apiCall(unit, name, args); }
    catch (e) { LbTelemetry.count(roleNow(), LbTelemetry.err(app + '.' + String(name).slice(0, 40), e)); throw e; }
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
  /**
   * 過去の記録を1回だけ集計に取り込む（アプリが legacySources・legacySessions を持つ時）。
   * 記録先ごとに「済み」の印を置き、新しい形の記録が始まった時刻より前の分だけを足す（二重に数えない）
   */
  function legacy() {
    var hub = Base.hub(), fy = Base.fy(), errs = [];
    Object.keys(LB_MODULES).forEach(function (k) {
      var m = LB_MODULES[k];
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

  /** 前日までの使われ方を usage シートへ（1日×区分×出来事で1行） */
  function usage() {
    try { console.log('使われ方：' + LbTelemetry.flush(Base.hub()) + ' 行'); return []; }
    catch (e) { console.error('使われ方 失敗: ' + e.message); return ['usage: ' + e.message]; }
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
      'var fn=String(name).replace(/^home(.)/,function(m,c){return c.toLowerCase();});' +   // homeSetNow → setNow（LbHome.API の名前）
      'return new Promise(function(ok,ng){google.script.run.withSuccessHandler(ok).withFailureHandler(ng).lbCall("home",fn,a);});},' +
      'fetchJson:function(u){return fetch(u).then(function(r){if(!r.ok)throw new Error("目録 "+r.status);return r.json();});},' +
      'open:function(u){window.open(u,"_top");}};' +
      'function lbLoadFail(){if(window.lbFailed)return;window.lbFailed=1;try{google.script.run.lbCall("home","report",["loadfail"]);}catch(e){}var m=document.getElementById("lb");if(m)m.innerHTML=\'<div class="lb-msg" style="padding:24px;font-size:20px">いま ひらけません。すこし まってから、ページを ひらきなおしてね。</div>\';}';
  }
  function message(text) {
    return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width, initial-scale=1"><div lang="ja" style="font-family:\'BIZ UDPGothic\',\'Noto Sans CJK JP\',sans-serif;font-size:20px;padding:24px">' +
      String(text).replace(/[<>&]/g, '') + '</div>').setTitle('学習BASE');
  }

  return { doGet: doGet, call: call, appApi: appApi, setup: setup,
    nightly: function () { var e = each('nightly'); e = e.concat(legacy()); e = e.concat(facts()); e = e.concat(alerts()); return e.concat(usage()); },
    weekly: weekly, daily: function () { return each('daily'); },
    rollover: function () { return each('rollover'); }, continueAll: function () { return each('continueAll'); } };
})();
