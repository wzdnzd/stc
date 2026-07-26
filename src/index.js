const COOKIE_NAME = "converter_session";
const DEFAULT_SESSION_TTL_HOURS = 168;

// 单批数量：代码默认 / 绝对上限默认（均可被环境变量覆盖）
const DEFAULT_MAX_SUB2API_ACCOUNTS = 100;
const DEFAULT_MAX_CPA_FILES = 20;
const DEFAULT_ABSOLUTE_MAX_SUB2API_ACCOUNTS = 5000;
const DEFAULT_ABSOLUTE_MAX_CPA_FILES = 500;
const HARD_MAX_BATCH_SUB2API = 20000;
const HARD_MAX_BATCH_CPA = 2000;

// 上传并发
const DEFAULT_MAX_UPLOAD_CONCURRENCY_SUB2API = 3;
const DEFAULT_MAX_UPLOAD_CONCURRENCY_CPA = 8;
const DEFAULT_ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API = 50;
const DEFAULT_ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA = 150;
const HARD_MAX_UPLOAD_CONCURRENCY = 1000;

// 上传重试次数（含首次）
const DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS = 3;
const DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS = 3;
const DEFAULT_ABSOLUTE_MAX_UPLOAD_ATTEMPTS = 10;
const HARD_MAX_UPLOAD_ATTEMPTS = 30;

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
      limits: buildPublicLimits(env),
    });
  }

  if (url.pathname === "/api/config/verify" && request.method === "POST") {
    const body = await readJsonBody(request, 32 * 1024);
    const target = normalizeTarget(body?.target);
    const override = extractConfigOverride(body);
    const result = await verifyTarget(env, target, override);
    return jsonResponse({ ok: true, target, ...result });
  }

  if (url.pathname === "/api/upload/sub2api" && request.method === "POST") {
    const body = await readJsonBody(request, 20 * 1024 * 1024);
    const accounts = body?.accounts;
    const maxAccounts = maxSub2apiAccounts(env);
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new HttpError(400, "accounts 必须是非空数组。", "INVALID_PAYLOAD");
    }
    if (accounts.length > maxAccounts) {
      throw new HttpError(400, `单批最多上传 ${maxAccounts} 个 SUB2API 账号。`, "BATCH_TOO_LARGE");
    }
    // 仅从 body.config 读取覆盖配置，避免把 accounts/files 误当配置源
    const override = extractConfigOverride(body?.config);
    const maxAttempts = resolveRequestedAttempts(
      body?.maxAttempts,
      maxSub2apiUploadAttempts(env),
      DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS,
    );
    const retryAmbiguous = body?.retryAmbiguous === true;
    const result = await uploadSub2api(
      env,
      accounts,
      Boolean(body?.skipDefaultGroupBind),
      request.signal,
      override,
      maxAttempts,
      retryAmbiguous,
    );
    return jsonResponse({ ok: true, target: "SUB2API", count: accounts.length, ...result });
  }

  if (url.pathname === "/api/upload/cpa" && request.method === "POST") {
    const body = await readJsonBody(request, 20 * 1024 * 1024);
    const files = body?.files;
    const maxFiles = maxCpaFiles(env);
    if (!Array.isArray(files) || files.length === 0) {
      throw new HttpError(400, "files 必须是非空数组。", "INVALID_PAYLOAD");
    }
    if (files.length > maxFiles) {
      throw new HttpError(400, `单批最多上传 ${maxFiles} 个 CPA 账号。`, "BATCH_TOO_LARGE");
    }
    const override = extractConfigOverride(body?.config);
    const maxAttempts = resolveRequestedAttempts(
      body?.maxAttempts,
      maxCpaUploadAttempts(env),
      DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS,
    );
    const results = await uploadCpaFiles(env, files, request.signal, override, maxAttempts);
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
  if (missing.length) {
    return `Worker 尚未配置访问控制密钥：${missing.join(", ")}。请在 Cloudflare Worker 的 Settings → Variables and Secrets 中以 Secret 类型添加。`;
  }
  // 批次/并发/重试相关环境变量：值必须有效，且默认上限 ≤ 绝对上限
  return getLimitsEnvProblem(env);
}

/**
 * 读取单个环境变量原始值。
 * Cloudflare Worker 的 env 是绑定代理：不能依赖 hasOwnProperty / ownKeys。
 * 同时兼容 env[key]、Reflect.get，以及少数实现上的 env.get(key)。
 */
