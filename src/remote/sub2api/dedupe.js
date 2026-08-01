import { resolveTargetConfig } from "../../config.js";
import {
  listAllSub2apiAccounts,
  compareAccountIdAsc,
  normalizeDedupeEmail,
  isNormalAccountStatus,
  accountExpiresUnix,
  summarizeDedupeAccount,
} from "./accounts.js";
import { sub2apiRequest, mapWithConcurrency } from "../../http.js";
import { HttpError } from "../../errors.js";
import { DEDUPE_DELETE_CONCURRENCY, VERIFY_TIMEOUT_MS } from "../../constants.js";
import { publicErrorMessage } from "../../responses.js";

/** 去重分组键：优先邮箱，其次 name；无标识则不参与去重 */
export function accountDedupeKey(account) {
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

/**
 * 保留策略：
 * 1. 优先保留正常状态账号
 * 2. 状态相同时优先保留过期时间较晚者（无过期信息排后）
 * 3. 再按更小 id 保留
 */
export function selectDedupeKeeper(members) {
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

export function buildSub2apiDuplicatePlan(accounts) {
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

export async function scanSub2apiDuplicates(env, override = null, clientSignal = undefined) {
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

export async function deleteSub2apiAccount(config, accountId, clientSignal) {
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

export async function applySub2apiDedupe(env, ids, override = null, clientSignal = undefined) {
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

export {
  compareAccountIdAsc,
  normalizeDedupeEmail,
  isNormalAccountStatus,
  accountExpiresUnix,
  summarizeDedupeAccount,
};
