# CPA ↔ SUB2API Cloudflare Worker 转换工具

这是从原单文件 HTML 改造而来的 Cloudflare Worker 全栈版本：

- 浏览器只访问同源 `/api/*`；
- Worker 在服务端请求 SUB2API 和 CPA，因此不受浏览器 CORS 限制；
- 目标服务器地址/密钥：**本机 localStorage 优先**，没有本机配置时回退 Worker 环境变量；
- 上传前会验证配置有效性；无效或缺失时弹窗引导填写并保存；
- 页面由内置密码登录保护，登录态使用签名的 HttpOnly Cookie；
- 上传支持前端可配并发与自适应降并发；SUB2API 支持分类重试，CPA 会返回每个账号的独立上传结果。

## 一、部署

```bash
cd cpa-sub2api-cloudflare-worker
npm install
npx wrangler login
npm run deploy
```

首次部署后，因为尚未设置 `APP_PASSWORD` 和 `SESSION_SECRET`，页面会显示配置提示。

## 二、配置访问权限（必填）

Cloudflare Dashboard 路径：

```text
Workers & Pages → cpa-sub2api-converter → Settings → Variables and Secrets
```

添加以下两个 **Secret**：

| 名称 | 用途 |
|---|---|
| `APP_PASSWORD` | 打开页面时使用的访问密码 |
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

## 三、目标服务器配置（本机优先 / 环境变量回退）

上传到 SUB2API 或 CPA 时，配置解析顺序为：

1. **浏览器 localStorage 本机配置**（页面「服务器配置」弹窗中验证并保存）
2. 若无本机配置，则使用 **Worker 环境变量**
3. 两者都无效时，点击上传会弹出配置窗引导填写

本机配置以 target 为单位**成对覆盖**（必须同时有地址和密钥），不会与 env 半套混拼。

安全说明：

- 上游请求仍由 Worker 中转，浏览器不直连 SUB2API/CPA；
- 本机密钥以**明文**保存在 `localStorage`（键名 `cpa2sub.targetConfig.v1`），存在同机共用与 XSS 风险，请勿在公用设备长期保存；
- Worker **不会**通过 status 接口下发环境变量中的密钥；
- 使用本机配置上传/验证时，密钥仅出现在当次请求体中，Worker 不持久化。

### 3.1 在页面配置（推荐个人使用）

登录后点击顶栏「服务器配置」，或直接点「上传到 SUB2API / CPA」：

- 填写服务器地址与管理员密钥；
- 点击「验证并保存」——验证成功后写入本机；
- 「清除本机配置」后回退到环境变量（若有）。

### 3.2 用环境变量配置 SUB2API（可选回退）

| 名称 | 类型 | 示例 |
|---|---|---|
| `SUB2API_BASE_URL` | 普通变量或 Secret | `https://sapi.example.com` |
| `SUB2API_ADMIN_API_KEY` | **Secret** | 管理员 API Key |

Worker 会验证：

```http
GET /api/v1/admin/accounts?page=1&page_size=1&lite=1
x-api-key: <API_KEY>
```

上传使用：

```http
POST /api/v1/admin/accounts/data
```

前端可在页面配置每批账号数，且不得超过 Worker 的 `MAX_SUB2API_ACCOUNTS` 上限（默认 100，硬上限 5000）。也可配置前端并行批次数与重试策略（见下方「上传行为说明」）。SUB2API 批量导入为非幂等写操作；Worker 仅对较安全的失败自动重试，超时等模糊失败默认不重试。

### 3.3 用环境变量配置 CPA（可选回退）

这里的 CPA 指 CLIProxyAPI：

| 名称 | 类型 | 示例 |
|---|---|---|
| `CPA_BASE_URL` | 普通变量或 Secret | `https://cpa.example.com` |
| `CPA_MANAGEMENT_KEY` | **Secret** | CPA 管理密钥 |
| `CPA_AUTH_MODE` | 普通变量，可选 | `auto`、`bearer` 或 `x-management-key` |

Worker 会验证：

