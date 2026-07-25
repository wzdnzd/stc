const COOKIE_NAME = "converter_session";
const DEFAULT_SESSION_TTL_HOURS = 168;
const MAX_SUB2API_ACCOUNTS = 500;
const MAX_CPA_FILES = 12;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 30 * 1000;

class HttpError extends Error {
  constructor(status, message, code = "REQUEST_FAILED", details = undefined) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Unhandled error", error?.stack || error);
      if (new URL(request.url).pathname.startsWith("/api/")) {
        return errorResponse(error);
      }
      return htmlResponse(renderErrorPage(error), error?.status || 500);
    }
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const setupProblem = getAccessSetupProblem(env);

  if (url.pathname === "/auth/login") {
    if (setupProblem) return htmlResponse(renderSetupPage(setupProblem), 503);
    return handleLogin(request, env);
  }

  if (url.pathname === "/auth/logout") {
    assertTrustedMutation(request);
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": clearSessionCookie(),
        ...securityHeaders(),
      },
    });
  }

  if (setupProblem) {
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ ok: false, code: "APP_NOT_CONFIGURED", error: setupProblem }, 503);
    }
    return htmlResponse(renderSetupPage(setupProblem), 503);
  }

  const authenticated = await isAuthenticated(request, env);
  if (!authenticated) {
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ ok: false, code: "AUTH_REQUIRED", error: "登录状态已失效，请重新登录。" }, 401);
    }
    return htmlResponse(renderLoginPage(), 401);
  }

  if (url.pathname.startsWith("/api/")) {
    return handleApi(request, env, url);
  }

  const assetResponse = await env.ASSETS.fetch(request);
  return withSecurityHeaders(assetResponse, true);
}

async function handleApi(request, env, url) {
  if (request.method !== "GET") assertTrustedMutation(request);

  if (url.pathname === "/api/config/status" && request.method === "GET") {
    return jsonResponse({
      ok: true,
      targets: {
        SUB2API: publicTargetStatus(env, "SUB2API"),
        CPA: publicTargetStatus(env, "CPA"),
      },
      access: {
        protected: true,
        sessionTtlHours: sessionTtlHours(env),
      },
    });
  }

  if (url.pathname === "/api/config/verify" && request.method === "POST") {
    const body = await readJsonBody(request, 32 * 1024);
    const target = normalizeTarget(body?.target);
    const result = await verifyTarget(env, target);
    return jsonResponse({ ok: true, target, ...result });
  }

  if (url.pathname === "/api/upload/sub2api" && request.method === "POST") {
    const body = await readJsonBody(request, 20 * 1024 * 1024);
    const accounts = body?.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new HttpError(400, "accounts 必须是非空数组。", "INVALID_PAYLOAD");
    }
    if (accounts.length > MAX_SUB2API_ACCOUNTS) {
      throw new HttpError(400, `单批最多上传 ${MAX_SUB2API_ACCOUNTS} 个 SUB2API 账号。`, "BATCH_TOO_LARGE");
    }
    const result = await uploadSub2api(env, accounts, Boolean(body?.skipDefaultGroupBind), request.signal);
    return jsonResponse({ ok: true, target: "SUB2API", count: accounts.length, ...result });
  }

  if (url.pathname === "/api/upload/cpa" && request.method === "POST") {
    const body = await readJsonBody(request, 20 * 1024 * 1024);
    const files = body?.files;
    if (!Array.isArray(files) || files.length === 0) {
      throw new HttpError(400, "files 必须是非空数组。", "INVALID_PAYLOAD");
    }
    if (files.length > MAX_CPA_FILES) {
      throw new HttpError(400, `单批最多上传 ${MAX_CPA_FILES} 个 CPA 账号。`, "BATCH_TOO_LARGE");
    }
    const results = await uploadCpaFiles(env, files, request.signal);
    return jsonResponse({
      ok: results.every((item) => item.ok),
      target: "CPA",
      results,
    });
  }

  throw new HttpError(404, "API 路径不存在。", "NOT_FOUND");
}

function getAccessSetupProblem(env) {
  const missing = [];
  if (!String(env.APP_PASSWORD || "").trim()) missing.push("APP_PASSWORD");
  if (!String(env.SESSION_SECRET || "").trim()) missing.push("SESSION_SECRET");
  if (!missing.length) return "";
  return `Worker 尚未配置访问控制密钥：${missing.join(", ")}。请在 Cloudflare Worker 的 Settings → Variables and Secrets 中以 Secret 类型添加。`;
}

