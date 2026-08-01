export function publicErrorMessage(error) {
  if (!error) return "未知错误";
  return error.message || String(error);
}

export function errorResponse(error) {
  const status = error?.status || 500;
  const details = error?.details;
  const body = {
    ok: false,
    code: error?.code || "INTERNAL_ERROR",
    error: status >= 500 && !error?.message ? "服务器内部错误" : publicErrorMessage(error),
    attempts: error?.attempts,
  };
  // TARGET_NOT_CONFIGURED 等诊断信息
  if (error?.code === "TARGET_NOT_CONFIGURED" && details !== undefined) {
    body.details = details;
  }
  // 远端导出/下载等：把失败明细与部分成功包透出给前端分批合并
  if (details && typeof details === "object" && !Array.isArray(details)) {
    if (Array.isArray(details.failures)) body.failures = details.failures;
    if (details.failedCount != null) body.failedCount = details.failedCount;
    if (Array.isArray(details.successIds)) body.successIds = details.successIds;
    if (details.pack && typeof details.pack === "object") body.pack = details.pack;
    if (Array.isArray(details.files)) body.files = details.files;
  }
  return jsonResponse(body, status);
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...securityHeaders(),
    },
  });
}

export function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...securityHeaders(),
    },
  });
}

export function withSecurityHeaders(response, privateAsset = false) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  if (privateAsset) headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function securityHeaders() {
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

export function renderLoginPage(error = "") {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · CPA ↔ SUB2API</title><style>${authPageCss()}</style></head>
<body><main class="panel">
<h1>CPA ↔ SUB2API 账号转换与批量上传工具</h1>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/auth/login">
<input id="password" name="password" type="password" required autofocus autocomplete="current-password" placeholder="访问密码" aria-label="访问密码">
<button type="submit">登录</button>
</form>
</main></body></html>`;
}

export function renderSetupPage(message) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要配置 · CPA ↔ SUB2API</title><style>${authPageCss()}</style></head>
<body><main class="panel">
<h1>尚未完成配置</h1>
<div class="error">${escapeHtml(message)}</div>
<p>在 Worker 的 Variables and Secrets 中添加：</p>
<pre>APP_PASSWORD
SESSION_SECRET</pre>
<div class="hint">保存并重新部署后刷新本页</div>
</main></body></html>`;
}

export function renderErrorPage(error) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>错误</title><style>${authPageCss()}</style></head>
<body><main class="panel"><h1>请求失败</h1><div class="error">${escapeHtml(publicErrorMessage(error))}</div><p><a href="/">返回</a></p></main></body></html>`;
}

export function authPageCss() {
  return `:root{color-scheme:dark;--bg:#0b1017;--panel:#141c28;--border:#2a3649;--text:#e8eef7;--muted:#8b9bb4;--accent:#3b82f6;--danger:#ef4444}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:radial-gradient(900px 500px at 10% -10%,rgba(37,99,235,.18),transparent 55%),radial-gradient(800px 450px at 100% 0%,rgba(124,58,237,.12),transparent 48%),var(--bg);color:var(--text);font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}.panel{width:min(460px,100%);padding:28px 26px;border:1px solid var(--border);border-radius:14px;background:var(--panel);box-shadow:0 24px 70px rgba(0,0,0,.4)}.panel h1{margin:0;font-size:17px;letter-spacing:-.02em;line-height:1.4;white-space:nowrap}.panel .sub{margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.5}.panel p,.hint{color:var(--muted);font-size:13px;line-height:1.6;margin:0 0 4px}input{width:100%;margin-top:18px;padding:11px 12px;border:1px solid var(--border);border-radius:8px;background:#1c2738;color:var(--text);font:inherit}input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(59,130,246,.15)}input::placeholder{color:var(--muted)}button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:700;cursor:pointer}button:hover{filter:brightness(1.08)}.error{margin:14px 0 0;padding:10px 12px;border:1px solid rgba(239,68,68,.35);border-radius:8px;background:rgba(239,68,68,.12);color:#fca5a5;font-size:12px;white-space:pre-wrap;line-height:1.55}pre{overflow:auto;margin:12px 0;padding:12px;border:1px solid var(--border);border-radius:8px;background:#0f172a;color:#cbd5e1;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.hint{margin-top:12px}a{color:#93c5fd;text-decoration:none}a:hover{text-decoration:underline}`;
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
