# app.py - BelloTreno 专用安全代理
from flask import Flask, request, Response
from curl_cffi import requests
from flask_cors import CORS
import json
import os
from urllib.parse import urlparse

app = Flask(__name__)
# 允许跨域请求
CORS(app)

# 1. 密钥配置（从环境变量读取，对应 docker-compose.yml 中的 SECURITY_TOKEN）
SECURITY_TOKEN = os.getenv("SECURITY_TOKEN", "")

# 2. 域名白名单校验函数
def is_allowed(target_url):
    # 允许访问的基础域名
    allowed_base_domains = ["viaggiatreno.it", "rfi.it"]
    try:
        parsed = urlparse(target_url)
        domain = parsed.netloc.lower()
        # 允许域名本身或其任何子域名 (例如 rfi.it 和 www.rfi.it)
        return any(domain == d or domain.endswith("." + d) for d in allowed_base_domains)
    except Exception:
        return False

@app.route('/', methods=['GET'])
def proxy():
    # --- 安全校验：令牌 ---
    client_token = request.headers.get("X-Bello-Token")
    
    # 如果没配置 Token，为了安全起见拒绝所有请求，提示运维检查环境
    if not SECURITY_TOKEN:
        return json.dumps({"error": "Internal Server Error: SECURITY_TOKEN not configured on VPS"}), 500
        
    # 校验客户端带过来的 Token 是否匹配
    if client_token != SECURITY_TOKEN:
        return json.dumps({"error": "Unauthorized: Invalid or missing token"}), 401

    # --- 获取并校验目标地址 ---
    target_url = request.args.get('url')
    if not target_url:
        return json.dumps({"error": "Missing 'url' parameter"}), 400

    # --- 安全校验：域名白名单 ---
    if not is_allowed(target_url):
        return json.dumps({"error": f"Forbidden: Domain not in whitelist"}), 403

    # 强制使用 HTTPS
    if target_url.startswith("http://"):
        target_url = target_url.replace("http://", "https://")

    print(f"Fetching: {target_url}")

    try:
        # 核心：使用 curl_cffi 模拟真实浏览器指纹，绕过防火墙
        response = requests.get(
            target_url,
            impersonate="chrome120", # 核心模拟参数
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
                "Referer": "https://www.viaggiatreno.it/"
            },
            timeout=30
        )

        # 过滤掉不必要的头信息
        excluded_headers = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
        headers = [
            (name, value) for (name, value) in response.headers.items()
            if name.lower() not in excluded_headers
        ]

        # 转发目标网站返回的内容和状态码
        return Response(response.content, response.status_code, headers)

    except Exception as e:
        print(f"Error during proxy request: {e}")
        return json.dumps({"error": str(e)}), 500

if __name__ == '__main__':
    # 容器内监听 8080 端口
    app.run(host='0.0.0.0', port=8080)
