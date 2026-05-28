# BelloTreno

BelloTreno 是一个**意大利铁路实时信息面板**，通过自建后端代理绕过官方 API 反爬限制，经 Cloudflare Worker 中间层转发，最终在静态前端网站上以更清晰、易读的 UI 展示列车实时动态、车站到发信息与 RFI 出行公告。

线上地址：https://bellotreno.org/（`real.bellotreno.org` 作为旧入口保留，并建议 301 到主域名）

---

## 一、2026-05 当前功能快照

BelloTreno 现在包含五个主要页面，并按 `/it`、`/en`、`/zh` 生成三套静态多语言 URL。根路径 `/` 不承载页面内容，而是由 Cloudflare Pages Function 根据 `bt_locale` cookie 与浏览器 `Accept-Language` 重定向到合适语言；无法匹配时默认进入 `/it/`。

- `/it/`、`/en/`、`/zh/`：列车实时查询、停站时间线、运行状态、SmartCaring 运行报告，以及可用时的瑞士列车编组。
- `/it/station`、`/en/station`、`/zh/station`：意大利车站出发/到达面板，支持天气、站台、延误、取消、改线和跨境终点补全。
- `/it/infomobilita`、`/en/infomobilita`、`/zh/infomobilita`：RFI 出行公告与区域筛选。
- `/it/statistics`、`/en/statistics`、`/zh/statistics`：意大利铁路每日运行统计，包括运行中列车曲线、状态分布、准点率、类别排行、车次/车站/关系查询。
- `/it/about`、`/en/about`、`/zh/about`：项目说明、数据来源、限制和 Roadmap。

当前数据链路分为四类：

1. **ViaggiaTreno / RFI 实时数据**：浏览器通过 Cloudflare Worker `ah.bellotreno.workers.dev` 访问 VPS `rfi-proxy`，由 `curl_cffi` 模拟浏览器指纹请求官方 API。
2. **Swiss OpenTransportData 编组数据**：Cloudflare Pages Function 读取 Pages Secret 中的 Train Formation token，只在服务端请求 `formations_full`，前端不接触 token。
3. **Statistics 聚合数据**：Cloudflare Pages Function `/api/statistics/*` 转发到 VPS 上的 `bellotreno-statistics` 服务；当前部署使用 `https://stats-api.bellotreno.org/v1` 作为 statistics 上游 API。该服务定时扫描车站 registry、`partenze`/`arrivi` board 和 `andamentoTreno`，把聚合结果写入 SQLite 与 JSON cache。
4. **Trenord line notices**：Cloudflare Pages Function `/api/trenord/traffic` fetches Trenord's train BFF and `direttrici` feed, maps the train `direttrice` to line-level notices, and feeds the collapsed `Traffic info` card for Trenord trains only.

浏览器缓存方面，项目使用 `public/_headers` 控制 HTML 与脚本重新校验，并在 `BaseLayout.astro` 中给 `/scripts/*.js` 追加 build version 查询参数，避免 Cloudflare Pages 新部署后 iOS Safari 或桌面浏览器继续使用旧脚本。

访问统计方面，`BaseLayout.astro` 支持可选 Umami 注入。只有同时配置 `PUBLIC_UMAMI_SCRIPT_URL` 和 `PUBLIC_UMAMI_WEBSITE_ID` 时才会加载，默认限定 `PUBLIC_UMAMI_DOMAINS=bellotreno.org,real.bellotreno.org`，并启用 `data-do-not-track` 和 `data-exclude-search`。

---

## 二、整体架构

