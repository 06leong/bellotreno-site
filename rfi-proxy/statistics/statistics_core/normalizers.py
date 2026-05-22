from __future__ import annotations

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
    return f"unknown-{hash((number, origin, epoch))}"


def is_same_service_date(item: dict | None, date_text: str) -> bool:
    return service_date_from_item(item, date_text) == date_text
