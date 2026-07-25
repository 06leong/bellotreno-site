import re
from urllib.parse import urlparse


ALLOWED_BASE_DOMAINS = ("viaggiatreno.it", "rfi.it", "italotreno.com", "trenord.it", "lefrecce.it")
ITALO_BASE_DOMAINS = ("italotreno.com",)
TRENORD_BASE_DOMAINS = ("trenord.it",)
LEFRECCE_BASE_DOMAINS = ("lefrecce.it",)
LEFRECCE_API_PREFIX = "/Channels.Website.BFF.WEB/website/"
MAX_PROXY_BODY_BYTES = 128 * 1024


def hostname_for(target_url):
    try:
        return (urlparse(target_url).hostname or "").lower()
    except Exception:
        return ""


def host_matches(domain, allowed_base_domains):
    return any(domain == allowed or domain.endswith(f".{allowed}") for allowed in allowed_base_domains)


def is_italo_url(target_url):
    return host_matches(hostname_for(target_url), ITALO_BASE_DOMAINS)


def is_trenord_url(target_url):
    return host_matches(hostname_for(target_url), TRENORD_BASE_DOMAINS)


def is_lefrecce_url(target_url):
    return host_matches(hostname_for(target_url), LEFRECCE_BASE_DOMAINS)


def is_lefrecce_api_url(target_url):
    try:
        return is_lefrecce_url(target_url) and urlparse(target_url).path.startswith(LEFRECCE_API_PREFIX)
    except Exception:
        return False


def is_italo_api_url(target_url):
    try:
        return urlparse(target_url).path.startswith("/api/")
    except Exception:
        return False


def is_allowed(target_url):
    if is_lefrecce_url(target_url):
        return is_lefrecce_api_url(target_url)
    return host_matches(hostname_for(target_url), ALLOWED_BASE_DOMAINS)


def method_is_allowed(target_url, method):
    normalized_method = (method or "").upper()
    return normalized_method == "GET" or (
        normalized_method == "POST" and is_lefrecce_api_url(target_url)
    )


def lefrecce_session_cookie(value):
    match = re.search(r"(?:^|;\s*)WSESSIONID=([A-Za-z0-9._~-]+)", value or "")
    return f"WSESSIONID={match.group(1)}" if match else ""
