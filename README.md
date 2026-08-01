# STC

> 说明：早期前端页面设计来自于 [LinuxDo](https://linux.do) 某位佬友，但后来我搜索了很久都没找到原贴，待我找到后再更新到文档，感谢🙏🙏🙏

**STC**（SUB2API ↔ CPA）是部署在 Cloudflare Worker 上的账号转换与批量上传工具，用于在 **SUB2API** 与 **CLIProxyAPI（CPA）** 之间双向转换、导入、导出与互传账号。

浏览器只访问同源 `/api/*`；Worker 在服务端请求 SUB2API 和 CPA，因此不受浏览器 CORS 限制。页面由访问密码保护，登录态使用签名的 HttpOnly Cookie。

## 主要功能

### 账号转换

- SUB2API 账号数据 ↔ CPA 认证文件双向转换
- 前后端共用同一套转换逻辑（`src/shared/account-convert.js` / `public/shared/account-convert.js`）
- 支持命名规则、目标格式选择，以及账号状态、过期时间、代理等字段规范化

### 本地导入 / 导出

- 拖拽或选择本地 JSON / ZIP 批量导入
- 主列表展示、搜索、排序、多选
- 按目标格式转换后导出为 JSON / ZIP
- 本机工作区快照：意外关闭后可恢复列表，必要时续传

### 远端导入

- 从 CPA 拉取认证文件列表，或从 SUB2API 拉取账号元数据
- 先快速载入列表 stub，完整凭证在导出 / 上传时按需补全
- 支持分批拉取与合并，受 Worker 上限约束

### 批量上传

- 一键上传到 SUB2API 或 CPA
- 可配置批次大小、并行批次数、重试次数
- 超时等模糊失败可自适应降并发，并支持取消上传
- SUB2API 支持分类重试策略；CPA 返回每个账号的独立上传结果
- 上传前自动验证目标配置；无效或缺失时弹窗引导填写

### 远端互传

- 列表账号全部来自对端远端 stub 时，走 `POST /api/transfer/batch`
- Worker 在服务端完成「拉源 → 转换 → 上传目标」
- 完整凭证不经浏览器，减少网络 IO 与前端暴露面
- 本地导入或已补全账号仍走原 `/api/upload/*` 路径
- 远端账号不可回传到同一端；导出不受同源限制

### SUB2API 去重

- 扫描远端重复账号
- 按规则分批删除，受 `MAX_SUB2API_DEDUPE_IDS` 等上限约束

### 服务器配置

- **本机 localStorage 优先**，无本机配置时回退 Worker 环境变量
- 顶栏徽章显示「本机 / 环境变量 / 未配置」
- 点击徽章即可配置 SUB2API / CPA 地址与密钥，并「验证并保存」
- Worker 不会通过 status 接口下发环境变量中的密钥
- 本机密钥以明文保存在 `localStorage`（键名 `cpa2sub.targetConfig.v1`），请勿在公用设备长期保存

### 界面与安全

- 亮色 / 暗色 / 跟随系统主题
- 显示账号类型等列表信息
- 访问密码登录；会话 Cookie：`HttpOnly; Secure; SameSite=Strict`
- 写操作根据 `Sec-Fetch-Site` 拒绝明确的 cross-site 请求
- 静态资源与 API 均带安全响应头

## 技术架构

| 层级     | 说明                                               |
| -------- | -------------------------------------------------- |
| 前端     | `public/` 静态页面与模块化 JS                      |
| 后端     | Cloudflare Worker（`src/`）                        |
| 静态资源 | `assets` 绑定 `ASSETS`，`run_worker_first: true`   |
| 可选缓存 | KV 绑定 `PROXY_CACHE_KV`，缓存 SUB2API 代理 id→key |

配置解析顺序：

1. 浏览器 localStorage 本机配置
2. Worker 环境变量
3. 两者都无效时，上传会弹出配置窗

本机配置以 target 为单位成对覆盖（地址 + 密钥），不会与 env 半套混拼。

## 部署

```bash
cd stc
npm install
npx wrangler login
npm run deploy
```

Worker 名称见 [wrangler.jsonc](wrangler.jsonc)：`stc`（技术标识小写；产品展示名为 **STC**）。

首次部署后，若尚未设置 `APP_PASSWORD` 和 `SESSION_SECRET`，页面会显示配置提示。

## 配置访问权限（必填）

Cloudflare Dashboard 路径：

```text
Workers & Pages → stc → Settings → Variables and Secrets
```

添加以下两个 **Secret**：

| 名称             | 用途                                    |
| ---------------- | --------------------------------------- |
| `APP_PASSWORD`   | 打开页面时使用的访问密码                |
| `SESSION_SECRET` | 签名登录 Cookie；建议至少 32 字节随机值 |

生成 `SESSION_SECRET`：

```bash
openssl rand -base64 48
```

也可以使用 Wrangler：

```bash
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_SECRET
```

可选普通变量：

```text
SESSION_TTL_HOURS=168
```

## 目标服务器配置

### 在页面配置（推荐个人使用）

登录后点击顶栏徽章或「服务器配置」：

- 填写服务器地址与管理员密钥
- 点击「验证并保存」——验证成功后写入本机
- 「清除本机配置」后回退到环境变量（若有）

### 用环境变量配置 SUB2API（可选回退）

| 名称                    | 类型              | 示例                       |
| ----------------------- | ----------------- | -------------------------- |
| `SUB2API_BASE_URL`      | 普通变量或 Secret | `https://sapi.example.com` |
| `SUB2API_ADMIN_API_KEY` | **Secret**        | 管理员 API Key             |

Worker 会验证：

```http
GET /api/v1/admin/accounts?page=1&page_size=1&lite=1
x-api-key: <API_KEY>
```

上传使用：

```http
POST /api/v1/admin/accounts/data
```

从 SUB2API 导出选中账号时，与官方后台一致，使用：

```http
GET /api/v1/admin/settings?timezone=Asia/Shanghai
GET /api/v1/admin/accounts/data?ids=1,2,3&timezone=Asia/Shanghai
```

导出前会先读取系统设置中的 `totp_enabled` 与 `step_up_enabled`。**仅当两者同时为 true** 时，官方要求「已通过二次验证的管理会话」才能访问 `accounts/data`，**Admin API Key 会 403**，本工具将直接拒绝导出并提示。

### 用环境变量配置 CPA（可选回退）

这里的 CPA 指 CLIProxyAPI：

| 名称                 | 类型              | 示例                                   |
| -------------------- | ----------------- | -------------------------------------- |
| `CPA_BASE_URL`       | 普通变量或 Secret | `https://cpa.example.com`              |
| `CPA_MANAGEMENT_KEY` | **Secret**        | CPA 管理密钥                           |
| `CPA_AUTH_MODE`      | 普通变量，可选    | `auto`、`bearer` 或 `x-management-key` |

Worker 会验证：

```http
GET /v0/management/auth-files
Authorization: Bearer <MANAGEMENT_KEY>
```

`CPA_AUTH_MODE=auto` 时，若 Bearer 鉴权返回 401/403，会自动尝试：

```http
X-Management-Key: <MANAGEMENT_KEY>
```

上传使用官方支持的单文件原始 JSON 方式：

```http
POST /v0/management/auth-files?name=xai-account.json
Content-Type: application/json
```

CPA 服务端通常需要在 `config.yaml` 中允许远程管理：

```yaml
remote-management:
  allow-remote: true
  secret-key: "你的管理密钥"
```

## 网络要求

Cloudflare Worker 运行在边缘网络，目标服务器必须能被公网访问。以下地址不能作为生产目标：

```text
http://127.0.0.1:8080
http://localhost:8317
http://sub2api:8080
局域网私有地址
```

建议给 SUB2API / CPA 配置 HTTPS 域名，或通过 Cloudflare Tunnel 暴露。默认禁止明文 HTTP；确有需要时配置：

```text
ALLOW_INSECURE_UPSTREAM=true
```

## 本地开发

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入测试值
npm install
npm run dev
```

`.dev.vars` 已被 `.gitignore` 排除，不要提交真实密钥。

### 代码规范与提交前检查

| 命令                   | 作用                             |
| ---------------------- | -------------------------------- |
| `npm run lint`         | ESLint 检查                      |
| `npm run lint:fix`     | 自动修复可修的 ESLint 问题       |
| `npm run format`       | Prettier 格式化                  |
| `npm run format:check` | 仅检查格式                       |
| `npm run check`        | lint + 格式检查 + `node --check` |

`npm install` 会通过 `prepare` 安装 husky。提交时 pre-commit 会执行 `lint-staged`；任一检查失败则 commit 被拒绝。

## 环境变量汇总

| 变量                                      | 必填 | 建议类型                                                                                                               |
| ----------------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------- |
| `APP_PASSWORD`                            |   是 | Secret                                                                                                                 |
| `SESSION_SECRET`                          |   是 | Secret                                                                                                                 |
| `SESSION_TTL_HOURS`                       |   否 | 普通变量                                                                                                               |
| `SUB2API_BASE_URL`                        |   否 | 普通变量                                                                                                               |
| `SUB2API_ADMIN_API_KEY`                   |   否 | Secret                                                                                                                 |
| `CPA_BASE_URL`                            |   否 | 普通变量                                                                                                               |
| `CPA_MANAGEMENT_KEY`                      |   否 | Secret                                                                                                                 |
| `CPA_AUTH_MODE`                           |   否 | 普通变量                                                                                                               |
| `ALLOW_INSECURE_UPSTREAM`                 |   否 | 普通变量                                                                                                               |
| `MAX_SUB2API_ACCOUNTS`                    |   否 | 普通变量，默认 `100`，不得超过 `ABSOLUTE_MAX_SUB2API_ACCOUNTS`                                                         |
| `MAX_CPA_FILES`                           |   否 | 普通变量，默认 `20`，不得超过 `ABSOLUTE_MAX_CPA_FILES`                                                                 |
| `MAX_CPA_AUTH_DOWNLOAD_FILES`             |   否 | 普通变量，默认 `500`，单次从 CPA 下载认证文件上限；别名 `MAX_CPA_DOWNLOAD_FILES`                                       |
| `MAX_SUB2API_EXPORT_ACCOUNTS`             |   否 | 普通变量，默认 `500`，单次从 SUB2API 导出账号上限                                                                      |
| `MAX_SUB2API_DEDUPE_IDS`                  |   否 | 普通变量，默认 `5000`，单次去重删除账号 ID 上限；别名 `MAX_SUB2API_DEDUPE_ACCOUNTS`                                    |
| `ABSOLUTE_MAX_SUB2API_ACCOUNTS`           |   否 | 普通变量，默认 `5000`，平台天花板 50000                                                                                |
| `ABSOLUTE_MAX_CPA_FILES`                  |   否 | 普通变量，默认 `500`，平台天花板 50000                                                                                 |
| `ABSOLUTE_MAX_CPA_AUTH_DOWNLOAD_FILES`    |   否 | 普通变量，默认 `2000`，平台天花板 50000；约束 `MAX_CPA_AUTH_DOWNLOAD_FILES`                                            |
| `ABSOLUTE_MAX_SUB2API_EXPORT_ACCOUNTS`    |   否 | 普通变量，默认 `2000`，平台天花板 50000；约束 `MAX_SUB2API_EXPORT_ACCOUNTS`                                            |
| `ABSOLUTE_MAX_SUB2API_DEDUPE_IDS`         |   否 | 普通变量，默认 `10000`，平台天花板 50000；约束 `MAX_SUB2API_DEDUPE_IDS`；别名 `ABSOLUTE_MAX_SUB2API_DEDUPE_ACCOUNTS`   |
| `MAX_UPLOAD_CONCURRENCY_SUB2API`          |   否 | 普通变量，默认 `3`，不得超过对应绝对上限                                                                               |
| `MAX_UPLOAD_CONCURRENCY_CPA`              |   否 | 普通变量，默认 `8`，不得超过对应绝对上限                                                                               |
| `ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API` |   否 | 普通变量，默认 `50`，范围 1–1000，且 ≥ 默认并发 `3`                                                                    |
| `ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA`     |   否 | 普通变量，默认 `150`，范围 1–1000，且 ≥ 默认并发 `8`                                                                   |
| `MAX_SUB2API_UPLOAD_ATTEMPTS`             |   否 | 普通变量，默认 `3`，不得超过对应绝对上限                                                                               |
| `MAX_CPA_UPLOAD_ATTEMPTS`                 |   否 | 普通变量，默认 `3`，不得超过对应绝对上限                                                                               |
| `ABSOLUTE_MAX_UPLOAD_ATTEMPTS`            |   否 | 普通变量，默认 `10`，范围 1–30；也可分别设 `ABSOLUTE_MAX_SUB2API_UPLOAD_ATTEMPTS` / `ABSOLUTE_MAX_CPA_UPLOAD_ATTEMPTS` |
| `PROXY_MAP_CACHE_TTL_SECONDS`             |   否 | 普通变量，默认 `1800`（30 分钟），范围 60–86400；代理 id→key 缓存 TTL                                                  |

SUB2API 和 CPA 均为可选目标。每个目标的地址和密钥必须成对出现。

### 代理映射缓存

上传 SUB2API 时，Worker 会把账号上的代理 ID 换成官方导入所需的 `proxy_key`。缓存分层：

1. 当前 isolate 内存
2. Cloudflare KV（可选；绑定后跨 isolate 共享）
3. 未命中再请求上游 `GET /api/v1/admin/proxies/all`

| 项        | 说明                                                     |
| --------- | -------------------------------------------------------- |
| TTL       | `PROXY_MAP_CACHE_TTL_SECONDS`，默认 1800 秒              |
| KV 绑定名 | `PROXY_CACHE_KV` 或 `PROXY_MAP_KV`；未绑定则只走内存缓存 |
| 手动刷新  | 页面「刷新代理缓存」会强制失效内存 / KV 并回写           |
| 安全      | 浏览器只收到 `proxyIds`；`proxy_key` 不下发前端          |

启用 KV 示例：

```bash
npx wrangler kv namespace create "stc-proxy-cache"
# 将返回的 id 写入 wrangler.jsonc 的 kv_namespaces.binding = "PROXY_CACHE_KV"
npx wrangler deploy
```

### 上传与远端拉取上限

- `MAX_SUB2API_ACCOUNTS` / `MAX_CPA_FILES`：单批上传最大数量
- `MAX_CPA_AUTH_DOWNLOAD_FILES`：从 CPA 下载单次文件名数量
- `MAX_SUB2API_EXPORT_ACCOUNTS`：从 SUB2API 导出单次账号 ID 数量
- `MAX_SUB2API_DEDUPE_IDS`：去重删除单次账号 ID 数量
- `MAX_UPLOAD_CONCURRENCY_*`：前端并行批次数上限
- `MAX_*_UPLOAD_ATTEMPTS`：最大尝试次数（含首次）
- `ABSOLUTE_MAX_*`：可选绝对天花板；只配 `MAX_*` 时不会被偏低的内置 defaultAbsolute 卡住
- 改环境变量后需重新部署，新版本生效后才会反映到 `/api/config/status`

## 上传行为说明

- 有可上传账号时，上传按钮始终可点；无有效配置时点击会弹出对应目标的配置窗
- 上传前会调用 `/api/config/verify`；失败则引导修正配置
- 本机配置上传时，请求体附带 `config: { baseUrl, apiKey, cpaAuthMode? }`；纯 env 时不附带
- 页面可配置项会保存到本机 `localStorage`（键名 `cpa2sub.uiSettings.v1`）
- **批次大小**：SUB2API 默认 100 / 批，CPA 默认 20 / 批
- **上传并发**：默认均为 1；遇到模糊失败时自适应降并发，连续成功后再恢复
- **CPA**：官方 Management API 仅支持单文件上传；Worker 批内按文件串行转发
- **上传重试**：对网络抖动、部分 5xx 等较安全失败会自动重试；业务 4XX 不重试
- SUB2API 模糊失败策略：`不重试`（默认）/ `自动重试` / `等待确认`
- “已确认成功”只统计已收到目标服务器成功响应的条目
- 取消会停止后续批次；若当前批次已到达目标服务器，仍可能完成，取消后应先核对
- 状态未知时不要直接批量重试，以免重复导入

## 登录后显示“拒绝跨站请求”

旧版本对登录表单执行了严格的 Origin 比较，在 Dashboard 内嵌预览等场景可能误判。当前版本：

- 登录 POST 不再做脆弱的 Origin 字符串比较
- 已登录后的写操作根据 `Sec-Fetch-Site` 拒绝明确的 cross-site 请求
- 会话 Cookie 仍使用 `HttpOnly; Secure; SameSite=Strict`

建议通过 `workers.dev` 或自定义域名在浏览器新标签页中打开，不要在 Cloudflare Dashboard 嵌入式预览框中登录。

## 许可证

见 [LICENSE](LICENSE)。
