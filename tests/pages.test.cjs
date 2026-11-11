// node tests/pages.test.cjs — 入口（LbPages）と窓口（LbHome）
const assert = require('assert'), fs = require('fs'), path = require('path');
const { loadPure, J } = require('./lb-load.cjs');
const { makeSS } = require('./sheet-mock.cjs');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'pages.json'), 'utf8'));
const { LbPages } = loadPure(['Pages.gs']);

t('目録：リポジトリの pages.json は誤りなし', () => {
  assert.strictEqual(J(LbPages.validate(CAT)), '[]');
});
t('目録：別の GAS で動くページ（kind: link）は linkId が要る。URL は目録に書かない', () => {
  assert.ok(LbPages.validate({ pages: [{ id: 'x', subject: 'sogo', grades: [3], title: 't', kind: 'link' }] }).join().includes('linkId'));
  const tb = CAT.pages.find(p => p.id === 'toi-board');
  assert.strictEqual(tb.kind, 'link'); assert.strictEqual(tb.url, undefined);
  assert.ok(!/script\.google\.com|edu\.nishi/.test(JSON.stringify(CAT)), '学校の URL を公開の目録に書かない');
});

t('目録：誤りを具体的に返す', () => {
  const e = LbPages.validate({ pages: [
    { id: 'A', subject: 'x', grades: [7], kind: 'zzz' },
    { id: 'b', subject: 'kokugo', grades: [1], title: 't', kind: 'page', src: { repo: 'r', path: 'p', ver: 'main' } },
    { id: 'b', subject: 'kokugo', grades: [1], title: 't', kind: 'app', app: 'ok' }] }).join('\n');
  ['id は英小文字', 'src は repo・path・ver', 'id が重複: b'].forEach(w => assert.ok(e.includes(w), w + '\n' + e));
  assert.ok(LbPages.validate({ pages: [{ id: 'c', subject: 'nope', grades: [0], title: 't', kind: 'app', app: 'a' }] }).join().includes('教科が不明'));
});

t('ホーム：その学年の・公開のページだけ。教科は中身のある教科だけ、単元ごとにまとまる', () => {
  const h = LbPages.home(CAT, 3, { publish: {}, now: [] }, '2026-11-10');
  assert.strictEqual(J(h.subjects.map(s => s.id)), J(['kokugo', 'sansu', 'sogo']), '総合（といボード）も出る');
  const sansu = h.bySubject.sansu;
  assert.strictEqual(sansu[0].unit, 'かけ算');
  assert.ok(sansu.every(u => u.pages.every(p => p.grades.includes(3))));
  assert.strictEqual(h.subjects.find(s => s.id === 'sansu').count, 9);
  assert.strictEqual(J(LbPages.home(CAT, 5, {}, '2026-11-10').subjects.map(s => s.id)), J(['kokugo', 'sansu']));
});
t('ページが1つだけの教科は only にそのページ（タイルから直接開く）。2つ以上なら only なし', () => {
  const h = LbPages.home(CAT, 3, { publish: {}, now: [] }, '2026-11-10');
  assert.strictEqual(h.subjects.find(s => s.id === 'kokugo').only.id, 'kanzi');
  assert.strictEqual(h.subjects.find(s => s.id === 'sansu').only, undefined);
  const h2 = LbPages.home(CAT, 3, { publish: {}, now: [] }, '2026-11-10');
  assert.strictEqual(h2.subjects.find(s => s.id === 'sogo').only.id, 'toi-board');
  assert.strictEqual(h2.subjects.find(s => s.id === 'sogo').only.kind, 'link');
  // 公開を絞って1つになった教科も直接開く
  const off = {}; CAT.pages.filter(p => p.subject === 'sansu' && p.id !== 'tamath-kuku').forEach(p => { off[p.id] = false; });
  assert.strictEqual(LbPages.home(CAT, 3, { publish: off, now: [] }, '2026-11-10').subjects.find(s => s.id === 'sansu').only.id, 'tamath-kuku');
});