```
用户浏览器 (前端)
     │
     │  HTTPS 请求
     ▼
┌──────────────────────────────────┐
│  Cloudflare Worker (主 CORS 代理) │   ah.bellotreno.workers.dev
│  - Origin/Referer 域名白名单校验   │
│  - 注入安全令牌 X-Bello-Token     │
│  - CORS 跨域头管理               │
│  - 缓解 VPS 直接暴露的风险        │
└──────────────┬───────────────────┘
               │  附带 Token 的 HTTPS 请求
               ▼
┌──────────────────────────────────┐
│  Linux VPS (Docker 容器)          │   api.bellotreno.org
│  rfi-docker-proxy (Flask + Gunicorn)│
│  - Token 令牌验证                 │
│  - 目标域名白名单 (仅 viaggiatreno.it / rfi.it)
│  - curl_cffi 模拟 Chrome 浏览器指纹│
│  - 绕过 ViaggiaTreno 的反爬 WAF   │
└──────────────┬───────────────────┘
               │  模拟浏览器请求
               ▼
┌──────────────────────────────────┐
│  ViaggiaTreno / RFI 官方 API      │
│  www.viaggiatreno.it              │
│  www.rfi.it (RSS)                 │
└──────────────────────────────────┘

用户浏览器 (前端)
     │
     │  SmartCaring 通知查询
     ▼
┌──────────────────────────────────┐
│  Cloudflare Worker (SmartCaring)  │   notify.bellotreno.workers.dev
│  - Origin 白名单校验              │
│  - 直接调用 ViaggiaTreno SmartCaring API (无需 TLS 欺骗)
│  - 聚合输出 today/recent/history/stats
│  - Cache-Control: max-age=120     │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  ViaggiaTreno SmartCaring API     │
│  .../news/smartcaring?commercialTrainNumber=N
└──────────────────────────────────┘

用户浏览器 (前端)
     │
     │  根路径语言协商 / Swiss Formation / Statistics 查询
     ▼
┌──────────────────────────────────┐
│  Cloudflare Pages Functions       │  bellotreno.org/
│  - /                              │
│  - /api/swiss/formation           │
│  - /api/statistics/*              │
│  - /api/trenord/traffic           │
│  - 读取 Pages Secrets             │
│  - 不向浏览器暴露 API token        │
│  - per-function Cache-Control     │
└──────────────┬───────────────────┘
               │
               ├── OpenTransportData.swiss Train Formation API
               │
               └── VPS statistics API: stats-api.bellotreno.org/v1
                         │
                         ▼
                  SQLite / JSON cache
```

**数据流方向：** 用户浏览器 → CF Worker → VPS 代理 → 意大利铁路官方 API → 原路返回

### 官方 API 的反爬机制

ViaggiaTreno 的 REST API（`viaggiatreno.it/infomobilita/resteasy/viaggiatreno/`）虽然是公开的，但部署了 **WAF（Web Application Firewall）**，会对非浏览器请求进行拦截。直接在前端 `fetch()` 调用会遇到：
- **CORS 跨域限制**：官方服务器不返回 `Access-Control-Allow-Origin` 头
- **TLS 指纹检测**：普通 HTTP 客户端（如 Python requests、Node fetch）的 TLS 握手特征与真实浏览器不同，会被 WAF 拦截

Cloudflare Worker 的 `fetch()` 同样无法绕过 TLS 指纹检测，因为它的网络栈不模拟浏览器指纹。因此需要 VPS 上运行的 `curl_cffi` 库来**伪造 Chrome 120 的完整 TLS/JA3 指纹**。

## 各层详细讲解

###  后端 — VPS Docker 代理（rfi-docker-proxy）

| 项目 | 详情 |
|------|------|
| **语言/框架** | Python 3.9 / Flask |
| **WSGI 服务器** | Gunicorn（当前 VPS 上主代理使用 2 个 Worker 更稳） |
| **核心依赖** | `curl_cffi`（C 语言绑定的 libcurl 封装，支持浏览器指纹模拟） |
| **容器化** | Docker + docker-compose，接入外部网络 `bellotreno-network` |
| **监听端口** | 容器内 8080，通过反向代理暴露为 `api.bellotreno.org` |

#### 关键代码逻辑（app.py）

```
请求进入 → Token 验证 → URL 参数提取 → 域名白名单检查 → curl_cffi 模拟 Chrome 请求 → 返回响应
```

1. **Token 验证**：从请求头 `X-Bello-Token` 读取令牌，与环境变量 `SECURITY_TOKEN` 比对，不匹配返回 401
2. **域名白名单**：解析目标 URL 的域名，只允许 `viaggiatreno.it` 和 `rfi.it` 及其子域名，防止代理被滥用为开放代理（Open Proxy）
3. **反爬绕过核心**：`curl_cffi` 的 `impersonate="chrome120"` 参数会模拟 Chrome 120 的完整 TLS 握手指纹（JA3 指纹）、HTTP/2 设置帧、header 顺序等，让目标服务器认为请求来自真实浏览器
4. **响应过滤**：去除 `content-encoding`、`transfer-encoding` 等 hop-by-hop 头，避免代理层解码问题

