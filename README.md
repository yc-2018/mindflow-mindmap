# MindFlow · 思维导图

基于 [React Flow (@xyflow/react)](https://github.com/xyflow/xyflow) 的在线思维导图，部署在 Cloudflare Workers + D1。

- **线上地址**：https://mindflow.245556.xyz
- **备选地址**：https://mindflow.cgl556.workers.dev

## 功能

**账号**
- 管理员登录（账号密码来自 Worker Secret 环境变量）
- 管理员可在「用户管理」中创建/删除用户、重置密码
- 注册由管理员代建（邮件自助注册为 TODO）

**列表页**
- 缩略图网格，SVG 轻量渲染（不挂载 ReactFlow 实例）
- 「+ 新建」一键创建并进入编辑
- 鼠标悬停缩略图浮现操作条：分享 / 下载 JSON / 重命名 / 删除
- 点击缩略图进入编辑
- 搜索 + 排序（最近编辑 / 创建时间 / 标题）

**编辑器**
- 横向树状思维导图，自动布局
- 节点为「一行」结构：**文字在上，图片在下**
- 图片经 Worker 代理上传到 pixhost 图床，返回缩略图 URL 存进节点
- 键盘操作：`Tab` 加子主题、`Enter` 加同级、`Del` 删除、`Ctrl+S` 保存、双击改名
- 自动保存（防抖 900ms）+ 保存状态提示
- 分享链接（`/s/<token>`）只读公开访问

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19、Vite 8、@xyflow/react 12、TypeScript |
| 后端 | Cloudflare Workers（`worker/index.ts` 单文件路由） |
| 数据库 | Cloudflare D1（SQLite） |
| 图床 | pixhost.to（经 Worker 代理，避免浏览器 CORS） |
| 鉴权 | PBKDF2-SHA256 密码哈希 + HMAC 签名 Cookie 会话 |

## 目录结构

```
worker/index.ts          后端：认证、地图 CRUD、分享、上传代理
migrations/0001_init.sql D1 表结构
src/
  App.tsx                路由分发（/、/map/:id、/s/:token、/admin）
  pages/                 登录、仪表盘、编辑器、分享查看、用户管理
  components/            自定义节点、连线、缩略图
  lib/                   API 客户端、布局算法、类型、toast、路由
```

## 本地开发

```bash
npm install

# 1) 本地 D1 迁移
npx wrangler d1 migrations apply mindflow --local

# 2) 准备 .dev.vars（参考 .dev.vars.example）
#    ADMIN_EMAIL / ADMIN_PASSWORD / SESSION_SECRET

# 3) 启动（前端 5173，API 8787）
npx wrangler dev --port 8787     # 终端 A
npx vite                         # 终端 B
```

首次请求任一 `/api/*` 时，会自动用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 创建管理员账号（若不存在）。

## 部署（Git 自动构建）

生产环境走 **Cloudflare Workers Builds** 的 Git 集成，不再手动 `wrangler deploy`：

```
本地改代码 → git commit → git push → Cloudflare 自动构建部署 → 线上更新
```

一次性配置（Cloudflare Dashboard → Workers & Pages → `mindflow` → Settings → Builds）：

| 项 | 值 |
|---|---|
| Git 仓库 | `yc-2018/mindflow-mindmap`（分支 `main`） |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Node version | 22 |

仓库里的 `.npmrc` 把 registry 固定到 `registry.npmjs.org`，避免开发者本机的私有 registry 泄漏进 CI（这曾导致 `npm E401`）。

手动部署（应急用）：

```bash
# 生产密钥
wrangler secret put ADMIN_EMAIL
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET

# 远程数据库迁移
wrangler d1 migrations apply mindflow --remote

# 构建 + 部署
npm run deploy
```

## 数据模型

```sql
users (id, email, name, password_hash, salt, role, created_at)
maps  (id, owner_id, title, data, share_token, created_at, updated_at)
```

`maps.data` 是 JSON 字符串：`{ nodes, edges, viewport, theme }`，节点数据形如：

```json
{
  "id": "n_x", "type": "mind", "position": { "x": 0, "y": 0 },
  "data": {
    "label": "**Markdown** 支持\n换行也保留",
    "tone": "root",
    "images": [
      { "id": "img_1", "thumbUrl": "https://t3.pixhost.cc/thumbs/...", "fullUrl": "https://img3.pixhost.cc/images/..." }
    ],
    "collapsed": false,
    "childCount": 2
  }
}
```

连线带自适应手柄，反向连接不会绕大弯：

```json
{ "id": "e_1", "source": "n_a", "target": "n_b", "type": "mind", "sourceHandle": "s-right", "targetHandle": "t-left", "label": "可选文字" }
```

## 说明

- `workers.dev` 域名在国内存在 DNS 污染，直连可能超时；自定义域名 `245556.xyz` 正常。
- 图床是第三方公开服务，图片长期可用性取决于 pixhost；如需长期保存可改存 R2。
- 上传前会在浏览器里转成 WebP，超过图床 10MB 上限时自动降质/降尺寸。
