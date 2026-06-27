# 我的观赛日历（Vercel 版）

2026 世界杯 + F1 观赛日历。小组赛与 F1 用本地静态数据即时渲染；**淘汰赛对阵**
每次打开通过同源接口 `/api/knockout` 自动更新。**上游接口密钥只在服务端使用，
绝不出现在前端代码里。**

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `index.html` | 主页面（UI + 逻辑）。先用 `fixtures.js` 渲染，再异步拉淘汰赛对阵 |
| `fixtures.js` | 本地静态数据：小组赛 72 场 + 6/7 月 F1，`<script src>` 引入 |
| `api/knockout.js` | Vercel Serverless 函数，服务端用密钥请求上游、归一化淘汰赛对阵 |
| `knockout-skeleton.json` | 淘汰赛固定骨架（轮次/时间/场馆），上游失败时兜底，全部 `tbd=true` |
| `.env.example` | 环境变量模板，复制成 `.env` 填入你的 key |

## 数据流

1. 打开页面 → 立即用 `fixtures.js` 渲染小组赛 + F1（不等网络）。
2. 前端 `fetch('/api/knockout')`（同源、无需任何 key、无 CORS），超时 5 秒。
3. 成功 → 渲染淘汰赛 + 存 `localStorage` 缓存；顶部显示「对阵更新于 HH:mm」。
4. 失败/超时 → 用 `localStorage` 上次缓存渲染；顶部显示「⚠ 更新失败，用缓存」。
5. `api/knockout.js` 内部：上游成功则归一化对阵；上游失败/超时/无 key →
   返回 `knockout-skeleton.json`，**接口永远有可用返回**。
6. 响应头 `Cache-Control: s-maxage=900, stale-while-revalidate=3600`，
   Vercel CDN 缓存约 15 分钟，避免每次打开都打上游，稳稳待在免费额度内。

## 数据源（football-data.org）

- 免费档（Free Tier）**就包含 FIFA 世界杯（竞赛代码 `WC`）**，且不限制赛季年份；
  限速 10 次/分钟，配合上面的 CDN 缓存绰绰有余。
- 注册拿 token：<https://www.football-data.org/client/register>，把 token 填进
  环境变量 `FOOTBALL_API_KEY`。请求头用 `X-Auth-Token`。
- 世界杯参数：`competition=WC`、`season=2026`。
- 淘汰赛 `match.stage` 取值：`LAST_32` / `LAST_16` / `QUARTER_FINALS` /
  `SEMI_FINALS` / `THIRD_PLACE` / `FINAL`（小组赛是 `GROUP_STAGE`，自动忽略）。
- 换源只需改 `api/knockout.js` 顶部的 `API_CONFIG`（地址 / 请求头 / 字段映射 /
  stage→中文 映射都集中在那里，已加注释）。
- > 备注：本来用 API-Football(api-sports.io)，但其免费档只给 2022–2024 赛季、
  > 拿不到 2026 世界杯，故改用 football-data.org。

## 本地开发

```bash
npm i -g vercel          # 首次：安装 Vercel CLI
cp .env.example .env      # 复制环境变量模板，填入你的 FOOTBALL_API_KEY
vercel dev               # 本地起服务（同时跑静态页 + /api 函数），默认 http://localhost:3000
```

> `vercel dev` 会自动读取本地 `.env`。`.env` 已在 `.gitignore`，不会被提交。

## 部署

```bash
vercel                   # 部署到预览环境
vercel --prod            # 部署到生产环境
```

零配置即可：根目录的 `index.html` 作为静态站点，`api/` 下的文件自动成为
Serverless 函数。

## 需在 Vercel 后台配置的环境变量

进入 **Project → Settings → Environment Variables** 添加：

| 变量名 | 值 | 环境 |
| --- | --- | --- |
| `FOOTBALL_API_KEY` | 你在 api-sports.io 申请的 API key | Production / Preview / Development |

（本地开发则写在 `.env` 里。）
