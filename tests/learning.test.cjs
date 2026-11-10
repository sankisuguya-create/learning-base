// node tests/learning.test.cjs — 目録（Catalog）・セッション（LbSession）・集計（LbFacts）
const assert = require('assert');
const { loadPure, J } = require('./lb-load.cjs');
const { makeSS } = require('./sheet-mock.cjs');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const fakeBase = { fyOf: d => { const x = new Date(new Date(d).getTime() + 9 * 3600e3); return x.getUTCMonth() >= 3 ? x.getUTCFullYear() : x.getUTCFullYear() - 1; },
  child: mail => (mail.startsWith('1') ? { lid: 'L' + mail.slice(0, 2), mail, grade: 3, cls: '1', no: Number(mail[1]) } : null),
  learner: lid => (lid === 'Ltennyu' ? { lid, mail: '', grade: 3, cls: '1', no: 30, provisional: true } : null) };
const ctx = loadPure(['Catalog.gs', 'LbSession.gs', 'Facts.gs'], {
  Base: fakeBase, LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) } });
const { LbCatalog, LbSession, LbFacts } = ctx;

const CAT = { app: 'tamath', title: '算数TA', version: 1,
  skills: [{ key: 'math/mul/kuku/7', label: '7の段' }, { key: 'math/mul/kuku/8', label: '8の段', mastery: { acc: 0.95, gmMs: 2000 } }],
  misconceptions: [{ key: 'adj', label: '隣の段' }], mastery: { minN: 4, acc: 0.75 }, directives: ['weight'] };
const KANJI = { app: 'kanzi', title: '漢字の森', version: 1, rollup: 2,
  skills: [{ key: 'kanji/g3/港', label: '港' }, { key: 'kanji/g3/湖', label: '湖' }, { key: 'kanji/g3', label: '3年の漢字' }] };

/* ---------- 目録 ---------- */
t('目録：正しい目録は誤りなし、誤りは具体的に返す', () => {
  assert.strictEqual(J(LbCatalog.validate(CAT)), '[]');
  assert.strictEqual(J(LbCatalog.validate(KANJI)), '[]');
  const bad = LbCatalog.validate({ app: 'Bad App', version: 0, skills: [{ key: 'a//b' }, { key: 'x', label: 'x' }, { key: 'x', label: 'y' }], directives: ['fly'], mastery: { acc: 2 } });
  const s = bad.join('\n');
  ['app は英小文字', 'title がありません', 'version', 'キーが不正', '重複: x', '知らない指示の種類: fly', 'mastery.acc'].forEach(w => assert.ok(s.includes(w), w + '\n' + s));
});
t('目録：到達の基準は 技能 > 目録 > 既定 の順に上書き', () => {
  assert.strictEqual(J(LbCatalog.mastery(CAT, 'math/mul/kuku/7')), J({ minN: 4, acc: 0.75, gmMs: 0, windowWeeks: 4 }));
  assert.strictEqual(J(LbCatalog.mastery(CAT, 'math/mul/kuku/8')), J({ minN: 4, acc: 0.95, gmMs: 2000, windowWeeks: 4 }));
  assert.strictEqual(LbCatalog.mastery(null, 'x').minN, 20);
});
t('目録：rollup で集計のキーをまとめる', () => {
  assert.strictEqual(LbCatalog.rollupKey(KANJI, 'kanji/g3/港'), 'kanji/g3');
  assert.strictEqual(LbCatalog.rollupKey(CAT, 'math/mul/kuku/7'), 'math/mul/kuku/7');
});
t('目録：ハブに書く（同じなら書かない・版が上がれば書き換え）、読み戻す', () => {
  const hub = makeSS('hub');
  assert.strictEqual(LbCatalog.publish(hub, CAT), true);
  assert.strictEqual(LbCatalog.publish(hub, CAT), false);
  assert.strictEqual(LbCatalog.publish(hub, Object.assign({}, CAT, { version: 2 })), true);
  LbCatalog.publish(hub, KANJI);
  const all = LbCatalog.readAll(hub);
  assert.strictEqual(J(Object.keys(all).sort()), J(['kanzi', 'tamath']));
  assert.strictEqual(all.tamath.version, 2);
  assert.strictEqual(hub.sheets.catalog.v.length, 3);
  assert.throws(() => LbCatalog.publish(hub, { app: 'x' }), /目録の誤り/);
});

