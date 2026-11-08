// node tests/platform.test.cjs — 読み込み係（Loader.gs）と振り分け（Platform.gs）を、GAS を模擬して通しで動かす
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { makeSS } = require('./sheet-mock.cjs');
const R = path.join(__dirname, '..');
const LOADER = fs.readFileSync(path.join(R, 'gas', 'Loader.gs'), 'utf8');
const DIST = f => fs.readFileSync(path.join(R, 'dist', f), 'utf8');
const MANIFEST = JSON.parse(DIST('manifest.json'));
const VER = 'abc1234def5678';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

/** 1つの「学校」：一時保存・プロパティ・ハブ・jsDelivr は実行をまたいで残る */
function school(opts = {}) {
  const S = { cache: {}, props: { HUB_ID: 'HUBxxxxxxxxxxxxxxxxxxxxxx' }, fetches: [], down: false, triggers: [], hub: makeSS('hub') };
  S.hub.insertSheet('platform').v.push(['版', VER], ['指紋', opts.sha === undefined ? '' : opts.sha]);
  S.hub.insertSheet('roster').v.push(['メール', '学年', '組', '番号', '姓', '名'], ['11111111@kyoiku.edu.nishi.or.jp', 3, 1, 5, '田中', 'はなこ']);
  S.files = { 'server.js': DIST('server.js'), 'html.json': DIST('html.json') };
  return S;
}
/** 1回の実行（新しいコンテキストに Loader.gs を読み込む） */
function run(S, user = 'owner@edu.nishi.or.jp') {
  const store = S.cache;
  const ctx = {
    console: { log() {}, error() {} },
    Session: { getActiveUser: () => ({ getEmail: () => user }), getEffectiveUser: () => ({ getEmail: () => 'owner@edu.nishi.or.jp' }), getScriptTimeZone: () => 'Asia/Tokyo' },
    CacheService: { getScriptCache: () => ({ get: k => (k in store ? store[k] : null), put: (k, v) => { store[k] = String(v); }, remove: k => { delete store[k]; },
      getAll: ks => { const o = {}; ks.forEach(k => { if (k in store) o[k] = store[k]; }); return o; }, putAll: m => { for (const k in m) store[k] = String(m[k]); },
      removeAll: ks => ks.forEach(k => delete store[k]) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in S.props ? S.props[k] : null), setProperty: (k, v) => { S.props[k] = String(v); }, deleteProperty: k => { delete S.props[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: id => { if (id !== S.props.HUB_ID) throw new Error('開けません ' + id); return S.hub; }, getActiveSpreadsheet: () => { throw new Error('付属のスプレッドシートは無い'); } },
    UrlFetchApp: { fetch: url => {
      S.fetches.push(url);
      if (S.down) throw new Error('接続できません');
      const m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/gh\/sankisuguya-create\/learning-base@([^/]+)\/dist\/(.+)$/);
      const ok = m && m[1] === VER && S.files[m[2]] != null;
      return { getResponseCode: () => (ok ? 200 : 404), getContentText: () => (ok ? S.files[m[2]] : 'Not found') };
    } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => Array.from(crypto.createHash('sha256').update(text, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, f) => { const s = new Date(d.getTime() + 9 * 3600e3), p = x => String(x).padStart(2, '0');
        return f === 'yyyy' ? String(s.getUTCFullYear()) : f === 'M' ? String(s.getUTCMonth() + 1) : f === 'yyyy-MM-dd' ? `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())}` : f === 'MMdd' ? p(s.getUTCMonth() + 1) + p(s.getUTCDate()) : ''; }
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/a/macros/edu.nishi.or.jp/s/LB/exec' }),
      getProjectTriggers: () => S.triggers.map(fn => ({ getHandlerFunction: () => fn })), deleteTrigger: tr => { S.triggers.splice(S.triggers.indexOf(tr.getHandlerFunction()), 1); },
      newTrigger: fn => ({ timeBased: () => ({ atHour: () => ({ everyDays: () => ({ create: () => S.triggers.push(fn) }) }), everyHours: () => ({ create: () => S.triggers.push(fn) }), after: () => ({ create: () => S.triggers.push(fn) }) }) }) },
    HtmlService: {
      createHtmlOutput: h => ({ html: h, setTitle() { return this; }, addMetaTag() { return this; } }),
      createTemplate: src => ({ src, evaluate() { return { html: src, setTitle() { return this; }, addMetaTag() { return this; } }; } }),
      createTemplateFromFile: () => { throw new Error('GAS のファイルは無い（学習BASE の中）'); },
      createHtmlOutputFromFile: () => { throw new Error('GAS のファイルは無い（学習BASE の中）'); }
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(LOADER, ctx, { filename: 'Loader.gs' });
  return ctx;
}
const jsd = S => S.fetches.filter(u => u.includes('jsdelivr'));

t('ホーム：初回は jsDelivr から取り、版で固定した画面のプログラムを返す。ハブに写しを残す', () => {
  const S = school();
  const page = run(S).doGet({ parameter: {} });
  assert.match(page.html, new RegExp(`learning-base@${VER}/web/home\\.js`));
  assert.match(page.html, new RegExp(`learning-base@${VER}/web/pages\\.js`));
  assert.match(page.html, /lbCall\("home"/);
  assert.strictEqual(jsd(S).length, 1);
  assert.ok(S.hub.sheets.platform_code.v.some(r => r[0] === 'server.js' && r[1] === VER));
});
t('2回目からは一時保存から読む（jsDelivr に行かない）。版はハブを開かずに一時保存から', () => {
  const S = school(); run(S).doGet({ parameter: {} });
  const before = S.fetches.length;
  run(S).doGet({ parameter: {} }); run(S).doGet({ parameter: {} });
  assert.strictEqual(S.fetches.length, before);
});
t('読み込み係の入口は、アプリの同じ名前の関数に上書きされない（アプリは関数の中に包む）', () => {
  const S = school(); const c = run(S); c.doGet({ parameter: {} });
  assert.ok(String(c.doGet).includes('LbPlatform'));
  assert.ok(String(c.apiCall).includes('appApi'));
  assert.strictEqual(typeof c.UNIT_DEFS, 'undefined');
  assert.strictEqual(typeof c.LB_MODULES.tamath.doGet, 'function');
});
t('算数TA：?app=tamath は単元の一覧（リンクに app=tamath）。?unit=… だけの今までの URL も算数TA へ。画面のファイルはこの時だけ読む', () => {
  const S = school();
  run(S).doGet({ parameter: {} });
  assert.ok(!jsd(S).some(u => u.endsWith('html.json')), 'ホームでは画面のファイルを読まない');
  const p = run(S).doGet({ parameter: { app: 'tamath' } });
  assert.match(p.html, /exec\?app=tamath&unit=kuku/);
  assert.ok(jsd(S).some(u => u.endsWith('html.json')));
  assert.match(run(S).doGet({ parameter: { unit: 'zzz' } }).html, /app=tamath&unit=/, '知らない単元は一覧へ');
  assert.match(run(S).doGet({ parameter: { app: 'nope' } }).html, /アプリが見つかりません/);
});
t('学習BASE の画面からの呼び出し：決めた関数だけ（児童はホームの情報を受け取れる）', () => {
  const S = school();
  const b = run(S, '11111111@kyoiku.edu.nishi.or.jp').lbCall('home', 'boot', [{}]);
  assert.strictEqual(b.role, 'child'); assert.strictEqual(b.classKey, '3-1');
  assert.strictEqual(b.pagesUrl, `https://cdn.jsdelivr.net/gh/sankisuguya-create/learning-base@${VER}/catalog/pages.json`);
  assert.throws(() => run(S).lbCall('home', 'nope', []), /呼べない関数/);
  assert.throws(() => run(S).lbCall('Base', 'setHub', ['x']), /呼べない関数/);
});
t('算数TA の画面からの呼び出し（apiCall）は算数TA の中の関数に届く', () => {
  const S = school();
  const ids = run(S).apiCall('kuku', 'unitIdsForTest', []);
  assert.strictEqual(ids.length >= 14, true);
  assert.throws(() => run(S).apiCall('kuku', 'eval', ['1']), /呼べない関数/);
});
t('指紋：ハブの指紋と違えば実行しない（児童には案内、先生には理由）。合っていれば実行する', () => {
  const bad = school({ sha: '0'.repeat(64) });
  const c = run(bad), p = c.doGet({ parameter: {} });
  assert.match(p.html, /ひらけません/); assert.match(p.html, /指紋/);
  assert.strictEqual(typeof c.LbPlatform, 'undefined', '中身を実行していない');
  const good = school({ sha: MANIFEST.server });
  assert.match(run(good).doGet({ parameter: {} }).html, /home\.js/);
});
t('jsDelivr が止まった時：一時保存が無くてもハブの写しで動く。写しも無ければ案内を出す', () => {
  const S = school(); run(S).doGet({ parameter: {} });
  S.cache = {}; S.down = true;
  assert.match(run(S).doGet({ parameter: {} }).html, /home\.js/, 'ハブの写しから');
  const S2 = school(); S2.down = true;
  const p = run(S2).doGet({ parameter: {} });
  assert.match(p.html, /ひらけません/); assert.match(p.html, /写しもありません/);
});
t('版の切り替え：ハブの版を書き換え、lbReload（または5分後）で新しい版を取る', () => {
  const S = school(); run(S).doGet({ parameter: {} });
  S.hub.sheets.platform.v[0][1] = 'v2026.1110.0900';
  S.files = Object.assign({}, S.files);
  run(S).doGet({ parameter: {} });
  assert.ok(!jsd(S).some(u => u.includes('@v2026.1110.0900')), '5分の間は前の版');
  run(S).lbReload();
  run(S).doGet({ parameter: {} });
  assert.ok(jsd(S).some(u => u.includes('@v2026.1110.0900/dist/server.js')));
});
t('版の欄が不正・ハブが未設定なら、理由を出して止まる', () => {
  const S = school(); S.hub.sheets.platform.v[0][1] = 'main';
  assert.match(run(S).doGet({ parameter: {} }).html, /コミット番号でもタグでもありません/);
  const S2 = school(); delete S2.props.HUB_ID;
  assert.match(run(S2).doGet({ parameter: {} }).html, /HUB_ID/);
});
t('lbSetup：所有者だけ。自動実行（夜・朝・4/1・毎時）を1回だけ置き、各アプリの準備を呼ぶ', () => {
  const S = school();
  assert.throws(() => run(S, '11111111@kyoiku.edu.nishi.or.jp').lbSetup(), /所有者/);
  S.triggers.push('nightlyAggregateAll', 'rolloverRosterAll', 'resetDailyAll');   // 前の形（算数TA をまとめた GAS）の自動実行
  const msg = run(S).lbSetup(); run(S).lbSetup();
  assert.match(msg, /前の形の自動実行を消しました：nightlyAggregateAll・rolloverRosterAll・resetDailyAll/);
  assert.strictEqual(JSON.stringify(S.triggers.slice().sort()), JSON.stringify(['lbDaily', 'lbHourly', 'lbNightly', 'lbRollover']));
  assert.match(msg, /tamath：/);
});
t('自動実行：夜の処理は各アプリへ（算数TA は未登録の単元を飛ばす）。毎時は jsDelivr に行かずに一時保存を延ばす', () => {
  const S = school(); run(S).doGet({ parameter: {} }); run(S).doGet({ parameter: { app: 'tamath' } });
  assert.strictEqual(JSON.stringify(run(S).lbNightly()), '[]');
  const before = S.fetches.length;
  run(S).lbHourly();
  assert.strictEqual(S.fetches.length, before);
});

(async () => {
  const S = school();
  const html = run(S).doGet({ parameter: {} }).html;
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const calls = [];
  const runner = h => ({ withSuccessHandler: f => runner(Object.assign({}, h, { ok: f })), withFailureHandler: f => runner(Object.assign({}, h, { ng: f })),
    lbCall: (mod, name, args) => { calls.push([mod, name, args]); h.ok({ echo: name }); } });
  const page = { google: { script: { run: runner({}) } }, window: {}, fetch: () => Promise.resolve({ ok: true, json: () => ({}) }) };
  page.window = page; vm.createContext(page); vm.runInContext(inline, page);
  const r = await page.LB_PLATFORM.call('homeSetNow', '3-1', [{ page: 'kanzi' }]);
  assert.strictEqual(JSON.stringify(calls[0]), JSON.stringify(['home', 'setNow', ['3-1', [{ page: 'kanzi' }]]]));
  assert.strictEqual(r.echo, 'setNow');
  assert.strictEqual(page.LB_PLATFORM.baseUrl, 'https://script.google.com/a/macros/edu.nishi.or.jp/s/LB/exec');
  console.log('ok ホームの画面の Platform 層（呼び出しの変換）');
  console.log(`platform ${n + 1} 件 ok`);
})().catch(e => { console.error(e); process.exit(1); });
