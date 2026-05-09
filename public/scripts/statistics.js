(function () {
    const API_BASE = "/api/statistics";
    const PAGE_SIZE = 25;
    const CATEGORY_OPTIONS = ["REG", "RV", "RE", "MET", "NCL", "FR", "FA", "FB", "IC", "ICN", "EC", "EN", "EXP", "TS"];

    const state = {
        date: "",
        days: [],
        summary: null,
        timeseries: null,
        activeView: "trains",
        page: 1,
        pageSize: PAGE_SIZE,
        total: 0,
        tableItems: [],
        loading: false,
        tableLoading: false
    };

    const palette = ["#65bfc0", "#5b9ee4", "#ec6685", "#f4b35d", "#83c77f", "#a78bfa", "#f78fb3", "#7dd3fc"];
    const CATEGORY_COLORS = {
        REG: "#70a84a",
        RE: "#70a84a",
        RV: "#70a84a",
        MET: "#70a84a",
        NCL: "#d9dee7",
        FR: "#bc3433",
        FB: "#bc3433",
        FA: "#bc3433",
        IC: "#008ad8",
        ICN: "#008ad8",
        EC: "#3c8149",
        EN: "#3c8149",
        TS: "#827654",
        EXP: "#35556b"
    };

    function tr(key, fallback) {
        const dict = typeof translations !== "undefined" ? translations : window.translations;
        return (dict && dict[window.currentLang] && dict[window.currentLang][key])
            || (dict && dict.en && dict.en[key])
            || fallback
            || key;
    }

    function esc(value) {
        return window.escapeHtml ? window.escapeHtml(value) : String(value ?? "");
    }

    function $(id) {
        return document.getElementById(id);
    }

    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }

    function asNumber(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function pct(value, digits = 1) {
        const num = asNumber(value, 0);
        return `${num.toFixed(digits)}%`;
    }

    function formatNumber(value) {
        return asNumber(value, 0).toLocaleString(window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB");
    }

    function formatMinutes(value) {
        const minutes = asNumber(value, 0);
        return `${minutes.toLocaleString(window.currentLang === "zh" ? "zh-CN" : "en-GB")} ${tr("minutes", "min")}`;
    }

    function categoryCode(value) {
        return String(value || "").trim().toUpperCase();
    }

    function categoryColor(value) {
        return CATEGORY_COLORS[categoryCode(value)] || palette[0];
    }

    function categoryBadgeHtml(value) {
        const cat = categoryCode(value);
        if (!cat || cat === "--") return "--";
        const badgeClass = (window.getBadgeClass ? window.getBadgeClass(cat) : "") || "badge-statistics-fallback";
        return `<span class="train-badge statistics-category-badge ${esc(badgeClass)}">${esc(cat)}</span>`;
    }

    function operatorName(value) {
        const raw = String(value ?? "").trim();
        if (!raw) return "--";
        const map = window.CLIENT_MAP || {};
        const mapped = map[raw] || map[Number(raw)];
        return mapped || raw;
    }

    function buildTrainHref(item) {
        const number = item?.trainNumber || item?.train_number || item?.number || item?.train || "";
        const cleanNumber = String(number).replace(/[^\d]/g, "") || String(number).trim();
        return cleanNumber ? `/?train=${encodeURIComponent(cleanNumber)}` : "";
    }

    function buildStationHref(item) {
        const code = item?.code || item?.stationCode || item?.station_code || item?.id || "";
        const name = item?.name || item?.station || item?.stationName || item?.station_name || "";
        if (!code || !name) return "";
        const params = new URLSearchParams({ id: code, name, type: "partenze" });
        return `/station?${params.toString()}`;
    }

    function todayRome() {
        return new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Europe/Rome",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(new Date());
    }

    function formatDateTime(value) {
        if (!value) return "--";
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return String(value);
        return new Intl.DateTimeFormat(window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB", {
            timeZone: "Europe/Rome",
            dateStyle: "medium",
            timeStyle: "medium"
        }).format(date);
    }

    function getPath(source, paths, fallback = null) {
        for (const path of paths) {
            const value = String(path).split(".").reduce((current, key) => current?.[key], source);
            if (value !== undefined && value !== null && value !== "") return value;
        }
        return fallback;
    }

    function paramsString(params) {
        const search = new URLSearchParams();
        Object.entries(params || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== "") search.set(key, value);
        });
        return search.toString();
    }

    async function fetchJson(path, params = {}) {
        const query = paramsString(params);
        const response = await fetch(`${API_BASE}${path}${query ? `?${query}` : ""}`, {
            headers: { "accept": "application/json" }
        });
        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }
        if (!response.ok || payload?.available === false) {
            const reason = payload?.reason || `http_${response.status}`;
            throw new Error(reason);
        }
        return payload;
    }

    function setStatus(message, kind = "info") {
        const el = $("statisticsStatus");
        if (!el) return;
        if (!message) {
            el.hidden = true;
            el.textContent = "";
            el.className = "statistics-status";
            return;
        }
        el.hidden = false;
        el.className = `statistics-status statistics-status-${kind}`;
        el.textContent = message;
    }

    function setTableStatus(message) {
        const el = $("statisticsTableStatus");
        if (el) el.textContent = message || "";
    }

    function normalizeDays(payload) {
        const raw = asArray(payload?.days || payload);
        return raw.map((item) => typeof item === "string" ? { date: item } : item)
            .filter((item) => item?.date)
            .slice(0, 30);
    }

    function normalizeSummary(payload) {
        return payload?.summary || payload || {};
    }

    function normalizeTimeseries(payload) {
        return payload?.timeseries || payload || {};
    }

    function normalizeItems(payload) {
        const items = asArray(payload?.items || payload?.trains || payload?.stations || payload?.relations || payload?.ranking || payload);
        const total = asNumber(payload?.total || payload?.count || items.length, items.length);
        return { items, total };
    }

    function fillDateSelect() {
        const select = $("statisticsDate");
        if (!select) return;
        const days = state.days.length ? state.days : [{ date: state.date || todayRome() }];
        select.innerHTML = days.map((day) => `
            <option value="${esc(day.date)}"${day.date === state.date ? " selected" : ""}>
                ${esc(day.label || day.date)}${day.finalized ? "" : ` · ${tr("statistics_live", "live")}`}
            </option>
        `).join("");
    }

    function fillCategorySelect() {
        const select = $("statisticsCategory");
        if (!select) return;
        const current = select.value;
        select.innerHTML = `<option value="">${esc(tr("statistics_all_categories", "All categories"))}</option>`
            + CATEGORY_OPTIONS.map((cat) => `<option value="${esc(cat)}">${esc(cat)}</option>`).join("");
        select.value = current;
    }

    function metricCard(id, icon, label, value, note = "") {
        return `
            <div class="statistics-metric" data-stat-metric="${esc(id)}">
                <span class="material-symbols-outlined">${esc(icon)}</span>
                <div>
                    <small>${esc(label)}</small>
                    <strong>${esc(value)}</strong>
                    ${note ? `<em>${esc(note)}</em>` : ""}
                </div>
            </div>
        `;
    }

    function summaryCounts() {
        const summary = state.summary || {};
        const counts = summary.counts || {};
        const punctuality = summary.punctuality || {};
        const delayTotals = summary.delayTotals || summary.delays || {};
        const coverage = summary.coverage || summary.completeness || {};
        const monitored = getPath(summary, ["counts.monitored", "monitored", "trains.monitored"], 0);
        const circulated = getPath(summary, ["counts.circulated", "counts.treniGiorno", "treniGiorno", "circulated"], 0);
        const running = getPath(summary, ["counts.running", "counts.treniCircolanti", "treniCircolanti", "running"], 0);
        const regular = getPath(summary, ["counts.regular", "regular"], 0);
        const delayed = getPath(summary, ["counts.delayed", "delayed"], 0);
        const cancelled = getPath(summary, ["counts.cancelled", "cancelled"], 0);
        const rescheduled = getPath(summary, ["counts.rescheduled", "rescheduled", "counts.reprogrammed"], 0);
        const notDeparted = getPath(summary, ["counts.notDeparted", "notDeparted", "counts.not_departed"], 0);
        const avgDelay = getPath(summary, ["delayTotals.average", "delayTotals.avg", "avgDelay", "averageDelay"], 0);
        const indexedStations = getPath(summary, ["coverage.stations", "stationsIndexed", "stationCount"], null);
        const departureDelayed = getPath(summary, ["punctuality.departure.delayed", "departure.delayed"], 0);
        const departureOnTime = getPath(summary, ["punctuality.departure.onTime", "departure.onTime"], 0);
        const arrivalDelayed = getPath(summary, ["punctuality.arrival.delayed", "arrival.delayed"], 0);
        const arrivalOnTime = getPath(summary, ["punctuality.arrival.onTime", "arrival.onTime"], 0);
        const arrivalEarly = getPath(summary, ["punctuality.arrival.early", "arrival.early"], 0);
        const worstTrain = summary.worstTrain || summary.worst || null;
        return {
            counts,
            punctuality,
            delayTotals,
            coverage,
            monitored,
            circulated,
            running,
            regular,
            delayed,
            cancelled,
            rescheduled,
            notDeparted,
            avgDelay,
            indexedStations,
            departureDelayed,
            departureOnTime,
            arrivalDelayed,
            arrivalOnTime,
            arrivalEarly,
            worstTrain
        };
    }

    function renderMeta() {
        const summary = state.summary || {};
        const values = summaryCounts();
        const lastUpdated = getPath(summary, ["lastUpdated", "ultimoAggiornamento", "updatedAt"], null);
        const cadence = getPath(summary, ["collectionCadenceMinutes", "cadenceMinutes", "samplingMinutes"], null);
        const stationValue = values.indexedStations !== null
            ? formatNumber(values.indexedStations)
            : "--";
        if ($("statisticsLastUpdated")) $("statisticsLastUpdated").textContent = formatDateTime(lastUpdated);
        if ($("statisticsCadence")) $("statisticsCadence").textContent = cadence ? `${cadence} ${tr("minutes", "min")}` : "--";
        if ($("statisticsCoverage")) $("statisticsCoverage").textContent = stationValue;
    }

    function renderMetrics() {
        const el = $("statisticsMetrics");
        if (!el) return;
        const values = summaryCounts();
        const worst = values.worstTrain;
        const worstNumber = worst?.trainNumber || worst?.train_number || worst?.number || worst?.train || "";
        const worstRoute = [worst?.origin, worst?.destination].filter(Boolean).join(" -> ");
        const worstLabel = worst
            ? `${worst.category || ""} ${worstNumber}`.trim() || "--"
            : "--";
        const worstNote = worst
            ? [worstRoute, worst?.delay ? `+${worst.delay} ${tr("minutes", "min")}` : ""].filter(Boolean).join(" - ")
            : "";
        el.innerHTML = [
            metricCard("running", "directions_railway", tr("statistics_running_now", "Running now"), formatNumber(values.running)),
            metricCard("circulated", "today", tr("statistics_circulated_today", "Operated today"), formatNumber(values.circulated)),
            metricCard("monitored", "visibility", tr("statistics_monitored", "Monitored"), formatNumber(values.monitored)),
            metricCard("regular", "verified", tr("statistics_regular", "Regular"), formatNumber(values.regular)),
            metricCard("cancelled", "cancel", tr("statistics_cancelled", "Cancelled"), formatNumber(values.cancelled)),
            metricCard("rescheduled", "published_with_changes", tr("statistics_rescheduled", "Rescheduled"), formatNumber(values.rescheduled)),
            metricCard("avg_delay", "timer", tr("statistics_avg_delay", "Average delay"), formatMinutes(values.avgDelay)),
            metricCard("worst", "warning", tr("statistics_worst_train", "Worst train"), worstLabel, worstNote)
        ].join("");
    }

    function emptyChart(message = tr("statistics_no_chart_data", "No chart data")) {
        return `<div class="statistics-empty-chart">${esc(message)}</div>`;
    }

    function pointValue(point) {
        return asNumber(point.value ?? point.running ?? point.treniCircolanti ?? point.count ?? point.y, 0);
    }

    function pointLabel(point) {
        const raw = point.label || point.time || point.timestamp || point.x || "";
        if (!raw) return "";
        const date = new Date(raw);
        if (Number.isFinite(date.getTime())) {
            return new Intl.DateTimeFormat(window.currentLang === "it" ? "it-IT" : "en-GB", {
                timeZone: "Europe/Rome",
                hour: "2-digit",
                minute: "2-digit"
            }).format(date);
        }
        return String(raw);
    }

    function renderLineChart(points) {
        const data = asArray(points).filter(Boolean);
        if (!data.length) return emptyChart();
        const values = data.map(pointValue);
        const max = Math.max(...values, 1);
        const width = 680;
        const height = 260;
        const pad = 28;
        const step = data.length > 1 ? (width - pad * 2) / (data.length - 1) : 0;
        const coords = data.map((point, index) => {
            const x = pad + step * index;
            const y = height - pad - (pointValue(point) / max) * (height - pad * 2);
            return [x, y];
        });
        const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
        const ticks = data.filter((_, index) => index === 0 || index === data.length - 1 || index % Math.ceil(data.length / 6) === 0);
        return `
            <svg class="statistics-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(tr("statistics_chart_running", "Trains in circulation"))}">
                <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" />
                <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" />
                <polygon points="${area}" />
                <polyline points="${line}" />
                ${coords.map(([x, y], index) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${esc(pointLabel(data[index]))}: ${esc(pointValue(data[index]))}</title></circle>`).join("")}
                <text x="${pad}" y="${pad - 8}">${esc(formatNumber(max))}</text>
                ${ticks.map((point, index) => {
                    const x = pad + step * data.indexOf(point);
                    return `<text x="${x.toFixed(1)}" y="${height - 5}" text-anchor="${index === 0 ? "start" : "middle"}">${esc(pointLabel(point))}</text>`;
                }).join("")}
            </svg>
        `;
    }

    function renderDonut(segments, title) {
        const filtered = segments.filter((segment) => asNumber(segment.value) > 0);
        if (!filtered.length) return emptyChart();
        const total = filtered.reduce((sum, item) => sum + asNumber(item.value), 0);
        let cursor = 0;
        const gradient = filtered.map((item, index) => {
            const start = cursor;
            const end = cursor + (asNumber(item.value) / total) * 100;
            cursor = end;
            return `${item.color || palette[index % palette.length]} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
        }).join(", ");
        return `
            <div class="statistics-donut-wrap">
                <div class="statistics-donut" style="background: conic-gradient(${gradient})">
                    <div><strong>${esc(formatNumber(total))}</strong><span>${esc(title)}</span></div>
                </div>
                <div class="statistics-legend">
                    ${filtered.map((item, index) => `
                        <div><span style="background:${esc(item.color || palette[index % palette.length])}"></span><b>${esc(item.label)}</b><em>${esc(formatNumber(item.value))} · ${esc(pct((asNumber(item.value) / total) * 100))}</em></div>
                    `).join("")}
                </div>
            </div>
        `;
    }

    function renderCategoryChart(categories) {
        const data = asArray(categories).map((item) => ({
            label: item.label || item.category || item.name || item.code || "--",
            value: asNumber(item.value ?? item.count ?? item.total, 0)
        })).filter((item) => item.value > 0);
        if (!data.length) return emptyChart();
        const max = Math.max(...data.map((item) => item.value), 1);
        return `
            <div class="statistics-bars">
                ${data.slice(0, 10).map((item) => `
                    <div class="statistics-bar-row">
                        <span>${categoryBadgeHtml(item.label)}</span>
                        <div><i style="width:${Math.max(2, (item.value / max) * 100)}%;background:${esc(categoryColor(item.label))}"></i></div>
                        <strong>${esc(formatNumber(item.value))}</strong>
                    </div>
                `).join("")}
            </div>
        `;
    }

    function renderCharts() {
        const summary = state.summary || {};
        const values = summaryCounts();
        const series = normalizeTimeseries(state.timeseries);
        const runningPoints = asArray(series.points || series.running || series.trains || series.treniCircolanti);
        if ($("statisticsRunningChart")) $("statisticsRunningChart").innerHTML = renderLineChart(runningPoints);
        if ($("statisticsRegularityChart")) {
            $("statisticsRegularityChart").innerHTML = renderDonut([
                { label: tr("statistics_regular", "Regular"), value: values.regular, color: "#65bfc0" },
                { label: tr("statistics_status_delayed", "Delayed"), value: values.delayed, color: "#5b9ee4" },
                { label: tr("statistics_rescheduled", "Rescheduled"), value: values.rescheduled, color: "#f4b35d" },
                { label: tr("statistics_cancelled", "Cancelled"), value: values.cancelled, color: "#ec6685" }
            ], tr("statistics_trains", "trains"));
        }
        if ($("statisticsPunctualityChart")) {
            $("statisticsPunctualityChart").innerHTML = `
                <div class="statistics-dual-donut">
                    <div>
                        <h3>${esc(tr("statistics_departure_punctuality", "Departure punctuality"))}</h3>
                        ${renderDonut([
                            { label: tr("on_time", "On Time"), value: values.departureOnTime, color: "#65bfc0" },
                            { label: tr("statistics_status_delayed", "Delayed"), value: values.departureDelayed, color: "#ec6685" }
                        ], tr("departures", "Departures"))}
                    </div>
                    <div>
                        <h3>${esc(tr("statistics_arrival_punctuality", "Arrival punctuality"))}</h3>
                        ${renderDonut([
                            { label: tr("statistics_early", "Early"), value: values.arrivalEarly, color: "#5b9ee4" },
                            { label: tr("on_time", "On Time"), value: values.arrivalOnTime, color: "#65bfc0" },
                            { label: tr("statistics_status_delayed", "Delayed"), value: values.arrivalDelayed, color: "#ec6685" }
                        ], tr("arrivals", "Arrivals"))}
                    </div>
                </div>
            `;
        }
        if ($("statisticsCategoryChart")) {
            $("statisticsCategoryChart").innerHTML = renderCategoryChart(summary.categories || summary.categoryCounts || []);
        }
    }

    function renderAll() {
        fillDateSelect();
        fillCategorySelect();
        renderMeta();
        renderMetrics();
        renderCharts();
        renderTable();
    }

    function setActiveView(view, shouldLoad = true) {
        state.activeView = view;
        state.page = 1;
        document.querySelectorAll(".statistics-tab").forEach((tab) => {
            tab.classList.toggle("active", tab.dataset.statView === view);
        });
        const category = $("statisticsCategory");
        const status = $("statisticsStatusFilter");
        const metric = $("statisticsRankingMetric");
        if (category) category.style.display = view === "trains" ? "" : "none";
        if (status) status.style.display = view === "trains" ? "" : "none";
        if (metric) metric.style.display = view === "ranking" ? "" : "none";
        if (shouldLoad) loadTable();
    }

    function queryValue() {
        return $("statisticsSearch")?.value.trim() || "";
    }

    function relationParams(query) {
        const parts = query.split(/\s*(?:->|→|-|–|—|>)\s*/).map((item) => item.trim()).filter(Boolean);
        return parts.length >= 2 ? { from: parts[0], to: parts.slice(1).join(" ") } : { q: query };
    }

    async function loadTable() {
        if (!state.date) return;
        state.tableLoading = true;
        setTableStatus(tr("loading", "Loading..."));
        renderTable();
        const q = queryValue();
        const category = $("statisticsCategory")?.value || "";
        const status = $("statisticsStatusFilter")?.value || "";
        const metric = $("statisticsRankingMetric")?.value || "delay";
        let path = "/trains";
        let params = { date: state.date, page: state.page, pageSize: state.pageSize };

        if (state.activeView === "trains") {
            params = { ...params, q, category, status };
        } else if (state.activeView === "stations") {
            path = q ? "/stations/search" : "/stations/search";
            params = { q, date: state.date, page: state.page, pageSize: state.pageSize };
        } else if (state.activeView === "relations") {
            path = "/relations";
            params = { date: state.date, ...relationParams(q), page: state.page, pageSize: state.pageSize };
        } else if (state.activeView === "ranking") {
            path = "/ranking";
            params = { date: state.date, metric, limit: state.pageSize };
        }

        try {
            const payload = await fetchJson(path, params);
            const normalized = normalizeItems(payload);
            state.tableItems = normalized.items;
            state.total = normalized.total;
            setTableStatus("");
        } catch (error) {
            state.tableItems = [];
            state.total = 0;
            setTableStatus(reasonMessage(error.message));
        } finally {
            state.tableLoading = false;
            renderTable();
        }
    }

    function reasonMessage(reason) {
        if (reason === "not_configured") return tr("statistics_not_configured", "Statistics API is not configured yet.");
        if (reason === "forbidden") return tr("statistics_forbidden", "Statistics API access denied.");
        if (reason === "upstream_error") return tr("statistics_upstream_error", "Statistics service is unavailable.");
        return tr("load_error", "Failed to load, please try again later");
    }

    function tableColumns() {
        if (state.activeView === "stations") {
            return [
                ["station", tr("statistics_station", "Station")],
                ["code", tr("statistics_code", "Code")],
                ["monitored", tr("statistics_monitored", "Monitored")],
                ["avgDelay", tr("statistics_avg_delay", "Average delay")]
            ];
        }
        if (state.activeView === "relations") {
            return [
                ["relation", tr("statistics_relation", "Relation")],
                ["monitored", tr("statistics_monitored", "Monitored")],
                ["cancelled", tr("statistics_cancelled", "Cancelled")],
                ["avgDelay", tr("statistics_avg_delay", "Average delay")]
            ];
        }
        if (state.activeView === "ranking") {
            return [
                ["rank", "#"],
                ["train", tr("train", "Train")],
                ["route", tr("statistics_route", "Route")],
                ["delay", tr("statistics_delay", "Delay")],
                ["status", tr("status", "Status")]
            ];
        }
        return [
            ["train", tr("train", "Train")],
            ["route", tr("statistics_route", "Route")],
            ["category", tr("statistics_category", "Category")],
            ["operator", tr("statistics_operator", "Operator")],
            ["delay", tr("statistics_delay", "Delay")],
            ["status", tr("status", "Status")]
        ];
    }

    function itemValue(item, column, index) {
        if (column === "rank") return String(index + 1 + (state.page - 1) * state.pageSize);
        if (column === "train") return `${item.category || item.trainCategory || ""} ${item.trainNumber || item.number || item.train || ""}`.trim() || "--";
        if (column === "route") return item.route || [item.origin || item.from, item.destination || item.to].filter(Boolean).join(" → ") || "--";
        if (column === "station") return item.name || item.station || item.stationName || "--";
        if (column === "code") return item.code || item.stationCode || item.id || "--";
        if (column === "relation") return item.relation || [item.from, item.to].filter(Boolean).join(" → ") || "--";
        if (column === "category") return item.category || item.trainCategory || "--";
        if (column === "operator") return operatorName(item.operator || item.client);
        if (column === "delay") return formatMinutes(item.delay ?? item.totalDelay ?? item.arrivalDelay ?? item.departureDelay);
        if (column === "avgDelay") return formatMinutes(item.avgDelay ?? item.averageDelay ?? item.delayAverage);
        if (column === "monitored") return formatNumber(item.monitored ?? item.count ?? item.total);
        if (column === "cancelled") return formatNumber(item.cancelled);
        if (column === "status") return statusLabel(item.status || item.state || (item.notDeparted ? "not_departed" : item.cancelled ? "cancelled" : item.delay > 5 ? "delayed" : "regular"));
        return item[column] ?? "--";
    }

    function itemCellHtml(item, column, index) {
        const value = itemValue(item, column, index);
        if (column === "train") {
            const href = buildTrainHref(item);
            return href ? `<a class="statistics-table-link" href="${esc(href)}">${esc(value)}</a>` : esc(value);
        }
        if (column === "station") {
            const href = buildStationHref(item);
            return href ? `<a class="statistics-table-link" href="${esc(href)}">${esc(value)}</a>` : esc(value);
        }
        if (column === "category") return categoryBadgeHtml(value);
        return esc(value);
    }

    function statusLabel(status) {
        const normalized = String(status || "").toLowerCase();
        if (normalized.includes("cancel")) return tr("statistics_status_cancelled", "Cancelled");
        if (normalized.includes("not_departed") || normalized.includes("not departed") || normalized.includes("non_partito") || normalized.includes("nonpartito")) return tr("statistics_status_not_departed", tr("not_departed", "Not Departed"));
        if (normalized.includes("resched") || normalized.includes("ripro")) return tr("statistics_status_rescheduled", "Rescheduled");
        if (normalized.includes("delay") || normalized.includes("ritard")) return tr("statistics_status_delayed", "Delayed");
        return tr("statistics_status_regular", "Regular");
    }

    function renderTable() {
        const head = $("statisticsTableHead");
        const body = $("statisticsTableBody");
        if (!head || !body) return;
        const columns = tableColumns();
        head.innerHTML = `<tr>${columns.map(([, label]) => `<th>${esc(label)}</th>`).join("")}</tr>`;

        if (state.tableLoading) {
            body.innerHTML = `<tr><td colspan="${columns.length}">${esc(tr("loading", "Loading..."))}</td></tr>`;
        } else if (!state.tableItems.length) {
            body.innerHTML = `<tr><td colspan="${columns.length}">${esc(tr("statistics_no_rows", "No rows available"))}</td></tr>`;
        } else {
            body.innerHTML = state.tableItems.map((item, index) => `
                <tr>${columns.map(([column]) => `<td>${itemCellHtml(item, column, index)}</td>`).join("")}</tr>
            `).join("");
        }

        const pageInfo = $("statisticsPageInfo");
        const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
        if (pageInfo) {
            const totalLabel = tr("statistics_table_total", "total");
            pageInfo.textContent = `${state.page} / ${totalPages} · ${totalLabel} ${formatNumber(state.total)}`;
        }
        if ($("statisticsPrev")) $("statisticsPrev").disabled = state.page <= 1 || state.tableLoading;
        if ($("statisticsNext")) $("statisticsNext").disabled = state.page >= totalPages || state.tableLoading || state.activeView === "ranking";
    }

    async function loadCore() {
        state.loading = true;
        setStatus(tr("statistics_loading", "Loading statistics..."), "info");
        try {
            const daysPayload = await fetchJson("/days", { limit: 30 });
            state.days = normalizeDays(daysPayload);
            state.date = state.date || state.days[0]?.date || todayRome();
            fillDateSelect();
        } catch (error) {
            state.days = [{ date: state.date || todayRome(), label: state.date || todayRome() }];
            state.date = state.date || todayRome();
            fillDateSelect();
            setStatus(reasonMessage(error.message), "warning");
        }

        try {
            const [summary, timeseries] = await Promise.all([
                fetchJson("/summary", { date: state.date }),
                fetchJson("/timeseries", { date: state.date }).catch(() => ({}))
            ]);
            state.summary = normalizeSummary(summary);
            state.timeseries = normalizeTimeseries(timeseries);
            setStatus("");
        } catch (error) {
            state.summary = null;
            state.timeseries = null;
            setStatus(reasonMessage(error.message), "warning");
        } finally {
            state.loading = false;
            renderAll();
            loadTable();
        }
    }

    function downloadCsv() {
        if (!state.date) return;
        const view = state.activeView === "ranking" ? "trains" : state.activeView;
        const query = paramsString({
            date: state.date,
            view,
            q: queryValue(),
            category: $("statisticsCategory")?.value || "",
            status: $("statisticsStatusFilter")?.value || ""
        });
        window.location.href = `${API_BASE}/export.csv?${query}`;
    }

    function debounce(fn, delay = 350) {
        let timer = null;
        return (...args) => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => fn(...args), delay);
        };
    }

    function bindEvents() {
        $("statisticsRefresh")?.addEventListener("click", () => loadCore());
        $("statisticsDate")?.addEventListener("change", (event) => {
            state.date = event.target.value;
            state.page = 1;
            loadCore();
        });
        document.querySelectorAll(".statistics-tab").forEach((tab) => {
            tab.addEventListener("click", () => setActiveView(tab.dataset.statView || "trains"));
        });
        const reloadTable = debounce(() => {
            state.page = 1;
            loadTable();
        });
        $("statisticsSearch")?.addEventListener("input", reloadTable);
        $("statisticsCategory")?.addEventListener("change", reloadTable);
        $("statisticsStatusFilter")?.addEventListener("change", reloadTable);
        $("statisticsRankingMetric")?.addEventListener("change", reloadTable);
        $("statisticsCsv")?.addEventListener("click", downloadCsv);
        $("statisticsPrev")?.addEventListener("click", () => {
            if (state.page <= 1) return;
            state.page -= 1;
            loadTable();
        });
        $("statisticsNext")?.addEventListener("click", () => {
            const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
            if (state.page >= totalPages) return;
            state.page += 1;
            loadTable();
        });
    }

    function initStatisticsPage() {
        if (!$("statisticsMetrics")) return;
        state.date = todayRome();
        bindEvents();
        fillCategorySelect();
        setActiveView("trains", false);
        loadCore();
    }

    window.onLanguageChanged = () => {
        if (!$("statisticsMetrics")) return;
        renderAll();
    };

    document.addEventListener("astro:page-load", initStatisticsPage);
})();
