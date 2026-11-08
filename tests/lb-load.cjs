// gas/ のファイルを Node の vm で読み込む（GAS の模擬は gas-mock.cjs）
const fs = require('fs'), path = require('path'), vm = require('vm');
function loadPure(files, extra) {
  const ctx = Object.assign({ console }, extra || {});
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
  return ctx;
}
const J = x => JSON.stringify(x);
module.exports = { loadPure, J };
