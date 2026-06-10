# Italo Realtime Integration Guide

This document describes the Italo support added to BelloTreno. It focuses on
public passenger-facing realtime data from Italo in Viaggio and intentionally
does not use Italo booking APIs.

## Scope

Italo is not exposed through the ViaggiaTreno train lookup flow used for
Trenitalia, Trenitalia TPER, Trenord/TILO, FSE, FS Treni Turistici Italiani, and
selected FS-linked international services. BelloTreno therefore treats Italo as
a separate provider.

The first supported Italo surfaces are:

- train-number fallback lookup on the homepage;
- Italo train detail timeline rendering;
- Italo departures and arrivals merged into supported station boards;
- Italo station-code discovery through a same-origin Pages Function.

The implementation does not provide realtime train formation, vehicle numbers,
seat maps, fares, or booking availability.

## Upstream Endpoints

The current Italo in Viaggio public pages use these passenger-facing endpoints:

```text
GET https://italoinviaggio.italotreno.com/api/RicercaTrenoService?TrainNumber={trainNumber}
GET https://italoinviaggio.italotreno.com/api/RicercaStazioneService?CodiceStazione={italoStationCode}
GET https://italoinviaggio.italotreno.com/it/stazione
```

The first endpoint returns a train-detail JSON payload. The second endpoint
returns an Italo station board JSON payload. The third page contains the station
list used by Italo's own station search UI.

Because these endpoints are not documented as a stable public developer API,
BelloTreno calls them only through Cloudflare Pages Functions:

| Function | Purpose |
| --- | --- |
| `/api/italo/train?number=9908` | Fetches and normalizes one Italo train |
| `/api/italo/station?code=MC_&type=partenze` | Fetches and normalizes one Italo station board |
| `/api/italo/stations?q=milano` | Extracts and caches the Italo station list |

The Italo train endpoint can occasionally return an upstream network or HTTP
failure through the BelloTreno proxy even when the same URL later opens in a
browser. BelloTreno treats this as a transport failure, not as "train not
found". The Pages Function uses browser-like request headers, a bounded timeout,
limited retry for transient statuses such as `429` and `5xx`, and a short
successful-response cache to reduce repeated upstream hits during rapid
searches. It still returns an unavailable payload when the upstream cannot be
reached, rather than fabricating stale realtime data.

In production, Italo API traffic should use the VPS `rfi-proxy` path instead of
Cloudflare Pages direct `fetch()`. Italo is served behind Cloudflare, and Pages
egress can receive an upstream `403` even though the same API URL opens in a
normal browser. This is not a browser CORS failure: the browser calls
BelloTreno's same-origin `/api/italo/*` endpoint successfully, and the `403`
comes from the server-side request from Pages to Italo.

The Pages Function supports these proxy settings:

| Variable | Required | Purpose |
| --- | --- | --- |
| `ITALO_PROXY_BASE_URL` | production | proxy endpoint, for example `https://api.bellotreno.org/` |
| `ITALO_PROXY_TOKEN` | when calling VPS directly | value sent as `X-Bello-Token` to `rfi-proxy` |
| `ITALO_PROXY_CALLER_ORIGIN` | optional | referer used when the proxy endpoint is the public Worker; defaults to `https://bellotreno.org` |

`RFI_PROXY_BASE_URL` and `RFI_PROXY_TOKEN` are accepted as fallback names, but
new Italo deployments should prefer the Italo-specific names so the runtime
configuration remains explicit.

If `ITALO_PROXY_BASE_URL` points directly to the VPS proxy, set
`ITALO_PROXY_TOKEN` to the same secret used by the VPS `SECURITY_TOKEN`. The
token is injected only inside the Pages Function and is never exposed to browser
code.

If `ITALO_PROXY_BASE_URL` points to the existing public Worker
`https://ah.bellotreno.workers.dev/`, the Worker must also allow Italo targets:
the VPS token remains in the Worker's `RFI_PROXY_TOKEN` secret, and
`ITALO_PROXY_TOKEN` is not required in Pages for that route.

```js
function targetAllowed(value) {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === "viaggiatreno.it" ||
      host.endsWith(".viaggiatreno.it") ||
      host === "rfi.it" ||
      host.endsWith(".rfi.it") ||
      host === "italotreno.com" ||
      host.endsWith(".italotreno.com")
    );
  } catch {
    return false;
  }
}
```

That Worker remains outside this repository, so its allowlist must be deployed
separately. The VPS `rfi-proxy` in this repository also has to be redeployed
after pulling the image that includes `italotreno.com` in its own allowlist.

## Station Codes

Italo station codes are not ViaggiaTreno station ids. BelloTreno keeps those
identifiers as separate typed fields and uses only confirmed mappings.

