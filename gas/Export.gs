/**
 * Export.gs — 先生の気づきと「失敗と速さ」の書き出し（LbExport）
 *
 * 正本は learning-base。所有者がコピーして Claude（私用 PC）に渡す。渡すのは学習BASE の使い勝手・機能性だけで、児童の学習状態は入れない。
 * 児童の名前・メール・学習者ID を書かない：気づきの名前は記号に置き換え（記号表はハブの pseudo_<年度> にだけある）、
 * 全文にも置き換えをかけ、最後に機械で確かめ、残っていれば文を返さない。先生のメールは「先生n」、学級は学年だけ。
 */
var LbExport = (function () {
  var FB = 'feedback', FB_HEAD = ['日時', '教師', '学級', '画面', '本文'];
  var CODE_HEAD = ['学習者ID・メール', '記号'];
  var day = LbSheets.day, sheet = LbSheets.sheet, usage = LbTelemetry.usage, cleanName = LbTelemetry.cleanName;

  /* ---------- 先生の気づき ---------- */

  function saveFeedback(hub, by, classKey, view, text) {
    text = String(text == null ? '' : text).trim().slice(0, 1000);
    if (!text) throw new Error('気づきが空です');
    var sh = sheet(hub, FB, FB_HEAD, [3, 4, 5]);
    sh.appendRow([new Date(), String(by || ''), String(classKey || ''), cleanName(view), text]);
  }
  function readFeedback(hub, sinceMs) {
    var sh = hub.getSheetByName(FB);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().map(function (r) {
      var t = r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime();
      return { t: t, by: String(r[1]), cls: String(r[2]), view: String(r[3]), text: String(r[4]) };
    }).filter(function (f) { return !isNaN(f.t) && f.t >= sinceMs && f.text; });
  }

  /* ---------- 記号（名前をかくす・気づきの置き換え） ---------- */

  /**
   * 今年度の記号表（ハブの pseudo_<年度>。学習者ID（教師はメール）→ 記号）。まだ記号の無い人にだけ振って足す。
   * 記号は乱数で振る（名前・番号・ID から導けない）。表はハブにだけ置く。
   */
  function codes(hub, fy, roster, teachers) {
    var name = 'pseudo_' + fy;
    function readEx() {
      var sh = hub.getSheetByName(name), ex = {};
      if (sh && sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) { if (r[0] && r[1]) ex[String(r[0])] = String(r[1]); });
      return ex;
    }
    var ppl = roster.filter(function (r) { return r.lid && r.name; }).map(function (r) { return { id: r.lid, sei: r.sei, mei: r.mei, seiKana: r.seiKana, meiKana: r.meiKana }; })
      .concat((teachers || []).filter(function (t) { return t.mail && (t.sei || t.mei); }).map(function (t) { return { id: t.mail, sei: t.sei, mei: t.mei, seiKana: t.seiKana, meiKana: t.meiKana }; }));
    var ex = readEx();
    if (ppl.every(function (p) { return ex[p.id]; })) return LbPseudo.table(ppl, { existing: ex });
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      ex = readEx();
      var tbl = LbPseudo.table(ppl, { existing: ex });
      var rows = ppl.filter(function (p) { return !ex[p.id]; }).map(function (p) { return [p.id, tbl.codeOf[p.id]]; });
      if (rows.length) {
        var sh = sheet(hub, name, CODE_HEAD, [1, 2]);
        sh.getRange(sh.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
      }
      return tbl;
    } finally { lock.releaseLock(); }
  }
  /* ---------- 改善用の書き出し ---------- */

  /**
   * 最後の確かめ：メール・学習者ID・名前（記号表の全表記）が残っていないか。
   * 返す：{ ok, problems: [文] }。名前は置き換えをもう一度かけて、当たる箇所が無いことで確かめる
   */
  function guard(text, tbl, roster) {
    var probs = [];
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.test(text)) probs.push('メールアドレスが残っています');
    var lids = 0;
    roster.forEach(function (r) { if (r.lid && text.indexOf(r.lid) >= 0) lids++; });
    if (lids) probs.push('学習者ID が ' + lids + ' 件 残っています');
    var again = LbPseudo.replace(text, tbl);
    if (again.hits.length) probs.push('名前が ' + again.hits.length + ' か所 残っています');
    return { ok: !probs.length, problems: probs };
  }

  function table(head, rows) {
    return '| ' + head.join(' | ') + ' |\n|' + head.map(function () { return '---'; }).join('|') + '|\n' +
      rows.map(function (r) { return '| ' + r.map(function (c) { return String(c).replace(/\|/g, '／').replace(/\n/g, ' '); }).join(' | ') + ' |'; }).join('\n');
  }

  /**
   * 「失敗と速さ」の書き出し（Markdown。所有者が Claude に渡す）。観察では見えないものだけ。児童の学習状態は入れない。
   * o: { hub, fy, today, ver, roster, teachers, settings: [{ classKey, hidden, now }], days }
   * 返す：{ ok, text（ok の時だけ）, problems, notes: [目で確かめてほしいこと（画面にだけ出す。書き出しには入れない）] }
   */
  function exportText(o) {
    var today = o.today || day(), days = o.days || 14;
    var sinceDay = day(new Date(new Date(today + 'T12:00:00+09:00').getTime() - (days - 1) * 86400000));
    var last7 = day(new Date(new Date(today + 'T12:00:00+09:00').getTime() - 6 * 86400000));
    var out = [], notes = [];
    out.push('# 学習BASE 失敗と速さ');
    out.push('書き出した日：' + today + '／版：' + (o.ver || '不明') + '／年度：' + o.fy + '／児童の学習状態は入れていません');

    var u = usage(o.hub, sinceDay), ev = {};
    Object.keys(u).forEach(function (d) {
      Object.keys(u[d]).forEach(function (e) { var x = ev[e] || (ev[e] = { a: 0, b: 0 }); if (d >= last7) x.a += u[d][e]; else x.b += u[d][e]; });
    });
    function pick(re) {
      return Object.keys(ev).filter(function (e) { return re.test(e.slice(e.indexOf('|') + 1)); }).sort().map(function (e) {
        var i = e.indexOf('|'); return { role: e.slice(0, i), name: e.slice(i + 1), a: ev[e].a, b: ev[e].b };
      });
    }
    var boots = pick(/^boot$/);
    out.push('\n開いた回数（分母）：' + (boots.length ? boots.map(function (r) { return r.role + ' ' + r.a + '（その前7日 ' + r.b + '）'; }).join('・') : 'まだ記録がありません'));

    var errs = pick(/^(err|js|client):|^その他$/);
    out.push('\n## 1. 失敗（直近7日と、その前の7日）\nerr＝サーバーの失敗（どこで:エラー文）／js＝画面の JavaScript の失敗／client＝画面の読み込みの失敗。メール・ID・長い数は伏せています');
    out.push(errs.length ? table(['区分', '失敗', '直近7日', 'その前7日'], errs.map(function (r) { return [r.role, r.name, r.a, r.b]; })) : '（ありません）');

    var sp = pick(/^(srv|rt):/);
    out.push('\n## 2. 速さ\nsrv＝サーバーでの処理時間（ホームを開く時）／rt＝開いてから表示までの往復（端末のメモリ別。前回分）');
    out.push(sp.length ? table(['区分', '速さ', '直近7日', 'その前7日'], sp.map(function (r) { return [r.role, r.name, r.a, r.b]; })) : '（まだ記録がありません）');

    var st = pick(/^(start|deadend):/);
    out.push('\n## 3. 始めるまで（児童。直した時に効いたかを比べる用）\nstart＝ホームを開いてから最初のページを開くまで（学年:経路:時間）／deadend＝教科に入って何も開かずに戻った回数');
    out.push(st.length ? table(['出来事', '直近7日', 'その前7日'], st.map(function (r) { return [r.name, r.a, r.b]; })) : '（まだ記録がありません）');

    var s = o.settings || [], saved = LbAlerts.savedValues(o.hub);
    var hidCls = s.filter(function (x) { return x.hidden > 0; }).length, nowCls = s.filter(function (x) { return x.now > 0; }).length;
    out.push('\n## 4. 先生の設定\n- 学級：' + s.length + '／かくしたページ：計 ' + s.reduce(function (a, x) { return a + x.hidden; }, 0) + ' 件（' + hidCls + ' 学級）' +
      '／いまの学習：計 ' + s.reduce(function (a, x) { return a + x.now; }, 0) + ' 件（' + nowCls + ' 学級）');
    out.push('- 閾値（所有者が初期値から変えたもの）：' + (Object.keys(saved).length ? Object.keys(saved).map(function (k) { return k + ' ' + LbAlerts.getPath(LbAlerts.RULES, k) + '→' + saved[k]; }).join('・') : 'なし'));

    // 気づき：先生のメールは「先生n」に、学級は学年だけに、文の中の名前は記号に
    var tbl = codes(o.hub, o.fy, o.roster, o.teachers);
    var fb = readFeedback(o.hub, new Date(sinceDay + 'T00:00:00+09:00').getTime()), tno = {}, tn = 0;
    out.push('\n## 5. 先生の気づき（直近' + days + '日。文の中の名前は記号〔…〕に置き換え済み）');
    if (!fb.length) out.push('（ありません）');
    fb.forEach(function (f) {
      if (!tno[f.by]) tno[f.by] = '先生' + (++tn);
      var r = LbPseudo.replace(f.text, tbl);
      r.skipped1.forEach(function (x) { notes.push('1文字の名前かもしれない「' + x.name + '」を置き換えていません（' + day(new Date(f.t)) + ' の気づき）'); });
      r.warn.forEach(function (x) { notes.push('「' + x.name + '」を名前として ' + x.count + ' か所 置き換えました。普通の言葉なら、元の文を言い換えてください'); });
      if (r.hits.length) notes.push(day(new Date(f.t)) + ' の気づきに児童・先生の名前がありました（記号に置き換え済み）。児童の学習のようすが書かれていないか読んでください');
      var g = String(f.cls).split('-')[0];
      out.push('- ' + day(new Date(f.t)) + '・' + tno[f.by] + '・' + (Number(g) ? g + '年' : '学級なし') + '・' + (f.view || '—') + '：' + r.text);
    });

    // 全体にも置き換えをかける（エラー文などに名前と同じ表記がある時のため）。置き換えた所は画面で知らせる
    var text = out.join('\n'), all = LbPseudo.replace(text, tbl);
    var fbStart = text.indexOf('\n## 5. ');
    all.hits.filter(function (h) { return h.start < fbStart; }).forEach(function (h) { notes.push('気づき以外の所で「' + h.from + '」を記号に置き換えました（エラー文などと重なっています）'); });
    text = all.text;
    var g = guard(text, tbl, o.roster);
    return { ok: g.ok, text: g.ok ? text : '', problems: g.problems, notes: notes.filter(function (v, i, a) { return a.indexOf(v) === i; }) };
  }
  return { saveFeedback: saveFeedback, readFeedback: readFeedback, codes: codes, guard: guard, exportText: exportText };
})();