#### Docker 部署要点

- **Dockerfile**：基于 `python:3.9-slim` 轻量镜像，`pip install` 安装依赖后用 `gunicorn` 启动
- **docker-compose**：使用 `expose`（非 `ports`）暴露端口，意味着只在 Docker 网络内可达，由同网络的反向代理（如 Nginx Proxy Manager / Caddy）统一对外提供 HTTPS
- **外部网络**：`bellotreno-network` 是一个外部 Docker 网络，允许多个 compose 项目（如代理 + Nginx）互相通信
- **restart: always**：保证容器异常退出后自动重启

### 后端 — Statistics 聚合服务（bellotreno-statistics）

`rfi-proxy/` 现在还包含一个独立的统计服务，和主代理放在同一个 `docker-compose.yml` 中启动，但职责不同：

| 项目 | 详情 |
|------|------|
| **语言/框架** | Python 3.11 / Flask |
| **WSGI 服务器** | Gunicorn（1 个 Worker + 4 threads，线程数和 timeout 可通过 VPS `.env` 调整） |
| **容器端口** | 8081 |
| **对外域名** | 当前使用 `https://stats-api.bellotreno.org/v1`；`api.bellotreno.org/statistics/v1` 是之前讨论过的 Nginx Proxy Manager path routing 备选方案 |
| **存储** | SQLite + WAL，数据目录挂载到 `./statistics-data:/data` |
| **资源限制** | docker compose 中设置 `mem_limit: 680m` |
| **鉴权** | 请求必须带 `X-Bello-Stats-Token`，由 Cloudflare Pages Function 注入 |

统计服务的采集方式接近 `railway-opendata` 的思路，但实现更轻量：

1. 定期刷新 `elencoStazioni/1..22` 生成 station registry。
2. 扫描所有发现的车站 board，而不是只扫描少数 seed stations。
3. 当前配置同时扫描 `partenze` 和 `arrivi`；每个 station board 是独立并发任务，所以同一车站的出发板和到达板不会互相等待。
4. 从 board 发现车次后再调用 `andamentoTreno` 采集详情。
5. 将车次、停站、车站聚合、关系聚合和时间序列写入 SQLite，并生成前端读取的 JSON 结果。
6. 统计归属日期使用采集 slot 日期，同时保留列车真实始发日期 `service_date`；默认会把前一晚始发、当天仍在运行或到达的跨午夜列车计入当天统计。

当前调度采用固定 slot，而不是“采集结束后 sleep”：

- 默认每 30 分钟一次：`HH:05`、`HH:35`。
- 每天 Europe/Rome `23:55` 额外执行日终补采。
- 同一轮采集的所有 board 使用同一个逻辑采样时间，避免一轮 10 分钟采集中不同车站时间不一致。
- 如果上一轮还在运行，不会重叠启动，而是在 `collector_runs` 中记录 skipped/missed。

主要 API：

- `GET /v1/days`
- `GET /v1/summary?date=YYYY-MM-DD`
- `GET /v1/timeseries?date=YYYY-MM-DD`
- `GET /v1/trains?date=&q=&category=&status=`
- `GET /v1/stations/search?q=`
- `GET /v1/stations/{stationCode}?date=YYYY-MM-DD`
- `GET /v1/relations?date=YYYY-MM-DD`
- `GET /v1/ranking?date=YYYY-MM-DD&metric=delay`
- `POST /v1/collect`
- `GET /health`

### 中间层 — Cloudflare Workers

项目现有 **3 个** Cloudflare Worker：

| Worker 域名 | 用途 |
|------------|------|
| `ah.bellotreno.workers.dev` | 主 CORS 代理，转发所有 ViaggiaTreno API 请求（经 VPS 指纹绕过层）|
| `notify.bellotreno.workers.dev` | SmartCaring 通知专用 Worker，直连官方 SmartCaring API，聚合并缓存列车运行历史 |
| `site-counter.bellotreno.workers.dev` | 页面访问计数器（前端用 sessionStorage 去重，每次会话只计一次） |

除此之外，Cloudflare Pages Functions 现在负责根路径语言协商与三个服务端代理：