| ViaggiaTreno name | ViaggiaTreno id | Italo code | Italo display name | Italo payload `RfiLocationCode` | Notes |
| --- | --- | --- | --- | --- | --- |
| MILANO CENTRALE | `S01700` | `MC_` | Milano Centrale | `1728` |  |
| RHO FIERA | `S01039` | `RRO` | Milano Rho Fiera / Milano Expo Rho | `3098` |  |
| ROMA TERMINI | `S08409` | `RMT` | Roma Termini | `2416` |  |
| ROMA TIBURTINA | `S08217` | `RTB` | Roma Tiburtina | `2385` |  |
| FIRENZE SANTA MARIA NOVELLA | `S06421` | `SMN` | Firenze Santa Maria Novella | `1325` |  |
| BOLOGNA CENTRALE | `S05043` | `BO2` | Bologna Centrale | `942` |  |
| REGGIO EMILIA AV MEDIOPADANA | `S05254` | `AAV` | Reggio Emilia AV Mediopadana / Mediopadana R.Emilia | `4054` |  |
| TORINO PORTA SUSA | `S00035` | `OUE` | Torino Porta Susa / Torino Porta di Susa | `3163` |  |
| TORINO PORTA NUOVA | `S00219` | `TOP` | Torino Porta Nuova | `2876` |  |
| MILANO ROGOREDO | `S01820` | `RG_` | Milano Rogoredo | `1720` |  |
| NAPOLI AFRAGOLA | `S09988` | `NAF` | Napoli Afragola | `4020` |  |
| NAPOLI CENTRALE | `S09218` | `NAC` | Napoli | `1888` |  |
| CASERTA | `S09211` | `CEA` | Caserta | `945` |  |
| SALERNO | `S09818` | `SAL` | Salerno | `2617` |  |
| REGGIO DI CALABRIA CENTRALE | `S11781` | `RCE` | Reggio Calabria | `116` |  |
| VILLA S.GIOVANNI | `S11774` | `VSG` | Villa S.Giovanni | `183` |  |
| ROSARNO | `S11765` | `RUT` | Rosarno | `133` |  |
| LAMEZIA TERME CENTRALE | `S11749` | `LON` | Lamezia Terme C | `75` |  |
| PAOLA | `S11739` | `PAR` | Paola | `107` |  |
| SCALEA S.DOMENICA TALAO | `S11727` | `SDC` | Scalea | `154` |  |
| MARATEA | `S11723` | `MRT` | Maratea | `81` |  |
| SAPRI | `S11721` | `SRI` | Sapri | `153` |  |
| VALLO DELLA LUCANIA-CASTELNUOVO | `S11709` | `VLH` | Vallo d.Lucania | `177` |  |
| AGROPOLI CASTELLABATE | `S11705` | `AGR` | Agropoli Castellabate | `5` |  |
| TRIESTE CENTRALE | `S03317` | `TSC` | Trieste C.le | `2925` | Shares the same Italo payload RFI code as `RHA`; use Italo code or ViaggiaTreno id to disambiguate. |
| MONFALCONE | `S03310` | `MNF` | Monfalcone | `1770` |  |
| TRIESTE AIRPORT | `S03213` | `RHA` | Trieste Airport | `2925` | Shares the same Italo payload RFI code as `TSC`; use Italo code or ViaggiaTreno id to disambiguate. |
| LATISANA LIGNANO-BIBIONE | `S03202` | `LTL` | Latisana-Lignano | `1540` |  |
| PORTOGRUARO CAORLE | `S03200` | `PGR` | Portogruaro | `2261` |  |
| S.DONA' DI PIAVE-JESOLO | `S02666` | `SDP` | S.Dona-Jesolo | `2489` |  |
| VENEZIA MESTRE | `S02589` | `VEM` | Venezia Mestre | `3002` |  |
| VENEZIA S.LUCIA | `S02593` | `VSL` | Venezia Santa Lucia | `3009` |  |
| PADOVA | `S02581` | `PD_` | Padova | `2000` |  |
| VERONA PORTA NUOVA | `S02430` | `VPN` | Verona Porta Nuova | `3025` |  |
| BRESCIA | `S01717` | `BSC` | Brescia | `734` |  |
| DESENZANO DEL GARDA-SIRMIONE | `S02084` | `DSG` | Desenzano | `1229` |  |
| PESCHIERA DEL GARDA | `S02088` | `PSY` | Peschiera | `2099` |  |
| VICENZA | `S02446` | `VIC` | Vicenza | `3043` |  |
| FERRARA | `S05712` | `F__` | Ferrara | `1309` | RFI code observed from train 8918 payload. |
| ROVIGO | `S05706` | `R__` | Rovigo | `2445` |  |
| BARI CENTRALE | `S11119` | `BAC` | Bari Centrale | `995` |  |
| MOLFETTA | `S11114` | `ML_` | Molfetta | `652` | Shares the same provided RFI code as `BIG`; use Italo code or ViaggiaTreno id to disambiguate. |
| BISCEGLIE | `S11113` | `BIG` | Bisceglie | `652` | Shares the same provided RFI code as `ML_`; use Italo code or ViaggiaTreno id to disambiguate. |
| TRANI | `S11112` | `TR_` | Trani | `2902` |  |
| BARLETTA | `S11108` | `BLT` | Barletta | `598` |  |
| FOGGIA | `S11100` | `FG_` | Foggia | `1334` |  |
| BENEVENTO | `S09311` | `BEN` | Benevento | `626` |  |
| BOLZANO | `S02026` | `BLZ` | Bolzano | `685` |  |
| TRENTO | `S02038` | `TCN` | Trento | `2912` |  |
| ROVERETO | `S02044` | `RVR` | Rovereto | `2440` |  |