async function handleLogin(request, env) {
  if (request.method === "GET") return htmlResponse(renderLoginPage(), 200);
  if (request.method !== "POST") throw new HttpError(405, "Method Not Allowed", "METHOD_NOT_ALLOWED");

  // 登录请求不做严格 Origin 比对。Cloudflare Dashboard/Preview、自定义域名
  // 或边缘代理可能使浏览器的 Origin 与 Worker 看到的 request.url 不完全一致，
  // 从而误判为跨站。登录仍受访问密码、失败延迟和后续 SameSite 会话 Cookie 保护。
  const contentType = request.headers.get("content-type") || "";
  let password = "";
  if (contentType.includes("application/json")) {
    const body = await readJsonBody(request, 16 * 1024);
    password = String(body?.password || "");
  } else {
    const form = await request.formData();
    password = String(form.get("password") || "");
  }

  if (!constantTimeEqual(password, String(env.APP_PASSWORD))) {
    await sleep(650);
    return htmlResponse(renderLoginPage("访问密码不正确。"), 401);
  }

  const token = await createSessionToken(env);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": sessionCookie(token, sessionTtlHours(env)),
      ...securityHeaders(),
    },
  });
}

function sessionTtlHours(env) {
  const parsed = Number(env.SESSION_TTL_HOURS || DEFAULT_SESSION_TTL_HOURS);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_TTL_HOURS;
  return Math.min(24 * 30, Math.max(1, Math.floor(parsed)));
}

async function createSessionToken(env) {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + sessionTtlHours(env) * 3600,
    nonce: crypto.randomUUID(),
  };
  const encoded = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSign(encoded, String(env.SESSION_SECRET));
  return `${encoded}.${signature}`;
}

async function isAuthenticated(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;

  const expected = await hmacSign(payload, String(env.SESSION_SECRET));
  if (!constantTimeEqual(signature, expected)) return false;

  try {
    const data = JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));
    return Number.isFinite(data.exp) && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64urlEncode(new Uint8Array(signature));
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function base64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

function sessionCookie(token, ttlHours) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttlHours * 3600}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function assertTrustedMutation(request) {
  const fetchSite = String(request.headers.get("Sec-Fetch-Site") || "").toLowerCase();

  // 浏览器明确标记为 cross-site 时拒绝。允许 same-origin、same-site 和 none；
  // 这比直接比较 Origin 与 request.url 更适合 Workers 的预览 URL、自定义域名
  // 以及可能存在的边缘代理，同时仍可阻止普通跨站表单/Fetch 携带会话执行写操作。
  if (fetchSite === "cross-site") {
    throw new HttpError(403, "拒绝跨站请求。", "CROSS_SITE_REQUEST");
  }

  // 某些非浏览器客户端不发送 Sec-Fetch-Site。此时若提供了正常 Origin，
  // 仍进行传统同源检查；Origin: null 不参与判断，避免沙箱预览误伤。
  if (!fetchSite) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== "null") {
      let parsedOrigin;
      try {
        parsedOrigin = new URL(origin).origin;
      } catch {
        throw new HttpError(403, "拒绝跨站请求。", "CROSS_SITE_REQUEST");
      }
      if (parsedOrigin !== new URL(request.url).origin) {
        throw new HttpError(403, "拒绝跨站请求。", "CROSS_SITE_REQUEST");
      }
    }
  }
}

function normalizeTarget(value) {
  const target = String(value || "").toUpperCase();
  if (target !== "SUB2API" && target !== "CPA") {
    throw new HttpError(400, "target 必须是 SUB2API 或 CPA。", "INVALID_TARGET");
  }
  return target;
}

function targetEnvNames(target) {
  return target === "SUB2API"
    ? { url: "SUB2API_BASE_URL", key: "SUB2API_ADMIN_API_KEY" }
    : { url: "CPA_BASE_URL", key: "CPA_MANAGEMENT_KEY" };
}

function getTargetConfig(env, target) {
  const names = targetEnvNames(target);
  const rawBaseUrl = String(env[names.url] || "").trim();
  const apiKey = String(env[names.key] || "").trim();
  const missing = [];
  if (!rawBaseUrl) missing.push(names.url);
  if (!apiKey) missing.push(names.key);

  if (missing.length) {
    throw new HttpError(
      503,
      `${target} 尚未配置。请在 Worker 环境变量中设置：${missing.join(", " )}。`,
      "TARGET_NOT_CONFIGURED",
      { target, missing },
    );
  }

  return {
    target,
    baseUrl: normalizeBaseUrl(rawBaseUrl, target, env),
    apiKey,
    cpaAuthMode: normalizeCpaAuthMode(env.CPA_AUTH_MODE),
  };
}

