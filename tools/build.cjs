'use strict';
// 画面用の写しを作る。node tools/build.cjs（作る）／ --check（一致するかだけ見る。tests が使う）
const fs = require('fs'), path = require('path');
const R = path.resolve(__dirname, '..');
const COPIES = [['gas/Pages.gs', 'web/pages.js', '// 写し：正本は gas/Pages.gs（tools/build.cjs が作る。直接直さない）\n']];
let bad = [];
for (const [src, dst, head] of COPIES) {
  const want = head + fs.readFileSync(path.join(R, src), 'utf8');
  const p = path.join(R, dst);
  if (process.argv.includes('--check')) { if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== want) bad.push(dst); }
  else fs.writeFileSync(p, want);
}
if (bad.length) { console.error('古い写し: ' + bad.join(', ') + '（node tools/build.cjs で作り直す）'); process.exit(1); }
console.log(process.argv.includes('--check') ? '写しは最新' : '写しを作った');
