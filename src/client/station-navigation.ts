export type StationBoardType = 'partenze' | 'arrivi';

export interface StationBoardNavigationTarget {
    stationId: string | number | null | undefined;
    stationName?: string | null;
    type?: StationBoardType | string | null;
}

type StationNavigationGlobal = Window & {
    goToStationBoard?: (
        stationId: StationBoardNavigationTarget['stationId'],
        stationName?: StationBoardNavigationTarget['stationName'],
        type?: StationBoardNavigationTarget['type']
    ) => boolean | void;
};

export function normalizeStationBoardType(type: StationBoardNavigationTarget['type']): StationBoardType {
    return type === 'arrivi' ? 'arrivi' : 'partenze';
}

export function createStationBoardUrl(target: StationBoardNavigationTarget): string | null {
    const stationId = String(target.stationId ?? '').trim();
    if (!stationId) return null;

    const params = new URLSearchParams({
        id: stationId,
        name: String(target.stationName ?? ''),
        type: normalizeStationBoardType(target.type)
    });

    return `/station?${params.toString()}`;
}

export function navigateToStationBoard(
    stationId: StationBoardNavigationTarget['stationId'],
    stationName?: StationBoardNavigationTarget['stationName'],
    type?: StationBoardNavigationTarget['type']
): boolean {
    const url = createStationBoardUrl({ stationId, stationName, type });
    if (!url) return false;

    window.location.href = url;
    return true;
}

export function registerStationNavigationGlobal(target: StationNavigationGlobal = window): void {
    target.goToStationBoard = navigateToStationBoard;
}