| Pages Function | 上游 | 说明 |
|---------------|------|------|
| `/` | 无上游 | 读取 `bt_locale` cookie 与浏览器 `Accept-Language`，将根路径重定向到 `/it/`、`/en/` 或 `/zh/`；未匹配时默认 `/it/` |
| `/api/swiss/formation` | `api.opentransportdata.swiss/formation/v2/formations_full` | 读取 `SWISS_TRAIN_FORMATION_API_KEY`，返回 normalized formation JSON |
| `/api/statistics/*` | `STATISTICS_API_BASE_URL`（如 `https://stats-api.bellotreno.org/v1`） | 读取 `STATISTICS_API_TOKEN`，向 VPS statistics API 注入 `X-Bello-Stats-Token` |
| `/api/trenord/traffic` | `www.trenord.it/mia/bff/train/*` + `www.trenord.it/mgmt/store-management-api/mia/direttrici/` | 读取 `TRENORD_BFF_SECRET`，服务端解密 Trenord train BFF payload，并返回 normalized line notice JSON |

服务端 API 代理类 Pages Function 都做 Origin/Referer 校验。Swiss 与 statistics 响应默认 `Cache-Control: no-store`；Trenord traffic 正常响应短缓存 120 秒，配置缺失或上游错误时使用 `no-store`。根路径 `/` Function 不访问上游 API，只负责语言协商重定向。

Trenord Traffic info is intentionally implemented as a same-origin Pages Function instead of a new public Worker. The frontend calls it only when the loaded train detail has `codiceCliente === 63`; all other operators continue to use the existing SmartCaring provider. The response is line-level (`direttrice`) information and does not expose raw decrypted payloads by default.

#### 主代理 Worker（ah.bellotreno.workers.dev）

| 项目 | 详情 |
|------|------|
| **平台** | Cloudflare Workers（Serverless 边缘计算） |
| **域名** | ah.bellotreno.workers.dev |
| **作用** | 安全网关 + 反向代理 + CORS 管理 |

##### 安全校验流程

```
请求到达 Worker
  │
  ├─ 读取 Origin 头 → 匹配白名单域名？→ 放行
  │
  ├─ 无 Origin → 读取 Referer 头 → 匹配白名单域名？→ 放行
  │
  └─ 均不匹配 → 返回 403 "Access Denied"
```

**白名单域名**：`bellotreno.org`、`bellotreno.site`、`localhost`（开发用）

#### 转发逻辑

1. 从查询参数 `?url=` 提取目标 API 地址
2. 构造新请求，目标指向 VPS（`https://api.bellotreno.org/?url=...`）
3. **注入安全令牌**：在请求头中添加 `X-Bello-Token`，VPS 端据此验证请求合法性
4. 将 VPS 返回的响应转发给浏览器，并设置 `Access-Control-Allow-Origin` 头解决 CORS

#### 为什么选择 CF Worker？

- **免费额度充足**：每天 10 万次免费请求
- **全球边缘节点**：延迟低
- **隐藏 VPS 真实 IP**：浏览器只看到 Worker 域名
- **无需运维**：Serverless，零服务器管理

###  前端 — Astro 静态网站

| 项目 | 详情 |
|------|------|
| **框架** | Astro 6.x（静态站点生成器） |
| **样式** | Tailwind CSS 4 + DaisyUI 5（组件库） |
| **运行环境** | Node.js 24.11.1+；npm 11.6.2+（与 Cloudflare Pages v3 构建环境一致） |
| **字体与图标** | Astro Fonts API 生成本地 `/_astro/fonts/*.woff2`；Material Symbols 只打包站点已使用的 glyphs |
| **部署** | Cloudflare Pages 静态托管 + Pages Functions |
| **域名** | bellotreno.org（主域名）；real.bellotreno.org（旧入口，建议 301 到主域名） |

#### 页面结构

| 页面 | 路由 | 功能 |
|------|------|------|
| 首页 | `/it/`、`/en/`、`/zh/` | 列车号查询 → 实时运行时间轴；车站名查询 → 跳转车站面板 |
| 车站面板 | `/it/station?id=&name=&type=` 等语言前缀路径 | 到达/出发列表、天气数据 |
| 出行信息 | `/it/infomobilita`、`/en/infomobilita`、`/zh/infomobilita` | RFI RSS 公告（按区域筛选） |
| 统计 | `/it/statistics`、`/en/statistics`、`/zh/statistics` | 每日运行统计、运行中曲线、状态/准点率/类别图、车次/车站/关系/Ranking 查询 |
| 关于 | `/it/about`、`/en/about`、`/zh/about` | 项目说明 |

