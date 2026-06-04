export {};

type TerminalTheme = {
    name: string;
    bg: string;
    main: string;
    dim: string;
    glow: string;
    scanline: string;
};

const themes: TerminalTheme[] = [
    { name: "Green", bg: "#050505", main: "#33ff00", dim: "#006600", glow: "rgba(51, 255, 0, 0.6)", scanline: "rgba(0, 0, 0, 0.5)" },
    { name: "Amber", bg: "#1a1000", main: "#ffb000", dim: "#664400", glow: "rgba(255, 176, 0, 0.6)", scanline: "rgba(20, 10, 0, 0.4)" },
    { name: "Blue", bg: "#101020", main: "#a5a5ff", dim: "#404080", glow: "rgba(165, 165, 255, 0.5)", scanline: "rgba(0, 0, 0, 0.3)" },
    { name: "Pink", bg: "#150015", main: "#ff00ff", dim: "#770077", glow: "rgba(255, 0, 255, 0.5)", scanline: "rgba(0, 0, 0, 0.4)" },
    { name: "SSH", bg: "#000000", main: "#c0c0c0", dim: "#666666", glow: "rgba(255, 255, 255, 0.1)", scanline: "rgba(255, 255, 255, 0.08)" },
];

function detectDevice(userAgent: string): string {
    if (/iPhone/.test(userAgent)) return "iPhone";
    if (/iPad/.test(userAgent)) return "iPad";
    if (/Android/.test(userAgent)) {
        const match = userAgent.match(/Android.*?; (.*?)\)/);
        return match?.[1] ? match[1].split("Build")[0]?.trim() || "Android Device" : "Android Device";
    }
    if (/Mac/.test(userAgent)) return "Macintosh";
    if (/Win/.test(userAgent)) return "Windows PC";
    if (/Linux/.test(userAgent)) return "Linux Machine";
    return "Unknown Device";
}

function detectBrowser(userAgent: string): string {
    if (/Edge/.test(userAgent)) return "Edge";
    if (/Firefox/.test(userAgent)) return "Firefox";
    if (/Chrome/.test(userAgent)) return "Chrome";
    if (/Safari/.test(userAgent)) return "Safari";
    return "Web Client";
}

function appendCommandPrefix(target: HTMLElement): void {
    const prefix = document.createElement("span");
    prefix.className = "cmd-prefix";
    prefix.textContent = "root@bellotreno:~#";
    target.append(prefix, " ");
}

function appendLine(target: HTMLElement, className: string | null, ...parts: Array<Node | string>): void {
    const line = document.createElement("span");
    line.className = className ? `cmd-line ${className}` : "cmd-line";
    line.append(...parts);
    target.append(line);
}

function appendValue(label: string, value: string): Array<Node | string> {
    const data = document.createElement("span");
    data.className = "data-val";
    data.textContent = value;
    return [label, data];
}

function renderTerminal(target: HTMLElement): void {
    target.replaceChildren();
    appendCommandPrefix(target);
    target.append("client_identify", document.createElement("br"));

    const userAgent = navigator.userAgent;
    appendLine(target, null, ...appendValue("Connection established from ", detectDevice(userAgent)));
    appendLine(target, null, ...appendValue("Client Agent: ", detectBrowser(userAgent)));
    appendLine(target, null, ...appendValue("Display Geometry: ", `${window.screen.width}x${window.screen.height}`));
    target.append(document.createElement("br"));

    appendCommandPrefix(target);
    target.append("check_status", document.createElement("br"));
    appendLine(target, "log-warn", "> [WARN] ACCESS DENIED: ROOT PRIVILEGES REQUIRED");
}

function applyRandomTheme(): void {
    const theme = themes[Math.floor(Math.random() * themes.length)] ?? themes[0];
    const root = document.documentElement;
    root.style.setProperty("--bg-color", theme.bg);
    root.style.setProperty("--main-color", theme.main);
    root.style.setProperty("--dim-color", theme.name === "SSH" ? "#888" : theme.dim);
    root.style.setProperty("--glow", theme.glow);
    root.style.setProperty("--scanline", theme.scanline);
}

document.addEventListener("DOMContentLoaded", () => {
    const year = document.getElementById("year");
    if (year) year.textContent = String(new Date().getFullYear());

    applyRandomTheme();

    const terminal = document.getElementById("terminal-body");
    if (terminal instanceof HTMLElement) {
        window.setTimeout(() => renderTerminal(terminal), 300);
    }
});
