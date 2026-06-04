type SmokePage = {
    path: string;
    markers: string[];
};

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:4321";

const pages: SmokePage[] = [
    { path: "/", markers: ["BelloTreno", "Enter train number"] },
    { path: "/station/?id=S01700&name=MILANO+CENTRALE&type=partenze", markers: ["BelloTreno", "station"] },
    { path: "/statistics/", markers: ["Railway statistics", "/api/statistics"] },
    { path: "/infomobilita/", markers: ["BelloTreno", "Infomobilita"] },
    { path: "/about/", markers: ["About BelloTreno", "data-about-section"] },
];

function pageUrl(path: string): string {
    return new URL(path, baseUrl).toString();
}

async function checkPage(page: SmokePage): Promise<void> {
    const url = pageUrl(page.path);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
        throw new Error(`${url} returned HTTP ${response.status}`);
    }

    const html = await response.text();
    const missing = page.markers.filter((marker) => !html.includes(marker));
    if (missing.length > 0) {
        throw new Error(`${url} is missing markers: ${missing.join(", ")}`);
    }
}

for (const page of pages) {
    await checkPage(page);
    console.log(`ok ${page.path}`);
}
