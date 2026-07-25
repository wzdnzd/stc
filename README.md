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

前端每批发送 50 个账号；Worker 对临时网络错误、429 和 5xx 最多重试 3 次。批次失败时，前端会递归拆分批次以定位失败账号。

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

SUB2API 和 CPA 均为可选目标，但每个目标的地址和密钥必须成对配置。页面会显示配置状态；点击上传时还会实时调用对应管理接口验证有效性。
