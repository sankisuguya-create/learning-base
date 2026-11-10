// node tests/tune.test.cjs — 直すための材料（LbTune）：使われ方・今週の3件の働き・閾値を変えたら・分布（5人未満を伏せる）・記号・書き出しの確かめ
const assert = require('assert');
const { loadPure, J } = require('./lb-load.cjs');
const { makeSS } = require('./sheet-mock.cjs');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

function env(opts = {}) {
  const props = {}, clock = { now: new Date(opts.now || '2026-11-18T10:00:00+09:00') };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(clock.now.getTime()); } static now() { return clock.now.getTime(); } }
  const p = x => String(x).padStart(2, '0');
  const ctx = loadPure(['Pseudo.gs', 'Catalog.gs', 'LbSession.gs', 'Facts.gs', 'Alerts.gs', 'Tune.gs'], {
    Date: FakeDate, Math: Object.create(Math, { random: { value: opts.random || Math.random } }),
    Base: { fyOf: () => 2026 },
    Utilities: { formatDate: (d, tz, f) => { const s = new RealDate(d.getTime() + 9 * 3600e3);
      if (f === 'yyyy-MM-dd') return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())}`; throw new Error(f); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      getProperties: () => Object.assign({}, props), deleteProperty: k => { delete props[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }
  });
  return { ctx, props, clock, T: ctx.LbTune, A: ctx.LbAlerts, F: ctx.LbFacts };
}
const W = (F, k) => F.addWeeks('2026-11-16', -k);
const CAT = { tamath: { app: 'tamath', title: '算数TA', version: 1, skills: [{ key: 's', label: 'S' }, { key: 'm', label: 'M' }], mastery: { minN: 20, acc: 0.9 } } };
function f(acc, week, lid, skill, nn, ok, ms) {
  const l = Math.log(ms || 1000);
  acc[week + '|' + lid + '|tamath|' + skill] = { week, lid, grade: 3, cls: '1', no: 1, app: 'tamath', skill, n: nn, ok, tn: ok, sl: l * ok, sl2: l * l * ok, mis: {}, sess: 1 };
}
const KIDS = [['田中', 'はなこ', 'たなか', 'はなこ'], ['佐藤', '大和', 'さとう', 'やまと'], ['鈴木', '空', 'すずき', 'そら'], ['高橋', 'ゆう', 'たかはし', 'ゆう'],
  ['伊藤', '健', 'いとう', 'けん'], ['渡辺', '美咲', 'わたなべ', 'みさき'], ['山本', '翔', 'やまもと', 'しょう'], ['中村', '陽菜', 'なかむら', 'ひな']];
const ROSTER = KIDS.map((k, i) => ({ lid: 'Lxx' + 'abcdefgh'[i] + '1234567', mail: (10000001 + i) + '@kyoiku.edu.nishi.or.jp', grade: 3, cls: '1', no: i + 1,
  sei: k[0], mei: k[1], seiKana: k[2], meiKana: k[3], name: k[0] + ' ' + k[1] }));
const TEACHERS = [{ mail: 'yamada@edu.nishi.or.jp', sei: '山田', mei: '太郎', seiKana: 'やまだ', meiKana: 'たろう', scopes: [] }];

t('使われ方：数えた分はプロパティに日付ごと。夜に前日までをシートへ1日×区分×出来事で1行（日付は文字のまま）。今日の分は残す', () => {
  const { T, props, clock } = env();
  let r = 0; const seq = [0.01, 0.99, 0.5];
  const e2 = env({ now: '2026-11-17T10:00:00+09:00', random: () => seq[(r++) % 3] });
  e2.T.count('child', ['boot', 'srv:1秒未満']); e2.T.count('child', 'boot'); e2.T.count('teacher', 'boot');
  assert.ok(Object.keys(e2.props).filter(k => k.startsWith('LB_U|2026-11-17|')).length >= 2, '番号で分けて置く');
  e2.clock.now = new Date('2026-11-18T23:00:00+09:00');
  e2.T.count('child', 'boot');                                       // 今日の分
  const hub = makeSS('hub');
  assert.strictEqual(e2.T.flush(hub), 3);
  const v = hub.sheets.usage.v;
  assert.strictEqual(J(v[0]), J(['日付', '区分', '出来事', '回数']));
  assert.ok(v.slice(1).some(x => x[0] === '2026-11-17' && x[1] === 'child' && x[2] === 'boot' && x[3] === 2), '日付は文字のまま・同じ出来事は足す');
  assert.ok(Object.keys(e2.props).every(k => k.startsWith('LB_U|2026-11-18|')), '前日までは消し、今日は残す');
  const u = e2.T.usage(hub, '2026-11-01');
  assert.strictEqual(u['2026-11-17']['child|boot'], 2); assert.strictEqual(u['2026-11-18']['child|boot'], 1, 'まだシートに無い今日の分も読む');
  assert.strictEqual(e2.T.flush(hub), 0, '2回目は何も足さない');
  void T; void props; void clock;
});
t('使われ方：数えるのに失敗しても止めない。区分・出来事の | や空白は消す', () => {
  const { T, props } = env();
  T.count('child', 'open:tamath/kuku|x y');
  assert.ok(JSON.stringify(props).includes('child|open:tamath/kukuxy'));
  const broken = env(); broken.ctx.PropertiesService.getScriptProperties = () => { throw new Error('quota'); };
  broken.T.count('child', 'boot');
  assert.strictEqual(T.speed('srv', 1500), 'srv:1〜2秒'); assert.strictEqual(T.speed('rt', 9000), 'rt:8秒以上');
});
t('今週の3件の働き：出た項目は1回だけ残し、週×種類で 出た・判断が変わった・見た・押されていない を数える', () => {
  const { T, A, F } = env();
  const hub = makeSS('hub'), w0 = W(F, 0);
  const by = { '3-1': [{ key: 'drop|a|' + w0, kind: 'drop', week: w0 }, { key: 'stall|b|' + w0, kind: 'stall', week: w0 }, { key: 'stall|c|' + w0, kind: 'stall', week: w0 }] };
  assert.strictEqual(T.logAlerts(hub, by, '2026-11-17'), 3);
  assert.strictEqual(T.logAlerts(hub, by, '2026-11-18'), 0, '同じキーは2回残さない');
  assert.strictEqual(hub.sheets.now3_log.v[1][0], w0, '週は文字のまま');
  A.decide(hub, '3-1', { key: 'drop|a|' + w0, kind: 'drop' }, 'changed', '', 't@edu.nishi.or.jp');
  A.decide(hub, '3-1', { key: 'stall|b|' + w0, kind: 'stall' }, 'seen', '', 't@edu.nishi.or.jp');
  const p = T.performance(hub, '2026-11-18', 8);
  assert.strictEqual(J(p.map(r => [r.kind, r.fired, r.changed, r.seen, r.open])), J([['drop', 1, 1, 0, 0], ['stall', 2, 0, 1, 1]]));
});
t('閾値を変えたら：いまの値の行と、1つずつ変えた行。下がり幅12ポイントは 0.15 では出ず 0.10 で出る', () => {
  const { T, F } = env();
  const acc = {};
  for (let k = 1; k <= 4; k++) f(acc, W(F, k), ROSTER[0].lid, 's', 10, 9, 1500);    // 90%
  f(acc, W(F, 0), ROSTER[0].lid, 's', 50, 39, 1500);                                 // 78%：12ポイント
  const rows = T.sensitivity(acc, ROSTER, CAT, '2026-11-18');
  assert.strictEqual(rows[0].rule, 'いまの値'); assert.strictEqual(rows[0].drop, 0);
  const lo = rows.find(r => r.rule === 'drop.accDrop' && r.value === 0.10);
  assert.strictEqual(lo.drop, 1); assert.strictEqual(lo.now, 0.15); assert.strictEqual(lo.classes, 1);
  assert.strictEqual(env().A.RULES.drop.accDrop, 0.15, 'いまの規則は書き換えない');
  assert.strictEqual(rows.length, 1 + T.VARIANTS.reduce((a, v) => a + v[1].length, 0));
});
t('分布：区間ごとの児童の数。1〜4人は「5人未満」・0 は 0・5人以上は数。学年の問題数は今週5人未満なら —', () => {
  const { T, F } = env();
  const acc = {};
  // 6人：今週・前の4週とも10問。前は90%、今週は 3人が 60%（30ポイント下がる）・3人が 90%（0ポイント）
  ROSTER.slice(0, 6).forEach((r, i) => { for (let k = 1; k <= 4; k++) f(acc, W(F, k), r.lid, 's', 10, 9, 1500); f(acc, W(F, 0), r.lid, 's', 10, i < 3 ? 6 : 9, 1500); });
  const d = T.distributions(acc, ROSTER, CAT, '2026-11-18');
  const h = Object.fromEntries(d.hist.dropAcc);
  assert.strictEqual(h['20以上'], '5人未満'); assert.strictEqual(h['0〜5'], '5人未満'); assert.strictEqual(h['上がった'], '0');
  assert.strictEqual(d.grades[0].week, '6'); assert.strictEqual(d.grades[0].n, '60');
  const kidsOnly = Object.assign({}, d.hist); delete kidsOnly.klassShare;     // 学級でつまずき はまとまりの数（児童の数ではない）
  assert.ok(!JSON.stringify([kidsOnly, d.grades.map(g => [g.week, g.month])]).match(/"[1-4]"/), '児童の数に 1〜4 がどこにも出ない');
  assert.strictEqual(Object.fromEntries(d.hist.klassShare)['3割未満'], '1', '直近2週では 75% なので低い児童はいない');
  const acc2 = {}; ROSTER.slice(0, 2).forEach(r => f(acc2, W(F, 0), r.lid, 's', 10, 9, 1500));
  const d2 = T.distributions(acc2, ROSTER, CAT, '2026-11-18');
  assert.strictEqual(d2.grades[0].week, '5人未満'); assert.strictEqual(d2.grades[0].n, '—', '少ない学年の問題数は出さない');
  assert.strictEqual(T.people(0), '0'); assert.strictEqual(T.people(4), '5人未満'); assert.strictEqual(T.people(5), '5');
});
t('記号：初めてで全員に振ってハブに保存。2回目は同じ記号。転入生にだけ新しく振る', () => {
  const { T } = env();
  const hub = makeSS('hub');
  const a = T.codes(hub, 2026, ROSTER.slice(0, 6), TEACHERS);
  assert.strictEqual(hub.sheets.pseudo_2026.v.length, 1 + 7, '児童6人＋先生1人');
  const b = T.codes(hub, 2026, ROSTER.slice(0, 6), TEACHERS);
  assert.strictEqual(J(b.codeOf), J(a.codeOf));
  const c = T.codes(hub, 2026, ROSTER, TEACHERS);
  ROSTER.slice(0, 6).forEach(r => assert.strictEqual(c.codeOf[r.lid], a.codeOf[r.lid]));
  assert.ok(c.codeOf[ROSTER[7].lid]); assert.strictEqual(hub.sheets.pseudo_2026.v.length, 1 + 9);
  assert.strictEqual(T.codeOf(hub, 2026)[ROSTER[0].lid], a.codeOf[ROSTER[0].lid]);
});
t('最後の確かめ：名前・メール・学習者ID が残っていれば止める', () => {
  const { T } = env();
  const tbl = T.codes(makeSS('hub'), 2026, ROSTER, TEACHERS);
  assert.ok(T.guard('学級全体で九九が遅い', tbl, ROSTER).ok);
  assert.match(T.guard('田中さんが遅い', tbl, ROSTER).problems.join(), /名前/);
  assert.match(T.guard('たなか はなこ', tbl, ROSTER).problems.join(), /名前/);
  assert.match(T.guard('連絡は yamada@edu.nishi.or.jp', tbl, ROSTER).problems.join(), /メール/);
  assert.match(T.guard('ID ' + ROSTER[3].lid, tbl, ROSTER).problems.join(), /学習者ID/);
});

function exportEnv() {
  const e = env();
  const hub = makeSS('hub'), acc = {};
  ROSTER.forEach((r, i) => { for (let k = 0; k < 8; k++) f(acc, W(e.F, k), r.lid, 'm', 6, 4, 2500); });
  e.T.logAlerts(hub, { '3-1': [{ key: 'stall|x|' + W(e.F, 0), kind: 'stall', week: W(e.F, 0) }] }, '2026-11-18');
  e.T.saveFeedback(hub, 'yamada@edu.nishi.or.jp', '3-1', 'home', '佐藤大和さんの「伸びが止まった」は外れ。はなこは家で練習している。空が泣いた。山田より');
  e.T.count('teacher', 'boot'); e.T.count('child', 'err:home.boot');
  return Object.assign(e, { hub, acc });
}
t('改善用の書き出し：気づきの名前は記号に。先生のメールは「先生1」、学級は学年だけ。人数は伏せる。最後の確かめを通る', () => {
  const { T, hub, acc } = exportEnv();
  const r = T.exportText({ hub, fy: 2026, today: '2026-11-18', ver: 'abc1234', roster: ROSTER, teachers: TEACHERS, acc, cats: CAT, settings: [{ classKey: '3-1', hidden: 2, now: 1 }] });
  assert.ok(r.ok, r.problems.join());
  ['佐藤', '大和', 'はなこ', '山田', 'yamada', '@', '3-1', ROSTER[0].lid].forEach(s => assert.ok(!r.text.includes(s), '残っている：' + s));
  assert.match(r.text, /先生1・3年・home：〔[a-z0-9]{2,3}〕さんの「伸びが止まった」は外れ。〔[a-z0-9]{2,3}〕は家で練習している/);
  assert.match(r.text, /空が泣いた/, '1文字の名前は単独では置き換えない');
  assert.ok(r.notes.some(x => x.includes('「空」')), '…代わりに画面で目の確かめを頼む');
  assert.match(r.text, /## 3\. 閾値を1つ変えたら/); assert.match(r.text, /\| stall\.minN \| 20 \| 10 \|/);
  assert.match(r.text, /\| 3年 \| 8 \| 8 \| 48 \|/);
  assert.match(r.text, /\| 週 \| 種類 \| 出た/); assert.match(r.text, /伸びが止まった \| 1 \| 0 \| 0 \| 1/);
  assert.match(r.text, /child \| err:home\.boot \| 1 \| 0/); assert.match(r.text, /teacher \| boot \| 1 \| 0/);
  assert.match(r.text, /かくしたページ：計 2 件（1 学級）/);
});
t('改善用の書き出し：技能の名前が児童の名前と同じ表記でも記号に置き換え、画面で知らせる。置き換えを外すと最後の確かめで止まる', () => {
  const { T, hub, acc } = exportEnv();
  const r = T.exportText({ hub, fy: 2026, today: '2026-11-18', ver: '佐藤大和', roster: ROSTER, teachers: TEACHERS, acc, cats: CAT, settings: [] });
  assert.ok(r.ok); assert.ok(!r.text.includes('佐藤'));
  assert.ok(r.notes.some(x => x.includes('気づき以外')));
  // 置き換えが壊れた時の備え：置き換えを何もしない関数にすると、確かめで止まり、文を返さない
  const e2 = exportEnv(), real = e2.ctx.LbPseudo.replace;
  let calls = 0;
  e2.ctx.LbPseudo.replace = (text, tbl) => (++calls <= 2 ? { text, hits: [], skipped1: [], warn: [] } : real(text, tbl));
  const r2 = e2.T.exportText({ hub: e2.hub, fy: 2026, today: '2026-11-18', ver: 'v', roster: ROSTER, teachers: TEACHERS, acc: e2.acc, cats: CAT, settings: [] });
  assert.strictEqual(r2.ok, false); assert.strictEqual(r2.text, ''); assert.match(r2.problems.join(), /名前/);
});

console.log('tune', n, '件 ok');
