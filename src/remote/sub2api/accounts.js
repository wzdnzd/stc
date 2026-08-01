import { resolveTargetConfig } from "../../config.js";
import { sub2apiRequest, mapWithConcurrency } from "../../http.js";
import { HttpError } from "../../errors.js";
import {
  DEDUPE_PAGE_SIZE,
  DEDUPE_SCAN_CONCURRENCY,
  DEDUPE_NORMAL_STATUSES,
  VERIFY_TIMEOUT_MS,
} from "../../constants.js";

export function compareAccountIdAsc(a, b) {
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

export function normalizeDedupeEmail(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function isNormalAccountStatus(status) {
  if (status == null || status === "") return false;
  const raw = String(status).trim().toLowerCase();
  if (DEDUPE_NORMAL_STATUSES.has(raw)) return true;
  const n = Number(status);
  return Number.isFinite(n) && n === 1;
}

export function accountExpiresUnix(account) {
  if (!account || typeof account !== "object") return null;
  const candidates = [
    account.credentials?.expires_at,
    account.credentials?.expired_at,
    account.credentials?.expired,
    account.expires_at,
    account.expired_at,
    account.expired,
    account.extra?.expires_at,
    account.extra?.expired_at,
    account.extra?.expired,
  ];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
    }
    const text = String(raw).trim();
    // 纯数字（含字符串形式的 unix 秒/毫秒）
    if (/^\d+(\.\d+)?$/.test(text)) {
      const asNum = Number(text);
      if (Number.isFinite(asNum)) {
        return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
      }
    }
    // ISO / 可解析日期字符串
    const normalized = text.endsWith("Z") ? `${text.slice(0, -1)}+00:00` : text;
    const ms = Date.parse(normalized);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

export function summarizeDedupeAccount(account) {
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

export function extractAccountsPageItems(payload) {
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

export async function fetchSub2apiAccountsPage(config, page, pageSize, clientSignal) {
  // 快载/去重需要 credentials.expires_at 等元数据；lite=1 可能裁掉该字段导致过期列为空
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    sort_by: "id",
    sort_order: "asc",
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

export async function listAllSub2apiAccounts(config, clientSignal) {
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
    console.warn(
      `SUB2API dedupe scan total mismatch: expected=${expectedTotal}, unique=${seenIds.size}`
    );
  }

  allAccounts.sort(compareAccountIdAsc);
  return { accounts: allAccounts, attempts, reportedTotal: expectedTotal };
}

export async function listSub2apiAccountsMeta(env, override = null, clientSignal = undefined) {
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
