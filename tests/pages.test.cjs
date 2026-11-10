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
  assert.strictEqual(J(h.subjects.map(s => s.id)), J(['kokugo', 'sansu']), '総合（といボード）は既定で非公開');
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
  const h2 = LbPages.home(CAT, 3, { publish: { 'toi-board': true }, now: [] }, '2026-11-10');
  assert.strictEqual(h2.subjects.find(s => s.id === 'sogo').only.id, 'toi-board');
  // 公開を絞って1つになった教科も直接開く
  const off = {}; CAT.pages.filter(p => p.subject === 'sansu' && p.id !== 'tamath-kuku').forEach(p => { off[p.id] = false; });
  assert.strictEqual(LbPages.home(CAT, 3, { publish: off, now: [] }, '2026-11-10').subjects.find(s => s.id === 'sansu').only.id, 'tamath-kuku');
});

t('ホーム：教師の公開の切り替えが効く（非公開にした・既定で非公開のものを公開にした）', () => {
  const h = LbPages.home(CAT, 3, { publish: { 'tamath-kuku': false, 'toi-board': true }, now: [] }, '2026-11-10');
  assert.ok(!h.bySubject.sansu.some(u => u.pages.some(p => p.id === 'tamath-kuku')));
  assert.ok(h.subjects.some(s => s.id === 'sogo'));
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
  assert.strictEqual(v.find(x => x.page.id === 'toi-board').on, false);
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
  const ctx = loadPure(['Pages.gs', 'Home.gs'], { Base: fake,
    Utilities: { formatDate: () => '2026-11-10' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }, LB_LOADER: { ver: () => 'abc1234' } });
  return { ctx, hub };
}
const ROSTER = [{ lid: 'La', grade: 3, cls: '1', no: 1, name: 'あ' }, { lid: 'Lb', grade: 3, cls: '2', no: 1, name: 'い' },
  { lid: 'Lc', grade: 3, cls: '1', no: 30, name: '転入 太郎', provisional: true }, { lid: 'Ld', grade: 4, cls: '1', no: 1, name: 'う' }];

t('窓口：児童は自分の学級の設定だけ。目録の置き場（固定の版）を受け取る', () => {
  const { ctx } = homeEnv('1@kyoiku.edu.nishi.or.jp', ROSTER);
  const b = ctx.homeBoot({ classKey: '4-1' });                              // 他の学級を指定しても自分の学級
  assert.strictEqual(b.role, 'child'); assert.strictEqual(b.classKey, '3-1');
  assert.strictEqual(b.pagesUrl, 'https://cdn.jsdelivr.net/gh/sankisuguya-create/learning-base@abc1234/catalog/pages.json', '読み込み係と同じ版');
  assert.strictEqual(b.members, undefined, '児童に名簿は渡さない');
  assert.throws(() => ctx.homeSetPublish('3-1', 'kanzi', false), /先生だけ/);
  assert.throws(() => ctx.homeSetNow('3-1', [{ page: 'kanzi' }]), /先生だけ/);
});
t('窓口：教師は扱える学級の一覧と、選んだ学級の児童（メールの無い転入生も）を受け取る', () => {
  const { ctx } = homeEnv('na@edu.nishi.or.jp', ROSTER);
  const b = ctx.homeBoot({ classKey: '3-1' });
  assert.strictEqual(J(b.classes.map(c => c.key)), J(['3-1', '3-2', '4-1']));
  assert.ok(b.members.some(m => m.name === '転入 太郎' && m.provisional));
  assert.strictEqual(b.members[0].mail, undefined, 'メールは画面に渡さない');
  const s = ctx.homeSetPublish('3-1', 'kanzi', false);
  assert.strictEqual(s.publish.kanzi, false);
  assert.throws(() => ctx.homeSetPublish('3-1', 'Bad Id!', false), /ページの名前が不正/);
  const s2 = ctx.homeSetNow('3-1', [{ page: 'kanzi', from: '2026-11-10', to: 'あした' }, { page: 'Bad Id' }]);
  assert.strictEqual(J(s2.now.map(x => [x.page, x.from, x.to])), J([['kanzi', '2026-11-10', '']]), '不正な日付・id は捨てる');
});
t('窓口：担当外の学級は変えられない（別ドメインの支援員）。名簿にない人はおためしの案内', () => {
  const { ctx } = homeEnv('sub@example.jp', ROSTER);
  assert.strictEqual(J(ctx.homeBoot().classes.map(c => c.key)), J(['3-2']));
  assert.throws(() => ctx.homeSetPublish('3-1', 'kanzi', false), /担当していない/);
  assert.ok(ctx.homeSetPublish('3-2', 'kanzi', false));
  const g = homeEnv('9@kyoiku.edu.nishi.or.jp', ROSTER).ctx.homeBoot();
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

console.log(`pages ${n} 件 ok`);
