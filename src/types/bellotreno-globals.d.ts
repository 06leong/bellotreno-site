export {};

type BelloLanguage = "zh" | "en" | "it";
type BelloTheme = "auto" | "light" | "dark";

type TranslationDictionary = Record<string, Record<string, string>>;

interface BelloSwissApi {
  fetchSwissByTrainNumber?: (trainNumber: string, operationDate: string) => Promise<unknown>;
  fetchSwissEc?: (data: unknown, category?: string) => Promise<unknown>;
  getCategory?: (data: unknown) => string;
  getOperationDate?: (data: unknown) => string;
  getTodayInZurich?: () => string;
  getTrainNumber?: (data: unknown) => string;
  hasSwissHint?: (data: unknown) => boolean;
  hideFormationCard: () => void;
  isSwissBoundaryName?: (value: unknown) => boolean;
  isTechnicalSwissStop?: (value: unknown) => boolean;
  mergeTimelineStops: (stops: unknown[], formationData: unknown) => unknown[];
  normalizeStationName: (value: unknown) => string;
  renderFormationCard: (data: unknown) => void;
  renderLoadingCard: () => void;
  shouldQuery: (data: unknown, category?: string) => boolean;
}

declare global {
  const translations: TranslationDictionary;
  const currentLang: BelloLanguage;
  const currentTheme: BelloTheme;

  function applyTheme(): void;
  function goToStationBoard(stationId: string, stationName?: string, type?: string): void;

  interface Window {
    API_BASE?: string;
    BelloSwiss?: BelloSwissApi;
    CAT_IMAGE_MAP?: Record<string, string>;
    CAT_MAP?: Record<string, string>;
    CLIENT_LINK_MAP?: Record<string, string>;
    CLIENT_MAP?: Record<string, string>;
    COUNTER_URL?: string;
    NOTIFY_BASE?: string;
    PROXY_BASE?: string;
    SWISS_EC_BASE?: string;
    SWISS_FORMATION_BASE?: string;
    TRENORD_TRAFFIC_BASE?: string;
    __btThemeSwapGuard?: boolean;
    _commonInitialized?: boolean;
    _mainInitialized?: boolean;
    applyTheme?: () => void;
    changeDropdownRegion?: (value: string, text: string, i18nKey?: string) => void;
    changeLang?: (lang: BelloLanguage) => void;
    changeTheme?: (theme: BelloTheme) => void;
    currentLang?: BelloLanguage;
    currentTheme?: BelloTheme;
    escapeHtml?: (value: unknown) => string;
    fetchStationBoard?: (stationId: string, type?: string) => Promise<unknown[]>;
    formatArrivalData?: (train: unknown, lang: string, stationName: string) => unknown;
    formatDepartureData?: (train: unknown, lang: string, stationName: string) => unknown;
    getBadgeClass?: (categoryCode: string) => string;
    getItalianTimeString?: () => string;
    goHome?: () => void;
    goToStationBoard?: (stationId: string, stationName?: string, type?: string) => void;
    initLanguage?: () => void;
    initTheme?: () => void;
    initVisitorCounter?: () => Promise<void>;
    onLanguageChanged?: () => void;
    scrollToTop?: () => void;
    searchMode?: "train" | "station";
    switchInfoMode?: (mode: "updates" | "notices") => void;
    switchSearchMode?: (mode: "train" | "station") => void;
    switchBoardType?: (type: "partenze" | "arrivi") => void;
    translations?: TranslationDictionary;
    updateLanguage?: () => void;
    updateThemeDisplay?: () => void;
    visitorCountData?: number;
  }
}