#### 前端数据获取流程（以查询列车为例）

```javascript
// 1. 用户输入列车号，如 "9505"
// 2. 调用自动补全接口
fetch("https://ah.bellotreno.workers.dev/?url=https://www.viaggiatreno.it/.../cercaNumeroTrenoTrenoAutocomplete/9505")

// 3. 如果有多个匹配结果，弹出选择框让用户选择
// 4. 获取列车详情（需要三元组：列车号 + 始发站ID + 午夜时间戳）
fetch("https://ah.bellotreno.workers.dev/?url=https://www.viaggiatreno.it/.../andamentoTreno/{始发站ID}/{列车号}/{时间戳}")

// 5. 解析 JSON，渲染时间轴 UI
```

#### UI/UX 亮点

- **三语切换**：中文/英文/意大利语，采用 Astro i18n 静态语言路由；首屏文本由服务端按语言输出，交互更新继续复用 `data-i18n` 翻译表
- **明暗主题**：亮色/暗色/跟随系统，DaisyUI 自定义主题配色
- **列车类型图标**：Frecciarossa、Intercity、Regionale 等不同类别有独立图标
- **站台变更高亮**：原站台划线删除 + 新站台加粗显示
- **最近搜索记录**：localStorage 存储最近 5 条搜索，方便快速访问
- **RSS 区域筛选**：按意大利 20 个大区过滤出行公告
- **运行报告卡片（SmartCaring）**：查询车次后自动展示近 14 天运行历史。Frecciarossa/Frecciargento/Frecciabianca 显示完整模式（通知 + 日历柱状图 + 准点率统计）；普通区间车显示精简模式（仅通知）；IC/EC 等车次不显示。
- **Trenord Traffic info card**：当 `codiceCliente === 63` 时，前端跳过 SmartCaring，调用 `/api/trenord/traffic` 并在同一个 `#smartCaringCard` 容器中显示默认折叠的 `Traffic info · {direttriceDescription}` card。该模块只展示 Trenord line-level notices，不把它描述成单个车次专属公告；同一响应里的 `line` 字段也用于 Trenord line badge（如 S9、RE80、MXP1）。
- **部分取消停站显示**：当 ViaggiaTreno 返回 `Treno cancellato da ... a ...`、`fermateSoppresse` 或 `actualFermataType === 3` 时，timeline 可把取消停站标成红色，并保留正常运行段的原有颜色。
- **Swiss 编组卡片**：支持 EC、EN 以及带瑞士边境提示的 REG/RE/RV/S/IR 等车次；可展示车厢顺序、站台扇区、车辆设施、EVN、运行区间和当前 selected stop 的关闭/不可贯通状态。
- **统计图表交互**：`/statistics` 中 Regularity / Punctuality 的 donut 与图例可点击显示分项数据，Ranking 可查看晚点排序，类别图只显示当前数据中真实出现的类别。

#### 为什么选择 Astro？

- **零 JS 默认**：Astro 默认不向浏览器发送 JS 框架代码，页面加载极快
- **Islands 架构**：只在需要交互的地方注入 JS
- **Astro Fonts API**：构建时下载并生成带 hash 的本地字体资源，避免运行时阻塞 `fonts.googleapis.com` / `fonts.gstatic.com`
- **适合内容型站点**：配合 Tailwind + DaisyUI 快速构建美观 UI

#### SEO 与 PWA

`BaseLayout.astro` 集中管理所有 SEO 标签，各页面按当前语言传入 `title` 与 `description`：

