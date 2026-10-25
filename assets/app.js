/* 平准基金观测站 前端逻辑
   纯静态: 读取 data/ 下的 JSON 渲染。本地预览: python3 -m http.server */
"use strict";

const INDEX_META = {
  "000001": "上证指数",
  "399001": "深证成指",
  "000688": "科创50"
};
const EVENT_STYLE = {
  buy:    { color: "#1f5fbf", label: "公开增持" },
  policy: { color: "#5b48b0", label: "政策出台" },
  trough: { color: "#d23b3b", label: "事后价格低点" },
  sell:   { color: "#d97b1f", label: "推算的份额减少窗口" }
};
const VOTE_LABEL = { support: "偏暖", risk: "警惕", neutral: "中性" };
const DEFAULT_ETF_VIEW_START = "2025-12-31";
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const AXIS = dark ? "#9a9891" : "#787672";
const GRIDLINE = dark ? "#2b2d33" : "#e3e1da";
const INKLINE = dark ? "#c9c8c2" : "#44454a";
const chartInstances = [];
let resizeFrame = null;

function registerChart(chart) {
  chartInstances.push(chart);
  return chart;
}

function resizeAllCharts() {
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    chartInstances.forEach(chart => chart.resize());
    resizeFrame = null;
  });
}
window.addEventListener("resize", resizeAllCharts, { passive: true });

