# CPA ↔ SUB2API Cloudflare Worker 转换工具

这是从原单文件 HTML 改造而来的 Cloudflare Worker 全栈版本：

- 浏览器只访问同源 `/api/*`；
- Worker 在服务端请求 SUB2API 和 CPA，因此不受浏览器 CORS 限制；
- 服务器地址和管理员密钥只存在于 Worker 环境变量/Secret 中，不下发到浏览器；
- 页面由内置密码登录保护，登录态使用签名的 HttpOnly Cookie；
- SUB2API 与 CPA 都带失败重试，CPA 会返回每个账号的独立上传结果。

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

## 三、配置 SUB2API（可选）

只有需要“上传到 SUB2API”时才配置：

| 名称 | 类型 | 示例 |
|---|---|---|
| `SUB2API_BASE_URL` | 普通变量或 Secret | `https://sapi.example.com` |
| `SUB2API_ADMIN_API_KEY` | **Secret** | 管理员 API Key |

Worker 会验证：

```http
GET /api/v1/admin/accounts?page=1&page_size=1&lite=1
x-api-key: <SUB2API_ADMIN_API_KEY>
```

上传使用：

```http
POST /api/v1/admin/accounts/data
```

前端可在页面配置每批账号数，且不得超过 Worker 的 `MAX_SUB2API_ACCOUNTS` 上限（默认 100，硬上限 5000）。SUB2API 批量导入为非幂等写操作，Worker 对该 POST 不自动重试，避免重复创建账号。

## 四、配置 CPA（可选）

这里的 CPA 指 CLIProxyAPI。只有需要“上传到 CPA”时才配置：

| 名称 | 类型 | 示例 |
|---|---|---|
| `CPA_BASE_URL` | 普通变量或 Secret | `https://cpa.example.com` |
| `CPA_MANAGEMENT_KEY` | **Secret** | CPA 管理密钥 |
| `CPA_AUTH_MODE` | 普通变量，可选 | `auto`、`bearer` 或 `x-management-key` |

Worker 会验证：

```http
GET /v0/management/auth-files
Authorization: Bearer <CPA_MANAGEMENT_KEY>
```

`CPA_AUTH_MODE=auto` 时，若 Bearer 鉴权返回 401/403，会自动尝试：

```http
X-Management-Key: <CPA_MANAGEMENT_KEY>
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

SUB2API 和 CPA 均为可选目标，但每个目标的地址和密钥必须成对配置。页面会显示配置状态；点击上传时还会实时调用对应管理接口验证有效性。

单批上限说明：

- `MAX_SUB2API_ACCOUNTS` / `MAX_CPA_FILES` 控制 Worker 接口允许的单批最大数量。
- 未设置、非数字、小于 1 时回退默认值；超过硬上限时钳制到硬上限。
- 页面通过 `/api/config/status` 读取 `limits`，并限制用户可配置的批次大小不超过该上限。

## 登录后显示“拒绝跨站请求”

旧版本对登录表单执行了严格的 `Origin === request.url.origin` 比较。在 Cloudflare Dashboard 内嵌预览、版本预览、自定义域名或边缘代理场景中，这两个值可能不完全一致，导致同源登录被误判。

当前版本已改为：

- 登录 POST 不再执行脆弱的 Origin 字符串比较；
- 已登录后的写操作根据 `Sec-Fetch-Site` 拒绝明确的 `cross-site` 请求；
- 会话 Cookie 仍使用 `HttpOnly; Secure; SameSite=Strict`。

建议通过部署生成的 `workers.dev` 地址或自定义域名在浏览器新标签页中打开，不要在 Cloudflare Dashboard 的嵌入式预览框中完成登录，因为第三方 Cookie 策略仍可能阻止会话 Cookie。

## 上传行为说明（v2）

- 上传按钮会按 Worker 环境变量配置状态独立启用；未配置的目标保持禁用，并通过悬浮提示缺少的变量。
- 上传期间仅当前目标按钮显示旋转状态，另一个目标按钮仅禁用；同时显示“取消上传”。
- 页面可配置分批上传批次大小：SUB2API 默认 100 / 批，CPA 默认 20 / 批；不得超过 Worker 通过 `/api/config/status` 返回的 `limits` 上限。
- Worker 单批上限可由环境变量调整：`MAX_SUB2API_ACCOUNTS`（默认 100，硬上限 5000）、`MAX_CPA_FILES`（默认 20，硬上限 100）。
- SUB2API 的批量导入属于非幂等写操作。为避免响应丢失或超时后自动重试造成重复账号，Worker 对该 POST 不自动重试，前端也不再递归拆分重传。
- “已确认成功”只统计已经收到 SUB2API 成功响应的批次；正在处理的批次可能已经在服务器端写入一部分，所以服务器列表数量短时间内可能领先页面确认进度。
- 取消操作会停止后续批次并中断当前浏览器请求；若当前批次已经到达目标服务器，仍可能完成，因此取消后应先到目标服务器核对。
- 网络中断、超时或 5xx 等无法确定服务端最终结果的情况会标记为“状态未知”，不要直接批量重试，以免重复导入。