- **静态 `lang` 按语言输出**：`/it` 为 `it`，`/en` 为 `en`，`/zh` 为 `zh-CN`，避免刷新首帧使用错误语言或系统 fallback 字体
- **每页独立 canonical URL**：使用当前语言路径生成，例如 `/it/statistics/`、`/en/statistics/`、`/zh/statistics/`
- **hreflang 多语言提示**：`it` / `en` / `zh-Hans` 分别指向对应语言 URL，`x-default` 指向默认意大利语 `/it/`
- **根路径语言协商**：`/` 在 Cloudflare Pages Function 中优先读取 `bt_locale` cookie，其次读取浏览器 `Accept-Language`；支持 `zh`、`en`、`it`，其他语言默认 `/it/`
- **Open Graph + Twitter Card**：社交分享预览，依赖 `public/og-image.png`（1200×630 px）
- **JSON-LD 结构化数据**：`WebApplication` 类型，`applicationCategory: TravelApplication`
- **Sitemap**：`@astrojs/sitemap` 每次 `npm run build` 自动生成 `dist/sitemap-index.xml`
- **robots.txt**：`public/robots.txt`，允许所有爬虫并指向 sitemap
- **PWA**：`public/site.webmanifest`（`display: standalone`）+ `public/apple-touch-icon.png`（180×180 px），iOS Safari 16.4+ 和 Android Chrome 均支持"添加到主屏"
- **可选 Umami**：`BaseLayout.astro` 支持 `PUBLIC_UMAMI_SCRIPT_URL`、`PUBLIC_UMAMI_WEBSITE_ID`、`PUBLIC_UMAMI_DOMAINS`，只在配置完整时加载，且开启 `data-do-not-track` 与 `data-exclude-search`。

#### Cloudflare Pages 缓存失效

Cloudflare Pages 部署后，浏览器可能继续使用旧的 `/scripts/*.js`。项目现在通过两层方式避免这个问题：

- `public/_headers` 对 HTML、manifest、脚本入口设置 `Cache-Control: public, max-age=0, must-revalidate`，让普通浏览器每次打开都重新校验。
- `BaseLayout.astro` 为 `/scripts/config.js`、`i18n.js`、`common.js` 和页面脚本追加 `?v=<build-id>`。build id 优先来自 `PUBLIC_BUILD_ID`、`CF_PAGES_COMMIT_SHA` 或 `CF_PAGES_DEPLOYMENT_ID`，没有时才用构建时间。

这不会明显拖慢正常访问：HTML 很小，脚本在同一个部署版本内仍可复用；只有新部署时 URL 变化，浏览器才会下载新脚本。`/_astro/*` 这类带 hash 的资源，包括 Astro Fonts API 输出的字体文件，仍然使用长期 immutable 缓存。

#### 前端代码质量改进

| 问题 | 解决方案 |
|------|---------|
| badge 映射逻辑重复（`main.js` 和 `station.js` 各有一份） | 提取为 `window.getBadgeClass(catCode)` 放在 `config.js` 末尾，两处共用 |
| API 数据直接注入 `innerHTML` 存在 XSS 风险 | `common.js` 提供 `window.escapeHtml(str)`，已应用于 `n.infoNote`、`data.subTitle`、`tipReason`、`data-station-name` 等高风险位置 |
| `station.astro` 内嵌 ~175 行业务逻辑脚本 | 全部移入 `station.js`（通过 `astro:page-load` 初始化），`station.astro` 现为纯 HTML 模板 |
| `platform-pulse` CSS 用 `<style is:global>` 限制在单页 | 移入 `global.css`，全局可用 |
| 访问计数每次 SPA 跳转重复触发 | `common.js` 用 `sessionStorage` 标记，同一标签页会话只计一次 |
| URL 参数触发搜索用轮询重试（10 次，100ms 间隔） | 改为在 `astro:page-load` 内直接处理（DOM 此时已就绪） |
| Swiss Formation 同号误匹配 | `swiss.js` 只对 EC/EN 默认尝试；REG/RE/RV/S/IR 必须命中边境站提示。当前边境提示保留 `CHIASSO`、`DOMODOSSOLA`、`LUINO`、`TIRANO`、`STABIO`，移除 Porto Ceresio、Ponte Tresa、Gaggiolo |
| Swiss 车辆重复与关闭状态污染 | 以 EVN 作为真实车辆 identity 合并多段记录；`Closed` / `GeschlossenBetrieblich` 按当前 selected stop 的 active segment 判断，不再全程 OR 合并 |
| 统计页面类别和查询交互 | `statistics.js` 维护 `CATEGORY_ORDER`，包含 `EC FR`、`NCL`、`IR`、`TS` 等；图表只展示实际出现类别，查询表中的车次/车站尽量可点击 |
| 部分取消区间不易读 | `main.js` 根据 `subTitle`、`fermateSoppresse`、`actualFermataType` 计算 partial cancellation state，取消停站用红色 timeline 和 `Cancelled stop` 标签 |
| Cloudflare Pages 新部署后旧 JS 残留 | `_headers` + `BaseLayout.astro` build version 参数共同处理脚本缓存失效 |