/* ---------- セッション ---------- */
const it = (skill, ok, first, mis) => ({ q: 'q', a: 'a', ok, ms: first + 300, first, skill, mis });
const S1 = { ts: new Date('2026-11-09T10:00:00+09:00'), mail: '15@kyoiku.edu.nishi.or.jp', app: 'tamath', activity: 'kuku', context: 'live', ver: '10',
  items: [it('math/mul/kuku/7', true, 1000), it('math/mul/kuku/7', false, 4000, 'adj'), it('math/mul/kuku/8', true, 2000)] };

t('セッション：技能ごとに件数・正答・対数時間（最初のキーまでを優先）・誤答の型をまとめる', () => {
  const s = LbSession.summarize(S1.items);
  assert.strictEqual(s['math/mul/kuku/7'].n, 2);
  assert.strictEqual(s['math/mul/kuku/7'].ok, 1);
  assert.strictEqual(s['math/mul/kuku/7'].tn, 2);
  assert.ok(Math.abs(s['math/mul/kuku/7'].sl - (Math.log(1000) + Math.log(4000))) < 1e-5);
  assert.strictEqual(J(s['math/mul/kuku/7'].mis), J({ adj: 1 }));
  const k = LbSession.summarize([it('kanji/g3/港', true, 900), it('kanji/g3/湖', false, 1500)], KANJI);
  assert.strictEqual(J(Object.keys(k)), J(['kanji/g3']));
  assert.strictEqual(k['kanji/g3'].n, 2);
});
t('セッション：検査（目録にない技能・ok の型・mail）', () => {
  assert.strictEqual(J(LbSession.validate(S1, CAT)), '[]');
  const e = LbSession.validate({ mail: 'x', app: 'tamath', activity: 'a', items: [{ ok: 1, skill: 'nope' }] }, CAT).join('\n');
  ['本人（lid か mail）がありません', '.ok は true / false', '目録にない: nope'].forEach(w => assert.ok(e.includes(w), w));
});
t('セッション：行にして戻すと同じ。全問が残り、所属は記録時点の値', () => {
  const row = LbSession.toRow(S1, { lid: 'L15', mail: S1.mail, grade: 3, cls: '1', no: 5 });
  assert.strictEqual(row.length, LbSession.HEAD.length);
  const back = LbSession.fromRow(row);
  assert.strictEqual(back.items.length, 3);
  assert.strictEqual(back.no, 5);
  assert.strictEqual(back.lid, 'L15');
  assert.strictEqual(back.skills['math/mul/kuku/8'].ok, 1);
});
t('セッション：問題が多すぎてセルに入らない時は、問題の欄を空にして技能別の統計は残す', () => {
  const big = Object.assign({}, S1, { items: Array.from({ length: 2000 }, () => ({ q: 'あ'.repeat(20), a: 'い'.repeat(10), ok: true, ms: 1000, skill: 'math/mul/kuku/7' })) });
  const back = LbSession.fromRow(LbSession.toRow(big, null));
  assert.strictEqual(back.items.length, 0);
  assert.strictEqual(back.extra.truncated, 2000);
  assert.strictEqual(back.skills['math/mul/kuku/7'].n, 2000);
});
t('メールの無い転入生：学習者IDで記録し、操作した教師を残す', () => {
  const ss = makeSS('app');
  const r = LbSession.write(ss, Object.assign({}, S1, { mail: undefined, lid: 'Ltennyu' }), { by: 'na@edu.nishi.or.jp' });
  assert.strictEqual(r.ok, true);
  const back = LbSession.fromRow(ss.sheets.sessions_2026.v[1]);
  assert.strictEqual(back.lid, 'Ltennyu'); assert.strictEqual(back.mail, ''); assert.strictEqual(back.by, 'na@edu.nishi.or.jp');
  assert.strictEqual(LbSession.write(ss, Object.assign({}, S1, { mail: undefined, lid: 'Lnobody' })).reason, 'guest');
});

