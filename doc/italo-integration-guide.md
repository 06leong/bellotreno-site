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

## Station Codes

Italo station codes are not ViaggiaTreno station ids. Examples:

| Italo code | Italo display name | Italo payload `RfiLocationCode` | ViaggiaTreno station page note |
| --- | --- | --- | --- |
| `MC_` | Milano Centrale | `1728` | ViaggiaTreno station page id can be `S01700`; this id is not used as an Italo bridge |
| `RRO` | Milano Rho Fiera / Milano Expo Rho | `3098` | pending confirmation |
| `RMT` | Roma Termini | `2416` | pending confirmation |
| `RTB` | Roma Tiburtina | `2385` | pending confirmation |
| `SMN` | Firenze Santa Maria Novella | `1325` | pending confirmation |
| `BO2` | Bologna Centrale | `942` | pending confirmation |
| `AAV` | Reggio Emilia AV Mediopadana | `4054` | pending confirmation |
| `OUE` | Torino Porta Susa | `3163` | pending confirmation |
| `TOP` | Torino Porta Nuova | `2876` | pending confirmation |

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
2. exact normalized station-name or alias match, such as `MILANO CENTRALE -> MC_`;
3. exact or alias station-name match through the Italo station list;
4. built-in fallback station aliases.

ViaggiaTreno station page ids and Italo payload location codes are not treated
as the same numbering system. For example, Milano Centrale can appear as
`S01700` on a ViaggiaTreno station-board URL, while Italo train payloads expose
`MC_` with `RfiLocationCode: 1728`. BelloTreno therefore uses strict normalized
name matching for station-board merging unless an Italo code is already known.
Name matching normalizes case, accents, punctuation, and spacing. For example,
`MILANO CENTRALE`, `Milano Centrale`, and `Milano C.le` can resolve to `MC_`,
but a broader name such as `Milano Rogoredo` will not be treated as Milano
Centrale simply because it contains `Milano`.

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
- Keep the built-in station fallback small and evidence-based. Add new Italo
  station-code mappings when they are observed in train payloads or in the Italo
  station list, not by guessing.
