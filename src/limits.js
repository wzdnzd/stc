import {
  DEFAULT_MAX_SUB2API_ACCOUNTS,
  DEFAULT_MAX_CPA_FILES,
  DEFAULT_ABSOLUTE_MAX_SUB2API_ACCOUNTS,
  DEFAULT_ABSOLUTE_MAX_CPA_FILES,
  HARD_MAX_BATCH_SUB2API,
  HARD_MAX_BATCH_CPA,
  DEFAULT_MAX_CPA_AUTH_DOWNLOAD_FILES,
  DEFAULT_ABSOLUTE_MAX_CPA_AUTH_DOWNLOAD_FILES,
  HARD_MAX_CPA_AUTH_DOWNLOAD_FILES,
  DEFAULT_MAX_SUB2API_EXPORT_ACCOUNTS,
  DEFAULT_ABSOLUTE_MAX_SUB2API_EXPORT_ACCOUNTS,
  HARD_MAX_SUB2API_EXPORT_ACCOUNTS,
  DEFAULT_MAX_SUB2API_DEDUPE_IDS,
  DEFAULT_ABSOLUTE_MAX_SUB2API_DEDUPE_IDS,
  HARD_MAX_SUB2API_DEDUPE_IDS,
  DEFAULT_MAX_UPLOAD_CONCURRENCY_SUB2API,
  DEFAULT_MAX_UPLOAD_CONCURRENCY_CPA,
  DEFAULT_ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API,
  DEFAULT_ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA,
  HARD_MAX_UPLOAD_CONCURRENCY,
  DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS,
  DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS,
  DEFAULT_ABSOLUTE_MAX_UPLOAD_ATTEMPTS,
  HARD_MAX_UPLOAD_ATTEMPTS,
} from "./constants.js";
import { getProxyCacheKv, resolveProxyMapCacheTtlSeconds } from "./proxy-cache.js";

export function getAccessSetupProblem(env) {
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
export function readEnvRaw(env, key) {
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
export function firstEnv(env, ...keys) {
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

export function parsePositiveIntText(raw, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
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
export function parseAbsoluteLimitEnv(
  absFound,
  maxFound,
  defaultAbsolute,
  defaultMax,
  hardMax,
  label
) {
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
export function validateOptionalMaxEnv(found, absolute, label) {
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

export function getLimitsEnvProblem(env) {
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

export function limitSpecs() {
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

export function resolveLimitDetail(env, spec) {
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
  const value = parsePositiveIntText(maxFound?.raw, { min: 1, max: absolute }) ?? fallback;
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

export function resolveLimit(env, spec) {
  return resolveLimitDetail(env, spec).value;
}

export function buildPublicLimits(env) {
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

export function maxSub2apiAccounts(env) {
  return resolveLimit(env, limitSpecs()[0]);
}

export function maxCpaFiles(env) {
  return resolveLimit(env, limitSpecs()[1]);
}

export function maxCpaAuthDownloadFiles(env) {
  return resolveLimit(env, limitSpecs()[6]);
}

export function maxSub2apiExportAccounts(env) {
  return resolveLimit(env, limitSpecs()[7]);
}

export function maxSub2apiDedupeIds(env) {
  return resolveLimit(env, limitSpecs()[8]);
}

export function maxSub2apiUploadAttempts(env) {
  return resolveLimit(env, limitSpecs()[4]);
}

export function maxCpaUploadAttempts(env) {
  return resolveLimit(env, limitSpecs()[5]);
}

export function resolveRequestedAttempts(requested, limit, fallbackDefault) {
  const requestedAttempts = Number(requested);
  if (Number.isFinite(requestedAttempts)) {
    return Math.min(limit, Math.max(1, Math.floor(requestedAttempts)));
  }
  return Math.min(limit, fallbackDefault);
}
