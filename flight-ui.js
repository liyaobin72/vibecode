(function () {
  const copy = {
    en: {
      flight: "Round-trip from Toronto", dates: "Dates", nights: "nights", checked: "Checked", updating: "Updating",
      noFare: "No verified fare found", unavailable: "Search temporarily unavailable", expired: "Price expired; open Google Flights to search again",
      open: "Open exact itinerary", airline: "Airline", stops: "Stops", duration: "Journey time", cabin: "Cabin / fare", baggage: "Baggage",
      unknown: "Unknown", nonstop: "Nonstop", stop: "stop", stopsPlural: "stops", outbound: "outbound", return: "return",
      labels: { exceptional_deal: "Exceptional deal", good_deal: "Good deal", fair_price: "Fair price", above_normal: "Above normal" },
    },
    zh: {
      flight: "多伦多出发往返机票", dates: "日期", nights: "晚", checked: "核实于", updating: "更新中",
      noFare: "未找到已核实票价", unavailable: "暂时无法查询", expired: "票价已过期；请打开 Google 航班重新搜索",
      open: "打开准确行程", airline: "航空公司", stops: "中转", duration: "行程时间", cabin: "舱等 / 票价类型", baggage: "行李",
      unknown: "未知", nonstop: "直飞", stop: "次中转", stopsPlural: "次中转", outbound: "去程", return: "回程",
      labels: { exceptional_deal: "超值优惠", good_deal: "优惠票价", fair_price: "价格合理", above_normal: "高于正常价格" },
    },
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function formatDate(value, lang, withYear = false) {
    if (!value) return "";
    const options = { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) };
    return new Date(`${value}T00:00:00`).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-CA", options);
  }

  function formatChecked(timestamp, lang) {
    if (!Number.isFinite(timestamp)) return "";
    return new Date(timestamp * 1000).toLocaleString(lang === "zh" ? "zh-CN" : "en-CA", { dateStyle: "medium", timeStyle: "short" });
  }

  function stopsText(value, lang) {
    const t = copy[lang];
    if (value === 0) return t.nonstop;
    if (!Number.isFinite(value)) return t.unknown;
    return lang === "zh" ? `${value}${t.stop}` : `${value} ${value === 1 ? t.stop : t.stopsPlural}`;
  }

  function statusText(record, lang) {
    const t = copy[lang];
    if (record.status === "expired") return t.expired;
    if (record.status === "updating") return t.updating;
    if (record.status === "temporarily_unavailable") return t.unavailable;
    if (record.status === "no_verified_fare") return t.noFare;
    return "";
  }

  function summary(record, lang) {
    const t = copy[lang];
    const hasVerifiedFare = Number.isFinite(record?.price_cad) && record?.verification_status === "verified";
    if (!hasVerifiedFare) return `<div class="flight-status">${escapeHtml(statusText(record || {}, lang) || t.noFare)}</div>`;
    const destinations = (record.destination_airports || []).join("/");
    const dates = `${formatDate(record.depart_date, lang)} – ${formatDate(record.return_date, lang)}`;
    const checked = formatChecked(record.last_successfully_verified_at || record.verified_at, lang);
    const label = t.labels[record.deal_label];
    const badge = label ? `<span class="deal-badge">${escapeHtml(label)}${Number.isFinite(record.discount_percent) ? ` · ${Math.abs(record.discount_percent)}%` : ""}</span>` : "";
    const state = record.status !== "verified" ? `<span class="flight-state">${escapeHtml(statusText(record, lang))}</span>` : "";
    return `<div class="flight-summary">
      <div class="flight-price">C$${record.price_cad} ${badge}</div>
      <div class="flight-route">${escapeHtml(record.origin_airport || "YYZ")} → ${escapeHtml(destinations)}</div>
      <div class="flight-dates">${escapeHtml(t.dates)}: ${escapeHtml(dates)} · ${record.nights} ${escapeHtml(t.nights)}</div>
      <div class="flight-brief">${escapeHtml(record.airline || t.unknown)} · ${escapeHtml(stopsText(record.stops?.outbound, lang))}</div>
      <div class="flight-checked">${checked ? `${escapeHtml(t.checked)} ${escapeHtml(checked)}` : ""} ${state}</div>
    </div>`;
  }

  function details(record, lang) {
    const t = copy[lang];
    const hasVerifiedFare = Number.isFinite(record?.price_cad) && record?.verification_status === "verified";
    if (!hasVerifiedFare) return `<div class="flight-panel"><p class="flight-status">${escapeHtml(statusText(record || {}, lang) || t.noFare)}</p></div>`;
    const checked = formatChecked(record.last_successfully_verified_at || record.verified_at, lang);
    const url = escapeHtml(record.exact_url || record.url || "");
    const duration = `${t.outbound}: ${record.journey_duration?.outbound || t.unknown}; ${t.return}: ${record.journey_duration?.return || t.unknown}`;
    const stops = `${t.outbound}: ${stopsText(record.stops?.outbound, lang)}; ${t.return}: ${stopsText(record.stops?.return, lang)}`;
    return `<div class="flight-panel ${record.is_deal ? "deal-card" : ""}">
      ${summary(record, lang)}
      <dl class="flight-facts">
        <div><dt>${escapeHtml(t.airline)}</dt><dd>${escapeHtml(record.airline || t.unknown)}</dd></div>
        <div><dt>${escapeHtml(t.stops)}</dt><dd>${escapeHtml(stops)}</dd></div>
        <div><dt>${escapeHtml(t.duration)}</dt><dd>${escapeHtml(duration)}</dd></div>
        <div><dt>${escapeHtml(t.cabin)}</dt><dd>${escapeHtml(record.cabin_fare || t.unknown)}</dd></div>
        <div><dt>${escapeHtml(t.baggage)}</dt><dd>${escapeHtml(record.baggage || t.unknown)}</dd></div>
      </dl>
      ${url ? `<a class="flight-link" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.open)}</a>` : ""}
      ${record.status !== "verified" ? `<p class="flight-state">${escapeHtml(statusText(record, lang))}${checked ? ` · ${escapeHtml(t.checked)} ${escapeHtml(checked)}` : ""}</p>` : ""}
    </div>`;
  }

  window.FlightUI = { copy, details, escapeHtml, formatDate, statusText, summary };
})();