function readEnvRaw(env, key) {
  if (!env || !key) return undefined;

  try {
    if (typeof env.get === "function") {
      const viaGet = env.get(key);
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    }
  } catch {
    // ignore
  }

  try {
    const viaIndex = env[key];
    if (viaIndex !== undefined && viaIndex !== null) return viaIndex;
  } catch {
    // ignore
  }

  try {
    const viaReflect = Reflect.get(env, key);
    if (viaReflect !== undefined && viaReflect !== null) return viaReflect;
  } catch {
    // ignore
  }

  return undefined;
}

/** 读取第一个非空环境变量 */
function firstEnv(env, ...keys) {
  if (!env) return null;
  for (const key of keys) {
    const value = readEnvRaw(env, key);
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    return { key, raw: text };
  }
  return null;
}

function parsePositiveIntText(raw, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  // 允许 "100" / "100.0"；拒绝明显非数字
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  const floored = Math.floor(parsed);
  if (floored < min || floored > max) return null;
  return floored;
}

/**
 * 解析绝对上限。
 * - 显式设置 ABSOLUTE_MAX_* → 用该值（须 1–hardMax，且 ≥ defaultMax）
 * - 未设置但设置了 MAX_* → 用 hardMax，让单独配置 MAX_* 即可生效
 * - 都未设置 → 用 defaultAbsolute
 * @returns {{ value: number, source: "env"|"max-unbounded"|"default" } | { error: string }}
 */
function parseAbsoluteLimitEnv(absFound, maxFound, defaultAbsolute, defaultMax, hardMax, label) {
  if (defaultAbsolute < defaultMax) {
    return {
      error: `内置配置错误：${label} 默认绝对上限 ${defaultAbsolute} 小于默认上限 ${defaultMax}。`,
    };
  }

  if (absFound) {
    const parsed = parsePositiveIntText(absFound.raw, { min: 1, max: hardMax });
    if (parsed == null) {
      return {
        error: `${absFound.key} 必须是正整数（1–${hardMax}），当前值无效：${absFound.raw}`,
      };
    }
    if (parsed < defaultMax) {
      return {
        error:
          `${absFound.key}=${parsed} 无效：绝对上限必须 ≥ 默认上限 ${defaultMax}` +
          `（未设置 MAX_* 时的回退值）。`,
      };
    }
    return { value: parsed, source: "env" };
  }

  // 只配了 MAX_*：不再被偏低的 defaultAbsolute 卡住
  if (maxFound) return { value: hardMax, source: "max-unbounded" };
  return { value: defaultAbsolute, source: "default" };
}