```http
GET /v0/management/auth-files
Authorization: Bearer <MANAGEMENT_KEY>
```

`CPA_AUTH_MODE=auto`（或本机配置选择 auto）时，若 Bearer 鉴权返回 401/403，会自动尝试：

```http
X-Management-Key: <MANAGEMENT_KEY>
```

上传使用官方支持的单文件原始 JSON 方式：

```http
POST /v0/management/auth-files?name=xai-account.json
Content-Type: application/json
```

CPA 服务端必须允许远程管理。通常需要在 CPA 的 `config.yaml` 中配置：

```yaml
remote-management:
  allow-remote: true
  secret-key: "你的管理密钥"
```

也可以使用 CPA 的 `MANAGEMENT_PASSWORD` 环境变量。Worker 版本不需要 CPA 配置 CORS。

## 五、重要网络要求

Cloudflare Worker 运行在 Cloudflare 边缘网络，目标服务器必须能被公网访问。下面这些地址不能作为生产目标：

```text
http://127.0.0.1:8080
http://localhost:8317
http://sub2api:8080
局域网私有地址
```

建议给 SUB2API/CPA 配置 HTTPS 域名，或通过 Cloudflare Tunnel 暴露。默认禁止明文 HTTP；确有需要时配置：

```text
ALLOW_INSECURE_UPSTREAM=true
```

