import json
import os
from urllib.parse import urlparse

from curl_cffi import requests
from flask import Flask, Response, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

SECURITY_TOKEN = os.getenv("SECURITY_TOKEN", "")
LOG_REQUESTS = os.getenv("LOG_REQUESTS", "false").lower() == "true"

ALLOWED_BASE_DOMAINS = ("viaggiatreno.it", "rfi.it", "italotreno.com")
ITALO_BASE_DOMAINS = ("italotreno.com",)
CHROME_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def hostname_for(target_url):
    try:
        return (urlparse(target_url).hostname or "").lower()
    except Exception:
        return ""


def host_matches(domain, allowed_base_domains):
    return any(domain == allowed or domain.endswith(f".{allowed}") for allowed in allowed_base_domains)


def is_allowed(target_url):
    return host_matches(hostname_for(target_url), ALLOWED_BASE_DOMAINS)


def is_italo_url(target_url):
    return host_matches(hostname_for(target_url), ITALO_BASE_DOMAINS)


def is_italo_api_url(target_url):
    try:
        return urlparse(target_url).path.startswith("/api/")
    except Exception:
        return False


def upstream_headers(target_url):
    if is_italo_url(target_url):
        accept = (
            "application/json, text/plain, */*"
            if is_italo_api_url(target_url)
            else "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        )
        return {
            "User-Agent": CHROME_USER_AGENT,
            "Accept": accept,
            "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
            "Referer": "https://italoinviaggio.italotreno.com/it",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        }

    return {
        "User-Agent": CHROME_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.viaggiatreno.it/",
    }


@app.route("/", methods=["GET"])
def proxy():
    client_token = request.headers.get("X-Bello-Token")

    if not SECURITY_TOKEN:
        return json.dumps({"error": "Internal Server Error: SECURITY_TOKEN not configured on VPS"}), 500

    if client_token != SECURITY_TOKEN:
        return json.dumps({"error": "Unauthorized: Invalid or missing token"}), 401

    target_url = request.args.get("url")
    if not target_url:
        return json.dumps({"error": "Missing 'url' parameter"}), 400

    if target_url.startswith("http://"):
        target_url = target_url.replace("http://", "https://", 1)

    if not is_allowed(target_url):
        return json.dumps({"error": "Forbidden: Domain not in whitelist"}), 403

    if LOG_REQUESTS:
        print(f"Fetching: {target_url}")

    try:
        response = requests.get(
            target_url,
            impersonate="chrome120",
            headers=upstream_headers(target_url),
            timeout=30,
        )

        excluded_headers = ("content-encoding", "content-length", "transfer-encoding", "connection")
        headers = [
            (name, value)
            for (name, value) in response.headers.items()
            if name.lower() not in excluded_headers
        ]

        return Response(response.content, response.status_code, headers)
    except Exception as e:
        print(f"Error during proxy request: {e}")
        return json.dumps({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
