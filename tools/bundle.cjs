'use strict';
// 学習BASE の配布物 dist/ を作る。
//   node tools/bundle.cjs          作る
//   node tools/bundle.cjs --check  作り直さずに、dist/ が今のソースと apps.lock.json の版に一致するかだけ見る
//
// dist/server.js  … 読み込み係が実行するサーバー側のコード：共通部品（gas/）＋ 各アプリ（関数の中に包む）＋ 振り分け
// dist/html.json  … アプリの画面のファイル（{ 'tamath/index': '…' }）。アプリの画面を返す時だけ読む
// dist/manifest.json … 版の確認用（各ファイルの指紋 SHA-256・大きさ・取り込んだアプリの版）
//
// アプリのファイルは、隣にあるクローン（../<リポジトリ名>）から apps.lock.json のコミットで取り出す（git show）。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');
const R = path.resolve(__dirname, '..');
const GAS_ORDER = ['Sheets.gs', 'Base.gs', 'Pseudo.gs', 'Catalog.gs', 'LbSession.gs', 'Facts.gs', 'Alerts.gs', 'Telemetry.gs', 'Tuning.gs', 'Export.gs', 'Pages.gs', 'Home.gs'];
const lock = JSON.parse(fs.readFileSync(path.join(R, 'apps.lock.json'), 'utf8'));

function gitShow(repo, commit, file) {
  const dir = path.resolve(process.env.LB_APPS_DIR ? path.resolve(R, process.env.LB_APPS_DIR) : path.resolve(R, '..'), repo.split('/')[1]);   // GitHub Actions では LB_APPS_DIR に取り込む
  if (!fs.existsSync(dir)) throw new Error(`${repo} のクローンが ${dir} にありません`);
  return execFileSync('git', ['-C', dir, 'show', `${commit}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** アプリのサーバー側のコードを関数の中に包む。包んだ中の LB_RESOLVE_ は、画面から呼ぶ関数を名前で探す */
function wrap(id, a, code) {
  const locals = Object.entries(a.locals || {}).map(([k, v]) => `var ${k} = ${JSON.stringify(v)};`).join('\n');
  const exp = Object.entries(a.exports).map(([k, v]) => `${JSON.stringify(k)}: (typeof ${v} === 'function' ? ${v} : undefined)`).join(',\n  ');
  return `// ===== アプリ ${id}（${a.repo}@${a.commit.slice(0, 7)}） =====
LB_MODULES[${JSON.stringify(id)}] = (function () {
${locals}
var LB_RESOLVE_ = function (n) { return /^[A-Za-z][A-Za-z0-9]*$/.test(n) ? eval('typeof ' + n + " === 'function' ? " + n + ' : undefined') : undefined; };
${code}
return {
  ${exp}
};
})();
`;
}

function build() {
  const parts = ['// dist/server.js — 学習BASE のサーバー側のコード（tools/bundle.cjs が作る。直接直さない）',
    'var LB_MODULES = (typeof LB_MODULES !== "undefined" && LB_MODULES) || {};',
    'var LB_PLATFORM_TRIGGERS = true;   // 自動実行は読み込み係が置く（アプリは置かない）', ''];
  for (const f of GAS_ORDER) parts.push(`// ===== gas/${f} =====\n` + fs.readFileSync(path.join(R, 'gas', f), 'utf8'));
  const html = {}, apps = {};
  for (const [id, a] of Object.entries(lock)) {
    if (id === '_') continue;
    const code = a.server.map(f => `// --- ${f} ---\n` + gitShow(a.repo, a.commit, f)).join('\n');
    parts.push(wrap(id, a, code));
    for (const [name, f] of Object.entries(a.files || {})) html[`${id}/${name}`] = gitShow(a.repo, a.commit, f);
    apps[id] = { repo: a.repo, commit: a.commit };
  }
  parts.push('// ===== gas/Platform.gs =====\n' + fs.readFileSync(path.join(R, 'gas', 'Platform.gs'), 'utf8'));
  const server = parts.join('\n');
  const htmlJson = JSON.stringify(html);
  const sha = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
  const manifest = JSON.stringify({ server: sha(server), html: sha(htmlJson), serverChars: server.length, htmlChars: htmlJson.length, apps }, null, 1) + '\n';
  return { 'dist/server.js': server, 'dist/html.json': htmlJson, 'dist/manifest.json': manifest };
}

const out = build();
if (process.argv.includes('--check')) {
  const bad = Object.keys(out).filter(f => !fs.existsSync(path.join(R, f)) || fs.readFileSync(path.join(R, f), 'utf8') !== out[f]);
  if (bad.length) { console.error('dist/ が古い: ' + bad.join(', ') + '（npm run bundle で作り直す）'); process.exit(1); }
  console.log('dist/ は最新');
} else {
  fs.mkdirSync(path.join(R, 'dist'), { recursive: true });
  for (const f in out) fs.writeFileSync(path.join(R, f), out[f]);
  const m = JSON.parse(out['dist/manifest.json']);
  console.log(`dist/ を作った：server.js ${m.serverChars} 字・html.json ${m.htmlChars} 字・指紋 ${m.server}`);
}