t('セッション：名簿にない人（おためし）は書かない。年度のシートに書き、上限を越えたら次のシートへ', () => {
  const ss = makeSS('app');
  assert.strictEqual(LbSession.write(ss, Object.assign({}, S1, { mail: '9@kyoiku.edu.nishi.or.jp' })).reason, 'guest');
  assert.strictEqual(LbSession.write(ss, S1, { catalog: CAT }).sheet, 'sessions_2026');
  assert.strictEqual(ss.sheets.sessions_2026.v.length, 2);
  // 年度の境目：3/31 は前の年度、4/1 は新しい年度
  assert.strictEqual(LbSession.write(ss, Object.assign({}, S1, { ts: new Date('2027-03-31T23:00:00+09:00') })).sheet, 'sessions_2026');
  assert.strictEqual(LbSession.write(ss, Object.assign({}, S1, { ts: new Date('2027-04-01T08:00:00+09:00') })).sheet, 'sessions_2027');
  // 上限
  const sh = ss.sheets.sessions_2026; while (sh.v.length < LbSession.SHARD_ROWS) sh.v.push(['x']);
  assert.strictEqual(LbSession.write(ss, S1).sheet, 'sessions_2026_2');
  assert.strictEqual(J(LbSession.sheetNames(ss, 2026)), J(['sessions_2026', 'sessions_2026_2']));
  assert.throws(() => LbSession.write(ss, { mail: 'x' }), /セッションの誤り/);
});

