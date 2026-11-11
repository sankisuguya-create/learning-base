// node tests/directives.test.cjs — 指示（LbDirectives）：作る・児童ごとに読む・やめる・期間後の結果（本番の記録で、同じ学年のほかの児童と比べる）
const assert = require('assert');
const { loadPure, J } = require('./lb-load.cjs');
const { makeSS } = require('./sheet-mock.cjs');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

function env() {
  const cache = {}, p = x => String(x).padStart(2, '0');
  const ctx = loadPure(['Catalog.gs', 'LbSession.gs', 'Facts.gs', 'Directives.gs'], {
    Base: { fyOf: () => 2026 },
    Utilities: { formatDate: (d, tz, f) => { const s = new Date(d.getTime() + 9 * 3600e3); return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())}`; },
      getUuid: () => require('crypto').randomUUID() },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); } }) }
  });
  return { D: ctx.LbDirectives, F: ctx.LbFacts, cache };
}
const ROSTER = [];
for (let i = 1; i <= 6; i++) ROSTER.push({ lid: 'L' + i + 'aaaaaaaaa', grade: 3, cls: '1', name: '児' + i });
ROSTER.push({ lid: 'Lzzzzzzzzz', grade: 4, cls: '1', name: '別学年' });
const L = i => ROSTER[i - 1].lid;
const BASE = { classKey: '3-1', lids: [L(1)], app: 'tamath', skill: 'math/kuku/k7', days: 14, show: false, fromKey: 'stall|x' };

t('作る：期間は今日から（1週＝7日・2週＝14日）。対象・技能・見せるを保存。学級と日付は文字のまま', () => {
  const { D } = env(), hub = makeSS('hub');
  const d = D.create(hub, BASE, 't@edu.nishi.or.jp', '2026-11-10');
  assert.strictEqual(d.from, '2026-11-10'); assert.strictEqual(d.to, '2026-11-23');
  assert.strictEqual(D.create(hub, Object.assign({}, BASE, { days: 7 }), 't', '2026-11-10').to, '2026-11-16');
  const row = hub.sheets.directives.v[1];
  assert.strictEqual(row[3], '3-1'); assert.strictEqual(row[7], '2026-11-10'); assert.strictEqual(row[11], '有効');
  assert.throws(() => D.create(hub, Object.assign({}, BASE, { days: 30 }), 't', '2026-11-10'), /1週か2週/);
  assert.throws(() => D.create(hub, Object.assign({}, BASE, { lids: [] }), 't', '2026-11-10'), /対象/);
  assert.throws(() => D.create(hub, Object.assign({}, BASE, { lids: ['<x>'] }), 't', '2026-11-10'), /対象/, '学習者ID の形でないものは捨てる');
});
t('児童ごとに読む：有効・期間中・そのアプリの指示だけ。作る・やめると覚えた分を使わない', () => {
  const { D } = env(), hub = makeSS('hub');
  assert.strictEqual(D.forLearner(hub, L(1), 'tamath', '2026-11-10').length, 0);
  const d = D.create(hub, Object.assign({}, BASE, { show: true }), 't', '2026-11-10');
  assert.strictEqual(J(D.forLearner(hub, L(1), 'tamath', '2026-11-10')), J([{ id: d.id, skill: 'math/kuku/k7', show: true }]), '作ると覚えた「なし」を使わない');
  assert.strictEqual(D.forLearner(hub, L(2), 'tamath', '2026-11-10').length, 0, '対象でない児童');
  assert.strictEqual(D.forLearner(hub, L(1), 'kanzi', '2026-11-10').length, 0, '別のアプリ');
  assert.strictEqual(D.forLearner(hub, L(1), 'tamath', '2026-11-24').length, 0, '期間の後');
  assert.throws(() => D.end(hub, d.id, '3-2'), /この学級/);
  assert.strictEqual(D.end(hub, d.id, '3-1'), true);
  assert.strictEqual(D.forLearner(hub, L(1), 'tamath', '2026-11-10').length, 0, 'やめると覚えた分を使わない');
  assert.strictEqual(D.active(hub, '3-1', '2026-11-10').length, 0);
});

/** 集計（本番だけ）の行：週・学習者・件数・正答 */
function f(acc, week, lid, nn, ok, skill) {
  const l = Math.log(1500);
  acc[week + '|' + lid + '|tamath|' + (skill || 'math/kuku/k7')] = { week, lid, grade: 3, cls: '1', no: 1, app: 'tamath', skill: skill || 'math/kuku/k7', n: nn, ok, tn: ok, sl: l * ok, sl2: l * l * ok, mis: {}, sess: 1 };
}
t('結果：前の4週と期間中を、対象と同じ学年のほかの児童とで比べる。別の学年・対象・片方の期間しか無い児童は比べる相手に入れない', () => {
  const { D, F } = env(), hub = makeSS('hub');
  const d = D.create(hub, BASE, 't', '2026-11-02');            // 11/02〜11/15（月曜から2週）
  const acc = {}, W = k => F.addWeeks('2026-11-02', k);
  for (let k = -4; k <= -1; k++) { f(acc, W(k), L(1), 5, 3); f(acc, W(k), L(2), 5, 4); f(acc, W(k), L(3), 5, 4); f(acc, W(k), 'Lzzzzzzzzz', 5, 1); }
  for (let k = 0; k <= 1; k++) { f(acc, W(k), L(1), 10, 9); f(acc, W(k), L(2), 5, 4); f(acc, W(k), L(4), 5, 5); f(acc, W(k), 'Lzzzzzzzzz', 5, 5); }
  f(acc, W(0), L(1), 99, 0, 'math/kuku/k8');                   // 別の技能は数えない
  const r = D.measure(Object.assign({}, d, { lids: d.lids }), acc, ROSTER);
  assert.strictEqual(r.enough, true); assert.strictEqual(r.nBefore, 20); assert.strictEqual(r.nDuring, 20);
  assert.strictEqual(r.accBefore, 0.6); assert.strictEqual(r.accDuring, 0.9);
  assert.strictEqual(r.others, 1, '前と期間中の両方がある、同じ学年の対象でない児童だけ（L2）');
  assert.strictEqual(r.oAccBefore, 0.8); assert.strictEqual(r.oAccDuring, 0.8);
  assert.match(D.describe(r), /正答率 60% → 90%.*ほかの児童 1人は正答率 \+0ポイント.*目安/);
  // 毎晩：期間が終わった翌日に結果を出し、終了にする。期間中は出さない
  assert.strictEqual(D.evaluate(hub, acc, ROSTER, '2026-11-15'), 0);
  assert.strictEqual(D.evaluate(hub, acc, ROSTER, '2026-11-16'), 1);
  assert.strictEqual(D.evaluate(hub, acc, ROSTER, '2026-11-17'), 0, '2回は出さない');
  const res = D.results(hub, '3-1', '2026-11-17', {});
  assert.strictEqual(res.length, 1); assert.strictEqual(res[0].state, '終了'); assert.strictEqual(res[0].result.accDuring, 0.9);
  assert.strictEqual(hub.sheets.directives.v[1][13], '2026-11-16', '結果の日は文字のまま');
  assert.strictEqual(D.results(hub, '3-1', '2026-11-17', { ['result|' + d.id]: true }).length, 0, '見た結果は出さない');
  assert.strictEqual(D.results(hub, '3-1', '2026-12-01', {}).length, 0, '14日を過ぎた結果は出さない');
});
t('結果：本番が10問未満なら比べない（数が少ない、とだけ言う）', () => {
  const { D, F } = env(), hub = makeSS('hub');
  const d = D.create(hub, BASE, 't', '2026-11-02'), acc = {};
  f(acc, F.addWeeks('2026-11-02', -1), L(1), 4, 2); f(acc, F.addWeeks('2026-11-02', 0), L(1), 20, 18);
  const r = D.measure(d, acc, ROSTER);
  assert.strictEqual(r.enough, false); assert.match(D.describe(r), /少ないので比べられません（前の4週 4問・期間中 20問/);
});

console.log('directives', n, '件 ok');
