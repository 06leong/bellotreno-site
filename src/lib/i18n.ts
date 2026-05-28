import translationsJson from './translations.json';

export const LOCALES = ['it', 'en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export type PageKey = 'home' | 'station' | 'statistics' | 'infomobilita' | 'about';

export const DEFAULT_LOCALE: Locale = 'it';

export const htmlLang: Record<Locale, string> = {
    it: 'it',
    en: 'en',
    zh: 'zh-CN',
};

export const ogLocale: Record<Locale, string> = {
    it: 'it_IT',
    en: 'en_GB',
    zh: 'zh_CN',
};

export const localeNames: Record<Locale, string> = {
    it: 'Italiano',
    en: 'English',
    zh: 'Chinese',
};

const translations = translationsJson as Record<Locale, Record<string, string>>;

export function isLocale(value: unknown): value is Locale {
    return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function normalizeLocale(value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
    return isLocale(value) ? value : fallback;
}

export function localeFromPath(pathname: string): Locale | null {
    const firstSegment = pathname.split('/').filter(Boolean)[0];
    return isLocale(firstSegment) ? firstSegment : null;
}

export function t(locale: Locale, key: string): string {
    return translations[locale]?.[key] ?? translations[DEFAULT_LOCALE]?.[key] ?? translations.en?.[key] ?? key;
}

function splitInternalPath(inputPath: string) {
    const url = new URL(inputPath || '/', 'https://bellotreno.org');
    const parts = url.pathname.split('/').filter(Boolean);

    if (isLocale(parts[0])) {
        parts.shift();
    }

    return {
        path: parts.length ? `/${parts.join('/')}` : '/',
        search: url.search,
        hash: url.hash,
    };
}

export function localizedPath(locale: Locale, inputPath = '/'): string {
    const { path, search, hash } = splitInternalPath(inputPath);
    const localized = path === '/' ? `/${locale}/` : `/${locale}${path}`;
    return `${localized}${search}${hash}`;
}

export function switchLocalePath(currentPath: string, targetLocale: Locale): string {
    return localizedPath(targetLocale, currentPath);
}

export function alternatePath(pathname: string, targetLocale: Locale): string {
    const path = localizedPath(targetLocale, pathname);
    return path.endsWith('/') ? path : `${path}/`;
}

export const pageMeta: Record<PageKey, Record<Locale, { title: string; description: string }>> = {
    home: {
        it: {
            title: 'BelloTreno - Treni in Tempo Reale',
            description: 'Cerca treni italiani in tempo reale. Stato, ritardi e percorso completo di Frecciarossa, Intercity, Regionali e altri treni Trenitalia su ViaggiaTreno.',
        },
        en: {
            title: 'BelloTreno - Italian Trains in Real Time',
            description: 'Search Italian trains in real time. Check status, delays, full routes, Frecciarossa, Intercity, regional trains and more through ViaggiaTreno.',
        },
        zh: {
            title: 'BelloTreno - 意大利铁路实时信息',
            description: '实时查询意大利列车运行状态、晚点、停站路线、Frecciarossa、Intercity、区域列车和 ViaggiaTreno 可观测数据。',
        },
    },
    station: {
        it: {
            title: 'Partenze & Arrivi - BelloTreno',
            description: 'Tabellone partenze e arrivi in tempo reale delle stazioni ferroviarie italiane. Cerca la tua stazione e consulta i treni in orario e in ritardo.',
        },
        en: {
            title: 'Departures & Arrivals - BelloTreno',
            description: 'Real-time departure and arrival boards for Italian railway stations. Search a station and check on-time, delayed and cancelled trains.',
        },
        zh: {
            title: '车站到发 - BelloTreno',
            description: '意大利铁路车站实时出发与到达面板，支持车站搜索、站台、晚点、取消和天气信息。',
        },
    },
    statistics: {
        it: {
            title: 'Statistiche ferroviarie italiane - BelloTreno',
            description: 'Statistiche giornaliere dei treni italiani monitorati da BelloTreno: puntualita, ritardi, cancellazioni, categorie e andamento della circolazione.',
        },
        en: {
            title: 'Italian railway statistics - BelloTreno',
            description: 'Daily statistics for Italian trains monitored by BelloTreno: punctuality, delays, cancellations, categories and circulation trends.',
        },
        zh: {
            title: '意大利铁路运行统计 - BelloTreno',
            description: 'BelloTreno 监测的意大利铁路每日统计，包括准点率、晚点、取消、列车类别和运行趋势。',
        },
    },
    infomobilita: {
        it: {
            title: 'Infomobilita - BelloTreno',
            description: 'Avvisi e aggiornamenti in tempo reale dell infomobilita ferroviaria RFI. Notizie su scioperi, lavori e perturbazioni su tutta la rete ferroviaria italiana.',
        },
        en: {
            title: 'Infomobility - BelloTreno',
            description: 'Real-time RFI railway mobility notices and updates, including strikes, works and disruptions across the Italian railway network.',
        },
        zh: {
            title: '出行信息 - BelloTreno',
            description: 'RFI 铁路出行公告与实时更新，包括罢工、施工和意大利铁路网络扰动信息。',
        },
    },
    about: {
        it: {
            title: 'About - BelloTreno',
            description: 'BelloTreno e un progetto amatoriale per il monitoraggio in tempo reale dei treni italiani. Dati forniti da ViaggiaTreno, Trenitalia e RFI.',
        },
        en: {
            title: 'About - BelloTreno',
            description: 'BelloTreno is an enthusiast project for monitoring Italian trains in real time using public ViaggiaTreno, Trenitalia and RFI data.',
        },
        zh: {
            title: '关于 - BelloTreno',
            description: 'BelloTreno 是一个铁路爱好者项目，用于基于 ViaggiaTreno、Trenitalia 和 RFI 公开数据查看意大利列车实时信息。',
        },
    },
};

export function getPageMeta(locale: Locale, page: PageKey) {
    return pageMeta[page][locale] ?? pageMeta[page][DEFAULT_LOCALE];
}
