import { onBelloLanguageChanged } from "./language-events.js";
import {
    formatAnalyticsNumber,
    formatAnalyticsPercent,
    normalizeAnalyticsExplore,
    normalizeAnalyticsMeta,
    normalizeAnalyticsOutliers,
    normalizeAnalyticsOverview,
    normalizeAnalyticsRanking,
    percentagePointChange,
    type AnalyticsDimension,
    type AnalyticsExplore,
    type AnalyticsMeta,
    type AnalyticsMetricSet,
    type AnalyticsOutlierPayload,
    type AnalyticsOverview,
    type AnalyticsRankingPayload,
    type AnalyticsRankingSort,
    type AnalyticsWindow
} from "../lib/normalizers/statistics-analytics.js";
import {
    statisticsOperatorLabel,
    statisticsStationColor
} from "../lib/normalizers/statistics.js";

(function () {
    type AnalyticsChartModule = typeof import("./statistics-echarts.js");
    type StatisticsMode = "live" | "performance";
    type AnalyticsTopic = "overview" | "mix" | "rhythm" | "stations" | "routes" | "services" | "quality";

    interface AnalyticsState {
        asOf: string;
        category: string;
        charts: AnalyticsChartModule | null;
        dimension: AnalyticsDimension;
        explore: AnalyticsExplore | null;
        initialized: boolean;
        loading: boolean;
        meta: AnalyticsMeta | null;
        mode: StatisticsMode;
        operator: string;
        outliers: AnalyticsOutlierPayload | null;
        overview: AnalyticsOverview | null;
        ranking: AnalyticsRankingPayload | null;
        rankings: Partial<Record<AnalyticsDimension, AnalyticsRankingPayload>>;
        rankDirection: "asc" | "desc";
        rankSort: AnalyticsRankingSort;
        requestSerial: number;
        station: string;
        themeObserver: MutationObserver | null;
        topic: AnalyticsTopic;
        windowDays: AnalyticsWindow;
    }

    const API_BASE = "/api/statistics/analytics";
    const state: AnalyticsState = {
        asOf: "",
        category: "",
        charts: null,
        dimension: "operator",
        explore: null,
        initialized: false,
        loading: false,
        meta: null,
        mode: "live",
        operator: "",
        outliers: null,
        overview: null,
        ranking: null,
        rankings: {},
        rankDirection: "asc",
        rankSort: "punctuality",
        requestSerial: 0,
        station: "",
        themeObserver: null,
        topic: "overview",
        windowDays: 28
    };

    function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
        return document.getElementById(id) as T | null;
    }

    function tr(key: string, fallback?: string): string {
        const dict = window.translations;
        return (dict && dict[window.currentLang] && dict[window.currentLang][key])
            || (dict && dict.en && dict.en[key])
            || fallback
            || key;
    }

    function locale(): string {
        return window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-US";
    }

    function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function setHidden(target: HTMLElement | null, hidden: boolean): void {
        if (target) target.hidden = hidden;
    }

    async function fetchJson(path: string, params?: URLSearchParams): Promise<unknown> {
        const url = params && params.size > 0 ? `${API_BASE}${path}?${params}` : `${API_BASE}${path}`;
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        const payload = await response.json().catch(() => null) as unknown;
        if (!response.ok) {
            const reason = payload && typeof payload === "object" && "reason" in payload
                ? String((payload as { reason?: unknown }).reason ?? "")
                : "";
            throw new Error(reason || `analytics_http_${response.status}`);
        }
        return payload;
    }

    function paramsForOverview(): URLSearchParams {
        const params = new URLSearchParams({ asOf: state.asOf, window: String(state.windowDays) });
        if (state.operator) params.set("operator", state.operator);
        if (state.category) params.set("category", state.category);
        return params;
    }

    function paramsForRanking(): URLSearchParams {
        return new URLSearchParams({
            asOf: state.asOf,
            window: String(state.windowDays),
            dimension: state.dimension,
            sort: state.rankSort,
            direction: state.rankDirection,
            minimumSample: String(state.meta?.minimumRankingSample || 100),
            limit: "25"
        });
    }

    function paramsForDashboardRanking(dimension: AnalyticsDimension): URLSearchParams {
        return new URLSearchParams({
            asOf: state.asOf,
            window: String(state.windowDays),
            dimension,
            sort: "sample",
            direction: "desc",
            minimumSample: String(state.meta?.minimumRankingSample || 100),
            limit: "25"
        });
    }

    function paramsForOutliers(): URLSearchParams {
        const params = new URLSearchParams({ asOf: state.asOf, window: String(state.windowDays), limit: "25" });
        if (state.operator) params.set("operator", state.operator);
        if (state.category) params.set("category", state.category);
        return params;
    }

    function paramsForExplore(): URLSearchParams {
        const params = paramsForOverview();
        if (state.station) params.set("station", state.station);
        return params;
    }

    function setStatus(message: string, tone: "info" | "warning" = "info"): void {
        const target = $("statisticsAnalyticsStatus");
        if (!target) return;
        target.hidden = false;
        target.classList.toggle("statistics-status-info", tone === "info");
        target.textContent = message;
    }

    function clearStatus(): void {
        const target = $("statisticsAnalyticsStatus");
        if (target) target.hidden = true;
    }

    function analyticsErrorMessage(error: unknown): string {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === "analytics_not_built" || reason === "analytics_http_404") return tr("statistics_analytics_not_built", "Historical analytics have not been published yet.");
        if (reason === "analytics_window_not_available") return tr("statistics_analytics_window_unavailable", "This historical window is not available.");
        return tr("statistics_analytics_unavailable", "Historical analytics are temporarily unavailable.");
    }

    function syncModeButtons(): void {
        document.querySelector<HTMLElement>(".statistics-page")?.classList.toggle("statistics-performance-active", state.mode === "performance");
        document.querySelectorAll<HTMLButtonElement>("[data-statistics-mode]").forEach((button) => {
            const selected = button.dataset.statisticsMode === state.mode;
            button.classList.toggle("active", selected);
            button.setAttribute("aria-selected", String(selected));
        });
        setHidden($("statisticsLiveControls"), state.mode !== "live");
        setHidden($("statisticsLiveView"), state.mode !== "live");
        setHidden($("statisticsPerformanceView"), state.mode !== "performance");
    }

    function updateUrl(): void {
        const url = new URL(window.location.href);
        if (state.mode === "performance") {
            url.searchParams.set("mode", "performance");
            url.searchParams.set("window", String(state.windowDays));
            if (state.asOf) url.searchParams.set("asOf", state.asOf);
            if (state.operator) url.searchParams.set("operator", state.operator); else url.searchParams.delete("operator");
            if (state.category) url.searchParams.set("category", state.category); else url.searchParams.delete("category");
            url.searchParams.set("dimension", state.dimension);
            if (state.topic !== "overview") url.searchParams.set("topic", state.topic); else url.searchParams.delete("topic");
            if (state.station) url.searchParams.set("station", state.station); else url.searchParams.delete("station");
        } else {
            ["mode", "window", "asOf", "operator", "category", "dimension", "topic", "station"].forEach((key) => url.searchParams.delete(key));
        }
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }

    function readUrlState(): void {
        const params = new URLSearchParams(window.location.search);
        state.mode = params.get("mode") === "performance" ? "performance" : "live";
        const windowValue = Number(params.get("window"));
        if (windowValue === 7 || windowValue === 28 || windowValue === 90) state.windowDays = windowValue;
        state.asOf = params.get("asOf") || "";
        state.operator = params.get("operator") || "";
        state.category = (params.get("category") || "").toUpperCase();
        state.station = params.get("station") || "";
        const dimension = params.get("dimension");
        if (dimension === "operator" || dimension === "category" || dimension === "station" || dimension === "relation") state.dimension = dimension;
        const topic = params.get("topic");
        if (topic === "mix" || topic === "rhythm" || topic === "stations" || topic === "routes" || topic === "services" || topic === "quality") state.topic = topic;
    }

    async function setMode(mode: StatisticsMode): Promise<void> {
        state.mode = mode;
        syncModeButtons();
        updateUrl();
        if (mode === "performance") {
            await ensureAnalyticsLoaded();
            requestAnimationFrame(() => renderCharts());
        }
    }

    function dateRange(from: string, to: string): string[] {
        const result: string[] = [];
        const cursor = new Date(`${to}T12:00:00Z`);
        const minimum = new Date(`${from}T12:00:00Z`);
        while (cursor >= minimum && result.length < 740) {
            result.push(cursor.toISOString().slice(0, 10));
            cursor.setUTCDate(cursor.getUTCDate() - 1);
        }
        return result;
    }

    function displayDate(value: string): string {
        const parsed = new Date(`${value}T12:00:00Z`);
        return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: "Europe/Rome" }).format(parsed);
    }

    function displayTimestamp(value: string): string {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Rome" }).format(parsed);
    }

    function operatorLabel(value: string | null, fallback?: string | null): string {
        const label = statisticsOperatorLabel(value, fallback);
        return label || tr("statistics_unknown", "Unknown");
    }

    function fillSelect(select: HTMLSelectElement | null, items: Array<{ key: string; label: string }>, allLabel: string, selected: string): void {
        if (!select) return;
        select.replaceChildren();
        const all = element("option", "", allLabel);
        all.value = "";
        select.append(all);
        for (const item of items) {
            const option = element("option", "", item.label);
            option.value = item.key;
            select.append(option);
        }
        select.value = selected;
    }

    function syncFilterControls(): void {
        document.querySelectorAll<HTMLButtonElement>("[data-analytics-window]").forEach((button) => {
            const selected = Number(button.dataset.analyticsWindow) === state.windowDays;
            button.classList.toggle("active", selected);
            button.setAttribute("aria-pressed", String(selected));
        });
        document.querySelectorAll<HTMLButtonElement>("[data-analytics-topic]").forEach((button) => {
            button.addEventListener("click", () => {
                const topic = button.dataset.analyticsTopic;
                if (topic === "overview" || topic === "mix" || topic === "rhythm" || topic === "stations" || topic === "routes" || topic === "services" || topic === "quality") setTopic(topic);
            });
        });
        $("statisticsAnalyticsTopics")?.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
            const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-analytics-topic]")];
            const current = buttons.findIndex((button) => button.dataset.analyticsTopic === state.topic);
            const nextIndex = event.key === "Home"
                ? 0
                : event.key === "End"
                    ? buttons.length - 1
                    : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
            const next = buttons[nextIndex];
            const topic = next?.dataset.analyticsTopic;
            if (!next || !topic) return;
            event.preventDefault();
            next.focus();
            if (topic === "overview" || topic === "mix" || topic === "rhythm" || topic === "stations" || topic === "routes" || topic === "services" || topic === "quality") setTopic(topic);
        });
        const asOf = $<HTMLSelectElement>("statisticsAnalyticsAsOf");
        const operator = $<HTMLSelectElement>("statisticsAnalyticsOperator");
        const category = $<HTMLSelectElement>("statisticsAnalyticsCategory");
        const dimension = $<HTMLSelectElement>("statisticsAnalyticsDimension");
        const sort = $<HTMLSelectElement>("statisticsAnalyticsRankSort");
        if (asOf) asOf.value = state.asOf;
        if (operator) operator.value = state.operator;
        if (category) category.value = state.category;
        if (dimension) dimension.value = state.dimension;
        if (sort) sort.value = state.rankSort;
    }

    function renderMeta(meta: AnalyticsMeta): void {
        const asOf = $<HTMLSelectElement>("statisticsAnalyticsAsOf");
        if (asOf) {
            asOf.replaceChildren();
            for (const value of dateRange(meta.serviceDate.availableFrom, meta.serviceDate.availableTo)) {
                const option = element("option", "", displayDate(value));
                option.value = value;
                asOf.append(option);
            }
        }
        fillSelect(
            $<HTMLSelectElement>("statisticsAnalyticsOperator"),
            meta.dimensions.operator.map((item) => ({ key: item.key, label: operatorLabel(item.key, item.label) })),
            tr("statistics_all_operators", "All operators"),
            state.operator
        );
        fillSelect(
            $<HTMLSelectElement>("statisticsAnalyticsCategory"),
            meta.dimensions.category.map((item) => ({ key: item.key, label: item.label })),
            tr("statistics_all_categories", "All categories"),
            state.category
        );
        $("statisticsAnalyticsFreshness")!.textContent = displayDate(meta.asOfDate);
        $("statisticsAnalyticsFreshness")!.title = `${tr("statistics_read_model_built", "Read model built")} ${displayTimestamp(meta.builtAt)}`;
        $("statisticsAnalyticsMetricVersion")!.textContent = meta.metricDefinitionVersion;
        syncFilterControls();
    }

    function comparisonText(current: number | null, previous: number | null, lowerIsBetter = false, suffix = " pp"): { text: string; tone: string } {
        const change = percentagePointChange(current, previous);
        if (change === null) return { text: tr("statistics_no_previous_window", "No previous complete window"), tone: "neutral" };
        const sign = change > 0 ? "+" : "";
        const better = lowerIsBetter ? change < 0 : change > 0;
        const worse = lowerIsBetter ? change > 0 : change < 0;
        return {
            text: `${sign}${formatAnalyticsNumber(change, locale(), 1)}${suffix} · ${tr("statistics_vs_previous_window", "vs previous window")}`,
            tone: better ? "good" : worse ? "bad" : "neutral"
        };
    }

    function renderMetricCard(options: {
        icon: string;
        label: string;
        value: string;
        sample: string;
        comparison: { text: string; tone: string };
        tone: string;
    }): HTMLElement {
        const article = element("article", `statistics-performance-metric statistics-performance-metric-${options.tone}`);
        const icon = element("span", "material-symbols-outlined", options.icon);
        icon.setAttribute("aria-hidden", "true");
        const body = element("div", "statistics-performance-metric-body");
        body.append(element("span", "statistics-performance-metric-label", options.label));
        body.append(element("strong", "statistics-performance-metric-value", options.value));
        body.append(element("span", "statistics-performance-metric-sample", options.sample));
        const comparison = element("span", `statistics-performance-metric-change statistics-performance-change-${options.comparison.tone}`, options.comparison.text);
        body.append(comparison);
        article.append(icon, body);
        return article;
    }

    function sampleText(numerator: number, denominator: number): string {
        return `${tr("statistics_sample", "sample")} ${formatAnalyticsNumber(denominator, locale())} · ${formatAnalyticsNumber(numerator, locale())}/${formatAnalyticsNumber(denominator, locale())}`;
    }

    function rateTableText(percent: number | null, numerator: number, denominator: number): string {
        return `${formatAnalyticsPercent(percent, locale())} · ${formatAnalyticsNumber(numerator, locale())}/${formatAnalyticsNumber(denominator, locale())}`;
    }

    function renderMetrics(overview: AnalyticsOverview): void {
        const target = $("statisticsAnalyticsMetrics");
        if (!target) return;
        const current = overview.current;
        const previous = overview.previous;
        const cards = [
            {
                icon: "timer",
                label: tr("statistics_metric_within_5", "Arrivals within 5 min"),
                value: formatAnalyticsPercent(current.punctuality.within5.percent, locale()),
                sample: sampleText(current.punctuality.within5.numerator, current.punctuality.within5.denominator),
                comparison: comparisonText(current.punctuality.within5.percent, previous?.punctuality.within5.percent ?? null),
                tone: "blue"
            },
            {
                icon: "schedule",
                label: tr("statistics_metric_within_15", "Arrivals within 15 min"),
                value: formatAnalyticsPercent(current.punctuality.within15.percent, locale()),
                sample: sampleText(current.punctuality.within15.numerator, current.punctuality.within15.denominator),
                comparison: comparisonText(current.punctuality.within15.percent, previous?.punctuality.within15.percent ?? null),
                tone: "teal"
            },
            {
                icon: "cancel",
                label: tr("statistics_metric_cancellation", "Cancellation"),
                value: formatAnalyticsPercent(current.cancellation.percent, locale()),
                sample: sampleText(current.cancellation.numerator, current.cancellation.denominator),
                comparison: comparisonText(current.cancellation.percent, previous?.cancellation.percent ?? null, true),
                tone: "red"
            },
            {
                icon: "moving",
                label: tr("statistics_metric_p90", "P90 arrival delay"),
                value: `${formatAnalyticsNumber(current.delayMinutes.p90, locale(), 1)} ${tr("statistics_minutes_short", "min")}`,
                sample: `${tr("statistics_arrival_sample", "arrival sample")} ${formatAnalyticsNumber(current.arrivalSample, locale())}`,
                comparison: comparisonText(current.delayMinutes.p90, previous?.delayMinutes.p90 ?? null, true, ` ${tr("statistics_minutes_short", "min")}`),
                tone: "orange"
            },
            {
                icon: "warning",
                label: tr("statistics_metric_over_60", "Arrivals over 60 min"),
                value: formatAnalyticsPercent(current.severeDelay.over60.percent, locale()),
                sample: sampleText(current.severeDelay.over60.numerator, current.severeDelay.over60.denominator),
                comparison: comparisonText(current.severeDelay.over60.percent, previous?.severeDelay.over60.percent ?? null, true),
                tone: "red"
            },
            {
                icon: "rule",
                label: tr("statistics_eligible_coverage", "Outcome eligibility"),
                value: formatAnalyticsPercent(current.observedServices > 0 ? current.outcomeEligibleServices * 100 / current.observedServices : null, locale()),
                sample: `${formatAnalyticsNumber(current.excludedServices, locale())} ${tr("statistics_services_excluded", "services excluded")}`,
                comparison: { text: tr("statistics_missing_not_zero", "Missing evidence is not treated as zero"), tone: "neutral" },
                tone: "neutral"
            }
        ];
        target.replaceChildren(...cards.map(renderMetricCard));
    }

    function renderQuality(overview: AnalyticsOverview): void {
        $("statisticsAnalyticsObserved")!.textContent = formatAnalyticsNumber(overview.current.observedServices, locale());
        const rail = document.querySelector<HTMLElement>(".statistics-quality-rail");
        rail?.classList.toggle("statistics-quality-partial", !overview.context.windowComplete);
        const qualityIcon = rail?.querySelector<HTMLElement>(".statistics-quality-summary > .material-symbols-outlined");
        if (qualityIcon) qualityIcon.textContent = overview.context.windowComplete ? "verified" : "info";
        const coverage = $("statisticsAnalyticsCoverage");
        const detail = $("statisticsAnalyticsCoverageDetail");
        if (coverage) coverage.textContent = `${overview.current.serviceDays}/${overview.context.windowDays} ${tr("statistics_service_days_available", "service days available")}`;
        if (detail) {
            const filter = overview.context.filter.type
                ? ` · ${overview.context.filter.type === "operator" ? tr("statistics_operator", "Operator") : tr("statistics_category", "Category")}: ${overview.context.filter.type === "operator" ? operatorLabel(overview.context.filter.key) : overview.context.filter.key}`
                : "";
            detail.textContent = `${displayDate(overview.context.windowStart)} – ${displayDate(overview.context.asOfDate)} · ${overview.quality.completeDays}/${overview.quality.days} ${tr("statistics_complete_collection_days", "complete collection days")}${filter}`;
        }
    }

    function createCell(label: string, value: string, column: string): HTMLTableCellElement {
        const cell = element("td", "", value);
        cell.dataset.label = label;
        cell.dataset.column = column;
        return cell;
    }

    function renderRanking(ranking: AnalyticsRankingPayload): void {
        const head = $("statisticsAnalyticsRankingHead");
        const body = $("statisticsAnalyticsRankingBody");
        if (!head || !body) return;
        const labels = [
            tr(`statistics_dimension_${ranking.dimension}`, "Dimension"),
            tr("statistics_arrival_sample", "Arrival sample"),
            tr("statistics_metric_punctuality_5", "Within 5 min"),
            tr("statistics_metric_punctuality_15", "Within 15 min"),
            tr("statistics_metric_cancellation", "Cancellation"),
            tr("statistics_metric_p90", "P90 delay")
        ];
        const row = element("tr");
        labels.forEach((label, index) => {
            const th = element("th");
            if (index === 0) {
                th.textContent = label;
            } else {
                const sortForIndex: AnalyticsRankingSort | null = index === 1 ? "sample" : index === 2 ? "punctuality" : index === 4 ? "cancellation" : index === 5 ? "p90" : null;
                if (sortForIndex) {
                    const button = element("button", "statistics-sort-button", label);
                    button.type = "button";
                    button.dataset.rankSort = sortForIndex;
                    if (state.rankSort === sortForIndex) {
                        const arrow = element("span", "material-symbols-outlined", state.rankDirection === "asc" ? "arrow_upward" : "arrow_downward");
                        arrow.setAttribute("aria-hidden", "true");
                        button.append(arrow);
                    }
                    th.append(button);
                } else {
                    th.textContent = label;
                }
            }
            row.append(th);
        });
        head.replaceChildren(row);
        if (ranking.items.length === 0) {
            const emptyRow = element("tr", "statistics-table-message");
            const cell = createCell("", tr("statistics_no_comparable_rows", "No rows meet the comparison sample threshold."), "message");
            cell.colSpan = labels.length;
            emptyRow.append(cell);
            body.replaceChildren(emptyRow);
            return;
        }
        const rows = ranking.items.map((item) => {
            const tableRow = element("tr");
            const label = ranking.dimension === "operator" ? operatorLabel(item.key, item.label) : item.label;
            tableRow.append(
                createCell(labels[0]!, label, "dimension"),
                createCell(labels[1]!, formatAnalyticsNumber(item.arrivalSample, locale()), "sample"),
                createCell(labels[2]!, rateTableText(item.punctuality.within5.percent, item.punctuality.within5.numerator, item.punctuality.within5.denominator), "punctuality"),
                createCell(labels[3]!, rateTableText(item.punctuality.within15.percent, item.punctuality.within15.numerator, item.punctuality.within15.denominator), "punctuality15"),
                createCell(labels[4]!, rateTableText(item.cancellation.percent, item.cancellation.numerator, item.cancellation.denominator), "cancellation"),
                createCell(labels[5]!, `${formatAnalyticsNumber(item.delayMinutes.p90, locale(), 1)} ${tr("statistics_minutes_short", "min")}`, "p90")
            );
            return tableRow;
        });
        body.replaceChildren(...rows);
        head.querySelectorAll<HTMLButtonElement>("[data-rank-sort]").forEach((button) => {
            button.addEventListener("click", () => {
                const next = button.dataset.rankSort as AnalyticsRankingSort;
                if (state.rankSort === next) state.rankDirection = state.rankDirection === "asc" ? "desc" : "asc";
                else {
                    state.rankSort = next;
                    state.rankDirection = next === "punctuality" ? "asc" : "desc";
                }
                void loadAnalytics();
            });
        });
    }

    function renderOutliers(payload: AnalyticsOutlierPayload): void {
        const head = $("statisticsAnalyticsOutlierHead");
        const body = $("statisticsAnalyticsOutlierBody");
        if (!head || !body) return;
        const labels = [
            tr("statistics_service_date", "Service date"),
            tr("statistics_train", "Train"),
            tr("statistics_route", "Route"),
            tr("statistics_operator", "Operator"),
            tr("statistics_arrival_delay", "Arrival delay"),
            tr("statistics_observations", "Observations")
        ];
        const headerRow = element("tr");
        labels.forEach((label) => headerRow.append(element("th", "", label)));
        head.replaceChildren(headerRow);
        if (payload.items.length === 0) {
            const emptyRow = element("tr", "statistics-table-message");
            const cell = createCell("", tr("statistics_no_outliers", "No disrupted services are available for this window."), "message");
            cell.colSpan = labels.length;
            emptyRow.append(cell);
            body.replaceChildren(emptyRow);
            return;
        }
        const rows = payload.items.map((item) => {
            const row = element("tr");
            row.title = item.train_key;
            const train = `${item.category ? `${item.category} ` : ""}${item.train_number}`;
            const route = [item.origin, item.destination].filter(Boolean).join(" → ") || item.relation_key || "—";
            const delay = item.cancelled
                ? tr("statistics_status_cancelled", "Cancelled")
                : `${formatAnalyticsNumber(item.final_arrival_delay, locale(), 0)} ${tr("statistics_minutes_short", "min")}`;
            row.append(
                createCell(labels[0]!, displayDate(item.service_date), "date"),
                createCell(labels[1]!, train, "train"),
                createCell(labels[2]!, route, "route"),
                createCell(labels[3]!, operatorLabel(item.operator), "operator"),
                createCell(labels[4]!, delay, "delay"),
                createCell(labels[5]!, formatAnalyticsNumber(item.observation_count, locale()), "observations")
            );
            return row;
        });
        body.replaceChildren(...rows);
    }

    function syncTopicPanels(): void {
        document.querySelectorAll<HTMLButtonElement>("[data-analytics-topic]").forEach((button) => {
            const selected = button.dataset.analyticsTopic === state.topic;
            button.classList.toggle("active", selected);
            button.setAttribute("aria-selected", String(selected));
            button.tabIndex = selected ? 0 : -1;
        });
        document.querySelectorAll<HTMLElement>("[data-analytics-topic-panel]").forEach((panel) => {
            panel.hidden = panel.dataset.analyticsTopicPanel !== state.topic;
        });
        const methodology = document.querySelector<HTMLDetailsElement>("details.statistics-methodology");
        if (methodology && state.topic === "quality") methodology.open = true;
    }

    function setTopic(topic: AnalyticsTopic): void {
        state.topic = topic;
        syncTopicPanels();
        updateUrl();
        requestAnimationFrame(() => void renderCharts());
    }

    function metricChange(current: number, previous: number): string {
        if (previous <= 0) return tr("statistics_no_previous_window", "No previous complete window");
        const change = (current - previous) * 100 / previous;
        const sign = change > 0 ? "+" : "";
        return `${sign}${formatAnalyticsNumber(change, locale(), 1)}% · ${tr("statistics_vs_previous_window", "vs previous window")}`;
    }

    function renderLeaderboard(
        targetId: string,
        items: Array<{ key: string; label: string; value: number; detail: string; comparison?: string; color?: string }>
    ): void {
        const target = $(targetId);
        if (!target) return;
        if (!items.length) {
            target.replaceChildren(element("p", "statistics-dashboard-empty", tr("statistics_no_comparable_rows", "No rows meet the comparison sample threshold.")));
            return;
        }
        const maximum = Math.max(...items.map((item) => item.value), 1);
        target.replaceChildren(...items.slice(0, 15).map((item, index) => {
            const row = element("article", "statistics-leaderboard-row");
            row.dataset.key = item.key;
            const rank = element("span", "statistics-leaderboard-rank", String(index + 1).padStart(2, "0"));
            const body = element("div", "statistics-leaderboard-body");
            const heading = element("div", "statistics-leaderboard-heading");
            const title = element("strong", "", item.label);
            if (item.color) {
                const marker = element("span", "statistics-leaderboard-marker");
                marker.setAttribute("aria-hidden", "true");
                marker.style.backgroundColor = item.color;
                title.prepend(marker);
                row.style.setProperty("--statistics-item-color", item.color);
            }
            heading.append(title, element("span", "", formatAnalyticsNumber(item.value, locale())));
            const track = element("div", "statistics-leaderboard-track");
            const fill = element("span", "statistics-leaderboard-fill");
            fill.style.width = `${Math.max(2, item.value * 100 / maximum)}%`;
            track.append(fill);
            const meta = element("div", "statistics-leaderboard-meta");
            meta.append(element("span", "", item.detail));
            if (item.comparison) meta.append(element("span", "", item.comparison));
            body.append(heading, track, meta);
            row.append(rank, body);
            return row;
        }));
    }

    function dashboardRankingItems(dimension: AnalyticsDimension): AnalyticsRankingPayload["items"] {
        return state.rankings[dimension]?.items ?? [];
    }

    function renderStationLeaderboard(explore: AnalyticsExplore | null): void {
        if (explore) {
            renderLeaderboard("statisticsStationLeaderboard", explore.network.stations.map((item, index) => ({
                key: item.key,
                label: item.label,
                value: item.observedServices,
                color: statisticsStationColor(index),
                detail: `${tr("statistics_roles_arrival", "Arrivals")} ${formatAnalyticsPercent(item.roles.arrivalPercent, locale())} · ${tr("statistics_roles_departure", "Departures")} ${formatAnalyticsPercent(item.roles.departurePercent, locale())} · ${tr("statistics_roles_transit", "Transit")} ${formatAnalyticsPercent(item.roles.transitPercent, locale())}`,
                comparison: metricChange(item.observedServices, item.previousObservedServices)
            })));
            return;
        }
        renderLeaderboard("statisticsStationLeaderboard", dashboardRankingItems("station").map((item, index) => ({
            key: item.key,
            label: item.label,
            value: item.observedServices,
            color: statisticsStationColor(index),
            detail: `${tr("statistics_metric_punctuality_5", "Within 5 min")} ${formatAnalyticsPercent(item.punctuality.within5.percent, locale())} · ${tr("statistics_arrival_sample", "Arrival sample")} ${formatAnalyticsNumber(item.arrivalSample, locale())}`
        })));
    }

    function renderRelationLeaderboard(explore: AnalyticsExplore | null): void {
        if (explore) {
            renderLeaderboard("statisticsRelationLeaderboard", explore.network.relations.map((item) => ({
                key: item.key,
                label: item.label,
                value: item.observedServices,
                detail: `${tr("statistics_metric_punctuality_5", "Within 5 min")} ${formatAnalyticsPercent(item.punctuality.within5.percent, locale())} · P90 ${formatAnalyticsNumber(item.delayMinutes.p90, locale(), 1)} ${tr("statistics_minutes_short", "min")}`,
                comparison: metricChange(item.observedServices, item.previousObservedServices)
            })));
            return;
        }
        renderLeaderboard("statisticsRelationLeaderboard", dashboardRankingItems("relation").map((item) => ({
            key: item.key,
            label: item.label,
            value: item.observedServices,
            detail: `${tr("statistics_metric_punctuality_5", "Within 5 min")} ${formatAnalyticsPercent(item.punctuality.within5.percent, locale())} · P90 ${formatAnalyticsNumber(item.delayMinutes.p90, locale(), 1)} ${tr("statistics_minutes_short", "min")}`
        })));
    }

    function renderStationSelect(explore: AnalyticsExplore): void {
        const select = $<HTMLSelectElement>("statisticsAnalyticsStation");
        if (!select) return;
        select.disabled = false;
        const selected = explore.network.stationRhythm.stationCode || state.station || explore.network.stations[0]?.key || "";
        select.replaceChildren(...explore.network.stations.map((station) => {
            const option = element("option", "", `${station.label} · ${formatAnalyticsNumber(station.observedServices, locale())}`);
            option.value = station.key;
            return option;
        }));
        if (selected) select.value = selected;
        state.station = selected;
    }

    function renderCrossMidnight(explore: AnalyticsExplore): void {
        const metric = explore.services.crossMidnight;
        const value = $("statisticsCrossMidnightRate");
        const sample = $("statisticsCrossMidnightSample");
        if (value) value.textContent = formatAnalyticsPercent(metric.percent, locale());
        if (sample) sample.textContent = `${formatAnalyticsNumber(metric.numerator, locale())}/${formatAnalyticsNumber(metric.denominator, locale())} ${tr("statistics_observed_services", "observed services")} · P90 ${formatAnalyticsNumber(metric.durationP90Minutes, locale(), 0)} ${tr("statistics_minutes_short", "min")}`;
    }

    function renderJourneys(explore: AnalyticsExplore): void {
        const target = $("statisticsLongestJourneys");
        if (!target) return;
        if (!explore.services.longestJourneys.length) {
            target.replaceChildren(element("p", "statistics-dashboard-empty", tr("statistics_no_chart_data", "No chart data")));
            return;
        }
        target.replaceChildren(...explore.services.longestJourneys.map((journey, index) => {
            const row = element("article", "statistics-journey-row");
            const rank = element("span", "statistics-journey-rank", String(index + 1).padStart(2, "0"));
            const body = element("div", "statistics-journey-body");
            const title = element("strong", "", `${journey.category ? `${journey.category} ` : ""}${journey.train_number}`);
            const route = element("span", "", `${journey.origin ?? journey.origin_code ?? "—"} → ${journey.destination ?? journey.destination_code ?? "—"}`);
            const tags = element("div", "statistics-journey-tags");
            tags.append(
                element("span", "", operatorLabel(journey.operator)),
                element("span", "", `${formatAnalyticsNumber(journey.scheduled_duration_minutes, locale(), 0)} ${tr("statistics_minutes_short", "min")}`)
            );
            if (journey.cross_midnight) tags.append(element("span", "statistics-journey-night", tr("statistics_cross_midnight", "Cross-midnight")));
            body.append(title, route, tags);
            row.append(rank, body);
            return row;
        }));
    }

    function renderSpotlight(explore: AnalyticsExplore): void {
        const service = explore.services.spotlight.service;
        const title = $("statisticsSpotlightTitle");
        const observations = $("statisticsSpotlightObservations");
        const facts = $("statisticsSpotlightFacts");
        if (!service) {
            if (title) title.textContent = tr("statistics_no_outliers", "No disrupted services are available for this window.");
            if (observations) observations.textContent = "—";
            facts?.replaceChildren();
            return;
        }
        if (title) title.textContent = `${service.category ? `${service.category} ` : ""}${service.train_number} · ${service.origin ?? "—"} → ${service.destination ?? "—"}`;
        if (observations) observations.textContent = `${formatAnalyticsNumber(service.observation_count, locale())} ${tr("statistics_observations", "observations")}`;
        if (facts) {
            const values = [
                [tr("statistics_service_date", "Service date"), displayDate(service.service_date)],
                [tr("statistics_operator", "Operator"), operatorLabel(service.operator)],
                [tr("statistics_arrival_delay", "Arrival delay"), service.cancelled ? tr("statistics_status_cancelled", "Cancelled") : `${formatAnalyticsNumber(service.final_arrival_delay, locale(), 0)} ${tr("statistics_minutes_short", "min")}`],
                [tr("statistics_station_count", "Stops"), formatAnalyticsNumber(explore.services.spotlight.stops.length, locale())]
            ];
            facts.replaceChildren(...values.map(([label, value]) => {
                const item = element("div");
                item.append(element("span", "", label), element("strong", "", value));
                return item;
            }));
        }
    }

    function renderDataTable(targetId: string, columns: string[], rows: string[][]): void {
        const target = $(targetId);
        if (!target) return;
        const details = element("details", "statistics-chart-data-details");
        details.append(element("summary", "", tr("statistics_view_chart_data", "View chart data table")));
        const wrap = element("div", "statistics-chart-data-scroll");
        const table = element("table");
        const head = element("thead");
        const headRow = element("tr");
        columns.forEach((column) => headRow.append(element("th", "", column)));
        head.append(headRow);
        const body = element("tbody");
        rows.forEach((values) => {
            const row = element("tr");
            values.forEach((value) => row.append(element("td", "", value)));
            body.append(row);
        });
        table.append(head, body);
        wrap.append(table);
        details.append(wrap);
        target.replaceChildren(details);
    }

    function renderExploreTables(explore: AnalyticsExplore): void {
        renderDataTable("statisticsOperatorMixTable", [tr("statistics_operator", "Operator"), tr("statistics_observed_services", "Observed services"), tr("statistics_share", "Share")], explore.composition.operators.map((item) => [operatorLabel(item.key, item.label), formatAnalyticsNumber(item.observedServices, locale()), formatAnalyticsPercent(item.sharePercent, locale())]));
        renderDataTable("statisticsCategoryMixTable", [tr("statistics_category", "Category"), tr("statistics_observed_services", "Observed services"), tr("statistics_share", "Share")], explore.composition.categories.map((item) => [item.label, formatAnalyticsNumber(item.observedServices, locale()), formatAnalyticsPercent(item.sharePercent, locale())]));
        renderDataTable("statisticsOperatorCategoryTable", [tr("statistics_operator", "Operator"), tr("statistics_category", "Category"), tr("statistics_observed_services", "Observed services")], explore.composition.matrix.map((item) => [operatorLabel(item.operator), item.category, formatAnalyticsNumber(item.observedServices, locale())]));
        renderDataTable("statisticsNetworkRhythmTable", [tr("statistics_weekday", "Weekday"), tr("statistics_hour", "Hour"), tr("statistics_observed_services", "Observed services")], explore.rhythm.map((item) => [chartLabels().weekdays[item.weekday] ?? String(item.weekday), `${String(item.hour).padStart(2, "0")}:00`, formatAnalyticsNumber(item.observedServices, locale())]));
        renderDataTable("statisticsCategoryRhythmTable", [tr("statistics_category", "Category"), tr("statistics_hour", "Hour"), tr("statistics_observed_services", "Observed services")], explore.categoryRhythm.map((item) => [item.category, `${String(item.hour).padStart(2, "0")}:00`, formatAnalyticsNumber(item.observedServices, locale())]));
        renderDataTable("statisticsStationScatterTable", [tr("statistics_station", "Station"), tr("statistics_observed_services", "Observed services"), tr("statistics_metric_punctuality_5", "Within 5 min")], explore.network.stations.map((item) => [item.label, formatAnalyticsNumber(item.observedServices, locale()), formatAnalyticsPercent(item.punctuality.within5.percent, locale())]));
        renderDataTable("statisticsStationRhythmTable", [tr("statistics_weekday", "Weekday"), tr("statistics_hour", "Hour"), tr("statistics_observed_services", "Observed services")], explore.network.stationRhythm.items.map((item) => [chartLabels().weekdays[item.weekday] ?? String(item.weekday), `${String(item.hour).padStart(2, "0")}:00`, formatAnalyticsNumber(item.observed_services, locale())]));
        renderDataTable("statisticsDisruptionTable", [tr("statistics_route", "Route"), tr("statistics_metric_over_60", "Arrivals over 60 min"), tr("statistics_cumulative_share", "Cumulative share")], explore.services.disruptionConcentration.items.map((item) => [item.label, formatAnalyticsNumber(item.events, locale()), formatAnalyticsPercent(item.cumulativePercent, locale())]));
    }

    function renderExplore(explore: AnalyticsExplore | null): void {
        renderStationLeaderboard(explore);
        renderRelationLeaderboard(explore);
        if (!explore) {
            const operatorItems = dashboardRankingItems("operator");
            const categoryItems = dashboardRankingItems("category");
            const total = state.overview?.current.observedServices ?? 0;
            const active = $("statisticsActiveOperators");
            const activeOperators = state.meta?.dimensions.operator.filter((item) => item.key !== "unknown" && item.sample > 0).length
                ?? operatorItems.filter((item) => item.key !== "unknown" && item.observedServices > 0).length;
            if (active) active.textContent = `${formatAnalyticsNumber(activeOperators, locale())} ${tr("statistics_active_operators", "active operators")}`;
            renderDataTable("statisticsOperatorMixTable", [tr("statistics_operator", "Operator"), tr("statistics_observed_services", "Observed services"), tr("statistics_share", "Share")], operatorItems.map((item) => [operatorLabel(item.key, item.label), formatAnalyticsNumber(item.observedServices, locale()), formatAnalyticsPercent(total > 0 ? item.observedServices * 100 / total : null, locale())]));
            renderDataTable("statisticsCategoryMixTable", [tr("statistics_category", "Category"), tr("statistics_observed_services", "Observed services"), tr("statistics_share", "Share")], categoryItems.map((item) => [item.label, formatAnalyticsNumber(item.observedServices, locale()), formatAnalyticsPercent(total > 0 ? item.observedServices * 100 / total : null, locale())]));
            const unavailable = tr("statistics_extended_model_pending", "This view becomes available after the latest analytical model is published.");
            for (const id of ["statisticsOperatorCategoryTable", "statisticsNetworkRhythmTable", "statisticsCategoryRhythmTable", "statisticsStationRhythmTable", "statisticsDisruptionTable"]) {
                $(id)?.replaceChildren(element("p", "statistics-dashboard-empty", unavailable));
            }
            const stationSelect = $<HTMLSelectElement>("statisticsAnalyticsStation");
            if (stationSelect) {
                stationSelect.replaceChildren(element("option", "", unavailable));
                stationSelect.disabled = true;
            }
            const crossRate = $("statisticsCrossMidnightRate");
            const crossSample = $("statisticsCrossMidnightSample");
            const spotlightTitle = $("statisticsSpotlightTitle");
            const spotlightObservations = $("statisticsSpotlightObservations");
            if (crossRate) crossRate.textContent = "—";
            if (crossSample) crossSample.textContent = unavailable;
            if (spotlightTitle) spotlightTitle.textContent = unavailable;
            if (spotlightObservations) spotlightObservations.textContent = "—";
            $("statisticsLongestJourneys")?.replaceChildren(element("p", "statistics-dashboard-empty", unavailable));
            $("statisticsSpotlightFacts")?.replaceChildren();
            return;
        }
        const active = $("statisticsActiveOperators");
        if (active) active.textContent = `${formatAnalyticsNumber(explore.composition.activeOperators, locale())} ${tr("statistics_active_operators", "active operators")}`;
        renderStationSelect(explore);
        renderCrossMidnight(explore);
        renderJourneys(explore);
        renderSpotlight(explore);
        renderExploreTables(explore);
    }

    function renderAccessibleChartTable(targetId: string, overview: AnalyticsOverview, columns: Array<{ label: string; value: (metric: AnalyticsMetricSet) => string }>): void {
        const target = $(targetId);
        if (!target) return;
        const details = element("details", "statistics-chart-data-details");
        details.append(element("summary", "", tr("statistics_view_chart_data", "View chart data table")));
        const wrap = element("div", "statistics-chart-data-scroll");
        const table = element("table");
        const head = element("thead");
        const headRow = element("tr");
        headRow.append(element("th", "", tr("statistics_date", "Date")));
        columns.forEach((column) => headRow.append(element("th", "", column.label)));
        head.append(headRow);
        const body = element("tbody");
        for (const point of overview.series) {
            const row = element("tr");
            row.append(element("td", "", displayDate(point.date)));
            columns.forEach((column) => row.append(element("td", "", column.value(point))));
            body.append(row);
        }
        table.append(head, body);
        wrap.append(table);
        details.append(wrap);
        target.replaceChildren(details);
    }

    function chartLabels(): import("./statistics-echarts.js").AnalyticsChartLabels {
        const weekdayFormatter = new Intl.DateTimeFormat(locale(), { weekday: "narrow", timeZone: "UTC" });
        return {
            within5: tr("statistics_metric_punctuality_5", "Within 5 min"),
            within15: tr("statistics_metric_punctuality_15", "Within 15 min"),
            p50: tr("statistics_metric_p50", "P50"),
            p90: tr("statistics_metric_p90", "P90"),
            p95: tr("statistics_metric_p95", "P95"),
            over30: tr("statistics_metric_over_30", "Over 30 min"),
            over60: tr("statistics_metric_over_60", "Over 60 min"),
            over120: tr("statistics_metric_over_120", "Over 120 min"),
            noData: tr("statistics_no_chart_data", "No chart data"),
            weekdays: Array.from({ length: 7 }, (_, index) => weekdayFormatter.format(new Date(Date.UTC(2026, 0, 5 + index)))),
            delayBuckets: {
                early: tr("statistics_bucket_early", "Early"),
                "0_5": tr("statistics_bucket_0_5", "0–5"),
                "6_15": tr("statistics_bucket_6_15", "6–15"),
                "16_30": tr("statistics_bucket_16_30", "16–30"),
                "31_60": tr("statistics_bucket_31_60", "31–60"),
                "61_120": tr("statistics_bucket_61_120", "61–120"),
                over_120: tr("statistics_bucket_over_120", ">120"),
                total: tr("statistics_services", "Services")
            }
        };
    }

    async function renderCharts(): Promise<void> {
        if (state.mode !== "performance" || !state.overview) return;
        if (state.topic === "quality") return;
        state.charts ??= await import("./statistics-echarts.js");
        if (state.topic === "overview") {
            const containers = {
                punctuality: $("statisticsPunctualityTrendChart"),
                percentiles: $("statisticsDelayPercentileChart"),
                distribution: $("statisticsDelayDistributionChart"),
                severeDelay: $("statisticsSevereDelayChart"),
                calendar: $("statisticsPunctualityCalendarChart")
            };
            if (!Object.values(containers).some((item) => !item)) {
                containers.punctuality?.setAttribute("aria-label", tr("statistics_punctuality_trend", "Arrival punctuality trend"));
                containers.percentiles?.setAttribute("aria-label", tr("statistics_delay_percentiles", "Arrival delay percentiles"));
                containers.distribution?.setAttribute("aria-label", tr("statistics_delay_buckets", "Arrival delay distribution"));
                containers.severeDelay?.setAttribute("aria-label", tr("statistics_severe_delay_share", "Severe arrival delay share"));
                containers.calendar?.setAttribute("aria-label", tr("statistics_punctuality_calendar", "Punctuality calendar"));
                state.charts.renderAnalyticsCharts(containers as Record<keyof typeof containers, HTMLElement>, state.overview, chartLabels());
                renderAccessibleChartTable("statisticsPunctualityTrendTable", state.overview, [
                    { label: tr("statistics_metric_punctuality_5", "Within 5 min"), value: (metric) => formatAnalyticsPercent(metric.punctuality.within5.percent, locale()) },
                    { label: tr("statistics_metric_punctuality_15", "Within 15 min"), value: (metric) => formatAnalyticsPercent(metric.punctuality.within15.percent, locale()) },
                    { label: tr("statistics_arrival_sample", "Arrival sample"), value: (metric) => formatAnalyticsNumber(metric.arrivalSample, locale()) }
                ]);
                renderAccessibleChartTable("statisticsDelayPercentileTable", state.overview, [
                    { label: tr("statistics_metric_p50", "P50"), value: (metric) => formatAnalyticsNumber(metric.delayMinutes.p50, locale(), 1) },
                    { label: tr("statistics_metric_p90", "P90"), value: (metric) => formatAnalyticsNumber(metric.delayMinutes.p90, locale(), 1) },
                    { label: tr("statistics_metric_p95", "P95"), value: (metric) => formatAnalyticsNumber(metric.delayMinutes.p95, locale(), 1) }
                ]);
            }
        }
        const exploreLabels: import("./statistics-echarts.js").AnalyticsExploreChartLabels = {
            services: tr("statistics_observed_services", "Observed services"),
            punctuality: tr("statistics_metric_punctuality_5", "Within 5 min"),
            cumulative: tr("statistics_cumulative_share", "Cumulative share"),
            delayMinutes: tr("statistics_delay_minutes", "Delay minutes"),
            recovered: tr("statistics_recovered", "Recovered"),
            gained: tr("statistics_gained", "Gained"),
            arrivals: tr("statistics_roles_arrival", "Arrivals"),
            departures: tr("statistics_roles_departure", "Departures"),
            transits: tr("statistics_roles_transit", "Transit"),
            noData: tr("statistics_no_chart_data", "No chart data"),
            weekdays: chartLabels().weekdays
        };
        if (!state.explore) {
            const fallbackContainers: Pick<import("./statistics-echarts.js").AnalyticsExploreChartContainers, "operatorMix" | "categoryMix" | "stationScatter"> = {};
            if (state.topic === "mix") Object.assign(fallbackContainers, { operatorMix: $("statisticsOperatorMixChart"), categoryMix: $("statisticsCategoryMixChart") });
            if (state.topic === "stations") Object.assign(fallbackContainers, { stationScatter: $("statisticsStationScatterChart") });
            const operatorRanking = state.rankings.operator;
            state.charts.renderRankingFallbackCharts(fallbackContainers, {
                operator: operatorRanking ? { ...operatorRanking, items: operatorRanking.items.map((item) => ({ ...item, label: operatorLabel(item.key, item.label) })) } : undefined,
                category: state.rankings.category,
                station: state.rankings.station
            }, state.overview.current.observedServices, exploreLabels);
            return;
        }
        const exploreContainers: import("./statistics-echarts.js").AnalyticsExploreChartContainers = {};
        if (state.topic === "mix") Object.assign(exploreContainers, { operatorMix: $("statisticsOperatorMixChart"), categoryMix: $("statisticsCategoryMixChart"), operatorCategory: $("statisticsOperatorCategoryChart") });
        if (state.topic === "rhythm") Object.assign(exploreContainers, { networkRhythm: $("statisticsNetworkRhythmChart"), categoryRhythm: $("statisticsCategoryRhythmChart") });
        if (state.topic === "stations") Object.assign(exploreContainers, { stationScatter: $("statisticsStationScatterChart"), stationRhythm: $("statisticsStationRhythmChart") });
        if (state.topic === "routes") Object.assign(exploreContainers, { recovery: $("statisticsRecoveryChart"), disruption: $("statisticsDisruptionChart") });
        if (state.topic === "services") Object.assign(exploreContainers, { lifecycle: $("statisticsServiceLifecycleChart") });
        const chartExplore: AnalyticsExplore = {
            ...state.explore,
            composition: {
                ...state.explore.composition,
                operators: state.explore.composition.operators.map((item) => ({ ...item, label: operatorLabel(item.key, item.label) }))
            }
        };
        state.charts.renderExploreCharts(exploreContainers, chartExplore, exploreLabels);
    }

    function renderAnalytics(): void {
        if (!state.meta || !state.overview || !state.ranking || !state.outliers) return;
        renderMeta(state.meta);
        renderQuality(state.overview);
        renderMetrics(state.overview);
        renderRanking(state.ranking);
        renderOutliers(state.outliers);
        renderExplore(state.explore);
        syncTopicPanels();
        clearStatus();
        void renderCharts();
    }

    async function loadAnalytics(): Promise<void> {
        if (!state.meta) return;
        state.loading = true;
        const serial = ++state.requestSerial;
        setStatus(tr("statistics_analytics_loading", "Preparing historical analysis..."));
        syncFilterControls();
        updateUrl();
        try {
            const [overviewRaw, rankingRaw, outliersRaw, operatorRaw, categoryRaw, stationRaw, relationRaw, explore] = await Promise.all([
                fetchJson("/overview", paramsForOverview()),
                fetchJson("/rankings", paramsForRanking()),
                fetchJson("/outliers", paramsForOutliers()),
                fetchJson("/rankings", paramsForDashboardRanking("operator")),
                fetchJson("/rankings", paramsForDashboardRanking("category")),
                fetchJson("/rankings", paramsForDashboardRanking("station")),
                fetchJson("/rankings", paramsForDashboardRanking("relation")),
                fetchJson("/explore", paramsForExplore()).then(normalizeAnalyticsExplore).catch(() => null)
            ]);
            if (serial !== state.requestSerial) return;
            state.overview = normalizeAnalyticsOverview(overviewRaw);
            state.ranking = normalizeAnalyticsRanking(rankingRaw);
            state.outliers = normalizeAnalyticsOutliers(outliersRaw);
            state.rankings = {
                operator: normalizeAnalyticsRanking(operatorRaw),
                category: normalizeAnalyticsRanking(categoryRaw),
                station: normalizeAnalyticsRanking(stationRaw),
                relation: normalizeAnalyticsRanking(relationRaw)
            };
            state.explore = explore;
            renderAnalytics();
        } catch (error) {
            if (serial === state.requestSerial) setStatus(analyticsErrorMessage(error), "warning");
        } finally {
            if (serial === state.requestSerial) state.loading = false;
        }
    }

    async function ensureAnalyticsLoaded(): Promise<void> {
        if (state.meta) {
            if (!state.overview) await loadAnalytics();
            return;
        }
        setStatus(tr("statistics_analytics_loading", "Preparing historical analysis..."));
        try {
            state.meta = normalizeAnalyticsMeta(await fetchJson("/meta"));
            if (!state.asOf || state.asOf < state.meta.serviceDate.availableFrom || state.asOf > state.meta.serviceDate.availableTo) state.asOf = state.meta.asOfDate;
            if (!state.meta.windows.includes(state.windowDays)) state.windowDays = 28;
            if (state.operator && !state.meta.dimensions.operator.some((item) => item.key === state.operator)) state.operator = "";
            if (state.category && !state.meta.dimensions.category.some((item) => item.key === state.category)) state.category = "";
            renderMeta(state.meta);
            await loadAnalytics();
        } catch (error) {
            setStatus(analyticsErrorMessage(error), "warning");
        }
    }

    function downloadCsv(): void {
        if (!state.meta) return;
        const params = paramsForRanking();
        params.set("view", "rankings");
        window.location.href = `${API_BASE}/export.csv?${params}`;
    }

    function bindEvents(): void {
        document.querySelectorAll<HTMLButtonElement>("[data-statistics-mode]").forEach((button) => {
            button.addEventListener("click", () => void setMode(button.dataset.statisticsMode === "performance" ? "performance" : "live"));
        });
        document.querySelectorAll<HTMLButtonElement>("[data-analytics-window]").forEach((button) => {
            button.addEventListener("click", () => {
                const value = Number(button.dataset.analyticsWindow);
                if (value !== 7 && value !== 28 && value !== 90) return;
                state.windowDays = value;
                void loadAnalytics();
            });
        });
        $<HTMLSelectElement>("statisticsAnalyticsAsOf")?.addEventListener("change", (event) => {
            state.asOf = (event.currentTarget as HTMLSelectElement).value;
            void loadAnalytics();
        });
        $<HTMLSelectElement>("statisticsAnalyticsOperator")?.addEventListener("change", (event) => {
            state.operator = (event.currentTarget as HTMLSelectElement).value;
            if (state.operator) state.category = "";
            state.station = "";
            void loadAnalytics();
        });
        $<HTMLSelectElement>("statisticsAnalyticsCategory")?.addEventListener("change", (event) => {
            state.category = (event.currentTarget as HTMLSelectElement).value;
            if (state.category) state.operator = "";
            state.station = "";
            void loadAnalytics();
        });
        $<HTMLSelectElement>("statisticsAnalyticsStation")?.addEventListener("change", (event) => {
            state.station = (event.currentTarget as HTMLSelectElement).value;
            void loadAnalytics();
        });
        $<HTMLSelectElement>("statisticsAnalyticsDimension")?.addEventListener("change", (event) => {
            const value = (event.currentTarget as HTMLSelectElement).value;
            if (value === "operator" || value === "category" || value === "station" || value === "relation") state.dimension = value;
            void loadAnalytics();
        });
        $<HTMLSelectElement>("statisticsAnalyticsRankSort")?.addEventListener("change", (event) => {
            const value = (event.currentTarget as HTMLSelectElement).value;
            if (value === "punctuality" || value === "p90" || value === "cancellation" || value === "sample") state.rankSort = value;
            state.rankDirection = state.rankSort === "punctuality" ? "asc" : "desc";
            void loadAnalytics();
        });
        $<HTMLButtonElement>("statisticsAnalyticsExport")?.addEventListener("click", downloadCsv);
        state.themeObserver?.disconnect();
        state.themeObserver = new MutationObserver(() => void renderCharts());
        state.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    }

    function initAnalyticsPage(): void {
        if (!$("statisticsPerformanceView")) return;
        state.charts?.disposeAnalyticsCharts();
        state.charts = null;
        state.meta = null;
        state.overview = null;
        state.ranking = null;
        state.rankings = {};
        state.outliers = null;
        state.explore = null;
        state.loading = false;
        state.requestSerial += 1;
        readUrlState();
        bindEvents();
        syncModeButtons();
        syncFilterControls();
        syncTopicPanels();
        state.initialized = true;
        if (state.mode === "performance") void ensureAnalyticsLoaded();
    }

    onBelloLanguageChanged(() => {
        if (!state.initialized || !$("statisticsPerformanceView")) return;
        if (state.meta) renderMeta(state.meta);
        if (state.overview && state.ranking && state.outliers) renderAnalytics();
    });

    document.addEventListener("astro:before-swap", () => {
        state.charts?.disposeAnalyticsCharts();
        state.themeObserver?.disconnect();
        state.themeObserver = null;
        state.initialized = false;
    });
    document.addEventListener("astro:page-load", initAnalyticsPage);
})();
