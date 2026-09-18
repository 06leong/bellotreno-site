
const pickers = new WeakMap<HTMLSelectElement, () => void>();
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/** Enhance the existing eligible-date list without changing its change-event contract. */
export function syncDatePicker(source: HTMLSelectElement): void {
    let sync = pickers.get(source);
    if (!sync) {
        sync = createDatePicker(source);
        pickers.set(source, sync);
    }
    sync();
}

function createDatePicker(source: HTMLSelectElement): () => void {
    function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "") {
        const result = document.createElement(tag);
        result.className = className;
        return result;
    }
    function text(key: string): string {
        return window.translations?.[window.currentLang]?.[key] || key;
    }
    function locale(): string {
        return window.currentLang === "zh" ? "zh-CN" : window.currentLang === "it" ? "it-IT" : "en-GB";
    }
    function button(className = ""): HTMLButtonElement {
        const result = node("button", className);
        result.type = "button";
        return result;
    }
    const wrapper = node("span", "statistics-date-picker");
    const trigger = button("statistics-date-trigger");
    trigger.id = `${source.id}-trigger`;
    trigger.setAttribute("aria-haspopup", "dialog");
    const native = node("input", "statistics-date-native");
    native.type = "date";
    native.id = `${source.id}-native`;
    const status = node("span", "statistics-date-status");
    status.id = `${source.id}-status`;
    const error = node("span", "statistics-date-error");
    error.id = `${source.id}-error`;
    error.setAttribute("role", "status");
    native.setAttribute("aria-describedby", `${status.id} ${error.id}`);
    trigger.setAttribute("aria-describedby", `${status.id} ${error.id}`);
    const dialog = node("dialog", "statistics-date-dialog");
    dialog.id = `${source.id}-calendar`;
    trigger.setAttribute("aria-controls", dialog.id);
    const heading = node("div", "statistics-calendar-heading");
    const year = node("select");
    const month = node("select");
    const previous = button();
    previous.textContent = "‹";
    const next = button();
    next.textContent = "›";
    heading.append(year, month, previous, next);
    const weekdays = node("div", "statistics-calendar-weekdays");
    weekdays.setAttribute("aria-hidden", "true");
    const days = node("div", "statistics-calendar-days");
    const close = button("statistics-calendar-close");
    dialog.append(heading, weekdays, days, close);
    // Keep theme variables inherited from the statistics page; showModal uses the top layer.
    (source.closest("main") || document.body).append(dialog);
    wrapper.append(trigger, native, status, error);
    source.after(wrapper);
    source.hidden = true;
    const label = source.closest("label");
    const touch = window.matchMedia("(pointer: coarse)");
    let available = new Set<string>();
    let cursor = "";
    let minimum = "";
    let maximum = "";

    function choose(value: string): void {
        if (!available.has(value)) {
            native.value = source.value;
            error.textContent = text("date_picker_unavailable");
            return;
        }
        error.textContent = "";
        source.value = value;
        sync();
        if (dialog.open) dialog.close();
        source.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function render(): void {
        if (!cursor) return;
        const y = Number(cursor.slice(0, 4));
        const m = Number(cursor.slice(5, 7)) - 1;
        year.replaceChildren();
        for (let value = Number(minimum.slice(0, 4)); value <= Number(maximum.slice(0, 4)); value++) {
            const option = node("option");
            option.value = String(value);
            option.textContent = String(value);
            year.append(option);
        }
        year.value = String(y);
        month.replaceChildren();
        for (let value = 0; value < 12; value++) {
            const option = node("option");
            option.value = String(value + 1).padStart(2, "0");
            option.textContent = new Intl.DateTimeFormat(locale(), { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, value, 1)));
            const prefix = `${y}-${option.value}`;
            option.disabled = prefix < minimum.slice(0, 7) || prefix > maximum.slice(0, 7);
            month.append(option);
        }
        month.value = String(m + 1).padStart(2, "0");
        year.setAttribute("aria-label", text("date_picker_year"));
        month.setAttribute("aria-label", text("date_picker_month"));
        previous.setAttribute("aria-label", text("date_picker_previous"));
        next.setAttribute("aria-label", text("date_picker_next"));
        previous.disabled = cursor <= minimum.slice(0, 7);
        next.disabled = cursor >= maximum.slice(0, 7);
        close.textContent = text("date_picker_close");
        weekdays.replaceChildren();
        for (let index = 0; index < 7; index++) {
            const day = node("span");
            day.textContent = new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 5, 1 + index)));
            weekdays.append(day);
        }
        days.replaceChildren();
        const offset = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
        for (let index = 0; index < offset; index++) days.append(node("span"));
        const count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        for (let day = 1; day <= count; day++) {
            const value = `${cursor}-${String(day).padStart(2, "0")}`;
            const cell = button();
            cell.textContent = String(day);
            cell.dataset.date = value;
            cell.disabled = !available.has(value);
            cell.setAttribute("aria-label", new Intl.DateTimeFormat(locale(), { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`)));
            cell.setAttribute("aria-pressed", String(value === source.value));
            cell.addEventListener("click", () => choose(value));
            days.append(cell);
        }
    }

    function changeMonth(value: string): void {
        cursor = value < minimum.slice(0, 7) ? minimum.slice(0, 7) : value > maximum.slice(0, 7) ? maximum.slice(0, 7) : value;
        render();
    }
    year.addEventListener("change", () => changeMonth(`${year.value}-${month.value}`));
    month.addEventListener("change", () => changeMonth(`${year.value}-${month.value}`));
    function stepMonth(step: number): void {
        const date = new Date(`${cursor}-01T12:00:00Z`);
        date.setUTCMonth(date.getUTCMonth() + step);
        changeMonth(date.toISOString().slice(0, 7));
    }
    previous.addEventListener("click", () => stepMonth(-1));
    next.addEventListener("click", () => stepMonth(1));
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    days.addEventListener("keydown", (event) => {
        const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
        const target = event.target;
        if (!delta || !(target instanceof HTMLButtonElement) || !target.dataset.date) return;
        event.preventDefault();
        const date = new Date(`${target.dataset.date}T12:00:00Z`);
        do { date.setUTCDate(date.getUTCDate() + delta); }
        while (!available.has(date.toISOString().slice(0, 10)) && date.toISOString().slice(0, 10) >= minimum && date.toISOString().slice(0, 10) <= maximum);
        const value = date.toISOString().slice(0, 10);
        if (!available.has(value)) return;
        changeMonth(value.slice(0, 7));
        days.querySelector<HTMLButtonElement>(`[data-date="${value}"]`)?.focus();
    });
    trigger.addEventListener("click", () => {
        cursor = (source.value || maximum).slice(0, 7);
        render();
        dialog.showModal();
        (days.querySelector<HTMLButtonElement>('[aria-pressed="true"]:not(:disabled)') || days.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    });
    native.addEventListener("change", () => choose(native.value));

    function sync(): void {
        const options = Array.from(source.options).filter((option) => datePattern.test(option.value) && !option.disabled);
        available = new Set(options.map((option) => option.value));
        const sorted = [...available].sort();
        minimum = sorted[0] || "";
        maximum = sorted.at(-1) || "";
        native.min = minimum;
        native.max = maximum;
        native.value = source.value;
        trigger.disabled = native.disabled = source.disabled || !options.length;
        const selected = source.selectedOptions[0];
        trigger.textContent = source.value ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${source.value}T12:00:00Z`)) : selected?.textContent || "—";
        status.textContent = selected?.textContent?.split(" · ").slice(1).join(" · ") || "";
        native.title = source.value ? "" : selected?.textContent || "";
        if (!source.value) {
            status.textContent = selected?.textContent || "";
            status.classList.add("statistics-date-native-note");
        } else {
            status.classList.remove("statistics-date-native-note");
        }
        if (error.textContent) error.textContent = text("date_picker_unavailable");
        const title = label?.querySelector("[data-i18n]")?.textContent || text("statistics_date");
        trigger.setAttribute("aria-label", `${title}: ${trigger.textContent}`);
        native.setAttribute("aria-label", title);
        dialog.setAttribute("aria-label", title);
        if (label) label.htmlFor = touch.matches ? native.id : trigger.id;
        if (dialog.open) {
            if (!available.size || source.disabled) dialog.close();
            else { changeMonth(cursor); }
        }
    }
    return sync;
}
