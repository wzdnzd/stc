import {
  DEFAULT_PROXY_MAP_CACHE_TTL_SECONDS,
  MIN_PROXY_MAP_CACHE_TTL_SECONDS,
  MAX_PROXY_MAP_CACHE_TTL_SECONDS,
  VERIFY_TIMEOUT_MS,
} from "./constants.js";
import { firstEnv, parsePositiveIntText } from "./limits.js";
import { resolveTargetConfig } from "./config.js";
import { sub2apiRequest } from "./http.js";

export function extractProxyEntries(payload) {
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
export function buildProxyKey(protocol, host, port, username, password) {
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

export function parseLocalProxyId(value) {
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
export function buildLocalProxyMap(payload) {
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
export function rewriteAccountsProxyIdToKey(accounts, idToKey) {
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
export const proxyMapMemoryCache = new Map();

export function resolveProxyMapCacheTtlSeconds(env) {
  const found = firstEnv(env, "PROXY_MAP_CACHE_TTL_SECONDS");
  if (!found) return DEFAULT_PROXY_MAP_CACHE_TTL_SECONDS;
  const parsed = parsePositiveIntText(found.raw, {
    min: MIN_PROXY_MAP_CACHE_TTL_SECONDS,
    max: MAX_PROXY_MAP_CACHE_TTL_SECONDS,
  });
  return parsed == null ? DEFAULT_PROXY_MAP_CACHE_TTL_SECONDS : parsed;
}

/** 绑定名 PROXY_CACHE_KV 或 PROXY_MAP_KV；未绑定则返回 null，回落内存缓存 */
export function getProxyCacheKv(env) {
  if (!env) return null;
  const kv = env.PROXY_CACHE_KV || env.PROXY_MAP_KV || null;
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") return null;
  return kv;
}

export function proxyMapCacheKey(config) {
  const base = String(config?.baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
  const key = String(config?.apiKey || "");
  // 不把完整密钥写入缓存键；长度 + 首尾片段足以区分本机不同配置
  const fp = `${key.length}:${key.slice(0, 6)}:${key.slice(-6)}`;
  return `${base}|${fp}`;
}

export function proxyMapKvKey(cacheKey) {
  // KV key 安全字符；完整 apiKey 不入 key
  return `proxy-map:v1:${cacheKey}`;
}

export function memoryHitToResult(entry, source = "memory") {
  return {
    proxyIds: entry.proxyIds,
    idToKey: new Map(entry.entries),
    attempts: 0,
    cacheHit: true,
    cacheSource: source,
  };
}

export function readProxyMapMemory(cacheKey) {
  const entry = proxyMapMemoryCache.get(cacheKey);
  if (!entry?.entries || !(entry.expiresAt > Date.now())) return null;
  return memoryHitToResult(entry, "memory");
}

export function storeProxyMapMemory(cacheKey, mapped, ttlSeconds) {
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

export function clearProxyMapMemory(cacheKey) {
  if (cacheKey) proxyMapMemoryCache.delete(cacheKey);
  else proxyMapMemoryCache.clear();
}

export async function readProxyMapKv(kv, cacheKey) {
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

export async function storeProxyMapKv(kv, cacheKey, mapped, ttlSeconds) {
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

export async function clearProxyMapKv(kv, cacheKey) {
  if (!kv || !cacheKey || typeof kv.delete !== "function") return;
  try {
    await kv.delete(proxyMapKvKey(cacheKey));
  } catch (error) {
    console.warn("proxy map KV delete failed", error?.message || error);
  }
}

export async function fetchSub2apiProxyIdKeyMap(config, clientSignal = undefined) {
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
export async function getSub2apiProxyIdKeyMap(
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

export function accountsNeedProxyMap(accounts) {
  return Array.isArray(accounts)
    ? accounts.some((a) => parseLocalProxyId(a?.proxy_id ?? a?.proxyId) != null)
    : false;
}

/** 仅向前端返回 proxy_id 列表；proxy_key 留在 Worker 内，避免网络泄露 */
export async function listSub2apiProxies(
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
