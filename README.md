# BelloTreno

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Astro](https://img.shields.io/badge/Astro-5.x-orange.svg)](https://astro.build/)
[![Cloudflare Pages](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-f38020.svg)](https://pages.cloudflare.com/)

BelloTreno is a web application for checking real-time Italian railway information, with a focus on train running details, station departure and arrival boards, disruption notices, and cross-border services between Italy and Switzerland.

Live site: [real.bellotreno.org](https://real.bellotreno.org/)

This project is a personal railway data research and presentation project. It is not affiliated with Trenitalia, RFI, FS Italiane, SBB, Trenord, TILO, or OpenTransportData.swiss.

## Features

- Search Italian trains by train number through ViaggiaTreno data.
- Display real-time train status, delay, platforms, stop sequence, and route details.
- Show station departure and arrival boards with platform and destination information.
- Provide RFI travel notices from public RSS feeds.
- Show SmartCaring running reports for supported train categories.
- Support Chinese, English, and Italian UI text.
- Support light, dark, and system themes.
- Enrich supported Swiss cross-border trains with OpenTransportData.swiss Train Formation data.
- Add Swiss-only stops, platform sectors, coach formation, vehicle details, accessibility, bicycle, and seat information when formation data is available.
- Keep the ViaggiaTreno-only experience unchanged when Swiss data is unavailable.

## Tech Stack

- [Astro](https://astro.build/) 5
- Tailwind CSS 4
- DaisyUI 5
- Vanilla JavaScript
- Cloudflare Pages
- Cloudflare Pages Functions
- Cloudflare Workers
- OpenTransportData.swiss Train Formation Service

The ViaggiaTreno backend proxy used by this deployment is hosted separately and is not included in this repository.

## Architecture

```text
Browser
  |
  | Static frontend
  v
Cloudflare Pages
  |
  | /api/swiss/formation
  v
Cloudflare Pages Function
  |
  | Bearer token stored in Cloudflare secret
  v
OpenTransportData.swiss Train Formation API

Browser
  |
  | ViaggiaTreno and RFI requests
  v
Cloudflare Workers proxy
  |
  v
External backend proxy
  |
  v
ViaggiaTreno / RFI public services
```

The frontend is static and can be deployed to Cloudflare Pages. The Swiss formation integration runs through a Pages Function so the OpenTransportData.swiss token is never exposed to the browser.

## Project Structure

```text
.
|-- functions/              # Cloudflare Pages Functions
|   `-- api/swiss/          # Swiss formation proxy endpoints
|-- public/
|   |-- pic/                # Public train/operator images
|   `-- scripts/            # Browser-side application logic
|-- src/
|   |-- layouts/            # Shared Astro layout
|   |-- pages/              # Astro pages
|   `-- styles/             # Global styles
|-- doc/                    # Project notes and API research
|-- package.json
`-- README.md
```

## Getting Started

### Requirements

- Node.js 18 or newer
- npm

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

Astro will start a local development server, usually at `http://localhost:4321`.

### Build

```bash
npm run build
```

### Preview the Static Build

```bash
npm run preview
```

## Cloudflare Pages Functions

The Swiss formation endpoint is implemented as a Cloudflare Pages Function:

```http
GET /api/swiss/formation?train=36&date=2026-04-30
```

It calls:

```text
https://api.opentransportdata.swiss/formation/v2/formations_full
```

Required Cloudflare secret:

```text
SWISS_TRAIN_FORMATION_API_KEY
```

Optional environment variables:

```text
SWISS_TRAIN_FORMATION_API_BASE_URL
SWISS_TRAIN_FORMATION_FULL_PATH
SWISS_TRAIN_FORMATION_EVU
SWISS_TRAIN_FORMATION_USER_AGENT
```

Default values:

```text
SWISS_TRAIN_FORMATION_API_BASE_URL=https://api.opentransportdata.swiss/formation
SWISS_TRAIN_FORMATION_FULL_PATH=/v2/formations_full
SWISS_TRAIN_FORMATION_EVU=SBBP
SWISS_TRAIN_FORMATION_USER_AGENT=BelloTreno/1.0
```

Local Pages Function testing can be done with Wrangler:

```bash
npm run build
npx wrangler pages dev dist --binding SWISS_TRAIN_FORMATION_API_KEY=<your-token>
```

For production, add `SWISS_TRAIN_FORMATION_API_KEY` in Cloudflare Pages:

```text
Cloudflare Dashboard -> Workers & Pages -> your Pages project -> Settings -> Environment variables
```

Use a secret variable, not a public client-side variable.

## Data Sources

BelloTreno combines several public or externally proxied data sources:

- ViaggiaTreno public endpoints for Italian train and station running data.
- RFI public RSS feeds for disruption and travel information.
- ViaggiaTreno SmartCaring data through a dedicated worker.
- OpenTransportData.swiss Train Formation Service for supported Swiss cross-border train formations.

Swiss formation data is only used when a train number and operation date can be matched. If the Swiss API returns no supported data, the UI falls back to the ViaggiaTreno result.

## Security Notes

- Swiss API tokens are read from `context.env` inside Cloudflare Pages Functions.
- Tokens are never sent to the browser.
- The Pages Function checks request origin and referer against allowed hosts.
- The repository ignores `.env*` and `.dev.vars*` files by default.
- API-sourced strings should be escaped before insertion into `innerHTML`.

## Documentation

Additional notes are available in the `doc/` directory:

- `doc/PROJECT_GUIDE.md`
- `doc/AGENTS.md`
- `doc/blog-viaggiatreno-api.md`
- `doc/swiss-open-data-api-guide.zh-CN.md`
- `doc/swiss-open-data-integration-guide.md`

## Scripts

```bash
npm run dev      # Start Astro dev server
npm run build    # Build static site
npm run preview  # Preview the built site
```

## Deployment

The production frontend is intended for Cloudflare Pages. A typical Pages setup is:

- Build command: `npm run build`
- Build output directory: `dist`
- Node.js version: 18 or newer
- Required secret: `SWISS_TRAIN_FORMATION_API_KEY`

The separate ViaggiaTreno backend proxy and Cloudflare Workers used by the live deployment are not part of this repository.

## Disclaimer

This project is for personal research, railway enthusiast use, and educational purposes. It does not guarantee data accuracy, completeness, availability, or real-time correctness.

Always rely on official railway channels, station displays, operator apps, and staff instructions for travel decisions.

## License

This project is licensed under the [MIT License](LICENSE).
