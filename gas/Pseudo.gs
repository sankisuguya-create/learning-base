/**
 * Pseudo.gs — 名前を記号に置き換える（Gemini・NotebookLM に渡す前）
 *
 * 正本は learning-base。設計：`-` リポジトリ principles/learning-app-foundation.md §8
 * 画面も保存も持たない（純粋な計算だけ）。確認画面と書き出しはハブが持つ。
 *
 *   var t = LbPseudo.table(people, { existing: 保存した記号表 });   // 初めては existing なし
 *   var r = LbPseudo.replace(text, t);   // { text, hits, skipped1, warn }
 *   LbPseudo.restore(r.text, t);          // 記号を名前に戻す（1人に決まる記号だけ）
 *
 * people: [{ id, sei, mei, seiKana, meiKana }]（id は学習者ID。教師はメール。児童も教師も入れる）
 *
 * 規則（決定 2026-11）
 * - 1人につき 姓・名・姓名 × 漢字／ひらがな／カタカナ（姓名は空白あり・なし）。あだ名は対象外
 * - 照合の前に揃える：NFKC（全角半角）・異体字（髙→高 など）・カタカナ→ひらがな
 * - 長い表記から先に。重ならないように左から
 * - 姓だけ・名だけの表記が複数の人に当たる時は、誰か1人の記号にせず共通の記号〔共n〕にする
 * - 1文字の姓・名は単独では置き換えない。直後に敬称（さん・くん・ちゃん・君・先生・せんせい）がある時だけ置き換える。
 *   置き換えなかった箇所は skipped1 に返す（教師が目で確かめる）
 * - 敬称は残す（はなこさん → 〔z8〕さん）
 * - 2文字以下のひらがなの名（まい・ゆう）は一般語の中で多く当たるので warn に件数を返す
 */