## 六、本地开发

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入测试值
npm install
npm run dev
```

`.dev.vars` 已被 `.gitignore` 排除，不要提交真实密钥。

## 七、环境变量汇总

| 变量 | 必填 | 建议类型 |
|---|---:|---|
| `APP_PASSWORD` | 是 | Secret |
| `SESSION_SECRET` | 是 | Secret |
| `SESSION_TTL_HOURS` | 否 | 普通变量 |
| `SUB2API_BASE_URL` | 否 | 普通变量 |
| `SUB2API_ADMIN_API_KEY` | 否 | Secret |
| `CPA_BASE_URL` | 否 | 普通变量 |
| `CPA_MANAGEMENT_KEY` | 否 | Secret |
| `CPA_AUTH_MODE` | 否 | 普通变量 |
| `ALLOW_INSECURE_UPSTREAM` | 否 | 普通变量 |
| `MAX_SUB2API_ACCOUNTS` | 否 | 普通变量，默认 `100`，范围 1–5000 |
| `MAX_CPA_FILES` | 否 | 普通变量，默认 `20`，范围 1–100 |
| `MAX_UPLOAD_CONCURRENCY_SUB2API` | 否 | 普通变量，默认 `3`，不得超过对应绝对上限 |
| `MAX_UPLOAD_CONCURRENCY_CPA` | 否 | 普通变量，默认 `8`，不得超过对应绝对上限 |
| `ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API` | 否 | 普通变量，默认 `50`，范围 1–1000，且 ≥ 默认并发 `3` |
| `ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA` | 否 | 普通变量，默认 `150`，范围 1–1000，且 ≥ 默认并发 `8` |
| `MAX_SUB2API_UPLOAD_ATTEMPTS` | 否 | 普通变量，默认 `3`，范围 1–10 |

SUB2API 和 CPA 均为可选目标。每个目标的地址和密钥必须成对出现（本机配置或环境变量各自成对）。页面顶栏徽章会显示「本机 / 环境变量 / 未配置」；点击上传时会先验证，失败则打开配置窗。

上传上限说明：

- `MAX_SUB2API_ACCOUNTS` / `MAX_CPA_FILES` 控制 Worker 接口允许的单批最大数量。
- `MAX_UPLOAD_CONCURRENCY_SUB2API` / `MAX_UPLOAD_CONCURRENCY_CPA` 控制前端可配置的并行批次数上限（页面可配项的上限来源）。
- `ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API` / `ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA` 控制上述并发上限的绝对天花板，便于按目标服务器承载能力调整。
- `MAX_SUB2API_UPLOAD_ATTEMPTS` 控制 SUB2API 单批最大尝试次数上限（含首次）。
- 启动时校验：绝对上限必须有效，且 `DEFAULT_MAX_UPLOAD_CONCURRENCY_* ≤ ABSOLUTE_MAX_UPLOAD_CONCURRENCY_*`；若显式设置了 `MAX_UPLOAD_CONCURRENCY_*`，也必须 ≤ 对应绝对上限。配置无效时页面会显示配置错误提示。
- 未设置、非数字、小于 1 时：`MAX_*` 回退默认值并钳制到绝对上限；`ABSOLUTE_MAX_*` 回退内置默认绝对上限。
- 页面通过 `/api/config/status` 读取 `limits`，并限制用户可配置项不超过对应上限。

## 登录后显示“拒绝跨站请求”

旧版本对登录表单执行了严格的 `Origin === request.url.origin` 比较。在 Cloudflare Dashboard 内嵌预览、版本预览、自定义域名或边缘代理场景中，这两个值可能不完全一致，导致同源登录被误判。

当前版本已改为：

- 登录 POST 不再执行脆弱的 Origin 字符串比较；
- 已登录后的写操作根据 `Sec-Fetch-Site` 拒绝明确的 `cross-site` 请求；
- 会话 Cookie 仍使用 `HttpOnly; Secure; SameSite=Strict`。

建议通过部署生成的 `workers.dev` 地址或自定义域名在浏览器新标签页中打开，不要在 Cloudflare Dashboard 的嵌入式预览框中完成登录，因为第三方 Cookie 策略仍可能阻止会话 Cookie。

## 上传行为说明（v2）

- 有可上传账号时，上传按钮始终可点；无有效配置时点击会弹出对应目标的配置窗，验证保存成功后继续上传。
- 上传前无论本机还是 env，都会先调用 `/api/config/verify`；失败则引导修正配置。
- 本机配置上传时，请求体会附带 `config: { baseUrl, apiKey, cpaAuthMode? }`；纯 env 时不附带，由 Worker 读环境变量。
- 上传期间仅当前目标按钮显示旋转状态，另一个目标按钮仅禁用；同时显示“取消上传”。
- 页面可配置项（方向、命名、调度参数、批次大小、上传并发、SUB2API 重试等）会保存到本机 `localStorage`（键名 `cpa2sub.uiSettings.v1`），下次打开自动恢复。
- **批次大小**：SUB2API 默认 100 / 批，CPA 默认 20 / 批；不得超过 `MAX_SUB2API_ACCOUNTS` / `MAX_CPA_FILES`。
- **上传并发**：前端可并行提交多个批次，默认均为 1；页面可配上限由 `MAX_UPLOAD_CONCURRENCY_SUB2API`（默认 3）与 `MAX_UPLOAD_CONCURRENCY_CPA`（默认 8）约束，二者再受 `ABSOLUTE_MAX_UPLOAD_CONCURRENCY_*`（默认 SUB2API 50 / CPA 150）钳制。遇到超时等模糊失败时会自适应降低并发并短暂冷却，连续成功后再逐步恢复。
- **CPA**：官方 Management API 仅支持单文件上传。页面按批并发请求 Worker；Worker 批内按文件串行转发（并发 1），避免 Worker 内再放大。
- **SUB2API 重试**：
  - 页面可配最大尝试次数（含首次，默认 3），不得超过 `MAX_SUB2API_UPLOAD_ATTEMPTS`。
  - 对网络抖动、部分 5xx 等较安全失败会在次数内自动重试。
  - 超时 / 响应丢失等**模糊失败**策略可选：`不重试`（默认）/ `自动重试` / `等待确认`。模糊失败自动重试有重复创建账号风险。
- “已确认成功”只统计已经收到目标服务器成功响应的条目；正在处理的批次可能已经在服务器端写入一部分，所以服务器列表数量短时间内可能领先页面确认进度。
- 取消操作会停止后续批次并中断当前浏览器请求；若当前批次已经到达目标服务器，仍可能完成，因此取消后应先到目标服务器核对。
- 网络中断、超时或结果不明的情况会标记为“状态未知”；在未核对服务器前，不要对未知状态直接批量重试，以免重复导入。