/* ---------- 集計 ---------- */
t('週：日本時間の月曜で区切る（日曜23時台は前の週、月曜0時台は新しい週）', () => {
  assert.strictEqual(LbFacts.weekOf(new Date('2026-11-15T23:30:00+09:00')), '2026-11-09');
  assert.strictEqual(LbFacts.weekOf(new Date('2026-11-16T00:10:00+09:00')), '2026-11-16');
  assert.strictEqual(LbFacts.weekOf(new Date('2026-11-15T15:10:00Z')), '2026-11-16');   // UTC では日曜でも日本は月曜
  assert.strictEqual(LbFacts.addWeeks('2026-12-28', 1), '2027-01-04');
});
t('集計：セッションを足す・まとめる・統計・状態', () => {
  const acc = {};
  LbFacts.addSession(acc, LbSession.fromRow(LbSession.toRow(S1, { lid: 'L15', grade: 3, cls: '1', no: 5 })));
  LbFacts.addSession(acc, LbSession.fromRow(LbSession.toRow(Object.assign({}, S1, { ts: new Date('2026-11-10T10:00:00+09:00') }), { lid: 'L15', grade: 3, cls: '1', no: 5 })));
  const k7 = Object.keys(acc).find(k => k.endsWith('math/mul/kuku/7'));
  assert.strictEqual(acc[k7].n, 4); assert.strictEqual(acc[k7].sess, 2); assert.strictEqual(acc[k7].mis.adj, 2);
  const st = LbFacts.stats(acc[k7]);
  assert.strictEqual(st.acc, 0.5);
  assert.ok(Math.abs(st.gmMs - 2000) < 0.01);                      // √(1000×4000)。対数の和は小数第6位で丸める
  assert.strictEqual(LbFacts.state(acc[k7], LbCatalog.mastery(CAT, 'math/mul/kuku/7')), '練習中');
  assert.strictEqual(LbFacts.state(null, LbCatalog.mastery(CAT, 'x')), '未着手');
  const good = { n: 10, ok: 10, tn: 10, sl: 10 * Math.log(1500), sl2: 10 * Math.log(1500) ** 2 };
  assert.strictEqual(LbFacts.state(good, LbCatalog.mastery(CAT, 'math/mul/kuku/8')), '到達');
  assert.strictEqual(LbFacts.state(Object.assign({}, good, { sl: 10 * Math.log(2500) }), LbCatalog.mastery(CAT, 'math/mul/kuku/8')), '練習中', '時間の基準');
  assert.strictEqual(LbFacts.state({ n: 3, ok: 3, tn: 3, sl: 3 * Math.log(1500), sl2: 0 }, LbCatalog.mastery(CAT, 'math/mul/kuku/8')), '練習中', '件数の基準（minN=4 に届かない）');
  const back = LbFacts.fromRows(LbFacts.toRows(acc));
  assert.strictEqual(J(LbFacts.toRows(back)), J(LbFacts.toRows(acc)), '行にして戻すと同じ');
  const win = LbFacts.recent(acc, 'L15', 'tamath', 'math/mul/kuku/7', '2026-11-09', 4);
  assert.strictEqual(LbFacts.combine(win).n, 4);
});
t('取り込み：新しいセッションだけを足す（2回目に同じものを足さない）・作り直しで同じ結果', () => {
  const hub = makeSS('hub'), app = makeSS('app'), kz = makeSS('kz');
  for (let d = 0; d < 6; d++) LbSession.write(app, Object.assign({}, S1, { ts: new Date(Date.UTC(2026, 10, 9 + d, 1)) }), { catalog: CAT });
  LbSession.write(kz, { ts: new Date('2026-11-09T10:00:00+09:00'), mail: '12@kyoiku.edu.nishi.or.jp', app: 'kanzi', activity: 'read',
    items: [it('kanji/g3/港', true, 900), it('kanji/g3/湖', false, 1500)] }, { catalog: KANJI });
  const src = [{ app: 'tamath', ss: app }, { app: 'kanzi', ss: kz }];
  assert.strictEqual(LbFacts.ingest(hub, src, { fy: 2026 }).read, 7);
  const once = J(LbFacts.toRows(LbFacts.read(hub, 2026)));
  assert.strictEqual(LbFacts.ingest(hub, src, { fy: 2026 }).read, 0, '2回目は何も読まない');
  assert.strictEqual(J(LbFacts.toRows(LbFacts.read(hub, 2026))), once);
  LbSession.write(app, S1, { catalog: CAT });
  assert.strictEqual(LbFacts.ingest(hub, src, { fy: 2026 }).read, 1, '増えた分だけ');
  const after = LbFacts.read(hub, 2026, f => f.app === 'tamath' && f.skill === 'math/mul/kuku/7');
  assert.strictEqual(Object.values(after).reduce((s, f) => s + f.n, 0), 14);
  const kz3 = LbFacts.read(hub, 2026, f => f.app === 'kanzi');
  assert.strictEqual(J(Object.values(kz3).map(f => f.skill)), J(['kanji/g3']), 'rollup した技能で集計');
  const before = J(LbFacts.toRows(LbFacts.read(hub, 2026)));
  LbFacts.rebuild(hub, src, { fy: 2026 });
  assert.strictEqual(J(LbFacts.toRows(LbFacts.read(hub, 2026))), before, '作り直しても同じ');
  // 問題の欄（11列目）は読まない
  const reads = app.sheets.sessions_2026.reads;
  LbSession.write(app, S1, { catalog: CAT });
  LbFacts.ingest(hub, src, { fy: 2026 });
  assert.strictEqual(app.sheets.sessions_2026.reads - reads, 2, '問題の欄より前の列と技能別の列だけ');
});
t('取り込み：時間切れなら途中でやめ、続きは次の実行で読む（二重に足さない）', () => {
  const hub = makeSS('hub'), app = makeSS('app');
  for (let d = 0; d < 3; d++) LbSession.write(app, S1, { catalog: CAT });
  const r1 = LbFacts.ingest(hub, [{ app: 'tamath', ss: app }], { fy: 2026, budgetMs: -1 });
  assert.strictEqual(r1.read, 0); assert.strictEqual(r1.more, true);
  const r2 = LbFacts.ingest(hub, [{ app: 'tamath', ss: app }], { fy: 2026 });
  assert.strictEqual(r2.read, 3);
  const all = LbFacts.read(hub, 2026, f => f.skill === 'math/mul/kuku/7');
  assert.strictEqual(Object.values(all)[0].n, 6);
});

console.log(`learning ${n} 件 ok`);