t('ホーム：教師の公開の切り替えが効く（非公開にした・既定で非公開のものを公開にした）', () => {
  const h = LbPages.home(CAT, 3, { publish: { 'tamath-kuku': false, 'toi-board': false }, now: [] }, '2026-11-10');
  assert.ok(!h.bySubject.sansu.some(u => u.pages.some(p => p.id === 'tamath-kuku')));
  assert.ok(!h.subjects.some(s => s.id === 'sogo'), 'かくしたといボードは出ない');
});
t('いまの学習：期間内・公開・学年が合うものを順に最大3件', () => {
  const now = [
    { page: 'tamath-bai', order: 2 }, { page: 'kanzi', order: 1 },
    { page: 'tamath-volume', order: 3 },                                  // 5年のページ：3年には出ない
    { page: 'tamath-kuku', order: 4, to: '2026-11-09' },                  // 期間が終わった
    { page: 'tamath-length', order: 5, from: '2026-11-11' },              // まだ始まっていない
    { page: 'tamath-weight', order: 6 }, { page: 'tamath-circle', order: 7 }];
  const h = LbPages.home(CAT, 3, { publish: { 'tamath-weight': false }, now }, '2026-11-10');
  assert.strictEqual(J(h.now.map(p => p.id)), J(['kanzi', 'tamath-bai', 'tamath-circle']));
});
t('教師の一覧：公開していないページも出し、公開・いまの学習の状態を添える', () => {
  const v = LbPages.teacherView(CAT, 3, { publish: { 'tamath-kuku': false }, now: [{ page: 'kanzi' }] }, '2026-11-10');
  assert.strictEqual(v.find(x => x.page.id === 'tamath-kuku').on, false);
  assert.strictEqual(v.find(x => x.page.id === 'toi-board').on, true);
  assert.strictEqual(v.find(x => x.page.id === 'kanzi').now, true);
});
t('保存：公開を押すたびに保存・学級ごと・全部もどす。いまの学習は学級の分を入れ替え、3件まで', () => {
  const hub = makeSS('hub');
  LbPages.setPublish(hub, '3-1', 'tamath-kuku', false, 't@x');
  LbPages.setPublish(hub, '3-1', 'tamath-kuku', true, 't@x');           // 同じ行を書き換える
  LbPages.setPublish(hub, '3-2', 'tamath-kuku', false, 't@x');
  assert.strictEqual(hub.sheets.class_pages.v.length, 3);
  assert.strictEqual(LbPages.readSettings(hub, '3-1').publish['tamath-kuku'], true);
  assert.strictEqual(LbPages.readSettings(hub, '3-2').publish['tamath-kuku'], false);
  assert.strictEqual(LbPages.resetPublish(hub, '3-2'), 1);
  assert.strictEqual(LbPages.readSettings(hub, '3-2').publish['tamath-kuku'], undefined);
  assert.strictEqual(LbPages.readSettings(hub, '3-1').publish['tamath-kuku'], true, '他の学級は残る');
  LbPages.setNow(hub, '3-1', [{ page: 'a' }, { page: 'b', from: '2026-11-01', to: '2026-11-30' }, { page: 'c' }, { page: 'd' }], 't@x');
  LbPages.setNow(hub, '3-2', [{ page: 'x' }], 't@x');
  LbPages.setNow(hub, '3-1', [{ page: 'b', from: '2026-11-01', to: '2026-11-30' }, { page: 'a' }, { page: 'c' }, { page: 'd' }], 't@x');
  const s1 = LbPages.readSettings(hub, '3-1');
  assert.strictEqual(J(s1.now.map(x => x.page)), J(['b', 'a', 'c']));
  assert.strictEqual(s1.now[0].to, '2026-11-30');
  assert.strictEqual(J(LbPages.readSettings(hub, '3-2').now.map(x => x.page)), J(['x']));
});

