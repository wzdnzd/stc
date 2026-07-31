const COOKIE_NAME = "converter_session";
const DEFAULT_SESSION_TTL_HOURS = 168;

// 单批数量：代码默认 / 绝对上限默认（均可被环境变量覆盖）
const DEFAULT_MAX_SUB2API_ACCOUNTS = 100;
const DEFAULT_MAX_CPA_FILES = 20;
const DEFAULT_ABSOLUTE_MAX_SUB2API_ACCOUNTS = 5000;
const DEFAULT_ABSOLUTE_MAX_CPA_FILES = 500;
// 导入单批平台天花板（最高上限）
const HARD_MAX_BATCH_SUB2API = 50000;
const HARD_MAX_BATCH_CPA = 50000;

// 远端导出 / 下载 / 去重删除：代码默认 / 绝对上限默认（均可被环境变量覆盖）
const DEFAULT_MAX_CPA_AUTH_DOWNLOAD_FILES = 500;
const DEFAULT_ABSOLUTE_MAX_CPA_AUTH_DOWNLOAD_FILES = 2000;
const HARD_MAX_CPA_AUTH_DOWNLOAD_FILES = 50000;
const DEFAULT_MAX_SUB2API_EXPORT_ACCOUNTS = 500;
const DEFAULT_ABSOLUTE_MAX_SUB2API_EXPORT_ACCOUNTS = 2000;
const HARD_MAX_SUB2API_EXPORT_ACCOUNTS = 50000;
const DEFAULT_MAX_SUB2API_DEDUPE_IDS = 5000;
const DEFAULT_ABSOLUTE_MAX_SUB2API_DEDUPE_IDS = 10000;
const HARD_MAX_SUB2API_DEDUPE_IDS = 50000;

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

/** 代理 id→key 映射缓存 TTL：默认 30 分钟，覆盖大批量多批上传；可用 PROXY_MAP_CACHE_TTL_SECONDS 覆盖 */
const DEFAULT_PROXY_MAP_CACHE_TTL_SECONDS = 1800;
const MIN_PROXY_MAP_CACHE_TTL_SECONDS = 60;
const MAX_PROXY_MAP_CACHE_TTL_SECONDS = 86400;

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
      return jsonResponse(
        { ok: false, code: "AUTH_REQUIRED", error: "登录状态已失效，请重新登录" },
        401
      );
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
      throw new HttpError(400, "accounts 必须是非空数组", "INVALID_PAYLOAD");
    }
    if (accounts.length > maxAccounts) {
      throw new HttpError(400, `单批最多上传 ${maxAccounts} 个 SUB2API 账号`, "BATCH_TOO_LARGE");
    }
    // 仅从 body.config 读取覆盖配置，避免把 accounts/files 误当配置源
    const override = extractConfigOverride(body?.config);
    const maxAttempts = resolveRequestedAttempts(
      body?.maxAttempts,
      maxSub2apiUploadAttempts(env),
      DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS
    );
    const retryAmbiguous = body?.retryAmbiguous === true;
    const result = await uploadSub2api(
      env,
      accounts,
      Boolean(body?.skipDefaultGroupBind),
      request.signal,
      override,
      maxAttempts,
      retryAmbiguous
    );
    return jsonResponse({ ok: true, target: "SUB2API", count: accounts.length, ...result });
  }

  // 拉取 SUB2API 代理 id 列表；refresh=true 时强制刷新内存/KV 缓存
  if (url.pathname === "/api/sub2api/proxies" && request.method === "POST") {
    const body = await readJsonBody(request, 32 * 1024);
    const override = extractConfigOverride(body?.config ?? body);
    const forceRefresh = body?.refresh === true || body?.forceRefresh === true;
    const result = await listSub2apiProxies(env, override, request.signal, {
      forceRefresh,
    });
    return jsonResponse({ ok: true, target: "SUB2API", ...result });
  }

  // 扫描 SUB2API 同邮箱/名称重复账号（仅预览，不删除）
  if (url.pathname === "/api/sub2api/dedupe/scan" && request.method === "POST") {
    const body = await readJsonBody(request, 32 * 1024);
    const override = extractConfigOverride(body?.config ?? body);
    const result = await scanSub2apiDuplicates(env, override, request.signal);
    return jsonResponse({ ok: true, target: "SUB2API", ...result });
  }

  // 按确认后的账号 ID 列表并发删除 SUB2API 重复账号
  if (url.pathname === "/api/sub2api/dedupe/apply" && request.method === "POST") {
    const body = await readJsonBody(request, 2 * 1024 * 1024);
    const override = extractConfigOverride(body?.config ?? body);
    const ids = body?.ids ?? body?.accountIds ?? body?.account_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new HttpError(400, "ids 必须是非空数组", "INVALID_PAYLOAD");
    }
    const maxDedupeIds = maxSub2apiDedupeIds(env);
    if (ids.length > maxDedupeIds) {
      throw new HttpError(400, `单次最多删除 ${maxDedupeIds} 个账号`, "BATCH_TOO_LARGE");
    }
    const result = await applySub2apiDedupe(env, ids, override, request.signal);
    return jsonResponse({
      ok: result.failedCount === 0,
      target: "SUB2API",
      ...result,
    });
  }

  if (url.pathname === "/api/upload/cpa" && request.method === "POST") {
    const body = await readJsonBody(request, 20 * 1024 * 1024);
    const files = body?.files;
    const maxFiles = maxCpaFiles(env);
    if (!Array.isArray(files) || files.length === 0) {
      throw new HttpError(400, "files 必须是非空数组", "INVALID_PAYLOAD");
    }
    if (files.length > maxFiles) {
      throw new HttpError(400, `单批最多上传 ${maxFiles} 个 CPA 账号`, "BATCH_TOO_LARGE");
    }
    const override = extractConfigOverride(body?.config);
    const maxAttempts = resolveRequestedAttempts(
      body?.maxAttempts,
      maxCpaUploadAttempts(env),
      DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS
    );
    const results = await uploadCpaFiles(env, files, request.signal, override, maxAttempts);
    return jsonResponse({
      ok: results.every((item) => item.ok),
      target: "CPA",
      results,
    });
  }

  // 列出 CPA 远端认证文件元数据
  if (url.pathname === "/api/cpa/auth-files/list" && request.method === "POST") {
    const body = await readJsonBody(request, 32 * 1024);
    const override = extractConfigOverride(body?.config ?? body);
    const result = await listCpaAuthFiles(env, override, request.signal);
    return jsonResponse({ ok: true, target: "CPA", ...result });
  }

  // 按文件名批量下载 CPA 认证文件正文
  if (url.pathname === "/api/cpa/auth-files/download" && request.method === "POST") {
    const body = await readJsonBody(request, 2 * 1024 * 1024);
    const override = extractConfigOverride(body?.config ?? body);
    const names = body?.names ?? body?.files ?? body?.fileNames;
    if (!Array.isArray(names) || names.length === 0) {
      throw new HttpError(400, "names 必须是非空数组", "INVALID_PAYLOAD");
    }
    const maxDownload = maxCpaAuthDownloadFiles(env);
    if (names.length > maxDownload) {
      throw new HttpError(400, `单次最多下载 ${maxDownload} 个 CPA 认证文件`, "BATCH_TOO_LARGE");
    }
    const result = await downloadCpaAuthFiles(env, names, override, request.signal);
    return jsonResponse({
      ok: result.failedCount === 0,
      target: "CPA",
      ...result,
    });
  }

  // 列出 SUB2API 账号元数据，供远端导出勾选
  if (url.pathname === "/api/sub2api/accounts/list" && request.method === "POST") {
    const body = await readJsonBody(request, 32 * 1024);
    const override = extractConfigOverride(body?.config ?? body);
    const result = await listSub2apiAccountsMeta(env, override, request.signal);
    return jsonResponse({ ok: true, target: "SUB2API", ...result });
  }

  // 导出选中 SUB2API 账号为可再导入的合并包
  if (url.pathname === "/api/sub2api/accounts/export" && request.method === "POST") {
    const body = await readJsonBody(request, 2 * 1024 * 1024);
    const override = extractConfigOverride(body?.config ?? body);
    const ids = body?.ids ?? body?.accountIds ?? body?.account_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new HttpError(400, "ids 必须是非空数组", "INVALID_PAYLOAD");
    }
    const maxExport = maxSub2apiExportAccounts(env);
    if (ids.length > maxExport) {
      throw new HttpError(400, `单次最多导出 ${maxExport} 个 SUB2API 账号`, "BATCH_TOO_LARGE");
    }
    const result = await exportSub2apiAccounts(env, ids, override, request.signal);
    return jsonResponse({ ok: true, target: "SUB2API", ...result });
  }

  throw new HttpError(404, "API 路径不存在", "NOT_FOUND");
}

