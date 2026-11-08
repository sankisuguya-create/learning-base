// node tests/base.test.cjs
const assert = require('assert');
const { load } = require('./gas-mock.cjs');
let n = 0;
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));   // vm の別世界の配列も比べられるように
function t(name, fn) { fn(); n++; console.log('ok', name); }

const NEW_ROSTER = [
  ['メール', '学年', '組', '番号', '姓', '名', 'せい', 'めい'],
  ['12345678@kyoiku.edu.nishi.or.jp', 3, 1, 5, '田中', 'はなこ', 'たなか', 'はなこ'],
  ['22222222@kyoiku.edu.nishi.or.jp', 3, '2組', 1, '佐藤', '空', 'さとう', 'そら'],
  ['33333333@kyoiku.edu.nishi.or.jp', 3, '１', 2, '', '', '', ''],          // 名前なし
];
const OLD_ROSTER = [
  ['email', '学年', '組', '番号', '氏名'],
  ['12345678@KYOIKU.edu.nishi.or.jp', 3, 1, 5, '田中　はなこ'],
  ['email', '学年', '組', '番号', '氏名'],                                    // 縦積みで混ざった見出し
  ['44444444@kyoiku.edu.nishi.or.jp', 3, 1, 6, 'ジョン'],
  ['12345678@kyoiku.edu.nishi.or.jp', 3, 1, 5, '重複'],
];
const TEACHERS = [
  ['メール', '姓', '名', 'せい', 'めい', '学年', '組'],
  ['na@edu.nishi.or.jp', '西', '先生', 'にし', 'せんせい', 3, 1],
  ['na@edu.nishi.or.jp', '西', '先生', 'にし', 'せんせい', 4, ''],
  ['shien@example.jp', '支援', '員', '', '', '', ''],
  ['kocho@edu.nishi.or.jp', '', '', '', '', 0, ''],
];

t('年度：3/31 と 4/1 の境目（JST）', () => {
  const { Base } = load();
  assert.strictEqual(Base.fyOf(new Date('2027-03-31T23:59:00+09:00')), 2026);
  assert.strictEqual(Base.fyOf(new Date('2027-04-01T00:00:00+09:00')), 2027);
  assert.strictEqual(Base.fyOf(new Date('2027-03-31T15:30:00Z')), 2027);   // UTC では3月でも JST は4/1
  assert.strictEqual(Base.fyOf(0), 0);
  assert.strictEqual(Base.fy(), 2026);
});

t('ドメインは完全一致（児童は教師ドメインのサブドメイン）', () => {
  const { Base } = load();
  assert.strictEqual(Base.isTeacherDomain('a@kyoiku.edu.nishi.or.jp'), false);
  assert.strictEqual(Base.isTeacherDomain('a@edu.nishi.or.jp'), true);
  assert.strictEqual(Base.isTeacherDomain('a@EDU.nishi.or.jp'), true);
  assert.strictEqual(Base.isChildDomain('a@kyoiku.edu.nishi.or.jp'), true);
});

t('新形式の名簿：姓名・ふりがな・組の表記ゆれ', () => {
  const { Base } = load({ active: { roster: NEW_ROSTER } });
  const r = Base.roster();
  assert.strictEqual(r.length, 3);
  same(
    { name: r[0].name, sei: r[0].sei, seiKana: r[0].seiKana, cls: r[0].cls }, { name: '田中 はなこ', sei: '田中', seiKana: 'たなか', cls: '1' });
  assert.strictEqual(r[1].cls, '2');
  assert.strictEqual(r[2].cls, '1');
  assert.strictEqual(r[2].name, '');
});

t('旧形式の名簿（算数TAハブ）：氏名を分け、見出しの混入と重複を捨てる', () => {
  const { Base } = load({ active: { roster: OLD_ROSTER } });
  const r = Base.roster();
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].mail, '12345678@kyoiku.edu.nishi.or.jp');
  same([r[0].sei, r[0].mei, r[0].name], ['田中', 'はなこ', '田中 はなこ']);
  same([r[1].sei, r[1].mei, r[1].name], ['ジョン', '', 'ジョン']);
});

