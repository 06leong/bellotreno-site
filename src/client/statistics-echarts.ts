import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import {
    AriaComponent,
    CalendarComponent,
    DataZoomComponent,
    GridComponent,
    LegendComponent,
    TitleComponent,
    TooltipComponent,
    VisualMapComponent
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { ECharts, EChartsCoreOption } from "echarts/core";
import type { AnalyticsExplore, AnalyticsOverview, AnalyticsRankingPayload } from "../lib/normalizers/statistics-analytics.js";

echarts.use([
    LineChart,
    BarChart,
    HeatmapChart,
    ScatterChart,
    PieChart,
    AriaComponent,
    CalendarComponent,
    DataZoomComponent,
    GridComponent,
    LegendComponent,
    TitleComponent,
    TooltipComponent,
    VisualMapComponent,
    SVGRenderer
]);

export interface AnalyticsChartLabels {
    within5: string;
    within15: string;
    p50: string;
    p90: string;
    p95: string;
    over30: string;
    over60: string;
    over120: string;
    noData: string;
    weekdays: string[];
    delayBuckets: Record<string, string>;
}

export interface AnalyticsChartContainers {
    punctuality: HTMLElement;
    percentiles: HTMLElement;
    distribution: HTMLElement;
    severeDelay: HTMLElement;
    calendar: HTMLElement;
}

export interface AnalyticsExploreChartLabels {
    services: string;
    punctuality: string;
    cumulative: string;
    delayMinutes: string;
    recovered: string;
    gained: string;
    arrivals: string;
    departures: string;
    transits: string;
    noData: string;
    weekdays: string[];
}

export interface AnalyticsExploreChartContainers {
    operatorMix?: HTMLElement | null;
    categoryMix?: HTMLElement | null;
    operatorCategory?: HTMLElement | null;
    networkRhythm?: HTMLElement | null;
    categoryRhythm?: HTMLElement | null;
    stationScatter?: HTMLElement | null;
    stationRhythm?: HTMLElement | null;
    recovery?: HTMLElement | null;
    disruption?: HTMLElement | null;
    lifecycle?: HTMLElement | null;
}

export interface LiveChartDatum {
    label: string;
    value: number;
    color?: string;
    percent?: number;
}

export interface LivePunctualityGroup {
    label: string;
    segments: LiveChartDatum[];
}

export interface LiveChartData {
    running: LiveChartDatum[];
    regularity: LiveChartDatum[];
    punctuality: LivePunctualityGroup[];
    categories: LiveChartDatum[];
}

export interface LiveChartLabels {
    running: string;
    trains: string;
    noData: string;
    share: string;
}

export interface LiveChartContainers {
    running: HTMLElement;
    regularity: HTMLElement;
    punctuality: HTMLElement;
    categories: HTMLElement;
}

interface ChartTheme {
    accent: string;
    blue: string;
    green: string;
    red: string;
    purple: string;
    teal: string;
    orange: string;
    text: string;
    muted: string;
    border: string;
    surface: string;
}

const chartInstances = new Map<HTMLElement, ECharts>();
const chartScopes = new Map<HTMLElement, "analytics" | "live">();
let resizeObserver: ResizeObserver | null = null;

function cssValue(styles: CSSStyleDeclaration, name: string, fallback: string): string {
    return styles.getPropertyValue(name).trim() || fallback;
}

function readTheme(): ChartTheme {
    const page = document.querySelector<HTMLElement>(".statistics-page") ?? document.documentElement;
    const styles = getComputedStyle(page);
    return {
        accent: cssValue(styles, "--statistics-accent", "#d71920"),
        blue: cssValue(styles, "--statistics-blue", "#1769d2"),
        green: cssValue(styles, "--statistics-green", "#41d69b"),
        red: cssValue(styles, "--statistics-red", "#ff6673"),
        purple: cssValue(styles, "--statistics-purple", "#9b8cff"),
        teal: cssValue(styles, "--statistics-teal", "#078d91"),
        orange: cssValue(styles, "--statistics-orange", "#e8750a"),
        text: cssValue(styles, "--statistics-chart-text", "#edf7ff"),
        muted: cssValue(styles, "--statistics-chart-muted", "rgba(200, 218, 232, 0.66)"),
        border: cssValue(styles, "--statistics-chart-grid", "rgba(149, 180, 202, 0.16)"),
        surface: cssValue(styles, "--statistics-chart-tooltip", "#0d1b29")
    };
}

function chartFor(container: HTMLElement, scope: "analytics" | "live" = "analytics"): ECharts {
    const existing = chartInstances.get(container);
    if (existing && !existing.isDisposed()) return existing;
    const chart = echarts.init(container, undefined, { renderer: "svg" });
    chartInstances.set(container, chart);
    chartScopes.set(container, scope);
    if (!resizeObserver) {
        resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) chartInstances.get(entry.target as HTMLElement)?.resize();
        });
    }
    resizeObserver.observe(container);
    return chart;
}