function getAccessSetupProblem(env) {
  const missing = [];
  if (!String(env.APP_PASSWORD || "").trim()) missing.push("APP_PASSWORD");
  if (!String(env.SESSION_SECRET || "").trim()) missing.push("SESSION_SECRET");
  if (missing.length) {
    return `Worker 尚未配置访问控制密钥：${missing.join(", ")}，请在 Cloudflare Worker 的 Settings → Variables and Secrets 中以 Secret 类型添加`;
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
      error: `内置配置错误：${label} 默认绝对上限 ${defaultAbsolute} 小于默认上限 ${defaultMax}`,
    };
  }

  if (absFound) {
    const parsed = parsePositiveIntText(absFound.raw, { min: 1, max: hardMax });
    if (parsed == null) {
      return {
        error: `${absFound.key} 必须是 1 至 ${hardMax} 的正整数，当前值无效：${absFound.raw}`,
      };
    }
    if (parsed < defaultMax) {
      return {
        error: `${absFound.key}=${parsed} 无效，绝对上限必须 ≥ 默认上限 ${defaultMax}，该值为未设置 MAX_* 时的回退值`,
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
    return `${found.key}=${parsed} 超过 ${label} 绝对上限 ${absolute}，请调低该值或提高对应的 ABSOLUTE_MAX_*`;
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
      spec.label
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
    {
      label: "CPA 远端认证文件单次下载数",
      defaultMax: DEFAULT_MAX_CPA_AUTH_DOWNLOAD_FILES,
      defaultAbsolute: DEFAULT_ABSOLUTE_MAX_CPA_AUTH_DOWNLOAD_FILES,
      hardMax: HARD_MAX_CPA_AUTH_DOWNLOAD_FILES,
      maxKeys: ["MAX_CPA_AUTH_DOWNLOAD_FILES", "MAX_CPA_DOWNLOAD_FILES"],
      absoluteKeys: ["ABSOLUTE_MAX_CPA_AUTH_DOWNLOAD_FILES", "ABSOLUTE_MAX_CPA_DOWNLOAD_FILES"],
    },
    {
      label: "SUB2API 远端单次导出账号数",
      defaultMax: DEFAULT_MAX_SUB2API_EXPORT_ACCOUNTS,
      defaultAbsolute: DEFAULT_ABSOLUTE_MAX_SUB2API_EXPORT_ACCOUNTS,
      hardMax: HARD_MAX_SUB2API_EXPORT_ACCOUNTS,
      maxKeys: ["MAX_SUB2API_EXPORT_ACCOUNTS"],
      absoluteKeys: ["ABSOLUTE_MAX_SUB2API_EXPORT_ACCOUNTS"],
    },
    {
      label: "SUB2API 单次去重删除数",
      defaultMax: DEFAULT_MAX_SUB2API_DEDUPE_IDS,
      defaultAbsolute: DEFAULT_ABSOLUTE_MAX_SUB2API_DEDUPE_IDS,
      hardMax: HARD_MAX_SUB2API_DEDUPE_IDS,
      maxKeys: ["MAX_SUB2API_DEDUPE_IDS", "MAX_SUB2API_DEDUPE_ACCOUNTS"],
      absoluteKeys: ["ABSOLUTE_MAX_SUB2API_DEDUPE_IDS", "ABSOLUTE_MAX_SUB2API_DEDUPE_ACCOUNTS"],
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
    spec.label
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
  const proxyCacheTtl = resolveProxyMapCacheTtlSeconds(env);
  return {
    maxSub2apiAccounts: resolved[0].value,
    maxCpaFiles: resolved[1].value,
    maxUploadConcurrencySub2api: resolved[2].value,
    maxUploadConcurrencyCpa: resolved[3].value,
    maxSub2apiUploadAttempts: resolved[4].value,
    maxCpaUploadAttempts: resolved[5].value,
    maxCpaAuthDownloadFiles: resolved[6].value,
    maxSub2apiExportAccounts: resolved[7].value,
    maxSub2apiDedupeIds: resolved[8].value,
    proxyMapCacheTtlSeconds: proxyCacheTtl,
    proxyCacheKvBound: Boolean(getProxyCacheKv(env)),
    // 诊断：确认 Worker 实际读到了哪些 MAX_*/ABSOLUTE_MAX_*（不含密钥）
    resolvedFrom: {
      maxSub2apiAccounts: resolved[0].fromEnv ? resolved[0].maxKey : "default",
      maxCpaFiles: resolved[1].fromEnv ? resolved[1].maxKey : "default",
      maxUploadConcurrencySub2api: resolved[2].fromEnv ? resolved[2].maxKey : "default",
      maxUploadConcurrencyCpa: resolved[3].fromEnv ? resolved[3].maxKey : "default",
      maxSub2apiUploadAttempts: resolved[4].fromEnv ? resolved[4].maxKey : "default",
      maxCpaUploadAttempts: resolved[5].fromEnv ? resolved[5].maxKey : "default",
      maxCpaAuthDownloadFiles: resolved[6].fromEnv ? resolved[6].maxKey : "default",
      maxSub2apiExportAccounts: resolved[7].fromEnv ? resolved[7].maxKey : "default",
      maxSub2apiDedupeIds: resolved[8].fromEnv ? resolved[8].maxKey : "default",
      proxyMapCacheTtlSeconds: firstEnv(env, "PROXY_MAP_CACHE_TTL_SECONDS")
        ? "PROXY_MAP_CACHE_TTL_SECONDS"
        : "default",
    },
    envSeen: {
      MAX_SUB2API_ACCOUNTS: resolved[0].maxRaw,
      MAX_CPA_FILES: resolved[1].maxRaw,
      MAX_UPLOAD_CONCURRENCY_SUB2API: resolved[2].maxRaw,
      MAX_UPLOAD_CONCURRENCY_CPA: resolved[3].maxRaw,
      MAX_SUB2API_UPLOAD_ATTEMPTS: resolved[4].maxRaw,
      MAX_CPA_UPLOAD_ATTEMPTS: resolved[5].maxRaw,
      MAX_CPA_AUTH_DOWNLOAD_FILES: resolved[6].maxRaw,
      MAX_SUB2API_EXPORT_ACCOUNTS: resolved[7].maxRaw,
      MAX_SUB2API_DEDUPE_IDS: resolved[8].maxRaw,
      ABSOLUTE_MAX_SUB2API_ACCOUNTS: resolved[0].absoluteRaw,
      ABSOLUTE_MAX_CPA_FILES: resolved[1].absoluteRaw,
      ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API: resolved[2].absoluteRaw,
      ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA: resolved[3].absoluteRaw,
      ABSOLUTE_MAX_SUB2API_UPLOAD_ATTEMPTS:
        firstEnv(env, "ABSOLUTE_MAX_SUB2API_UPLOAD_ATTEMPTS")?.raw || null,
      ABSOLUTE_MAX_CPA_UPLOAD_ATTEMPTS:
        firstEnv(env, "ABSOLUTE_MAX_CPA_UPLOAD_ATTEMPTS")?.raw || null,
      ABSOLUTE_MAX_UPLOAD_ATTEMPTS: firstEnv(env, "ABSOLUTE_MAX_UPLOAD_ATTEMPTS")?.raw || null,
      ABSOLUTE_MAX_CPA_AUTH_DOWNLOAD_FILES: resolved[6].absoluteRaw,
      ABSOLUTE_MAX_SUB2API_EXPORT_ACCOUNTS: resolved[7].absoluteRaw,
      ABSOLUTE_MAX_SUB2API_DEDUPE_IDS: resolved[8].absoluteRaw,
      PROXY_MAP_CACHE_TTL_SECONDS: firstEnv(env, "PROXY_MAP_CACHE_TTL_SECONDS")?.raw || null,
    },
  };
}

function maxSub2apiAccounts(env) {
  return resolveLimit(env, limitSpecs()[0]);
}

function maxCpaFiles(env) {
  return resolveLimit(env, limitSpecs()[1]);
}

function maxCpaAuthDownloadFiles(env) {
  return resolveLimit(env, limitSpecs()[6]);
}

function maxSub2apiExportAccounts(env) {
  return resolveLimit(env, limitSpecs()[7]);
}

function maxSub2apiDedupeIds(env) {
  return resolveLimit(env, limitSpecs()[8]);
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
  if (request.method !== "POST")
    throw new HttpError(405, "Method Not Allowed", "METHOD_NOT_ALLOWED");

  // 登录请求不做严格 Origin 比对。Cloudflare Dashboard/Preview、自定义域名
  // 或边缘代理可能使浏览器的 Origin 与 Worker 看到的 request.url 不完全一致，
  // 从而误判为跨站。登录仍受访问密码、失败延迟和后续 SameSite 会话 Cookie 保护。
  const contentType = request.headers.get("content-type") || "";
  let password;
  if (contentType.includes("application/json")) {
    const body = await readJsonBody(request, 16 * 1024);
    password = String(body?.password || "");
  } else {
    const form = await request.formData();
    password = String(form.get("password") || "");
  }

  if (!constantTimeEqual(password, String(env.APP_PASSWORD))) {
    await sleep(650);
    return htmlResponse(renderLoginPage("访问密码不正确"), 401);
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
    ["sign"]
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
  const base64 =
    value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name)
      return decodeURIComponent(part.slice(index + 1).trim());
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
    throw new HttpError(403, "拒绝跨站请求", "CROSS_SITE_REQUEST");
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
        throw new HttpError(403, "拒绝跨站请求", "CROSS_SITE_REQUEST");
      }
      if (parsedOrigin !== new URL(request.url).origin) {
        throw new HttpError(403, "拒绝跨站请求", "CROSS_SITE_REQUEST");
      }
    }
  }
}

