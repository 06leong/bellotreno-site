export {};

declare global {
  interface PagesEnv {
    ITALO_PROXY_BASE_URL?: string;
    ITALO_PROXY_CALLER_ORIGIN?: string;
    ITALO_PROXY_TOKEN?: string;
    RFI_PROXY_BASE_URL?: string;
    RFI_PROXY_TOKEN?: string;
    STATISTICS_API_BASE_URL?: string;
    STATISTICS_API_TOKEN?: string;
    SWISS_TRAIN_FORMATION_API_BASE_URL?: string;
    SWISS_TRAIN_FORMATION_API_KEY?: string;
    SWISS_TRAIN_FORMATION_EVU?: string;
    SWISS_TRAIN_FORMATION_FULL_PATH?: string;
    SWISS_TRAIN_FORMATION_USER_AGENT?: string;
    TRENORD_BFF_SECRET?: string;
    TRENORD_PROXY_BASE_URL?: string;
    TRENORD_PROXY_TOKEN?: string;
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
