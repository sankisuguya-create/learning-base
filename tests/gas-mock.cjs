// GAS の最小の模擬（Base.gs の検査用）。Node の vm で Base.gs を読み込む
const fs = require('fs'), path = require('path'), vm = require('vm');

function makeSheet(values) {
  return { getDataRange: () => ({ getValues: () => values.map(r => r.slice()) }) };
}
function makeSpreadsheet(sheets, owner) {
  return {
    getSheetByName: n => (sheets[n] ? makeSheet(sheets[n]) : null),
    getOwner: () => ({ getEmail: () => owner || 'owner@edu.nishi.or.jp' })
  };
}

function load({ strict = false, owner_user = null, user = '', props = {}, active = {}, byId = {}, now = new Date('2026-11-05T09:00:00+09:00'), owner } = {}) {
  const store = {}, calls = { openById: 0 };
  const cache = {
    get: k => (k in store ? store[k] : null),
    getAll: ks => { const o = {}; ks.forEach(k => { if (k in store) o[k] = store[k]; }); return o; },
    putAll: m => { Object.assign(store, m); },
    removeAll: ks => ks.forEach(k => delete store[k])
  };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now.getTime()); }
    static now() { return now.getTime(); }
  }
  const ctx = {
    Date: FakeDate,
    Session: { getActiveUser: () => ({ getEmail: () => user }), getEffectiveUser: () => ({ getEmail: () => owner_user || 'owner@edu.nishi.or.jp' }), getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const s = new RealDate(d.getTime() + 9 * 3600 * 1000);   // JST 固定
        if (fmt === 'yyyy') return String(s.getUTCFullYear());
        if (fmt === 'M') return String(s.getUTCMonth() + 1);
        throw new Error('fmt ' + fmt);
      }
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => cache },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => makeSpreadsheet(active, owner),
      openById: id => { calls.openById++; if (!byId[id]) throw new Error('開けません ' + id); return makeSpreadsheet(byId[id], owner); }
    }
  };
  vm.createContext(ctx);
  let src = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Base.gs'), 'utf8');
  if (strict) {
    if (!src.includes('var STRICT_SCOPE = false;')) throw new Error('STRICT_SCOPE が見つからない');
    src = src.replace('var STRICT_SCOPE = false;', 'var STRICT_SCOPE = true;');
  }
  vm.runInContext(src, ctx);
  return { Base: ctx.Base, ctx, store, calls, props };
}
module.exports = { load };