The `/api/italo/stations` function attempts to parse Italo's station list from
`/it/stazione`. If the upstream page changes or cannot be fetched, the function
falls back to a small built-in list of core high-speed stations. This gives the
frontend a deterministic way to discover station codes without requiring a
manually maintained complete list before the feature can work.

The homepage station search still uses only ViaggiaTreno station search results.
Italo stations are not shown as separate search suggestions. The Italo station
board is requested only after the user has opened a ViaggiaTreno station page
and BelloTreno can bridge that selected station to a confirmed Italo station.

Station-board merging resolves an Italo station in this order:

1. explicit `code` query value, such as `MC_`;
2. confirmed ViaggiaTreno station id, such as `S01700 -> MC_`;
3. unique Italo payload `RfiLocationCode`, only when it maps to exactly one
   Italo station;
4. exact normalized station-name or alias match, such as `RHO FIERA -> RRO`;
5. built-in fallback station aliases.

ViaggiaTreno station page ids and Italo payload location codes are not treated
as the same numbering system. For example, Milano Centrale can appear as
`S01700` on a ViaggiaTreno station-board URL, while Italo train payloads expose
`MC_` with `RfiLocationCode: 1728`. BelloTreno links those values only because
the mapping table explicitly confirms that relationship. It does not derive
`MC_` from the number `1700`, and it does not use ambiguous `RfiLocationCode`
values such as `2925` or `652` as unique station keys.

Name matching normalizes case, accents, punctuation, and spacing. For example,
`MILANO CENTRALE`, `Milano Centrale`, and `Milano C.le` can resolve to `MC_`,
while `MILANO ROGOREDO` resolves separately to `RG_`.

## Normalized Train Model

Italo trains are normalized as independent provider records:

```json
{
  "available": true,
  "provider": "italo",
  "operator": "Italo",
  "codiceCliente": "ITALO",
  "categoria": "AV",
  "compNumeroTreno": "AV 9908"
}
```

The `AV` category means `Alta Velocita`. BelloTreno renders it with the Italo
badge color `#982719`, so an Italo train number appears as `AV 9908` rather than
as a generic train number.

`StazionePartenza`, `StazioniFerme`, and `StazioniNonFerme` are merged into the
timeline. Despite the Italian names, `StazioniNonFerme` in this payload is used
as future scheduled stops, not skipped stops. Future stops keep scheduled times
and delay estimates but do not mark the train as already passed.

Mapped timeline stops expose ViaggiaTreno station names and station-page ids for
navigation, while preserving Italo's original `LocationCode`, display name, and
payload `RfiLocationCode` for diagnostics. For example, train 8918 maps Italo
`NAC` / `Napoli` to `NAPOLI CENTRALE` / `S09218`, and distinguishes `RHA`
Trieste Airport from `TSC` Trieste Centrale even though both can carry
`RfiLocationCode: 2925` in the Italo payload.

## Station Boards

For a supported station page, BelloTreno fetches ViaggiaTreno and Italo station
boards concurrently. The Italo request is best-effort:

- if Italo fails, the existing ViaggiaTreno board continues to render;
- if ViaggiaTreno fails but Italo returns data, the Italo board can still render;
- rows are merged and sorted by scheduled time;
- Italo platform values may be empty or `N/A`, and both are treated as valid
  upstream states rather than errors.

Italo station-board rows expose useful orientation text such as:

```text
CARROZZA 1 IN CODA AL TRENO
CARROZZA 1 IN TESTA AL TRENO
```

This is a passenger orientation hint, not a full train formation. BelloTreno does
not render an Italo coach strip from this data.

## Operational Notes

- Do not call Italo endpoints directly from browser code.
- Do not mix Italo into ViaggiaTreno `codiceCliente` numeric semantics; use
  `provider: "italo"` and `codiceCliente: "ITALO"` at the normalized boundary.
- Do not use Italo booking APIs for this realtime feature. Booking APIs have
  session semantics and answer a different product question.
- Keep station mappings evidence-based. Add or change a mapping only when the
  ViaggiaTreno station id/name and Italo code/name are confirmed together, or
  when the relationship is observed in Italo train/station payloads without
  ambiguity.