/* ---------- 窓口（権限） ---------- */
function homeEnv(user, rosterRows) {
  const hub = makeSS('hub');
  const fake = {
    me: () => {
      if (user === '1@kyoiku.edu.nishi.or.jp') return { role: 'child', email: user, child: { name: '田中 はなこ', mei: 'はなこ', grade: 3, cls: '1' } };
      if (user.endsWith('@edu.nishi.or.jp') || user === 'sub@example.jp') return { role: 'teacher', email: user };
      return { role: user ? 'guest' : 'none', email: user };
    },
    hub: () => hub,
    roster: () => rosterRows,
    classKey: (g, c) => g + '-' + c,
    canSeeClass: (mail, g, c) => mail.endsWith('@edu.nishi.or.jp') || (mail === 'sub@example.jp' && g === 3 && c === '2'),
    members: (g, c) => rosterRows.filter(r => r.grade === g && r.cls === c)
  };
  const props = {};
  const ctx = loadPure(['Pseudo.gs', 'Catalog.gs', 'LbSession.gs', 'Facts.gs', 'Alerts.gs', 'Directives.gs', 'Telemetry.gs', 'Tuning.gs', 'Export.gs', 'Pages.gs', 'Home.gs'], { Base: fake,
    Utilities: { formatDate: () => '2026-11-10', getUuid: () => require('crypto').randomUUID() },
    CacheService: { getScriptCache: () => ({ store: {}, get(k) { return this.store[k] || null; }, put(k, v) { this.store[k] = String(v); } }) },
    Session: { getActiveUser: () => ({ getEmail: () => user }), getEffectiveUser: () => ({ getEmail: () => 'owner@edu.nishi.or.jp' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      getProperties: () => Object.assign({}, props), deleteProperty: k => { delete props[k]; } }) }, LB_LOADER: { ver: () => 'abc1234' } });
  return { ctx, hub, props };
}
const ROSTER = [{ lid: 'La', grade: 3, cls: '1', no: 1, name: 'あ' }, { lid: 'Lb', grade: 3, cls: '2', no: 1, name: 'い' },
  { lid: 'Lc', grade: 3, cls: '1', no: 30, name: '転入 太郎', provisional: true }, { lid: 'Ld', grade: 4, cls: '1', no: 1, name: 'う' }];

t('窓口：児童は自分の学級の設定だけ。目録の置き場（固定の版）を受け取る', () => {
  const { ctx } = homeEnv('1@kyoiku.edu.nishi.or.jp', ROSTER);
  const b = ctx.LbHome.API.boot({ classKey: '4-1' });                              // 他の学級を指定しても自分の学級
  assert.strictEqual(b.role, 'child'); assert.strictEqual(b.classKey, '3-1');
  assert.strictEqual(b.pagesUrl, 'https://cdn.jsdelivr.net/gh/sankisuguya-create/learning-base@abc1234/catalog/pages.json', '読み込み係と同じ版');
  assert.strictEqual(b.members, undefined, '児童に名簿は渡さない');
  assert.throws(() => ctx.LbHome.API.setPublish('3-1', 'kanzi', false), /先生だけ/);
  assert.throws(() => ctx.LbHome.API.setNow('3-1', [{ page: 'kanzi' }]), /先生だけ/);
});
t('窓口：教師は扱える学級の一覧と、選んだ学級の児童（メールの無い転入生も）を受け取る', () => {
  const { ctx, hub } = homeEnv('na@edu.nishi.or.jp', ROSTER);
  hub.insertSheet('links').v.push(['id', 'title', 'subtitle', 'url', 'grades', 'color', 'visible'], ['kuku', '九九', '3年', 'https://x/exec?unit=kuku', '3', 'mint', true], ['toi-board', 'といボード', '', 'https://y/exec', '3', 'lavender', false]);
  const b = ctx.LbHome.API.boot({ classKey: '3-1' });
  assert.strictEqual(b.links['toi-board'].url, 'https://y/exec', 'といボードの URL はハブの links から（表示しない行でも）');
  assert.strictEqual(b.links.kuku.color, 'mint');
  assert.strictEqual(J(b.classes.map(c => c.key)), J(['3-1', '3-2', '4-1']));
  assert.ok(b.members.some(m => m.name === '転入 太郎' && m.provisional));
  assert.strictEqual(b.members[0].mail, undefined, 'メールは画面に渡さない');
  const s = ctx.LbHome.API.setPublish('3-1', 'kanzi', false);
  assert.strictEqual(s.publish.kanzi, false);
  assert.throws(() => ctx.LbHome.API.setPublish('3-1', 'Bad Id!', false), /ページの名前が不正/);
  const s2 = ctx.LbHome.API.setNow('3-1', [{ page: 'kanzi', from: '2026-11-10', to: 'あした' }, { page: 'Bad Id' }]);
  assert.strictEqual(J(s2.now.map(x => [x.page, x.from, x.to])), J([['kanzi', '2026-11-10', '']]), '不正な日付・id は捨てる');
});
t('窓口：担当外の学級は変えられない（別ドメインの支援員）。名簿にない人はおためしの案内', () => {
  const { ctx } = homeEnv('sub@example.jp', ROSTER);
  assert.strictEqual(J(ctx.LbHome.API.boot().classes.map(c => c.key)), J(['3-2']));
  assert.throws(() => ctx.LbHome.API.setPublish('3-1', 'kanzi', false), /担当していない/);
  assert.ok(ctx.LbHome.API.setPublish('3-2', 'kanzi', false));
  const g = homeEnv('9@kyoiku.edu.nishi.or.jp', ROSTER).ctx.LbHome.API.boot();
  assert.strictEqual(g.role, 'guest'); assert.match(g.message, /とうろく/);
});