t('重複：先の行に名前が無く後の行にあれば後の行', () => {
  const { Base } = load();
  const r = Base._readRoster([['メール', '姓'], ['a@x.jp', ''], ['a@x.jp', '後']]);
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].sei, '後');
});

t('役割：児童・名前なし児童はおためし・教師ドメイン・別ドメインの支援員・メールなし', () => {
  const sheets = { roster: NEW_ROSTER, teachers: TEACHERS };
  let m = load({ user: '12345678@kyoiku.edu.nishi.or.jp', active: sheets }).Base.me();
  assert.strictEqual(m.role, 'child'); assert.strictEqual(m.child.no, 5);
  assert.strictEqual(load({ user: '33333333@kyoiku.edu.nishi.or.jp', active: sheets }).Base.me().role, 'guest');
  assert.strictEqual(load({ user: '99999999@kyoiku.edu.nishi.or.jp', active: sheets }).Base.me().role, 'guest');
  m = load({ user: 'nobody@edu.nishi.or.jp', active: sheets }).Base.me();
  assert.strictEqual(m.role, 'teacher'); same(m.teacher.scopes, []);
  assert.strictEqual(load({ user: 'shien@example.jp', active: sheets }).Base.me().role, 'teacher');
  assert.strictEqual(load({ user: '', active: sheets }).Base.me().role, 'none');
});

t('担当（既定）：教師ドメインは全学級、別ドメインは担当だけ、児童は不可', () => {
  const { Base } = load({ active: { roster: NEW_ROSTER, teachers: TEACHERS }, owner: 'owner@edu.nishi.or.jp' });
  assert.strictEqual(Base.canSeeClass('na@edu.nishi.or.jp', 3, 2), true);
  assert.strictEqual(Base.canSeeClass('nobody@edu.nishi.or.jp', 3, 1), true);
  assert.strictEqual(Base.canSeeClass('12345678@kyoiku.edu.nishi.or.jp', 3, 1), false);
  assert.strictEqual(Base.canSeeClass('shien@example.jp', 1, 1), true);
  const t2 = load({ active: { teachers: [['メール', '学年', '組'], ['sub@example.jp', 3, 1]] } }).Base;
  assert.strictEqual(t2.canSeeClass('sub@example.jp', 3, 1), true);
  assert.strictEqual(t2.canSeeClass('sub@example.jp', 3, 2), false);
  assert.strictEqual(t2.canSeeClass('other@example.jp', 3, 1), false);
});

t('担当（STRICT_SCOPE=true）：学級・学年全体・全校・載っていない教師・所有者', () => {
  const env = load({ active: { roster: NEW_ROSTER, teachers: TEACHERS }, owner: 'owner@edu.nishi.or.jp', strict: true });
  const Base = env.Base;
  assert.strictEqual(Base.canSeeClass('na@edu.nishi.or.jp', 3, '1組'), true);
  assert.strictEqual(Base.canSeeClass('na@edu.nishi.or.jp', 3, 2), false);
  assert.strictEqual(Base.canSeeClass('na@edu.nishi.or.jp', 4, 3), true);
  assert.strictEqual(Base.canSeeClass('kocho@edu.nishi.or.jp', 6, 2), true);
  assert.strictEqual(Base.canSeeClass('shien@example.jp', 1, 1), true);       // 学年も空＝全校
  assert.strictEqual(Base.canSeeClass('nobody@edu.nishi.or.jp', 3, 1), false);
  assert.strictEqual(Base.canSeeClass('owner@edu.nishi.or.jp', 1, 1), true);
});

t('ハブ：HUB_ID があれば開き、名簿は保存分から読む（2回目は開かない）', () => {
  const { Base, calls } = load({ props: { HUB_ID: 'HUBxxxxxxxxxxxxxxxxxxxxx' }, byId: { HUBxxxxxxxxxxxxxxxxxxxxx: { roster: NEW_ROSTER } } });
  Base.roster(); Base.roster(); Base.child('12345678@kyoiku.edu.nishi.or.jp');
  assert.strictEqual(calls.openById, 1);
});

