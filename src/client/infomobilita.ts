import {
  TRENITALIA_REGION_FILTERS,
  classifyTrenitaliaNotice,
  dedupeTrenitaliaNotices,
  safeHttpUrl,
  type TrenitaliaNoticeBadgeKey,
  type TrenitaliaNoticeKind,
  type TrenitaliaFilterKey,
} from "../lib/normalizers/infomobilita.js";
import { onBelloLanguageChanged } from "./language-events.js";

export {};

type ProviderMode = "trenitalia" | "rfi";
type RfiMode = "updates" | "notices";
type RegionKey =
  | "all"
  | "abruzzo"
  | "basilicata"
  | "calabria"
  | "campania"
  | "emilia_romagna"
  | "friuli_venezia_giulia"
  | "lazio"
  | "liguria"
  | "lombardia"
  | "marche"
  | "molise"
  | "piemonte"
  | "puglia"
  | "sardegna"
  | "sicilia"
  | "toscana"
  | "trentino_alto_adige"
  | "umbria"
  | "valle_d_aosta"
  | "veneto";

interface RfiCardData {
  formattedDate: string;
  region: string;
  safeLink: string;
  title: string;
}

interface TrenitaliaJsonNotice {
  description?: string;
  evidenzia?: boolean;
  link?: string;
  pubDate?: number;
  regionTags?: string[];
  title?: string;
  trainTags?: string[];
}

interface NodeOptions {
  attrs?: Record<string, unknown>;
  className?: string;
  dataset?: Record<string, unknown>;
  href?: string;
  rel?: string;
  style?: Partial<CSSStyleDeclaration>;
  target?: string;
  text?: unknown;
  type?: string;
}

type NodeChild = Node | string | number | boolean | null | undefined;

const translations = window.translations || {};
const VIAGGIATRENO_NEWS_BASE = "https://www.viaggiatreno.it/infomobilita/resteasy/news";
const ALLOWED_DESCRIPTION_TAGS = new Set(["P", "BR", "B", "STRONG", "I", "EM", "U", "UL", "OL", "LI", "A"]);

const RFI_RSS_BASE_URLS: Record<RfiMode, string> = {
  updates: "https://www.rfi.it/content/rfi/it/news-e-media/infomobilita.rss.updates",
  notices: "https://www.rfi.it/content/rfi/it/news-e-media/infomobilita.rss.notices",
};

const REGIONS: Record<RegionKey, string> = {
  all: "",
  abruzzo: ".abruzzo",
  basilicata: ".basilicata",
  calabria: ".calabria",
  campania: ".campania",
  emilia_romagna: ".emilia_romagna",
  friuli_venezia_giulia: ".friuli_venezia_giulia",
  lazio: ".lazio",
  liguria: ".liguria",
  lombardia: ".lombardia",
  marche: ".marche",
  molise: ".molise",
  piemonte: ".piemonte",
  puglia: ".puglia",
  sardegna: ".sardegna",
  sicilia: ".sicilia",
  toscana: ".toscana",
  trentino_alto_adige: ".trentino_alto_adige",
  umbria: ".umbria",
  valle_d_aosta: ".valle_d_aosta",
  veneto: ".veneto",
};

let currentProvider: ProviderMode = "trenitalia";
let currentRfiMode: RfiMode = "updates";
let currentRfiRegion: RegionKey = "all";
let currentTrenitaliaFilter: TrenitaliaFilterKey = "all";
let currentFetchController: AbortController | null = null;

document.addEventListener("astro:page-load", () => {
  if (!isInfomobilitaPage()) return;
  bindInfomobilitaControls();
  renderProviderState();
  void loadCurrentView();
});

onBelloLanguageChanged(() => {
  if (!isInfomobilitaPage()) return;
  void loadCurrentView();
});

function isInfomobilitaPage(): boolean {
  return Boolean(document.getElementById("rssContent"));
}