function publicTargetStatus(env, target) {
  const names = targetEnvNames(target);
  const rawBaseUrl = String(env[names.url] || "").trim();
  const hasKey = Boolean(String(env[names.key] || "").trim());
  const missing = [];
  if (!rawBaseUrl) missing.push(names.url);
  if (!hasKey) missing.push(names.key);

  let baseUrl = "";
  let urlError = "";
  if (rawBaseUrl) {
    try {
      baseUrl = normalizeBaseUrl(rawBaseUrl, target, env);
    } catch (error) {
      urlError = error.message;
    }
  }

  return {
    configured: missing.length === 0 && !urlError,
    baseUrl,
    missing,
    urlError,
    variables: {
      baseUrl: names.url,
      apiKey: names.key,
      apiKeyShouldBeSecret: true,
    },
  };
}

function normalizeBaseUrl(raw, target, env) {
  let value = String(raw || "").trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(503, `${target} 服务器地址无效。`, "INVALID_BASE_URL");
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(503, `${target} 服务器地址仅支持 HTTP/HTTPS。`, "INVALID_BASE_URL");
  }
  if (url.protocol !== "https:" && String(env.ALLOW_INSECURE_UPSTREAM || "").toLowerCase() !== "true") {
    throw new HttpError(
      503,
      `${target} 服务器地址必须使用 HTTPS；确需 HTTP 时设置 ALLOW_INSECURE_UPSTREAM=true。`,
      "INSECURE_UPSTREAM",
    );
  }

  url.hash = "";
  url.search = "";
  let path = url.pathname.replace(/\/+$/, "");
  if (target === "SUB2API") {
    path = path.replace(/\/api\/v1\/admin$/i, "").replace(/\/api\/v1$/i, "");
  } else {
    path = path.replace(/\/v0\/management$/i, "");
  }
  url.pathname = path || "/";
  return url.toString().replace(/\/$/, "");
}

function normalizeCpaAuthMode(value) {
  const mode = String(value || "auto").toLowerCase();
  return ["auto", "bearer", "x-management-key"].includes(mode) ? mode : "auto";
}

async function verifyTarget(env, target) {
  const config = getTargetConfig(env, target);
  if (target === "SUB2API") {
    const result = await sub2apiRequest(config, "/api/v1/admin/accounts?page=1&page_size=1&lite=1", {
      method: "GET",
    }, VERIFY_TIMEOUT_MS, 1);
    return { baseUrl: config.baseUrl, message: "SUB2API 管理接口验证成功。", attempts: result.attempts };
  }

  const result = await cpaRequest(config, "/v0/management/auth-files", { method: "GET" }, VERIFY_TIMEOUT_MS, 1);
  if (!result.data || !Array.isArray(result.data.files)) {
    throw new HttpError(502, "CPA 返回了非预期的管理接口响应。", "INVALID_UPSTREAM_RESPONSE");
  }
  return {
    baseUrl: config.baseUrl,
    message: "CPA 管理接口验证成功。",
    authMode: result.authMode,
    attempts: result.attempts,
  };
}

