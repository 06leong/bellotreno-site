from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    APP_TZ = ZoneInfo("Europe/Rome")
except ZoneInfoNotFoundError:
    APP_TZ = timezone(timedelta(hours=2), "Europe/Rome")


def as_int(value, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def pick(source: dict | None, *keys: str, default=None):
    if not isinstance(source, dict):
        return default
    for key in keys:
        value = source.get(key)
        if value is not None and value != "":
            return value
    return default


def normalize_category(value: str | None) -> str:
    text = str(value or "").strip().upper()
    if not text:
        return ""
    if "EC FR" in text:
        return "EC"
    return text.split()[0]


def midnight_epoch_ms(date_text: str | None = None) -> str:
    if date_text:
        year, month, day = map(int, date_text.split("-"))
        dt = datetime(year, month, day, tzinfo=APP_TZ)
    else:
        now = datetime.now(APP_TZ)
        dt = datetime(now.year, now.month, now.day, tzinfo=APP_TZ)
    return str(int(dt.timestamp() * 1000))


def service_date_from_epoch_ms(epoch_ms: int | str | None, fallback_date: str | None = None) -> str:
    value = as_int(epoch_ms, 0)
    if value <= 0:
        return fallback_date or datetime.now(APP_TZ).date().isoformat()
    return datetime.fromtimestamp(value / 1000, APP_TZ).date().isoformat()


def service_date_from_item(item: dict | None, fallback_date: str | None = None) -> str:
    epoch_ms = pick(item, "dataPartenzaTreno", "dataPartenza", "departureEpochMs", "departureEpoch")
    return service_date_from_epoch_ms(epoch_ms, fallback_date)


def origin_code_from_item(item: dict | None) -> str:
    """Return the ViaggiaTreno origin code used by andamentoTreno identity."""
    return str(pick(item, "codLocOrig", "idOrigine", "codOrigine", default="") or "").strip()


def train_key_from_parts(
    train_number: str | int | None,
    origin_code: str | int | None,
    departure_epoch_ms: int | str | None,
    fallback_date: str | None = None,
) -> str:
    number = str(train_number or "").strip()
    origin = str(origin_code or "").strip()
    epoch = str(departure_epoch_ms or "").strip()
    if number and origin and epoch:
        return f"{number}-{origin}-{epoch}"
    if number and origin:
        return f"{number}-{origin}-{fallback_date or datetime.now(APP_TZ).date().isoformat()}"
    provisional_source = "\x1f".join((number, origin, epoch, fallback_date or ""))
    digest = hashlib.sha256(provisional_source.encode("utf-8")).hexdigest()[:20]
    return f"unknown-{digest}"


def is_same_service_date(item: dict | None, date_text: str) -> bool:
    return service_date_from_item(item, date_text) == date_text


def is_service_date_within_lookback(item: dict | None, date_text: str, lookback_days: int = 0) -> bool:
    service_date = service_date_from_item(item, date_text)
    try:
        service_day = datetime.fromisoformat(service_date).date()
        collection_day = datetime.fromisoformat(date_text).date()
    except ValueError:
        return service_date == date_text
    if service_day > collection_day:
        return False
    return collection_day - service_day <= timedelta(days=max(0, lookback_days))


def is_collectable_service(
    item: dict | None,
    collection_date: str,
    *,
    normal_lookback_days: int,
    active_ttl_days: int,
    known_active_train_keys: set[str] | None = None,
) -> bool:
    if is_service_date_within_lookback(item, collection_date, normal_lookback_days):
        return True
    if not known_active_train_keys or not is_service_date_within_lookback(
        item,
        collection_date,
        active_ttl_days,
    ):
        return False
    service_date = service_date_from_item(item, collection_date)
    train_key = train_key_from_parts(
        pick(item, "numeroTreno", "trainNumber", "compNumeroTreno", default=""),
        origin_code_from_item(item),
        pick(
            item,
            "dataPartenzaTreno",
            "dataPartenza",
            default=midnight_epoch_ms(service_date),
        ),
        fallback_date=service_date,
    )
    return train_key in known_active_train_keys