function numberFormatter(): Intl.NumberFormat {
    const language = document.documentElement.lang || "en";
    return new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
}

function baseOption(theme: ChartTheme): EChartsCoreOption {
    return {
        animation: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        animationDuration: 350,
        textStyle: { color: theme.text, fontFamily: "inherit" },
        aria: { enabled: true, decal: { show: true } },
        tooltip: {
            trigger: "axis",
            renderMode: "richText",
            backgroundColor: theme.surface,
            borderColor: theme.border,
            textStyle: { color: theme.text },
            confine: true
        }
    };
}

function axis(theme: ChartTheme, percentage = false): Record<string, unknown> {
    return {
        type: "value",
        min: percentage ? 0 : undefined,
        max: percentage ? 100 : undefined,
        axisLabel: { color: theme.muted, formatter: percentage ? "{value}%" : "{value}" },
        splitLine: { lineStyle: { color: theme.border, type: "dashed" } },
        axisLine: { show: false },
        axisTick: { show: false }
    };
}

function categoryAxis(theme: ChartTheme, dates: string[]): Record<string, unknown> {
    return {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLabel: {
            color: theme.muted,
            hideOverlap: true,
            formatter: (value: string) => value.slice(5)
        },
        axisLine: { lineStyle: { color: theme.border } },
        axisTick: { show: false }
    };
}

function lineSeries(name: string, values: Array<number | null>, color: string, dashed = false): Record<string, unknown> {
    return {
        name,
        type: "line",
        data: values,
        showSymbol: values.length <= 31,
        symbolSize: 6,
        connectNulls: false,
        smooth: 0.18,
        lineStyle: { width: 2.5, type: dashed ? "dashed" : "solid", color },
        itemStyle: { color },
        emphasis: { focus: "series" }
    };
}

function renderPunctuality(container: HTMLElement, overview: AnalyticsOverview, labels: AnalyticsChartLabels, theme: ChartTheme): void {
    const dates = overview.series.map((item) => item.date);
    chartFor(container).setOption({
        ...baseOption(theme),
        color: [theme.blue, theme.teal],
        legend: { top: 0, left: 0, textStyle: { color: theme.muted } },
        grid: { top: 48, right: 18, bottom: dates.length > 31 ? 50 : 30, left: 50 },
        xAxis: categoryAxis(theme, dates),
        yAxis: axis(theme, true),
        dataZoom: dates.length > 31 ? [{ type: "inside", start: 55 }, { type: "slider", height: 16, bottom: 4, borderColor: theme.border }] : [],
        series: [
            lineSeries(labels.within5, overview.series.map((item) => item.punctuality.within5.percent), theme.blue),
            lineSeries(labels.within15, overview.series.map((item) => item.punctuality.within15.percent), theme.teal, true)
        ]
    }, { notMerge: true });
}

function renderPercentiles(container: HTMLElement, overview: AnalyticsOverview, labels: AnalyticsChartLabels, theme: ChartTheme): void {
    const dates = overview.series.map((item) => item.date);
    chartFor(container).setOption({
        ...baseOption(theme),
        color: [theme.teal, theme.orange, theme.accent],
        legend: { top: 0, left: 0, textStyle: { color: theme.muted } },
        grid: { top: 48, right: 18, bottom: dates.length > 31 ? 50 : 30, left: 48 },
        xAxis: categoryAxis(theme, dates),
        yAxis: axis(theme),
        dataZoom: dates.length > 31 ? [{ type: "inside", start: 55 }, { type: "slider", height: 16, bottom: 4, borderColor: theme.border }] : [],
        series: [
            lineSeries(labels.p50, overview.series.map((item) => item.delayMinutes.p50), theme.teal),
            lineSeries(labels.p90, overview.series.map((item) => item.delayMinutes.p90), theme.orange),
            lineSeries(labels.p95, overview.series.map((item) => item.delayMinutes.p95), theme.accent, true)
        ]
    }, { notMerge: true });
}

