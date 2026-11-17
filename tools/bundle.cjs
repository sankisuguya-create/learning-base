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
const GAS_ORDER = ['Sheets.gs', 'Base.gs', 'Pseudo.gs', 'Catalog.gs', 'LbSession.gs', 'Facts.gs', 'Alerts.gs', 'Directives.gs', 'Telemetry.gs', 'Tuning.gs', 'Export.gs', 'Pages.gs', 'Home.gs'];
const lock = JSON.parse(fs.readFileSync(path.join(R, 'apps.lock.json'), 'utf8'));

function gitShow(repo, commit, file) {
  const dir = path.resolve(process.env.LB_APPS_DIR ? path.resolve(R, process.env.LB_APPS_DIR) : path.resolve(R, '..'), repo.split('/')[1]);   // GitHub Actions では LB_APPS_DIR に取り込む
  if (!fs.existsSync(dir)) throw new Error(`${repo} のクローンが ${dir} にありません`);
  return execFileSync('git', ['-C', dir, 'show', `${commit}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** アプリのサーバー側のコードを関数の中に包む。包んだ中の LB_RESOLVE_ は、画面から呼ぶ関数を名前で探す */
function wrap(id, a, code) {
  // どのアプリにも渡す：自分のリポジトリと版（画面のファイルを jsDelivr から版で固定して読むのに使う。docs/add-app.md）
  a = Object.assign({}, a, { locals: Object.assign({ LB_APP_REPO: a.repo, LB_APP_COMMIT: a.commit }, a.locals || {}) });
  const locals = Object.entries(a.locals || {}).map(([k, v]) => `var ${k} = ${JSON.stringify(v)};`).join('\n');
  const exp = Object.entries(a.exports).map(([k, v]) => `${JSON.stringify(k)}: (typeof ${v} === 'function' ? ${v} : undefined)`).join(',\n  ');
  // 読み込みの時点で失敗したアプリは、そのアプリだけ { broken } にする（学習BASE とほかのアプリは動き続ける）。
  // 文法の誤りはここでは閉じ込められないので、検査（server.js を実際に読み込む platform.test）で落とす
  return `// ===== アプリ ${id}（${a.repo}@${a.commit.slice(0, 7)}） =====
LB_MODULES[${JSON.stringify(id)}] = (function () { try { return (function () {
${locals}
var LB_RESOLVE_ = function (n) { return /^[A-Za-z][A-Za-z0-9]*$/.test(n) ? eval('typeof ' + n + " === 'function' ? " + n + ' : undefined') : undefined; };
${code}
return {
  ${exp}
};
})(); } catch (e) { console.error(${JSON.stringify('アプリ ' + id + ' を読み込めません: ')} + (e && e.message || e)); return { broken: String(e && e.message || e) }; } })();
`;
}

/**
 * 作るもの
 *   dist/core.js         … 共通部品＋振り分け（新しい読み込み係が毎回読む）
 *   dist/app-<id>.js     … 教科（アプリ）ごとのサーバーのコード（その教科を使う時だけ読む）
 *   dist/html-<id>.json  … 教科ごとの画面のファイル（その教科のページを返す時だけ読む）
 *   dist/server.js・dist/html.json … 全部をまとめたもの（前の読み込み係のため。貼り直した後は使わない）
 *   dist/manifest.json   … 各ファイルの指紋（読み込み係が照らし合わせる）・取り込んだアプリの版
 * 教科を足しても、1回の呼び出しで読む量は「共通部品＋その教科」のまま増えない
 */
function build() {
  const head = ['var LB_MODULES = (typeof LB_MODULES !== "undefined" && LB_MODULES) || {};',
    'var LB_PLATFORM_TRIGGERS = true;   // 自動実行は読み込み係が置く（アプリは置かない）'];
  const common = GAS_ORDER.map(f => `// ===== gas/${f} =====\n` + fs.readFileSync(path.join(R, 'gas', f), 'utf8'));
  const platform = '// ===== gas/Platform.gs =====\n' + fs.readFileSync(path.join(R, 'gas', 'Platform.gs'), 'utf8');
  const out = {}, apps = {}, ids = [], ready = {}, htmlAll = {}, appCode = [];
  for (const [id, a] of Object.entries(lock)) {
    if (id === '_') continue;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('アプリの名前が不正: ' + id);
    ids.push(id);
    if (a.readyProp) ready[id] = a.readyProp;
    const code = a.server.map(f => `// --- ${f} ---\n` + gitShow(a.repo, a.commit, f)).join('\n');
    const w = wrap(id, a, code);
    appCode.push(w);
    out[`dist/app-${id}.js`] = `// dist/app-${id}.js — 教科 ${id} のサーバーのコード（tools/bundle.cjs が作る。直接直さない）\n` + w;
    const html = {};
    for (const [name, f] of Object.entries(a.files || {})) html[`${id}/${name}`] = htmlAll[`${id}/${name}`] = gitShow(a.repo, a.commit, f);
    out[`dist/html-${id}.json`] = JSON.stringify(html);
    apps[id] = { repo: a.repo, commit: a.commit };
  }
  const reg = `var LB_APP_IDS = ${JSON.stringify(ids)};   // 載っている教科（アプリ）\nvar LB_APP_READY = ${JSON.stringify(ready)};   // 準備に要るスクリプトのプロパティ`;
  out['dist/core.js'] = ['// dist/core.js — 学習BASE の共通部品と振り分け（tools/bundle.cjs が作る。直接直さない）', ...head, reg, ''].concat(common, [platform]).join('\n');
  out['dist/server.js'] = ['// dist/server.js — 学習BASE のサーバー側のコード（全部入り。前の読み込み係のため。tools/bundle.cjs が作る）', ...head, reg, ''].concat(common, appCode, [platform]).join('\n');
  out['dist/html.json'] = JSON.stringify(htmlAll);
  const sha = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
  const files = {}, chars = {};
  for (const f of Object.keys(out).sort()) { files[f.slice(5)] = sha(out[f]); chars[f.slice(5)] = out[f].length; }
  out['dist/manifest.json'] = JSON.stringify({ server: files['server.js'], html: files['html.json'], serverChars: chars['server.js'], htmlChars: chars['html.json'],
    files, chars, apps }, null, 1) + '\n';
  return out;
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
  // 前の形で作った dist/ の古いアプリのファイルを消す（apps.lock.json から外したアプリ）
  for (const f of fs.readdirSync(path.join(R, 'dist'))) if (/^(app-.*\.js|html-.*\.json)$/.test(f) && !m.files[f]) fs.unlinkSync(path.join(R, 'dist', f));
  console.log('dist/ を作った：' + Object.keys(m.chars).map(f => f + ' ' + m.chars[f] + '字').join('・'));
}