function normalizeTarget(value) {
  const target = String(value || "").toUpperCase();
  if (target !== "SUB2API" && target !== "CPA") {
    throw new HttpError(400, "target 必须是 SUB2API 或 CPA", "INVALID_TARGET");
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
  const cpaAuthMode =
    cpaAuthModeRaw == null || String(cpaAuthModeRaw).trim() === ""
      ? undefined
      : String(cpaAuthModeRaw).trim();

  // 原子覆盖：必须同时提供地址和密钥；只给一半时忽略，回退 env。
  if (!baseUrl && !apiKey && cpaAuthMode === undefined) return null;
  if (!baseUrl || !apiKey) {
    throw new HttpError(
      400,
      "自定义配置必须同时提供 baseUrl 和 apiKey，否则请省略以使用 Worker 环境变量",
      "INVALID_CONFIG_OVERRIDE"
    );
  }
  if (baseUrl.length > MAX_OVERRIDE_BASE_URL_LENGTH) {
    throw new HttpError(400, "baseUrl 过长", "INVALID_CONFIG_OVERRIDE");
  }
  if (apiKey.length > MAX_OVERRIDE_API_KEY_LENGTH) {
    throw new HttpError(400, "apiKey 过长", "INVALID_CONFIG_OVERRIDE");
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
      `${target} 尚未配置，请在页面填写服务器地址和密钥，或在 Worker 环境变量中设置：${missing.join(", ")}`,
      "TARGET_NOT_CONFIGURED",
      { target, missing }
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
        override.cpaAuthMode !== undefined ? override.cpaAuthMode : env.CPA_AUTH_MODE
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
    throw new HttpError(503, `${target} 服务器地址无效`, "INVALID_BASE_URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new HttpError(503, `${target} 服务器地址仅支持 HTTP/HTTPS`, "INVALID_BASE_URL");
  }
  if (
    url.protocol !== "https:" &&
    String(env.ALLOW_INSECURE_UPSTREAM || "").toLowerCase() !== "true"
  ) {
    throw new HttpError(
      503,
      `${target} 服务器地址必须使用 HTTPS，确需 HTTP 时设置 ALLOW_INSECURE_UPSTREAM=true`,
      "INSECURE_UPSTREAM"
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
    const result = await sub2apiRequest(
      config,
      "/api/v1/admin/accounts?page=1&page_size=1&lite=1",
      {
        method: "GET",
      },
      VERIFY_TIMEOUT_MS,
      1
    );
    return {
      baseUrl: config.baseUrl,
      source: config.source,
      message: "SUB2API 管理接口验证成功",
      attempts: result.attempts,
    };
  }

  const result = await cpaRequest(
    config,
    "/v0/management/auth-files",
    { method: "GET" },
    VERIFY_TIMEOUT_MS,
    1
  );
  if (!result.data || !Array.isArray(result.data.files)) {
    throw new HttpError(502, "CPA 返回了非预期的管理接口响应", "INVALID_UPSTREAM_RESPONSE");
  }
  return {
    baseUrl: config.baseUrl,
    source: config.source,
    message: "CPA 管理接口验证成功",
    authMode: result.authMode,
    attempts: result.attempts,
  };
}

function extractProxyEntries(payload) {
  const root = payload?.data !== undefined ? payload.data : payload;
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== "object") return [];
  if (Array.isArray(root.proxies)) return root.proxies;
  if (Array.isArray(root.items)) return root.items;
  if (Array.isArray(root.list)) return root.list;
  if (Array.isArray(root.records)) return root.records;
  if (Array.isArray(root.ids)) return root.ids;
  return [];
}

/**
 * 与 SUB2API 官方 buildProxyKey 一致：
 * protocol|host|port|username|password（仅 TrimSpace，不转小写）
 */
function buildProxyKey(protocol, host, port, username, password) {
  const p = String(protocol ?? "").trim();
  const h = String(host ?? "").trim();
  const u = String(username ?? "").trim();
  const pw = String(password ?? "").trim();
  const portNum = Number(port);
  const portPart = Number.isFinite(portNum)
    ? String(Math.trunc(portNum))
    : String(port ?? "").trim();
  return `${p}|${h}|${portPart}|${u}|${pw}`;
}

function parseLocalProxyId(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * 从 SUB2API proxies/all 响应构建本产品代理映射。
 * proxy_id：沿用 SUB2API 的 id，供前端填写/校验
 * proxy_key：仅在 Worker 内存中用于导入时 id→key 换算，不下发给浏览器
 */
function buildLocalProxyMap(payload) {
  const proxyIds = [];
  const idToKey = new Map();
  const seenIds = new Set();

  for (const entry of extractProxyEntries(payload)) {
    if (entry == null) continue;

    // 纯数字条目：仅有 id，无法生成有效 key，跳过
    if (typeof entry !== "object") {
      continue;
    }

    const id = parseLocalProxyId(entry.id ?? entry.proxy_id ?? entry.proxyId);
    if (id == null || seenIds.has(id)) continue;

    const protocol = entry.protocol ?? entry.scheme ?? "";
    const host = entry.host ?? entry.hostname ?? "";
    const port = entry.port;
    const username = entry.username ?? entry.user ?? "";
    const password = entry.password ?? entry.pass ?? "";

    // 无连接信息时无法生成可匹配的 key
    if (!String(protocol).trim() && !String(host).trim()) continue;

    const proxyKey = buildProxyKey(protocol, host, port, username, password);
    seenIds.add(id);
    idToKey.set(id, proxyKey);
    proxyIds.push(id);
  }

  return { proxyIds, idToKey };
}

/**
 * 将账号上的本产品 proxy_id 转为 SUB2API 导入所需的 proxy_key。
 * 官方 import-data 只认 proxy_key，不认 proxy_id。
 */
function rewriteAccountsProxyIdToKey(accounts, idToKey) {
  if (!Array.isArray(accounts)) return [];
  return accounts.map((raw) => {
    const account = raw && typeof raw === "object" ? { ...raw } : raw;
    if (!account || typeof account !== "object") return account;

    const localId = parseLocalProxyId(account.proxy_id ?? account.proxyId ?? null);
    delete account.proxy_id;
    delete account.proxyId;
    // 若前端误带了旧 key，先清掉，统一由本产品 id 映射
    delete account.proxy_key;
    delete account.proxyKey;

    if (localId != null && idToKey.has(localId)) {
      account.proxy_key = idToKey.get(localId);
    }
    return account;
  });
}

/**
 * 代理 id→key 分层缓存：
 * 1) 同 isolate 内存（最快）
 * 2) 可选 Cloudflare KV（跨 isolate / 跨 POP 共享）
 * 3) 上游 proxies/all
 * proxy_key 只存在于 Worker 侧缓存，不下发浏览器。
 */
/** @type {Map<string, { expiresAt: number, proxyIds: number[], entries: Array<[number, string]>, attempts: number, inflight: Promise<any>|null }>} */
const proxyMapMemoryCache = new Map();

function resolveProxyMapCacheTtlSeconds(env) {
  const found = firstEnv(env, "PROXY_MAP_CACHE_TTL_SECONDS");
  if (!found) return DEFAULT_PROXY_MAP_CACHE_TTL_SECONDS;
  const parsed = parsePositiveIntText(found.raw, {
    min: MIN_PROXY_MAP_CACHE_TTL_SECONDS,
    max: MAX_PROXY_MAP_CACHE_TTL_SECONDS,
  });
  return parsed == null ? DEFAULT_PROXY_MAP_CACHE_TTL_SECONDS : parsed;
}

/** 绑定名 PROXY_CACHE_KV 或 PROXY_MAP_KV；未绑定则返回 null，回落内存缓存 */
function getProxyCacheKv(env) {
  if (!env) return null;
  const kv = env.PROXY_CACHE_KV || env.PROXY_MAP_KV || null;
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") return null;
  return kv;
}

function proxyMapCacheKey(config) {
  const base = String(config?.baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
  const key = String(config?.apiKey || "");
  // 不把完整密钥写入缓存键；长度 + 首尾片段足以区分本机不同配置
  const fp = `${key.length}:${key.slice(0, 6)}:${key.slice(-6)}`;
  return `${base}|${fp}`;
}

function proxyMapKvKey(cacheKey) {
  // KV key 安全字符；完整 apiKey 不入 key
  return `proxy-map:v1:${cacheKey}`;
}

function memoryHitToResult(entry, source = "memory") {
  return {
    proxyIds: entry.proxyIds,
    idToKey: new Map(entry.entries),
    attempts: 0,
    cacheHit: true,
    cacheSource: source,
  };
}

function readProxyMapMemory(cacheKey) {
  const entry = proxyMapMemoryCache.get(cacheKey);
  if (!entry?.entries || !(entry.expiresAt > Date.now())) return null;
  return memoryHitToResult(entry, "memory");
}

function storeProxyMapMemory(cacheKey, mapped, ttlSeconds) {
  const entries =
    mapped.entries ||
    (mapped.idToKey instanceof Map
      ? Array.from(mapped.idToKey.entries())
      : Object.entries(mapped.idToKey || {}).map(([k, v]) => [Number(k), String(v)]));
  proxyMapMemoryCache.set(cacheKey, {
    expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000,
    proxyIds: Array.isArray(mapped.proxyIds) ? mapped.proxyIds : entries.map(([id]) => id),
    entries,
    attempts: mapped.attempts || 0,
    inflight: null,
  });
}

function clearProxyMapMemory(cacheKey) {
  if (cacheKey) proxyMapMemoryCache.delete(cacheKey);
  else proxyMapMemoryCache.clear();
}

async function readProxyMapKv(kv, cacheKey) {
  if (!kv) return null;
  try {
    const raw = await kv.get(proxyMapKvKey(cacheKey), "json");
    if (!raw || typeof raw !== "object") return null;
    const expiresAt = Number(raw.expiresAt) || 0;
    if (!(expiresAt > Date.now())) return null;
    const pairs = Array.isArray(raw.entries) ? raw.entries : [];
    const idToKey = new Map();
    const proxyIds = [];
    const seen = new Set();
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const id = parseLocalProxyId(pair[0]);
      const key = String(pair[1] ?? "");
      if (id == null || !key || seen.has(id)) continue;
      seen.add(id);
      idToKey.set(id, key);
      proxyIds.push(id);
    }
    return {
      proxyIds,
      idToKey,
      attempts: 0,
      cacheHit: true,
      cacheSource: "kv",
      expiresAt,
    };
  } catch (error) {
    console.warn("proxy map KV read failed", error?.message || error);
    return null;
  }
}

async function storeProxyMapKv(kv, cacheKey, mapped, ttlSeconds) {
  if (!kv) return;
  try {
    const entries =
      mapped.entries || (mapped.idToKey instanceof Map ? Array.from(mapped.idToKey.entries()) : []);
    const expiresAt = Date.now() + Math.max(1, ttlSeconds) * 1000;
    await kv.put(
      proxyMapKvKey(cacheKey),
      JSON.stringify({
        v: 1,
        expiresAt,
        proxyIds: mapped.proxyIds || entries.map(([id]) => id),
        entries,
      }),
      { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) }
    );
  } catch (error) {
    console.warn("proxy map KV write failed", error?.message || error);
  }
}

async function clearProxyMapKv(kv, cacheKey) {
  if (!kv || !cacheKey || typeof kv.delete !== "function") return;
  try {
    await kv.delete(proxyMapKvKey(cacheKey));
  } catch (error) {
    console.warn("proxy map KV delete failed", error?.message || error);
  }
}

async function fetchSub2apiProxyIdKeyMap(config, clientSignal = undefined) {
  const result = await sub2apiRequest(
    config,
    "/api/v1/admin/proxies/all",
    { method: "GET" },
    VERIFY_TIMEOUT_MS,
    1,
    clientSignal
  );
  const { proxyIds, idToKey } = buildLocalProxyMap(result.data);
  return {
    proxyIds,
    idToKey,
    entries: Array.from(idToKey.entries()),
    attempts: result.attempts,
  };
}

/**
 * 分层获取代理映射：内存 → KV → 上游。
 * forceRefresh 时跳过两级缓存并回写。
 * 同键 in-flight 合并；共享上游请求不绑定单客户端 AbortSignal。
 */
async function getSub2apiProxyIdKeyMap(
  env,
  config,
  clientSignal = undefined,
  { forceRefresh = false } = {}
) {
  const cacheKey = proxyMapCacheKey(config);
  const ttlSeconds = resolveProxyMapCacheTtlSeconds(env);
  const kv = getProxyCacheKv(env);

  if (forceRefresh) {
    clearProxyMapMemory(cacheKey);
    await clearProxyMapKv(kv, cacheKey);
  } else {
    const mem = readProxyMapMemory(cacheKey);
    if (mem) return mem;

    const fromKv = await readProxyMapKv(kv, cacheKey);
    if (fromKv) {
      // 回填内存，后续同 isolate 批次零延迟
      storeProxyMapMemory(cacheKey, fromKv, ttlSeconds);
      return {
        proxyIds: fromKv.proxyIds,
        idToKey: fromKv.idToKey,
        attempts: 0,
        cacheHit: true,
        cacheSource: "kv",
      };
    }
  }

  const entry = proxyMapMemoryCache.get(cacheKey);
  if (entry?.inflight) {
    return entry.inflight;
  }

  const inflight = (async () => {
    if (!forceRefresh) {
      const againMem = readProxyMapMemory(cacheKey);
      if (againMem) return againMem;
      const againKv = await readProxyMapKv(kv, cacheKey);
      if (againKv) {
        storeProxyMapMemory(cacheKey, againKv, ttlSeconds);
        return {
          proxyIds: againKv.proxyIds,
          idToKey: againKv.idToKey,
          attempts: 0,
          cacheHit: true,
          cacheSource: "kv",
        };
      }
    }

    const mapped = await fetchSub2apiProxyIdKeyMap(config, undefined);
    storeProxyMapMemory(cacheKey, mapped, ttlSeconds);
    // KV 写入失败不影响主路径
    await storeProxyMapKv(kv, cacheKey, mapped, ttlSeconds);
    return {
      proxyIds: mapped.proxyIds,
      idToKey: mapped.idToKey,
      attempts: mapped.attempts,
      cacheHit: false,
      cacheSource: "upstream",
    };
  })();

  proxyMapMemoryCache.set(cacheKey, {
    expiresAt: 0,
    proxyIds: [],
    entries: [],
    attempts: 0,
    inflight,
  });

  try {
    return await inflight;
  } catch (error) {
    const cur = proxyMapMemoryCache.get(cacheKey);
    if (cur?.inflight === inflight) proxyMapMemoryCache.delete(cacheKey);
    if (clientSignal?.aborted) {
      const abortErr = new Error("The operation was aborted.");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    throw error;
  } finally {
    const cur = proxyMapMemoryCache.get(cacheKey);
    if (cur?.inflight === inflight) cur.inflight = null;
  }
}

function accountsNeedProxyMap(accounts) {
  return Array.isArray(accounts)
    ? accounts.some((a) => parseLocalProxyId(a?.proxy_id ?? a?.proxyId) != null)
    : false;
}

/** 仅向前端返回 proxy_id 列表；proxy_key 留在 Worker 内，避免网络泄露 */
async function listSub2apiProxies(
  env,
  override = null,
  clientSignal = undefined,
  { forceRefresh = false } = {}
) {
  const config = resolveTargetConfig(env, "SUB2API", override);
  const mapped = await getSub2apiProxyIdKeyMap(env, config, clientSignal, {
    forceRefresh,
  });
  return {
    baseUrl: config.baseUrl,
    source: config.source,
    attempts: mapped.attempts,
    cacheHit: Boolean(mapped.cacheHit),
    cacheSource: mapped.cacheSource || (mapped.cacheHit ? "unknown" : "upstream"),
    refreshed: Boolean(forceRefresh),
    ttlSeconds: resolveProxyMapCacheTtlSeconds(env),
    kvEnabled: Boolean(getProxyCacheKv(env)),
    count: mapped.proxyIds.length,
    proxyIds: mapped.proxyIds,
  };
}

const DEDUPE_PAGE_SIZE = 200;
const DEDUPE_SCAN_CONCURRENCY = 4;
const DEDUPE_DELETE_CONCURRENCY = 4;
const CPA_DOWNLOAD_CONCURRENCY = 4;
const SUB2API_EXPORT_DETAIL_CONCURRENCY = 8;
const DEDUPE_NORMAL_STATUSES = new Set([
  "active",
  "normal",
  "enabled",
  "ok",
  "running",
  "success",
  "valid",
  "healthy",
  "1",
  "true",
]);

function extractAccountsPageItems(payload) {
  const root = payload?.data !== undefined ? payload.data : payload;
  if (Array.isArray(root)) return { items: root, total: root.length, pages: 1 };
  if (!root || typeof root !== "object") {
    throw new HttpError(502, "SUB2API 账号列表响应无效", "INVALID_UPSTREAM_RESPONSE");
  }
  const items = root.items ?? root.accounts ?? root.list ?? root.records;
  if (!Array.isArray(items)) {
    throw new HttpError(502, "SUB2API 账号列表缺少 items 数组", "INVALID_UPSTREAM_RESPONSE");
  }
  const totalRaw = root.total ?? root.count ?? root.total_count;
  const pagesRaw = root.pages ?? root.page_count ?? root.total_pages;
  const total = Number.isFinite(Number(totalRaw))
    ? Math.max(0, Math.floor(Number(totalRaw)))
    : items.length;
  const pages = Number.isFinite(Number(pagesRaw))
    ? Math.max(1, Math.floor(Number(pagesRaw)))
    : Math.max(1, Math.ceil(total / DEDUPE_PAGE_SIZE) || 1);
  return { items, total, pages };
}

async function fetchSub2apiAccountsPage(config, page, pageSize, clientSignal) {
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    sort_by: "id",
    sort_order: "asc",
    lite: "1",
  });
  const result = await sub2apiRequest(
    config,
    `/api/v1/admin/accounts?${query.toString()}`,
    { method: "GET" },
    VERIFY_TIMEOUT_MS,
    3,
    clientSignal
  );
  const parsed = extractAccountsPageItems(result.data);
  for (const item of parsed.items) {
    if (!item || typeof item !== "object" || item.id == null) {
      throw new HttpError(
        502,
        `SUB2API 账号列表第 ${page} 页存在缺少 id 的记录`,
        "INVALID_UPSTREAM_RESPONSE"
      );
    }
  }
  return { ...parsed, attempts: result.attempts };
}

async function listAllSub2apiAccounts(config, clientSignal) {
  const first = await fetchSub2apiAccountsPage(config, 1, DEDUPE_PAGE_SIZE, clientSignal);
  const expectedTotal = first.total;
  let expectedPages = first.pages;
  if (!expectedPages || expectedPages < 1) {
    expectedPages = Math.max(1, Math.ceil(expectedTotal / DEDUPE_PAGE_SIZE) || 1);
  }
  if (expectedPages > 1_000_000) {
    throw new HttpError(502, "SUB2API 账号分页数量异常，已停止扫描", "INVALID_UPSTREAM_RESPONSE");
  }

  const pages = new Map([[1, first]]);
  let attempts = first.attempts || 1;

  if (expectedPages > 1) {
    const pageNumbers = Array.from({ length: expectedPages - 1 }, (_, i) => i + 2);
    const rest = await mapWithConcurrency(pageNumbers, DEDUPE_SCAN_CONCURRENCY, async (page) => {
      const data = await fetchSub2apiAccountsPage(config, page, DEDUPE_PAGE_SIZE, clientSignal);
      return { page, data };
    });
    for (const entry of rest) {
      pages.set(entry.page, entry.data);
      attempts += entry.data.attempts || 0;
    }
  }

  const allAccounts = [];
  const seenIds = new Set();
  for (let page = 1; page <= expectedPages; page++) {
    const data = pages.get(page);
    if (!data) {
      throw new HttpError(
        502,
        `SUB2API 账号第 ${page} 页缺失，扫描不完整`,
        "INVALID_UPSTREAM_RESPONSE"
      );
    }
    if (data.total !== expectedTotal || data.pages !== expectedPages) {
      // pages 可能因 total 推算与上游不一致；仅在 total 变化时判定为数据漂移
      if (data.total !== expectedTotal) {
        throw new HttpError(
          409,
          `扫描期间账号数据发生变化：第 1 页 total=${expectedTotal}，第 ${page} 页 total=${data.total}，请重试`,
          "SCAN_RACE"
        );
      }
    }
    for (const item of data.items) {
      const marker = String(item.id);
      if (seenIds.has(marker)) {
        throw new HttpError(502, `分页结果重复出现账号 ID=${marker}`, "INVALID_UPSTREAM_RESPONSE");
      }
      seenIds.add(marker);
      allAccounts.push(item);
    }
  }

  if (expectedTotal > 0 && seenIds.size !== expectedTotal) {
    // 部分上游 total 不准时仍返回实际列表，但标注不一致
    console.warn(
      `SUB2API dedupe scan total mismatch: expected=${expectedTotal}, unique=${seenIds.size}`
    );
  }

  allAccounts.sort(compareAccountIdAsc);
  return { accounts: allAccounts, attempts, reportedTotal: expectedTotal };
}

function compareAccountIdAsc(a, b) {
  const av = a?.id;
  const bv = b?.id;
  const an = Number(av);
  const bn = Number(bv);
  const aNum = Number.isFinite(an);
  const bNum = Number.isFinite(bn);
  if (aNum && bNum) return an - bn;
  if (aNum) return -1;
  if (bNum) return 1;
  return String(av).localeCompare(String(bv));
}

function normalizeDedupeEmail(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/** 去重分组键：优先邮箱，其次 name；无标识则不参与去重 */
function accountDedupeKey(account) {
  if (!account || typeof account !== "object") return "";
  const email = normalizeDedupeEmail(
    account.credentials?.email || account.extra?.email || account.email || ""
  );
  if (email) return `email:${email}`;

  const name = String(account.name ?? "").trim();
  if (!name) return "";
  const nameKey = name.toLowerCase();
  if (nameKey.includes("@")) return `email:${nameKey}`;
  return `name:${nameKey}`;
}

function isNormalAccountStatus(status) {
  if (status == null || status === "") return false;
  const raw = String(status).trim().toLowerCase();
  if (DEDUPE_NORMAL_STATUSES.has(raw)) return true;
  // 数字 1 表示正常
  const n = Number(status);
  return Number.isFinite(n) && n === 1;
}

function accountExpiresUnix(account) {
  if (!account || typeof account !== "object") return null;
  const candidates = [
    account.credentials?.expires_at,
    account.expires_at,
    account.expired_at,
    account.expired,
    account.extra?.expires_at,
  ];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      // 兼容毫秒时间戳
      return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
    }
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && String(raw).trim() !== "" && !String(raw).includes("-")) {
      return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
    }
    const text = String(raw).trim();
    const normalized = text.endsWith("Z") ? `${text.slice(0, -1)}+00:00` : text;
    const ms = Date.parse(normalized);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

function summarizeDedupeAccount(account) {
  const email =
    normalizeDedupeEmail(
      account?.credentials?.email || account?.extra?.email || account?.email || ""
    ) ||
    (String(account?.name || "").includes("@") ? normalizeDedupeEmail(account.name) : "") ||
    "";
  return {
    id: account?.id,
    name: account?.name ?? "",
    email,
    platform: account?.platform ?? "",
    type: account?.type ?? "",
    status: account?.status ?? "",
    expiresAt: accountExpiresUnix(account),
    createdAt: account?.created_at ?? account?.createdAt ?? null,
    normal: isNormalAccountStatus(account?.status),
  };
}

/**
 * 保留策略：
 * 1. 优先保留正常状态账号
 * 2. 状态相同时优先保留过期时间较晚者（无过期信息排后）
 * 3. 再按更小 id 保留
 */
function selectDedupeKeeper(members) {
  return members.slice().sort((a, b) => {
    const aNormal = isNormalAccountStatus(a.status) ? 1 : 0;
    const bNormal = isNormalAccountStatus(b.status) ? 1 : 0;
    if (aNormal !== bNormal) return bNormal - aNormal;

    const aExp = accountExpiresUnix(a);
    const bExp = accountExpiresUnix(b);
    const aHas = aExp != null && Number.isFinite(aExp);
    const bHas = bExp != null && Number.isFinite(bExp);
    if (aHas && bHas && aExp !== bExp) return bExp - aExp;
    if (aHas !== bHas) return aHas ? -1 : 1;

    return compareAccountIdAsc(a, b);
  })[0];
}

function buildSub2apiDuplicatePlan(accounts) {
  const groups = new Map();
  for (const account of accounts) {
    const key = accountDedupeKey(account);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }

  const plan = [];
  for (const [key, members] of groups.entries()) {
    if (members.length < 2) continue;
    const keeper = selectDedupeKeeper(members);
    const keepId = String(keeper.id);
    const toDelete = members
      .filter((item) => String(item.id) !== keepId)
      .slice()
      .sort(compareAccountIdAsc);
    plan.push({
      key,
      count: members.length,
      keep: summarizeDedupeAccount(keeper),
      delete: toDelete.map(summarizeDedupeAccount),
      members: members.slice().sort(compareAccountIdAsc).map(summarizeDedupeAccount),
    });
  }

  plan.sort((a, b) => {
    const keyCmp = String(a.key).localeCompare(String(b.key));
    if (keyCmp !== 0) return keyCmp;
    return compareAccountIdAsc(a.keep, b.keep);
  });
  return plan;
}

async function scanSub2apiDuplicates(env, override = null, clientSignal = undefined) {
  const config = resolveTargetConfig(env, "SUB2API", override);
  const listed = await listAllSub2apiAccounts(config, clientSignal);
  const plan = buildSub2apiDuplicatePlan(listed.accounts);
  const plannedDeletionCount = plan.reduce((sum, group) => sum + group.delete.length, 0);
  const accountsInDuplicateGroups = plan.reduce((sum, group) => sum + group.count, 0);
  return {
    baseUrl: config.baseUrl,
    source: config.source,
    attempts: listed.attempts,
    accountCount: listed.accounts.length,
    reportedTotal: listed.reportedTotal,
    duplicateGroupCount: plan.length,
    accountsInDuplicateGroups,
    plannedDeletionCount,
    groups: plan,
  };
}

async function deleteSub2apiAccount(config, accountId, clientSignal) {
  const encodedId = encodeURIComponent(String(accountId));
  try {
    await sub2apiRequest(
      config,
      `/api/v1/admin/accounts/${encodedId}`,
      { method: "DELETE" },
      VERIFY_TIMEOUT_MS,
      3,
      clientSignal,
      { writeOperation: true, retryAmbiguous: false }
    );
    return { status: "deleted", id: accountId };
  } catch (error) {
    if (error?.status === 404) {
      return { status: "already_absent", id: accountId };
    }
    return {
      status: "failed",
      id: accountId,
      error: publicErrorMessage(error),
      httpStatus: error?.status,
      code: error?.code,
    };
  }
}

async function applySub2apiDedupe(env, ids, override = null, clientSignal = undefined) {
  const config = resolveTargetConfig(env, "SUB2API", override);
  const normalizedIds = [];
  const seen = new Set();
  for (const raw of ids) {
    if (raw == null || raw === "") continue;
    const id = typeof raw === "number" || typeof raw === "string" ? raw : String(raw);
    const marker = String(id);
    if (seen.has(marker)) continue;
    seen.add(marker);
    normalizedIds.push(id);
  }
  if (!normalizedIds.length) {
    throw new HttpError(400, "没有可删除的账号 ID", "INVALID_PAYLOAD");
  }

  const results = await mapWithConcurrency(normalizedIds, DEDUPE_DELETE_CONCURRENCY, async (id) =>
    deleteSub2apiAccount(config, id, clientSignal)
  );

  const deletedCount = results.filter((item) => item.status === "deleted").length;
  const alreadyAbsentCount = results.filter((item) => item.status === "already_absent").length;
  const failed = results.filter((item) => item.status === "failed");
  return {
    baseUrl: config.baseUrl,
    source: config.source,
    requestedCount: normalizedIds.length,
    deletedCount,
    alreadyAbsentCount,
    failedCount: failed.length,
    results,
    failures: failed,
  };
}

// ---------------------------------------------------------------------------
// CPA 远端认证文件 list / download
// ---------------------------------------------------------------------------

function pickFirstDefined(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  }
  return undefined;
}

function asBoolFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on", "disabled", "inactive"].includes(value.trim().toLowerCase());
  }
  return false;
}

function normalizeProviderLabel(value) {
  const s = String(value || "")
    .trim()
    .toLowerCase();
  const aliases = {
    "x-ai": "xai",
    grok: "xai",
    openai: "codex",
    chatgpt: "codex",
    google: "gemini",
    anthropic: "claude",
  };
  return aliases[s] || s;
}

function parseCpaAuthFileItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const nameRaw = pickFirstDefined(item, ["name", "file_name", "fileName", "id"]);
  if (nameRaw == null || nameRaw === "") return null;
  const name = String(nameRaw);
  let disabled;
  if ("disabled" in item) {
    disabled = asBoolFlag(item.disabled);
  } else {
    const status = String(pickFirstDefined(item, ["status", "state"]) || "")
      .trim()
      .toLowerCase();
    disabled = status === "disabled" || status === "inactive";
  }
  return {
    name,
    id: String(pickFirstDefined(item, ["id"]) || ""),
    authIndex: String(pickFirstDefined(item, ["auth_index", "authIndex", "auth-index"]) || ""),
    provider: normalizeProviderLabel(pickFirstDefined(item, ["provider", "type"])),
    account: String(
      pickFirstDefined(item, ["account", "email", "display_account", "displayAccount"]) || ""
    ),
    accountId: String(
      pickFirstDefined(item, [
        "account_id",
        "accountId",
        "chatgpt_account_id",
        "project_id",
        "sub",
      ]) || ""
    ),
    disabled,
  };
}

