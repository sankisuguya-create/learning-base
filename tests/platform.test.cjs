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
  const S = { cache: {}, props: { HUB_ID: 'HUBxxxxxxxxxxxxxxxxxxxxxx', 'u:kuku:ready_schema': '7' }, fetches: [], down: false, triggers: [], hub: makeSS('hub') };
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in S.props ? S.props[k] : null), setProperty: (k, v) => { S.props[k] = String(v); }, deleteProperty: k => { delete S.props[k]; }, getProperties: () => Object.assign({}, S.props) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: id => { if (id === S.props.HUB_ID) return S.hub; if (S.units && S.units[id]) return S.units[id]; throw new Error('開けません ' + id); }, getActiveSpreadsheet: () => { throw new Error('付属のスプレッドシートは無い'); } },
    UrlFetchApp: { fetch: url => {
      S.fetches.push(url);
      if (url === 'https://raw.githubusercontent.com/sankisuguya-create/learning-base/main/release.json') {
        if (S.githubDown) throw new Error('接続できません');
        return { getResponseCode: () => (S.release ? 200 : 404), getContentText: () => JSON.stringify(S.release || {}) };
      }
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
      WeekDay: { MONDAY: 'MONDAY' },
      newTrigger: fn => ({ timeBased: () => ({ atHour: () => ({ everyDays: () => ({ create: () => S.triggers.push(fn) }) }), everyHours: () => ({ create: () => S.triggers.push(fn) }), after: () => ({ create: () => S.triggers.push(fn) }),
        onWeekDay: () => ({ atHour: () => ({ nearMinute: () => ({ create: () => S.triggers.push(fn) }) }) }) }) }) },
    MailApp: { sendEmail: m => { (S.mails = S.mails || []).push(m); }, getRemainingDailyQuota: () => 100 },
    HtmlService: {
      createHtmlOutput: h => ({ html: h, setTitle() { return this; }, addMetaTag() { return this; } }),
      // 本物の GAS と同じく、<?!= ?> の中で見えるのはテンプレートに渡した名前と組み込みだけ（関数の中に包んだアプリの名前は見えない）
      createTemplate: src => { const t = { evaluate() {
        const names = Object.keys(t).filter(k => k !== 'evaluate'), vals = names.map(k => t[k]);
        const html = src.replace(/<\?!=([\s\S]*?)\?>/g, (m, expr) => String(new Function(...names, 'return (' + expr + ');')(...vals)));
        return { html, setTitle() { return this; }, addMetaTag() { return this; } }; } }; return t; },
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
  assert.match(run(S).doGet({ parameter: { doc: 'x' } }).html, /じゅんび中/, '教材ページは doc=');
  // 単元の画面（児童・教師）：テンプレートを評価でき、画面の呼び出しを apiCall につなぐ差し替えが入っている
  const kid = run(S).doGet({ parameter: { app: 'tamath', unit: 'kuku' } }).html;
  assert.match(kid, /var APP_ID = "kuku";/);
  assert.match(kid, /r\.apiCall\(KEY/, '差し替えが無い（画面からサーバーを呼べない）');
  assert.match(run(S).doGet({ parameter: { app: 'tamath', unit: 'kuku', page: 'teacher' } }).html, /r\.apiCall\(KEY/);
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
t('ハブの写し：区切りの頭が「+」「=」でも数式にならずに戻る（頭に # を付ける）', () => {
  const S = school();
  // 2つ目のセルの頭（30000字目）が「+」になる中身にする：行の境目まで詰め物の注釈を入れ、そこに実行できる文「+0;」を置く
  const orig = S.files['server.js'], cut = orig.lastIndexOf('\n', 29000) + 1, head = orig.slice(0, cut);
  const pad = '//' + ' '.repeat(30000 - head.length - 3) + '\n';
  S.files['server.js'] = head + pad + '+0;\n' + orig.slice(cut);
  assert.strictEqual(S.files['server.js'].charAt(30000), '+');
  run(S).doGet({ parameter: {} });
  assert.ok(S.hub.sheets.platform_code.v.some(r => String(r[3]).startsWith('#+')), '頭が + のセルができる');
  S.cache = {}; S.down = true;
  assert.match(run(S).doGet({ parameter: {} }).html, /home\.js/, '写しから元の中身に戻せる');
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
t('自動：platform シートが無い・「版」が空・「自動」なら GitHub の release.json の版で動く', () => {
  const FULL = 'a'.repeat(40);
  for (const setup of [S => { delete S.hub.sheets.platform; }, S => { S.hub.sheets.platform.v[0][1] = ''; }, S => { S.hub.sheets.platform.v[0][1] = '自動'; }]) {
    const S = school(); setup(S);
    S.release = { ver: FULL, sha: '' }; S.files = Object.assign({}, S.files);
    run(S).doGet({ parameter: {} });
    assert.ok(jsd(S).some(u => u.includes('@' + FULL + '/dist/server.js')), 'release.json の版を取りに行く');
  }
});
t('自動：GitHub に届かない時は、最後に取れた版で動く。一度も取れていなければ理由を出す', () => {
  const S = school(); delete S.hub.sheets.platform;
  S.release = { ver: 'b'.repeat(40), sha: '' };
  run(S).lbStatus();                                                 // 一度取れた（覚える）
  assert.strictEqual(S.props.LB_RELEASE.split('|')[0], 'b'.repeat(40));
  S.cache = {}; S.githubDown = true;
  run(S).doGet({ parameter: {} });
  assert.ok(jsd(S).some(u => u.includes('@' + 'b'.repeat(40) + '/dist/server.js')));
  const S2 = school(); delete S2.hub.sheets.platform; S2.githubDown = true;
  assert.match(run(S2).doGet({ parameter: {} }).html, /使う版が決まりません/);
});
t('固定：「版」にコミット番号があれば release.json に関わらずその版（戻す・止める）', () => {
  const S = school(); S.release = { ver: 'c'.repeat(40), sha: '' };
  run(S).doGet({ parameter: {} });
  assert.ok(!S.fetches.some(u => u.includes('release.json')), '固定の時は release.json を見ない');
  assert.ok(jsd(S).some(u => u.includes('@' + VER + '/')));
});

t('新しい形の記録：送信で単元のスプレッドシートに1行（学習者ID・全問）。夜の処理でハブの集計へ（練習は除く）', () => {
  const S = school();
  S.units = { KUKUxxxxxxxxxxxxxxxxxxxxxx: makeSS('kuku') }; S.props['unit_sheet:kuku'] = 'KUKUxxxxxxxxxxxxxxxxxxxxxx';
  const c = run(S); c.doGet({ parameter: {} });
  const M = c.LB_MODULES.tamath, mail = '11111111@kyoiku.edu.nishi.or.jp';
  const items = [{ i: 0, q: '7x8', t: 'x7', a: '56', tries: 1, hit: true, ok: true, skill: 'math/kuku/x7', first: 1200 },
    { i: 1, q: '7x6', t: 'x7', a: '41/42', tries: 2, hit: true, ok: false, skill: 'math/kuku/x7' }];
  assert.strictEqual(M.writeForUnit('kuku', { mode: 3 }, mail, false, items), true);
  assert.strictEqual(M.writeForUnit('kuku', { mode: 3 }, mail, true, items), true, '練習も記録する');
  assert.strictEqual(M.writeForUnit('kuku', { mode: 3 }, '99999999@kyoiku.edu.nishi.or.jp', false, items), false, '名簿にない人は書かない');
  const rows = S.units.KUKUxxxxxxxxxxxxxxxxxxxxxx.sheets.sessions_2026.v;
  assert.strictEqual(rows.length, 3);
  const lid = S.hub.sheets.roster.v[1][S.hub.sheets.roster.v[0].indexOf('学習者ID')];
  assert.ok(/^L[a-z2-9]{10}$/.test(lid));
  const r1 = c.LbSession.fromRow(rows[1]);
  assert.strictEqual(r1.lid, lid); assert.strictEqual(r1.app, 'tamath'); assert.strictEqual(r1.activity, 'kuku/3'); assert.strictEqual(r1.context, 'live');
  assert.strictEqual(r1.items.length, 2); assert.strictEqual(r1.skills['math/kuku/x7'].ok, 1, '一度で正答した問題だけ正答');
  assert.strictEqual(c.LbSession.fromRow(rows[2]).context, 'practice');
  // 夜の処理：集計（練習は除く・読んだ位置は単元ごと）
  run(S).lbNightly();
  const f = S.hub.sheets.facts_2026.v;
  assert.strictEqual(f.length, 2, '本番の1行だけ');
  assert.strictEqual(f[1][1], lid); assert.strictEqual(f[1][6], 'math/kuku/x7'); assert.strictEqual(f[1][7], 2); assert.strictEqual(f[1][8], 1);
  assert.ok(S.hub.sheets.facts_cursor.v.some(r => r[0] === 'tamath:kuku' && r[1] === 'sessions_2026'));
  run(S).lbNightly();
  assert.strictEqual(S.hub.sheets.facts_2026.v[1][7], 2, '2回目は足さない');
  // 技能の目録をハブに書く（lbSetup）
  run(S).lbSetup();
  assert.ok(S.hub.sheets.catalog.v.some(r => r[0] === 'tamath'));
});

t('段階D：過去の log を1回だけ集計へ（新しい形の記録より前の分）→ 今週の3件 → 先生の画面 → 判断の記録 → 月曜のメール（名前なし）', () => {
  const S = school();
  const kuku = makeSS('kuku');
  S.units = { KUKUxxxxxxxxxxxxxxxxxxxxxx: kuku }; S.props['unit_sheet:kuku'] = 'KUKUxxxxxxxxxxxxxxxxxxxxxx';
  S.hub.insertSheet('teachers').v.push(['メール', '学年', '組'], ['tan@edu.nishi.or.jp', 3, 1]);
  const c = run(S); c.doGet({ parameter: {} });
  const mail = '11111111@kyoiku.edu.nishi.or.jp';
  // 過去の log：4週前まで 90%、今週 50%（急に崩れた）
  const head = ['ts', 'email', '学年', '組', '番号', '氏名', 'mode', 'モード名', 'limit_sec', 'correct', 'attempts', 'miss_items', 'slow_items', 'type_stats', 'wrong_items'];
  const log = kuku.insertSheet('log'); log.v.push(head);
  const day = k => new Date(Date.now() - k * 7 * 86400000);
  for (let k = 1; k <= 4; k++) log.v.push([day(k), mail, 3, '1', 5, '田中 はなこ', 3, 'm', 60, 10, 10, 'x7:7x1', '', 'x7:9:0:9:9000:0:62.2:430', '']);
  log.v.push([day(0), mail, 3, '1', 5, '田中 はなこ', 3, 'm', 60, 10, 10, 'x7:a,x7:b,x7:c,x7:d,x7:e,x7:f', '', 'x7:6:0:6:6000:0:41.4:286', '']);
  // 新しい形の記録が始まった後の1回（log にも同じ回があるが、二重に数えない）
  run(S).lbStatus();
  c.LB_MODULES.tamath.writeForUnit('kuku', { mode: 3 }, mail, false, [{ i: 0, q: '7x8', t: 'x7', a: '56', tries: 1, hit: true, ok: true, skill: 'math/kuku/x7', first: 1000 }]);
  const sessTs = kuku.sheets.sessions_2026.v[1][0];
  log.v.push([new Date(sessTs.getTime() + 1), mail, 3, '1', 5, '田中 はなこ', 3, 'm', 60, 1, 1, '', '', 'x7:1:0:1:1000:0:6.9:47.7', '']);   // 新しい形が始まった後の回（いまより前）
  run(S).lbSetup();                                                  // 技能の目録をハブへ
  run(S).lbNightly();
  const f = S.hub.sheets.facts_2026.v.slice(1);
  const total = f.reduce((t, r) => t + Number(r[7]), 0);
  assert.strictEqual(total, 4 * 10 + 12 + 1, '過去の log（新しい形が始まる前の分）＋新しい形の1問。後の log の回は数えない');
  run(S).lbNightly();
  assert.strictEqual(S.hub.sheets.facts_2026.v.slice(1).reduce((t, r) => t + Number(r[7]), 0), total, '2回目の夜は取り込まない');
  // 今週の3件
  const now3 = S.hub.sheets.now3.v;
  assert.ok(now3.length >= 2 && now3[1][3] === 'drop', '急に崩れた が出る');
  const tb = run(S, 'tan@edu.nishi.or.jp').lbCall('home', 'boot', [{ classKey: '3-1' }]);
  assert.strictEqual(tb.now3[0].kind, 'drop');
  assert.strictEqual(tb.now3[0].names[0], '田中 はなこ');
  assert.match(tb.now3[0].skill, /九九/);
  assert.match(tb.now3[0].text, /正答率 90% →/);
  const kid = run(S, mail).lbCall('home', 'boot', [{}]);
  assert.strictEqual(kid.now3, undefined, '児童には渡さない');
  // 月曜のメール（判断する前）
  run(S).lbWeekly();
  const ms = S.mails || [];
  assert.ok(ms.some(m => m.to === 'tan@edu.nishi.or.jp') && ms.some(m => m.to === 'owner@edu.nishi.or.jp'));
  assert.ok(ms.every(m => !/田中|はなこ/.test(m.body + m.subject)), 'メールに名前を書かない');
  assert.match(ms[0].body, /3年1組：急に崩れた 1/);
  // 判断の記録
  const after = run(S, 'tan@edu.nishi.or.jp').lbCall('home', 'decide', ['3-1', tb.now3[0].key, 'changed', '']);
  assert.ok(!after.some(x => x.key === tb.now3[0].key));
  assert.throws(() => run(S, mail).lbCall('home', 'decide', ['3-1', tb.now3[0].key, 'seen', '']), /先生だけ/);
  S.mails = []; run(S).lbWeekly();
  assert.ok(!(S.mails || []).some(m => /急に崩れた/.test(m.body)), '判断した項目はメールにも出ない');
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
  assert.strictEqual(JSON.stringify(S.triggers.slice().sort()), JSON.stringify(['lbDaily', 'lbHourly', 'lbNightly', 'lbRollover', 'lbWeekly']));
  assert.match(msg, /tamath：/);
});
t('自動実行：夜の処理は各アプリへ（算数TA は未登録の単元を飛ばす）。毎時は jsDelivr に行かずに一時保存を延ばす', () => {
  const S = school(); run(S).doGet({ parameter: {} }); run(S).doGet({ parameter: { app: 'tamath' } });
  assert.strictEqual(JSON.stringify(run(S).lbNightly()), '[]');
  const before = S.fetches.length;
  run(S).lbHourly();
  assert.strictEqual(S.fetches.length, before);
});

t('直すための材料：ページを開くと数え、夜に前日までを usage へ。所有者は画面から改善用の書き出しを受け取れる（名前は入らない）', () => {
  const S = school();
  run(S, '11111111@kyoiku.edu.nishi.or.jp').doGet({ parameter: { app: 'tamath', unit: 'kuku' } });
  run(S, '11111111@kyoiku.edu.nishi.or.jp').lbCall('home', 'boot', [{ lastMs: 1200 }]);
  const sum = () => Object.keys(S.props).filter(k => k.startsWith('LB_U|')).map(k => JSON.parse(S.props[k])).reduce((a, o) => { for (const k in o) a[k] = (a[k] || 0) + o[k]; return a; }, {});
  const all = sum();
  assert.strictEqual(all['child|open:tamath/kuku'], 1); assert.strictEqual(all['child|boot'], 1); assert.strictEqual(all['child|rt:2秒未満'], 1);
  // 失敗を数える：呼べる関数が中で失敗した時（児童が学級の設定を変えようとした）
  assert.throws(() => run(S, '11111111@kyoiku.edu.nishi.or.jp').lbCall('home', 'setNow', ['3-1', []]), /先生だけ/);
  assert.strictEqual(sum()['-|err:home.setNow'], 1);
  // 書き出し：所有者だけ
  assert.throws(() => run(S, 'other@edu.nishi.or.jp').lbCall('home', 'exportForTuning', []), /所有者だけ/);
  S.hub.insertSheet('feedback').v.push(['日時', '教師', '学級', '画面', '本文'], [new Date(), 'owner@edu.nishi.or.jp', '3-1', 'home', '田中はなこさんが押し間違えた']);
  const r = run(S).lbCall('home', 'exportForTuning', []);
  assert.ok(r.ok, (r.problems || []).join());
  assert.ok(!/田中|はなこ|@|11111111/.test(r.text)); assert.match(r.text, /〔[a-z0-9]{2,3}〕さんが押し間違えた/);
  assert.match(r.text, new RegExp('版：' + VER));
  assert.ok(S.hub.sheets.pseudo_2026, '記号表はハブに');
  // 夜：前日までの分を usage へ
  for (const k of Object.keys(S.props)) if (k.startsWith('LB_U|')) { S.props[k.replace(/LB_U\|\d{4}-\d{2}-\d{2}/, 'LB_U|2026-01-05')] = S.props[k]; delete S.props[k]; }
  run(S).lbNightly();
  assert.ok(S.hub.sheets.usage.v.some(r => r[0] === '2026-01-05' && r[2] === 'open:tamath/kuku'));
  assert.ok(!Object.keys(S.props).some(k => k.startsWith('LB_U|2026-01-05')));
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