t('保存：100KB を越える名簿も分けて保存し、そのまま戻る', () => {
  const big = [['メール', '学年', '組', '番号', '姓', '名']];
  for (let i = 0; i < 2000; i++) big.push([`${10000000 + i}@kyoiku.edu.nishi.or.jp`, 1 + (i % 6), 1 + (i % 4), i % 35, '長い名字'.repeat(5), '名前'.repeat(5)]);
  const env = load({ props: { HUB_ID: 'HUBxxxxxxxxxxxxxxxxxxxxx' }, byId: { HUBxxxxxxxxxxxxxxxxxxxxx: { roster: big } } });
  const a = env.Base.roster();
  const parts = Number(env.store['base:roster:2026']);
  assert.ok(parts >= 2, 'parts=' + parts);
  Object.keys(env.store).forEach(k => assert.ok(Buffer.byteLength(env.store[k]) <= 100 * 1000, k + ' が100KBを越える'));
  const b = env.Base.roster();
  same(b, a); assert.strictEqual(env.calls.openById, 1);
  env.Base.clearCache();
  assert.strictEqual(Object.keys(env.store).length, 0);
});

t('過去年度：roster_<年度> が無ければ空、現在年度の名簿が無ければ止める', () => {
  const { Base } = load({ active: { roster: NEW_ROSTER, roster_2025: OLD_ROSTER } });
  assert.strictEqual(Base.roster(2025).length, 2);
  same(Base.roster(2024), []);
  assert.throws(() => load({ active: {} }).Base.roster(), /名簿のシート/);
});

t('setHub：URL から ID を取り出し、開けなければ止める', () => {
  const env = load({ byId: { '1AbCdEfGhIjKlMnOpQrStUvWxYz012345': { roster: NEW_ROSTER } } });
  env.Base.setHub('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=0');
  assert.strictEqual(env.props.HUB_ID, '1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
  assert.throws(() => env.Base.setHub('1ZZZZZZZZZZZZZZZZZZZZZZZZZZZ'), /開けません/);
  assert.throws(() => env.Base.setHub('abc'), /URLかID/);
});

t('エディタ用の関数は所有者だけ（画面から呼ばれてもハブを付け替えられない）', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const kid = load({ user: '12345678@kyoiku.edu.nishi.or.jp', byId: { [id]: { roster: NEW_ROSTER } } });
  assert.throws(() => kid.ctx.baseSetHub(id), /所有者/);
  assert.throws(() => kid.ctx.baseClearCache(), /所有者/);
  assert.strictEqual(kid.props.HUB_ID, undefined);
  const own = load({ user: 'owner@edu.nishi.or.jp', byId: { [id]: { roster: NEW_ROSTER } } });
  own.ctx.baseSetHub(id);
  assert.strictEqual(own.props.HUB_ID, id);
});

t('名簿にない人：保存分を使わずに1回だけ読み直す（転入生）。10分以内は読み直さない', () => {
  const id = 'HUBxxxxxxxxxxxxxxxxxxxxx';
  const rows = NEW_ROSTER.map(r => r.slice());
  const env = load({ props: { HUB_ID: id }, byId: { [id]: { roster: rows } } });
  assert.strictEqual(env.Base.child('55555555@kyoiku.edu.nishi.or.jp'), null);   // まだいない
  const opened = env.calls.openById;
  rows.push(['55555555@kyoiku.edu.nishi.or.jp', 3, 1, 9, '転入', '花']);         // 名簿に足す
  assert.strictEqual(env.Base.child('55555555@kyoiku.edu.nishi.or.jp'), null, '10分以内は読み直さない');
  assert.strictEqual(env.calls.openById, opened);
  delete env.store['base:roster-reload'];                                        // 10分たった
  assert.strictEqual(env.Base.child('55555555@kyoiku.edu.nishi.or.jp').name, '転入 花');
  assert.strictEqual(env.Base.child('12345678@kyoiku.edu.nishi.or.jp').name, '田中 はなこ', '名簿にいる人は保存分から');
});

t('組の正規化', () => {
  const { Base } = load();
  assert.strictEqual(Base.normCls('１組'), '1');
  assert.strictEqual(Base.normCls(' 01 '), '1');
  assert.strictEqual(Base.normCls('A'), 'A');
  assert.strictEqual(Base.classKey('3', '2組'), '3-2');
});

console.log(`\n${n} 件 すべて通過`);