---

## 五、安全设计总结

项目实现了**多层安全防护**：

| 层级 | 措施 | 防御目标 |
|------|------|----------|
| **CF Worker 层** | Origin/Referer 白名单校验 | 防止非 BelloTreno 网站调用 API |
| **CF Worker → VPS** | X-Bello-Token 令牌认证 | 防止绕过 Worker 直接访问 VPS |
| **VPS 代理层** | 目标域名白名单 | 防止代理被滥用为 Open Proxy 攻击第三方 |
| **Pages Function → Swiss API** | Cloudflare Pages Secret 保存 Swiss token | 防止 Train Formation token 暴露到浏览器 |
| **Pages Function → Statistics API** | `STATISTICS_API_TOKEN` 注入 `X-Bello-Stats-Token` | 防止 statistics VPS API 被公开滥用 |
| **Pages Function → Trenord BFF** | `TRENORD_BFF_SECRET` 保存为 Cloudflare Pages Secret | 防止 Trenord BFF decryption secret 暴露到浏览器或仓库 |
| **前端 innerHTML** | `escapeHtml()` 转义 API 数据 | 防止 XSS 注入（API 被污染时的最后防线） |

当前 Cloudflare Pages 侧需要注意的变量：

| 变量名 | 类型 | 用途 |
|------|------|------|
| `SWISS_TRAIN_FORMATION_API_KEY` | Secret | OpenTransportData.swiss Train Formation token |
| `STATISTICS_API_BASE_URL` | Plain text | statistics 上游地址，例如 `https://stats-api.bellotreno.org/v1` |
| `STATISTICS_API_TOKEN` | Secret | Pages Function 转发 statistics API 时注入的 token |
| `TRENORD_BFF_SECRET` | Secret | Pages Function `/api/trenord/traffic` 解密 Trenord train BFF payload；不要使用 `PUBLIC_` 前缀，不要写入仓库 |
| `PUBLIC_UMAMI_SCRIPT_URL` | Plain text | 可选 Umami script 地址，会进入前端 HTML |
| `PUBLIC_UMAMI_WEBSITE_ID` | Plain text | 可选 Umami website id，会进入前端 HTML |
| `PUBLIC_UMAMI_DOMAINS` | Plain text | Umami 允许统计的域名，默认 `bellotreno.org,real.bellotreno.org` |

`PUBLIC_*` 变量会暴露到前端，只能放可公开配置；真正的 API token 必须使用非 `PUBLIC_` 的 Secret。

---

## 六、技术栈全景

```
┌─ 前端 ─────────────────────────────────────────┐
│  Astro 6 · Tailwind CSS 4 · DaisyUI 5          │
│  原生 JavaScript · Astro Fonts API              │
│  @astrojs/sitemap · site.webmanifest (PWA)      │
│  Cloudflare Pages · Pages Functions             │
└─────────────────────────────────────────────────┘

┌─ 中间层 ───────────────────────────────────────┐
│  Cloudflare Workers (Serverless)               │
│  JavaScript (Service Worker API)               │
└─────────────────────────────────────────────────┘

┌─ 后端 ─────────────────────────────────────────┐
│  Python 3.9 · Flask · Gunicorn                 │
│  curl_cffi (浏览器指纹模拟)                     │
│  Python 3.11 · Flask · SQLite (Statistics)      │
│  Docker · docker-compose                       │
│  Linux VPS                                     │
└─────────────────────────────────────────────────┘

┌─ 数据源 ───────────────────────────────────────┐
│  ViaggiaTreno REST API (列车/车站)              │
│  RFI RSS Feeds (出行公告)                       │
│  OpenTransportData.swiss Train Formation        │
│  VPS statistics SQLite / JSON cache             │
└─────────────────────────────────────────────────┘
```
