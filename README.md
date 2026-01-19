# BelloTreno

意大利铁路列车实时查询系统

## 📁 项目结构

```
bellotreno-site/
├── index.html              # 主页（车次查询）
├── about.html              # 关于页面
├── real_station.html       # 车站看板页面
├── style.css               # 全局样式表
├── station.js              # 车站相关功能
├── js/                     # JavaScript 模块
│   ├── config.js          # 配置常量（API、运营商、图片映射）
│   ├── i18n.js            # 国际化翻译（中文、英文、意大利语）
│   └── main.js            # 主应用逻辑
└── pic/                    # 列车类型图片资源
    ├── IC.png
    ├── FR.png
    ├── RV.png
    └── ...
```

## 🔧 技术栈

- **前端框架**: 原生 JavaScript (Vanilla JS)
- **UI 组件**: Material Design 3 (Web Components)
- **样式**: CSS3 (包含 Glassmorphism 毛玻璃效果)
- **数据源**: ViaggiaTreno API (通过 CORS 代理)

## 📚 JavaScript 模块说明

### `js/config.js`
包含所有配置常量：
- `API_BASE` - API 基础路径
- `CLIENT_MAP` - 运营商代码映射
- `CLIENT_LINK_MAP` - 运营商官网链接
- `CAT_MAP` - 列车类型映射
- `CAT_IMAGE_MAP` - 列车图片映射

### `js/i18n.js`
包含三语言翻译：
- 中文 (zh)
- 英文 (en)
- 意大利语 (it)

### `js/main.js`
主要应用逻辑：
- 语言和主题管理
- 搜索功能（车次/车站）
- 车次详情渲染
- 最近搜索记录
- URL 参数处理

### `station.js`
车站看板功能：
- 意大利时区处理（CET/CEST）
- 车站看板数据获取
- 到达/出发数据格式化

## 🚀 加载顺序

JavaScript 文件的加载顺序很重要：
1. `config.js` - 首先加载配置
2. `i18n.js` - 然后加载翻译
3. `station.js` - 车站功能
4. `main.js` - 最后加载主逻辑

## 🎨 特色功能

- ✅ 车次实时查询
- ✅ 车站看板（到达/出发）
- ✅ 多语言支持（中文/英文/意大利语）
- ✅ 深色/浅色主题
- ✅ 最近搜索记录
- ✅ Material Design 3 设计
- ✅ 毛玻璃（Glassmorphism）效果
- ✅ 微光网格背景
- ✅ 响应式设计（移动端适配）

## 🔒 安全说明

- API 端点是公开的（必须暴露给浏览器）
- 不存储任何敏感信息
- LocalStorage 仅用于用户偏好（主题、语言、历史记录）
- 所有数据来源于 ViaggiaTreno 公开 API

## 📝 开发说明

### 修改配置
编辑 `js/config.js` 文件来修改：
- API 地址
- 运营商信息
- 列车类型映射

### 添加翻译
编辑 `js/i18n.js` 文件来添加或修改翻译。

### 修改主逻辑
编辑 `js/main.js` 文件来修改核心功能。

## 📄 许可证

© 2026 BelloTreno - 个人项目，仅供学习和铁路爱好者交流使用。

数据来源于 ViaggiaTreno，本站不保证准确性与实时性。
