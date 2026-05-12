# BelloTreno

BelloTreno 是一个**意大利铁路实时信息面板**，通过自建后端代理绕过官方 API 反爬限制，经 Cloudflare Worker 中间层转发，最终在静态前端网站上以更清晰、易读的 UI 展示列车实时动态、车站到发信息与 RFI 出行公告。

线上地址：https://real.bellotreno.org/

---

## 一、2026-05 当前功能快照

BelloTreno 现在包含五个主要页面：

- `/`：列车实时查询、停站时间线、运行状态、SmartCaring 运行报告，以及可用时的瑞士列车编组。
- `/station`：意大利车站出发/到达面板，支持天气、站台、延误、取消、改线和跨境终点补全。
- `/infomobilita`：RFI 出行公告与区域筛选。
- `/statistics`：意大利铁路每日运行统计，包括运行中列车曲线、状态分布、准点率、类别排行、车次/车站/关系查询。
- `/about`：项目说明、数据来源、限制和 Roadmap。

当前数据链路分为三类：

1. **ViaggiaTreno / RFI 实时数据**：浏览器通过 Cloudflare Worker `ah.bellotreno.workers.dev` 访问 VPS `rfi-proxy`，由 `curl_cffi` 模拟浏览器指纹请求官方 API。
2. **Swiss OpenTransportData 编组数据**：Cloudflare Pages Function 读取 Pages Secret 中的 Train Formation token，只在服务端请求 `formations_full`，前端不接触 token。
3. **Statistics 聚合数据**：Cloudflare Pages Function `/api/statistics/*` 转发到 VPS 上的 `bellotreno-statistics` 服务；该服务定时扫描车站 registry、`partenze`/`arrivi` board 和 `andamentoTreno`，把聚合结果写入 SQLite 与 JSON cache。

浏览器缓存方面，项目使用 `public/_headers` 控制 HTML 与脚本重新校验，并在 `BaseLayout.astro` 中给 `/scripts/*.js` 追加 build version 查询参数，避免 Cloudflare Pages 新部署后 iOS Safari 或桌面浏览器继续使用旧脚本。

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
| **WSGI 服务器** | Gunicorn（4 个 Worker 进程） |
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

### 中间层 — Cloudflare Workers

项目现有 **3 个** Cloudflare Worker：

| Worker 域名 | 用途 |
|------------|------|
| `ah.bellotreno.workers.dev` | 主 CORS 代理，转发所有 ViaggiaTreno API 请求（经 VPS 指纹绕过层）|
| `notify.bellotreno.workers.dev` | SmartCaring 通知专用 Worker，直连官方 SmartCaring API，聚合并缓存列车运行历史 |
| `site-counter.bellotreno.workers.dev` | 页面访问计数器（前端用 sessionStorage 去重，每次会话只计一次） |

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
| **框架** | Astro 5.x（静态站点生成器） |
| **样式** | Tailwind CSS 4 + DaisyUI 5（组件库） |
| **部署** | 静态 HTML 托管（Netlify / Cloudflare Pages） |
| **域名** | real.bellotreno.org |

#### 页面结构

| 页面 | 路由 | 功能 |
|------|------|------|
| 首页 | `/` | 列车号查询 → 实时运行时间轴；车站名查询 → 跳转车站面板 |
| 车站面板 | `/station?id=&name=&type=` | 到达/出发列表、天气数据 |
| 出行信息 | `/infomobilita` | RFI RSS 公告（按区域筛选） |
| 关于 | `/about` | 项目说明 |

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

- **三语切换**：中文/英文/意大利语，基于 `data-i18n` 属性的前端 i18n 方案
- **明暗主题**：亮色/暗色/跟随系统，DaisyUI 自定义主题配色
- **列车类型图标**：Frecciarossa、Intercity、Regionale 等不同类别有独立图标
- **站台变更高亮**：原站台划线删除 + 新站台加粗显示
- **最近搜索记录**：localStorage 存储最近 5 条搜索，方便快速访问
- **RSS 区域筛选**：按意大利 20 个大区过滤出行公告
- **运行报告卡片（SmartCaring）**：查询车次后自动展示近 14 天运行历史。Frecciarossa/Frecciargento/Frecciabianca 显示完整模式（通知 + 日历柱状图 + 准点率统计）；普通区间车显示精简模式（仅通知）；IC/EC 等车次不显示。

#### 为什么选择 Astro？