function parseCpaAuthFilesListPayload(data) {
  let items;
  if (Array.isArray(data)) {
    items = data;
  } else if (data && typeof data === "object") {
    let nested = null;
    for (const key of ["auth_files", "authFiles", "files", "items", "data"]) {
      if (Array.isArray(data[key])) {
        nested = data[key];
        break;
      }
    }
    if (nested) {
      items = nested;
    } else if (pickFirstDefined(data, ["name", "file_name", "fileName", "id"]) != null) {
      items = [data];
    } else {
      const maybe = [];
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          maybe.push({ ...v, name: v.name || k });
        } else if (v === true || v == null || typeof v === "string") {
          maybe.push({ name: k });
        }
      }
      items = maybe;
    }
  } else {
    throw new HttpError(502, "CPA 返回了非预期的认证文件列表", "INVALID_UPSTREAM_RESPONSE");
  }

  const files = [];
  const seen = new Set();
  for (const item of items) {
    const parsed = parseCpaAuthFileItem(item);
    if (!parsed || !parsed.name || seen.has(parsed.name)) continue;
    seen.add(parsed.name);
    files.push(parsed);
  }
  files.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return files;
}

async function listCpaAuthFiles(env, override = null, clientSignal = undefined) {
  const config = resolveTargetConfig(env, "CPA", override);
  const result = await cpaRequest(
    config,
    "/v0/management/auth-files",
    { method: "GET" },
    VERIFY_TIMEOUT_MS,
    3,
    clientSignal
  );
  const files = parseCpaAuthFilesListPayload(result.data);
  return {
    baseUrl: config.baseUrl,
    source: config.source,
    authMode: result.authMode,
    attempts: result.attempts,
    count: files.length,
    files,
  };
}

