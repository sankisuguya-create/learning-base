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
      // 総合（といボード）：タイルが直接開く。開く先はハブの links の url
      const tb = p.locator('.lb-tile[data-subject=sogo]');
      if ((await tb.getAttribute('data-id')) !== 'toi-board') fails.push('child3: 総合のタイルがといボードを開かない');
      let opened = ''; await p.exposeFunction('lbOpened', u => { opened = u; });
      await p.evaluate(() => { window.LB_PLATFORM.open = u => window.lbOpened(u); });
      await tb.click(); await p.waitForTimeout(200);
      if (opened !== 'https://example.com/toi-board') fails.push('child3: といボードの URL が違う: ' + opened);
      // 算数の中：ハブと同じ色のタイル（先生が選んだ色）
      await p.click('[data-act=subject][data-id=sansu]'); await p.waitForTimeout(200);
      const bg = await p.$eval('.lb-htile[data-id=tamath-kuku]', e => getComputedStyle(e).backgroundColor);
      if (bg !== 'rgb(18, 196, 139)') fails.push('child3: 九九のタイルがハブの色（ミント）でない: ' + bg);
    }
    if (role === 'teacher') {   // 今週の3件：先生の画面の一番上。押すと消える
      if ((await p.locator('.lb-alert').count()) !== 3) fails.push('teacher: 今週の3件が3件でない');
      const first = await p.locator('.lb h2').first().textContent();
      if (first !== '今週の3件') fails.push('teacher: 今週の3件が一番上にない: ' + first);
      await p.click('.lb-alert [data-act=decide][data-how=changed]'); await p.waitForTimeout(400);
      if ((await p.locator('.lb-alert').count()) !== 2) fails.push('teacher: 判断が変わった を押しても消えない');
      await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('lb-demo') || '{}'); delete s.now3; localStorage.setItem('lb-demo', JSON.stringify(s)); });
      await p.goto(p.url()); await p.waitForTimeout(600);
    }
    if (role === 'teacher') {   // 撮影用・気づき・閾値を見直す・改善用の書き出し
      await p.click('[data-act=shot]'); await p.waitForTimeout(100);
      const who = await p.locator('.lb-alert-who').first().textContent();
      if (!/^見本/.test(who)) fails.push('teacher: 撮影用で見本の名前にならない: ' + who);
      if (/いとう|あおき/.test(await p.locator('#lb').textContent())) fails.push('teacher: 撮影用に実際の名前が残る');
      if (!(await p.locator('.lb-shot').count())) fails.push('teacher: 撮影用の表示だと分からない');
      if (await p.locator('[data-act=tune], [data-act=export]').count()) fails.push('teacher: 撮影用に所有者の欄が出る');
      let opened2 = ''; await p.exposeFunction('lbOpened3', u => { opened2 = u; });
      await p.evaluate(() => { window.LB_PLATFORM.open = u => window.lbOpened3(u); });
      await p.click('.lb-nowcard'); await p.waitForTimeout(100);
      if (opened2) fails.push('teacher: 撮影用でページが開いた');
      await p.click('[data-act=decide][data-how=changed]'); await p.waitForTimeout(300);
      const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('lb-demo') || '{}').now3);
      if (kept && kept.length !== 2) fails.push('teacher: 撮影用で判断が記録された');
      await p.click('.lb-tbar [data-act=shot]'); await p.waitForTimeout(100);
      if (!/いとう|あおき/.test(await p.locator('.lb-alert-who').first().textContent())) fails.push('teacher: 撮影用を戻せない');
      await p.fill('#lb-fbtext', '九九のタイルが小さい');
      await p.click('[data-act=shot]'); await p.click('.lb-tbar [data-act=shot]');     // 描き直しても書きかけが残る
      if ((await p.inputValue('#lb-fbtext')) !== '九九のタイルが小さい') fails.push('teacher: 描き直しで気づきの書きかけが消える');
      await p.click('[data-act=fb]'); await p.waitForTimeout(400);
      const fb = await p.evaluate(() => (JSON.parse(localStorage.getItem('lb-demo') || '{}').fb || []).map(x => x.t).join());
      if (fb !== '九九のタイルが小さい') fails.push('teacher: 気づきが送られない: ' + fb);
      await p.click('[data-act=export]'); await p.waitForTimeout(400);
      if (!/使い勝手・機能性/.test(await p.inputValue('#lb-exptext'))) fails.push('teacher: 書き出しの文が出ない');
      await p.click('[data-act=export-close]');
      // 閾値を見直す：値を変えて数える → 入れた値なら の行。保存すると「変えている」
      await p.click('[data-act=tune]'); await p.waitForTimeout(400);
      if ((await p.locator('.lb-rule input').count()) < 10) fails.push('teacher: 閾値の項目が出ない');
      if ((await p.inputValue('[data-path="drop.accDrop"]')) !== '15') fails.push('teacher: 下がり幅がポイントで出ない');
      await p.fill('[data-path="drop.accDrop"]', '10'); await p.click('[data-act=rule-try]'); await p.waitForTimeout(400);
      if (!(await p.locator('.lb-tried').count())) fails.push('teacher: 入れた値で数えた結果が出ない');
      if ((await p.inputValue('[data-path="drop.accDrop"]')) !== '10') fails.push('teacher: 数えた後に入れた値が消える');
      await p.click('[data-act=rule-save]'); await p.waitForTimeout(400);
      const saved2 = await p.evaluate(() => JSON.parse(localStorage.getItem('lb-demo') || '{}').rules || {});
      if (saved2['drop.accDrop'] !== 0.1) fails.push('teacher: 閾値が元の値（0.1）で保存されない: ' + JSON.stringify(saved2));
      if (!/変えている/.test(await p.locator('.lb-rule').first().textContent())) fails.push('teacher: 変えている印が出ない');
      await p.click('[data-act=back]');
      await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('lb-demo') || '{}'); delete s.fb; delete s.rules; localStorage.setItem('lb-demo', JSON.stringify(s)); });
    }
    if (role === 'child3' && (await p.locator('.lb-fb, [data-act=shot], [data-act=export], [data-act=tune]').count())) fails.push('child3: 児童に先生の欄が出る');
    if (role === 'child3' && await p.locator('.lb-alert').count()) fails.push('child3: 児童に今週の3件が出る');
    if (role === 'teacher') {   // 算数は代わりに取り組むに対応：欄が出て、選んで開くと &as=<学習者ID>。対応していないページ（といボード）は開かない
      if (!(await p.locator('#lb-as').count())) fails.push('teacher: 「代わりに取り組む」が出ない');
      let opened = ''; await p.exposeFunction('lbOpened2', u => { opened = u; });
      await p.evaluate(() => { window.LB_PLATFORM.open = u => window.lbOpened2(u); });
      await p.selectOption('#lb-as', 'Lc');
      await p.click('[data-act=subject][data-id=sansu]'); await p.click('[data-act=open][data-id=tamath-kuku]'); await p.waitForTimeout(200);
      if (!/app=tamath&unit=kuku&as=Lc$/.test(opened)) fails.push('teacher: 代わりに取り組む時の URL が違う: ' + opened);
      opened = '';
      await p.click('[data-act=back]'); await p.click('.lb-tile[data-subject=sogo]'); await p.waitForTimeout(200);
      if (opened) fails.push('teacher: 代わりに取り組むに対応していないページが開いた');
      await p.goto(p.url()); await p.waitForTimeout(600);
    }
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
