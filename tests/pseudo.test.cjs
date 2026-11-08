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
const T = LbPseudo.table(PEOPLE, { seed: '2026-test' });
const code = id => T.codeOf[id];

t('記号表：全員に重ならない記号、紛らわしい文字を使わない、同じ種なら同じ記号', () => {
  const cs = Object.values(T.codeOf);
  assert.strictEqual(new Set(cs).size, PEOPLE.length);
  cs.forEach(c => assert.ok(/^[a-z][2-9]$/.test(c) && !/[01oli]/.test(c), c));
  const T2 = LbPseudo.table(PEOPLE.slice().reverse(), { seed: '2026-test' });
  assert.strictEqual(J(T2.codeOf), J(T.codeOf), '名簿の並びを変えても記号は同じ');
  const T3 = LbPseudo.table(PEOPLE, { seed: '2027-test' });
  assert.notStrictEqual(J(T3.codeOf), J(T.codeOf), '種が変われば記号も変わる');
  assert.throws(() => LbPseudo.table(PEOPLE, {}), /種/);
});

t('転入：今年度の記号表を引き継ぐと、他の人の記号は変わらず、新しい人に空いている記号が付く', () => {
  const tb1 = LbPseudo.table(PEOPLE, { seed: 's1' });
  const joined = PEOPLE.concat([{ id: 'new', sei: '転入', mei: '花' }]);
  const tb2 = LbPseudo.table(joined, { seed: 's1', existing: tb1.codeOf });
  PEOPLE.forEach(p => assert.strictEqual(tb2.codeOf[p.id], tb1.codeOf[p.id]));
  assert.ok(tb2.codeOf.new && !Object.values(tb1.codeOf).includes(tb2.codeOf.new));
});

t('記号は名簿の順と無関係（出席番号順に並べても記号が順に並ばない）', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: 'k' + i, sei: '姓' + i, mei: '名' + i }));
  const tb = LbPseudo.table(many, { seed: 's' });
  const seq = many.map(p => tb.codeOf[p.id]);
  assert.notStrictEqual(J(seq), J(seq.slice().sort()));
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
  const tb = LbPseudo.table(many, { seed: 's' });
  const cs = Object.values(tb.codeOf);
  assert.strictEqual(new Set(cs).size, 300);
  cs.forEach(c => assert.ok(/^[a-z][2-9][a-z]$/.test(c), c));
  assert.strictEqual(LbPseudo.restore('〔' + cs[0] + '〕', tb), tb.byCode[cs[0]]);
});

console.log(`pseudo ${n} 件 ok`);
