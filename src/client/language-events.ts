type Language = NonNullable<Window["currentLang"]>;

export const BELLO_LANGUAGE_CHANGED_EVENT = "bellotreno:language-changed";

export interface BelloLanguageChangedDetail {
    language: Language;
}

export type BelloLanguageChangedHandler = (event: CustomEvent<BelloLanguageChangedDetail>) => void;

export function dispatchBelloLanguageChanged(language: Language): void {
    window.dispatchEvent(new CustomEvent<BelloLanguageChangedDetail>(BELLO_LANGUAGE_CHANGED_EVENT, {
        detail: { language }
    }));
}

export function onBelloLanguageChanged(handler: BelloLanguageChangedHandler): void {
    window.addEventListener(BELLO_LANGUAGE_CHANGED_EVENT, handler as EventListener);
}
