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
    nightly: function () { return each('nightly'); }, daily: function () { return each('daily'); },
    rollover: function () { return each('rollover'); }, continueAll: function () { return each('continueAll'); } };
})();