function createNode<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  options: NodeOptions = {},
  children: NodeChild | NodeChild[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.type) node.setAttribute("type", options.type);
  if (options.href) node.setAttribute("href", options.href);
  if (options.target) node.setAttribute("target", options.target);
  if (options.rel) node.setAttribute("rel", options.rel);
  if (options.style) Object.assign(node.style, options.style);
  if (options.attrs) {
    Object.entries(options.attrs).forEach(([key, value]) => {
      if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    });
  }
  if (options.dataset) {
    Object.entries(options.dataset).forEach(([key, value]) => {
      if (value !== undefined && value !== null) node.dataset[key] = String(value);
    });
  }

  const childList = Array.isArray(children) ? children : [children];
  childList.forEach((child) => {
    if (child === undefined || child === null) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function createMaterialIcon(name: string, className = "material-symbols-outlined text-[16px]"): HTMLSpanElement {
  return createNode("span", { className, text: name });
}

function getI18n(key: string): string {
  const localizedValue = translations[window.currentLang || "en"]?.[key];
  if (localizedValue) return localizedValue;

  const fallbacks: Record<string, string> = {
    info_details: "Details",
    info_hide_details: "Hide details",
    info_open_source: "Open source",
    no_info_found: "No notices found",
    read_more: "Read more",
  };
  return fallbacks[key] || key;
}

function isRegionKey(value: string | undefined): value is RegionKey {
  return Boolean(value && Object.prototype.hasOwnProperty.call(REGIONS, value));
}

function isTrenitaliaFilterKey(value: string | undefined): value is TrenitaliaFilterKey {
  if (!value) return false;
  return [
    "all",
    "highlighted",
    "line_train",
    "infotreni",
    "infolavori",
    ...TRENITALIA_REGION_FILTERS.map((region) => region.key),
  ].includes(value);
}

function bindInfomobilitaControls(): void {
  bindProviderButton("providerTrenitaliaBtn", "trenitalia");
  bindProviderButton("providerRfiBtn", "rfi");
  bindRfiModeButton("modeUpdatesBtn", "updates");
  bindRfiModeButton("modeNoticesBtn", "notices");

  document.querySelectorAll<HTMLElement>("[data-region-option]").forEach((option) => {
    if (option.dataset.btBound) return;
    option.dataset.btBound = "true";
    option.addEventListener("click", (event) => {
      event.preventDefault();
      const region = option.dataset.region;
      if (!isRegionKey(region)) return;
      changeRfiRegion(region, option.textContent?.trim() || "", option.dataset.i18n);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-trenitalia-filter-option]").forEach((option) => {
    if (option.dataset.btBound) return;
    option.dataset.btBound = "true";
    option.addEventListener("click", (event) => {
      event.preventDefault();
      const filter = option.dataset.trenitaliaFilter;
      if (!isTrenitaliaFilterKey(filter)) return;
      changeTrenitaliaFilter(filter, option.textContent?.trim() || "", option.dataset.i18n);
    });
  });
}

function bindProviderButton(id: string, provider: ProviderMode): void {
  const button = document.getElementById(id);
  if (!button || button.dataset.btBound) return;
  button.dataset.btBound = "true";
  button.addEventListener("click", () => {
    if (currentProvider === provider) return;
    currentProvider = provider;
    renderProviderState();
    void loadCurrentView();
  });
}

function bindRfiModeButton(id: string, mode: RfiMode): void {
  const button = document.getElementById(id);
  if (!button || button.dataset.btBound) return;
  button.dataset.btBound = "true";
  button.addEventListener("click", () => {
    if (currentRfiMode === mode) return;
    currentRfiMode = mode;
    renderProviderState();
    void loadCurrentView();
  });
}

function changeRfiRegion(value: RegionKey, text: string, i18nKey?: string): void {
  const btnText = document.getElementById("regionBtnText");
  if (btnText) {
    btnText.textContent = text;
    setI18nKey(btnText, i18nKey);
  }

  currentRfiRegion = value;
  void loadCurrentView();
  blurActiveElement();
}

function changeTrenitaliaFilter(value: TrenitaliaFilterKey, text: string, i18nKey?: string): void {
  const btnText = document.getElementById("trenitaliaFilterBtnText");
  if (btnText) {
    btnText.textContent = text;
    setI18nKey(btnText, i18nKey);
  }

  currentTrenitaliaFilter = value;
  void loadCurrentView();
  blurActiveElement();
}

function setI18nKey(element: Element, i18nKey?: string): void {
  if (i18nKey) {
    element.setAttribute("data-i18n", i18nKey);
  } else {
    element.removeAttribute("data-i18n");
  }
}

function renderProviderState(): void {
  document.getElementById("providerTrenitaliaBtn")?.classList.toggle("active", currentProvider === "trenitalia");
  document.getElementById("providerRfiBtn")?.classList.toggle("active", currentProvider === "rfi");
  document.getElementById("trenitaliaControls")?.toggleAttribute("hidden", currentProvider !== "trenitalia");
  document.getElementById("rfiControls")?.toggleAttribute("hidden", currentProvider !== "rfi");

  document.getElementById("modeUpdatesBtn")?.classList.toggle("active", currentRfiMode === "updates");
  document.getElementById("modeNoticesBtn")?.classList.toggle("active", currentRfiMode === "notices");
}

function blurActiveElement(): void {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

function toggleLoading(show: boolean): void {
  const loader = document.getElementById("infoLoading");
  const content = document.getElementById("rssContent");
  if (!loader || !content) return;

  loader.style.display = show ? "flex" : "none";
  content.style.opacity = show ? "0.32" : "1";
}

function replaceContent(element: HTMLElement | null, children: Node[] = []): void {
  element?.replaceChildren(...children);
}

function createInfoMessage(text: string, color = "var(--color-base-content)"): HTMLDivElement {
  const message = createNode("div", {
    className: "info-empty-message",
    style: { color },
    text,
  });
  return message;
}

function proxiedUrl(targetUrl: string): string {
  const proxyBase = window.PROXY_BASE || "https://ah.bellotreno.workers.dev";
  return `${proxyBase}/?url=${encodeURIComponent(targetUrl)}&ts=${Date.now()}`;
}

async function loadCurrentView(): Promise<void> {
  currentFetchController?.abort();
  const controller = new AbortController();
  currentFetchController = controller;
  const signal = controller.signal;
  toggleLoading(true);

  try {
    if (currentProvider === "trenitalia") {
      await fetchTrenitaliaNews(signal);
    } else {
      await fetchRfiRss(signal);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching infomobilita:", error);
    replaceContent(document.getElementById("rssContent"), [createInfoMessage(`Error: ${message}`, "var(--train-red)")]);
  } finally {
    if (currentFetchController === controller) currentFetchController = null;
    toggleLoading(false);
  }
}

async function fetchTrenitaliaNews(signal: AbortSignal): Promise<void> {
  const response = await fetch(proxiedUrl(`${VIAGGIATRENO_NEWS_BASE}/infomobility`), { signal });
  if (!response.ok) throw new Error("Network response was not ok");

  const payload = await response.json() as unknown;
  const notices = Array.isArray(payload)
    ? dedupeTrenitaliaNotices(payload.filter(isTrenitaliaJsonNotice))
    : [];
  const filtered = notices.filter((notice) => classifyTrenitaliaNotice(notice).filterKeys.includes(currentTrenitaliaFilter));

  if (filtered.length === 0) {
    const message = createInfoMessage(getI18n("no_info_found"));
    message.setAttribute("data-i18n", "no_info_found");
    replaceContent(document.getElementById("rssContent"), [message]);
    return;
  }

  filtered.sort((a, b) => Number(b.pubDate || 0) - Number(a.pubDate || 0));
  replaceContent(document.getElementById("rssContent"), filtered.map(createTrenitaliaJsonCard));
}

async function fetchRfiRss(signal: AbortSignal): Promise<void> {
  const regionSuffix = REGIONS[currentRfiRegion];
  const targetUrl = `${RFI_RSS_BASE_URLS[currentRfiMode]}${regionSuffix}.xml`;
  const response = await fetch(proxiedUrl(targetUrl), { signal });
  if (!response.ok) throw new Error("Network response was not ok");

  const xmlText = await response.text();
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "text/xml");
  const items = Array.from(xmlDoc.querySelectorAll("item"));

  if (items.length === 0) {
    const message = createInfoMessage(getI18n("no_info_found"));
    message.setAttribute("data-i18n", "no_info_found");
    replaceContent(document.getElementById("rssContent"), [message]);
    return;
  }

  items.sort((a, b) => getRfiItemDateMs(b) - getRfiItemDateMs(a));
  replaceContent(document.getElementById("rssContent"), items.map(createRfiRssCardFromItem));
}

function isTrenitaliaJsonNotice(value: unknown): value is TrenitaliaJsonNotice {
  return Boolean(value && typeof value === "object" && "title" in value);
}

function createTrenitaliaJsonCard(notice: TrenitaliaJsonNotice): HTMLDivElement {
  const classification = classifyTrenitaliaNotice(notice);
  const detailFragment = sanitizeHtmlString(notice.description || "");
  const sourceLabel = getTrenitaliaBadgeLabel(classification.badgeKey);
  const dateText = formatTimestampDate(notice.pubDate);
  const chips = [
    ...classification.regionTags.map((tag) => createInfoChip(tag, "map")),
    ...classification.trainTags.map((tag) => createTrainChip(tag)),
  ];

  const card = createInfoCardShell({
    dateText,
    detail: detailFragment,
    evidence: classification.isHighlighted,
    icon: getTrenitaliaIcon(classification.kind),
    sourceLabel,
    title: classification.title,
    chips,
  });
  card.classList.add(`trenitalia-kind-${classification.kind}`);
  return card;
}

function createRfiRssCardFromItem(item: Element): HTMLDivElement {
  const title = item.querySelector("title")?.textContent || "";
  const link = item.querySelector("link")?.textContent || "#";
  const pubDateStr = item.querySelector("pubDate")?.textContent || "";
  const region =
    item.querySelector("region")?.textContent || item.getElementsByTagName("rfi:region")[0]?.textContent || "";

  return createRfiRssCard({
    title,
    safeLink: safeHttpUrl(link) || "#",
    formattedDate: formatRssDate(pubDateStr),
    region,
  });
}

function createRfiRssCard({ title, safeLink, formattedDate, region }: RfiCardData): HTMLDivElement {
  const chipNodes = region ? [createInfoChip(region, "map")] : [];
  return createInfoCardShell({
    dateText: formattedDate,
    icon: "apartment",
    link: safeLink,
    sourceLabel: "RFI",
    title,
    chips: chipNodes,
  });
}

function getTrenitaliaBadgeLabel(badgeKey: TrenitaliaNoticeBadgeKey): string {
  return getI18n(`trenitalia_badge_${badgeKey}`);
}

function getTrenitaliaIcon(kind: TrenitaliaNoticeKind): string {
  if (kind === "regular") return "check_circle";
  if (kind === "infolavori") return "construction";
  if (kind === "infotreni") return "train";
  if (kind === "regional") return "departure_board";
  if (kind === "line" || kind === "av_disruption") return "warning";
  return "campaign";
}

function createInfoCardShell(options: {
  chips?: HTMLElement[];
  dateText?: string;
  detail?: DocumentFragment;
  evidence?: boolean;
  icon: string;
  link?: string;
  sourceLabel: string;
  title: string;
}): HTMLDivElement {
  const card = createNode("div", {
    className: `info-notice-card${options.evidence ? " info-notice-card-evidence" : ""}`,
  });

  const body = createNode("div", { className: "info-notice-body" });
  const headingRow = createNode("div", { className: "info-notice-heading-row" }, [
    createNode("span", { className: "info-notice-icon" }, [createMaterialIcon(options.icon)]),
    createNode("h3", { className: "info-notice-title", text: options.title }),
  ]);

  const meta = createNode("div", { className: "info-notice-meta" }, [
    createNode("span", { className: "info-source-badge", text: options.sourceLabel }),
    options.dateText ? createNode("span", { className: "info-notice-date" }, [
      createMaterialIcon("schedule"),
      options.dateText,
    ]) : null,
    ...(options.chips || []),
  ]);

  const actions: HTMLElement[] = [];
  const hasDetail = Boolean(options.detail && options.detail.childNodes.length > 0);
  let detailWrap: HTMLDivElement | null = null;

  if (hasDetail && options.detail) {
    const detailButton = createNode("button", {
      className: "btn btn-sm info-detail-toggle rounded-full px-4 gap-1",
      type: "button",
      attrs: { "aria-expanded": "false" },
    }, [
      createMaterialIcon("expand_more"),
      createNode("span", { text: getI18n("info_details") }),
    ]);
    detailWrap = createNode("div", { className: "info-notice-detail", attrs: { hidden: "" } }, [options.detail]);
    detailButton.addEventListener("click", () => {
      const expanded = detailButton.getAttribute("aria-expanded") === "true";
      detailButton.setAttribute("aria-expanded", String(!expanded));
      detailButton.classList.toggle("is-open", !expanded);
      const label = detailButton.querySelector("span:last-child");
      if (label) label.textContent = expanded ? getI18n("info_details") : getI18n("info_hide_details");
      detailWrap?.toggleAttribute("hidden", expanded);
    });
    actions.push(detailButton);
  }

  if (options.link) {
    actions.push(createNode("a", {
      className: "btn btn-sm custom-readmore-btn rounded-full px-4 gap-1",
      href: options.link,
      target: "_blank",
      rel: "noopener noreferrer",
    }, [
      createNode("span", { text: hasDetail ? getI18n("info_open_source") : getI18n("read_more") }),
      createMaterialIcon("open_in_new"),
    ]));
  }

  body.append(headingRow, meta);
  if (actions.length) body.append(createNode("div", { className: "info-notice-actions" }, actions));
  if (detailWrap) body.append(detailWrap);
  card.appendChild(body);
  return card;
}

function createInfoChip(label: string, iconName: string): HTMLSpanElement {
  return createNode("span", { className: "info-chip" }, [
    createMaterialIcon(iconName),
    createNode("span", { text: label }),
  ]);
}

function createTrainChip(trainNumber: string): HTMLAnchorElement {
  const cleanTrainNumber = normalizeTrainNumber(trainNumber);
  return createNode("a", {
    className: "info-chip info-train-chip",
    href: cleanTrainNumber ? `/?train=${encodeURIComponent(cleanTrainNumber)}` : undefined,
  }, [
    createMaterialIcon("train"),
    createNode("span", { text: trainNumber }),
  ]);
}

function sanitizeHtmlString(value: string): DocumentFragment {
  if (!value.trim()) return document.createDocumentFragment();
  const parser = new DOMParser();
  const decoded = parser.parseFromString(value, "text/html").documentElement.textContent || value;
  const html = decoded.includes("<") ? decoded : value;
  const doc = parser.parseFromString(html, "text/html");
  return sanitizeNodeList(doc.body.childNodes);
}

function sanitizeNodeList(nodes: NodeListOf<ChildNode> | ChildNode[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  Array.from(nodes).forEach((node) => {
    const sanitized = sanitizeDescriptionNode(node);
    if (sanitized) fragment.appendChild(sanitized);
  });
  return fragment;
}

function sanitizeDescriptionNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent || "");
  }
  if (!(node instanceof Element)) return null;

  if (!ALLOWED_DESCRIPTION_TAGS.has(node.tagName)) {
    return sanitizeNodeList(node.childNodes);
  }

  if (node.tagName === "BR") return document.createElement("br");

  const tagName = node.tagName === "B" ? "strong" : node.tagName === "I" ? "em" : node.tagName.toLowerCase();
  const element = document.createElement(tagName);

  if (node.tagName === "A") {
    const safeLink = safeHttpUrl(node.getAttribute("href"));
    const trainNumber = extractTrainNumberFromText(node.textContent || "");
    const internalTrainLink = trainNumber ? `/?train=${encodeURIComponent(trainNumber)}` : "";
    if (!safeLink && !internalTrainLink) return sanitizeNodeList(node.childNodes);
    element.setAttribute("href", internalTrainLink || safeLink);
    element.setAttribute("target", "_blank");
    element.setAttribute("rel", "noopener noreferrer");
    if (internalTrainLink) {
      element.removeAttribute("target");
      element.setAttribute("rel", "noopener");
    }
  }

  element.appendChild(sanitizeNodeList(node.childNodes));
  return element;
}

function normalizeTrainNumber(value: unknown): string {
  return String(value || "").replace(/\D+/g, "");
}

function extractTrainNumberFromText(value: string): string {
  const match = value.match(/\b(?:AV|FR|FA|FB|ICN|IC|EC|EN|RV|REG|RE)?\s*(\d{1,5})\b/i);
  return match ? normalizeTrainNumber(match[1]) : "";
}

function getRfiItemDateMs(item: Element): number {
  return new Date(item.querySelector("pubDate")?.textContent || 0).getTime();
}

function formatTimestampDate(value: unknown): string {
  const timestamp = typeof value === "number" ? value : Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return formatDate(new Date(timestamp));
}

function formatRssDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDate(date);
}

function formatDate(date: Date): string {
  const locale = window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB";
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