function renderDistribution(container: HTMLElement, overview: AnalyticsOverview, labels: AnalyticsChartLabels, theme: ChartTheme): void {
    const items = overview.current.distribution;
    chartFor(container).setOption({
        ...baseOption(theme),
        tooltip: { ...baseOption(theme).tooltip as object, trigger: "item" },
        grid: { top: 10, right: 12, bottom: 62, left: 48 },
        xAxis: {
            type: "category",
            data: items.map((item) => labels.delayBuckets[item.key] ?? item.key),
            axisLabel: { color: theme.muted, interval: 0, rotate: 28 },
            axisLine: { lineStyle: { color: theme.border } },
            axisTick: { show: false }
        },
        yAxis: axis(theme),
        series: [{
            name: labels.delayBuckets.total ?? "Services",
            type: "bar",
            data: items.map((item) => item.count),
            itemStyle: { color: theme.blue, borderRadius: [5, 5, 0, 0] },
            emphasis: { itemStyle: { color: theme.teal } }
        }]
    }, { notMerge: true });
}

function renderSevereDelay(container: HTMLElement, overview: AnalyticsOverview, labels: AnalyticsChartLabels, theme: ChartTheme): void {
    const items = [
        [labels.over30, overview.current.severeDelay.over30.percent],
        [labels.over60, overview.current.severeDelay.over60.percent],
        [labels.over120, overview.current.severeDelay.over120.percent]
    ];
    chartFor(container).setOption({
        ...baseOption(theme),
        tooltip: { ...baseOption(theme).tooltip as object, trigger: "item", valueFormatter: (value: unknown) => `${Number(value).toFixed(1)}%` },
        grid: { top: 12, right: 24, bottom: 26, left: 80 },
        xAxis: axis(theme, true),
        yAxis: {
            type: "category",
            data: items.map(([label]) => label),
            axisLabel: { color: theme.muted },
            axisLine: { show: false },
            axisTick: { show: false }
        },
        series: [{
            type: "bar",
            data: items.map(([, value]) => value),
            barMaxWidth: 24,
            itemStyle: {
                color: (parameters: { dataIndex: number }) => [theme.orange, theme.accent, "#8b1e3f"][parameters.dataIndex] ?? theme.accent,
                borderRadius: [0, 6, 6, 0]
            },
            label: { show: true, position: "right", color: theme.text, formatter: "{c}%" }
        }]
    }, { notMerge: true });
}

function renderCalendar(container: HTMLElement, overview: AnalyticsOverview, labels: AnalyticsChartLabels, theme: ChartTheme): void {
    const values = overview.series
        .filter((item) => item.punctuality.within5.percent !== null)
        .map((item) => [item.date, item.punctuality.within5.percent]);
    const percentages = values.map((item) => Number(item[1]));
    const minimum = percentages.length ? Math.floor(Math.min(...percentages)) : 0;
    const maximum = percentages.length ? Math.ceil(Math.max(...percentages)) : 100;
    chartFor(container).setOption({
        ...baseOption(theme),
        tooltip: { ...baseOption(theme).tooltip as object, trigger: "item", valueFormatter: (value: unknown) => `${Number(value).toFixed(1)}%` },
        visualMap: {
            min: minimum,
            max: Math.max(minimum + 1, maximum),
            calculable: false,
            orient: "horizontal",
            left: "center",
            bottom: 0,
            itemWidth: 12,
            itemHeight: 90,
            textStyle: { color: theme.muted },
            inRange: { color: ["#b4232c", theme.orange, "#e8c65a", theme.teal] }
        },
        calendar: {
            top: 22,
            left: 34,
            right: 12,
            bottom: 54,
            range: [overview.context.windowStart, overview.context.asOfDate],
            cellSize: ["auto", 18],
            splitLine: { show: false },
            itemStyle: { color: "transparent", borderColor: theme.border, borderWidth: 2 },
            dayLabel: { color: theme.muted, firstDay: 1, nameMap: labels.weekdays },
            monthLabel: { color: theme.muted },
            yearLabel: { show: false }
        },
        series: [{ type: "heatmap", coordinateSystem: "calendar", data: values }]
    }, { notMerge: true });
}

function emptyOption(theme: ChartTheme, label: string): EChartsCoreOption {
    return {
        ...baseOption(theme),
        title: { text: label, left: "center", top: "middle", textStyle: { color: theme.muted, fontSize: 14, fontWeight: 500 } },
        xAxis: { show: false },
        yAxis: { show: false },
        series: []
    };
}