t('教科の色：全教科に淡い地の色があり、school-timetable と同じ値。地の上の文字は読める濃さ', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'home.css'), 'utf8');
  const TT = { kokugo: '#FDE8D3', shakai: '#F7E9A8', sansu: '#D7EDF9', rika: '#D9EFD9', seikatsu: '#E9E2F5', sogo: '#E9E2F5', ongaku: '#FBE0EC',
    zuko: '#E8F2CE', katei: '#F3E3D3', taiiku: '#FBDAD7', dotoku: '#EDE7DC', gaikokugo: '#DEE2F7', other: '#E4E7EA' };   // school-timetable src/css/tokens.css
  const Lum = h => { const c = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const cr = (a, b) => { const x = Lum(a), y = Lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const sub = (css.match(/--ink-sub-on-tint:(#[0-9A-Fa-f]{6})/) || [])[1];
  LbPages.SUBJECTS.forEach(s => {
    const m = css.match(new RegExp('--sub-' + s.id + ':(#[0-9A-Fa-f]{6})'));
    assert.ok(m, s.id + ' の色が無い');
    assert.strictEqual(m[1].toUpperCase(), TT[s.id], s.id + ' が school-timetable と違う');
    assert.ok(new RegExp('\\[data-subject=' + s.id + '\\]\\{--tint:var\\(--sub-' + s.id + '\\)\\}').test(css), s.id + ' の当て方が無い');
    assert.ok(cr('#1A1A1A', m[1]) >= 7, s.id + ' 本文');
    assert.ok(cr(sub, m[1]) >= 4.5, s.id + ' 補助の文字 ' + cr(sub, m[1]).toFixed(2));
    assert.ok(cr('#0F5EA8', m[1]) >= 3, s.id + ' 再生の印');
  });
});

t('保存：日付に化けた学級（3-1 → 3月1日）・日付の欄も、読む時に元の形に戻す', () => {
  const hub = makeSS('hub');
  LbPages.setNow(hub, '3-1', [{ page: 'kanzi', from: '2026-11-01', to: '2026-11-30' }], 't@x');
  const sh = hub.sheets.now_learning;
  sh.v.push([new Date(2026, 2, 2), 'tamath-kuku', 1, new Date(2026, 10, 1), '', '', '']);   // 手で書いた行（3-2 が日付に化けた）
  assert.strictEqual(J(LbPages.readSettings(hub, '3-1').now.map(x => [x.page, x.from, x.to])), J([['kanzi', '2026-11-01', '2026-11-30']]));
  assert.strictEqual(LbPages.readSettings(hub, '3-2').now[0].page, 'tamath-kuku');
  assert.strictEqual(LbPages.readSettings(hub, '3-2').now[0].from, '2026-11-01');
  LbPages.setPublish(hub, '3-1', 'kanzi', false, 't@x');
  assert.strictEqual(hub.sheets.class_pages.v[1][0], '3-1', '学級の欄は文字のまま');
});

t('窓口：開くたびに役割ごとに数える（前回の往復の時間は端末別、始めるまで・行き止まりは学年別）。名前は数えない', () => {
  const { ctx, props } = homeEnv('1@kyoiku.edu.nishi.or.jp', ROSTER);
  ctx.LbHome.API.boot({ lastMs: 3100, mem: 4, start: { path: 'tile', ms: 12000 }, dead: 1 });
  const all = Object.values(props).map(v => JSON.parse(v)).reduce((a, o) => Object.assign(a, o), {});
  assert.strictEqual(all['child|boot'], 1); assert.strictEqual(all['child|rt:4GB以下:2〜4秒'], 1);
  assert.strictEqual(all['child|start:3年:教科のタイル:10〜20秒'], 1); assert.strictEqual(all['child|deadend:3年'], 1);
  assert.ok(Object.keys(all).some(k => /^child\|srv:/.test(k)));
  assert.ok(!JSON.stringify(props).match(/田中|はなこ|kyoiku/), '名前・メールは数えるところに入らない');
});
t('窓口：所有者かどうか。閾値を見直す・数える・保存するは所有者だけ。保存した値は次の計算から効く', () => {
  const t1 = homeEnv('na@edu.nishi.or.jp', ROSTER);
  t1.ctx.Base.fy = () => 2026;
  const b = t1.ctx.LbHome.API.boot({ classKey: '3-1' });
  assert.strictEqual(b.owner, false);
  assert.ok(b.members.every(m => !('code' in m)), '記号は渡さない（撮影用は画面の見本）');
  assert.throws(() => t1.ctx.LbHome.API.tuning(), /所有者だけ/); assert.throws(() => t1.ctx.LbHome.API.tryRules({}), /所有者だけ/); assert.throws(() => t1.ctx.LbHome.API.saveRules({ max: 5 }), /所有者だけ/);
  assert.ok(!t1.hub.sheets.rules, '所有者でなければ何も書かない');
  const own = homeEnv('owner@edu.nishi.or.jp', ROSTER);
  own.ctx.Base.fy = () => 2026; own.ctx.Base.teachers = () => [];
  assert.strictEqual(own.ctx.LbHome.API.boot({}).owner, true);
  const tu = own.ctx.LbHome.API.tuning();
  assert.ok(tu.spec.length >= 10); assert.strictEqual(typeof tu.counts.drop, 'number');
  assert.strictEqual(own.ctx.LbHome.API.tryRules({ 'drop.accDrop': 0.1 }).tried.drop, 0);
  const after = own.ctx.LbHome.API.saveRules({ 'drop.accDrop': 0.1 }, true);
  assert.strictEqual(after.spec.find(x => x.path === 'drop.accDrop').changed, true);
  assert.strictEqual(own.ctx.LbAlerts.active(own.hub).drop.accDrop, 0.1);
  assert.ok(own.hub.sheets.now3, '今すぐ計算し直すと now3 を入れ替える');
  assert.throws(() => own.ctx.LbHome.API.saveRules({ 'drop.accDrop': 5 }), /使えない値/);
});
t('窓口：気づきは先生だけ（担当外の学級は不可）。書き出しは所有者だけ。画面の失敗は決めた種類だけ数える', () => {
  const kid = homeEnv('1@kyoiku.edu.nishi.or.jp', ROSTER);
  assert.throws(() => kid.ctx.LbHome.API.feedback('3-1', 'home', 'x'), /先生だけ/);
  assert.throws(() => kid.ctx.LbHome.API.feedback('', 'home', 'x'), /先生だけ/, '学級を空にしても児童は送れない');
  assert.ok(!kid.hub.sheets.feedback);
  assert.throws(() => kid.ctx.LbHome.API.export(), /所有者だけ/);
  const sub = homeEnv('sub@example.jp', ROSTER);
  assert.throws(() => sub.ctx.LbHome.API.feedback('3-1', 'home', 'x'), /担当していない/);
  const tc = homeEnv('na@edu.nishi.or.jp', ROSTER);
  assert.throws(() => tc.ctx.LbHome.API.feedback('3-1', 'home', '   '), /空/);
  assert.strictEqual(tc.ctx.LbHome.API.feedback('3-1', 'home', '今週の3件が多すぎる'), true);
  const row = tc.hub.sheets.feedback.v[1];
  assert.strictEqual(row[2], '3-1', '学級は文字のまま'); assert.strictEqual(row[4], '今週の3件が多すぎる');
  assert.throws(() => tc.ctx.LbHome.API.export(), /所有者だけ/);
  assert.strictEqual(tc.ctx.LbHome.API.report('loadfail'), true); assert.strictEqual(tc.ctx.LbHome.API.report('<script>'), false);
  assert.strictEqual(tc.ctx.LbHome.API.report('jserror', 'TypeError: a is null at 12345678@kyoiku.edu.nishi.or.jp'), true);
  const pj = JSON.stringify(tc.props);
  assert.ok(pj.includes('teacher|client:loadfail')); assert.ok(!pj.includes('script'));
  assert.ok(pj.includes('teacher|js:TypeError: a is null at ＜メール＞')); assert.ok(!pj.includes('kyoiku'));
});

t('共通の部品（Sheets.gs）：日付に化けた学級・日付を戻す。表は作った時に見出しと文字の書式', () => {
  const { LbSheets } = loadPure(['Sheets.gs'], { Utilities: { formatDate: d => d.toISOString().slice(0, 10) } });
  assert.strictEqual(LbSheets.clsCell(new Date(2026, 2, 1)), '3-1'); assert.strictEqual(LbSheets.clsCell(' 3-2 '), '3-2');
  assert.strictEqual(LbSheets.ymd('2026-11-10'), '2026-11-10'); assert.strictEqual(LbSheets.ymd(null), '');
  const ss = makeSS('hub'), sh = LbSheets.sheet(ss, 'x', ['学級', '値'], [1]);
  sh.getRange(2, 1, 1, 2).setValues([['3-1', '2026-11-10']]);
  assert.strictEqual(sh.v[1][0], '3-1', '文字の書式の列は化けない'); assert.ok(sh.v[1][1] instanceof Date, '書式の無い列は化ける（模擬も本物と同じ）');
  assert.strictEqual(LbSheets.sheet(ss, 'x', ['別'], []).v[0][0], '学級', '既にある表の見出しは書き換えない');
  assert.strictEqual(LbSheets.rows(ss, 'x', 2).length, 1); assert.strictEqual(LbSheets.rows(ss, 'none', 2).length, 0);
});
t('窓口：先生の起動の情報に、今週の3件の種類の名前（Alerts.gs の1か所から）', () => {
  const t1 = homeEnv('na@edu.nishi.or.jp', ROSTER);
  const b = t1.ctx.LbHome.API.boot({ classKey: '3-1' });
  assert.strictEqual(b.kinds.names.drop, t1.ctx.LbAlerts.KIND_NAME.drop); assert.strictEqual(b.kinds.labels.drop, '▼ ' + b.kinds.names.drop);
  assert.strictEqual(homeEnv('1@kyoiku.edu.nishi.or.jp', ROSTER).ctx.LbHome.API.boot({}).kinds, undefined, '児童には渡さない');
});

t('窓口：手を打つ（指示）は先生だけ・指示を受け取れるアプリだけ。作るとその項目に「判断が変わった」が付き、今週の3件から消える。やめる・結果を見る・続ける', () => {
  const tc = homeEnv('na@edu.nishi.or.jp', ROSTER), A = tc.ctx.LbAlerts, hub = tc.hub;
  tc.ctx.Base.learner = l => ROSTER.find(r => r.lid === l) || null;
  tc.ctx.LbCatalog.publish(hub, { app: 'tamath', title: '算数', version: 1, skills: [{ key: 's', label: 'S' }], mastery: { minN: 20, acc: 0.9 }, directives: ['weight'] });
  tc.ctx.LbCatalog.publish(hub, { app: 'kanzi', title: '漢字', version: 1, skills: [{ key: 'k', label: 'K' }], mastery: { minN: 20, acc: 0.9 } });
  A.store(hub, { '3-1': [{ key: 'stall|La|tamath|s|w', kind: 'stall', lids: ['La'], app: 'tamath', skill: 's', ev: {}, week: '2026-11-09' },
    { key: 'stall|La|kanzi|k|w', kind: 'stall', lids: ['La'], app: 'kanzi', skill: 'k', ev: {}, week: '2026-11-09' }] });
  const b = tc.ctx.LbHome.API.boot({ classKey: '3-1' });
  assert.strictEqual(J(b.now3.map(x => x.canDirect)), J([true, false]), '目録に weight があるアプリだけ「手を打つ」');
  assert.throws(() => tc.ctx.LbHome.API.direct('3-1', 'stall|La|kanzi|k|w', 14, false), /まだ 指示を受け取れません/);
  const kid = homeEnv('1@kyoiku.edu.nishi.or.jp', ROSTER);
  assert.throws(() => kid.ctx.LbHome.API.direct('3-1', 'x', 14, false), /先生だけ/);
  const r = tc.ctx.LbHome.API.direct('3-1', 'stall|La|tamath|s|w', 7, true);
  assert.strictEqual(r.now3.length, 1, '指示した項目は消える'); assert.strictEqual(r.directives.length, 1);
  assert.strictEqual(r.directives[0].show, true); assert.strictEqual(J(r.directives[0].names), J(['あ'])); assert.strictEqual(r.directives[0].skill, 'S');
  assert.strictEqual(hub.sheets.decisions.v[1][5], '判断が変わった'); assert.match(hub.sheets.decisions.v[1][6], /^指示 D/);
  assert.strictEqual(tc.ctx.LbDirectives.forLearner(hub, 'La', 'tamath', '2026-11-10')[0].show, true);
  const id = r.directives[0].id;
  assert.strictEqual(tc.ctx.LbHome.API.endDirective('3-1', id).directives.length, 0);
  // 結果を見る・続ける（結果の行を作ってから）
  const D = tc.ctx.LbDirectives;
  const d2 = D.create(hub, { classKey: '3-1', lids: ['La'], app: 'tamath', skill: 's', days: 7, show: false }, 't', '2026-10-01');
  D.evaluate(hub, {}, ROSTER, '2026-11-11');   // この検査の日付の模擬はいつも 2026-11-10 を返すので、翌日として結果を出す
  assert.strictEqual(tc.ctx.LbHome.API.boot({ classKey: '3-1' }).results.length, 1);
  const r2 = tc.ctx.LbHome.API.seeResult('3-1', d2.id, 14);
  assert.strictEqual(r2.results.length, 0, '見た結果は消える'); assert.strictEqual(r2.directives.length, 1, '続けると同じ指示が新しく始まる');
  assert.throws(() => tc.ctx.LbHome.API.seeResult('4-1', d2.id, 0), /担当していない|この学級/);
});

t('並び：先生が並べた順にする（無いページは元の順で後ろ）。学級・教科ごとに保存し、空なら目録の順に戻る。学級は文字のまま', () => {
  const P = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.strictEqual(LbPages.sortByOrder(P, ['c', 'a']).map(p => p.id).join(), 'c,a,b,d');
  assert.strictEqual(LbPages.sortByOrder(P, ['zz', 'b']).map(p => p.id).join(), 'b,a,c,d', '目録から消えたページは無視');
  assert.strictEqual(LbPages.sortByOrder(P, []).map(p => p.id).join(), 'a,b,c,d');
  const hub = makeSS('hub');
  LbPages.setOrder(hub, '3-1', 'sansu', ['tamath-kuku', 'tamath-tasu'], 't@x');
  LbPages.setOrder(hub, '3-2', 'sansu', ['tamath-tasu'], 't@x');
  LbPages.setOrder(hub, '3-1', 'kokugo', ['kanzi'], 't@x');
  assert.strictEqual(J(LbPages.readSettings(hub, '3-1').order), J({ sansu: ['tamath-kuku', 'tamath-tasu'], kokugo: ['kanzi'] }));
  assert.ok(hub.sheets.class_order.v.slice(1).every(r => typeof r[0] === 'string'), '学級は文字のまま（書き直したほかの学級の行も化けない）');
  assert.ok(hub.sheets.class_order.v.some(r => r[0] === '3-2'));
  LbPages.setOrder(hub, '3-1', 'sansu', ['tamath-tasu'], 't@x');
  assert.strictEqual(J(LbPages.readSettings(hub, '3-1').order.sansu), J(['tamath-tasu']), '置き換える（足さない）');
  LbPages.setOrder(hub, '3-1', 'sansu', [], 't@x');
  assert.strictEqual(LbPages.readSettings(hub, '3-1').order.sansu, undefined, '空なら目録の順');
  assert.strictEqual(J(LbPages.readSettings(hub, '3-2').order.sansu), J(['tamath-tasu']), 'ほかの学級は変えない');
  assert.throws(() => LbPages.setOrder(hub, '3-1', 'nope', ['a']), /知らない教科/);
  assert.strictEqual(LbPages.setOrder(hub, '3-1', 'sansu', ['ok-1', '<bad>', 'Bad']).join(), 'ok-1', 'ページの名前の形でないものは捨てる');
});
t('窓口：並びを変えられるのは担当の学級の先生だけ', () => {
  const kid = homeEnv('1@kyoiku.edu.nishi.or.jp', ROSTER);
  assert.throws(() => kid.ctx.LbHome.API.setOrder('3-1', 'sansu', ['a']), /先生だけ/);
  const sub = homeEnv('sub@example.jp', ROSTER);
  assert.throws(() => sub.ctx.LbHome.API.setOrder('3-1', 'sansu', ['a']), /担当していない/);
  const tc = homeEnv('na@edu.nishi.or.jp', ROSTER);
  assert.strictEqual(J(tc.ctx.LbHome.API.setOrder('3-1', 'sansu', ['tamath-kuku']).order.sansu), J(['tamath-kuku']));
});

console.log(`pages ${n} 件 ok`);
