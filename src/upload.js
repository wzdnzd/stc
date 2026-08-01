import { resolveTargetConfig } from "./config.js";
import {
  getSub2apiProxyIdKeyMap,
  accountsNeedProxyMap,
  rewriteAccountsProxyIdToKey,
} from "./proxy-cache.js";
import { sub2apiRequest, cpaRequest, mapWithConcurrency } from "./http.js";
import { HttpError } from "./errors.js";
import { publicErrorMessage } from "./responses.js";
import { UPSTREAM_TIMEOUT_MS, DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS } from "./constants.js";

export async function uploadSub2api(
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

export async function uploadCpaFiles(
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

export function sanitizeJsonFilename(value) {
  // 去掉路径分隔符、Windows 非法字符与 C0 控制字符（含 NUL）
  let name = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_"); // eslint-disable-line no-control-regex -- 故意匹配控制字符
  if (!name.toLowerCase().endsWith(".json")) name += ".json";
  if (name.length > 180) name = `${name.slice(0, 175)}.json`;
  return name || "account.json";
}