function renderHorizontalShare(container: HTMLElement, items: Array<{ label: string; observedServices: number; sharePercent: number | null }>, labels: AnalyticsExploreChartLabels, theme: ChartTheme): void {
    const visible = items.filter((item) => item.observedServices > 0).slice(0, 12).reverse();
    if (!visible.length) {
        chartFor(container).setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    chartFor(container).setOption({
        ...baseOption(theme),
        grid: { top: 8, right: 68, bottom: 24, left: 118 },
        xAxis: axis(theme, true),
        yAxis: {
            type: "category",
            data: visible.map((item) => item.label),
            axisLabel: { color: theme.muted, width: 104, overflow: "truncate" },
            axisLine: { show: false },
            axisTick: { show: false }
        },
        series: [{
            name: labels.services,
            type: "bar",
            data: visible.map((item) => item.sharePercent),
            barMaxWidth: 20,
            itemStyle: { color: theme.blue, borderRadius: [0, 6, 6, 0] },
            label: { show: true, position: "right", color: theme.text, formatter: "{c}%" }
        }]
    }, { notMerge: true });
}

function renderMixMatrix(container: HTMLElement, explore: AnalyticsExplore, labels: AnalyticsExploreChartLabels, theme: ChartTheme): void {
    const operators = explore.composition.operators.filter((item) => item.observedServices > 0).slice(0, 10).map((item) => item.key);
    const categories = explore.composition.categories.filter((item) => item.observedServices > 0).slice(0, 12).map((item) => item.key);
    const cells = explore.composition.matrix
        .filter((item) => operators.includes(item.operator) && categories.includes(item.category))
        .map((item) => [categories.indexOf(item.category), operators.indexOf(item.operator), item.observedServices]);
    if (!cells.length) {
        chartFor(container).setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    const maximum = Math.max(...cells.map((item) => Number(item[2])), 1);
    chartFor(container).setOption({
        ...baseOption(theme),
        tooltip: { ...baseOption(theme).tooltip as object, trigger: "item" },
        grid: { top: 24, right: 24, bottom: 58, left: 118 },
        xAxis: { type: "category", data: categories, axisLabel: { color: theme.muted, rotate: 28 }, axisLine: { lineStyle: { color: theme.border } } },
        yAxis: {
            type: "category",
            data: operators,
            axisLabel: {
                color: theme.muted,
                width: 102,
                overflow: "truncate",
                formatter: (value: string) => explore.composition.operators.find((item) => item.key === value)?.label ?? value
            },
            axisLine: { show: false }
        },
        visualMap: { min: 0, max: maximum, show: false, inRange: { color: [theme.surface, theme.blue, theme.teal] } },
        series: [{ type: "heatmap", data: cells, label: { show: true, color: theme.text }, emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } } }]
    }, { notMerge: true });
}

