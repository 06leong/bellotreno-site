export {};

type InfoMode = "updates" | "notices";
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

interface RssCardData {
  formattedDate: string;
  region: string;
  safeLink: string;
  title: string;
}

const translations = window.translations || {};

const RSS_BASE_URLS: Record<InfoMode, string> = {
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

let currentMode: InfoMode = "updates";
let currentRegion: RegionKey = "all";
let currentFetchController: AbortController | null = null;

document.addEventListener("astro:page-load", () => {
  bindInfomobilitaControls();
  void fetchRSS();
});

window.onLanguageChanged = () => {
  void fetchRSS();
};

function isRegionKey(value: string | undefined): value is RegionKey {
  return Boolean(value && Object.prototype.hasOwnProperty.call(REGIONS, value));
}

function bindInfomobilitaControls(): void {
  bindModeButton("modeUpdatesBtn", "updates");
  bindModeButton("modeNoticesBtn", "notices");

  document.querySelectorAll<HTMLElement>("[data-region-option]").forEach((option) => {
    if (option.dataset.btBound) return;
    option.dataset.btBound = "true";
    option.addEventListener("click", (event) => {
      event.preventDefault();
      const region = option.dataset.region;
      if (!isRegionKey(region)) return;
      changeDropdownRegion(region, option.textContent?.trim() || "", option.dataset.i18n);
    });
  });
}

function bindModeButton(id: string, mode: InfoMode): void {
  const button = document.getElementById(id);
  if (!button || button.dataset.btBound) return;
  button.dataset.btBound = "true";
  button.addEventListener("click", () => {
    switchInfoMode(mode);
  });
}

function changeDropdownRegion(value: RegionKey, text: string, i18nKey?: string): void {
  const btnText = document.getElementById("regionBtnText");
  if (btnText) {
    btnText.textContent = text;
    if (i18nKey) {
      btnText.setAttribute("data-i18n", i18nKey);
    } else {
      btnText.removeAttribute("data-i18n");
    }
  }

  currentRegion = value;
  void fetchRSS();
  blurActiveElement();
}

function switchInfoMode(mode: InfoMode): void {
  if (currentMode === mode) return;
  currentMode = mode;

  document.getElementById("modeUpdatesBtn")?.classList.toggle("active", mode === "updates");
  document.getElementById("modeNoticesBtn")?.classList.toggle("active", mode === "notices");

  void fetchRSS();
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
  content.style.opacity = show ? "0.3" : "1";
}

function replaceContent(element: HTMLElement | null, children: Node[] = []): void {
  element?.replaceChildren(...children);
}

function createInfoMessage(text: string, color = "var(--text-grey)"): HTMLDivElement {
  const message = document.createElement("div");
  message.style.cssText = `text-align:center;padding:40px;color:${color}`;
  message.textContent = text;
  return message;
}

function createMaterialIcon(name: string, className = "material-symbols-outlined text-[16px]"): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = className;
  icon.textContent = name;
  return icon;
}

function createRSSCard({ title, safeLink, formattedDate, region }: RssCardData): HTMLDivElement {
  const rssCard = document.createElement("div");
  rssCard.className =
    "card bg-base-100/65 backdrop-blur-3xl shadow-glass border border-base-content/10 hover:bg-base-100/75 hover:shadow-lg transition-all mb-4";

  const body = document.createElement("div");
  body.className = "card-body p-6";

  const heading = document.createElement("h3");
  heading.className = "card-title text-lg text-base-content leading-snug";
  heading.textContent = title;

  const metaRow = document.createElement("div");
  metaRow.className = "flex items-center justify-between gap-3 mt-4 flex-wrap";

  const meta = document.createElement("div");
  meta.className = "flex items-center gap-2 text-sm text-base-content/60";

  const time = document.createElement("span");
  time.className = "flex items-center gap-1";
  time.append(createMaterialIcon("schedule"), document.createTextNode(` ${formattedDate}`));
  meta.appendChild(time);

  if (region) {
    const badge = document.createElement("span");
    badge.className = "badge badge-sm badge-ghost custom-info-badge";
    badge.textContent = region;
    meta.appendChild(badge);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const anchor = document.createElement("a");
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.className = "btn btn-sm custom-readmore-btn rounded-full px-4 gap-1";
  anchor.href = safeLink;

  const readMore = document.createElement("span");
  readMore.setAttribute("data-i18n", "read_more");
  readMore.textContent = getI18n("read_more");

  anchor.append(readMore, createMaterialIcon("open_in_new"));
  actions.appendChild(anchor);
  metaRow.append(meta, actions);
  body.append(heading, metaRow);
  rssCard.appendChild(body);

  return rssCard;
}

async function fetchRSS(): Promise<void> {
  currentFetchController?.abort();
  currentFetchController = new AbortController();
  const signal = currentFetchController.signal;

  toggleLoading(true);
  const contentContainer = document.getElementById("rssContent");

  const regionSuffix = REGIONS[currentRegion];
  const targetUrl = `${RSS_BASE_URLS[currentMode]}${regionSuffix}.xml`;
  const proxyBase = window.PROXY_BASE || "https://ah.bellotreno.workers.dev";
  const proxyUrl = `${proxyBase}/?url=${encodeURIComponent(targetUrl)}&ts=${Date.now()}`;

  try {
    const response = await fetch(proxyUrl, { signal });
    if (!response.ok) throw new Error("Network response was not ok");

    const xmlText = await response.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    const items = Array.from(xmlDoc.querySelectorAll("item"));

    if (items.length === 0) {
      const message = createInfoMessage(getI18n("no_info_found"));
      message.setAttribute("data-i18n", "no_info_found");
      replaceContent(contentContainer, [message]);
      return;
    }

    items.sort((a, b) => getItemDateMs(b) - getItemDateMs(a));
    renderRSS(items);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching RSS:", error);
    replaceContent(contentContainer, [createInfoMessage(`Error: ${message}`, "var(--train-red)")]);
  } finally {
    currentFetchController = null;
    toggleLoading(false);
  }
}

function getItemDateMs(item: Element): number {
  return new Date(item.querySelector("pubDate")?.textContent || 0).getTime();
}

function renderRSS(items: Element[]): void {
  const contentContainer = document.getElementById("rssContent");
  replaceContent(contentContainer);

  for (const item of items) {
    const title = item.querySelector("title")?.textContent || "";
    const link = item.querySelector("link")?.textContent || "#";
    const pubDateStr = item.querySelector("pubDate")?.textContent || "";
    const region =
      item.querySelector("region")?.textContent || item.getElementsByTagName("rfi:region")[0]?.textContent || "";

    const formattedDate = formatRssDate(pubDateStr);
    const safeLink = /^https?:\/\//.test(link) ? link : "#";

    contentContainer?.appendChild(createRSSCard({ title, safeLink, formattedDate, region }));
  }
}

function formatRssDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const locale = window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB";
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function getI18n(key: string): string {
  const localizedValue = translations[window.currentLang || "en"]?.[key];
  if (localizedValue) return localizedValue;

  if (key === "read_more") {
    const fallbacks: Record<NonNullable<Window["currentLang"]>, string> = {
      zh: "阅读全文",
      en: "Read more",
      it: "Leggi tutto",
    };
    return fallbacks[window.currentLang || "en"];
  }

  return key;
}
