// node tests/pseudo.test.cjs
const assert = require('assert');
const { loadPure, J } = require('./lb-load.cjs');
const { LbPseudo } = loadPure(['Pseudo.gs']);
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const PEOPLE = [
  { id: 'a', sei: '田中', mei: 'はなこ', seiKana: 'たなか', meiKana: 'はなこ' },
  { id: 'b', sei: '田中', mei: '一郎', seiKana: 'たなか', meiKana: 'いちろう' },        // 同じ姓
  { id: 'c', sei: '髙橋', mei: '空', seiKana: 'たかはし', meiKana: 'そら' },             // 異体字・1文字の名
  { id: 'd', sei: '佐藤', mei: 'まい', seiKana: 'さとう', meiKana: 'まい' },             // 2文字ひらがなの名
  { id: 'e', sei: '山﨑', mei: '健太', seiKana: 'やまさき', meiKana: 'けんた' },
  { id: 'T1', sei: '西', mei: '美樹', seiKana: 'にし', meiKana: 'みき' }                 // 教師・1文字の姓
];
const T = LbPseudo.table(PEOPLE);
const code = id => T.codeOf[id];

t('記号表：全員に重ならない記号、紛らわしい文字を使わない', () => {
  const cs = Object.values(T.codeOf);
  assert.strictEqual(new Set(cs).size, PEOPLE.length);
  cs.forEach(c => assert.ok(/^[a-z][2-9]$/.test(c) && !/[01oli]/.test(c), c));
});

t('記号は情報から導けない：同じ名簿・同じ ID でも、作るたびに違う記号になる', () => {
  const runs = Array.from({ length: 5 }, () => J(LbPseudo.table(PEOPLE).codeOf));
  assert.ok(new Set(runs).size > 1, '毎回同じなら、何かから計算している');
  // ID と記号の間に決まった関係がない（ID の並びに記号の並びがついてこない）
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 'L' + String(i).padStart(3, '0'), sei: '姓' + i, mei: '名' + i }));
  const tb = LbPseudo.table(many), seq = many.map(p => tb.codeOf[p.id]);
  assert.notStrictEqual(J(seq), J(seq.slice().sort()));
  assert.strictEqual(typeof LbPseudo.table(PEOPLE, { seed: 'x' }).seed, 'undefined', '種は使わない');
});

t('記号表を引き継ぐ：保存した記号はそのまま、転入生にだけ空いている記号を振る', () => {
  const tb1 = LbPseudo.table(PEOPLE);
  const joined = PEOPLE.concat([{ id: 'new', sei: '転入', mei: '花' }]);
  const tb2 = LbPseudo.table(joined, { existing: tb1.codeOf });
  PEOPLE.forEach(p => assert.strictEqual(tb2.codeOf[p.id], tb1.codeOf[p.id]));
  assert.ok(tb2.codeOf.new && !Object.values(tb1.codeOf).includes(tb2.codeOf.new));
  const tb3 = LbPseudo.table(PEOPLE.slice().reverse(), { existing: tb1.codeOf });
  PEOPLE.forEach(p => assert.strictEqual(tb3.codeOf[p.id], tb1.codeOf[p.id], '名簿の並びを変えても同じ'));
});

t('姓名：漢字・ひらがな・カタカナ・空白あり／なし・混ぜ書き', () => {
  const src = '田中はなこさんと、たなか はなこ、タナカハナコ、田中　はなこ。';
  const r = LbPseudo.replace(src, T);
  const c = '〔' + code('a') + '〕';
  assert.strictEqual(r.text, `${c}さんと、${c}、${c}、${c}。`);
  assert.strictEqual(r.hits.length, 4);
});

t('同じ姓だけの表記は共通の記号（別人に取り違えない）。名は1人に決まれば本人の記号', () => {
  const r = LbPseudo.replace('田中さんが一郎くんに話した', T);
  assert.match(r.text, /^〔共\d+〕さんが〔[a-z][2-9]〕くんに話した$/);
  assert.ok(r.text.includes('〔' + code('b') + '〕くん'));
});

t('異体字：髙橋 と 高橋、山﨑 と 山崎 を同じ人として扱う', () => {
  const r = LbPseudo.replace('高橋さんと山崎健太さん', T);
  assert.strictEqual(r.text, `〔${code('c')}〕さんと〔${code('e')}〕さん`);
  const r2 = LbPseudo.replace('ﾀｶﾊｼさん', T);   // 半角カタカナ
  assert.strictEqual(r2.text, `〔${code('c')}〕さん`);
});

t('1文字の名・姓：単独では置き換えず skipped1 に。敬称がつけば置き換える。姓名の一部なら置き換える', () => {
  const r = LbPseudo.replace('空がきれい。空くんが来た。西先生と髙橋空。', T);
  assert.strictEqual(r.text, `空がきれい。〔${code('c')}〕くんが来た。〔${code('T1')}〕先生と〔${code('c')}〕。`);
  assert.strictEqual(r.skipped1.length, 1);
  assert.strictEqual(r.skipped1[0].name, '空');
  assert.strictEqual(r.skipped1[0].start, 0);
});

t('2文字ひらがなの名は warn に件数（一般語の中でも当たる）', () => {
  const r = LbPseudo.replace('まいにち まいさんと しまいまで', T);
  const w = r.warn.find(x => x.name === 'まい');
  assert.ok(w && w.count === 3, J(r.warn));
  assert.ok(LbPseudo.riskyNames(T).includes('まい'));
});

t('元の文の位置：hits の start/end は元の文の部分を指す（色付けに使う）', () => {
  const src = 'きのう ﾀﾅｶ ﾊﾅｺさんが';
  const r = LbPseudo.replace(src, T);
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(src.slice(r.hits[0].start, r.hits[0].end), 'ﾀﾅｶ ﾊﾅｺ');
});

t('元に戻す：1人に決まる記号は名前に、共通の記号は戻さない。往復で元の人に戻る', () => {
  const r = LbPseudo.replace('田中はなこさんと田中さん', T);
  const back = LbPseudo.restore(r.text, T);
  assert.match(back, /^田中 はなこさんと〔共\d+〕さん$/);
  assert.strictEqual(LbPseudo.restore('〔zz〕と〔' + code('e') + '〕', T), '〔zz〕と山﨑 健太');
});

t('名前の無い文・空文字・記号だけの文はそのまま', () => {
  assert.strictEqual(LbPseudo.replace('', T).text, '');
  assert.strictEqual(LbPseudo.replace('きょうは はれ。', T).text, 'きょうは はれ。');
  assert.strictEqual(LbPseudo.replace(null, T).text, '');
});

t('人数が多い時は3文字の記号（学校全体）', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: 'x' + i, sei: 'あ' + i, mei: 'い' + i }));
  const tb = LbPseudo.table(many);
  const cs = Object.values(tb.codeOf);
  assert.strictEqual(new Set(cs).size, 300);
  cs.forEach(c => assert.ok(/^[a-z][2-9][a-z]$/.test(c), c));
  assert.strictEqual(LbPseudo.restore('〔' + cs[0] + '〕', tb), tb.byCode[cs[0]]);
});

console.log(`pseudo ${n} 件 ok`);