function renderRhythmHeatmap(container: HTMLElement, items: AnalyticsExplore["rhythm"], labels: AnalyticsExploreChartLabels, theme: ChartTheme): void {
    const values = items.map((item) => [item.hour, item.weekday, item.observedServices]);
    if (!values.length) {
        chartFor(container).setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    chartFor(container).setOption({
        ...baseOption(theme),
        tooltip: { ...baseOption(theme).tooltip as object, trigger: "item" },
        grid: { top: 20, right: 20, bottom: 42, left: 54 },
        xAxis: { type: "category", data: Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`), axisLabel: { color: theme.muted, interval: 2 }, axisLine: { lineStyle: { color: theme.border } } },
        yAxis: { type: "category", data: labels.weekdays, axisLabel: { color: theme.muted }, axisLine: { show: false } },
        visualMap: { min: 0, max: Math.max(...values.map((item) => Number(item[2])), 1), show: false, inRange: { color: [theme.surface, theme.blue, theme.teal, theme.orange] } },
        series: [{ type: "heatmap", data: values, emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } } }]
    }, { notMerge: true });
}

function renderCategoryRhythm(container: HTMLElement, explore: AnalyticsExplore, labels: AnalyticsExploreChartLabels, theme: ChartTheme): void {
    const categoryTotals = new Map<string, number>();
    for (const item of explore.categoryRhythm) categoryTotals.set(item.category, (categoryTotals.get(item.category) ?? 0) + item.observedServices);
    const categories = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([key]) => key);
    if (!categories.length) {
        chartFor(container).setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    chartFor(container).setOption({
        ...baseOption(theme),
        legend: { top: 0, left: 0, textStyle: { color: theme.muted } },
        grid: { top: 54, right: 16, bottom: 34, left: 48 },
        xAxis: { type: "category", data: Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")), axisLabel: { color: theme.muted, interval: 2 }, axisLine: { lineStyle: { color: theme.border } } },
        yAxis: axis(theme),
        series: categories.map((category, index) => ({
            name: category,
            type: "line",
            showSymbol: false,
            smooth: 0.2,
            data: Array.from({ length: 24 }, (_, hour) => explore.categoryRhythm.filter((item) => item.category === category && item.hour === hour).reduce((sum, item) => sum + item.observedServices, 0)),
            lineStyle: { width: index < 3 ? 2.5 : 1.5 }
        }))
    }, { notMerge: true });
}

function renderStationScatter(container: HTMLElement, explore: AnalyticsExplore, labels: AnalyticsExploreChartLabels, theme: ChartTheme): void {
    renderStationScatterItems(container, explore.network.stations, labels, theme);
}

function renderStationScatterItems(container: HTMLElement, stations: Array<{ label: string; observedServices: number; arrivalSample: number; punctuality: { within5: { percent: number | null } } }>, labels: AnalyticsExploreChartLabels, theme: ChartTheme): void {
    const values = stations
        .filter((item) => item.punctuality.within5.percent !== null)
        .map((item) => [item.observedServices, item.punctuality.within5.percent, item.label, item.arrivalSample]);
    if (!values.length) {
        chartFor(container).setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    chartFor(container).setOption({
        ...baseOption(theme),
        tooltip: { ...baseOption(theme).tooltip as object, trigger: "item", formatter: (parameters: { value?: unknown[] }) => `${parameters.value?.[2] ?? ""}<br>${labels.services}: ${parameters.value?.[0] ?? "—"}<br>${labels.punctuality}: ${parameters.value?.[1] ?? "—"}%` },
        grid: { top: 20, right: 20, bottom: 42, left: 58 },
        xAxis: { ...axis(theme), name: labels.services, nameTextStyle: { color: theme.muted } },
        yAxis: { ...axis(theme, true), name: labels.punctuality, nameTextStyle: { color: theme.muted } },
        series: [{ type: "scatter", data: values, symbolSize: (value: unknown[]) => Math.max(8, Math.min(30, Math.sqrt(Number(value[3] ?? 0)) / 2)), itemStyle: { color: theme.blue, opacity: 0.72 } }]
    }, { notMerge: true });
}

function renderStationRhythm(container: HTMLElement, explore: AnalyticsExplore, labels: AnalyticsExploreChartLabels, theme: ChartTheme): void {
    renderRhythmHeatmap(container, explore.network.stationRhythm.items.map((item) => ({
        weekday: item.weekday,
        hour: item.hour,
        observedServices: item.observed_services,
        outcomeEligibleServices: 0,
        arrivalSample: 0,
        punctuality: { within5: { numerator: 0, denominator: 0, percent: null, confidence95: null }, within15: { numerator: 0, denominator: 0, percent: null, confidence95: null } },
        cancellation: { numerator: 0, denominator: 0, percent: null, confidence95: null },
        severeDelay: { over30: { numerator: 0, denominator: 0, percent: null, confidence95: null }, over60: { numerator: 0, denominator: 0, percent: null, confidence95: null }, over120: { numerator: 0, denominator: 0, percent: null, confidence95: null } },
        delayMinutes: { p50: null, p75: null, p90: null, p95: null, mean: null }
    })), labels, theme);
}

function renderRecovery(container: HTMLElement, explore: AnalyticsExplore, labels: AnalyticsExploreChartLabels, theme: ChartTheme): void {
    const items = explore.services.recoveryRelations.filter((item) => item.recovery.meanMinutes !== null).slice(0, 10).reverse();
    if (!items.length) {
        chartFor(container).setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    chartFor(container).setOption({
        ...baseOption(theme),
        grid: { top: 14, right: 28, bottom: 28, left: 130 },
        xAxis: { ...axis(theme), name: labels.delayMinutes, nameTextStyle: { color: theme.muted } },
        yAxis: { type: "category", data: items.map((item) => item.label), axisLabel: { color: theme.muted, width: 116, overflow: "truncate" }, axisLine: { show: false }, axisTick: { show: false } },
        series: [{ type: "bar", data: items.map((item) => item.recovery.meanMinutes), itemStyle: { color: (parameters: { value: number }) => parameters.value <= 0 ? theme.teal : theme.accent, borderRadius: 4 }, label: { show: true, position: "right", color: theme.text, formatter: "{c}" } }]
    }, { notMerge: true });
}

function renderDisruption(container: HTMLElement, explore: AnalyticsExplore, labels: AnalyticsExploreChartLabels, theme: ChartTheme): void {
    const items = explore.services.disruptionConcentration.items;
    if (!items.length) {
        chartFor(container).setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    chartFor(container).setOption({
        ...baseOption(theme),
        legend: { top: 0, left: 0, textStyle: { color: theme.muted } },
        grid: { top: 50, right: 52, bottom: 76, left: 52 },
        xAxis: { type: "category", data: items.map((item) => item.label), axisLabel: { color: theme.muted, rotate: 28, width: 110, overflow: "truncate" }, axisLine: { lineStyle: { color: theme.border } } },
        yAxis: [axis(theme), axis(theme, true)],
        series: [
            { name: labels.services, type: "bar", data: items.map((item) => item.events), itemStyle: { color: theme.accent, borderRadius: [5, 5, 0, 0] } },
            { name: labels.cumulative, type: "line", yAxisIndex: 1, data: items.map((item) => item.cumulativePercent), lineStyle: { color: theme.teal, width: 2.5 }, itemStyle: { color: theme.teal } }
        ]
    }, { notMerge: true });
}

function renderLifecycle(container: HTMLElement, explore: AnalyticsExplore, labels: AnalyticsExploreChartLabels, theme: ChartTheme): void {
    const stops = explore.services.spotlight.stops;
    if (!stops.length) {
        chartFor(container).setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    chartFor(container).setOption({
        ...baseOption(theme),
        legend: { top: 0, left: 0, textStyle: { color: theme.muted } },
        grid: { top: 48, right: 16, bottom: 58, left: 48 },
        xAxis: { type: "category", data: stops.map((item) => item.station_name ?? item.station_code ?? String(item.stop_number)), axisLabel: { color: theme.muted, rotate: 30, hideOverlap: true }, axisLine: { lineStyle: { color: theme.border } } },
        yAxis: { ...axis(theme), name: labels.delayMinutes, nameTextStyle: { color: theme.muted } },
        series: [
            lineSeries(labels.arrivals, stops.map((item) => item.arrival_delay), theme.blue),
            lineSeries(labels.departures, stops.map((item) => item.departure_delay), theme.teal, true)
        ]
    }, { notMerge: true });
}

function renderLiveRunning(container: HTMLElement, data: LiveChartDatum[], labels: LiveChartLabels, theme: ChartTheme): void {
    if (!data.length) {
        chartFor(container, "live").setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    const formatter = numberFormatter();
    const compact = window.matchMedia("(max-width: 560px)").matches;
    chartFor(container, "live").setOption({
        ...baseOption(theme),
        tooltip: {
            ...baseOption(theme).tooltip as object,
            valueFormatter: (value: unknown) => `${formatter.format(Number(value))} ${labels.trains}`
        },
        grid: { top: 18, right: compact ? 10 : 28, bottom: 34, left: compact ? 42 : 54 },
        xAxis: {
            type: "category",
            boundaryGap: false,
            data: data.map((item) => item.label),
            axisLabel: { color: theme.muted, hideOverlap: true, interval: "auto" },
            axisLine: { lineStyle: { color: theme.border } },
            axisTick: { show: false }
        },
        yAxis: { ...axis(theme), min: (value: { min: number }) => Math.max(0, Math.floor(value.min * 0.9)) },
        series: [{
            name: labels.running,
            type: "line",
            data: data.map((item, index) => ({
                value: item.value,
                label: index === data.length - 1
                    ? { show: true, position: "top", color: theme.text, fontWeight: 700, formatter: formatter.format(item.value) }
                    : { show: false }
            })),
            showSymbol: data.length <= 18,
            symbol: "circle",
            symbolSize: 7,
            smooth: 0.24,
            lineStyle: { width: 3, color: theme.blue },
            itemStyle: { color: theme.blue, borderColor: theme.surface, borderWidth: 2 },
            areaStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: "rgba(83, 168, 255, 0.38)" },
                    { offset: 1, color: "rgba(83, 168, 255, 0.02)" }
                ])
            },
            emphasis: { focus: "series" }
        }]
    }, { notMerge: true });
}

function renderLiveRegularity(container: HTMLElement, data: LiveChartDatum[], labels: LiveChartLabels, theme: ChartTheme): void {
    const visible = data.filter((item) => item.value > 0);
    if (!visible.length) {
        chartFor(container, "live").setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    const total = visible.reduce((sum, item) => sum + item.value, 0);
    const compact = window.matchMedia("(max-width: 560px)").matches;
    const formatter = numberFormatter();
    chartFor(container, "live").setOption({
        ...baseOption(theme),
        tooltip: {
            ...baseOption(theme).tooltip as object,
            trigger: "item",
            formatter: (parameters: { name?: string; value?: unknown; percent?: number }) => `${parameters.name ?? ""}<br><strong>${formatter.format(Number(parameters.value))}</strong> · ${(parameters.percent ?? 0).toFixed(1)}%`
        },
        legend: {
            orient: compact ? "horizontal" : "vertical",
            left: compact ? "center" : "58%",
            right: compact ? 0 : 8,
            bottom: compact ? 0 : "auto",
            top: compact ? "auto" : "middle",
            textStyle: { color: theme.muted, fontSize: 11 },
            itemWidth: 9,
            itemHeight: 9
        },
        graphic: [{
            type: "group",
            left: compact ? "center" : "28%",
            top: compact ? "35%" : "middle",
            children: [
                { type: "text", y: -14, style: { text: formatter.format(total), fill: theme.text, font: "700 25px sans-serif", textAlign: "center" } },
                { type: "text", y: 18, style: { text: labels.trains, fill: theme.muted, font: "12px sans-serif", textAlign: "center" } }
            ]
        }],
        series: [{
            type: "pie",
            radius: compact ? ["48%", "68%"] : ["50%", "72%"],
            center: compact ? ["50%", "37%"] : ["29%", "50%"],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: theme.surface, borderWidth: 3, borderRadius: 4 },
            label: { show: false },
            emphasis: { label: { show: true, color: theme.text, fontWeight: 700, formatter: "{d}%" }, scaleSize: 6 },
            data: visible.map((item) => ({ value: item.value, name: item.label, itemStyle: { color: item.color ?? theme.blue } }))
        }]
    }, { notMerge: true });
}

function renderLivePunctuality(container: HTMLElement, groups: LivePunctualityGroup[], labels: LiveChartLabels, theme: ChartTheme): void {
    if (!groups.some((group) => group.segments.some((item) => (item.percent ?? 0) > 0))) {
        chartFor(container, "live").setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    const segmentNames = [...new Set(groups.flatMap((group) => group.segments.map((item) => item.label)))];
    const colorByName = new Map(groups.flatMap((group) => group.segments.map((item) => [item.label, item.color ?? theme.blue] as const)));
    chartFor(container, "live").setOption({
        ...baseOption(theme),
        tooltip: {
            ...baseOption(theme).tooltip as object,
            valueFormatter: (value: unknown) => `${Number(value).toFixed(1)}%`
        },
        legend: { top: 0, left: 0, textStyle: { color: theme.muted, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
        grid: { top: 52, right: 22, bottom: 26, left: 84 },
        xAxis: { ...axis(theme, true), axisLabel: { color: theme.muted, formatter: "{value}%" } },
        yAxis: {
            type: "category",
            data: groups.map((group) => group.label),
            axisLabel: { color: theme.text, fontWeight: 650 },
            axisLine: { show: false },
            axisTick: { show: false }
        },
        series: segmentNames.map((name) => ({
            name,
            type: "bar",
            stack: "total",
            barMaxWidth: 30,
            data: groups.map((group) => group.segments.find((item) => item.label === name)?.percent ?? 0),
            itemStyle: { color: colorByName.get(name) ?? theme.blue, borderColor: theme.surface, borderWidth: 1 },
            label: { show: true, position: "inside", color: "#ffffff", fontSize: 10, fontWeight: 700, formatter: (parameters: { value?: unknown }) => Number(parameters.value) >= 7 ? `${Number(parameters.value).toFixed(0)}%` : "" },
            emphasis: { focus: "series" }
        }))
    }, { notMerge: true });
}

function renderLiveCategories(container: HTMLElement, data: LiveChartDatum[], labels: LiveChartLabels, theme: ChartTheme): void {
    const visible = data.filter((item) => item.value > 0).sort((a, b) => b.value - a.value).slice(0, 12).reverse();
    if (!visible.length) {
        chartFor(container, "live").setOption(emptyOption(theme, labels.noData), { notMerge: true });
        return;
    }
    const formatter = numberFormatter();
    chartFor(container, "live").setOption({
        ...baseOption(theme),
        tooltip: {
            ...baseOption(theme).tooltip as object,
            trigger: "item",
            formatter: (parameters: { name?: string; value?: unknown; data?: LiveChartDatum }) => `${parameters.name ?? ""}<br><strong>${formatter.format(Number(parameters.value))}</strong> · ${(parameters.data?.percent ?? 0).toFixed(1)}%`
        },
        grid: { top: 8, right: 72, bottom: 24, left: 58 },
        xAxis: axis(theme),
        yAxis: {
            type: "category",
            data: visible.map((item) => item.label),
            axisLabel: { color: theme.text, fontWeight: 700 },
            axisLine: { show: false },
            axisTick: { show: false }
        },
        series: [{
            type: "bar",
            barMaxWidth: 18,
            data: visible.map((item) => ({ value: item.value, percent: item.percent, itemStyle: { color: item.color ?? theme.purple, borderRadius: [0, 5, 5, 0] } })),
            label: { show: true, position: "right", color: theme.muted, fontSize: 10, formatter: (parameters: { data?: LiveChartDatum }) => `${(parameters.data?.percent ?? 0).toFixed(1)}%` }
        }]
    }, { notMerge: true });
}

export function renderLiveCharts(containers: LiveChartContainers, data: LiveChartData, labels: LiveChartLabels): void {
    const theme = readTheme();
    renderLiveRunning(containers.running, data.running, labels, theme);
    renderLiveRegularity(containers.regularity, data.regularity, labels, theme);
    renderLivePunctuality(containers.punctuality, data.punctuality, labels, theme);
    renderLiveCategories(containers.categories, data.categories, labels, theme);
}

export function renderAnalyticsCharts(containers: AnalyticsChartContainers, overview: AnalyticsOverview, labels: AnalyticsChartLabels): void {
    const theme = readTheme();
    renderPunctuality(containers.punctuality, overview, labels, theme);
    renderPercentiles(containers.percentiles, overview, labels, theme);
    renderDistribution(containers.distribution, overview, labels, theme);
    renderSevereDelay(containers.severeDelay, overview, labels, theme);
    renderCalendar(containers.calendar, overview, labels, theme);
}

export function renderExploreCharts(containers: AnalyticsExploreChartContainers, explore: AnalyticsExplore, labels: AnalyticsExploreChartLabels): void {
    const theme = readTheme();
    if (containers.operatorMix) renderHorizontalShare(containers.operatorMix, explore.composition.operators, labels, theme);
    if (containers.categoryMix) renderHorizontalShare(containers.categoryMix, explore.composition.categories, labels, theme);
    if (containers.operatorCategory) renderMixMatrix(containers.operatorCategory, explore, labels, theme);
    if (containers.networkRhythm) renderRhythmHeatmap(containers.networkRhythm, explore.rhythm, labels, theme);
    if (containers.categoryRhythm) renderCategoryRhythm(containers.categoryRhythm, explore, labels, theme);
    if (containers.stationScatter) renderStationScatter(containers.stationScatter, explore, labels, theme);
    if (containers.stationRhythm) renderStationRhythm(containers.stationRhythm, explore, labels, theme);
    if (containers.recovery) renderRecovery(containers.recovery, explore, labels, theme);
    if (containers.disruption) renderDisruption(containers.disruption, explore, labels, theme);
    if (containers.lifecycle) renderLifecycle(containers.lifecycle, explore, labels, theme);
}

export function renderRankingFallbackCharts(
    containers: Pick<AnalyticsExploreChartContainers, "operatorMix" | "categoryMix" | "stationScatter">,
    rankings: { operator?: AnalyticsRankingPayload; category?: AnalyticsRankingPayload; station?: AnalyticsRankingPayload },
    observedServices: number,
    labels: AnalyticsExploreChartLabels
): void {
    const theme = readTheme();
    const mix = (ranking?: AnalyticsRankingPayload) => (ranking?.items ?? []).map((item) => ({
        label: item.label,
        observedServices: item.observedServices,
        sharePercent: observedServices > 0 ? Math.round(item.observedServices * 1000 / observedServices) / 10 : null
    }));
    if (containers.operatorMix) renderHorizontalShare(containers.operatorMix, mix(rankings.operator), labels, theme);
    if (containers.categoryMix) renderHorizontalShare(containers.categoryMix, mix(rankings.category), labels, theme);
    if (containers.stationScatter) renderStationScatterItems(containers.stationScatter, rankings.station?.items ?? [], labels, theme);
}

export function disposeAnalyticsCharts(): void {
    disposeChartScope("analytics");
}

export function disposeLiveCharts(): void {
    disposeChartScope("live");
}

function disposeChartScope(scope: "analytics" | "live"): void {
    for (const [container, chart] of [...chartInstances]) {
        if (chartScopes.get(container) !== scope) continue;
        resizeObserver?.unobserve(container);
        if (!chart.isDisposed()) chart.dispose();
        chartInstances.delete(container);
        chartScopes.delete(container);
    }
    if (!chartInstances.size) {
        resizeObserver?.disconnect();
        resizeObserver = null;
    }
}
