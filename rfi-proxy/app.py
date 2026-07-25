import json
import os

from curl_cffi import requests
from flask import Flask, Response, request
from flask_cors import CORS
from proxy_policy import (
    MAX_PROXY_BODY_BYTES,
    is_allowed,
    is_italo_api_url,
    is_italo_url,
    is_lefrecce_api_url,
    is_lefrecce_url,
    is_trenord_url,
    lefrecce_session_cookie,
    method_is_allowed,
)

app = Flask(__name__)
CORS(app)

SECURITY_TOKEN = os.getenv("SECURITY_TOKEN", "")
LOG_REQUESTS = os.getenv("LOG_REQUESTS", "false").lower() == "true"

CHROME_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

def upstream_headers(target_url, method="GET", upstream_cookie=""):
    if is_lefrecce_url(target_url):
        headers = {
            "User-Agent": CHROME_USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
            "Origin": "https://www.lefrecce.it",
            "Referer": "https://www.lefrecce.it/Channels.Website.WEB/",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        }
        if method == "POST":
            headers["Content-Type"] = "application/json"
        if upstream_cookie:
            headers["Cookie"] = upstream_cookie
        return headers

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

    if is_trenord_url(target_url):
        return {
            "User-Agent": CHROME_USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
            "Referer": "https://www.trenord.it/en/routes-and-timetables/journey/real-time/",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        }

    return {
        "User-Agent": CHROME_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.viaggiatreno.it/",
    }


@app.route("/", methods=["GET", "POST"])
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

    if not method_is_allowed(target_url, request.method):
        return json.dumps({"error": "Method Not Allowed"}), 405

    if (request.content_length or 0) > MAX_PROXY_BODY_BYTES:
        return json.dumps({"error": "Request body too large"}), 413

    if LOG_REQUESTS:
        print(f"Fetching: {target_url}")

    try:
        response = requests.request(
            request.method,
            target_url,
            impersonate="chrome120",
            headers=upstream_headers(
                target_url,
                method=request.method,
                upstream_cookie=lefrecce_session_cookie(
                    request.headers.get("X-Bello-Upstream-Cookie")
                ) if is_lefrecce_url(target_url) else "",
            ),
            data=request.get_data() if request.method == "POST" else None,
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
