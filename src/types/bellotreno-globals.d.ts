export {};

type BelloLanguage = "zh" | "en" | "it";
type BelloTheme = "auto" | "light" | "dark";

type TranslationDictionary = Record<string, Record<string, string>>;
type BelloRecord = Record<string, unknown>;

interface BelloSwissApi {
  fetchSwissByTrainNumber?: (trainNumber: string, operationDate: string) => Promise<unknown>;
  fetchSwissEc?: (data: BelloRecord, category?: string) => Promise<unknown>;
  getCategory?: (data: BelloRecord) => string;
  getOperationDate?: (data: BelloRecord) => string | null;
  getTodayInZurich?: () => string;
  getTrainNumber?: (data: BelloRecord) => string;
  hasSwissHint?: (data: BelloRecord) => boolean;
  hideFormationCard: () => void;
  isSwissBoundaryName?: (value: unknown) => boolean;
  isTechnicalSwissStop?: (value: BelloRecord) => boolean;
  mergeTimelineStops: (stops: unknown[], formationData: BelloRecord) => unknown[];
  normalizeStationName: (value: unknown) => string;
  renderFormationCard: (data: BelloRecord) => void;
  renderLoadingCard: () => void;
  shouldQuery: (data: BelloRecord, category?: string) => boolean;
}

declare global {
  const translations: TranslationDictionary;
  const currentLang: BelloLanguage;
  const currentTheme: BelloTheme;

  function applyTheme(): void;
  function goToStationBoard(stationId: string | number | null | undefined, stationName?: string | null, type?: string | null): boolean | void;

  interface Window {
    API_BASE?: string;
    BelloSwiss?: BelloSwissApi;
    CAT_IMAGE_MAP?: Record<string, string>;
    CAT_MAP?: Record<string, string>;
    CLIENT_LINK_MAP?: Record<string, string>;
    CLIENT_MAP?: Record<string, string>;
    COUNTER_URL?: string;
    ITALO_STATION_BASE?: string;
    ITALO_STATIONS_BASE?: string;
    ITALO_TRAIN_BASE?: string;
    NOTIFY_BASE?: string;
    PROXY_BASE?: string;
    SWISS_EC_BASE?: string;
    SWISS_FORMATION_BASE?: string;
    TRENORD_TRAFFIC_BASE?: string;
    __btThemeSwapGuard?: boolean;
    _commonInitialized?: boolean;
    _mainInitialized?: boolean;
    applyTheme?: () => void;
    currentLang: BelloLanguage;
    currentTheme: BelloTheme;
    escapeHtml?: (value: unknown) => string;
    getBadgeClass?: (categoryCode: string) => string;
    goHome?: () => void;
    goToStationBoard?: (stationId: string | number | null | undefined, stationName?: string | null, type?: string | null) => boolean | void;
    initLanguage?: () => void;
    initTheme?: () => void;
    initVisitorCounter?: () => Promise<void>;
    searchMode?: "train" | "station";
    switchSearchMode?: (mode: "train" | "station") => void;
    translations?: TranslationDictionary;
    updateLanguage?: () => void;
    updateThemeDisplay?: () => void;
    visitorCountData?: number;
  }
}