async function uploadSub2api(env, accounts, skipDefaultGroupBind, clientSignal) {
  const config = getTargetConfig(env, "SUB2API");
  const payload = {
    data: {
      exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      proxies: [],
      accounts,
    },
    skip_default_group_bind: skipDefaultGroupBind,
  };
  const result = await sub2apiRequest(config, "/api/v1/admin/accounts/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, UPSTREAM_TIMEOUT_MS, 1, clientSignal);
  return { attempts: result.attempts, data: result.data?.data ?? result.data };
}

async function uploadCpaFiles(env, files, clientSignal) {
  const config = getTargetConfig(env, "CPA");
  const normalized = files.map((entry, index) => {
    if (!entry || typeof entry !== "object" || !entry.account || typeof entry.account !== "object") {
      throw new HttpError(400, `files[${index}] 缺少 account 对象。`, "INVALID_PAYLOAD");
    }
    return {
      name: sanitizeJsonFilename(entry.name || `xai-account-${index + 1}.json`),
      account: entry.account,
    };
  });

  return mapWithConcurrency(normalized, 4, async (entry) => {
    try {
      const result = await cpaRequest(
        config,
        `/v0/management/auth-files?name=${encodeURIComponent(entry.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry.account),
        },
        120000,
        3,
        clientSignal,
      );
      return {
        name: entry.name,
        ok: true,
        attempts: result.attempts,
        authMode: result.authMode,
      };
    } catch (error) {
      return {
        name: entry.name,
        ok: false,
        attempts: error?.attempts || 1,
        status: error?.status || 502,
        error: publicErrorMessage(error),
      };
    }
  });
}

function sanitizeJsonFilename(value) {
  let name = String(value || "").trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
  if (!name.toLowerCase().endsWith(".json")) name += ".json";
  if (name.length > 180) name = `${name.slice(0, 175)}.json`;
  return name || "account.json";
}

async function sub2apiRequest(config, path, init, timeoutMs, maxAttempts, clientSignal) {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");
  headers.set("x-api-key", config.apiKey);
  return requestJsonWithRetry(`${config.baseUrl}${path}`, { ...init, headers }, {
    timeoutMs,
    maxAttempts,
    validate(data) {
      if (data && data.code !== undefined && data.code !== 0 && data.code !== "0") {
        const message = data.message || `SUB2API 业务错误：${data.code}`;
        throw new HttpError(400, message, "UPSTREAM_BUSINESS_ERROR", data);
      }
    },
    clientSignal,
  });
}

async function cpaRequest(config, path, init, timeoutMs, maxAttempts, clientSignal) {
  const modes = cpaAuthModes(config.cpaAuthMode);
  let lastError;
  for (const mode of modes) {
    const headers = new Headers(init.headers || {});
    headers.set("Accept", "application/json");
    if (mode === "x-management-key") headers.set("X-Management-Key", config.apiKey);
    else headers.set("Authorization", `Bearer ${config.apiKey}`);

    try {
      const result = await requestJsonWithRetry(`${config.baseUrl}${path}`, { ...init, headers }, {
        timeoutMs,
        maxAttempts,
        clientSignal,
      });
      return { ...result, authMode: mode };
    } catch (error) {
      lastError = error;
      if (![401, 403].includes(error?.status)) throw error;
    }
  }
  throw lastError || new HttpError(401, "CPA 管理密钥验证失败。", "UPSTREAM_AUTH_FAILED");
}

function cpaAuthModes(preferred) {
  if (preferred === "bearer") return ["bearer"];
  if (preferred === "x-management-key") return ["x-management-key"];
  return ["bearer", "x-management-key"];
}

async function requestJsonWithRetry(url, init, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const maxAttempts = options.maxAttempts || 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (options.clientSignal?.aborted) {
        throw new HttpError(499, "客户端已取消上传。", "CLIENT_ABORTED");
      }
      const response = await fetchWithTimeout(url, init, timeoutMs, options.clientSignal);
      const text = await response.text();
      const data = parseResponseBody(text);
      if (!response.ok) {
        const detail = data?.message || data?.error || data?.code || data?.raw || response.statusText;
        const error = new HttpError(
          response.status,
          `上游 HTTP ${response.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
          "UPSTREAM_HTTP_ERROR",
          data,
        );
        error.attempts = attempt;
        throw error;
      }
      if (options.validate) options.validate(data);
      return { response, data, attempts: attempt };
    } catch (error) {
      lastError = normalizeUpstreamError(error);
      lastError.attempts = attempt;
      if (attempt >= maxAttempts || !isRetryable(lastError)) throw lastError;
      await sleep(700 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 300));
    }
  }
  throw lastError;
}

async function fetchWithTimeout(url, init, timeoutMs, clientSignal) {
  const controller = new AbortController();
  const timeoutError = new DOMException("upstream timeout", "TimeoutError");
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const onClientAbort = () => {
    controller.abort(new DOMException("client cancelled", "AbortError"));
  };

  if (clientSignal) {
    if (clientSignal.aborted) onClientAbort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } catch (error) {
    if (clientSignal?.aborted) {
      throw new HttpError(499, "客户端已取消上传。", "CLIENT_ABORTED");
    }
    if (controller.signal.aborted) {
      throw new HttpError(504, "上游请求超时；服务器可能已经接收并处理本批数据，请先核对后再重试。", "UPSTREAM_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    clientSignal?.removeEventListener?.("abort", onClientAbort);
  }
}

function normalizeUpstreamError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(502, `无法连接上游服务器：${error?.message || String(error)}`, "UPSTREAM_NETWORK_ERROR");
}

function isRetryable(error) {
  if (!error?.status) return true;
  return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
}

function parseResponseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function readJsonBody(request, maxBytes) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new HttpError(413, "请求体过大。", "PAYLOAD_TOO_LARGE");
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new HttpError(413, "请求体过大。", "PAYLOAD_TOO_LARGE");
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new HttpError(400, "请求体不是有效 JSON。", "INVALID_JSON");
  }
}