- **零 JS 默认**：Astro 默认不向浏览器发送 JS 框架代码，页面加载极快
- **Islands 架构**：只在需要交互的地方注入 JS
- **适合内容型站点**：配合 Tailwind + DaisyUI 快速构建美观 UI

#### SEO 与 PWA

`BaseLayout.astro` 集中管理所有 SEO 标签，各页面只需传入意大利语 `description`：

- **静态 `lang="it"`**：搜索引擎爬虫看到意大利语作为主语言；`theme-init.js` 在运行时根据 `localStorage('language')` 覆盖为用户偏好语言
- **每页独立 canonical URL**：使用 `Astro.url.pathname` 自动生成，避免重复内容问题
- **hreflang 多语言提示**：`it` / `en` / `zh-Hans` / `x-default` 均指向同一 URL（单 URL 多语言架构）
- **Open Graph + Twitter Card**：社交分享预览，依赖 `public/og-image.png`（1200×630 px）
- **JSON-LD 结构化数据**：`WebApplication` 类型，`applicationCategory: TravelApplication`
- **Sitemap**：`@astrojs/sitemap` 每次 `npm run build` 自动生成 `dist/sitemap-index.xml`
- **robots.txt**：`public/robots.txt`，允许所有爬虫并指向 sitemap
- **PWA**：`public/site.webmanifest`（`display: standalone`）+ `public/apple-touch-icon.png`（180×180 px），iOS Safari 16.4+ 和 Android Chrome 均支持"添加到主屏"

#### 前端代码质量改进

| 问题 | 解决方案 |
|------|---------|
| badge 映射逻辑重复（`main.js` 和 `station.js` 各有一份） | 提取为 `window.getBadgeClass(catCode)` 放在 `config.js` 末尾，两处共用 |
| API 数据直接注入 `innerHTML` 存在 XSS 风险 | `common.js` 提供 `window.escapeHtml(str)`，已应用于 `n.infoNote`、`data.subTitle`、`tipReason`、`data-station-name` 等高风险位置 |
| `station.astro` 内嵌 ~175 行业务逻辑脚本 | 全部移入 `station.js`（通过 `astro:page-load` 初始化），`station.astro` 现为纯 HTML 模板 |
| `platform-pulse` CSS 用 `<style is:global>` 限制在单页 | 移入 `global.css`，全局可用 |
| 访问计数每次 SPA 跳转重复触发 | `common.js` 用 `sessionStorage` 标记，同一标签页会话只计一次 |
| URL 参数触发搜索用轮询重试（10 次，100ms 间隔） | 改为在 `astro:page-load` 内直接处理（DOM 此时已就绪） |

---

## 五、安全设计总结

项目实现了**多层安全防护**：

| 层级 | 措施 | 防御目标 |
|------|------|----------|
| **CF Worker 层** | Origin/Referer 白名单校验 | 防止非 BelloTreno 网站调用 API |
| **CF Worker → VPS** | X-Bello-Token 令牌认证 | 防止绕过 Worker 直接访问 VPS |
| **VPS 代理层** | 目标域名白名单 | 防止代理被滥用为 Open Proxy 攻击第三方 |
| **前端 innerHTML** | `escapeHtml()` 转义 API 数据 | 防止 XSS 注入（API 被污染时的最后防线） |

---

## 六、技术栈全景

```
┌─ 前端 ─────────────────────────────────────────┐
│  Astro 5 · Tailwind CSS 4 · DaisyUI 5          │
│  原生 JavaScript · Google Fonts                 │
│  @astrojs/sitemap · site.webmanifest (PWA)      │
│  静态部署 (Netlify / CF Pages)                  │
└─────────────────────────────────────────────────┘

┌─ 中间层 ───────────────────────────────────────┐
│  Cloudflare Workers (Serverless)               │
│  JavaScript (Service Worker API)               │
└─────────────────────────────────────────────────┘

┌─ 后端 ─────────────────────────────────────────┐
│  Python 3.9 · Flask · Gunicorn                 │
│  curl_cffi (浏览器指纹模拟)                     │
│  Docker · docker-compose                       │
│  Linux VPS                                     │
└─────────────────────────────────────────────────┘

┌─ 数据源 ───────────────────────────────────────┐
│  ViaggiaTreno REST API (列车/车站)              │
│  RFI RSS Feeds (出行公告)                       │
└─────────────────────────────────────────────────┘
```
