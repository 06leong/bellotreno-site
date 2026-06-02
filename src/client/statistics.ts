export {};

(function () {
    type StatisticsView = "trains" | "stations" | "relations" | "ranking";
    type StatusKind = "info" | "warning";
    type JsonRecord = Record<string, unknown>;
    type QueryParamValue = string | number | boolean | null | undefined;
    type QueryParams = Record<string, QueryParamValue>;
    type TableColumn = "rank" | "train" | "route" | "category" | "operator" | "delay" | "status" | "station" | "code" | "relation" | "monitored" | "avgDelay" | "cancelled";
    type TableColumnDefinition = readonly [TableColumn, string];
    type VoidFunctionWithArgs<T extends unknown[]> = (...args: T) => void;

    interface StatisticsDay extends JsonRecord {
        date: string;
        label?: string;
        finalized?: boolean;
    }

    interface StatisticsTableItem extends JsonRecord {
        arrivalDelay?: number;
        averageDelay?: number;
        avgDelay?: number;
        cancelled?: boolean | number;
        category?: string;
        client?: string | number;
        code?: string;
        count?: number;
        delay?: number;
        delayAverage?: number;
        departureDelay?: number;
        destination?: string;
        from?: string;
        id?: string;
        monitored?: number;
        name?: string;
        notDeparted?: boolean;
        number?: string | number;
        operator?: string | number;
        origin?: string;
        relation?: string;
        route?: string;
        state?: string;
        station?: string;
        stationCode?: string;
        stationName?: string;
        status?: string;
        to?: string;
        total?: number;
        totalDelay?: number;
        train?: string | number;
        trainCategory?: string;
        trainNumber?: string | number;
    }

    interface StatisticsState {
        activeView: StatisticsView;
        date: string;
        days: StatisticsDay[];
        loading: boolean;
        page: number;
        pageSize: number;
        summary: JsonRecord | null;
        tableItems: StatisticsTableItem[];
        tableLoading: boolean;
        timeseries: JsonRecord | null;
        total: number;
    }

    interface ChartDatum extends JsonRecord {
        category?: string;
        code?: string;
        color?: string;
        count?: number;
        label?: string;
        name?: string;
        running?: number;
        time?: string;
        timestamp?: string;
        total?: number;
        treniCircolanti?: number;
        value?: number;
        x?: string;
        y?: number;
    }

    interface DonutSegment {
        color?: string;
        label: string;
        value: number;
    }

    interface SummaryCounts {
        arrivalDelayed: number;
        arrivalEarly: number;
        arrivalOnTime: number;
        avgDelay: number;
        cancelled: number;
        circulated: number;
        counts: JsonRecord;
        coverage: JsonRecord;
        delayed: number;
        delayTotals: JsonRecord;
        departureDelayed: number;
        departureOnTime: number;
        indexedStations: number | null;
        monitored: number;
        notDeparted: number;
        punctuality: JsonRecord;
        regular: number;
        rescheduled: number;
        running: number;
        worstTrain: StatisticsTableItem | null;
    }

    const API_BASE = "/api/statistics";
    const PAGE_SIZE = 25;
    const CATEGORY_ORDER = ["REG", "MET", "FR", "EC FR", "FA", "FB", "IC", "ICN", "EC", "EN", "EXP", "NCL", "IR", "TS"];
    const CATEGORY_OPTIONS = [...CATEGORY_ORDER];

    const state: StatisticsState = {
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
        "EC FR": "#bc3433",
        FB: "#bc3433",
        FA: "#bc3433",
        IC: "#008ad8",
        ICN: "#008ad8",
        EC: "#3c8149",
        EN: "#3c8149",
        TS: "#827654",
        EXP: "#35556b",
        IR: "#69737f"
    };

    function tr(key: string, fallback?: string): string {
        const dict = window.translations;
        return (dict && dict[window.currentLang] && dict[window.currentLang][key])
            || (dict && dict.en && dict.en[key])
            || fallback
            || key;
    }

    function esc(value: unknown): string {
        return window.escapeHtml ? window.escapeHtml(value) : String(value ?? "");
    }

    function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
        return document.getElementById(id) as T | null;
    }

    function asRecord(value: unknown): JsonRecord {
        return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
    }

    function asArray(value: unknown): JsonRecord[] {
        return Array.isArray(value) ? value.filter((item): item is JsonRecord => item !== null && typeof item === "object") : [];
    }

    function asNumber(value: unknown, fallback = 0): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function asString(value: unknown, fallback = ""): string {
        if (value === undefined || value === null) return fallback;
        return String(value);
    }

    function errorReason(error: unknown): string {
        return error instanceof Error ? error.message : asString(error);
    }

    function pct(value: unknown, digits = 1): string {
        const num = asNumber(value, 0);
        return `${num.toFixed(digits)}%`;
    }

    function formatNumber(value: unknown): string {
        return asNumber(value, 0).toLocaleString(window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB");
    }

    function formatMinutes(value: unknown): string {
        const minutes = asNumber(value, 0);
        return `${minutes.toLocaleString(window.currentLang === "zh" ? "zh-CN" : "en-GB")} ${tr("minutes", "min")}`;
    }

    function categoryCode(value: unknown): string {
        const raw = String(value || "").trim().toUpperCase();
        if (!raw) return "";
        if (raw === "ECFR" || raw.replace(/[-_]+/g, " ") === "EC FR") return "EC FR";
        return raw;
    }

    function chartCategoryCode(value: unknown): string {
        const cat = categoryCode(value);
        if (cat === "RV" || cat === "RE") return "REG";
        return cat;
    }

    function categoryColor(value: unknown): string {
        return CATEGORY_COLORS[categoryCode(value)] || palette[0];
    }

    function categorySortIndex(value: unknown): number {
        const index = CATEGORY_ORDER.indexOf(categoryCode(value));
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    }

    function categoryBadgeHtml(value: unknown): string {
        const cat = categoryCode(value);
        if (!cat || cat === "--") return "--";
        const badgeKey = cat === "EC FR" ? "FR" : cat;
        const badgeClass = (window.getBadgeClass ? window.getBadgeClass(badgeKey) : "") || "badge-statistics-fallback";
        return `<span class="train-badge statistics-category-badge ${esc(badgeClass)}">${esc(cat)}</span>`;
    }

    function categoryBadgeElement(value: unknown): Text | HTMLSpanElement {
        const cat = categoryCode(value);
        if (!cat || cat === "--") return document.createTextNode("--");
        const badgeKey = cat === "EC FR" ? "FR" : cat;
        const badgeClass = (window.getBadgeClass ? window.getBadgeClass(badgeKey) : "") || "badge-statistics-fallback";
        const badge = document.createElement("span");
        badge.classList.add("train-badge", "statistics-category-badge");
        String(badgeClass).split(/\s+/).filter(Boolean).forEach((className) => badge.classList.add(className));
        badge.textContent = cat;
        return badge;
    }

    function operatorName(value: unknown): string {
        const raw = String(value ?? "").trim();
        if (!raw) return "--";
        const map = window.CLIENT_MAP || {};
        const mapped = map[raw] || map[Number(raw)];
        return mapped || raw;
    }

    function buildTrainHref(item: StatisticsTableItem): string {
        const number = item?.trainNumber || item?.train_number || item?.number || item?.train || "";
        const cleanNumber = String(number).replace(/[^\d]/g, "") || String(number).trim();
        return cleanNumber ? `/?train=${encodeURIComponent(cleanNumber)}` : "";
    }

    function buildStationHref(item: StatisticsTableItem): string {
        const code = asString(item?.code || item?.stationCode || item?.station_code || item?.id);
        const name = asString(item?.name || item?.station || item?.stationName || item?.station_name);
        if (!code || !name) return "";
        const params = new URLSearchParams({ id: code, name, type: "partenze" });
        return `/station?${params.toString()}`;
    }

    function todayRome(): string {
        return new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Europe/Rome",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(new Date());
    }

    function formatDateTime(value: unknown): string {
        if (!value) return "--";
        const raw = value instanceof Date || typeof value === "string" || typeof value === "number"
            ? value
            : asString(value);
        const date = new Date(raw);
        if (!Number.isFinite(date.getTime())) return asString(value);
        return new Intl.DateTimeFormat(window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB", {
            timeZone: "Europe/Rome",
            dateStyle: "medium",
            timeStyle: "medium"
        }).format(date);
    }

    function getPath(source: JsonRecord | null | undefined, paths: string[], fallback: unknown = null): unknown {
        for (const path of paths) {
            const value = String(path).split(".").reduce<unknown>((current, key) => asRecord(current)[key], source);
            if (value !== undefined && value !== null && value !== "") return value;
        }
        return fallback;
    }

    function paramsString(params: QueryParams): string {
        const search = new URLSearchParams();
        Object.entries(params || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
        });
        return search.toString();
    }

    async function fetchJson(path: string, params: QueryParams = {}): Promise<unknown> {
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

    function setStatus(message: string, kind: StatusKind = "info"): void {
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

    function setTableStatus(message: string): void {
        const el = $("statisticsTableStatus");
        if (el) el.textContent = message || "";
    }

    function normalizeDays(payload: unknown): StatisticsDay[] {
        const record = asRecord(payload);
        const raw = Array.isArray(record.days) ? record.days : Array.isArray(payload) ? payload : [];
        return raw.map((item) => typeof item === "string" ? { date: item } : asRecord(item))
            .filter((item): item is StatisticsDay => typeof item.date === "string" && item.date.length > 0)
            .slice(0, 30);
    }

    function normalizeSummary(payload: unknown): JsonRecord {
        const record = asRecord(payload);
        return asRecord(record.summary || record);
    }

    function normalizeTimeseries(payload: unknown): JsonRecord {
        const record = asRecord(payload);
        return asRecord(record.timeseries || record);
    }

    function normalizeItems(payload: unknown): { items: StatisticsTableItem[]; total: number } {
        const record = asRecord(payload);
        const items = asArray(record.items || record.trains || record.stations || record.relations || record.ranking || payload) as StatisticsTableItem[];
        const total = asNumber(record.total || record.count || items.length, items.length);
        return { items, total };
    }

    function fillDateSelect(): void {
        const select = $<HTMLSelectElement>("statisticsDate");
        if (!select) return;
        const days = state.days.length ? state.days : [{ date: state.date || todayRome() }];
        select.innerHTML = days.map((day) => `
            <option value="${esc(day.date)}"${day.date === state.date ? " selected" : ""}>
                ${esc(day.label || day.date)}${day.finalized ? "" : ` - ${tr("statistics_live", "live")}`}
            </option>
        `).join("");
    }

    function fillCategorySelect(): void {
        const select = $<HTMLSelectElement>("statisticsCategory");
        if (!select) return;
        const current = select.value;
        select.innerHTML = `<option value="">${esc(tr("statistics_all_categories", "All categories"))}</option>`
            + CATEGORY_OPTIONS.map((cat) => `<option value="${esc(cat)}">${esc(cat)}</option>`).join("");
        select.value = current;
    }

    function metricCard(id: string, icon: string, label: string, value: string, note = ""): string {
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

    function summaryCounts(): SummaryCounts {
        const summary = state.summary || {};
        const counts = asRecord(summary.counts);
        const punctuality = asRecord(summary.punctuality);
        const delayTotals = asRecord(summary.delayTotals || summary.delays);
        const coverage = asRecord(summary.coverage || summary.completeness);
        const monitored = asNumber(getPath(summary, ["counts.monitored", "monitored", "trains.monitored"], 0));
        const circulated = asNumber(getPath(summary, ["counts.circulated", "counts.treniGiorno", "treniGiorno", "circulated"], 0));
        const running = asNumber(getPath(summary, ["counts.running", "counts.treniCircolanti", "treniCircolanti", "running"], 0));
        const regular = asNumber(getPath(summary, ["counts.regular", "regular"], 0));
        const delayed = asNumber(getPath(summary, ["counts.delayed", "delayed"], 0));
        const cancelled = asNumber(getPath(summary, ["counts.cancelled", "cancelled"], 0));
        const rescheduled = asNumber(getPath(summary, ["counts.rescheduled", "rescheduled", "counts.reprogrammed"], 0));
        const notDeparted = asNumber(getPath(summary, ["counts.notDeparted", "notDeparted", "counts.not_departed"], 0));
        const avgDelay = asNumber(getPath(summary, ["delayTotals.average", "delayTotals.avg", "avgDelay", "averageDelay"], 0));
        const indexedStationsRaw = getPath(summary, ["coverage.stations", "stationsIndexed", "stationCount"], null);
        const indexedStations = indexedStationsRaw === null ? null : asNumber(indexedStationsRaw);
        const departureDelayed = asNumber(getPath(summary, ["punctuality.departure.delayed", "departure.delayed"], 0));
        const departureOnTime = asNumber(getPath(summary, ["punctuality.departure.onTime", "departure.onTime"], 0));
        const arrivalDelayed = asNumber(getPath(summary, ["punctuality.arrival.delayed", "arrival.delayed"], 0));
        const arrivalOnTime = asNumber(getPath(summary, ["punctuality.arrival.onTime", "arrival.onTime"], 0));
        const arrivalEarly = asNumber(getPath(summary, ["punctuality.arrival.early", "arrival.early"], 0));
        const worstTrainRecord = asRecord(summary.worstTrain || summary.worst);
        const worstTrain = Object.keys(worstTrainRecord).length ? worstTrainRecord as StatisticsTableItem : null;
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

    function renderMeta(): void {
        const summary = state.summary || {};
        const values = summaryCounts();
        const completedAt = getPath(summary, ["collectionCompletedAt", "lastUpdated", "ultimoAggiornamento", "updatedAt"], null);
        const snapshotAt = getPath(summary, ["snapshotTime", "capturedAt", "captured_at"], null);
        const nextScheduledAt = getPath(summary, ["nextScheduledAt"], null);
        const cadence = getPath(summary, ["collectionCadenceMinutes", "cadenceMinutes", "samplingMinutes"], null);
        const stationValue = values.indexedStations !== null
            ? formatNumber(values.indexedStations)
            : "--";
        const lastUpdatedEl = $("statisticsLastUpdated");
        if (lastUpdatedEl) {
            lastUpdatedEl.textContent = formatDateTime(completedAt);
            lastUpdatedEl.title = snapshotAt
                ? `${tr("statistics_snapshot_time", "Snapshot time")}: ${formatDateTime(snapshotAt)}`
                : "";
        }
        const cadenceEl = $("statisticsCadence");
        if (cadenceEl) {
            cadenceEl.textContent = cadence ? `${cadence} ${tr("minutes", "min")} - ${tr("statistics_fixed_schedule", "fixed slots")}` : "--";
            cadenceEl.title = nextScheduledAt
                ? `${tr("statistics_next_run", "Next scheduled run")}: ${formatDateTime(nextScheduledAt)}`
                : "";
        }
        const coverageEl = $("statisticsCoverage");
        if (coverageEl) coverageEl.textContent = stationValue;
    }

    function renderMetrics(): void {
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

    function emptyChart(message = tr("statistics_no_chart_data", "No chart data")): string {
        return `<div class="statistics-empty-chart">${esc(message)}</div>`;
    }

    function pointValue(point: JsonRecord): number {
        return asNumber(point.value ?? point.running ?? point.treniCircolanti ?? point.count ?? point.y, 0);
    }

    function pointLabel(point: JsonRecord): string {
        const raw = asString(point.label || point.time || point.timestamp || point.x);
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

    function renderLineChart(points: unknown): string {
        const data = asArray(points).filter(Boolean);
        if (!data.length) return emptyChart();
        const values = data.map(pointValue);
        const max = Math.max(...values, 1);
        const width = 680;
        const height = 260;
        const padLeft = 52;
        const padRight = 26;
        const padTop = 24;
        const padBottom = 34;
        const plotWidth = width - padLeft - padRight;
        const plotHeight = height - padTop - padBottom;
        const step = data.length > 1 ? plotWidth / (data.length - 1) : 0;
        const coords = data.map((point, index): [number, number] => {
            const x = padLeft + step * index;
            const y = height - padBottom - (pointValue(point) / max) * plotHeight;
            return [x, y];
        });
        const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        const area = `${padLeft},${height - padBottom} ${line} ${width - padRight},${height - padBottom}`;
        const xStep = Math.max(1, Math.ceil(data.length / 8));
        const xTicks = data.filter((_, index) => index === 0 || index === data.length - 1 || index % xStep === 0);
        const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const value = Math.round(max * ratio);
            const y = height - padBottom - ratio * plotHeight;
            return { value, y };
        }).filter((tick, index, list) => list.findIndex((item) => item.value === tick.value) === index);
        return `
            <div class="statistics-line-chart-wrap">
                <svg class="statistics-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(tr("statistics_chart_running", "Trains in circulation"))}">
                    ${yTicks.map((tick) => `
                        <line class="statistics-chart-grid" x1="${padLeft}" y1="${tick.y.toFixed(1)}" x2="${width - padRight}" y2="${tick.y.toFixed(1)}" />
                        <text x="${padLeft - 10}" y="${(tick.y + 4).toFixed(1)}" text-anchor="end">${esc(formatNumber(tick.value))}</text>
                    `).join("")}
                    <line x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}" />
                    <line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${height - padBottom}" />
                    <polygon points="${area}" />
                    <polyline points="${line}" />
                    ${coords.map(([x, y], index) => {
                        const label = pointLabel(data[index]);
                        const value = pointValue(data[index]);
                        return `
                            <circle class="statistics-chart-point" tabindex="0" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5"
                                data-label="${esc(label)}" data-value="${esc(formatNumber(value))}" data-x="${x.toFixed(1)}" data-y="${y.toFixed(1)}">
                                <title>${esc(label)}: ${esc(formatNumber(value))}</title>
                            </circle>
                        `;
                    }).join("")}
                    ${xTicks.map((point, index) => {
                        const dataIndex = data.indexOf(point);
                        const x = padLeft + step * dataIndex;
                        const anchor = index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle";
                        return `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="${anchor}">${esc(pointLabel(point))}</text>`;
                    }).join("")}
                </svg>
                <div class="statistics-chart-tooltip" hidden></div>
            </div>
        `;
    }

    function bindRunningChartEvents(): void {
        const chart = $("statisticsRunningChart");
        if (!chart || chart.dataset.bound === "1") return;
        chart.dataset.bound = "1";
        const showPoint = (point: HTMLElement) => {
            const tooltip = chart.querySelector<HTMLElement>(".statistics-chart-tooltip");
            if (!tooltip) return;
            const label = point.dataset.label || "";
            const value = point.dataset.value || "";
            tooltip.innerHTML = `<strong>${esc(value)}</strong><span>${esc(label)}</span>`;
            tooltip.style.left = `${(asNumber(point.dataset.x, 0) / 680) * 100}%`;
            tooltip.style.top = `${(asNumber(point.dataset.y, 0) / 260) * 100}%`;
            tooltip.hidden = false;
        };
        chart.addEventListener("click", (event) => {
            const point = event.target instanceof Element
                ? event.target.closest<HTMLElement>(".statistics-chart-point")
                : null;
            if (point) showPoint(point);
        });
        chart.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            const point = event.target instanceof Element
                ? event.target.closest<HTMLElement>(".statistics-chart-point")
                : null;
            if (!point) return;
            event.preventDefault();
            showPoint(point);
        });
    }

    function renderDonut(segments: DonutSegment[], title: string): string {
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
                        <div><span style="background:${esc(item.color || palette[index % palette.length])}"></span><b>${esc(item.label)}</b><em>${esc(formatNumber(item.value))} - ${esc(pct((asNumber(item.value) / total) * 100))}</em></div>
                    `).join("")}
                </div>
            </div>
        `;
    }

    function renderInteractiveDonut(segments: DonutSegment[], title: string): string {
        const filtered = segments.filter((segment) => asNumber(segment.value) > 0);
        if (!filtered.length) return emptyChart();
        const total = filtered.reduce((sum, item) => sum + asNumber(item.value), 0);
        const radius = 72;
        const circumference = 2 * Math.PI * radius;
        let strokeOffset = 0;
        return `
            <div class="statistics-donut-wrap" data-donut-total="${esc(formatNumber(total))}">
                <div class="statistics-donut-svg-wrap">
                    <svg class="statistics-donut-svg" viewBox="0 0 180 180" role="img" aria-label="${esc(title)}">
                        <circle class="statistics-donut-track" cx="90" cy="90" r="${radius}" />
                        ${filtered.map((item, index) => {
                            const value = asNumber(item.value);
                            const percent = (value / total) * 100;
                            const length = (value / total) * circumference;
                            const dash = `${Math.max(0.01, length).toFixed(3)} ${Math.max(0, circumference - length).toFixed(3)}`;
                            const offset = strokeOffset;
                            strokeOffset += length;
                            const color = item.color || palette[index % palette.length];
                            return `
                                <circle class="statistics-donut-segment" tabindex="0" role="button" cx="90" cy="90" r="${radius}"
                                    stroke="${esc(color)}" stroke-dasharray="${dash}" stroke-dashoffset="${(-offset).toFixed(3)}"
                                    data-label="${esc(item.label)}" data-value="${esc(formatNumber(value))}" data-percent="${esc(pct(percent))}"
                                    transform="rotate(-90 90 90)">
                                    <title>${esc(item.label)}: ${esc(formatNumber(value))} - ${esc(pct(percent))}</title>
                                </circle>
                            `;
                        }).join("")}
                    </svg>
                    <div class="statistics-donut-center"><strong>${esc(formatNumber(total))}</strong><span>${esc(title)}</span></div>
                </div>
                <div class="statistics-legend">
                    ${filtered.map((item, index) => `
                        <button type="button" class="statistics-legend-row"
                            data-label="${esc(item.label)}" data-value="${esc(formatNumber(item.value))}" data-percent="${esc(pct((asNumber(item.value) / total) * 100))}">
                            <span style="background:${esc(item.color || palette[index % palette.length])}"></span>
                            <b>${esc(item.label)}</b>
                            <em>${esc(formatNumber(item.value))} - ${esc(pct((asNumber(item.value) / total) * 100))}</em>
                        </button>
                    `).join("")}
                </div>
                <div class="statistics-donut-selected" hidden></div>
            </div>
        `;
    }

    function bindDonutChartEvents(): void {
        document.querySelectorAll<HTMLElement>(".statistics-chart-box").forEach((chart) => {
            if (chart.dataset.donutBound === "1") return;
            chart.dataset.donutBound = "1";
            const showSegment = (target: HTMLElement) => {
                const wrap = target.closest(".statistics-donut-wrap");
                const selected = wrap?.querySelector<HTMLElement>(".statistics-donut-selected");
                if (!selected) return;
                const label = target.dataset.label || "";
                const value = target.dataset.value || "";
                const percent = target.dataset.percent || "";
                selected.hidden = false;
                selected.innerHTML = `<b>${esc(label)}</b><strong>${esc(value)}</strong><span>${esc(percent)}</span>`;
                wrap.querySelectorAll<HTMLElement>(".statistics-donut-segment, .statistics-legend-row").forEach((item) => {
                    item.classList.toggle("active", item.dataset.label === label);
                });
            };
            chart.addEventListener("click", (event) => {
                const target = event.target instanceof Element
                    ? event.target.closest<HTMLElement>(".statistics-donut-segment, .statistics-legend-row")
                    : null;
                if (target) showSegment(target);
            });
            chart.addEventListener("keydown", (event: KeyboardEvent) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                const target = event.target instanceof Element
                    ? event.target.closest<HTMLElement>(".statistics-donut-segment, .statistics-legend-row")
                    : null;
                if (!target) return;
                event.preventDefault();
                showSegment(target);
            });
        });
    }

    function renderCategoryChart(categories: unknown): string {
        const buckets = new Map<string, number>();
        asArray(categories).forEach((item) => {
            const label = chartCategoryCode(item.label || item.category || item.name || item.code || "--");
            const value = asNumber(item.value ?? item.count ?? item.total, 0);
            if (!label || label === "--" || value <= 0) return;
            buckets.set(label, (buckets.get(label) || 0) + value);
        });
        const data = Array.from(buckets, ([label, value]) => ({ label, value }))
            .sort((a, b) => {
                const order = categorySortIndex(a.label) - categorySortIndex(b.label);
                if (order !== 0) return order;
                return b.value - a.value;
            });
        if (!data.length) return emptyChart();
        const max = Math.max(...data.map((item) => item.value), 1);
        return `
            <div class="statistics-bars">
                ${data.map((item) => `
                    <div class="statistics-bar-row">
                        <span>${categoryBadgeHtml(item.label)}</span>
                        <div><i style="width:${Math.max(2, (item.value / max) * 100)}%;background:${esc(categoryColor(item.label))}"></i></div>
                        <strong>${esc(formatNumber(item.value))}</strong>
                    </div>
                `).join("")}
            </div>
        `;
    }

    function renderCharts(): void {
        const summary = state.summary || {};
        const values = summaryCounts();
        const series = normalizeTimeseries(state.timeseries);
        const runningPoints = asArray(series.points || series.running || series.trains || series.treniCircolanti);
        if ($("statisticsRunningChart")) $("statisticsRunningChart").innerHTML = renderLineChart(runningPoints);
        if ($("statisticsRegularityChart")) {
            $("statisticsRegularityChart").innerHTML = renderInteractiveDonut([
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
                        ${renderInteractiveDonut([
                            { label: tr("on_time", "On Time"), value: values.departureOnTime, color: "#65bfc0" },
                            { label: tr("statistics_status_delayed", "Delayed"), value: values.departureDelayed, color: "#ec6685" }
                        ], tr("departures", "Departures"))}
                    </div>
                    <div>
                        <h3>${esc(tr("statistics_arrival_punctuality", "Arrival punctuality"))}</h3>
                        ${renderInteractiveDonut([
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

    function renderAll(): void {
        fillDateSelect();
        fillCategorySelect();
        renderMeta();
        renderMetrics();
        renderCharts();
        renderTable();
    }

    function isStatisticsView(value: string | undefined): value is StatisticsView {
        return value === "trains" || value === "stations" || value === "relations" || value === "ranking";
    }

    function setActiveView(view: StatisticsView, shouldLoad = true): void {
        state.activeView = view;
        state.page = 1;
        document.querySelectorAll<HTMLElement>(".statistics-tab").forEach((tab) => {
            tab.classList.toggle("active", tab.dataset.statView === view);
        });
        const category = $<HTMLSelectElement>("statisticsCategory");
        const status = $<HTMLSelectElement>("statisticsStatusFilter");
        if (category) category.style.display = view === "trains" ? "" : "none";
        if (status) status.style.display = view === "trains" ? "" : "none";
        if (shouldLoad) loadTable();
    }

    function queryValue(): string {
        return $<HTMLInputElement>("statisticsSearch")?.value.trim() || "";
    }

    function relationParams(query: string): QueryParams {
        const parts = query.split(/\s*(?:->|-|>)\s*/).map((item) => item.trim()).filter(Boolean);
        return parts.length >= 2 ? { from: parts[0], to: parts.slice(1).join(" ") } : { q: query };
    }

    async function loadTable(): Promise<void> {
        if (!state.date) return;
        state.tableLoading = true;
        setTableStatus(tr("loading", "Loading..."));
        renderTable();
        const q = queryValue();
        const category = $<HTMLSelectElement>("statisticsCategory")?.value || "";
        const status = $<HTMLSelectElement>("statisticsStatusFilter")?.value || "";
        let path = "/trains";
        let params: QueryParams = { date: state.date, page: state.page, pageSize: state.pageSize };

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
            params = { date: state.date, metric: "delay", limit: state.pageSize };
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
            setTableStatus(reasonMessage(errorReason(error)));
        } finally {
            state.tableLoading = false;
            renderTable();
        }
    }

    function reasonMessage(reason: string): string {
        if (reason === "not_configured") return tr("statistics_not_configured", "Statistics API is not configured yet.");
        if (reason === "forbidden") return tr("statistics_forbidden", "Statistics API access denied.");
        if (reason === "upstream_error") return tr("statistics_upstream_error", "Statistics service is unavailable.");
        return tr("load_error", "Failed to load, please try again later");
    }

    function tableColumns(): TableColumnDefinition[] {
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
        return [
            ["train", tr("train", "Train")],
            ["route", tr("statistics_route", "Route")],
            ["category", tr("statistics_category", "Category")],
            ["operator", tr("statistics_operator", "Operator")],
            ["delay", tr("statistics_delay", "Delay")],
            ["status", tr("status", "Status")]
        ];
    }

    function itemValue(item: StatisticsTableItem, column: TableColumn, index: number): string {
        if (column === "rank") return String(index + 1 + (state.page - 1) * state.pageSize);
        if (column === "train") return `${item.category || item.trainCategory || ""} ${item.trainNumber || item.number || item.train || ""}`.trim() || "--";
        if (column === "route") return item.route || [item.origin || item.from, item.destination || item.to].filter(Boolean).join(" -> ") || "--";
        if (column === "station") return item.name || item.station || item.stationName || "--";
        if (column === "code") return item.code || item.stationCode || item.id || "--";
        if (column === "relation") return item.relation || [item.from, item.to].filter(Boolean).join(" -> ") || "--";
        if (column === "category") return item.category || item.trainCategory || "--";
        if (column === "operator") return operatorName(item.operator || item.client);
        if (column === "delay") return formatMinutes(item.delay ?? item.totalDelay ?? item.arrivalDelay ?? item.departureDelay);
        if (column === "avgDelay") return formatMinutes(item.avgDelay ?? item.averageDelay ?? item.delayAverage);
        if (column === "monitored") return formatNumber(item.monitored ?? item.count ?? item.total);
        if (column === "cancelled") return formatNumber(item.cancelled);
        if (column === "status") return statusLabel(item.status || item.state || (item.notDeparted ? "not_departed" : item.cancelled ? "cancelled" : item.delay > 5 ? "delayed" : "regular"));
        return asString(item[column], "--");
    }

    function appendItemCellContent(cell: HTMLTableCellElement, item: StatisticsTableItem, column: TableColumn, index: number): void {
        const value = itemValue(item, column, index);
        if (column === "train") {
            const href = buildTrainHref(item);
            if (href) {
                const link = document.createElement("a");
                link.className = "statistics-table-link";
                link.href = href;
                link.textContent = value;
                cell.appendChild(link);
                return;
            }
        }
        if (column === "station") {
            const href = buildStationHref(item);
            if (href) {
                const link = document.createElement("a");
                link.className = "statistics-table-link";
                link.href = href;
                link.textContent = value;
                cell.appendChild(link);
                return;
            }
        }
        if (column === "category") {
            cell.appendChild(categoryBadgeElement(value));
            return;
        }
        cell.textContent = value;
    }

    function replaceChildrenSafe(element: HTMLElement, children: Node[]): void {
        if (typeof element.replaceChildren === "function") {
            element.replaceChildren(...children);
            return;
        }
        element.textContent = "";
        children.forEach((child) => element.appendChild(child));
    }

    function buildTableMessageRow(message: string, colspan: number): HTMLTableRowElement {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = colspan;
        cell.textContent = message;
        row.appendChild(cell);
        return row;
    }

    function statusLabel(status: unknown): string {
        const normalized = String(status || "").toLowerCase();
        if (normalized.includes("cancel")) return tr("statistics_status_cancelled", "Cancelled");
        if (normalized.includes("not_departed") || normalized.includes("not departed") || normalized.includes("non_partito") || normalized.includes("nonpartito")) return tr("statistics_status_not_departed", tr("not_departed", "Not Departed"));
        if (normalized.includes("resched") || normalized.includes("ripro")) return tr("statistics_status_rescheduled", "Rescheduled");
        if (normalized.includes("delay") || normalized.includes("ritard")) return tr("statistics_status_delayed", "Delayed");
        return tr("statistics_status_regular", "Regular");
    }

    function renderTable(): void {
        const head = $("statisticsTableHead");
        const body = $("statisticsTableBody");
        if (!head || !body) return;
        const columns = tableColumns();

        const headerRow = document.createElement("tr");
        columns.forEach(([, label]) => {
            const cell = document.createElement("th");
            cell.textContent = label;
            headerRow.appendChild(cell);
        });
        replaceChildrenSafe(head, [headerRow]);

        if (state.tableLoading) {
            replaceChildrenSafe(body, [buildTableMessageRow(tr("loading", "Loading..."), columns.length)]);
        } else if (!state.tableItems.length) {
            replaceChildrenSafe(body, [buildTableMessageRow(tr("statistics_no_rows", "No rows available"), columns.length)]);
        } else {
            const rows = state.tableItems.map((item, index) => {
                const row = document.createElement("tr");
                columns.forEach(([column]) => {
                    const cell = document.createElement("td");
                    appendItemCellContent(cell, item, column, index);
                    row.appendChild(cell);
                });
                return row;
            });
            replaceChildrenSafe(body, rows);
        }

        const pageInfo = $("statisticsPageInfo");
        const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
        if (pageInfo) {
            const totalLabel = tr("statistics_table_total", "total");
            pageInfo.textContent = `${state.page} / ${totalPages} - ${totalLabel} ${formatNumber(state.total)}`;
        }
        const previousButton = $<HTMLButtonElement>("statisticsPrev");
        const nextButton = $<HTMLButtonElement>("statisticsNext");
        if (previousButton) previousButton.disabled = state.page <= 1 || state.tableLoading;
        if (nextButton) nextButton.disabled = state.page >= totalPages || state.tableLoading;
    }

    async function loadCore(): Promise<void> {
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
            setStatus(reasonMessage(errorReason(error)), "warning");
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
            setStatus(reasonMessage(errorReason(error)), "warning");
        } finally {
            state.loading = false;
            renderAll();
            loadTable();
        }
    }

    function downloadCsv(): void {
        if (!state.date) return;
        const view = state.activeView;
        const query = paramsString({
            date: state.date,
            view,
            q: queryValue(),
            category: $<HTMLSelectElement>("statisticsCategory")?.value || "",
            status: $<HTMLSelectElement>("statisticsStatusFilter")?.value || ""
        });
        window.location.href = `${API_BASE}/export.csv?${query}`;
    }

    function debounce<T extends unknown[]>(fn: VoidFunctionWithArgs<T>, delay = 350): VoidFunctionWithArgs<T> {
        let timer: number | undefined;
        return (...args: T) => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => fn(...args), delay);
        };
    }

    function bindEvents(): void {
        $<HTMLSelectElement>("statisticsDate")?.addEventListener("change", (event) => {
            state.date = (event.currentTarget as HTMLSelectElement).value;
            state.page = 1;
            loadCore();
        });
        document.querySelectorAll<HTMLElement>(".statistics-tab").forEach((tab) => {
            tab.addEventListener("click", () => {
                setActiveView(isStatisticsView(tab.dataset.statView) ? tab.dataset.statView : "trains");
            });
        });
        const reloadTable = debounce(() => {
            state.page = 1;
            loadTable();
        });
        $<HTMLInputElement>("statisticsSearch")?.addEventListener("input", reloadTable);
        $<HTMLSelectElement>("statisticsCategory")?.addEventListener("change", reloadTable);
        $<HTMLSelectElement>("statisticsStatusFilter")?.addEventListener("change", reloadTable);
        $<HTMLButtonElement>("statisticsCsv")?.addEventListener("click", downloadCsv);
        $<HTMLButtonElement>("statisticsPrev")?.addEventListener("click", () => {
            if (state.page <= 1) return;
            state.page -= 1;
            loadTable();
        });
        $<HTMLButtonElement>("statisticsNext")?.addEventListener("click", () => {
            const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
            if (state.page >= totalPages) return;
            state.page += 1;
            loadTable();
        });
        bindRunningChartEvents();
        bindDonutChartEvents();
    }

    function initStatisticsPage(): void {
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