function publicErrorMessage(error) {
  if (!error) return "未知错误";
  return error.message || String(error);
}

function errorResponse(error) {
  const status = error?.status || 500;
  return jsonResponse({
    ok: false,
    code: error?.code || "INTERNAL_ERROR",
    error: status >= 500 && !error?.message ? "服务器内部错误。" : publicErrorMessage(error),
    details: error?.code === "TARGET_NOT_CONFIGURED" ? error?.details : undefined,
    attempts: error?.attempts,
  }, status);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...securityHeaders(),
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...securityHeaders(),
    },
  });
}

function withSecurityHeaders(response, privateAsset = false) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  if (privateAsset) headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

function renderLoginPage(error = "") {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · CPA ↔ SUB2API</title><style>${authPageCss()}</style></head>
<body><main class="panel"><div class="eyebrow">PRIVATE TOOL</div><h1>CPA ↔ SUB2API</h1><p>请输入此 Worker 配置的访问密码。</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/auth/login"><label for="password">访问密码</label><input id="password" name="password" type="password" required autofocus autocomplete="current-password"><button type="submit">登录</button></form>
<div class="hint">会话通过 HttpOnly、Secure、SameSite=Strict Cookie 保存，管理员 API Key 不会下发到浏览器。</div></main></body></html>`;
}

function renderSetupPage(message) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要配置 · CPA ↔ SUB2API</title><style>${authPageCss()}</style></head>
<body><main class="panel"><div class="eyebrow">SETUP REQUIRED</div><h1>Worker 尚未完成配置</h1><div class="error">${escapeHtml(message)}</div>
<p>进入 Cloudflare Dashboard → Workers & Pages → 当前 Worker → Settings → Variables and Secrets，添加以下 Secret：</p>
<pre>APP_PASSWORD=页面访问密码
SESSION_SECRET=至少 32 字节随机字符串</pre>
<div class="hint">保存并部署新版本后刷新本页面。</div></main></body></html>`;
}

function renderErrorPage(error) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>错误</title><style>${authPageCss()}</style></head><body><main class="panel"><div class="eyebrow">ERROR</div><h1>请求失败</h1><div class="error">${escapeHtml(publicErrorMessage(error))}</div><p><a href="/">返回工具</a></p></main></body></html>`;
}

function authPageCss() {
  return `:root{color-scheme:dark;--bg:#0f1419;--panel:#1a2332;--border:#2d3a4f;--text:#e7ecf3;--muted:#8b9bb4;--accent:#3b82f6;--danger:#ef4444}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:radial-gradient(900px 500px at 10% -10%,#1e293b 0%,transparent 55%),radial-gradient(800px 450px at 100% 0%,#172554 0%,transparent 48%),var(--bg);color:var(--text);font-family:"SF Mono","Menlo","Consolas","PingFang SC","Microsoft YaHei",monospace}.panel{width:min(460px,100%);padding:28px;border:1px solid var(--border);border-radius:14px;background:var(--panel);box-shadow:0 24px 80px rgba(0,0,0,.45)}.eyebrow{color:#93c5fd;font-size:11px;letter-spacing:1.6px}.panel h1{margin:8px 0 10px;font-size:22px}.panel p,.hint{color:var(--muted);font-size:13px;line-height:1.7}label{display:block;margin:20px 0 7px;color:var(--muted);font-size:12px}input{width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;background:#243044;color:var(--text);font:inherit}input:focus{outline:none;border-color:var(--accent)}button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:8px;background:var(--accent);color:white;font:inherit;font-weight:700;cursor:pointer}.error{margin:14px 0;padding:10px 12px;border:1px solid rgba(239,68,68,.35);border-radius:8px;background:rgba(239,68,68,.12);color:#fca5a5;font-size:12px;white-space:pre-wrap}pre{overflow:auto;padding:12px;border:1px solid var(--border);border-radius:8px;background:#0f172a;color:#cbd5e1;font-size:12px}a{color:#93c5fd}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
