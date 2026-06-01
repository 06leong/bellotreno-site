export {};

declare global {
  interface PagesEnv {
    STATISTICS_API_BASE_URL?: string;
    STATISTICS_API_TOKEN?: string;
    SWISS_TRAIN_FORMATION_API_KEY?: string;
    TRENORD_BFF_SECRET?: string;
  }

  interface PagesContext<Params extends Record<string, string | string[]> = Record<string, string | string[]>> {
    request: Request;
    env: PagesEnv;
    params: Params;
    waitUntil?: (promise: Promise<unknown>) => void;
    passThroughOnException?: () => void;
    next?: () => Promise<Response>;
    data?: Record<string, unknown>;
  }
}
