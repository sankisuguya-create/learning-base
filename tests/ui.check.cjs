// 画面の確かめ（Playwright。npm run ui）：見本ページを開き、エラー・中国語フォント・入れ子のボタンが無いこと、先生モードの切り替えが保存されることを見る
const { chromium } = require('playwright'), http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const srv = http.createServer((q, r) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(f, (e, d) => { r.writeHead(e ? 404 : 200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' }); r.end(d); }); }).listen(0);
(async () => {
  const port = srv.address().port, b = await chromium.launch(), fails = [];
  const CN = /WenQuanYi|SimSun|YaHei|PingFang|CJK SC|CJK TC|Heiti/;
  for (const role of ['child3', 'child1', 'teacher', 'guest']) {
    const p = await b.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`http://localhost:${port}/web/demo.html?role=${role}`); await p.waitForTimeout(700);
    if (errs.length) fails.push(role + ': ' + errs.join(' / '));
    if (await p.locator('button button').count()) fails.push(role + ': ボタンの中にボタン');
    const cdp = await p.context().newCDPSession(p); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const doc = await cdp.send('DOM.getDocument'); const q = await cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: '.lb h1,.lb-name,.lb-title' });
    for (const id of q.nodeIds) { const f = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: id }); f.fonts.forEach(x => { if (CN.test(x.familyName)) fails.push(role + ': 中国語フォント ' + x.familyName); }); }
    if (role === 'child3' && (await p.locator('.lb-nowcard').count()) !== 2) fails.push('child3: いまの学習が2件でない');
    if (role === 'child3') {   // 国語はページが1つ（漢字の森）：タイルが直接開く
      const t = p.locator('.lb-tile[data-subject=kokugo]');
      if ((await t.getAttribute('data-act')) !== 'open' || (await t.getAttribute('data-id')) !== 'kanzi') fails.push('child3: 1つだけの教科のタイルが直接開かない');
      if ((await p.locator('.lb-tile[data-subject=sansu]').getAttribute('data-act')) !== 'subject') fails.push('child3: 算数のタイルが教科の画面へ行かない');
    }
    if (role === 'teacher' && await p.locator('#lb-as').count()) fails.push('teacher: 対応しているページが無いのに「代わりに取り組む」が出る');
    if (role === 'teacher') {
      await p.click('[data-act=edit]'); await p.click('[data-act=subject][data-id=sansu]');
      await p.click('[data-act=pub][data-id=tamath-kuku]'); await p.waitForTimeout(400);
      const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('lb-demo'))['3-1'].publish['tamath-kuku']);
      if (saved !== false) fails.push('teacher: 公開の切り替えが保存されない');
      const nowColor = await p.goto(`http://localhost:${port}/web/demo.html?role=child3`).then(() => p.waitForTimeout(600)).then(() => p.$eval('.lb-nowcard .lb-title', e => getComputedStyle(e).color));
      if (nowColor !== 'rgb(255, 255, 255)') fails.push('いまの学習の文字が白でない: ' + nowColor);
      if (await p.locator('[data-act=open][data-id=tamath-kuku]').count()) fails.push('かくしたページが児童に見える');
      await p.evaluate(() => localStorage.removeItem('lb-demo'));
    }
    await p.close();
  }
  await b.close(); srv.close();
  if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
  console.log('ui ok');
})();
