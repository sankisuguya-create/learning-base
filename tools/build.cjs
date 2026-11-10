'use strict';
// 画面用の写しを作る。node tools/build.cjs（作る）／ --check（一致するかだけ見る。tests が使う）
//   web/pages.js     … gas/Pages.gs の写し（サーバーと画面で同じ判定を使う）
//   web/demo-data.js … 見本ページ（web/demo.html）が使う、今週の3件の種類の名前と閾値の項目（gas/Alerts.gs から取り出す）
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(R, f), 'utf8');

function demoData() {
  const ctx = {}; vm.createContext(ctx);
  ['gas/Sheets.gs', 'gas/Alerts.gs'].forEach(f => vm.runInContext(read(f), ctx, { filename: f }));
  const A = ctx.LbAlerts;
  const spec = A.SPEC.map(sp => ({ path: sp.path, kind: sp.kind, label: sp.label, unit: sp.unit, scale: sp.scale, int: !!sp.int, min: sp.min, max: sp.max, def: A.getPath(A.RULES, sp.path) }));
  return '// 写し：正本は gas/Alerts.gs（tools/build.cjs が作る。直接直さない）。見本ページだけが使う\n' +
    'window.LB_DEMO = ' + JSON.stringify({ kinds: { names: A.KIND_NAME, labels: A.LABEL }, spec }, null, 1) + ';\n';
}
const OUT = [
  ['web/pages.js', () => '// 写し：正本は gas/Pages.gs（tools/build.cjs が作る。直接直さない）\n' + read('gas/Pages.gs')],
  ['web/demo-data.js', demoData]
];
const bad = [];
for (const [dst, make] of OUT) {
  const want = make(), p = path.join(R, dst);
  if (process.argv.includes('--check')) { if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== want) bad.push(dst); }
  else fs.writeFileSync(p, want);
}
if (bad.length) { console.error('古い写し: ' + bad.join(', ') + '（node tools/build.cjs で作り直す）'); process.exit(1); }
console.log(process.argv.includes('--check') ? '写しは最新' : '写しを作った');
