// node tests/alerts.test.cjs — 今週の3件（LbAlerts）
const assert = require('assert');
const { loadPure, J } = require('./lb-load.cjs');
const { makeSS } = require('./sheet-mock.cjs');
const ctx = loadPure(['Catalog.gs', 'LbSession.gs', 'Facts.gs', 'Alerts.gs'], { Base: { fyOf: () => 2026 } });
const { LbFacts, LbAlerts } = ctx;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const TODAY = '2026-11-18';                                 // 水曜。今週は 2026-11-16 から
const W = k => LbFacts.addWeeks('2026-11-16', -k);          // k 週前の月曜
const CAT = { tamath: { app: 'tamath', title: '算数TA', version: 1, skills: [{ key: 's', label: 'S' }, { key: 'm', label: 'M' }], mastery: { minN: 20, acc: 0.9 } } };
const ROSTER = [];
for (let i = 1; i <= 8; i++) ROSTER.push({ lid: 'L' + i, grade: 3, cls: '1', name: '児' + i });
ROSTER.push({ lid: 'X1', grade: 3, cls: '2', name: '別' });
/** 集計の行を作る：週・学習者・技能・件数・正答・時間（ms） */
function f(acc, week, lid, skill, nn, ok, ms) {
  const l = Math.log(ms || 1000);
  acc[week + '|' + lid + '|tamath|' + skill] = { week, lid, grade: 3, cls: '1', no: 1, app: 'tamath', skill, n: nn, ok, tn: ok, sl: l * ok, sl2: l * l * ok, mis: {}, sess: 1 };
}

t('急に崩れた：今週の正答率が前の4週より15ポイント以上下がった（今週10問以上）', () => {
  const acc = {};
  for (let k = 1; k <= 4; k++) f(acc, W(k), 'L1', 's', 10, 9, 1500);    // 90%
  f(acc, W(0), 'L1', 's', 12, 8, 1500);                                  // 67%
  const out = LbAlerts.compute(acc, ROSTER, CAT, TODAY);
  assert.strictEqual(out['3-1'][0].kind, 'drop');
  assert.strictEqual(J(out['3-1'][0].lids), J(['L1']));
  assert.match(LbAlerts.describe(out['3-1'][0]), /正答率 90% → 67%/);
});
t('急に崩れた：時間が25%以上長くなった時も。今週が少ない（10問未満）なら出さない', () => {
  const acc = {};
  for (let k = 1; k <= 4; k++) f(acc, W(k), 'L2', 's', 10, 10, 1500);
  f(acc, W(0), 'L2', 's', 10, 10, 2000);
  assert.strictEqual(LbAlerts.compute(acc, ROSTER, CAT, TODAY)['3-1'][0].kind, 'drop');
  const acc2 = {};
  for (let k = 1; k <= 4; k++) f(acc2, W(k), 'L2', 's', 10, 9, 1500);
  f(acc2, W(0), 'L2', 's', 5, 1, 1500);
  assert.strictEqual(LbAlerts.compute(acc2, ROSTER, CAT, TODAY)['3-1'], undefined);
});
t('伸びが止まった：前後4週とも20問以上・練習中・正答率も時間も伸びていない。伸びていれば出さない', () => {
  const acc = {};
  for (let k = 0; k < 8; k++) f(acc, W(k), 'L3', 'm', 6, 4, 2500);   // 67% のまま・時間も同じ
  const out = LbAlerts.compute(acc, ROSTER, CAT, TODAY);
  assert.strictEqual(out['3-1'][0].kind, 'stall');
  const acc2 = {};
  for (let k = 4; k < 8; k++) f(acc2, W(k), 'L3', 'm', 6, 3, 3000);
  for (let k = 0; k < 4; k++) f(acc2, W(k), 'L3', 'm', 6, 5, 2000);   // 伸びた
  assert.strictEqual(LbAlerts.compute(acc2, ROSTER, CAT, TODAY)['3-1'], undefined);
  const acc3 = {};
  for (let k = 0; k < 8; k++) f(acc3, W(k), 'L3', 'm', 6, 6, 1500);   // 到達している（100%）
  assert.strictEqual(LbAlerts.compute(acc3, ROSTER, CAT, TODAY)['3-1'], undefined, '到達していれば伸びが止まったとは言わない');
});
t('学級でつまずき：直近2週に取り組んだ5人以上のうち半数以上が70%未満。4人なら出さない', () => {
  const acc = {};
  ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].forEach((l, i) => f(acc, W(0), l, 's', 6, i < 4 ? 3 : 6, 1500));   // 4人が50%
  const out = LbAlerts.compute(acc, ROSTER, CAT, TODAY);
  const k = out['3-1'].find(x => x.kind === 'klass');
  assert.ok(k); assert.strictEqual(k.lids.length, 4);
  assert.match(LbAlerts.describe(k), /6人のうち 4人/);
  const acc2 = {};
  ['L1', 'L2', 'L3', 'L4'].forEach(l => f(acc2, W(0), l, 's', 6, 2, 1500));
  assert.ok(!(LbAlerts.compute(acc2, ROSTER, CAT, TODAY)['3-1'] || []).some(x => x.kind === 'klass'));
});
t('並び：崩れた > 学級 > 止まった。学級ごとに3件まで。別の学級の児童は別の学級に', () => {
  const acc = {};
  for (let k = 0; k < 8; k++) ['L5', 'L6', 'L7'].forEach(l => f(acc, W(k), l, 'm', 6, 4, 2500));     // 止まった×3
  for (let k = 1; k <= 4; k++) f(acc, W(k), 'L1', 's', 10, 9, 1500); f(acc, W(0), 'L1', 's', 12, 6, 1500);   // 崩れた
  for (let k = 1; k <= 4; k++) f(acc, W(k), 'X1', 's', 10, 9, 1500); f(acc, W(0), 'X1', 's', 12, 6, 1500);   // 別の学級
  const out = LbAlerts.compute(acc, ROSTER, CAT, TODAY);
  assert.strictEqual(out['3-1'].length, 3);
  assert.strictEqual(out['3-1'][0].kind, 'drop');
  assert.strictEqual(out['3-2'][0].lids[0], 'X1');
});
t('判断済み・見た項目は出さない（同じ週のキー）。保存・読み出し・判断の記録', () => {
  const acc = {};
  for (let k = 1; k <= 4; k++) f(acc, W(k), 'L1', 's', 10, 9, 1500); f(acc, W(0), 'L1', 's', 12, 6, 1500);
  const hub = makeSS('hub');
  const out = LbAlerts.compute(acc, ROSTER, CAT, TODAY);
  LbAlerts.store(hub, out);
  assert.strictEqual(hub.sheets.now3.v[1][0], '3-1', '学級は文字のまま');
  const items = LbAlerts.read(hub, '3-1');
  assert.strictEqual(items.length, 1);
  LbAlerts.decide(hub, '3-1', items[0], 'changed', 'ひき算の復習へ', 'na@x');
  assert.strictEqual(LbAlerts.read(hub, '3-1').length, 0, '判断した項目は消える');
  assert.strictEqual(hub.sheets.decisions.v[1][5], '判断が変わった');
  assert.strictEqual(LbAlerts.compute(acc, ROSTER, CAT, TODAY, LbAlerts.decidedKeys(hub))['3-1'], undefined, '次の夜の計算でも出さない');
});
console.log(`alerts ${n} 件 ok`);
