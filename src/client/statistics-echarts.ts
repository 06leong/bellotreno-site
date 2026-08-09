import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart } from "echarts/charts";
import {
    AriaComponent,
    CalendarComponent,
    DataZoomComponent,
    GridComponent,
    LegendComponent,
    TooltipComponent,
    VisualMapComponent
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { ECharts, EChartsCoreOption } from "echarts/core";
import type { AnalyticsOverview } from "../lib/normalizers/statistics-analytics.js";

echarts.use([
    LineChart,
    BarChart,
    HeatmapChart,
    AriaComponent,
    CalendarComponent,
    DataZoomComponent,
    GridComponent,
    LegendComponent,
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

interface ChartTheme {
    accent: string;
    blue: string;
    teal: string;
    orange: string;
    text: string;
    muted: string;
    border: string;
    surface: string;
}

const chartInstances = new Map<HTMLElement, ECharts>();
let resizeObserver: ResizeObserver | null = null;

function cssValue(styles: CSSStyleDeclaration, name: string, fallback: string): string {
    return styles.getPropertyValue(name).trim() || fallback;
}

function readTheme(): ChartTheme {
    const page = document.querySelector<HTMLElement>(".statistics-page") ?? document.documentElement;
    const styles = getComputedStyle(page);
    const selectedTheme = document.documentElement.dataset.theme;
    const dark = selectedTheme === "dark"
        || (selectedTheme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    return {
        accent: cssValue(styles, "--statistics-accent", "#d71920"),
        blue: cssValue(styles, "--statistics-blue", "#1769d2"),
        teal: cssValue(styles, "--statistics-teal", "#078d91"),
        orange: cssValue(styles, "--statistics-orange", "#e8750a"),
        text: dark ? "#f3f4f6" : "#172033",
        muted: dark ? "rgba(229, 231, 235, 0.62)" : "rgba(23, 32, 51, 0.58)",
        border: dark ? "rgba(229, 231, 235, 0.14)" : "rgba(23, 32, 51, 0.13)",
        surface: dark ? "#111722" : "#ffffff"
    };
}

function chartFor(container: HTMLElement): ECharts {
    const existing = chartInstances.get(container);
    if (existing && !existing.isDisposed()) return existing;
    const chart = echarts.init(container, undefined, { renderer: "svg" });
    chartInstances.set(container, chart);
    if (!resizeObserver) {
        resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) chartInstances.get(entry.target as HTMLElement)?.resize();
        });
    }
    resizeObserver.observe(container);
    return chart;
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

export function renderAnalyticsCharts(containers: AnalyticsChartContainers, overview: AnalyticsOverview, labels: AnalyticsChartLabels): void {
    const theme = readTheme();
    renderPunctuality(containers.punctuality, overview, labels, theme);
    renderPercentiles(containers.percentiles, overview, labels, theme);
    renderDistribution(containers.distribution, overview, labels, theme);
    renderSevereDelay(containers.severeDelay, overview, labels, theme);
    renderCalendar(containers.calendar, overview, labels, theme);
}

export function disposeAnalyticsCharts(): void {
    for (const [container, chart] of chartInstances) {
        resizeObserver?.unobserve(container);
        if (!chart.isDisposed()) chart.dispose();
    }
    chartInstances.clear();
    resizeObserver?.disconnect();
    resizeObserver = null;
}
