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
      if ((await p.locator('.lb-alert:not([data-kind=result])').count()) !== 3) fails.push('teacher: 今週の3件が3件でない');
      const first = await p.locator('.lb h2').first().textContent();
      if (first !== '今週の3件') fails.push('teacher: 今週の3件が一番上にない: ' + first);
      await p.click('.lb-alert [data-act=decide][data-how=changed]'); await p.waitForTimeout(400);
      if ((await p.locator('.lb-alert:not([data-kind=result])').count()) !== 2) fails.push('teacher: 判断が変わった を押しても消えない');
      await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('lb-demo') || '{}'); delete s.now3; localStorage.setItem('lb-demo', JSON.stringify(s)); });
      await p.goto(p.url()); await p.waitForTimeout(600);
    }
    if (role === 'teacher') {   // 手を打つ（指示）：期間とおすすめを選んで指示 → カードが消え「手を打っている」に出る。結果のカード・やめる
      await p.evaluate(() => localStorage.removeItem('lb-demo')); await p.reload(); await p.waitForTimeout(700);
      if (!(await p.locator('.lb-alert[data-kind=result]').count())) fails.push('teacher: 指示の結果のカードが出ない');
      if ((await p.locator('[data-act=direct-open]').count()) !== 2) fails.push('teacher: 手を打つ が指示を受け取れる項目だけに出ない');
      await p.click('[data-act=direct-open]');
      if ((await p.locator('.lb-seg[aria-checked=true]').textContent()) !== '2週間') fails.push('teacher: 期間の既定が2週間でない');
      if ((await p.locator('[data-act=direct-show]').getAttribute('aria-checked')) !== 'false') fails.push('teacher: おすすめの既定が「見せない」でない');
      await p.click('[data-act=direct-days][data-days="7"]'); await p.click('[data-act=direct-show]');
      await p.click('[data-act=direct]'); await p.waitForTimeout(400);
      const dirs = await p.evaluate(() => JSON.parse(localStorage.getItem('lb-demo') || '{}').dirs || []);
      if (dirs.length !== 1 || dirs[0].show !== true) fails.push('teacher: 指示が保存されない／おすすめが渡らない: ' + JSON.stringify(dirs));
      if ((await p.locator('.lb-alert:not([data-kind=result])').count()) !== 2) fails.push('teacher: 指示した項目が消えない');
      if (!/★おすすめを見せている/.test(await p.locator('.lb-dlist').textContent())) fails.push('teacher: 手を打っている に出ない');
      await p.click('[data-act=direct-end]'); await p.waitForTimeout(300);
      if (await p.locator('.lb-dlist').count()) fails.push('teacher: 指示をやめられない');
      await p.click('[data-act=result][data-again=""]'); await p.waitForTimeout(300);
      if (await p.locator('.lb-alert[data-kind=result]').count()) fails.push('teacher: 結果の「見た」で消えない');
      await p.evaluate(() => localStorage.removeItem('lb-demo')); await p.reload(); await p.waitForTimeout(700);
    }
    if (role === 'teacher') {   // 撮影用・気づき・閾値を見直す・改善用の書き出し
      await p.click('[data-act=shot]'); await p.waitForTimeout(100);
      const who = await p.locator('.lb-alert:not([data-kind=result]) .lb-alert-who').first().textContent();
      if (!/^見本/.test(who)) fails.push('teacher: 撮影用で見本の名前にならない: ' + who);
      if ((await p.locator('.lb-alert:not([data-kind=result]) .lb-alert-kind').first().textContent()) !== '▼ 急に崩れた') fails.push('teacher: 撮影用の種類の名前が出ない');
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
      if (!/いとう|あおき/.test(await p.locator('.lb-alert:not([data-kind=result]) .lb-alert-who').first().textContent())) fails.push('teacher: 撮影用を戻せない');
      await p.fill('#lb-fbtext', '九九のタイルが小さい');
      await p.click('[data-act=shot]'); await p.click('.lb-tbar [data-act=shot]');     // 描き直しても書きかけが残る
      if ((await p.inputValue('#lb-fbtext')) !== '九九のタイルが小さい') fails.push('teacher: 描き直しで気づきの書きかけが消える');
      await p.click('[data-act=fb]'); await p.waitForTimeout(400);
      const fb = await p.evaluate(() => (JSON.parse(localStorage.getItem('lb-demo') || '{}').fb || []).map(x => x.t).join());
      if (fb !== '九九のタイルが小さい') fails.push('teacher: 気づきが送られない: ' + fb);
      await p.click('[data-act=export]'); await p.waitForTimeout(400);
      if (!/失敗と速さ/.test(await p.inputValue('#lb-exptext'))) fails.push('teacher: 書き出しの文が出ない');
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
    if (role === 'child3') {   // 記録：行き止まり・始めるまで（経路）を覚え、次に開いた時に送って消す。画面の JavaScript の失敗を送る
      await p.evaluate(() => localStorage.clear()); await p.goto(`http://localhost:${port}/web/demo.html?role=child3`); await p.waitForTimeout(700);
      await p.evaluate(() => { window.LB_PLATFORM.open = () => {}; });
      await p.click('[data-act=subject][data-id=sansu]'); await p.click('[data-act=back]');
      if (await p.evaluate(() => localStorage.getItem('lb-dead')) !== '1') fails.push('child3: 行き止まりを覚えない');
      await p.click('.lb-nowcard'); await p.waitForTimeout(100);
      const st = await p.evaluate(() => JSON.parse(localStorage.getItem('lb-start') || 'null'));
      if (!st || st.path !== 'now' || !(st.ms >= 0)) fails.push('child3: 始めるまでを覚えない: ' + JSON.stringify(st));
      await p.reload(); await p.waitForTimeout(700);
      const sent = await p.evaluate(() => (JSON.parse(localStorage.getItem('lb-demo') || '{}').boots || []).pop());
      if (!sent || !sent.start || sent.start.path !== 'now' || sent.dead !== 1) fails.push('child3: 前回分が次に開いた時に送られない: ' + JSON.stringify(sent));
      if (await p.evaluate(() => localStorage.getItem('lb-dead')) !== '0') fails.push('child3: 送った分が消えない');
      await p.evaluate(() => setTimeout(() => { throw new Error('見本の失敗'); }, 0)); await p.waitForTimeout(400);
      const rep = await p.evaluate(() => JSON.parse(localStorage.getItem('lb-demo') || '{}').reports || []);
      if (!rep.some(r => r[0] === 'jserror' && /見本の失敗/.test(r[1]))) fails.push('child3: 画面の失敗が送られない: ' + JSON.stringify(rep));
      await p.evaluate(() => localStorage.clear());
    }
    if (role === 'child3' && (await p.locator('.lb-fb, [data-act=shot], [data-act=export], [data-act=tune]').count())) fails.push('child3: 児童に先生の欄が出る');
    if (role === 'child3' && await p.locator('.lb-alert:not([data-kind=result])').count()) fails.push('child3: 児童に今週の3件が出る');
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
    if (role === 'teacher') {   // 先生モード：スイッチ（オン／オフの文字）と帯。教科の中で ⠿ をドラッグ・矢印キーで並べかえ → 保存 → 児童も同じ順
      const sw = p.locator('[data-act=edit]');
      if ((await sw.getAttribute('role')) !== 'switch' || !/オフ/.test(await sw.textContent())) fails.push('teacher: 先生モードがオフと分かるスイッチでない');
      await sw.click();
      if ((await p.locator('[data-act=edit]').getAttribute('aria-checked')) !== 'true' || !/オン/.test(await p.locator('[data-act=edit]').textContent())) fails.push('teacher: 先生モードがオンと分からない');
      if (!(await p.locator('.lb-editbar').count())) fails.push('teacher: 先生モードの帯が出ない');
      await p.click('[data-act=subject][data-id=sansu]'); await p.waitForTimeout(200);
      const ids0 = await p.$$eval('.lb-hgrid .lb-cell', cs => cs.map(c => c.dataset.id));
      const a0 = await p.locator('.lb-drag').nth(0).boundingBox(), t2 = await p.locator('.lb-hgrid .lb-cell').nth(2).boundingBox();
      await p.mouse.move(a0.x + 24, a0.y + 24); await p.mouse.down();
      await p.mouse.move(t2.x + t2.width / 2, t2.y + t2.height / 2, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(400);
      const ids1 = await p.$$eval('.lb-hgrid .lb-cell', cs => cs.map(c => c.dataset.id));
      if (ids1[2] !== ids0[0] || ids1[0] !== ids0[1]) fails.push('teacher: ドラッグで並ばない: ' + ids0.slice(0, 3) + ' → ' + ids1.slice(0, 3));
      const saved0 = await p.evaluate(() => (JSON.parse(localStorage.getItem('lb-demo'))['3-1'].order || {}).sansu || []);
      if (saved0.join() !== ids1.join()) fails.push('teacher: 並びが保存されない');
      await p.locator('.lb-drag[data-drag="' + ids0[0] + '"]').focus(); await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(300);
      const ids2 = await p.$$eval('.lb-hgrid .lb-cell', cs => cs.map(c => c.dataset.id));
      if (ids2[1] !== ids0[0]) fails.push('teacher: 矢印キーで動かない: ' + ids2.slice(0, 3));
      if ((await p.evaluate(() => document.activeElement && document.activeElement.dataset.drag)) !== ids0[0]) fails.push('teacher: 動かした後につまみに戻らない');
      const kidIds = await p.goto(`http://localhost:${port}/web/demo.html?role=child3`).then(() => p.waitForTimeout(600)).then(() => p.click('[data-act=subject][data-id=sansu]'))
        .then(() => p.$$eval('.lb-hgrid .lb-htile', cs => cs.map(c => c.dataset.id)));
      if (kidIds.slice(0, 3).join() !== ids2.slice(0, 3).join()) fails.push('teacher: 児童の画面が先生の並びにならない: ' + kidIds.slice(0, 3));
      if (await p.locator('.lb-drag').count()) fails.push('child3: 児童に並べかえのつまみが出る');
      await p.goto(`http://localhost:${port}/web/demo.html?role=teacher`); await p.waitForTimeout(600);
      await p.click('[data-act=edit]'); await p.click('[data-act=subject][data-id=sansu]'); await p.click('[data-act=order-reset]'); await p.waitForTimeout(300);
      if ((await p.$$eval('.lb-hgrid .lb-cell', cs => cs.map(c => c.dataset.id))).join() !== ids0.join()) fails.push('teacher: もとの並びに戻らない');
      await p.click('[data-act=back]'); await p.click('[data-act=edit]');
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
