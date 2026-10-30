# MindFlow · 在线思维导图

基于 [React Flow (@xyflow/react)](https://github.com/xyflow/xyflow) 的在线思维导图，部署在 Cloudflare Workers + D1。

- **线上地址**：https://mindflow.245556.xyz
- **备用地址**：https://mindflow.cgl556.workers.dev

## 功能

### 账号

- 管理员账号由 Worker 环境变量初始化（`ADMIN_EMAIL` / `ADMIN_PASSWORD`）
- 管理员可在「用户管理」中创建 / 删除用户、重置密码
- **自助注册**：只接受纯数字 QQ 邮箱（`123456789@qq.com`）
  - 验证码 6 位数字，10 分钟有效，单次使用
  - 同一邮箱 60 秒内只能请求一次；最多 5 次尝试
  - 注册成功直接签发会话，无需二次登录

### 列表页

- 缩略图网格，SVG 轻量渲染（不为每张卡片挂载 ReactFlow 实例）
- 「新建」一键创建并进入编辑
- 悬停缩略图浮现操作条：分享 / 下载 JSON / 重命名 / 删除
- 点击缩略图进入编辑
- 搜索 + 排序（最近编辑 / 创建时间 / 标题）
- **导入**：支持 MindFlow 自有 JSON 与 **ProcessOn 导出 JSON**

### 编辑器

- **7 种骨架结构**：思维导图、向右 / 向左树形图、向下 / 向上组织结构图、两侧平衡图、鱼骨图
- **8 套主题**：经典、鲜艳、深海蓝、森林、玫瑰、暗色、单色、**彩虹分支**
  - 彩虹分支：根节点白色，每个一级分支不同颜色（8 色循环），子节点继承分支色，连线同色
- 节点为「一行」结构：**文字在上，图片在下**（每个节点最多 4 张图）
- 图片经 Worker 代理上传到 pixhost 图床，返回缩略图 URL 存入节点
- 键盘操作：`Tab` 加子主题、`Enter` 加同级、`Del` 删除、`Ctrl+S` 保存、双击改名
- 文本格式：粗体 / 斜体 / 下划线 / 删除线 / **高亮 `==text==`** / 列表
- 自动保存（防抖 900ms）+ 保存状态提示
- 撤销 / 重做（快照栈）
- 折叠 / 展开分支（单个 + 全部）
- **整理布局**：强制重新排列全部节点
- **自由拖拽**：拖到节点上改结构，拖到空白处保留位置（标记 `pinned`，不参与自动布局）
- 多选拖拽、框选（始终开启）
- 分享链接（`/s/<token>`）只读公开访问，可随时关闭或**换一个链接**

### 分享页

- 只读视图，与编辑器渲染完全一致（同一套布局与连线算法）
- 保留**折叠 / 展开**按钮
- 保留**整理布局**按钮（只影响当前浏览，不修改原图，刷新即恢复）
- 无任何编辑控件（无删除按钮、无文本编辑框）

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19、Vite 8、@xyflow/react 12、TypeScript |
| 后端 | Cloudflare Workers（`worker/index.ts` 单文件路由） |
| 数据库 | Cloudflare D1（SQLite） |
| 图床 | pixhost.to（经 Worker 代理，避免浏览器 CORS） |
| 邮件 | Resend HTTP API（Worker 内 `fetch` 直调） |
| 鉴权 | PBKDF2-SHA256 密码哈希 + HMAC 签名 Cookie 会话 |

### 为什么用 Resend 而不是 SMTP

Workers 无法发送 SMTP：

- 出站 25 端口被官方禁用
- 465 端口虽可连 TCP，但 `connect()` 只提供裸字节流，没有 TLS 层

因此验证码走 Resend 的 REST API（纯 HTTP），一次 `fetch` 即可。

## 目录结构

```
worker/index.ts          后端：鉴权、地图 CRUD、分享、上传代理、邮件发送
wrangler.jsonc           Worker 配置（D1 绑定、路由、环境变量）
migrations/
  0001_init.sql          users / maps 表
  0002_verify.sql        注册验证码表
src/
  App.tsx                路由分发（/、/login、/register、/map/:id、/s/:token、/admin）
  pages/                 登录、注册、仪表盘、编辑器、分享查看、用户管理
  components/            自定义节点、连线、缩略图、主题/骨架选择器、格式栏
  lib/
    layout.ts            布局算法（7 种骨架 + 增量布局 + 高度估算）
    handles.ts           连线端口自适应（按几何位置判断左右/上下）
    reparent.ts          拖拽改结构（父子/同级，禁止脱离）
    import.ts            导入解析（MindFlow + ProcessOn 格式）
    themes.ts            主题定义（含彩虹分支配色）
    structures.ts        骨架定义
    visibility.ts        折叠子树过滤
    types.ts             节点/文档类型与序列化
    api.ts               API 客户端
```

## 本地开发

```bash
npm install

# 1) 本地 D1 迁移
npx wrangler d1 migrations apply mindflow --local

# 2) 准备 .dev.vars（已 gitignore）
#    ADMIN_EMAIL / ADMIN_PASSWORD / SESSION_SECRET / RESEND_API_KEY / MAIL_FROM

# 3) 前端构建（wrangler dev 服务的是 dist，不是 Vite dev server）
npx vite build

# 4) 启动本地服务（默认 8787）
npx wrangler dev
```

首次请求任一 `/api/*` 时，会自动用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 创建管理员账号（若不存在）。

## 部署

生产环境优先走 **Cloudflare Workers Builds** 的 Git 集成：

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

**若 CI 未触发**（Git 推送后线上未更新），手动部署：

```bash
# 生产密钥（首次配置后无需重复）
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put RESEND_API_KEY

# 远程数据库迁移
npx wrangler d1 migrations apply mindflow --remote

# 构建 + 部署
npx vite build
npx wrangler deploy
```

## 数据模型

```sql
users        (id, email, name, password_hash, salt, role, created_at)
maps         (id, owner_id, title, data, share_token, created_at, updated_at)
verify_codes (id, email, code, attempts, created_at, expires_at, sent_at, used_at)
```

`maps.data` 是 JSON 字符串：`{ nodes, edges, viewport, theme, structure }`，节点数据形如：

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