var LbPseudo = (function () {
  var OPEN = '〔', CLOSE = '〕';
  var HONORIFIC = ['さん', 'くん', 'ちゃん', '君', '先生', 'せんせい', 'さま', '様'];
  // 名前に使われる主な異体字 → 通用字体（照合の時だけ使う。元の文は変えない）
  var ITAIJI = {
    '髙': '高', '﨑': '崎', '嵜': '崎', '碕': '崎', '邉': '辺', '邊': '辺', '濵': '浜', '濱': '浜',
    '齋': '斎', '齊': '斉', '斎': '斎', '澤': '沢', '櫻': '桜', '廣': '広', '國': '国', '眞': '真',
    '藪': '薮', '槇': '槙', '德': '徳', '惠': '恵', '曻': '昇', '瀨': '瀬', '冨': '富', '桒': '桑',
    '鄕': '郷', '條': '条', '圓': '円', '龍': '竜', '彌': '弥', '壽': '寿', '實': '実', '淸': '清', '靜': '静'
  };
  // 記号に使う文字（紛らわしい 0 O o 1 l I i を除く）
  var LETTERS = 'abcdefghjkmnpqrstuvwxyz'.split('');
  var DIGITS = '23456789'.split('');

  /* ---------- 文字を揃える ---------- */

  function normChar(c) {
    var s = c.normalize ? c.normalize('NFKC') : c;
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      ch = ITAIJI[ch] || ch;
      var code = ch.charCodeAt(0);
      if (code >= 0x30A1 && code <= 0x30F6) ch = String.fromCharCode(code - 0x60);   // カタカナ → ひらがな
      out += ch;
    }
    return out;
  }
  /** 揃えた文字列と、揃えた後の各文字が元の何文字目から来たかの対応 */
  function normalize(text) {
    var out = '', map = [];
    var chars = Array.from(String(text == null ? '' : text));
    var pos = 0;
    for (var i = 0; i < chars.length; i++) {
      var n = normChar(chars[i]);
      for (var j = 0; j < n.length; j++) { out += n.charAt(j); map.push(pos); }
      pos += chars[i].length;
    }
    map.push(pos);   // 末尾
    return { text: out, map: map };
  }
  function normName(s) { return normalize(String(s || '').replace(/[\s　]+/g, '')).text; }

  /* ---------- 記号表 ---------- */

  function pool(len) {
    var p = [];
    if (len === 2) LETTERS.forEach(function (l) { DIGITS.forEach(function (d) { p.push(l + d); }); });
    else LETTERS.forEach(function (l) { DIGITS.forEach(function (d) { LETTERS.forEach(function (l2) { p.push(l + d + l2); }); }); });
    return p;
  }
  /** 0 以上 1 未満の乱数。GAS では UUID（暗号論的な乱数）から作る */
  function defaultRandom() {
    if (typeof Utilities !== 'undefined' && Utilities.getUuid) {
      var hex = Utilities.getUuid().replace(/-/g, '');
      return parseInt(hex.slice(0, 12), 16) / 281474976710656;
    }
    return Math.random();
  }

  /**
   * 記号表を作る。
   * - 記号は乱数で振る。名前・年齢・メール・ID・出席番号など、外の人が知りうる情報からは導けない
   *   （計算で求める方式にしない。種を知られても、ID と記号の対応を再現できない）
   * - そのため記号表は保存して使い続ける：opts.existing（{ id: 記号 }、ハブに保存した今年度の記号表）を渡すと、
   *   その記号をそのまま使い、まだ記号の無い人（転入生）にだけ空いている記号を振る
   * - id は学習者ID（メールではない。メールの無い転入生にも付き、後でメールが付いても変わらない）
   * - 記号の長さ：人数が 90 人以下なら2文字（z8）、それより多ければ3文字（k3m）。existing があればその長さ
   * 返す：{ people: [{ id, code, name }], variants, codeOf: {id: code}, byCode: {code: name} }
   */
  function table(people, opts) {
    opts = opts || {};
    var random = opts.random || defaultRandom;
    var list = (people || []).filter(function (p) { return p && p.id; });
    var existing = opts.existing || {};
    var exCodes = Object.keys(existing).map(function (k) { return existing[k]; });
    var len = exCodes.length ? exCodes[0].length : (list.length <= 90 ? 2 : 3);
    var P = pool(len);
    if (list.length > P.length * 0.9) { len = 3; P = pool(3); }
    var used = {}, codeOf = {};
    list.forEach(function (p) { if (existing[p.id]) { codeOf[p.id] = existing[p.id]; used[existing[p.id]] = true; } });
    var free = P.filter(function (c) { return !used[c]; });
    list.forEach(function (p) {
      if (codeOf[p.id]) return;
      if (!free.length) throw new Error('記号が足りません');
      var k = Math.floor(random() * free.length);
      codeOf[p.id] = free[k];
      free.splice(k, 1);
    });
    var byCode = {}, out = [];
    list.forEach(function (p) {
      var name = [p.sei, p.mei].filter(Boolean).join(' ');
      byCode[codeOf[p.id]] = name;
      out.push({ id: p.id, code: codeOf[p.id], name: name });
    });

    // 表記 → その表記を持つ人
    var vmap = {};
    function add(raw, id, part) {
      var key = normName(raw);
      if (!key) return;
      var v = vmap[key] || (vmap[key] = { key: key, len: key.length, ids: {}, part: part });
      v.ids[id] = true;
      if (part === 'full') v.part = 'full';
    }
    list.forEach(function (p) {
      var sei = String(p.sei || ''), mei = String(p.mei || ''), sk = String(p.seiKana || ''), mk = String(p.meiKana || '');
      if (sei) add(sei, p.id, 'sei');
      if (mei) add(mei, p.id, 'mei');
      if (sei && mei) add(sei + mei, p.id, 'full');
      if (sk) add(sk, p.id, 'sei');
      if (mk) add(mk, p.id, 'mei');
      if (sk && mk) add(sk + mk, p.id, 'full');
      if (sei && mk) add(sei + mk, p.id, 'full');   // 「田中はなこ」のような混ぜ書き
      if (sk && mei) add(sk + mei, p.id, 'full');
    });
    var variants = Object.keys(vmap).map(function (k) {
      var v = vmap[k];
      return { key: v.key, len: v.len, ids: Object.keys(v.ids), part: v.part };
    }).sort(function (a, b) { return b.len - a.len || (a.key < b.key ? -1 : 1); });

    // 複数の人に当たる表記に共通の記号を振る（表の中で安定した番号）
    var shared = 0;
    variants.forEach(function (v) {
      if (v.ids.length > 1) { shared++; v.code = '共' + shared; }
      else v.code = codeOf[v.ids[0]];
    });
    return { people: out, variants: variants, codeOf: codeOf, byCode: byCode };
  }

  /* ---------- 置き換え ---------- */

  function isHira(s) { return /^[ぁ-ゖー]+$/.test(s); }

  /**
   * 文の中の名前を記号に置き換える。
   * 返す：{ text, hits: [{ from, to, code, start, end }], skipped1: [{ name, start, end }], warn: [{ name, count }] }
   * start / end は元の文での位置（UTF-16 の添字）。確認画面で色を付けるのに使う。
   */
  function replace(text, tbl) {
    text = String(text == null ? '' : text);
    var nz = normalize(text), s = nz.text;
    // 先頭の文字 → その文字で始まる表記（長い順）
    var byFirst = {};
    tbl.variants.forEach(function (v) { (byFirst[v.key.charAt(0)] = byFirst[v.key.charAt(0)] || []).push(v); });
    // 空白をはさんだ姓名（「田中 はなこ」）も1つの表記として当てる
    function matchAt(i, v) {
      var k = 0, j = i;
      while (k < v.key.length && j < s.length) {
        if (s.charAt(j) === v.key.charAt(k)) { j++; k++; continue; }
        if (v.part === 'full' && k > 0 && /[\s]/.test(s.charAt(j))) { j++; continue; }
        return -1;
      }
      return k === v.key.length ? j : -1;
    }
    function honorificAt(j) {
      for (var h = 0; h < HONORIFIC.length; h++) if (s.substr(j, HONORIFIC[h].length) === normName(HONORIFIC[h])) return true;
      return false;
    }
    var hits = [], skipped1 = [], warnCount = {};
    var i = 0;
    while (i < s.length) {
      var cands = byFirst[s.charAt(i)], done = false;
      if (cands) {
        for (var c = 0; c < cands.length; c++) {
          var v = cands[c], end = matchAt(i, v);
          if (end < 0) continue;
          if (v.len === 1 && v.part !== 'full') {
            if (!honorificAt(end)) { skipped1.push({ name: text.slice(nz.map[i], nz.map[end]), start: nz.map[i], end: nz.map[end] }); continue; }
          }
          if (v.part !== 'full' && v.len <= 2 && isHira(v.key)) warnCount[v.key] = (warnCount[v.key] || 0) + 1;
          hits.push({ from: text.slice(nz.map[i], nz.map[end]), to: OPEN + v.code + CLOSE, code: v.code, start: nz.map[i], end: nz.map[end] });
          i = end; done = true; break;
        }
      }
      if (!done) i++;
    }
    // 後ろから置き換える（位置がずれないように）
    var out = text;
    for (var h = hits.length - 1; h >= 0; h--) out = out.slice(0, hits[h].start) + hits[h].to + out.slice(hits[h].end);
    var warn = Object.keys(warnCount).map(function (k) { return { name: k, count: warnCount[k] }; });
    return { text: out, hits: hits, skipped1: skipped1, warn: warn };
  }

  /** 名簿の中で、照合の前に件数を見せるべき名（2文字以下のひらがなの姓・名） */
  function riskyNames(tbl) {
    return tbl.variants.filter(function (v) { return v.part !== 'full' && v.len <= 2 && isHira(v.key); }).map(function (v) { return v.key; });
  }

  /** 記号を名前に戻す。共通の記号〔共n〕は戻さない（誰か1人に決まらないため） */
  function restore(text, tbl) {
    return String(text == null ? '' : text).replace(/〔([a-z0-9]{2,3})〕/g, function (m, code) {
      return Object.prototype.hasOwnProperty.call(tbl.byCode, code) ? tbl.byCode[code] : m;
    });
  }

  return { table: table, replace: replace, restore: restore, riskyNames: riskyNames, _normalize: normalize };
})();
