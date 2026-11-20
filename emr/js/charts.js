/* 経過グラフ（SVG・ライブラリなし）。1グラフ1軸。ホバーで日付ごとの値を表示 */
(function (g) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const U = g.EMRUI;

  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
    for (const k of kids) if (k) el.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
    return el;
  }
  const t = d => new Date(d + "T00:00:00").getTime();

  function niceTicks(min, max, n) {
    const span = max - min || Math.abs(max) || 1;
    const step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(x => span / x <= n) || 10 * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(6));
    return out;
  }

  /**
   * opts: { title, unit, series: [{ name, slot: 1|2, points: [{ d: 'YYYY-MM-DD', y }] }], band: [lo, hi] }
   */
  function lineChart(opts) {
    const W = 640, H = 200, L = 44, R = 92, T = 14, B = 26;
    const all = opts.series.flatMap(se => se.points);
    const wrap = U.h("figure", { class: "chart" }, U.h("figcaption", null, opts.title, opts.unit ? U.h("span", { class: "muted" }, `（${opts.unit}）`) : null));
    if (!all.length) { wrap.appendChild(U.h("p", { class: "muted small" }, "記録がありません")); return wrap; }
    const dates = Array.from(new Set(all.map(p => p.d))).sort();
    let x0 = t(dates[0]), x1 = t(dates[dates.length - 1]);
    if (x0 === x1) { x0 -= 86400000 * 15; x1 += 86400000 * 15; }
    let ys = all.map(p => p.y);
    if (opts.band) ys = ys.concat(opts.band.filter(v => v !== null));
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    const padY = (y1 - y0) * 0.12 || Math.abs(y1) * 0.1 || 1;
    const ticks = niceTicks(y0 - padY, y1 + padY, 4);
    y0 = ticks[0]; y1 = ticks[ticks.length - 1];
    const X = v => L + (t(v) - x0) / (x1 - x0) * (W - L - R);
    const Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${opts.title}の経過グラフ` });
    if (opts.band) {
      const lo = opts.band[0] === null ? y0 : Math.max(opts.band[0], y0), hi = opts.band[1] === null ? y1 : Math.min(opts.band[1], y1);
      if (hi > lo) svg.appendChild(s("rect", { class: "band", x: L, y: Y(hi), width: W - L - R, height: Y(lo) - Y(hi) }));
    }
    for (const v of ticks) {
      svg.appendChild(s("line", { class: "grid", x1: L, x2: W - R, y1: Y(v), y2: Y(v) }));
      svg.appendChild(s("text", { class: "tick", x: L - 6, y: Y(v) + 4, "text-anchor": "end" }, String(v)));
    }
    const xt = dates.length <= 6 ? dates : [dates[0], dates[Math.floor(dates.length / 2)], dates[dates.length - 1]];
    for (const d of xt) svg.appendChild(s("text", { class: "tick", x: X(d), y: H - 8, "text-anchor": "middle" }, `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`));

    const labels = [];
    for (const se of opts.series) {
      const pts = se.points.slice().sort((a, b) => a.d.localeCompare(b.d));
      if (!pts.length) continue;
      const cls = "s" + (se.slot || 1);
      if (pts.length > 1) svg.appendChild(s("path", { class: "line " + cls, d: pts.map((p, i) => `${i ? "L" : "M"}${X(p.d).toFixed(1)},${Y(p.y).toFixed(1)}`).join("") }));
      for (const p of pts) svg.appendChild(s("circle", { class: "dot " + cls, cx: X(p.d), cy: Y(p.y), r: 4 }));
      const last = pts[pts.length - 1];
      labels.push({ y: Y(last.y), text: `${se.name} ${last.y}`, cls });
    }
    // 直接ラベル（重なり回避）
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
    for (const lb of labels) svg.appendChild(s("text", { class: "dlabel", x: W - R + 8, y: lb.y + 4 }, lb.text));

    // ホバー
    const cross = s("line", { class: "cross", y1: T, y2: H - B, x1: L, x2: L, visibility: "hidden" });
    svg.appendChild(cross);
    const hit = s("rect", { x: L, y: 0, width: W - L - R, height: H, fill: "transparent" });
    svg.appendChild(hit);
    const tip = U.h("div", { class: "chart-tip", hidden: true });
    const box = U.h("div", { class: "chart-box" }, svg, tip);
    function show(evt) {
      const r = svg.getBoundingClientRect();
      const px = (evt.clientX - r.left) / r.width * W;
      let best = dates[0];
      for (const d of dates) if (Math.abs(X(d) - px) < Math.abs(X(best) - px)) best = d;
      cross.setAttribute("x1", X(best)); cross.setAttribute("x2", X(best)); cross.setAttribute("visibility", "visible");
      U.clear(tip);
      tip.appendChild(U.h("b", null, U.jdate(best)));
      for (const se of opts.series) {
        const p = se.points.find(q => q.d === best);
        tip.appendChild(U.h("div", null, U.h("i", { class: "key s" + (se.slot || 1) }), `${se.name}: `, p ? `${p.y}${opts.unit ? " " + opts.unit : ""}` : "—"));
      }
      tip.hidden = false;
      const left = X(best) / W * r.width;
      tip.style.left = Math.min(Math.max(left + 10, 0), r.width - 150) + "px";
    }
    hit.addEventListener("mousemove", show);
    hit.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
    wrap.appendChild(box);
    if (opts.series.length > 1) {
      wrap.appendChild(U.h("div", { class: "legend" }, opts.series.map(se => U.h("span", null, U.h("i", { class: "key s" + (se.slot || 1) }), se.name))));
    }
    return wrap;
  }

  g.EMRCharts = { lineChart };
})(window);
