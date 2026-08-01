import { resolveTargetConfig } from "../../config.js";
import { sub2apiRequest } from "../../http.js";
import { HttpError } from "../../errors.js";
import { VERIFY_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS } from "../../constants.js";
import { publicErrorMessage } from "../../responses.js";

// ---------------------------------------------------------------------------
// SUB2API 远端账号 list / export
// ---------------------------------------------------------------------------

export function nonEmptyText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function credentialsObjectLooksUsable(cred) {
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

export function accountHasUsableCredentials(account) {
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

export function normalizeExportCredentials(account) {
  if (!account || typeof account !== "object") return {};
  // 官方 /accounts/data 导出通常已带完整 credentials；优先原样保留，避免漏掉 access/refresh/id token
  if (
    account.credentials &&
    typeof account.credentials === "object" &&
    !Array.isArray(account.credentials)
  ) {
    return { ...account.credentials };
  }
  if (
    account.credential &&
    typeof account.credential === "object" &&
    !Array.isArray(account.credential)
  ) {
    return { ...account.credential };
  }
  if (account.auth && typeof account.auth === "object" && !Array.isArray(account.auth)) {
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
    ["email", ["email"]],
    ["expires_at", ["expires_at", "expiresAt"]],
    ["token_type", ["token_type", "tokenType"]],
    ["base_url", ["base_url", "baseUrl"]],
    ["client_id", ["client_id", "clientId"]],
    ["scope", ["scope"]],
  ];
  for (const [target, sources] of map) {
    for (const source of sources) {
      const value = account[source];
      if (value == null || value === "") continue;
      if (typeof value === "string") {
        const text = value.trim();
        if (text) {
          cred[target] = text;
          break;
        }
      } else if (typeof value === "number" && Number.isFinite(value)) {
        cred[target] = value;
        break;
      }
    }
  }
  return cred;
}

/** 导出用：保留官方 data 接口返回的完整凭证，仅去掉明显服务端只读字段 */
export function sanitizeSub2apiExportAccount(account) {
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
  // 关键：用官方导出包中的 credentials 原样回填，确保 access_token / refresh_token / id_token 不丢失
  out.credentials = normalizeExportCredentials(account);
  if (!out.extra || typeof out.extra !== "object" || Array.isArray(out.extra)) out.extra = {};
  if (out.concurrency == null) out.concurrency = 1;
  if (out.priority == null) out.priority = 1;
  if (out.rate_multiplier == null) out.rate_multiplier = 1;
  if (out.auto_pause_on_expired == null) out.auto_pause_on_expired = true;
  return out;
}

export function resolveExportTimezone(preferred) {
  const raw = String(preferred || "").trim();
  if (raw) return raw;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch {
    // ignore
  }
  return "UTC";
}

/**
 * 解析官方导出接口 GET /api/v1/admin/accounts/data 的响应。
 * 兼容：
 * - { exported_at, proxies, accounts }
 * - { data: { exported_at, proxies, accounts } }
 * - { data: { data: { ... } } }
 * - { accounts: [...] } / { data: [...] }
 */
export function unwrapSub2apiExportPack(payload) {
  let root = payload;
  for (let depth = 0; depth < 4; depth++) {
    if (!root || typeof root !== "object" || Array.isArray(root)) break;
    if (Array.isArray(root.accounts) || Array.isArray(root.proxies) || root.exported_at) {
      break;
    }
    if (root.data !== undefined) {
      root = root.data;
      continue;
    }
    if (root.result !== undefined) {
      root = root.result;
      continue;
    }
    if (root.pack !== undefined) {
      root = root.pack;
      continue;
    }
    break;
  }
  if (Array.isArray(root)) {
    return {
      exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      proxies: [],
      accounts: root,
    };
  }
  if (!root || typeof root !== "object") return null;
  const accounts = Array.isArray(root.accounts)
    ? root.accounts
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.list)
        ? root.list
        : null;
  if (!accounts) return null;
  return {
    exported_at:
      root.exported_at || root.exportedAt || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    proxies: Array.isArray(root.proxies) ? root.proxies : [],
    accounts,
  };
}

/**
 * 读取 SUB2API 系统设置：GET /api/v1/admin/settings?timezone=...
 * 用于导出前判断 totp_enabled 与 step_up_enabled。
 * 两者同时为 true 时，Admin API Key 无法调用 accounts/data。
 */
export async function fetchSub2apiAdminSettings(config, clientSignal, timezone) {
  const query = new URLSearchParams();
  query.set("timezone", resolveExportTimezone(timezone));
  const result = await sub2apiRequest(
    config,
    `/api/v1/admin/settings?${query.toString()}`,
    { method: "GET" },
    VERIFY_TIMEOUT_MS,
    2,
    clientSignal
  );
  return { settings: unwrapSub2apiSettings(result.data), attempts: result.attempts || 0 };
}

/** 兼容 { data: settings } / 嵌套 data / 顶层字段 */
export function unwrapSub2apiSettings(payload) {
  let root = payload;
  for (let depth = 0; depth < 4; depth++) {
    if (!root || typeof root !== "object" || Array.isArray(root)) break;
    if (
      root.totp_enabled !== undefined ||
      root.totpEnabled !== undefined ||
      root.step_up_enabled !== undefined ||
      root.stepUpEnabled !== undefined ||
      root.settings ||
      root.security ||
      root.config
    ) {
      // 可能是外壳：{ settings: {...} }
      if (
        root.settings &&
        typeof root.settings === "object" &&
        !Array.isArray(root.settings) &&
        root.totp_enabled === undefined &&
        root.totpEnabled === undefined &&
        root.step_up_enabled === undefined &&
        root.stepUpEnabled === undefined
      ) {
        root = root.settings;
        continue;
      }
      break;
    }
    if (root.data !== undefined) {
      root = root.data;
      continue;
    }
    if (root.result !== undefined) {
      root = root.result;
      continue;
    }
    break;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return {};
  return root;
}

export function coerceTruthyFlag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (!text) return false;
    if (["1", "true", "yes", "on", "enabled", "enable"].includes(text)) return true;
    if (["0", "false", "no", "off", "disabled", "disable"].includes(text)) return false;
  }
  return Boolean(value);
}