async function downloadOneCpaAuthFile(config, fileName, clientSignal) {
  const safeName = sanitizeJsonFilename(fileName);
  const path = `/v0/management/auth-files/download?name=${encodeURIComponent(safeName)}`;
  try {
    const result = await cpaRequestRaw(
      config,
      path,
      { method: "GET" },
      UPSTREAM_TIMEOUT_MS,
      3,
      clientSignal
    );
    let content = result.data;
    // 若上游包了一层 { raw }，尽量还原
    if (
      content &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      typeof content.raw === "string" &&
      Object.keys(content).length === 1
    ) {
      try {
        content = JSON.parse(content.raw);
      } catch {
        content = content.raw;
      }
    }
    return {
      name: safeName,
      ok: true,
      content,
      attempts: result.attempts,
      authMode: result.authMode,
    };
  } catch (error) {
    return {
      name: safeName,
      ok: false,
      error: publicErrorMessage(error),
      status: error?.status,
      code: error?.code,
      attempts: error?.attempts || 1,
    };
  }
}

async function downloadCpaAuthFiles(env, names, override = null, clientSignal = undefined) {
  const config = resolveTargetConfig(env, "CPA", override);
  const normalized = [];
  const seen = new Set();
  for (const raw of names) {
    if (raw == null || raw === "") continue;
    const name = sanitizeJsonFilename(String(raw));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  if (!normalized.length) {
    throw new HttpError(400, "没有可下载的认证文件名", "INVALID_PAYLOAD");
  }

  const files = await mapWithConcurrency(normalized, CPA_DOWNLOAD_CONCURRENCY, (name) =>
    downloadOneCpaAuthFile(config, name, clientSignal)
  );
  const okCount = files.filter((item) => item.ok).length;
  const failedCount = files.length - okCount;
  return {
    baseUrl: config.baseUrl,
    source: config.source,
    requestedCount: normalized.length,
    okCount,
    failedCount,
    files,
  };
}

// ---------------------------------------------------------------------------
// SUB2API 远端账号 list / export
// ---------------------------------------------------------------------------

function nonEmptyText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function credentialsObjectLooksUsable(cred) {
  if (!cred || typeof cred !== "object" || Array.isArray(cred)) return false;
  const keys = [
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "id_token",
    "idToken",
    "session_token",
    "sessionToken",
    "session_key",
    "sessionKey",
    "api_key",
    "apiKey",
    "token",
    "cookie",
    "cookies",
    "password",
    "secret",
  ];
  for (const key of keys) {
    if (nonEmptyText(cred[key])) return true;
  }
  // 任意非空字符串字段也视为可用（兼容自定义 type）
  for (const value of Object.values(cred)) {
    if (typeof value === "string" && value.trim()) return true;
  }
  return false;
}

function accountHasUsableCredentials(account) {
  if (!account || typeof account !== "object") return false;
  if (credentialsObjectLooksUsable(account.credentials)) return true;
  if (credentialsObjectLooksUsable(account.credential)) return true;
  if (credentialsObjectLooksUsable(account.auth)) return true;
  if (credentialsObjectLooksUsable(account.token)) return true;
  // 顶层扁平字段
  const flatKeys = [
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "id_token",
    "idToken",
    "session_token",
    "sessionToken",
    "api_key",
    "apiKey",
    "token",
    "cookie",
  ];
  for (const key of flatKeys) {
    if (nonEmptyText(account[key])) return true;
  }
  // extra 内偶发存放 token
  if (credentialsObjectLooksUsable(account.extra)) return true;
  return false;
}

function normalizeExportCredentials(account) {
  if (!account || typeof account !== "object") return {};
  if (account.credentials && typeof account.credentials === "object") {
    return { ...account.credentials };
  }
  if (account.credential && typeof account.credential === "object") {
    return { ...account.credential };
  }
  if (account.auth && typeof account.auth === "object") {
    return { ...account.auth };
  }
  const cred = {};
  const map = [
    ["access_token", ["access_token", "accessToken"]],
    ["refresh_token", ["refresh_token", "refreshToken"]],
    ["id_token", ["id_token", "idToken"]],
    ["api_key", ["api_key", "apiKey"]],
    ["token", ["token"]],
    ["cookie", ["cookie", "cookies"]],
    ["session_token", ["session_token", "sessionToken"]],
  ];
  for (const [target, sources] of map) {
    for (const source of sources) {
      const text = nonEmptyText(account[source]);
      if (text) {
        cred[target] = text;
        break;
      }
    }
  }
  return cred;
}

/** 导出用：尽量去掉服务端只读字段，保留可再导入的账号正文 */
function sanitizeSub2apiExportAccount(account) {
  if (!account || typeof account !== "object") return null;
  const out = { ...account };
  // 导入包通常不需要服务端 id / 时间戳；保留也不影响多数导入实现，这里去掉以贴近本机导出
  delete out.id;
  delete out.created_at;
  delete out.createdAt;
  delete out.updated_at;
  delete out.updatedAt;
  delete out.user_id;
  delete out.userId;
  delete out.group_id;
  delete out.groupId;
  // proxy_key 仅 Worker 内部使用；若有 proxy_id 留给前端/再导入
  delete out.proxy_key;
  delete out.proxyKey;
  delete out.credential;
  delete out.auth;
  if (!out.type) out.type = "oauth";
  out.credentials = normalizeExportCredentials(account);
  if (!out.extra || typeof out.extra !== "object") out.extra = {};
  if (out.concurrency == null) out.concurrency = 1;
  if (out.priority == null) out.priority = 1;
  if (out.rate_multiplier == null) out.rate_multiplier = 1;
  if (out.auto_pause_on_expired == null) out.auto_pause_on_expired = true;
  return out;
}

function unwrapSub2apiAccountDetail(payload) {
  let root = payload;
  // 常见：{ data: account } / { data: { account } } / { account }
  for (let depth = 0; depth < 4; depth++) {
    if (!root || typeof root !== "object" || Array.isArray(root)) break;
    if (root.account && typeof root.account === "object" && !Array.isArray(root.account)) {
      root = root.account;
      continue;
    }
    if (root.data !== undefined) {
      root = root.data;
      continue;
    }
    if (root.item && typeof root.item === "object") {
      root = root.item;
      continue;
    }
    if (root.result && typeof root.result === "object") {
      root = root.result;
      continue;
    }
    break;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  if (
    root.id != null ||
    root.credentials ||
    root.credential ||
    root.auth ||
    root.platform ||
    root.type ||
    root.access_token ||
    root.accessToken ||
    root.refresh_token ||
    root.refreshToken ||
    root.api_key ||
    root.apiKey
  ) {
    return root;
  }
  return null;
}

async function fetchSub2apiAccountDetail(config, accountId, clientSignal) {
  const encodedId = encodeURIComponent(String(accountId));
  const result = await sub2apiRequest(
    config,
    `/api/v1/admin/accounts/${encodedId}`,
    { method: "GET" },
    // 详情请求不宜用 30s 校验超时；大批量时上游偶发变慢
    Math.max(VERIFY_TIMEOUT_MS, 60 * 1000),
    2,
    clientSignal
  );
  const account = unwrapSub2apiAccountDetail(result.data);
  if (!account) {
    throw new HttpError(502, `SUB2API 账号 ${accountId} 详情响应无效`, "INVALID_UPSTREAM_RESPONSE");
  }
  return { account, attempts: result.attempts };
}

async function listSub2apiAccountsMeta(env, override = null, clientSignal = undefined) {
  const config = resolveTargetConfig(env, "SUB2API", override);
  const listed = await listAllSub2apiAccounts(config, clientSignal);
  const accounts = listed.accounts.map((account) => summarizeDedupeAccount(account));
  return {
    baseUrl: config.baseUrl,
    source: config.source,
    attempts: listed.attempts,
    count: accounts.length,
    reportedTotal: listed.reportedTotal,
    accounts,
  };
}

async function exportSub2apiAccounts(env, ids, override = null, clientSignal = undefined) {
  const config = resolveTargetConfig(env, "SUB2API", override);
  const normalizedIds = [];
  const seen = new Set();
  for (const raw of ids) {
    if (raw == null || raw === "") continue;
    const id = typeof raw === "number" || typeof raw === "string" ? raw : String(raw);
    const marker = String(id);
    if (seen.has(marker)) continue;
    seen.add(marker);
    normalizedIds.push(id);
  }
  if (!normalizedIds.length) {
    throw new HttpError(400, "没有可导出的账号 ID", "INVALID_PAYLOAD");
  }

  // 直接按 id 拉详情，避免先全量 lite 列表再逐个详情（选中越多越慢，且易超时）
  let attempts = 0;
  const detailResults = await mapWithConcurrency(
    normalizedIds,
    SUB2API_EXPORT_DETAIL_CONCURRENCY,
    async (id) => {
      try {
        const detail = await fetchSub2apiAccountDetail(config, id, clientSignal);
        attempts += detail.attempts || 0;
        return { id, ok: true, account: detail.account };
      } catch (error) {
        return {
          id,
          ok: false,
          error: publicErrorMessage(error),
          status: error?.status,
          code: error?.code,
        };
      }
    }
  );

  const failures = [];
  const accounts = [];
  // 清洗后 pack 不再带 id，单独回传成功 id 供前端标记逐项结果
  const successIds = [];
  for (const item of detailResults) {
    if (!item.ok) {
      failures.push(item);
      continue;
    }
    if (!accountHasUsableCredentials(item.account)) {
      failures.push({
        id: item.id,
        ok: false,
        error: "账号缺少可用凭证字段，无法导出完整认证数据",
        code: "INCOMPLETE_ACCOUNT_DATA",
        status: item.status,
      });
      continue;
    }
    const sanitized = sanitizeSub2apiExportAccount(item.account);
    if (sanitized) {
      accounts.push(sanitized);
      successIds.push(item.id);
    } else {
      failures.push({
        id: item.id,
        ok: false,
        error: "账号数据清洗后为空",
        code: "INCOMPLETE_ACCOUNT_DATA",
      });
    }
  }

  if (!accounts.length) {
    throw new HttpError(
      502,
      failures.length
        ? `未能导出任何完整账号：${failures[0].error || "未知错误"}`
        : "未能导出任何完整账号",
      failures[0]?.code || "INCOMPLETE_ACCOUNT_DATA",
      { failures: failures.slice(0, 20), failedCount: failures.length, successIds: [] }
    );
  }

  const pack = {
    exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    proxies: [],
    accounts,
  };

  return {
    baseUrl: config.baseUrl,
    source: config.source,
    attempts,
    requestedCount: normalizedIds.length,
    count: accounts.length,
    failedCount: failures.length,
    // 限制失败明细体积，避免大批量时响应膨胀
    failures: failures.slice(0, 50),
    successIds,
    pack,
  };
}

async function uploadSub2api(
  env,
  accounts,
  skipDefaultGroupBind,
  clientSignal,
  override = null,
  maxAttempts = 1,
  retryAmbiguous = false
) {
  const config = resolveTargetConfig(env, "SUB2API", override);

  // 仅当本批账号带有 proxy_id 时才需要 id→key；优先内存/KV 缓存
  let idToKey = new Map();
  let proxyMapAttempts = 0;
  let proxyMapCacheHit = false;
  let proxyMapCacheSource = "skipped";
  if (accountsNeedProxyMap(accounts)) {
    const mapped = await getSub2apiProxyIdKeyMap(env, config, clientSignal, {
      forceRefresh: false,
    });
    idToKey = mapped.idToKey;
    proxyMapAttempts = mapped.attempts;
    proxyMapCacheHit = Boolean(mapped.cacheHit);
    proxyMapCacheSource = mapped.cacheSource || (mapped.cacheHit ? "unknown" : "upstream");
  }

  const rewrittenAccounts = rewriteAccountsProxyIdToKey(accounts, idToKey);
  const payload = {
    data: {
      exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      proxies: [],
      accounts: rewrittenAccounts,
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
    }
  );
  return {
    attempts: result.attempts,
    proxyMapAttempts,
    proxyMapCacheHit,
    proxyMapCacheSource,
    source: config.source,
    data: result.data?.data ?? result.data,
  };
}

async function uploadCpaFiles(
  env,
  files,
  clientSignal,
  override = null,
  maxAttempts = DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS
) {
  const config = resolveTargetConfig(env, "CPA", override);
  const normalized = files.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !entry.account ||
      typeof entry.account !== "object"
    ) {
      throw new HttpError(400, `files[${index}] 缺少 account 对象`, "INVALID_PAYLOAD");
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
        clientSignal
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
  // 去掉路径分隔符、Windows 非法字符与 C0 控制字符（含 NUL）
  let name = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_"); // eslint-disable-line no-control-regex -- 故意匹配控制字符
  if (!name.toLowerCase().endsWith(".json")) name += ".json";
  if (name.length > 180) name = `${name.slice(0, 175)}.json`;
  return name || "account.json";
}

async function sub2apiRequest(
  config,
  path,
  init,
  timeoutMs,
  maxAttempts,
  clientSignal,
  retryOptions = {}
) {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");
  headers.set("x-api-key", config.apiKey);
  return requestJsonWithRetry(
    `${config.baseUrl}${path}`,
    { ...init, headers },
    {
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
    }
  );
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
      const result = await requestJsonWithRetry(
        `${config.baseUrl}${path}`,
        { ...init, headers },
        {
          timeoutMs,
          maxAttempts,
          clientSignal,
        }
      );
      return { ...result, authMode: mode };
    } catch (error) {
      lastError = error;
      if (![401, 403].includes(error?.status)) throw error;
    }
  }
  throw lastError || new HttpError(401, "CPA 管理密钥验证失败", "UPSTREAM_AUTH_FAILED");
}