async function fetchJSON(path) {
  try {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
async function fetchText(path) {
  try {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) { return null; }
}
const fmt = (x, d = 2) => (x === null || x === undefined) ? "—" : Number(x).toFixed(d);
const pct = x => (x === null || x === undefined) ? "—" : (x * 100).toFixed(1) + "%";
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
function baseChartOpts() {
  return {
    animation: false,
    grid: { left: 56, right: 18, top: 26, bottom: 32 },
    textStyle: { fontFamily: "system-ui, PingFang SC, Microsoft YaHei" },
    tooltip: { trigger: "axis", confine: true }
  };
}

function naturalDaysBetween(left, right) {
  return Math.round((Date.parse(`${right}T00:00:00Z`) -
    Date.parse(`${left}T00:00:00Z`)) / 864e5);
}

function comparableShareChanges(rows) {
  const changes = [];
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const current = rows[i];
    const gap = naturalDaysBetween(previous.date, current.date);
    // 正常周末算相邻记录；更长空档不画“单日”异动，避免把缺失数据误判成交易。
    if (gap < 1 || gap > 5 || !previous.verified || !current.verified) continue;
    changes.push({
      date: current.date,
      delta: Number(current.chart_shares_yi) - Number(previous.chart_shares_yi),
      rowIndex: i
    });
  }
  return changes;
}

function normalizeShareRows(code, rows, adjustments) {
  const applicable = adjustments.filter(item => item.code === code);
  return rows.map(row => {
    let value = Number(row.total_shares_yi);
    const notes = [];
    for (const adjustment of applicable) {
      if (row.date < adjustment.effective_date) {
        value *= Number(adjustment.factor_before);
        notes.push(adjustment.note);
      }
    }
    return { ...row, chart_shares_yi: value, adjustment_notes: notes };
  });
}

/* ---------- 总览卡片 + ETF份额图 ---------- */
async function renderEtfSection(conf) {
  const grid = document.getElementById("etf-charts");
  const cards = document.getElementById("cards");
  const eventConfig = (await fetchJSON("data/huijin_etf_events.json")) ||
    { events: [] };
  const adjustments = (await fetchJSON("data/share_adjustments.json")) || [];
  const historyPairs = await Promise.all(conf.etfs.map(async etf =>
    [etf.code, normalizeShareRows(etf.code,
      (await fetchJSON(`data/history/${etf.code}.json`)) || [], adjustments)]));
  const histories = Object.fromEntries(historyPairs);
  const perEtfLatestDates = conf.etfs.map(etf => {
    const rows = histories[etf.code] || [];
    return rows.length ? rows[rows.length - 1].date : null;
  });
  const availableLatestDates = perEtfLatestDates.filter(Boolean);
  const latestDate = availableLatestDates.length
    ? availableLatestDates.slice().sort().at(-1) : null;
  const completeDate = perEtfLatestDates.every(Boolean)
    ? perEtfLatestDates.slice().sort()[0] : null;
  const latestCount = latestDate
    ? perEtfLatestDates.filter(date => date === latestDate).length : 0;
  // Canonical backend events own calendar adjacency, splits, units and thresholds.
  const pulseReport = await fetchJSON("data/pulse/report.json");
  const largeChanges = (pulseReport?.events || [])
    .filter(event => event.signals.includes("large"))
    .map(event => ({ ...event, delta: event.delta_shares / 1e8 }));
  const monitoringStart = Object.values(histories)
    .filter(rows => rows.length)
    .map(rows => rows[0].date)
    .sort()[0] || "—";
  let inverted = 0, watched = 0;
  let coreSum = 0, coreCount = 0;

  for (const etf of conf.etfs) {
    const rows = histories[etf.code];
    watched++;
    const box = el("div", "chart-box");
    const title = el("div", "chart-title",
      `<span>${etf.name} <code>${etf.code}</code></span>` +
      `<span class="chart-meta"><span class="badge"></span>` +
      `<span class="chart-range-controls">` +
      `<span class="chart-latest"></span>` +
      `<button type="button" class="chart-range-btn latest-btn">回到最新</button>` +
      `<button type="button" class="chart-range-btn all-btn">全部历史</button>` +
      `</span></span>`);
    const chartDiv = el("div", "chart");
    box.append(title, chartDiv);
    grid.append(box);
    if (!rows || !rows.length) {
      chartDiv.outerHTML = '<p class="empty" style="margin:12px">暂无份额数据，等待抓取脚本首次运行。</p>';
      continue;
    }
    const last = rows[rows.length - 1];
    title.querySelector(".chart-latest").textContent = `最新 ${last.date}`;
    title.querySelector(".latest-btn").setAttribute("aria-label", `${etf.name}回到最新日期`);
    title.querySelector(".all-btn").setAttribute("aria-label", `${etf.name}显示全部历史`);
    const base = etf.huijin_shares_yi;
    const isInv = base !== null && last.total_shares_yi < base;
    if (isInv) {
      inverted++;
      title.querySelector(".badge").textContent =
        `低于参考线 ${(base - last.total_shares_yi).toFixed(1)} 亿份`;
    }
    if (base !== null) { coreSum += last.total_shares_yi; coreCount++; }

    // 低于历史持仓参考线的时间区间（红色色带）
    const areas = [];
    if (base !== null) {
      let start = null;
      rows.forEach((r, i) => {
        const below = r.chart_shares_yi < base;
        if (below && start === null) start = r.date;
        if ((!below || i === rows.length - 1) && start !== null) {
          areas.push([{ xAxis: start }, { xAxis: below ? r.date : rows[Math.max(i - 1, 0)].date }]);
          start = null;
        }
      });
    }
    const chart = registerChart(echarts.init(chartDiv, null, { renderer: "svg" }));
    const dateIndex = new Map(rows.map((row, index) => [row.date, index]));
    const officialDisplayEvents = (eventConfig.events || [])
      .filter(event => event.type === "confirmed_buy" &&
        event.date >= rows[0].date && event.date <= rows[rows.length - 1].date &&
        (!event.etf_codes || event.etf_codes.includes(etf.code)))
      .map(event => {
        const eventRow = rows.find(row => row.date >= event.date);
        return eventRow ? { event, eventRow } : null;
      }).filter(Boolean);
    const officialByDate = new Map();
    for (const item of officialDisplayEvents) {
      const items = officialByDate.get(item.eventRow.date) || [];
      items.push(item.event);
      officialByDate.set(item.eventRow.date, items);
    }
    const officialMarks = officialDisplayEvents.map(({ event, eventRow }) => {
        const amountLine = event.amount_text ? `<br>公开买入：${event.amount_text}` : "";
        return {
          coord: [eventRow.date, eventRow.chart_shares_yi],
          symbol: "circle", symbolSize: 14,
          itemStyle: { color: "#d4a000", borderColor: "#745900", borderWidth: 1 },
          label: { show: false },
          tooltipText: `${event.date}<br><strong>公开ETF增持公告</strong><br>` +
            `${event.title}${amountLine}`
        };
      });
    const changeMarks = largeChanges
      .filter(change => change.code === etf.code && dateIndex.has(change.date))
      .map(change => ({
        coord: [change.date, rows[dateIndex.get(change.date)].chart_shares_yi],
        symbol: "circle",
        symbolSize: 13,
        itemStyle: {
          color: change.delta > 0 ? "#d23b3b" : "#1e7d3c",
          borderColor: "#fff",
          borderWidth: 1
        },
        label: { show: false },
        tooltipText: `${change.date}<br><strong>单只ETF百亿份额异动</strong><br>` +
          `${etf.name}${change.delta > 0 ? "净增" : "净减"}` +
          `${fmt(Math.abs(change.delta), 1)}亿份<br>` +
          "属于机构级异动，但公开数据不能确认交易主体"
      }));
    const requestedStartIndex = rows.findIndex(row => row.date >= DEFAULT_ETF_VIEW_START);
    const zoomStartIndex = requestedStartIndex >= 0 ? requestedStartIndex : 0;
    const defaultZoomStart = rows[zoomStartIndex].date;
    const insideZoomId = `etf-${etf.code}-inside`;
    const sliderZoomId = `etf-${etf.code}-slider`;
    chart.setOption(Object.assign(baseChartOpts(), {
      grid: { left: 58, right: 58, top: 26, bottom: 52 },
      dataZoom: [
        { id: insideZoomId, type: "inside", filterMode: "filter",
          startValue: defaultZoomStart, endValue: last.date },
        { id: sliderZoomId, type: "slider", filterMode: "filter", height: 16, bottom: 4,
          startValue: defaultZoomStart, endValue: last.date }
      ],
      xAxis: { type: "category", data: rows.map(r => r.date), triggerEvent: true,
               axisLabel: {
                 color: AXIS, hideOverlap: true,
                 showMinLabel: true, showMaxLabel: true,
                 interval: (_index, value) => {
                   if (value === rows[zoomStartIndex].date || value === last.date) return true;
                   const month = Number(value.slice(5, 7));
                   const day = Number(value.slice(8, 10));
                   return month % 2 === 0 && day <= 3;
                 }
               },
               axisLine: { lineStyle: { color: GRIDLINE } } },
      yAxis: { type: "value", scale: true, name: "亿份",
               axisLabel: { color: AXIS },
               splitLine: { lineStyle: { color: GRIDLINE } } },
      tooltip: {
        trigger: "axis", triggerOn: "mousemove|click", confine: true,
        axisPointer: { type: "line", snap: true },
        formatter: params => {
          const date = params[0] ? params[0].axisValue : rows[0].date;
          const row = rows[dateIndex.get(date) ?? 0];
          const displayed = row.chart_shares_yi;
          const notices = (officialByDate.get(row.date) || []).map(event =>
            `<br><strong>公开ETF增持公告</strong><br>${event.title}` +
            (event.amount_text ? `<br>公开买入：${event.amount_text}` : "")
          ).join("");
          return `${row.date}<br>总份额 ${fmt(displayed)} 亿份${notices}`;
        }
      },
      series: [{
        type: "line", data: rows.map(r => r.chart_shares_yi), showSymbol: false,
        lineStyle: { color: INKLINE, width: 2 }, itemStyle: { color: INKLINE },
        markLine: base === null ? undefined : {
          silent: true, symbol: "none",
          lineStyle: { color: "#1f5fbf", type: "dashed" },
          label: { formatter: `历史持仓参考线 ${base}`, color: "#1f5fbf", position: "insideEndTop" },
          data: [{ yAxis: base }]
        },
        markArea: areas.length ? {
          silent: true,
          itemStyle: { color: "rgba(210,59,59,0.11)" },
          data: areas
        } : undefined,
        markPoint: {
          data: [...changeMarks, ...officialMarks],
          tooltip: { formatter: p => p.data.tooltipText }
        }
      }]
    }));
    const setDateRange = startValue => {
      chart.setOption({ dataZoom: [
        { id: insideZoomId, startValue, endValue: last.date },
        { id: sliderZoomId, startValue, endValue: last.date }
      ] });
    };
    title.querySelector(".latest-btn").addEventListener("click", () => {
      setDateRange(defaultZoomStart);
    });
    title.querySelector(".all-btn").addEventListener("click", () => {
      setDateRange(rows[0].date);
    });
    chart.on("click", params => {
      if (params.componentType !== "xAxis" || !dateIndex.has(params.value)) return;
      chart.dispatchAction({
        type: "showTip", seriesIndex: 0, dataIndex: dateIndex.get(params.value)
      });
    });
  }

  // 第一张图初始化时网格里还只有一张卡片，宽度会暂时占满整行。
  // 所有卡片加入后统一重算，避免SVG沿用旧宽度并溢出到相邻图表。
  resizeAllCharts();

  const mk = (k, v, red) => {
    const c = el("div", "card");
    c.append(el("p", "k", k), el("p", "v" + (red ? " red" : ""), v));
    return c;
  };
  cards.append(
    mk("监控标的", String(watched)),
    mk("低于历史参考线", String(inverted), inverted > 0),
    mk("宽基总份额", coreCount ? fmt(coreSum, 1) + " 亿份" : "—"),
    mk("持仓参考日", conf.baseline_date)
  );
  const freshnessText = latestDate && latestCount === conf.etfs.length
    ? `全部${conf.etfs.length}只ETF已更新至 ${latestDate}`
    : latestDate
      ? `份额更新中：${latestCount}/${conf.etfs.length}只已到 ${latestDate}；全部齐全至 ${completeDate || "—"}`
      : "ETF份额暂无数据";
  document.getElementById("statusline").textContent =
    `${freshnessText} · 持仓参考来源 ${conf.updated_from}（${conf.baseline_date}）` +
    (inverted ? ` · ${inverted}只ETF总份额低于历史参考线，原因要等定期报告确认` : " · 暂无ETF低于历史参考线");

  const signalBox = document.getElementById("etf-signal-summary");
  if (signalBox) {
    const sorted = largeChanges.slice().sort((a, b) =>
      b.date.localeCompare(a.date) || Math.abs(b.delta) - Math.abs(a.delta));
    const rowsHtml = sorted.map(change =>
      `<li><time>${change.date}</time><span>${change.name}</span>` +
      `<strong class="${change.delta > 0 ? "pos" : "neg"}">` +
      `${change.delta > 0 ? "净增" : "净减"}${fmt(Math.abs(change.delta), 1)}亿份</strong></li>`).join("");
    signalBox.innerHTML =
      `<details${sorted.length ? "" : " hidden"}><summary>查看单只ETF百亿份额异动（${sorted.length}条）</summary>` +
      `<ul>${rowsHtml}</ul></details>` +
      `<p class="term">默认显示${DEFAULT_ETF_VIEW_START}至最新；时间轴偏离最新日期时，点图右上角“回到最新”；` +
      `点“全部历史”可查看${monitoringStart}以来的记录。` +
      `510310在2024-09-20发生份额合并，图中已按官方比例换算，不把机械减份额误报为卖出。</p>`;
  }

  // 基线过期提醒(>120天)
  const ageDays = (Date.now() - new Date(conf.baseline_date)) / 864e5;
  if (ageDays > 120) {
    const w = document.getElementById("baseline-warn");
    w.hidden = false;
    w.textContent = `提醒：持仓参考线已 ${Math.floor(ageDays)} 天未更新。` +
      "参考线不是每日持仓；请等待最新基金定期报告后更新，否则比较会失真。";
  }
}

/* ---------- 今日评分 ---------- */
function renderAssessment(data) {
  const wrap = document.getElementById("assessment");
  if (!data || data.market_scope !== "CN") {
    wrap.innerHTML = '<p class="empty">今日评估暂不可用。</p>';
    return;
  }
  wrap.innerHTML = "";
  const scores = data.scorecard;
  if (!scores) {
    wrap.innerHTML = '<p class="empty">评分正在生成，请稍后刷新。</p>';
    return;
  }

  const scoreGrid = el("div", "score-grid");
  const scoreItems = [
    ["market_risk", "风险/卖出警报", "risk"],
    ["repair_readiness", "修复/买入准备度", "repair"],
    ["data_confidence", "数据可信度", "confidence"]
  ];
  for (const [key, label, tone] of scoreItems) {
    const item = scores[key];
    const card = el("article", `score-card ${tone}${item.alert ? " alert" : ""}`);
    const details = (item.components || []).map(component =>
      `<li><span>${component.label}</span><strong>${component.points}/${component.max}</strong>` +
      `<small>${component.detail}</small></li>`).join("");
    card.innerHTML = `<p class="score-label">${label}</p>` +
      `<p class="score-value"><strong>${item.score}</strong><span>/100 · ${item.level}</span></p>` +
      `<div class="score-track"><i style="width:${Math.max(0, Math.min(100, item.score))}%"></i></div>` +
      `<details><summary>查看计算</summary><ul>${details}</ul></details>`;
    scoreGrid.append(card);
  }
  wrap.append(scoreGrid);

  const signal = scores.general_signal;
  const signalCard = el("article", `score-signal ${signal.state}`);
  signalCard.innerHTML = `<p class="verdict-k">当前提示 · 数据截至 ${data.as_of || "—"}</p>` +
    `<h3>${signal.headline}</h3><p>${signal.guidance}</p>` +
    `<p class="boundary">${signal.boundary}</p>`;
  wrap.append(signalCard);
}

/* ---------- 指数 + 政策底/恐慌底标注 ---------- */
async function renderIndexSection() {
  const grid = document.getElementById("index-charts");
  const events = (await fetchJSON("data/bottom_events.json")) || [];
  for (const code of Object.keys(INDEX_META)) {
    const rows = await fetchJSON(`data/index/${code}.json`);
    const box = el("div", "chart-box");
    box.append(el("div", "chart-title", `<span>${INDEX_META[code]} <code>${code}</code></span>`));
    const chartDiv = el("div", "chart tall");
    box.append(chartDiv);
    grid.append(box);
    if (!rows || !rows.length) {
      chartDiv.outerHTML = '<p class="empty" style="margin:12px">暂无指数日线。运行 <code>python scripts/fetch_index_daily.py</code> 回补后自动显示。</p>';
      continue;
    }
    const dateIdx = new Map(rows.map((r, i) => [r.date, i]));
    const nearest = d => { // 事件日若非交易日, 取其后首个交易日
      if (dateIdx.has(d)) return d;
      const later = rows.find(r => r.date > d);
      return later ? later.date : null;
    };
    const markData = events
      .filter(ev => ev.scope.includes(code))
      .map(ev => {
        const d = nearest(ev.date);
        if (!d) return null;
        const s = EVENT_STYLE[ev.type] || EVENT_STYLE.policy;
        return {
          coord: [d, rows[dateIdx.get(d)].close],
          itemStyle: { color: s.color },
          name: `${ev.date} ${ev.title}`,
          value: s.label,
          label: { show: false },
          tooltipText: `${ev.date} · ${s.label}<br>${ev.title}${ev.note ? "<br>" + ev.note : ""}` +
                       (ev.verify ? "<br><i>（日期/点位待核实）</i>" : "")
        };
      }).filter(Boolean);
    const chart = registerChart(echarts.init(chartDiv, null, { renderer: "svg" }));
    chart.setOption(Object.assign(baseChartOpts(), {
      tooltip: {
        trigger: "axis", confine: true,
        formatter: params => {
          const p = params.find(x => x.seriesType === "line");
          let t = p ? `${p.axisValue}<br>收盘 ${fmt(p.data)}` : "";
          return t;
        }
      },
      dataZoom: [{ type: "inside" }, { type: "slider", height: 16, bottom: 4 }],
      xAxis: { type: "category", data: rows.map(r => r.date),
               axisLabel: { color: AXIS, hideOverlap: true },
               axisLine: { lineStyle: { color: GRIDLINE } } },
      yAxis: { type: "value", scale: true,
               axisLabel: { color: AXIS }, splitLine: { lineStyle: { color: GRIDLINE } } },
      series: [{
        type: "line", data: rows.map(r => r.close), showSymbol: false,
        lineStyle: { color: INKLINE, width: 1.4 },
        markPoint: {
          symbol: "circle", symbolSize: 11,
          data: markData,
          tooltip: { formatter: p => p.data.tooltipText }
        }
      }]
    }));
  }
  resizeAllCharts();
}

/* ---------- 事件研究结果 ---------- */
async function renderStudy(assessment) {
  const res = await fetchJSON("data/event_study_results.json");
  if (!res) return;
  const wrap = document.getElementById("study");
  wrap.innerHTML = "";
  const horizons = Object.keys(res.summary || {});
  const historyModel = (assessment && assessment.models || []).find(m => m.id === "history");
  const plain = el("div", "study-plain");
  const twenty = res.summary["20"];
  const wins20 = twenty ? Math.round(twenty.win_rate * twenty.n) : 0;
  plain.innerHTML = `<strong>如何理解：</strong>“20日胜率85.7%”只表示过去${twenty ? twenty.n : 0}次样本中，` +
    `${wins20}次在20个交易日后上涨；<strong>不是</strong>说明下一次有85.7%的确定上涨概率。` +
    `样本只有7次，一个反例就会让比例改变14.3个百分点。60个交易日大约3个月，是当前样本里最弱的窗口。`;
  wrap.append(plain);
  const sum = el("table", "study-table");
  const intervalCells = horizons.map(h => {
    const range = historyModel && historyModel.metrics[h] && historyModel.metrics[h].wilson95;
    return `<td>${range && range[0] !== null ? `${(range[0] * 100).toFixed(1)}%–${(range[1] * 100).toFixed(1)}%` : "—"}</td>`;
  }).join("");
  sum.innerHTML = "<caption>95%区间很宽，说明样本太少。</caption>" +
    "<tr><th>持有期</th>" + horizons.map(h => `<th>${h}日</th>`).join("") + "</tr>" +
    "<tr><td>胜率(样本数)</td>" + horizons.map(h => {
      const s = res.summary[h];
      return `<td>${s.win_rate === null ? "—" : (s.win_rate * 100).toFixed(1) + "%"} (n=${s.n})</td>`;
    }).join("") + `</tr><tr><td>不确定范围(95%)</td>${intervalCells}</tr>`;
  wrap.append(sum);

  const tbl = el("table", "study-table");
  const hasPendingVerification = res.buy_events.some(ev => ev.verify);
  let rows = "<tr><th>干预日</th>" +
    horizons.map(h => `<th>+${h}日</th>`).join("") +
    "<th>之后最深还跌多少</th><th>多久后最低</th></tr>";
  for (const ev of res.buy_events) {
    rows += `<tr><td>${ev.date}${ev.verify ? " *" : ""} ${ev.note}</td>` +
      horizons.map(h => {
        const r = ev.returns[h];
        const cls = r === null ? "" : (r > 0 ? "pos" : "neg");
        return `<td class="${cls}">${pct(r)}</td>`;
      }).join("") +
      `<td class="neg">${pct(ev.max_drawdown)}</td><td>${ev.days_to_trough ?? "—"}</td></tr>`;
  }
  const verificationNote = hasPendingVerification
    ? "* 带星号记录的日期/点位待核实。"
    : "样本日期与点位已按来源复核。";
  tbl.innerHTML = rows + `<caption>${verificationNote}样本量小，且干预往往发生在市场大跌后；历史结果不保证未来。</caption>`;
  wrap.append(tbl);
}

/* ---------- 每日解读 ---------- */
function humanizeComment(md) {
  return md
    .replace(/倒挂\/减持确认/g, "历史参考线提示（需要定期报告确认）")
    .replace(/持续倒挂，确认减持下限/g, "当前仍低于历史参考线，差额")
    .replace(/确认减持下限/g, "待定期报告确认的差额")
    .replace(/新出现倒挂/g, "首次低于历史参考线")
    .replace(/倒挂差额/g, "低于历史参考线的差额")
    .replace(/倒挂/g, "低于历史参考线")
    .replace(/减持下限/g, "待确认差额");
}
function renderCommentMarkdown(md) {
  const escapeHtml = value => value.replace(/[&<>]/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
  const inline = value => escapeHtml(value)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  const out = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) out.push("</ul>");
    listOpen = false;
  };
  for (const raw of humanizeComment(md).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      closeList();
    } else if (line.startsWith("# ")) {
      closeList();
      out.push(`<h3>${inline(line.slice(2))}</h3>`);
    } else if (line.startsWith("- ")) {
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("");
}
async function renderComments() {
  const manifest = await fetchJSON("data/comments/manifest.json");
  if (!manifest || !manifest.length) return;
  const wrap = document.getElementById("comments");
  wrap.innerHTML = "";
  for (const date of manifest.slice(0, 10)) {
    const md = await fetchText(`data/comments/${date}.md`);
    if (!md) continue;
    wrap.append(el("article", "comment", renderCommentMarkdown(md)));
  }
}

(async function init() {
  const conf = await fetchJSON("data/baselines.json");
  if (!conf) {
    document.getElementById("statusline").textContent =
      "无法读取 data/baselines.json —— 请通过 HTTP 服务访问本页（python3 -m http.server），而非直接双击打开文件。";
    return;
  }
  await renderEtfSection(conf);
  const assessment = await fetchJSON("data/daily_assessment.json");
  renderAssessment(assessment);
  await renderIndexSection();
  await renderStudy(assessment);
  await renderComments();
})();