export function readSub2apiSettingFlag(settings, keys) {
  if (!settings || typeof settings !== "object") return false;
  const bags = [
    settings,
    settings.security,
    settings.admin,
    settings.auth,
    settings.config,
    settings.features,
    settings.two_factor,
    settings.twoFactor,
    settings.mfa,
    settings.step_up,
    settings.stepUp,
  ].filter((item) => item && typeof item === "object" && !Array.isArray(item));
  for (const bag of bags) {
    for (const key of keys) {
      if (bag[key] !== undefined) return coerceTruthyFlag(bag[key]);
    }
  }
  return false;
}

/** 从系统设置中解析 totp_enabled */
export function isSub2apiTotpEnabled(settings) {
  return readSub2apiSettingFlag(settings, [
    "totp_enabled",
    "totpEnabled",
    "enable_totp",
    "enableTotp",
    "admin_totp_enabled",
    "adminTotpEnabled",
  ]);
}

/** 从系统设置中解析 step_up_enabled */
export function isSub2apiStepUpEnabled(settings) {
  return readSub2apiSettingFlag(settings, [
    "step_up_enabled",
    "stepUpEnabled",
    "enable_step_up",
    "enableStepUp",
    "stepup_enabled",
    "stepupEnabled",
  ]);
}

/**
 * 仅当 totp_enabled 与 step_up_enabled 同时为 true 时，
 * Admin API Key 无法导出账号数据。
 */
export function isSub2apiExportBlockedByStepUp(settings) {
  return isSub2apiTotpEnabled(settings) && isSub2apiStepUpEnabled(settings);
}

export function sub2apiStepUpExportBlockedError() {
  return new HttpError(
    403,
    "目标 SUB2API 已同时开启 totp_enabled 与 step_up_enabled，Admin API Key 无法调用账号导出接口，请在管理后台使用已通过二次验证的会话导出，或关闭敏感操作二次验证后再用本工具导出",
    "SUB2API_STEP_UP_REQUIRED"
  );
}

