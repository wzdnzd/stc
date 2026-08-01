import { HttpError } from "./errors.js";
import { VERIFY_TIMEOUT_MS } from "./constants.js";
import { cpaRequest, sub2apiRequest } from "./http.js";

export function normalizeTarget(value) {
  const target = String(value || "").toUpperCase();
  if (target !== "SUB2API" && target !== "CPA") {
    throw new HttpError(400, "target 必须是 SUB2API 或 CPA", "INVALID_TARGET");
  }
  return target;
}

export function targetEnvNames(target) {
  return target === "SUB2API"
    ? { url: "SUB2API_BASE_URL", key: "SUB2API_ADMIN_API_KEY" }
    : { url: "CPA_BASE_URL", key: "CPA_MANAGEMENT_KEY" };
}

export const MAX_OVERRIDE_BASE_URL_LENGTH = 2048;
export const MAX_OVERRIDE_API_KEY_LENGTH = 8 * 1024;

export function extractConfigOverride(source) {
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

export function getTargetConfig(env, target) {
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

export function resolveTargetConfig(env, target, override = null) {
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

export function publicTargetStatus(env, target) {
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

export function normalizeBaseUrl(raw, target, env) {
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

export function normalizeCpaAuthMode(value) {
  const mode = String(value || "auto").toLowerCase();
  return ["auto", "bearer", "x-management-key"].includes(mode) ? mode : "auto";
}

export async function verifyTarget(env, target, override = null) {
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
