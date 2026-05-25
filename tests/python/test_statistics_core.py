import sys
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "rfi-proxy" / "statistics"))

from statistics_core.normalizers import (  # noqa: E402
    APP_TZ,
    is_service_date_within_lookback,
    is_same_service_date,
    normalize_category,
    service_date_from_epoch_ms,
    service_date_from_item,
    train_key_from_parts,
)


def epoch_ms(date_time: datetime) -> int:
    return int(date_time.timestamp() * 1000)


class StatisticsCoreTest(unittest.TestCase):
    def test_normalize_category(self):
        self.assertEqual(normalize_category("EC FR"), "EC")
        self.assertEqual(normalize_category("IR"), "IR")
        self.assertEqual(normalize_category("REG 1234"), "REG")

    def test_service_date_from_epoch_ms_uses_rome_timezone(self):
        same_day = epoch_ms(datetime(2026, 5, 21, 23, 50, tzinfo=APP_TZ))
        next_day = epoch_ms(datetime(2026, 5, 22, 0, 5, tzinfo=APP_TZ))

        self.assertEqual(service_date_from_epoch_ms(same_day), "2026-05-21")
        self.assertEqual(service_date_from_epoch_ms(next_day), "2026-05-22")

    def test_service_date_from_item_uses_fallback_without_epoch(self):
        self.assertEqual(service_date_from_item({}, "2026-05-21"), "2026-05-21")

    def test_same_service_date_filter(self):
        item = {"dataPartenzaTreno": epoch_ms(datetime(2026, 5, 22, 0, 5, tzinfo=APP_TZ))}
        self.assertFalse(is_same_service_date(item, "2026-05-21"))
        self.assertTrue(is_same_service_date(item, "2026-05-22"))

    def test_service_date_lookback_includes_previous_day(self):
        previous_evening = {"dataPartenzaTreno": epoch_ms(datetime(2026, 5, 21, 22, 30, tzinfo=APP_TZ))}
        current_day = {"dataPartenzaTreno": epoch_ms(datetime(2026, 5, 22, 6, 5, tzinfo=APP_TZ))}
        next_day = {"dataPartenzaTreno": epoch_ms(datetime(2026, 5, 23, 0, 10, tzinfo=APP_TZ))}

        self.assertTrue(is_service_date_within_lookback(previous_evening, "2026-05-22", lookback_days=1))
        self.assertTrue(is_service_date_within_lookback(current_day, "2026-05-22", lookback_days=1))
        self.assertFalse(is_service_date_within_lookback(next_day, "2026-05-22", lookback_days=1))
        self.assertFalse(is_service_date_within_lookback(previous_evening, "2026-05-22", lookback_days=0))

    def test_train_key_uses_service_date(self):
        departure = epoch_ms(datetime(2026, 5, 21, 8, 0, tzinfo=APP_TZ))
        self.assertEqual(train_key_from_parts("1234", "S01700", departure), f"1234-S01700-{departure}")


if __name__ == "__main__":
    unittest.main()