export function isSub2apiExportStepUpSessionError(error) {
  if (!error) return false;
  const text = `${error.message || ""} ${error?.data?.error || ""} ${error?.data?.message || ""}`;
  if (/two-factor|2fa|totp|step[_ -]?up|second factor|二次验证|两步验证/i.test(text)) return true;
  if (error.status === 403 && /admin api key cannot access this endpoint/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * 官方导出：GET /api/v1/admin/accounts/data?ids=1,2,3&timezone=Asia/Shanghai
 * 该接口返回含 access_token / refresh_token / id_token 的完整 credentials，
 * 与管理后台「导出」一致；不要再用 /accounts/{id} 详情接口拼装。
 * 注意：上游若同时开启 totp_enabled 与 step_up_enabled，仅已二次验证的管理会话可访问，Admin API Key 会 403。
 */
export async function fetchSub2apiAccountsExportData(config, ids, clientSignal, timezone) {
  const query = new URLSearchParams();
  query.set("ids", ids.map((id) => String(id)).join(","));
  query.set("timezone", resolveExportTimezone(timezone));
  try {
    const result = await sub2apiRequest(
      config,
      `/api/v1/admin/accounts/data?${query.toString()}`,
      { method: "GET" },
      UPSTREAM_TIMEOUT_MS,
      2,
      clientSignal
    );
    const pack = unwrapSub2apiExportPack(result.data);
    if (!pack) {
      throw new HttpError(502, "SUB2API 导出响应无效", "INVALID_UPSTREAM_RESPONSE");
    }
    return { pack, attempts: result.attempts };
  } catch (error) {
    if (isSub2apiExportStepUpSessionError(error)) {
      throw sub2apiStepUpExportBlockedError();
    }
    throw error;
  }
}

export function collectAccountIdCandidates(account) {
  if (!account || typeof account !== "object") return [];
  const out = [];
  const push = (raw) => {
    if (raw == null || raw === "") return;
    if (typeof raw === "object") return;
    const marker = String(raw).trim();
    if (marker) out.push(marker);
  };
  push(account.id);
  push(account.account_id);
  push(account.accountId);
  push(account.ID);
  push(account.Id);
  // 官方导出偶发把 id 放在 extra / meta
  if (account.extra && typeof account.extra === "object") {
    push(account.extra.id);
    push(account.extra.account_id);
    push(account.extra.accountId);
  }
  if (account.meta && typeof account.meta === "object") {
    push(account.meta.id);
    push(account.meta.account_id);
    push(account.meta.accountId);
  }
  return out;
}

export function matchExportedAccountId(account, requestedIds) {
  for (const marker of collectAccountIdCandidates(account)) {
    if (requestedIds.has(marker)) return marker;
  }
  return "";
}
export async function exportSub2apiAccounts(
  env,
  ids,
  override = null,
  clientSignal = undefined,
  timezone = undefined
) {
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

  const tz = resolveExportTimezone(timezone);
  // 导出前检查：仅当 totp_enabled 与 step_up_enabled 同时为 true 时拦截
  let attempts = 0;
  try {
    const settingsResult = await fetchSub2apiAdminSettings(config, clientSignal, tz);
    attempts += settingsResult.attempts || 0;
    if (isSub2apiExportBlockedByStepUp(settingsResult.settings)) {
      throw sub2apiStepUpExportBlockedError();
    }
  } catch (error) {
    if (error?.code === "SUB2API_STEP_UP_REQUIRED") throw error;
    // settings 读取失败时不直接放行导出；若是 403/二次验证类错误，同样按 step-up 拦截
    if (isSub2apiExportStepUpSessionError(error)) {
      throw sub2apiStepUpExportBlockedError();
    }
    throw new HttpError(
      error?.status && error.status >= 400 && error.status < 600 ? error.status : 502,
      `无法读取 SUB2API 系统设置以确认 totp_enabled / step_up_enabled：${publicErrorMessage(error)}`,
      error?.code || "SUB2API_SETTINGS_UNAVAILABLE",
      error?.data
    );
  }

  // 官方批量导出接口：一次 ids 拉完整凭证包，不再逐个 /accounts/{id}
  const { pack: rawPack, attempts: exportAttempts } = await fetchSub2apiAccountsExportData(
    config,
    normalizedIds,
    clientSignal,
    tz
  );
  attempts += exportAttempts || 0;

  const requested = new Set(normalizedIds.map((id) => String(id)));
  const failures = [];
  const accounts = [];
  // 清洗后 pack 不再带 id，单独回传成功 id 供前端标记逐项结果
  const successIds = [];
  const returnedIds = new Set();
  // 官方 data 包有时不含/改写 id；保留可导出账号，后面按数量回填 successIds
  let usableWithoutId = 0;

  for (const account of rawPack.accounts) {
    if (!account || typeof account !== "object") continue;
    const matchedId = matchExportedAccountId(account, requested);
    if (matchedId) returnedIds.add(matchedId);

    if (!accountHasUsableCredentials(account)) {
      failures.push({
        id: matchedId || collectAccountIdCandidates(account)[0] || "",
        ok: false,
        error: "账号缺少可用凭证字段，无法导出完整认证数据",
        code: "INCOMPLETE_ACCOUNT_DATA",
      });
      continue;
    }
    const sanitized = sanitizeSub2apiExportAccount(account);
    if (!sanitized || !accountHasUsableCredentials(sanitized)) {
      failures.push({
        id: matchedId || collectAccountIdCandidates(account)[0] || "",
        ok: false,
        error: "账号数据清洗后缺少可用凭证",
        code: "INCOMPLETE_ACCOUNT_DATA",
      });
      continue;
    }
    accounts.push(sanitized);
    if (matchedId) successIds.push(matchedId);
    else usableWithoutId += 1;
  }

  // 真实业务失败（缺凭证等），不含「响应未带 id」的推断失败
  const realFailures = failures.filter((f) => f.code !== "ACCOUNT_NOT_IN_EXPORT");

  /**
   * 官方导出包常返回完整 accounts，但 id 字段与请求列表不一致或缺失。
   * 若可用账号数已覆盖请求数，且没有真实凭证失败，则整批记成功，避免前端全部标红。
   */
  if (
    accounts.length >= normalizedIds.length &&
    realFailures.length === 0 &&
    successIds.length < normalizedIds.length
  ) {
    successIds.length = 0;
    for (const id of normalizedIds) successIds.push(id);
    returnedIds.clear();
    for (const id of normalizedIds) returnedIds.add(String(id));
  } else if (
    // 部分匹配：把尚未记入 success 的请求 id，按剩余可用无 id 账号数补上
    usableWithoutId > 0 &&
    successIds.length < normalizedIds.length
  ) {
    const successSet = new Set(successIds.map((id) => String(id)));
    let remain = usableWithoutId;
    for (const id of normalizedIds) {
      if (remain <= 0) break;
      const marker = String(id);
      if (successSet.has(marker)) continue;
      // 已在 realFailures 里的不要标成功
      if (realFailures.some((f) => String(f.id) === marker)) continue;
      successIds.push(id);
      successSet.add(marker);
      returnedIds.add(marker);
      remain -= 1;
    }
  }

  // 请求了但既未匹配成功、也无真实失败记录的 id，记为未返回
  for (const id of normalizedIds) {
    const marker = String(id);
    if (returnedIds.has(marker)) continue;
    if (successIds.some((x) => String(x) === marker)) continue;
    if (failures.some((f) => String(f.id) === marker)) continue;
    failures.push({
      id,
      ok: false,
      error: "导出响应中未返回该账号",
      code: "ACCOUNT_NOT_IN_EXPORT",
    });
  }

  // 最终失败列表：去掉已被回填为成功的项
  const successSetFinal = new Set(successIds.map((id) => String(id)));
  const finalFailures = failures.filter((f) => {
    const fid = f?.id == null || f.id === "" ? "" : String(f.id);
    if (fid && successSetFinal.has(fid)) return false;
    return true;
  });

  if (!accounts.length) {
    throw new HttpError(
      502,
      finalFailures.length
        ? `未能导出任何完整账号：${finalFailures[0].error || "未知错误"}`
        : "未能导出任何完整账号",
      finalFailures[0]?.code || "INCOMPLETE_ACCOUNT_DATA",
      { failures: finalFailures.slice(0, 20), failedCount: finalFailures.length, successIds: [] }
    );
  }

  const pack = {
    exported_at: rawPack.exported_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    proxies: Array.isArray(rawPack.proxies) ? rawPack.proxies : [],
    accounts,
  };

  return {
    baseUrl: config.baseUrl,
    source: config.source,
    attempts,
    requestedCount: normalizedIds.length,
    count: accounts.length,
    failedCount: finalFailures.length,
    // 限制失败明细体积，避免大批量时响应膨胀
    failures: finalFailures.slice(0, 50),
    successIds,
    pack,
  };
}
