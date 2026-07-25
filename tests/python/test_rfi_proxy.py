from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "rfi-proxy"))

from proxy_policy import is_allowed, lefrecce_session_cookie, method_is_allowed


class RfiProxyTests(unittest.TestCase):
    def test_lefrecce_allowlist_is_limited_to_the_bff_website_path(self):
        self.assertTrue(is_allowed(
            "https://www.lefrecce.it/Channels.Website.BFF.WEB/website/ticket/solutions"
        ))
        self.assertFalse(is_allowed("https://www.lefrecce.it/private/admin"))

    def test_cookie_sanitizer_forwards_only_the_lefrecce_session(self):
        self.assertEqual(
            lefrecce_session_cookie("other=ignored; WSESSIONID=session:123; unsafe=ignored"),
            "WSESSIONID=session:123",
        )
        self.assertEqual(lefrecce_session_cookie("other=ignored"), "")

    def test_post_is_limited_to_the_lefrecce_bff(self):
        self.assertTrue(method_is_allowed(
            "https://www.lefrecce.it/Channels.Website.BFF.WEB/website/ticket/solutions",
            "POST",
        ))
        self.assertFalse(method_is_allowed(
            "https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno",
            "POST",
        ))
        self.assertTrue(method_is_allowed(
            "https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno",
            "GET",
        ))


if __name__ == "__main__":
    unittest.main()
