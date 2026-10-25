"use strict";

async function reportJSON(path) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch (error) { return null; }
}

const reportPct = value => value === null || value === undefined
  ? "—" : `${(Number(value) * 100).toFixed(1)}%`;

(async function renderReport() {
  const [assessment, study] = await Promise.all([
    reportJSON("data/daily_assessment.json"),
    reportJSON("data/event_study_results.json")
  ]);
  const summary = document.getElementById("report-summary");
  if (!assessment || assessment.market_scope !== "CN") {
    summary.innerHTML = '<p class="empty">评估数据暂不可用。</p>';
    return;
  }
  document.getElementById("report-status").textContent =
    `报告数据截至 ${assessment.as_of} · 每日自动更新`;
  const scorecard = assessment.scorecard;
  const scoreItems = [
    ["market_risk", "风险/卖出警报", "risk"],
    ["repair_readiness", "修复/买入准备度", "repair"],
    ["data_confidence", "数据可信度", "confidence"]
  ];
  summary.innerHTML = `<div class="score-grid">${scoreItems.map(([key, label, tone]) => {
    const item = scorecard[key];
    return `<article class="score-card ${tone}${item.alert ? " alert" : ""}">` +
      `<p class="score-label">${label}</p><p class="score-value"><strong>${item.score}</strong>` +
      `<span>/100 · ${item.level}</span></p><div class="score-track"><i style="width:${item.score}%"></i></div>` +
      `<ul>${item.components.map(component => `<li><span>${component.label}</span>` +
      `<strong>${component.points}/${component.max}</strong><small>${component.detail}</small></li>`).join("")}</ul></article>`;
  }).join("")}</div>` +
    `<article class="score-signal ${scorecard.general_signal.state}"><p class="verdict-k">当前提示</p>` +
    `<h3>${scorecard.general_signal.headline}</h3><p>${scorecard.general_signal.guidance}</p>` +
    `<p class="boundary">${scorecard.general_signal.boundary}</p></article>`;

  const history = document.getElementById("report-history");
  if (!study || JSON.stringify(study.markets_included) !== JSON.stringify(["CN"])) {
    history.innerHTML = "<p>历史结果暂不可用。</p>";
    return;
  }
  const historyModel = assessment.models.find(model => model.id === "history");
  const horizons = Object.keys(study.summary || {});
  history.innerHTML = `<div class="table-scroll"><table class="study-table">` +
    `<tr><th>干预后</th>${horizons.map(h => `<th>${h}日</th>`).join("")}</tr>` +
    `<tr><td>上涨次数/样本</td>${horizons.map(h => {
      const item = study.summary[h];
      return `<td>${Math.round(item.win_rate * item.n)}/${item.n}</td>`;
    }).join("")}</tr>` +
    `<tr><td>表面胜率</td>${horizons.map(h => `<td>${reportPct(study.summary[h].win_rate)}</td>`).join("")}</tr>` +
    `<tr><td>95%不确定范围</td>${horizons.map(h => {
      const range = historyModel.metrics[h].wilson95;
      return `<td>${reportPct(range[0])}–${reportPct(range[1])}</td>`;
    }).join("")}</tr></table></div>`;
})();