/**
 * CPA 请求（原始文本/JSON 均可）。
 * 用于 auth-files/download：正文是认证 JSON 文件，可能被 parse 成对象或 { raw }。
 * 鉴权模式回退与 cpaRequest 一致。
 */
async function cpaRequestRaw(config, path, init, timeoutMs, maxAttempts, clientSignal) {
  const modes = cpaAuthModes(config.cpaAuthMode);
  let lastError;
  for (const mode of modes) {
    const headers = new Headers(init.headers || {});
    headers.set("Accept", "*/*");
    if (mode === "x-management-key") headers.set("X-Management-Key", config.apiKey);
    else headers.set("Authorization", `Bearer ${config.apiKey}`);

    try {
      const result = await requestJsonWithRetry(
        `${config.baseUrl}${path}`,
        { ...init, headers },
        {
          timeoutMs,
          maxAttempts,
          clientSignal,
        }
      );
      return { ...result, authMode: mode };
    } catch (error) {
      lastError = error;
      if (![401, 403].includes(error?.status)) throw error;
    }
  }
  throw lastError || new HttpError(401, "CPA 管理密钥验证失败", "UPSTREAM_AUTH_FAILED");
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
        throw new HttpError(499, "客户端已取消上传", "CLIENT_ABORTED");
      }
      const response = await fetchWithTimeout(url, init, timeoutMs, options.clientSignal);
      const text = await response.text();
      const data = parseResponseBody(text);
      if (!response.ok) {
        const detail =
          data?.message || data?.error || data?.code || data?.raw || response.statusText;
        const error = new HttpError(
          response.status,
          `上游 HTTP ${response.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
          "UPSTREAM_HTTP_ERROR",
          data
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
      await sleep(700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300));
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
      throw new HttpError(499, "客户端已取消上传", "CLIENT_ABORTED");
    }
    if (controller.signal.aborted) {
      throw new HttpError(
        504,
        "上游请求超时，服务器可能已经接收并处理本批数据，请先核对后再重试",
        "UPSTREAM_TIMEOUT"
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    clientSignal?.removeEventListener?.("abort", onClientAbort);
  }
}

function normalizeUpstreamError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(
    502,
    `无法连接上游服务器：${error?.message || String(error)}`,
    "UPSTREAM_NETWORK_ERROR"
  );
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
  if (
    error?.status &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  ) {
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
    throw new HttpError(413, "请求体过大", "PAYLOAD_TOO_LARGE");
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new HttpError(413, "请求体过大", "PAYLOAD_TOO_LARGE");
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new HttpError(400, "请求体不是有效 JSON", "INVALID_JSON");
  }
}

function publicErrorMessage(error) {
  if (!error) return "未知错误";
  return error.message || String(error);
}

function errorResponse(error) {
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
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function securityHeaders() {
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
<div class="hint">保存并重新部署后刷新本页</div>
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
