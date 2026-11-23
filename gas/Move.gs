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
