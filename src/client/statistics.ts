import { onBelloLanguageChanged } from "./language-events.js";
import {
    compareStatisticsMetric,
    normalizeStatisticsDaysResponse,
    normalizeStatisticsNumber,
    selectStatisticsComparisonBaseline,
    type StatisticsComparisonBaseline,
    type StatisticsCoverage,
    type StatisticsCoverageDay
} from "../lib/normalizers/statistics.js";

(function () {
    type StatisticsView = "trains" | "stations" | "relations" | "ranking";
    type StatusKind = "info" | "warning";
    type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };
    interface JsonRecord {
        [key: string]: JsonValue;
    }
    type QueryParamValue = string | number | boolean | null | undefined;
    type QueryParams = Record<string, QueryParamValue>;
    type TableColumn = "rank" | "train" | "route" | "category" | "operator" | "delay" | "status" | "station" | "code" | "relation" | "monitored" | "avgDelay" | "cancelled";
    type TableColumnDefinition = readonly [TableColumn, string];
    type VoidFunctionWithArgs<T extends unknown[]> = (...args: T) => void;

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
        station_code?: string;
        stationCode?: string;
        stationName?: string;
        station_name?: string;
        status?: string;
        to?: string;
        total?: number;
        totalDelay?: number;
        train?: string | number;
        trainCategory?: string;
        train_number?: string | number;
        trainNumber?: string | number;
    }

    interface StatisticsSummary extends JsonRecord {
        categories?: ChartDatum[];
        categoryCounts?: ChartDatum[];
        collectionCadenceMinutes?: number | string;
        collectionCompletedAt?: string;
        completedAt?: string;
        counts?: JsonRecord;
        coverage?: JsonRecord;
        delayTotals?: JsonRecord;
        delays?: JsonRecord;
        nextScheduledAt?: string;
        punctuality?: JsonRecord;
        snapshotTime?: string;
        worst?: StatisticsTableItem;
        worstTrain?: StatisticsTableItem;
    }

    interface StatisticsTimeseries extends JsonRecord {
        points?: ChartDatum[];
        running?: ChartDatum[];
        trains?: ChartDatum[];
        treniCircolanti?: ChartDatum[];
    }

    interface StatisticsItemsPayload extends JsonRecord {
        count?: number;
        items?: StatisticsTableItem[];
        ranking?: StatisticsTableItem[];
        relations?: StatisticsTableItem[];
        stations?: StatisticsTableItem[];
        total?: number;
        trains?: StatisticsTableItem[];
    }

    interface StatisticsState {
        activeView: StatisticsView;
        compareDate: string;
        comparisonBaseline: StatisticsComparisonBaseline | null;
        comparisonSummary: StatisticsSummary | null;
        coverage: StatisticsCoverage | null;
        date: string;
        days: StatisticsCoverageDay[];
        loading: boolean;
        page: number;
        pageSize: number;
        requestSerial: number;
        summary: StatisticsSummary | null;
        tableItems: StatisticsTableItem[];
        tableLoading: boolean;
        tableRequestSerial: number;
        timeseries: StatisticsTimeseries | null;
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
        arrivalDelayed: number | null;
        arrivalEarly: number | null;
        arrivalOnTime: number | null;
        avgDelay: number | null;
        cancelled: number | null;
        circulated: number | null;
        counts: JsonRecord;
        coverage: JsonRecord;
        delayed: number | null;
        delayTotals: JsonRecord;
        departureDelayed: number | null;
        departureOnTime: number | null;
        indexedStations: number | null;
        monitored: number | null;
        notDeparted: number | null;
        punctuality: JsonRecord;
        regular: number | null;
        rescheduled: number | null;
        running: number | null;
        worstTrain: StatisticsTableItem | null;
    }

    const API_BASE = "/api/statistics";
    const PAGE_SIZE = 25;
    const CATEGORY_ORDER = ["REG", "MET", "FR", "EC FR", "FA", "FB", "IC", "ICN", "EC", "EN", "EXP", "NCL", "IR", "TS"];
    const CATEGORY_OPTIONS = [...CATEGORY_ORDER];

    const state: StatisticsState = {
        date: "",
        compareDate: "",
        comparisonBaseline: null,
        comparisonSummary: null,
        coverage: null,
        days: [],
        summary: null,
        timeseries: null,
        activeView: "trains",
        page: 1,
        pageSize: PAGE_SIZE,
        total: 0,
        tableItems: [],
        loading: false,
        tableLoading: false,
        requestSerial: 0,
        tableRequestSerial: 0
    };

    const palette = ["#65bfc0", "#5b9ee4", "#ec6685", "#f4b35d", "#83c77f", "#a78bfa", "#f78fb3", "#7dd3fc"];
    const CATEGORY_COLORS: Record<string, string> = {
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

    function asArray<T extends JsonRecord = JsonRecord>(value: unknown): T[] {
        return Array.isArray(value) ? value.filter((item): item is T => item !== null && typeof item === "object") : [];
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
        const num = normalizeStatisticsNumber(value);
        return num === null ? "—" : `${num.toFixed(digits)}%`;
    }

    function formatNumber(value: unknown): string {
        const number = normalizeStatisticsNumber(value);
        return number === null
            ? "—"
            : number.toLocaleString(window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB");
    }

    function formatMinutes(value: unknown): string {
        const minutes = normalizeStatisticsNumber(value);
        return minutes === null
            ? "—"
            : `${minutes.toLocaleString(window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB")} ${tr("minutes", "min")}`;
    }

    function formatDate(value: string | null | undefined): string {
        if (!value) return "—";
        const date = new Date(`${value}T12:00:00Z`);
        if (!Number.isFinite(date.getTime())) return value;
        return new Intl.DateTimeFormat(window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB", {
            timeZone: "UTC",
            dateStyle: "medium"
        }).format(date);
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

    function normalizeSummary(payload: unknown): StatisticsSummary {
        const record = asRecord(payload);
        return asRecord(record.summary || record) as StatisticsSummary;
    }

    function normalizeTimeseries(payload: unknown): StatisticsTimeseries {
        const record = asRecord(payload);
        return asRecord(record.timeseries || record) as StatisticsTimeseries;
    }

    function normalizeItems(payload: unknown): { items: StatisticsTableItem[]; total: number } {
        const record = asRecord(payload) as StatisticsItemsPayload;
        const items = asArray<StatisticsTableItem>(record.items || record.trains || record.stations || record.relations || record.ranking || payload);
        const total = asNumber(record.total ?? record.count ?? items.length, items.length);
        return { items, total };
    }

    function fillDateSelect(): void {
        const select = $<HTMLSelectElement>("statisticsDate");
        if (!select) return;
        const days = state.days;
        const options = days.map((day) => {
            const option = document.createElement("option");
            option.value = day.date;
            option.selected = day.date === state.date;
            const status = day.coverageStatus === "live"
                ? tr("statistics_live", "live")
                : day.coverageStatus === "partial"
                    ? tr("statistics_partial", "partial")
                    : "";
            option.textContent = `${day.label || formatDate(day.date)}${status ? ` · ${status}` : ""}`;
            return option;
        });
        replaceChildrenSafe(select, options);
        select.disabled = options.length === 0;
    }

    function comparisonCandidates(): StatisticsCoverageDay[] {
        const selected = state.days.find((day) => day.date === state.date);
        if (!selected?.comparisonEligible || selected.coverageStatus !== "complete") return [];
        return state.days
            .filter((day) => day.date < state.date && day.comparisonEligible && day.v2Available && day.coverageStatus === "complete")
            .sort((left, right) => right.date.localeCompare(left.date));
    }

    function syncComparisonDate(): void {
        const candidates = comparisonCandidates();
        if (state.compareDate && candidates.some((day) => day.date === state.compareDate)) {
            state.comparisonBaseline = {
                date: state.compareDate,
                gapDays: selectStatisticsComparisonBaseline(
                    [state.days.find((day) => day.date === state.date), candidates.find((day) => day.date === state.compareDate)]
                        .filter((day): day is StatisticsCoverageDay => Boolean(day)),
                    state.date
                )?.gapDays ?? 0
            };
            return;
        }
        state.comparisonBaseline = selectStatisticsComparisonBaseline(state.days, state.date);
        state.compareDate = state.comparisonBaseline?.date || "";
    }

    function fillComparisonSelect(): void {
        const select = $<HTMLSelectElement>("statisticsCompareDate");
        if (!select) return;
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = tr("statistics_no_comparable_day", "No complete comparison day yet");
        const options = comparisonCandidates().map((day) => {
            const option = document.createElement("option");
            option.value = day.date;
            option.selected = day.date === state.compareDate;
            option.textContent = day.label || formatDate(day.date);
            return option;
        });
        replaceChildrenSafe(select, [placeholder, ...options]);
        select.value = state.compareDate;
        select.disabled = options.length === 0;
    }

    function fillCategorySelect(): void {
        const select = $<HTMLSelectElement>("statisticsCategory");
        if (!select) return;
        const current = select.value;
        const allOption = document.createElement("option");
        allOption.value = "";
        allOption.textContent = tr("statistics_all_categories", "All categories");
        const options = CATEGORY_OPTIONS.map((cat) => {
            const option = document.createElement("option");
            option.value = cat;
            option.textContent = cat;
            return option;
        });
        replaceChildrenSafe(select, [allOption, ...options]);
        select.value = current;
    }

    function metricCardElement(
        id: string,
        icon: string,
        label: string,
        value: string,
        note = "",
        tone: "good" | "bad" | "neutral" = "neutral"
    ): HTMLDivElement {
        const card = document.createElement("div");
        card.className = "statistics-metric";
        card.dataset.statMetric = id;
        card.dataset.comparisonTone = tone;

        const iconEl = document.createElement("span");
        iconEl.className = "material-symbols-outlined";
        iconEl.textContent = icon;

        const body = document.createElement("div");
        const labelEl = document.createElement("small");
        labelEl.textContent = label;
        const valueEl = document.createElement("strong");
        valueEl.textContent = value;
        body.append(labelEl, valueEl);

        if (note) {
            const noteEl = document.createElement("em");
            noteEl.textContent = note;
            body.appendChild(noteEl);
        }

        card.append(iconEl, body);
        return card;
    }

    function summaryCounts(source: StatisticsSummary | null = state.summary): SummaryCounts {
        const summary = source || {};
        const counts = asRecord(summary.counts);
        const punctuality = asRecord(summary.punctuality);
        const delayTotals = asRecord(summary.delayTotals || summary.delays);
        const coverage = asRecord(summary.coverage || summary.completeness);
        const monitored = normalizeStatisticsNumber(getPath(summary, ["counts.monitored", "monitored", "trains.monitored"], null));
        const circulated = normalizeStatisticsNumber(getPath(summary, ["counts.circulated", "counts.treniGiorno", "treniGiorno", "circulated"], null));
        const running = normalizeStatisticsNumber(getPath(summary, ["counts.running", "counts.treniCircolanti", "treniCircolanti", "running"], null));
        const regular = normalizeStatisticsNumber(getPath(summary, ["counts.regular", "regular"], null));
        const delayed = normalizeStatisticsNumber(getPath(summary, ["counts.delayed", "delayed"], null));
        const cancelled = normalizeStatisticsNumber(getPath(summary, ["counts.cancelled", "cancelled"], null));
        const rescheduled = normalizeStatisticsNumber(getPath(summary, ["counts.rescheduled", "rescheduled", "counts.reprogrammed"], null));
        const notDeparted = normalizeStatisticsNumber(getPath(summary, ["counts.notDeparted", "notDeparted", "counts.not_departed"], null));
        const avgDelay = normalizeStatisticsNumber(getPath(summary, ["delayTotals.average", "delayTotals.avg", "avgDelay", "averageDelay"], null));
        const indexedStationsRaw = getPath(summary, ["coverage.stations", "stationsIndexed", "stationCount"], null);
        const indexedStations = normalizeStatisticsNumber(indexedStationsRaw);
        const departureDelayed = normalizeStatisticsNumber(getPath(summary, ["punctuality.departure.delayed", "departure.delayed"], null));
        const departureOnTime = normalizeStatisticsNumber(getPath(summary, ["punctuality.departure.onTime", "departure.onTime"], null));
        const arrivalDelayed = normalizeStatisticsNumber(getPath(summary, ["punctuality.arrival.delayed", "arrival.delayed"], null));
        const arrivalOnTime = normalizeStatisticsNumber(getPath(summary, ["punctuality.arrival.onTime", "arrival.onTime"], null));
        const arrivalEarly = normalizeStatisticsNumber(getPath(summary, ["punctuality.arrival.early", "arrival.early"], null));
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

    function ratioPercent(numerator: number | null, denominator: number | null): number | null {
        return numerator === null || denominator === null || denominator <= 0
            ? null
            : (numerator / denominator) * 100;
    }

    function signedNumber(value: number, digits = 0): string {
        const formatted = Math.abs(value).toLocaleString(
            window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB",
            { maximumFractionDigits: digits, minimumFractionDigits: digits }
        );
        return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatted}`;
    }

    function comparisonNote(
        current: number | null,
        baseline: number | null,
        kind: "number" | "percentage" | "minutes",
        lowerIsBetter = false
    ): { text: string; tone: "good" | "bad" | "neutral" } {
        if (!state.comparisonSummary || !state.compareDate) return { text: "", tone: "neutral" };
        const comparison = compareStatisticsMetric(current, baseline);
        if (!comparison) return { text: tr("statistics_comparison_unavailable", "Comparison unavailable"), tone: "neutral" };
        const deltaText = kind === "percentage"
            ? `${signedNumber(comparison.delta, 1)} pp`
            : kind === "minutes"
                ? `${signedNumber(comparison.delta, 1)} ${tr("minutes", "min")}`
                : signedNumber(comparison.delta);
        const tone = comparison.delta === 0
            ? "neutral"
            : (lowerIsBetter ? comparison.delta < 0 : comparison.delta > 0) ? "good" : "bad";
        return {
            text: `${deltaText} · ${formatDate(state.compareDate)}`,
            tone
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
            cadenceEl.textContent = cadence ? `${cadence} ${tr("minutes", "min")}` : "--";
            cadenceEl.title = nextScheduledAt
                ? `${tr("statistics_next_run", "Next scheduled run")}: ${formatDateTime(nextScheduledAt)}`
                : "";
        }
        const coverageEl = $("statisticsCoverage");
        if (coverageEl) coverageEl.textContent = stationValue;
    }

    function renderCoverageNotice(): void {
        const element = $("statisticsCoverageNotice");
        if (!element) return;
        const range = state.coverage?.collectionDate;
        const rolloutDate = state.coverage?.rolloutDate || range?.availableFrom;
        const selected = state.days.find((day) => day.date === state.date);
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined";
        icon.textContent = "info";
        const body = document.createElement("div");
        const title = document.createElement("strong");
        const detail = document.createElement("span");
        if (!rolloutDate) {
            title.textContent = tr("statistics_coverage_unavailable", "Detailed-data coverage is not available yet");
            detail.textContent = tr("statistics_coverage_accumulating", "New observations will appear here as they are collected.");
        } else {
            title.textContent = `${tr("statistics_detailed_data_from", "Detailed observations from")} ${formatDate(rolloutDate)}`;
            const end = range?.availableTo && range.availableTo !== rolloutDate
                ? ` · ${tr("statistics_through", "through")} ${formatDate(range.availableTo)}`
                : "";
            const selectedStatus = selected?.coverageStatus === "partial"
                ? selected.reason === "incomplete_collection_day"
                    ? tr("statistics_incomplete_day_note", "This day is missing one or more successful collection slots and is not used as a comparison baseline.")
                    : tr("statistics_partial_day_note", "The rollout day is partial and is not used as a comparison baseline.")
                : selected?.coverageStatus === "live"
                    ? tr("statistics_live_day_note", "The selected day is still being collected.")
                    : tr("statistics_forward_only_note", "Coverage grows forward from the rollout date; missing dates are never treated as zero.");
            detail.textContent = `${selectedStatus}${end}`;
        }
        body.append(title, detail);
        replaceChildrenSafe(element, [icon, body]);
    }

    function renderComparisonStatus(): void {
        const element = $("statisticsComparisonStatus");
        if (!element) return;
        const selected = state.days.find((day) => day.date === state.date);
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined";
        const body = document.createElement("div");
        const title = document.createElement("strong");
        const detail = document.createElement("span");
        if (state.comparisonSummary && state.compareDate) {
            icon.textContent = "check_circle";
            title.textContent = `${tr("statistics_change_vs", "Compared with")} ${formatDate(state.compareDate)}`;
            detail.textContent = state.comparisonBaseline?.gapDays
                ? `${tr("statistics_comparison_gap", "Nearest complete baseline; missing calendar days between dates")}: ${state.comparisonBaseline.gapDays}`
                : tr("statistics_comparison_ready", "Metric changes use the same daily definitions and a complete baseline.");
        } else {
            icon.textContent = "info";
            title.textContent = tr("statistics_comparison_pending", "Not enough complete data for a daily comparison");
            if (selected?.coverageStatus === "live") {
                detail.textContent = tr("statistics_comparison_live_day", "A live partial day is not compared with a completed day.");
            } else if (selected?.coverageStatus === "partial") {
                detail.textContent = selected.reason === "incomplete_collection_day"
                    ? tr("statistics_comparison_incomplete_day", "This day has incomplete collection evidence and cannot be used for comparison.")
                    : tr("statistics_comparison_partial_day", "The rollout day is partial and cannot be used for comparison.");
            } else if (!selected?.v2Available) {
                detail.textContent = tr("statistics_comparison_before_coverage", "This date predates detailed v2 observations.");
            } else {
                detail.textContent = tr("statistics_comparison_accumulating", "Comparison becomes available after two complete eligible days exist.");
            }
        }
        body.append(title, detail);
        replaceChildrenSafe(element, [icon, body]);
    }

    function insightElement(iconName: string, titleText: string, detailText: string, tone: string): HTMLDivElement {
        const item = document.createElement("div");
        item.className = "statistics-insight";
        item.dataset.insightTone = tone;
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined statistics-insight-severity";
        icon.textContent = iconName;
        const body = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = titleText;
        const detail = document.createElement("p");
        detail.textContent = detailText;
        body.append(title, detail);
        item.append(icon, body);
        return item;
    }

    function renderInsights(): void {
        const element = $("statisticsInsights");
        if (!element) return;
        if (!state.summary) {
            const empty = document.createElement("p");
            empty.className = "statistics-insights-empty";
            empty.textContent = tr("statistics_insights_empty", "No reliable insights are available for this date.");
            replaceChildrenSafe(element, [empty]);
            return;
        }
        const values = summaryCounts();
        const items: HTMLDivElement[] = [];
        const delayedRate = ratioPercent(values.delayed, values.monitored);
        const cancelledRate = ratioPercent(values.cancelled, values.monitored);
        const worst = values.worstTrain;
        if (worst) {
            const number = `${worst.category || ""} ${worst.trainNumber || worst.train_number || worst.number || worst.train || ""}`.trim();
            const route = [worst.origin, worst.destination].filter(Boolean).join(" → ");
            const delay = normalizeStatisticsNumber(worst.delay);
            items.push(insightElement(
                "warning",
                tr("statistics_insight_worst_train", "Most delayed observed train"),
                [number || "—", route, delay === null ? "" : `+${formatMinutes(delay)}`].filter(Boolean).join(" · "),
                "high"
            ));
        }
        if (delayedRate !== null) {
            items.push(insightElement(
                "schedule",
                tr("statistics_insight_delayed", "Observed delayed trains"),
                `${formatNumber(values.delayed)} · ${pct(delayedRate)}`,
                delayedRate >= 20 ? "high" : "medium"
            ));
        }
        if (cancelledRate !== null) {
            items.push(insightElement(
                "cancel",
                tr("statistics_insight_cancelled", "Observed cancellations"),
                `${formatNumber(values.cancelled)} · ${pct(cancelledRate)}`,
                cancelledRate >= 5 ? "high" : "medium"
            ));
        }
        const selected = state.days.find((day) => day.date === state.date);
        if (selected?.coverageStatus === "partial" || selected?.coverageStatus === "live") {
            items.push(insightElement(
                "info",
                tr("statistics_insight_coverage", "Interpret with coverage context"),
                selected.coverageStatus === "live"
                    ? tr("statistics_live_day_note", "The selected day is still being collected.")
                    : selected.reason === "incomplete_collection_day"
                        ? tr("statistics_incomplete_day_note", "This day is missing one or more successful collection slots and is not used as a comparison baseline.")
                        : tr("statistics_partial_day_note", "The rollout day is partial and is not used as a comparison baseline."),
                "info"
            ));
        }
        if (!items.length) {
            const empty = document.createElement("p");
            empty.className = "statistics-insights-empty";
            empty.textContent = tr("statistics_insights_empty", "No reliable insights are available for this date.");
            replaceChildrenSafe(element, [empty]);
            return;
        }
        replaceChildrenSafe(element, items);
    }

    function renderMetrics(): void {
        const el = $("statisticsMetrics");
        if (!el) return;
        const values = summaryCounts();
        const baseline = summaryCounts(state.comparisonSummary);
        const regularity = ratioPercent(values.regular, values.monitored);
        const baselineRegularity = ratioPercent(baseline.regular, baseline.monitored);
        const cancellationRate = ratioPercent(values.cancelled, values.monitored);
        const baselineCancellationRate = ratioPercent(baseline.cancelled, baseline.monitored);
        const monitoredNote = comparisonNote(values.monitored, baseline.monitored, "number");
        const regularityNote = comparisonNote(regularity, baselineRegularity, "percentage");
        const cancellationNote = comparisonNote(cancellationRate, baselineCancellationRate, "percentage", true);
        const delayNote = comparisonNote(values.avgDelay, baseline.avgDelay, "minutes", true);
        replaceChildrenSafe(el, [
            metricCardElement("monitored", "train", tr("statistics_monitored", "Monitored trains"), formatNumber(values.monitored), monitoredNote.text, monitoredNote.tone),
            metricCardElement("regularity", "check_circle", tr("statistics_regularity_rate", "Regularity rate"), pct(regularity), regularityNote.text, regularityNote.tone),
            metricCardElement("cancellation", "cancel", tr("statistics_cancellation_rate", "Cancellation rate"), pct(cancellationRate), cancellationNote.text, cancellationNote.tone),
            metricCardElement("avg_delay", "schedule", tr("statistics_avg_delay", "Average delay"), formatMinutes(values.avgDelay), delayNote.text, delayNote.tone)
        ]);
    }

    function emptyChart(message = tr("statistics_no_chart_data", "No chart data")): string {
        return `<div class="statistics-empty-chart">${esc(message)}</div>`;
    }

    function emptyChartElement(message = tr("statistics_no_chart_data", "No chart data")): HTMLDivElement {
        const element = document.createElement("div");
        element.className = "statistics-empty-chart";
        element.textContent = message;
        return element;
    }

    function pointValue(point: JsonRecord): number | null {
        return normalizeStatisticsNumber(point.value ?? point.running ?? point.treniCircolanti ?? point.count ?? point.y);
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
        const data = asArray(points)
            .map((point) => ({ point, value: pointValue(point) }))
            .filter((item): item is { point: JsonRecord; value: number } => item.value !== null);
        if (!data.length) return emptyChart();
        const values = data.map((item) => item.value);
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
        const coords = data.map((item, index): [number, number] => {
            const x = padLeft + step * index;
            const y = height - padBottom - (item.value / max) * plotHeight;
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
                        const label = pointLabel(data[index].point);
                        const value = data[index].value;
                        return `
                            <circle class="statistics-chart-point" tabindex="0" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5"
                                data-label="${esc(label)}" data-value="${esc(formatNumber(value))}" data-x="${x.toFixed(1)}" data-y="${y.toFixed(1)}">
                                <title>${esc(label)}: ${esc(formatNumber(value))}</title>
                            </circle>
                        `;
                    }).join("")}
                    ${xTicks.map((item, index) => {
                        const dataIndex = data.indexOf(item);
                        const x = padLeft + step * dataIndex;
                        const anchor = index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle";
                        return `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="${anchor}">${esc(pointLabel(item.point))}</text>`;
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
            const valueEl = document.createElement("strong");
            valueEl.textContent = value;
            const labelEl = document.createElement("span");
            labelEl.textContent = label;
            replaceChildrenSafe(tooltip, [valueEl, labelEl]);
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
                if (!wrap || !selected) return;
                const label = target.dataset.label || "";
                const value = target.dataset.value || "";
                const percent = target.dataset.percent || "";
                selected.hidden = false;
                const labelEl = document.createElement("b");
                labelEl.textContent = label;
                const valueEl = document.createElement("strong");
                valueEl.textContent = value;
                const percentEl = document.createElement("span");
                percentEl.textContent = percent;
                replaceChildrenSafe(selected, [labelEl, valueEl, percentEl]);
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

    function categoryChartData(categories: unknown): Array<{ label: string; value: number }> {
        const buckets = new Map<string, number>();
        asArray<ChartDatum>(categories).forEach((item) => {
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
        return data;
    }

    function renderCategoryChart(element: HTMLElement, categories: unknown): void {
        const data = categoryChartData(categories);
        if (!data.length) {
            replaceChildrenSafe(element, [emptyChartElement()]);
            return;
        }
        const max = Math.max(...data.map((item) => item.value), 1);
        const wrap = document.createElement("div");
        wrap.className = "statistics-bars";
        data.forEach((item) => {
            const row = document.createElement("div");
            row.className = "statistics-bar-row";

            const label = document.createElement("span");
            label.appendChild(categoryBadgeElement(item.label));

            const bar = document.createElement("div");
            const fill = document.createElement("i");
            fill.style.width = `${Math.max(2, (item.value / max) * 100)}%`;
            fill.style.background = categoryColor(item.label);
            bar.appendChild(fill);

            const value = document.createElement("strong");
            value.textContent = formatNumber(item.value);

            row.append(label, bar, value);
            wrap.appendChild(row);
        });
        replaceChildrenSafe(element, [wrap]);
    }

    function renderCharts(): void {
        const summary = state.summary || {};
        const values = summaryCounts();
        const series = normalizeTimeseries(state.timeseries);
        const runningPoints = asArray(series.points || series.running || series.trains || series.treniCircolanti);
        const runningChart = $("statisticsRunningChart");
        if (runningChart) runningChart.innerHTML = renderLineChart(runningPoints);
        const regularityChart = $("statisticsRegularityChart");
        if (regularityChart) {
            regularityChart.innerHTML = renderInteractiveDonut([
                { label: tr("statistics_regular", "Regular"), value: values.regular ?? 0, color: "#138a8a" },
                { label: tr("statistics_status_delayed", "Delayed"), value: values.delayed ?? 0, color: "#2869d8" },
                { label: tr("statistics_rescheduled", "Rescheduled"), value: values.rescheduled ?? 0, color: "#f59e0b" },
                { label: tr("statistics_cancelled", "Cancelled"), value: values.cancelled ?? 0, color: "#d71920" }
            ], tr("statistics_trains", "trains"));
        }
        const punctualityChart = $("statisticsPunctualityChart");
        if (punctualityChart) {
            punctualityChart.innerHTML = `
                <div class="statistics-dual-donut">
                    <div>
                        <h3>${esc(tr("statistics_departure_punctuality", "Departure punctuality"))}</h3>
                        ${renderInteractiveDonut([
                            { label: tr("on_time", "On Time"), value: values.departureOnTime ?? 0, color: "#138a8a" },
                            { label: tr("statistics_status_delayed", "Delayed"), value: values.departureDelayed ?? 0, color: "#d71920" }
                        ], tr("departures", "Departures"))}
                    </div>
                    <div>
                        <h3>${esc(tr("statistics_arrival_punctuality", "Arrival punctuality"))}</h3>
                        ${renderInteractiveDonut([
                            { label: tr("statistics_early", "Early"), value: values.arrivalEarly ?? 0, color: "#2869d8" },
                            { label: tr("on_time", "On Time"), value: values.arrivalOnTime ?? 0, color: "#138a8a" },
                            { label: tr("statistics_status_delayed", "Delayed"), value: values.arrivalDelayed ?? 0, color: "#d71920" }
                        ], tr("arrivals", "Arrivals"))}
                    </div>
                </div>
            `;
        }
        const categoryChart = $("statisticsCategoryChart");
        if (categoryChart) {
            renderCategoryChart(categoryChart, summary.categories || summary.categoryCounts || []);
        }
    }

    function renderAll(): void {
        fillDateSelect();
        fillComparisonSelect();
        fillCategorySelect();
        renderMeta();
        renderCoverageNotice();
        renderComparisonStatus();
        renderMetrics();
        renderCharts();
        renderInsights();
        renderTable();
    }

    function isStatisticsView(value: string | undefined): value is StatisticsView {
        return value === "trains" || value === "stations" || value === "relations" || value === "ranking";
    }

    function setActiveView(view: StatisticsView, shouldLoad = true): void {
        state.activeView = view;
        state.page = 1;
        document.querySelectorAll<HTMLElement>(".statistics-tab").forEach((tab) => {
            const selected = tab.dataset.statView === view;
            tab.classList.toggle("active", selected);
            tab.setAttribute("aria-selected", String(selected));
        });
        const category = $<HTMLSelectElement>("statisticsCategory");
        const status = $<HTMLSelectElement>("statisticsStatusFilter");
        const showTrainFilters = view === "trains";
        const categoryField = category?.closest<HTMLElement>(".statistics-filter-field");
        const statusField = status?.closest<HTMLElement>(".statistics-filter-field");
        if (categoryField) categoryField.hidden = !showTrainFilters;
        if (statusField) statusField.hidden = !showTrainFilters;
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
        const requestSerial = ++state.tableRequestSerial;
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
            if (requestSerial !== state.tableRequestSerial) return;
            const normalized = normalizeItems(payload);
            state.tableItems = normalized.items;
            state.total = normalized.total;
            setTableStatus("");
        } catch (error) {
            if (requestSerial !== state.tableRequestSerial) return;
            state.tableItems = [];
            state.total = 0;
            setTableStatus(reasonMessage(errorReason(error)));
        } finally {
            if (requestSerial !== state.tableRequestSerial) return;
            state.tableLoading = false;
            renderTable();
        }
    }

    function reasonMessage(reason: string): string {
        if (reason === "not_configured") return tr("statistics_not_configured", "Statistics API is not configured yet.");
        if (reason === "forbidden") return tr("statistics_forbidden", "Statistics API access denied.");
        if (reason === "upstream_error") return tr("statistics_upstream_error", "Statistics service is unavailable.");
        if (reason === "no_data") return tr("statistics_no_data_for_day", "No observations are available for this date.");
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
        if (column === "operator") {
            const operator = String(item.operator ?? "").trim() ? item.operator : item.client;
            return operatorName(operator);
        }
        if (column === "delay") return formatMinutes(item.delay ?? item.totalDelay ?? item.arrivalDelay ?? item.departureDelay);
        if (column === "avgDelay") return formatMinutes(item.avgDelay ?? item.averageDelay ?? item.delayAverage);
        if (column === "monitored") return formatNumber(item.monitored ?? item.count ?? item.total);
        if (column === "cancelled") return formatNumber(item.cancelled);
        if (column === "status") {
            const explicitStatus = item.status || item.state;
            if (explicitStatus) return statusLabel(explicitStatus);
            if (item.notDeparted) return statusLabel("not_departed");
            if (item.cancelled === true || normalizeStatisticsNumber(item.cancelled) === 1) return statusLabel("cancelled");
            const delay = normalizeStatisticsNumber(item.delay);
            if (delay !== null) return statusLabel(delay > 5 ? "delayed" : "regular");
            return tr("statistics_status_unknown", "Unknown");
        }
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
        if (!normalized) return tr("statistics_status_unknown", "Unknown");
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
        const requestSerial = ++state.requestSerial;
        state.tableRequestSerial += 1;
        state.loading = true;
        state.summary = null;
        state.timeseries = null;
        state.comparisonSummary = null;
        state.tableItems = [];
        state.total = 0;
        state.tableLoading = false;
        setStatus(tr("statistics_loading", "Loading statistics..."), "info");
        renderAll();
        try {
            const daysPayload = await fetchJson("/days", { limit: 90 });
            if (requestSerial !== state.requestSerial) return;
            const normalized = normalizeStatisticsDaysResponse(daysPayload);
            state.days = normalized.days;
            state.coverage = normalized.coverage;
            if (!state.days.some((day) => day.date === state.date)) {
                state.date = state.days[0]?.date || "";
            }
            syncComparisonDate();
            fillDateSelect();
            fillComparisonSelect();
        } catch (error) {
            if (requestSerial !== state.requestSerial) return;
            state.days = [];
            state.coverage = null;
            state.compareDate = "";
            state.comparisonBaseline = null;
            state.comparisonSummary = null;
            fillDateSelect();
            fillComparisonSelect();
            setStatus(reasonMessage(errorReason(error)), "warning");
        }

        if (!state.date) {
            state.summary = null;
            state.timeseries = null;
            state.comparisonSummary = null;
            state.loading = false;
            renderAll();
            return;
        }

        try {
            const [summary, timeseries, comparisonSummary] = await Promise.all([
                fetchJson("/summary", { date: state.date }),
                fetchJson("/timeseries", { date: state.date }).catch(() => ({})),
                state.compareDate
                    ? fetchJson("/summary", { date: state.compareDate }).then(normalizeSummary).catch(() => null)
                    : Promise.resolve(null)
            ]);
            if (requestSerial !== state.requestSerial) return;
            state.summary = normalizeSummary(summary);
            state.timeseries = normalizeTimeseries(timeseries);
            state.comparisonSummary = comparisonSummary;
            setStatus("");
        } catch (error) {
            if (requestSerial !== state.requestSerial) return;
            state.summary = null;
            state.timeseries = null;
            state.comparisonSummary = null;
            setStatus(reasonMessage(errorReason(error)), "warning");
        } finally {
            if (requestSerial !== state.requestSerial) return;
            state.loading = false;
            renderAll();
            if (state.summary) loadTable();
        }
    }

    function downloadCsv(): void {
        if (!state.date) return;
        const view = state.activeView;
        const exportView: Record<StatisticsView, string> = {
            trains: "trains",
            stations: "station",
            relations: "relation",
            ranking: "trains"
        };
        const query = paramsString({
            date: state.date,
            view: exportView[view],
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
            state.compareDate = "";
            state.comparisonBaseline = null;
            state.comparisonSummary = null;
            state.page = 1;
            loadCore();
        });
        $<HTMLSelectElement>("statisticsCompareDate")?.addEventListener("change", (event) => {
            state.compareDate = (event.currentTarget as HTMLSelectElement).value;
            state.comparisonSummary = null;
            syncComparisonDate();
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
        document.querySelectorAll<HTMLElement>(".statistics-analysis-tab").forEach((tab) => {
            tab.addEventListener("click", () => {
                document.querySelectorAll<HTMLElement>(".statistics-analysis-tab").forEach((item) => {
                    const selected = item === tab;
                    item.classList.toggle("active", selected);
                    item.setAttribute("aria-selected", String(selected));
                });
                const view = tab.dataset.analysisView;
                if (view === "network") setActiveView("stations");
                if (view === "details") setActiveView("trains");
                const target = view === "overview"
                    ? document.querySelector<HTMLElement>(".statistics-summary-strip")
                    : view === "trends"
                        ? document.querySelector<HTMLElement>(".statistics-primary-grid")
                        : document.querySelector<HTMLElement>(".statistics-search-panel");
                target?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
        });
    }

    function initStatisticsPage(): void {
        if (!$("statisticsMetrics")) return;
        state.date = todayRome();
        bindEvents();
        fillCategorySelect();
        setActiveView("trains", false);
        loadCore();
    }

    onBelloLanguageChanged(() => {
        if (!$("statisticsMetrics")) return;
        renderAll();
    });

    document.addEventListener("astro:page-load", initStatisticsPage);
})();