/** 校验可选的 MAX_*：有效正整数且 ≤ 绝对上限 */
function validateOptionalMaxEnv(found, absolute, label) {
  if (!found) return "";
  const parsed = parsePositiveIntText(found.raw, { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (parsed == null) {
    return `${found.key} 必须是 ≥ 1 的正整数，当前值无效：${found.raw}`;
  }
  if (parsed > absolute) {
    return (
      `${found.key}=${parsed} 超过绝对上限 ${absolute}（${label}）。` +
      `请调低该值，或提高对应的 ABSOLUTE_MAX_*。`
    );
  }
  return "";
}

function getLimitsEnvProblem(env) {
  const specs = limitSpecs();
  for (const spec of specs) {
    const absFound = firstEnv(env, ...spec.absoluteKeys);
    const maxFound = firstEnv(env, ...spec.maxKeys);
    const abs = parseAbsoluteLimitEnv(
      absFound,
      maxFound,
      spec.defaultAbsolute,
      spec.defaultMax,
      spec.hardMax,
      spec.label,
    );
    if (abs.error) return abs.error;

    const maxErr = validateOptionalMaxEnv(maxFound, abs.value, spec.label);
    if (maxErr) return maxErr;
  }
  return "";
}

function limitSpecs() {
  return [
    {
      label: "SUB2API 单批账号数",
      defaultMax: DEFAULT_MAX_SUB2API_ACCOUNTS,
      defaultAbsolute: DEFAULT_ABSOLUTE_MAX_SUB2API_ACCOUNTS,
      hardMax: HARD_MAX_BATCH_SUB2API,
      maxKeys: ["MAX_SUB2API_ACCOUNTS"],
      absoluteKeys: ["ABSOLUTE_MAX_SUB2API_ACCOUNTS"],
    },
    {
      label: "CPA 单批文件数",
      defaultMax: DEFAULT_MAX_CPA_FILES,
      defaultAbsolute: DEFAULT_ABSOLUTE_MAX_CPA_FILES,
      hardMax: HARD_MAX_BATCH_CPA,
      maxKeys: ["MAX_CPA_FILES"],
      absoluteKeys: ["ABSOLUTE_MAX_CPA_FILES"],
    },
    {
      label: "SUB2API 上传并发",
      defaultMax: DEFAULT_MAX_UPLOAD_CONCURRENCY_SUB2API,
      defaultAbsolute: DEFAULT_ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API,
      hardMax: HARD_MAX_UPLOAD_CONCURRENCY,
      maxKeys: ["MAX_UPLOAD_CONCURRENCY_SUB2API"],
      absoluteKeys: ["ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API"],
    },
    {
      label: "CPA 上传并发",
      defaultMax: DEFAULT_MAX_UPLOAD_CONCURRENCY_CPA,
      defaultAbsolute: DEFAULT_ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA,
      hardMax: HARD_MAX_UPLOAD_CONCURRENCY,
      maxKeys: ["MAX_UPLOAD_CONCURRENCY_CPA"],
      absoluteKeys: ["ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA"],
    },
    {
      label: "SUB2API 上传重试次数",
      defaultMax: DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS,
      defaultAbsolute: DEFAULT_ABSOLUTE_MAX_UPLOAD_ATTEMPTS,
      hardMax: HARD_MAX_UPLOAD_ATTEMPTS,
      maxKeys: ["MAX_SUB2API_UPLOAD_ATTEMPTS"],
      absoluteKeys: ["ABSOLUTE_MAX_SUB2API_UPLOAD_ATTEMPTS", "ABSOLUTE_MAX_UPLOAD_ATTEMPTS"],
    },
    {
      label: "CPA 上传重试次数",
      defaultMax: DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS,
      defaultAbsolute: DEFAULT_ABSOLUTE_MAX_UPLOAD_ATTEMPTS,
      hardMax: HARD_MAX_UPLOAD_ATTEMPTS,
      maxKeys: ["MAX_CPA_UPLOAD_ATTEMPTS"],
      absoluteKeys: ["ABSOLUTE_MAX_CPA_UPLOAD_ATTEMPTS", "ABSOLUTE_MAX_UPLOAD_ATTEMPTS"],
    },
  ];
}

function resolveLimitDetail(env, spec) {
  const absFound = firstEnv(env, ...spec.absoluteKeys);
  const maxFound = firstEnv(env, ...spec.maxKeys);
  const abs = parseAbsoluteLimitEnv(
    absFound,
    maxFound,
    spec.defaultAbsolute,
    spec.defaultMax,
    spec.hardMax,
    spec.label,
  );
  const absolute = abs.value || spec.defaultAbsolute;
  const fallback = Math.min(spec.defaultMax, absolute);
  const value = parsePositiveIntEnv(maxFound?.raw, fallback, absolute);
  return {
    value,
    absolute,
    absoluteSource: abs.source || "default",
    maxKey: maxFound?.key || spec.maxKeys[0],
    maxRaw: maxFound?.raw || null,
    absoluteKey: absFound?.key || spec.absoluteKeys[0],
    absoluteRaw: absFound?.raw || null,
    fromEnv: Boolean(maxFound),
  };
}

function resolveLimit(env, spec) {
  return resolveLimitDetail(env, spec).value;
}

function buildPublicLimits(env) {
  const specs = limitSpecs();
  const resolved = specs.map((spec) => resolveLimitDetail(env, spec));
  return {
    maxSub2apiAccounts: resolved[0].value,
    maxCpaFiles: resolved[1].value,
    maxUploadConcurrencySub2api: resolved[2].value,
    maxUploadConcurrencyCpa: resolved[3].value,
    maxSub2apiUploadAttempts: resolved[4].value,
    maxCpaUploadAttempts: resolved[5].value,
    // 诊断：确认 Worker 实际读到了哪些 MAX_*/ABSOLUTE_MAX_*（不含密钥）
    resolvedFrom: {
      maxSub2apiAccounts: resolved[0].fromEnv ? resolved[0].maxKey : "default",
      maxCpaFiles: resolved[1].fromEnv ? resolved[1].maxKey : "default",
      maxUploadConcurrencySub2api: resolved[2].fromEnv ? resolved[2].maxKey : "default",
      maxUploadConcurrencyCpa: resolved[3].fromEnv ? resolved[3].maxKey : "default",
      maxSub2apiUploadAttempts: resolved[4].fromEnv ? resolved[4].maxKey : "default",
      maxCpaUploadAttempts: resolved[5].fromEnv ? resolved[5].maxKey : "default",
    },
    envSeen: {
      MAX_SUB2API_ACCOUNTS: resolved[0].maxRaw,
      MAX_CPA_FILES: resolved[1].maxRaw,
      MAX_UPLOAD_CONCURRENCY_SUB2API: resolved[2].maxRaw,
      MAX_UPLOAD_CONCURRENCY_CPA: resolved[3].maxRaw,
      MAX_SUB2API_UPLOAD_ATTEMPTS: resolved[4].maxRaw,
      MAX_CPA_UPLOAD_ATTEMPTS: resolved[5].maxRaw,
      ABSOLUTE_MAX_SUB2API_ACCOUNTS: resolved[0].absoluteRaw,
      ABSOLUTE_MAX_CPA_FILES: resolved[1].absoluteRaw,
      ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API: resolved[2].absoluteRaw,
      ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA: resolved[3].absoluteRaw,
      ABSOLUTE_MAX_SUB2API_UPLOAD_ATTEMPTS: firstEnv(env, "ABSOLUTE_MAX_SUB2API_UPLOAD_ATTEMPTS")?.raw || null,
      ABSOLUTE_MAX_CPA_UPLOAD_ATTEMPTS: firstEnv(env, "ABSOLUTE_MAX_CPA_UPLOAD_ATTEMPTS")?.raw || null,
      ABSOLUTE_MAX_UPLOAD_ATTEMPTS: firstEnv(env, "ABSOLUTE_MAX_UPLOAD_ATTEMPTS")?.raw || null,
    },
  };
}

function maxSub2apiAccounts(env) {
  return resolveLimit(env, limitSpecs()[0]);
}

function maxCpaFiles(env) {
  return resolveLimit(env, limitSpecs()[1]);
}

function maxUploadConcurrencySub2api(env) {
  return resolveLimit(env, limitSpecs()[2]);
}

function maxUploadConcurrencyCpa(env) {
  return resolveLimit(env, limitSpecs()[3]);
}

function maxSub2apiUploadAttempts(env) {
  return resolveLimit(env, limitSpecs()[4]);
}

function maxCpaUploadAttempts(env) {
  return resolveLimit(env, limitSpecs()[5]);
}

function resolveRequestedAttempts(requested, limit, fallbackDefault) {
  const requestedAttempts = Number(requested);
  if (Number.isFinite(requestedAttempts)) {
    return Math.min(limit, Math.max(1, Math.floor(requestedAttempts)));
  }
  return Math.min(limit, fallbackDefault);
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

function parsePositiveIntEnv(raw, fallback, absoluteMax) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  if (floored < 1) return fallback;
  return Math.min(absoluteMax, floored);
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

const MAX_OVERRIDE_BASE_URL_LENGTH = 2048;
const MAX_OVERRIDE_API_KEY_LENGTH = 8 * 1024;

function extractConfigOverride(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const baseUrl = String(source.baseUrl ?? source.base_url ?? "").trim();
  const apiKey = String(source.apiKey ?? source.api_key ?? "").trim();
  const cpaAuthModeRaw = source.cpaAuthMode ?? source.cpa_auth_mode;
  const cpaAuthMode = cpaAuthModeRaw == null || String(cpaAuthModeRaw).trim() === ""
    ? undefined
    : String(cpaAuthModeRaw).trim();

  // 原子覆盖：必须同时提供地址和密钥；只给一半时忽略，回退 env。
  if (!baseUrl && !apiKey && cpaAuthMode === undefined) return null;
  if (!baseUrl || !apiKey) {
    throw new HttpError(
      400,
      "自定义配置必须同时提供 baseUrl 和 apiKey；否则请省略以使用 Worker 环境变量。",
      "INVALID_CONFIG_OVERRIDE",
    );
  }
  if (baseUrl.length > MAX_OVERRIDE_BASE_URL_LENGTH) {
    throw new HttpError(400, "baseUrl 过长。", "INVALID_CONFIG_OVERRIDE");
  }
  if (apiKey.length > MAX_OVERRIDE_API_KEY_LENGTH) {
    throw new HttpError(400, "apiKey 过长。", "INVALID_CONFIG_OVERRIDE");
  }
  return { baseUrl, apiKey, cpaAuthMode };
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
      `${target} 尚未配置。请在页面填写服务器地址和密钥，或在 Worker 环境变量中设置：${missing.join(", ")}。`,
      "TARGET_NOT_CONFIGURED",
      { target, missing },
    );
  }

  return {
    target,
    baseUrl: normalizeBaseUrl(rawBaseUrl, target, env),
    apiKey,
    cpaAuthMode: normalizeCpaAuthMode(env.CPA_AUTH_MODE),
    source: "env",
  };
}

function resolveTargetConfig(env, target, override = null) {
  if (override?.baseUrl && override?.apiKey) {
    return {
      target,
      baseUrl: normalizeBaseUrl(override.baseUrl, target, env),
      apiKey: String(override.apiKey).trim(),
      cpaAuthMode: normalizeCpaAuthMode(
        override.cpaAuthMode !== undefined ? override.cpaAuthMode : env.CPA_AUTH_MODE,
      ),
      source: "client",
    };
  }
  return getTargetConfig(env, target);
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
    source: "env",
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

async function verifyTarget(env, target, override = null) {
  const config = resolveTargetConfig(env, target, override);
  if (target === "SUB2API") {
    const result = await sub2apiRequest(config, "/api/v1/admin/accounts?page=1&page_size=1&lite=1", {
      method: "GET",
    }, VERIFY_TIMEOUT_MS, 1);
    return {
      baseUrl: config.baseUrl,
      source: config.source,
      message: "SUB2API 管理接口验证成功。",
      attempts: result.attempts,
    };
  }

  const result = await cpaRequest(config, "/v0/management/auth-files", { method: "GET" }, VERIFY_TIMEOUT_MS, 1);
  if (!result.data || !Array.isArray(result.data.files)) {
    throw new HttpError(502, "CPA 返回了非预期的管理接口响应。", "INVALID_UPSTREAM_RESPONSE");
  }
  return {
    baseUrl: config.baseUrl,
    source: config.source,
    message: "CPA 管理接口验证成功。",
    authMode: result.authMode,
    attempts: result.attempts,
  };
}

async function uploadSub2api(
  env,
  accounts,
  skipDefaultGroupBind,
  clientSignal,
  override = null,
  maxAttempts = 1,
  retryAmbiguous = false,
) {
  const config = resolveTargetConfig(env, "SUB2API", override);
  const payload = {
    data: {
      exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      proxies: [],
      accounts,
    },
    skip_default_group_bind: skipDefaultGroupBind,
  };
  // bulk 导入非幂等：默认只对“较安全”的失败重试；超时等模糊失败仅在 retryAmbiguous 时重试
  const result = await sub2apiRequest(
    config,
    "/api/v1/admin/accounts/data",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    UPSTREAM_TIMEOUT_MS,
    Math.max(1, Math.floor(Number(maxAttempts) || 1)),
    clientSignal,
    {
      retryAmbiguous: Boolean(retryAmbiguous),
      writeOperation: true,
    },
  );
  return {
    attempts: result.attempts,
    source: config.source,
    data: result.data?.data ?? result.data,
  };
}

async function uploadCpaFiles(env, files, clientSignal, override = null, maxAttempts = DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS) {
  const config = resolveTargetConfig(env, "CPA", override);
  const normalized = files.map((entry, index) => {
    if (!entry || typeof entry !== "object" || !entry.account || typeof entry.account !== "object") {
      throw new HttpError(400, `files[${index}] 缺少 account 对象。`, "INVALID_PAYLOAD");
    }
    return {
      name: sanitizeJsonFilename(entry.name || `xai-account-${index + 1}.json`),
      account: entry.account,
    };
  });

  const attempts = Math.max(1, Math.floor(Number(maxAttempts) || DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS));
  // Worker 批内串行单文件上传，总并发由前端上传并发控制，避免双重放大
  return mapWithConcurrency(normalized, 1, async (entry) => {
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
        attempts,
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

async function sub2apiRequest(config, path, init, timeoutMs, maxAttempts, clientSignal, retryOptions = {}) {
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
    retryAmbiguous: retryOptions.retryAmbiguous === true,
    writeOperation: retryOptions.writeOperation === true,
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
      const canRetry = options.writeOperation
        ? isRetryableWrite(lastError, options.retryAmbiguous === true)
        : isRetryable(lastError);
      if (attempt >= maxAttempts || !canRetry) throw lastError;
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

// 写操作（尤其 SUB2API bulk）更保守：
// - 安全重试：无 status 网络错误、429、502/503 等较可能未落库的情况
// - 模糊重试（可选）：超时 504 / 500 —— 可能已写入，仅当调用方明确允许时重试
function isRetryableWrite(error, retryAmbiguous = false) {
  if (error?.code === "CLIENT_ABORTED" || error?.status === 499) return false;
  if (error?.code === "UPSTREAM_BUSINESS_ERROR") return false;
  if (error?.status && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
    return false;
  }
  if (!error?.status) return true;
  if ([408, 425, 429, 502, 503].includes(error.status)) return true;
  if (retryAmbiguous && [500, 504].includes(error.status)) return true;
  if (error?.code === "UPSTREAM_TIMEOUT") return Boolean(retryAmbiguous);
  if (error?.code === "UPSTREAM_NETWORK_ERROR") return true;
  return false;
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
<body><main class="panel">
<h1>CPA ↔ SUB2API 账号转换与批量上传工具</h1>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/auth/login">
<input id="password" name="password" type="password" required autofocus autocomplete="current-password" placeholder="访问密码" aria-label="访问密码">
<button type="submit">登录</button>
</form>
</main></body></html>`;
}

function renderSetupPage(message) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要配置 · CPA ↔ SUB2API</title><style>${authPageCss()}</style></head>
<body><main class="panel">
<h1>尚未完成配置</h1>
<div class="error">${escapeHtml(message)}</div>
<p>在 Worker 的 Variables and Secrets 中添加：</p>
<pre>APP_PASSWORD
SESSION_SECRET</pre>
<div class="hint">保存并重新部署后刷新本页。</div>
</main></body></html>`;
}

function renderErrorPage(error) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>错误</title><style>${authPageCss()}</style></head>
<body><main class="panel"><h1>请求失败</h1><div class="error">${escapeHtml(publicErrorMessage(error))}</div><p><a href="/">返回</a></p></main></body></html>`;
}

function authPageCss() {
  return `:root{color-scheme:dark;--bg:#0b1017;--panel:#141c28;--border:#2a3649;--text:#e8eef7;--muted:#8b9bb4;--accent:#3b82f6;--danger:#ef4444}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:radial-gradient(900px 500px at 10% -10%,rgba(37,99,235,.18),transparent 55%),radial-gradient(800px 450px at 100% 0%,rgba(124,58,237,.12),transparent 48%),var(--bg);color:var(--text);font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}.panel{width:min(460px,100%);padding:28px 26px;border:1px solid var(--border);border-radius:14px;background:var(--panel);box-shadow:0 24px 70px rgba(0,0,0,.4)}.panel h1{margin:0;font-size:17px;letter-spacing:-.02em;line-height:1.4;white-space:nowrap}.panel .sub{margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.5}.panel p,.hint{color:var(--muted);font-size:13px;line-height:1.6;margin:0 0 4px}input{width:100%;margin-top:18px;padding:11px 12px;border:1px solid var(--border);border-radius:8px;background:#1c2738;color:var(--text);font:inherit}input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(59,130,246,.15)}input::placeholder{color:var(--muted)}button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:700;cursor:pointer}button:hover{filter:brightness(1.08)}.error{margin:14px 0 0;padding:10px 12px;border:1px solid rgba(239,68,68,.35);border-radius:8px;background:rgba(239,68,68,.12);color:#fca5a5;font-size:12px;white-space:pre-wrap;line-height:1.55}pre{overflow:auto;margin:12px 0;padding:12px;border:1px solid var(--border);border-radius:8px;background:#0f172a;color:#cbd5e1;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.hint{margin-top:12px}a{color:#93c5fd;text-decoration:none}a:hover{text-decoration:underline}`;
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
