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
  S.files = {};   // jsDelivr の dist/ にあるファイル全部
  for (const f of fs.readdirSync(path.join(R, 'dist'))) S.files[f] = DIST(f);
  return S;
}
/** 1回の実行（新しいコンテキストに Loader.gs を読み込む） */
function run(S, user = 'owner@edu.nishi.or.jp', loader = LOADER) {
  const store = S.cache;
  const ctx = {
    console: { log() {}, error() {} },
    Session: { getActiveUser: () => ({ getEmail: () => user }), getEffectiveUser: () => ({ getEmail: () => 'owner@edu.nishi.or.jp' }), getScriptTimeZone: () => 'Asia/Tokyo' },
    CacheService: { getScriptCache: () => ({ get: k => (S.trips = (S.trips || 0) + 1, k in store ? store[k] : null), put: (k, v) => { store[k] = String(v); }, remove: k => { delete store[k]; },
      getAll: ks => { S.trips = (S.trips || 0) + 1; const o = {}; ks.forEach(k => { if (k in store) o[k] = store[k]; }); return o; }, putAll: m => { for (const k in m) store[k] = String(m[k]); },
      removeAll: ks => ks.forEach(k => delete store[k]) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in S.props ? S.props[k] : null), setProperty: (k, v) => { S.props[k] = String(v); }, deleteProperty: k => { delete S.props[k]; }, getProperties: () => Object.assign({}, S.props),
      setProperties: (o) => { for (const k in o) S.props[k] = String(o[k]); } }) },
    DriveApp: { getRootFolder: () => ({}), getFileById: id => ({ getParents: () => ({ hasNext: () => true, next: () => 'folder' }), moveTo: f => { (S.moved = S.moved || {})[id] = f; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: id => { if (id === S.props.HUB_ID) return S.hub; if (S.bound && id === S.bound.getId()) return S.bound; if (S.units && S.units[id]) return S.units[id]; throw new Error('開けません ' + id); }, getActiveSpreadsheet: () => (S.bound || null),
      create: name => { const id = 'NEW' + String(Object.keys(S.units = S.units || {}).length).padStart(22, '0'); return (S.units[id] = Object.assign(makeSS(id), { title: name })); } },
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
      createHtmlOutput: h => ({ html: h, setTitle() { return this; }, addMetaTag() { return this; }, setFaviconUrl(u) { this.icon = u; return this; } }),
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
  vm.runInContext(loader, ctx, { filename: 'Loader.gs' });
  return ctx;
}
const jsd = S => S.fetches.filter(u => u.includes('jsdelivr'));

t('ホーム：初回は jsDelivr から取り、版で固定した画面のプログラムを返す。ハブに写しを残す', () => {
  const S = school();
  const page = run(S).doGet({ parameter: {} });
  assert.match(page.html, new RegExp(`learning-base@${VER}/web/home\\.js`));
  assert.match(page.html, new RegExp(`learning-base@${VER}/web/pages\\.js`));
  assert.match(page.html, /lbCall\("home"/);
  assert.strictEqual(JSON.stringify(jsd(S).map(u => u.split('/dist/')[1])), JSON.stringify(['manifest.json', 'core.js']), 'ホームでは教科のコードを読まない');
  assert.ok(S.hub.sheets.platform_code.v.some(r => r[0] === 'core.js' && r[1] === VER));
});
t('教科は使う時だけ読む：算数のページで app-tamath.js と html-tamath.json だけ。国語のコードは読まない。教科を足しても毎回読む量は増えない', () => {
  const S = school();
  run(S, '11111111@kyoiku.edu.nishi.or.jp').doGet({ parameter: { app: 'tamath', unit: 'kuku' } });
  const got = jsd(S).map(u => u.split('/dist/')[1]);
  assert.ok(got.includes('app-tamath.js') && got.includes('html-tamath.json'), got.join());
  assert.ok(!got.some(f => /kanzi|server\.js|html\.json$/.test(f) && f !== 'html-tamath.json'), '他の教科・全部入りは読まない: ' + got.join());
  const m = JSON.parse(DIST('manifest.json'));
  assert.ok(m.chars['core.js'] < m.chars['server.js'] * 0.4, '毎回読むのは全部入りの4割未満（' + m.chars['core.js'] + '／' + m.chars['server.js'] + '字）');
});
t('ファイルは manifest の指紋と照らし合わせる：中身が違えば、その教科は実行しない（その教科だけ止まる）', () => {
  const S = school();
  S.files['app-tamath.js'] = S.files['app-tamath.js'].replace('var LB_RESOLVE_', "globalThis.HACKED = 1; var LB_RESOLVE_");
  const c = run(S, '11111111@kyoiku.edu.nishi.or.jp');
  assert.match(c.doGet({ parameter: { app: 'tamath', unit: 'kuku' } }).html, /いまは ひらけません/);
  assert.strictEqual(c.HACKED, undefined, '書き換えられた中身は実行しない');
  assert.match(run(S).doGet({ parameter: {} }).html, /home\.js/, 'ホームは動く');
});
t('前の形の版（manifest に files が無い。戻した時など）は、全部入りの server.js を読む', () => {
  const S = school();
  const old = JSON.parse(S.files['manifest.json']); delete old.files; delete old.chars;
  S.files['manifest.json'] = JSON.stringify(old);
  const c = run(S, '11111111@kyoiku.edu.nishi.or.jp');
  assert.match(c.doGet({ parameter: { app: 'tamath', unit: 'kuku' } }).html, /var APP_ID = "kuku";/);
  assert.ok(jsd(S).some(u => u.endsWith('/dist/server.js')) && jsd(S).some(u => u.endsWith('/dist/html.json')));
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
  c.apiCall('kuku', 'unitIdsForTest', []);
  assert.strictEqual(typeof c.LB_MODULES.tamath.doGet, 'function');
});
t('算数TA：?app=tamath は単元の一覧（リンクに app=tamath）。?unit=… だけの今までの URL も算数TA へ。画面のファイルはこの時だけ読む', () => {
  const S = school();
  run(S).doGet({ parameter: {} });
  assert.ok(!jsd(S).some(u => /html.*\.json$/.test(u)), 'ホームでは画面のファイルを読まない');
  const p = run(S).doGet({ parameter: { app: 'tamath' } });
  assert.match(p.html, /exec\?app=tamath&unit=kuku/);
  assert.ok(jsd(S).some(u => u.endsWith('html-tamath.json')));
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
  // platform シートの「指紋」は dist/manifest.json の指紋（各ファイルは manifest の指紋で照らし合わせる）
  const good = school({ sha: crypto.createHash('sha256').update(DIST('manifest.json'), 'utf8').digest('hex') });
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
  const orig = S.files['core.js'], cut = orig.lastIndexOf('\n', 29000) + 1, head = orig.slice(0, cut);
  const pad = '//' + ' '.repeat(30000 - head.length - 3) + '\n';
  S.files['core.js'] = head + pad + '+0;\n' + orig.slice(cut);
  assert.strictEqual(S.files['core.js'].charAt(30000), '+');
  const man = JSON.parse(S.files['manifest.json']); man.files['core.js'] = crypto.createHash('sha256').update(S.files['core.js'], 'utf8').digest('hex');
  S.files['manifest.json'] = JSON.stringify(man);   // 書き換えた中身の指紋を manifest に（照らし合わせを通すため）
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
  assert.ok(jsd(S).some(u => u.includes('@v2026.1110.0900/dist/manifest.json')));
});
t('自動：platform シートが無い・「版」が空・「自動」なら GitHub の release.json の版で動く', () => {
  const FULL = 'a'.repeat(40);
  for (const setup of [S => { delete S.hub.sheets.platform; }, S => { S.hub.sheets.platform.v[0][1] = ''; }, S => { S.hub.sheets.platform.v[0][1] = '自動'; }]) {
    const S = school(); setup(S);
    S.release = { ver: FULL, sha: '' }; S.files = Object.assign({}, S.files);
    run(S).doGet({ parameter: {} });
    assert.ok(jsd(S).some(u => u.includes('@' + FULL + '/dist/manifest.json')), 'release.json の版を取りに行く');
  }
});
t('自動：GitHub に届かない時は、最後に取れた版で動く。一度も取れていなければ理由を出す', () => {
  const S = school(); delete S.hub.sheets.platform;
  S.release = { ver: 'b'.repeat(40), sha: '' };
  run(S).lbStatus();                                                 // 一度取れた（覚える）
  assert.strictEqual(S.props.LB_RELEASE.split('|')[0], 'b'.repeat(40));
  S.cache = {}; S.githubDown = true;
  run(S).doGet({ parameter: {} });
  assert.ok(jsd(S).some(u => u.includes('@' + 'b'.repeat(40) + '/dist/manifest.json')));
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
  const c = run(S); c.doGet({ parameter: {} }); c.apiCall('kuku', 'unitIdsForTest', []);   // 算数を読み込む（使う時だけ読む形）
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
  c.LbPlatform.appApi('tamath', 'kuku', 'unitIdsForTest', []); c.LB_MODULES.tamath.writeForUnit('kuku', { mode: 3 }, mail, false, [{ i: 0, q: '7x8', t: 'x7', a: '56', tries: 1, hit: true, ok: true, skill: 'math/kuku/x7', first: 1000 }]);
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

t('版の欄が不正・BASEシートが分からないなら、理由を出して止まる', () => {
  const S = school(); S.hub.sheets.platform.v[0][1] = 'main';
  assert.match(run(S).doGet({ parameter: {} }).html, /コミット番号でもタグでもありません/);
  const S2 = school(); delete S2.props.HUB_ID;
  assert.match(run(S2).doGet({ parameter: {} }).html, /BASEシートが分かりません/);
  const S3 = school(); S3.bound = S3.hub; delete S3.props.HUB_ID;   // BASEシートに付けた GAS：HUB_ID は要らない
  assert.match(run(S3).doGet({ parameter: {} }).html, /LB_BOOT/);
  assert.doesNotMatch(run(S3).doGet({ parameter: {} }).html, /先生へ/);
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
  run(S).lbHourly();                                                // 1回目：まだ一時保存に無い教科のファイル（国語の画面など）を取る
  const got = jsd(S).map(u => u.split('/dist/')[1]);
  assert.ok(['core.js', 'app-tamath.js', 'app-kanzi.js', 'html-tamath.json', 'html-kanzi.json'].every(f => got.includes(f)), '全教科のファイルを温める: ' + got.join());
  assert.ok(!got.includes('server.js'), '全部入りは温めない');
  const before = S.fetches.length;
  run(S).lbHourly();
  assert.strictEqual(S.fetches.length, before, '2回目からは jsDelivr に行かずに延ばす');
});

t('直すための材料：開いた・往復・始めるまで・失敗（エラー文つき）を数え、夜に前日までを usage へ。所有者は画面から失敗と速さの書き出しを受け取れる（名前は入らない）', () => {
  const S = school();
  run(S, '11111111@kyoiku.edu.nishi.or.jp').doGet({ parameter: { app: 'tamath', unit: 'kuku' } });
  run(S, '11111111@kyoiku.edu.nishi.or.jp').lbCall('home', 'boot', [{ lastMs: 1200, mem: 8, start: { path: 'now', ms: 3000 } }]);
  const sum = () => Object.keys(S.props).filter(k => k.startsWith('LB_U|')).map(k => JSON.parse(S.props[k])).reduce((a, o) => { for (const k in o) a[k] = (a[k] || 0) + o[k]; return a; }, {});
  const all = sum();
  assert.strictEqual(all['child|boot'], 1); assert.strictEqual(all['child|rt:8GB:2秒未満'], 1); assert.strictEqual(all['child|start:3年:いまの学習:5秒未満'], 1);
  assert.ok(!Object.keys(all).some(k => /open:/.test(k)), 'ページを開いた回数は数えない');
  run(S, '11111111@kyoiku.edu.nishi.or.jp').lbCall('home', 'report', ['jserror', 'TypeError: q is null']);
  assert.strictEqual(sum()['child|js:TypeError: q is null'], 1, '画面からのエラー文が届く');
  // 失敗を数える：呼べる関数が中で失敗した時（児童が学級の設定を変えようとした）。エラー文つき
  assert.throws(() => run(S, '11111111@kyoiku.edu.nishi.or.jp').lbCall('home', 'setNow', ['3-1', []]), /先生だけ/);
  assert.strictEqual(sum()['child|err:home.setNow:先生だけが変えられます'], 1);
  // 書き出し：所有者だけ
  assert.throws(() => run(S, 'other@edu.nishi.or.jp').lbCall('home', 'export', []), /所有者だけ/);
  S.hub.insertSheet('feedback').v.push(['日時', '教師', '学級', '画面', '本文'], [new Date(), 'owner@edu.nishi.or.jp', '3-1', 'home', '田中はなこさんが押し間違えた']);
  const r = run(S).lbCall('home', 'export', []);
  assert.ok(r.ok, (r.problems || []).join());
  assert.ok(!/田中|はなこ|@|11111111/.test(r.text)); assert.match(r.text, /〔[a-z0-9]{2,3}〕さんが押し間違えた/);
  assert.match(r.text, new RegExp('版：' + VER));
  assert.ok(!/候補|分布|正答率/.test(r.text), '学習状態は入れない');
  assert.match(r.text, /err:home\.setNow:先生だけが変えられます \| 1/);
  // 閾値：所有者が保存した値で夜の計算をする
  run(S).lbCall('home', 'saveRules', [{ 'drop.accDrop': 0.2 }, false]);
  assert.strictEqual(S.hub.sheets.rules.v.find(x => x[0] === 'drop.accDrop')[1], 0.2);
  assert.throws(() => run(S, 'other@edu.nishi.or.jp').lbCall('home', 'saveRules', [{ max: 5 }, false]), /所有者だけ/);
  assert.ok(S.hub.sheets.pseudo_2026, '記号表はハブに');
  // 夜：前日までの分を usage へ
  for (const k of Object.keys(S.props)) if (k.startsWith('LB_U|')) { S.props[k.replace(/LB_U\|\d{4}-\d{2}-\d{2}/, 'LB_U|2026-01-05')] = S.props[k]; delete S.props[k]; }
  run(S).lbNightly();
  assert.ok(S.hub.sheets.usage.v.some(r => r[0] === '2026-01-05' && r[2] === 'err:home.setNow:先生だけが変えられます'));
  assert.ok(!Object.keys(S.props).some(k => k.startsWith('LB_U|2026-01-05')));
});
t('月曜のメール：今週の3件が無い週でも、失敗があれば所有者にだけ件数を1行（名前・エラー文は書かない）', () => {
  const S = school();
  assert.strictEqual(run(S).lbWeekly(), 0, '失敗も3件も無ければ送らない');
  assert.throws(() => run(S, '11111111@kyoiku.edu.nishi.or.jp').lbCall('home', 'setNow', ['3-1', []]));
  assert.strictEqual(run(S).lbWeekly(), 1);
  const m = S.mails[S.mails.length - 1];
  assert.strictEqual(m.to, 'owner@edu.nishi.or.jp'); assert.match(m.body, /直近7日の失敗：1 件/);
  assert.ok(!/先生だけ|田中|はなこ/.test(m.body));
});
t('月曜のメール：今週の3件がある週は、失敗の1行を所有者のメールにだけ足す（担任には足さない）', () => {
  const S = school();
  S.hub.insertSheet('teachers').v.push(['メール', '学年', '組'], ['tannin@edu.nishi.or.jp', 3, '1']);
  S.hub.insertSheet('now3').v.push(['学級', '順', 'キー', '種類'], ['3-1', 1, 'drop|x|2026-11-02', 'drop']);
  assert.throws(() => run(S, '11111111@kyoiku.edu.nishi.or.jp').lbCall('home', 'setNow', ['3-1', []]));
  assert.strictEqual(run(S).lbWeekly(), 2);
  const own = S.mails.find(m => m.to === 'owner@edu.nishi.or.jp'), tan = S.mails.find(m => m.to === 'tannin@edu.nishi.or.jp');
  assert.match(own.body, /3年1組：急に崩れた 1/); assert.match(own.body, /（所有者へ）直近7日の失敗：1 件/);
  assert.match(tan.body, /3年1組：急に崩れた 1/); assert.ok(!/失敗/.test(tan.body));
});
t('指示：夜の処理で、期間が終わった指示の結果を出す（本番の集計から）', () => {
  const S = school();
  run(S).doGet({ parameter: {} });
  const c = run(S); c.doGet({ parameter: {} });
  const d = c.LbDirectives.create(S.hub, { classKey: '3-1', lids: ['Labcdefghij'], app: 'tamath', skill: 'math/kuku/k7', days: 7, show: false }, 'owner@edu.nishi.or.jp', '2026-01-05');
  run(S).lbNightly();
  const row = S.hub.sheets.directives.v.find(r => r[0] === d.id);
  assert.strictEqual(row[11], '終了'); assert.ok(JSON.parse(row[12]).enough === false, '記録が無いので「数が少ない」');
});
t('指示の継ぎ目：算数TA が呼ぶ形（LbDirectives.forLearner(ハブ, 学習者ID, "tamath") → [{ id, skill, show }]・WEIGHT_SHARE）と、学習BASE の形が合う', () => {
  const S = school(), c = run(S); c.doGet({ parameter: {} });
  const server = DIST('server.js');
  assert.ok(server.includes("LbDirectives.forLearner(Base.hub(), learner.lid, 'tamath')"), '算数TA が学習BASE の指示を読む');
  assert.ok(server.includes('LbDirectives.WEIGHT_SHARE'), '混ぜる割合は学習BASE の値を使う');
  assert.ok(/directives: \['weight'\]/.test(server), '算数TA の目録が weight を受け取ると宣言');
  const d = c.LbDirectives.create(S.hub, { classKey: '3-1', lids: ['Labcdefghij'], app: 'tamath', skill: 'math/kuku/k7', days: 7, show: true }, 't', c.LbSheets.day());
  assert.strictEqual(JSON.stringify(c.LbDirectives.forLearner(S.hub, 'Labcdefghij', 'tamath')), JSON.stringify([{ id: d.id, skill: 'math/kuku/k7', show: true }]));
  assert.strictEqual(c.LbDirectives.WEIGHT_SHARE, 0.5);
});
t('開くのを速く：ホームの情報をページの枠に入れて返す（</script> を含む名前でも枠が壊れない）。目録は同時に取り始める', () => {
  const S = school();
  S.hub.sheets.roster.v[1][4] = '</script><b>田中';
  const html = run(S, '11111111@kyoiku.edu.nishi.or.jp').doGet({ parameter: {} }).html;
  const m = html.match(/window\.LB_BOOT=(.*?);<\/script>/);
  assert.ok(m, 'ホームの情報が枠にある');
  assert.ok(!html.includes('</script><b>'), '名前の </script> で枠が終わらない');
  const boot = JSON.parse(m[1]);
  assert.strictEqual(boot.role, 'child'); assert.strictEqual(boot.learner.name.indexOf('</script><b>'), 0, '名前はそのまま届く');
  assert.ok(html.includes('<link rel="preload" href="' + boot.pagesUrl + '" as="fetch" crossorigin="anonymous">'));
  const sum = Object.keys(S.props).filter(k => k.startsWith('LB_U|')).map(k => JSON.parse(S.props[k])).reduce((a, o) => Object.assign(a, o), {});
  assert.strictEqual(sum['child|boot'], 1, '開いた回数は枠を作る時に数える');
  run(S, '11111111@kyoiku.edu.nishi.or.jp').lbCall('home', 'beat', [{ lastMs: 2500, mem: 4 }]);
  const sum2 = Object.keys(S.props).filter(k => k.startsWith('LB_U|')).map(k => JSON.parse(S.props[k])).reduce((a, o) => { for (const k in o) a[k] = (a[k] || 0) + o[k]; return a; }, {});
  assert.strictEqual(sum2['child|rt:4GB以下:2〜4秒'], 1, '前回分の記録は表示の後に送る');
});
t('隔離：読み込みで失敗したアプリはそのアプリだけ止まり、学習BASE のホームと夜の処理は動く', () => {
  const S = school();
  const mark = 'var LB_RESOLVE_ = function';
  const f = 'app-tamath.js', i = S.files[f].indexOf(mark);
  assert.ok(i > 0);
  S.files[f] = S.files[f].slice(0, i) + "throw new Error('壊れた版');\n" + S.files[f].slice(i);
  const man = JSON.parse(S.files['manifest.json']); man.files[f] = crypto.createHash('sha256').update(S.files[f], 'utf8').digest('hex');
  S.files['manifest.json'] = JSON.stringify(man);   // 指紋は合っているが、読み込みで失敗する版
  const c = run(S); const home = c.doGet({ parameter: {} }).html;
  assert.match(home, /home\.js/, 'ホームは開く');
  assert.match(run(S, '11111111@kyoiku.edu.nishi.or.jp').doGet({ parameter: { app: 'tamath', unit: 'kuku' } }).html, /いまは ひらけません/);
  assert.throws(() => run(S).apiCall('kuku', 'unitIdsForTest', []), /読み込めません/);
  assert.strictEqual(JSON.stringify(run(S).lbNightly()), '[]', '夜の処理はほかの部分を続ける');
  const sum = Object.keys(S.props).filter(k => k.startsWith('LB_U|')).map(k => JSON.parse(S.props[k])).reduce((a, o) => Object.assign(a, o), {});
  assert.ok(Object.keys(sum).some(k => /err:tamath\.load:壊れた版/.test(k)), '失敗として数える');
});
t('体育：作戦ボードのページを返す（?app=taiiku、page を省いても作戦ボード）。準備は要らない', () => {
  const S = school(), kid = '11111111@kyoiku.edu.nishi.or.jp';
  const a = run(S, kid).doGet({ parameter: { app: 'taiiku' } }).html, b = run(S, kid).doGet({ parameter: { app: 'taiiku', page: 'board' } }).html;
  assert.match(a, /作戦ボード/); assert.match(a, /three@0\.160\.0/); assert.strictEqual(a, b);
  assert.doesNotMatch(a, /\.\.\/\.\.\/\.\.\//, '元のリポジトリへの参照が残っていない');
});
t('国語（漢字の森）：学習BASE の中で動く。準備（KANZI_SS_ID）の前は使えない扱い。枠は版つきの jsDelivr。画面からは app:kanzi の表の関数だけ。名前は大域に出ない', () => {
  const S = school(), kid = '11111111@kyoiku.edu.nishi.or.jp';
  let c = run(S, kid); c.doGet({ parameter: {} });
  assert.strictEqual(JSON.stringify(c.LbPlatform.appsReady()), JSON.stringify({ tamath: true, kanzi: false, taiiku: true }));
  assert.strictEqual(run(S, kid).lbCall('home', 'boot', [{}]).apps.kanzi, false);
  assert.throws(() => run(S, kid).lbCall('app:kanzi', 'api_init', []), /KANZI_SS_ID|app_sheets/);
  // 準備：今の漢字の森のスプレッドシートの ID をプロパティに
  S.props.KANZI_SS_ID = 'KANZIxxxxxxxxxxxxxxxxxxxx';
  const book = makeSS('kanzi');
  book.insertSheet('名簿').v.push(['メール', '学年', '組', '番号', '名前'], [kid, 3, 1, 5, 'はなこ']);
  book.insertSheet('教師').v.push(['メール', '学年', '組']);
  book.insertSheet('進捗').v.push(['メール', 'read', 'write', 'meta', '更新']);
  book.insertSheet('設定').v.push(['キー', '値']);
  S.units = Object.assign(S.units || {}, { KANZIxxxxxxxxxxxxxxxxxxxx: book });
  c = run(S, kid); c.doGet({ parameter: {} });
  assert.strictEqual(c.LbPlatform.appsReady().kanzi, true);
  const page = run(S, kid).doGet({ parameter: { app: 'kanzi' } }).html;
  const commit = MANIFEST.apps.kanzi.commit;
  assert.ok(page.includes('https://cdn.jsdelivr.net/gh/sankisuguya-create/kanzi@' + commit + '/src/app.js'), '取り込んだ版のプログラムを読む');
  assert.ok(!/<script src="src\//.test(page), '相対のままの読み込みが残っていない');
  assert.match(page, /lbCall\("app:kanzi",fn,args\)/);
  const ver = page.match(/<meta name="kanzi-ver" content="([^"]+)">/)[1];
  let info;
  try { info = run(S, kid).lbCall('app:kanzi', 'api_init', []); } catch (e) { info = { err: e.message }; }
  assert.strictEqual(info.err, undefined, '児童として開ける: ' + info.err);
  assert.strictEqual(info.role, 'student'); assert.strictEqual(info.klass, '3-1');
  assert.strictEqual(info.ver, ver, '画面の版とサーバーの版が同じ（版ずれの検知が誤作動しない）');
  assert.throws(() => run(S, kid).lbCall('app:kanzi', 'setup', []), /呼べない関数/);
  assert.throws(() => run(S, kid).lbCall('app:nope', 'x', []), /アプリが見つかりません/);
  assert.throws(() => run(S, kid).lbCall('app:../home', 'boot', []), /呼べない関数/);
  const c2 = run(S, kid); c2.doGet({ parameter: {} });
  ['api_init', 'me_', 'STUDENT_RE', 'lbApi_', 'doGet_', 'UNIT_DEFS'].forEach(n => assert.strictEqual(typeof c2[n], 'undefined', '大域に出ている: ' + n));
  // 大域に出す名前は、アプリが apps.lock.json の globals に宣言したものだけ（ブラウザと共用のファイルが出す Sched・Genko）
  const lock = JSON.parse(fs.readFileSync(path.join(R, 'apps.lock.json'), 'utf8'));
  const declared = [].concat(...Object.keys(lock).filter(k => k !== '_').map(k => lock[k].globals || []));
  const bare = run(S, kid), before = new Set(Object.keys(bare)); bare.doGet({ parameter: {} });
  bare.lbCall('app:kanzi', 'api_init', []); bare.apiCall('kuku', 'unitIdsForTest', []);   // 両方の教科を読み込んでから見る
  const leaked = Object.keys(bare).filter(k => !before.has(k) && !/^(Lb[A-Z]|LB_|Base$|base[A-Z])/.test(k)).sort();
  assert.strictEqual(JSON.stringify(leaked), JSON.stringify(declared.slice().sort()), '宣言していない名前が大域に出ている');
  assert.strictEqual(typeof run(S, kid).apiCall, 'function'); assert.ok(run(S, kid).apiCall('kuku', 'unitIdsForTest', []).length >= 14, '算数は今まで通り');
  // 段階2b：所有者が照らし合わせて、学習BASE の名簿と担当に切り替える
  assert.throws(() => run(S, kid).lbCall('app:kanzi', 'api_lbRosterCheck', []), /所有者/);
  let chk = run(S).lbCall('app:kanzi', 'api_lbRosterCheck', []);
  assert.strictEqual(chk.using, 'sheet'); assert.strictEqual(chk.ok, true, JSON.stringify(chk));
  chk = run(S).lbCall('app:kanzi', 'api_lbRosterUse', [true]);
  assert.strictEqual(chk.using, 'base'); assert.strictEqual(S.props.KANZI_ROSTER, 'base');
  book.sheets['名簿'].v.splice(1);                                   // 漢字の森のシートの名簿を空にしても
  assert.strictEqual(run(S, kid).lbCall('app:kanzi', 'api_init', []).klass, '3-1', '学習BASE の名簿で開ける');
  assert.deepEqual(run(S, 'other@edu.nishi.or.jp').lbCall('app:kanzi', 'api_init', []).classes, ['3-1'], '教師ドメインは全学級（教師シートに無くても）');
});
t('貼り直す前の読み込み係（前の形）でも、新しい dist/ で今まで通り動く（全部入りの server.js・html.json を読む）', () => {
  const OLD = fs.readFileSync(path.join(__dirname, 'fixtures-old-loader.gs'), 'utf8');
  assert.ok(!OLD.includes('lbApp_'), '前の形の読み込み係');
  const S = school({ sha: MANIFEST.server }), kid = '11111111@kyoiku.edu.nishi.or.jp';
  assert.match(run(S, kid, OLD).doGet({ parameter: {} }).html, /home\.js/);
  assert.match(run(S, kid, OLD).doGet({ parameter: { app: 'tamath', unit: 'kuku' } }).html, /var APP_ID = "kuku";/);
  assert.ok(run(S, kid, OLD).apiCall('kuku', 'unitIdsForTest', []).length >= 14);
  assert.strictEqual(run(S, kid, OLD).lbCall('home', 'boot', [{}]).apps.kanzi, false);
  assert.strictEqual(JSON.stringify(run(S, 'owner@edu.nishi.or.jp', OLD).lbNightly()), '[]');
  assert.ok(!jsd(S).some(u => /app-|core\.js|html-/.test(u)), '前の形は全部入りだけを読む');
});
t('速さ：一時保存への往復はふだん（温まった状態）算数の呼び出しで2回・算数のページで4回まで（前の形の読み込み係より少ない）', () => {
  const S = school(), kid = '11111111@kyoiku.edu.nishi.or.jp';
  const call = () => run(S, kid).apiCall('kuku', 'unitIdsForTest', []), page = () => run(S, kid).doGet({ parameter: { app: 'tamath', unit: 'kuku' } });
  call(); call(); page(); page();
  S.trips = 0; call(); const a = S.trips;
  S.trips = 0; page(); const b = S.trips;
  assert.ok(a <= 2, '算数の呼び出し：' + a + '回'); assert.ok(b <= 4, '算数のページ：' + b + '回');
});
const ID_A = 'AAAAAAAAAAAAAAAAAAAAAAAA', ID_K = 'KKKKKKKKKKKKKKKKKKKKKKKK';
t('台帳 app_sheets：前の形のプロパティは台帳に写して使う。無ければ作って BASEシートのフォルダへ。「止める」の行は使わない', () => {
  const S = school(); S.props['unit_sheet:kuku'] = ID_A;
  const c = run(S); c.lbStatus();
  assert.strictEqual(c.LbStores.id('tamath', 'kuku', { legacyProp: 'unit_sheet:kuku' }), ID_A);
  assert.strictEqual(JSON.stringify(S.hub.sheets.app_sheets.v.slice(1).map(r => r.slice(0, 3))), JSON.stringify([['tamath', 'kuku', 'https://docs.google.com/spreadsheets/d/' + ID_A + '/edit']]));
  const made = c.LbStores.id('tamath', 'bai', { legacyProp: 'unit_sheet:bai', create: '算数TA かけ算（bai）' });
  assert.ok(S.units[made] && S.units[made].title === '算数TA かけ算（bai）', '作った');
  assert.strictEqual(S.moved[made], 'folder', 'BASEシートのフォルダへ');
  assert.strictEqual(c.LbStores.id('tamath', 'bai', { create: 'x' }), made, '2回目は作らない');
  assert.strictEqual(c.LbStores.id('kanzi', '', { legacyProp: 'KANZI_SS_ID', peek: true }), '', 'peek は作らない・書かない');
  S.hub.sheets.app_sheets.v[1][3] = '止める'; c.LbStores.forget();
  assert.strictEqual(c.LbStores.id('tamath', 'kuku', { legacyProp: 'unit_sheet:kuku', create: 'x' }), '', '止めた行は使わない（プロパティにあっても）');
  assert.strictEqual(JSON.stringify(c.LbStores.ofApp('tamath').map(r => r.unit)), JSON.stringify(['bai']));
  assert.ok(S.hub.sheets.app_sheets.v.slice(1).every(r => typeof r[4] === 'string'), '作成日は文字のまま（日付に化けない）');
  c.LbStores.add('tamath', '3-1', ID_K, '3-1');
  const r31 = S.hub.sheets.app_sheets.v.find(r => r[2].includes(ID_K));
  assert.ok(r31[1] === '3-1' && r31[4] === '3-1', '「3-1」のような単元名・メモもカレンダーの日付にならない');
});
t('台帳 app_sheets：写し終えた後（lbSetup の後）は前の形のプロパティを読まない。行を消すと、次に使われた時に新しく作る', () => {
  const S = school(); S.props['unit_sheet:kuku'] = ID_A;
  run(S).lbSetup();
  assert.ok(S.props.LB_STORES_LEGACY_DONE, '写し終えた印');
  assert.ok(S.hub.sheets.app_sheets.v.some(r => r[0] === 'tamath' && r[1] === 'kuku'));
  S.hub.sheets.app_sheets.v.splice(S.hub.sheets.app_sheets.v.findIndex(r => r[1] === 'kuku'), 1);   // 先生が行を消した
  delete S.cache['lb:stores'];
  const c = run(S); c.lbStatus();
  assert.strictEqual(c.LbStores.id('tamath', 'kuku', { legacyProp: 'unit_sheet:kuku' }), '', 'プロパティから戻さない');
  const made = c.LbStores.id('tamath', 'kuku', { legacyProp: 'unit_sheet:kuku', create: '算数TA 九九（kuku）' });
  assert.ok(made && made !== ID_A, '新しく作る');
  run(S).lbSetup();
  assert.strictEqual(S.hub.sheets.app_sheets.v.filter(r => r[1] === 'kuku').length, 1, 'lbSetup をもう一度実行しても、消した行は戻らない');
});
t('台帳 app_sheets：紐付けが0件でも、lbSetup・移転で見出しだけのシートを置く', () => {
  const S = school();
  run(S).lbSetup();
  assert.strictEqual(JSON.stringify(S.hub.sheets.app_sheets.v), JSON.stringify([['アプリ', '単元', 'スプレッドシート', '状態', '作成']]));
  const T = school(), NEW = makeSS('BASEyyyyyyyyyyyyyyyyyyyyy'); (T.units = {})[NEW.getId()] = NEW;
  assert.match(run(T).lbMoveOut(NEW.getId()), /写した紐付け：0 件/);
  assert.ok(NEW.sheets.app_sheets, '新しいシートにも台帳');
});
t('先生の学級：teachers シートのその先生の学級で開く（学年だけの行はその学年の最初の学級）。選んだ学級が先。書いていない先生は先頭の学級', () => {
  const S = school();
  S.hub.sheets.roster.v.push(['22222222@kyoiku.edu.nishi.or.jp', 4, 1, 1, '鈴木', 'たろう'], ['33333333@kyoiku.edu.nishi.or.jp', 4, 2, 1, '佐藤', 'じろう'], ['44444444@kyoiku.edu.nishi.or.jp', 5, 3, 1, '高橋', 'さぶろう']);
  run(S).lbSetup();
  assert.strictEqual(JSON.stringify(S.hub.sheets.teachers.v), JSON.stringify([['メール', '姓', '名', 'せい', 'めい', '学年', '組']]), 'lbSetup で見出しだけの teachers を置く');
  S.hub.sheets.teachers.v.push(['t42@edu.nishi.or.jp', '山田', '花', '', '', 4, '２組'], ['t42@edu.nishi.or.jp', '山田', '花', '', '', 3, 1],
    ['t5@edu.nishi.or.jp', '', '', '', '', 5, ''], ['tall@edu.nishi.or.jp', '', '', '', '', '', ''], ['t9@edu.nishi.or.jp', '', '', '', '', 6, 1]);
  run(S).lbReload();
  const boot = (mail, o) => run(S, mail).lbCall('home', 'boot', [o || {}]).classKey;
  assert.strictEqual(boot('t42@edu.nishi.or.jp'), '4-2', '最初の行の学級（「２組」も 2）');
  assert.strictEqual(boot('t5@edu.nishi.or.jp'), '5-3', '学年だけ：その学年の最初の学級');
  assert.strictEqual(boot('tall@edu.nishi.or.jp'), '3-1', '全校の行：先頭の学級');
  assert.strictEqual(boot('t9@edu.nishi.or.jp'), '3-1', '名簿に無い学級：先頭の学級');
  assert.strictEqual(boot('other@edu.nishi.or.jp'), '3-1', 'teachers に無い先生：先頭の学級');
  assert.strictEqual(boot('t42@edu.nishi.or.jp', { classKey: '5-3' }), '5-3', '画面で選んだ学級が先');
});
t('国語の準備：台帳に kanzi の行があれば使える（前の形の KANZI_SS_ID でも）', () => {
  const S = school(), kid = '11111111@kyoiku.edu.nishi.or.jp';
  assert.strictEqual(run(S, kid).lbCall('home', 'boot', [{}]).apps.kanzi, false);
  S.hub.insertSheet('app_sheets').v.push(['アプリ', '単元', 'スプレッドシート', '状態', '作成'], ['kanzi', '', 'https://docs.google.com/spreadsheets/d/' + ID_K + '/edit', '', '']);
  delete S.cache['lb:stores'];
  assert.strictEqual(run(S, kid).lbCall('home', 'boot', [{}]).apps.kanzi, true);
});
t('移転：旧GAS で lbMoveOut → 新しいBASEシート（GAS が付いている）で lbSetup → 旧URL は新しい URL を案内し、旧GAS は夜の処理をしない', () => {
  const S = school();
  S.props['unit_sheet:kuku'] = ID_A; S.props.KANZI_SS_ID = ID_K; S.props['u:kuku:mode'] = '=公開';
  S.hub.insertSheet('teachers').v.push(['メール', '学年', '組'], ['t@edu.nishi.or.jp', 3, 1]);
  S.hub.insertSheet('facts_2026').v.push(['h']);
  S.hub.insertSheet('links').v.push(['id', 'title', 'sub', 'url', 'x', 'color'], ['kuku', '九九', 'ほそく', 'https://script.google.com/macros/s/OLD/exec', '', 'mint'], ['bai', 'かけ', '', '', '', 'sky']);
  S.hub.insertSheet('pages').v.push(['キー', 'URL', '色', '補足', '更新'], ['bai', 'https://script.google.com/macros/s/B/exec', '', '', '']);
  S.hub.insertSheet('an_decisions').v.push(['算数TA の名残り']);
  S.hub.sheets.roster.formulas = [['=IMPORTRANGE("x","roster!A:E")'], ['']];
  S.hub.sheets.pages.formulas = [[''], ['=links!D2']];
  S.hub.editors = ['owner@edu.nishi.or.jp', 'sato@edu.nishi.or.jp'];
  S.triggers.push('lbNightly', 'lbHourly');
  const NEW = makeSS('BASExxxxxxxxxxxxxxxxxxxxx'); NEW.insertSheet('シート1');
  (S.units = S.units || {})[NEW.getId()] = NEW;
  assert.throws(() => run(S, 'kid@kyoiku.edu.nishi.or.jp').lbMoveOut('https://docs.google.com/spreadsheets/d/' + NEW.getId() + '/edit'), /所有者/);
  const msg = run(S).lbMoveOut('https://docs.google.com/spreadsheets/d/' + NEW.getId() + '/edit');
  assert.match(msg, /写さなかった（学習BASE のものでない）：.*links/);
  assert.match(msg, /【要確認】roster に他のファイルを読む数式/);
  assert.match(msg, /【要確認】pages に、写さなかったシート（links）を指す数式/);
  assert.match(msg, /【要確認】旧ハブを編集できた人.*：sato@edu\.nishi\.or\.jp$/m);
  assert.doesNotMatch(msg, /owner@edu\.nishi\.or\.jp/, '所有者は出さない');
  assert.ok(NEW.sheets.roster && NEW.sheets.teachers && NEW.sheets.facts_2026 && NEW.sheets.platform && NEW.sheets.app_sheets, Object.keys(NEW.sheets).join());
  assert.ok(!NEW.sheets.links && !NEW.sheets.an_decisions && !NEW.sheets['シート1'] && !NEW.sheets.platform_code, '算数TA の名残り・空のシートは無い: ' + Object.keys(NEW.sheets).join());
  assert.strictEqual(JSON.stringify(NEW.sheets.pages.v.slice(1).map(r => r[0]).sort()), JSON.stringify(['bai', 'kuku']), 'links の開く先は pages へ（pages にあるものはそのまま）');
  assert.strictEqual(NEW.sheets.pages.v.find(r => r[0] === 'bai')[1], 'https://script.google.com/macros/s/B/exec');
  assert.strictEqual(JSON.stringify(NEW.sheets.app_sheets.v.slice(1).map(r => r[0] + ':' + r[1]).sort()), JSON.stringify(['kanzi:', 'tamath:kuku']));
  assert.strictEqual(S.triggers.length, 0, '旧GAS の自動実行は止める');
  // 旧URL：移転を知らせる（新しい URL はまだ無い）。夜の処理はしない
  assert.match(run(S, '11111111@kyoiku.edu.nishi.or.jp').doGet({ parameter: {} }).html, /ひっこしました[\s\S]*先生に/);
  assert.strictEqual(JSON.stringify(run(S).lbNightly()), '[]');
  // 新しいBASEシートに付けた GAS（HUB_ID なし・別のプロパティ・同じ一時保存の置き場ではない）
  const N = school(); N.props = {}; N.bound = NEW; N.hub = NEW; N.units = S.units; S.units.hub = S.hub;
  const out = run(N).lbSetup();
  assert.match(out, /旧GAS のプロパティを取り込んだ：\d+ 件/);
  assert.strictEqual(N.props['u:kuku:mode'], '=公開', '設定（数式に見える値も）そのまま');
  assert.strictEqual(N.props.HUB_ID, undefined, 'HUB_ID は持ってこない');
  assert.strictEqual(N.props.LB_MOVED_FROM, 'hub');
  assert.ok(!NEW.sheets[' _移転'] && !NEW.sheets['_移転'], '受け渡しのシートは消す');
  assert.match(out, /旧ハブに新しい URL を書いた/);
  S.cache = {};   // 5分たった
  assert.match(run(S, '11111111@kyoiku.edu.nishi.or.jp').doGet({ parameter: {} }).html, /href="https:\/\/script\.google\.com\/a\/macros\/edu\.nishi\.or\.jp\/s\/LB\/exec"/);
  assert.match(run(N, '11111111@kyoiku.edu.nishi.or.jp').doGet({ parameter: {} }).html, /LB_BOOT/, '新しい GAS はふつうに開く');
  assert.match(run(N).lbStatus(), /中身: ○/);
});

t('タブアイコン：ホーム＝学習BASE、算数TA・漢字の森＝それぞれ。学習BASE と同じ版の jsDelivr の .png', () => {
  const S = school(), kid = '11111111@kyoiku.edu.nishi.or.jp';
  assert.strictEqual(run(S, kid).doGet({ parameter: {} }).icon, `https://cdn.jsdelivr.net/gh/sankisuguya-create/learning-base@${VER}/web/icons/favicon/base.png`);
  const ta = run(S, kid).doGet({ parameter: { app: 'tamath', unit: 'kuku' } });
  assert.ok(!ta.icon || /favicon\/tamath\.png$/.test(ta.icon), String(ta.icon));
  const fs2 = require('fs');
  ['base', 'tamath', 'kanzi'].forEach(n => assert.ok(fs2.existsSync(path.join(R, 'web/icons/favicon', n + '.png')), n + '.png がある'));
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
  await page.LB_PLATFORM.call('homeExport'); await page.LB_PLATFORM.call('homeTryRules', { max: 3 });
  assert.strictEqual(JSON.stringify(calls.slice(1).map(c => c[1])), JSON.stringify(['export', 'tryRules']), '画面の名前 homeXxx → 窓口の表の名前');
  // 画面で呼ぶ名前は、すべて窓口の表（LbHome.API）にある（足し忘れると本番だけで「呼べない関数」になる）
  const homeJs = fs.readFileSync(path.join(R, 'web', 'home.js'), 'utf8');
  const used = [...new Set([...homeJs.matchAll(/'home([A-Z]\w*)'/g)].map(m => m[1][0].toLowerCase() + m[1].slice(1)))];
  const c2 = run(school()); c2.doGet({ parameter: {} }); const api = Object.keys(c2.LbHome.API);
  assert.ok(used.length >= 10); used.forEach(n => assert.ok(api.includes(n), '窓口の表に無い：' + n));
  assert.strictEqual(page.LB_PLATFORM.baseUrl, 'https://script.google.com/a/macros/edu.nishi.or.jp/s/LB/exec');
  console.log('ok ホームの画面の Platform 層（呼び出しの変換）');
  console.log(`platform ${n + 1} 件 ok`);
})().catch(e => { console.error(e); process.exit(1); });
