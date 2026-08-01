import {
  TARGET_CPA,
  TARGET_SUB2API,
  convertAccountTo,
  normalizeConvertOptions,
  normalizeTargetFormat,
  summarizeAccountForResult,
  parseProxyId,
  isCpaRecord,
  isSub2Account,
  normalizeCpa,
  normalizeSub2,
  detectSourceFormat,
  resolveExpiresAtFromAccount,
  isExpiredUnix,
  uniqueCpaFilenames,
} from "./shared/account-convert.js";
import { HttpError } from "./errors.js";
import { extractConfigOverride, resolveTargetConfig } from "./config.js";
import { downloadCpaAuthFiles } from "./remote/cpa/auth-files.js";
import { exportSub2apiAccounts } from "./remote/sub2api/export.js";
import { uploadCpaFiles, uploadSub2api } from "./upload.js";
import {
  maxCpaAuthDownloadFiles,
  maxCpaFiles,
  maxSub2apiAccounts,
  maxSub2apiExportAccounts,
  resolveRequestedAttempts,
  maxSub2apiUploadAttempts,
  maxCpaUploadAttempts,
} from "./limits.js";
import {
  DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS,
  DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS,
} from "./constants.js";
import { publicErrorMessage } from "./responses.js";

// ---------------------------------------------------------------------------
// 远端互传：源拉凭证 → 转换 → 目标上传（完整 JSON 不回前端）
// ---------------------------------------------------------------------------

export function extractDualConfigOverrides(body) {
  const sourceOverride = extractConfigOverride(
    body?.sourceConfig ?? body?.source_config ?? body?.configs?.source ?? null
  );
  const targetOverride = extractConfigOverride(
    body?.targetConfig ?? body?.target_config ?? body?.configs?.target ?? null
  );
  return { sourceOverride, targetOverride };
}

export function normalizeTransferItems(rawItems, source) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, "items 必须是非空数组", "INVALID_PAYLOAD");
  }
  const out = [];
  const seen = new Set();
  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index];
    const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { value: raw };
    let key;
    let id;
    let name;
    if (source === TARGET_CPA) {
      name = String(entry.name ?? entry.fileName ?? entry.filename ?? entry.value ?? "").trim();
      if (!name) {
        throw new HttpError(400, `items[${index}] 缺少 CPA 文件名 name`, "INVALID_PAYLOAD");
      }
      key = name;
    } else {
      id = entry.id ?? entry.accountId ?? entry.account_id ?? entry.value;
      if (id == null || id === "") {
        throw new HttpError(400, `items[${index}] 缺少 SUB2API 账号 id`, "INVALID_PAYLOAD");
      }
      key = String(id);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      id: source === TARGET_SUB2API ? id : undefined,
      name: source === TARGET_CPA ? name : undefined,
      proxyId: parseProxyId(entry.proxyId ?? entry.proxy_id),
      clientId:
        entry.clientId != null
          ? String(entry.clientId)
          : entry.itemId != null
            ? String(entry.itemId)
            : "",
    });
  }
  if (!out.length) {
    throw new HttpError(400, "没有可传输的账号", "INVALID_PAYLOAD");
  }
  return out;
}

export function transferResultBase(item, extra = {}) {
  return {
    key: item.key,
    clientId: item.clientId || "",
    ok: false,
    ...extra,
  };
}

/**
 * 单批远端互传。
 * body: { source, target, items, sourceConfig?, targetConfig?, convert?, upload?, timezone? }
 */
export async function transferRemoteBatch(env, body, clientSignal = undefined) {
  const source = normalizeTargetFormat(body?.source ?? body?.from);
  const target = normalizeTargetFormat(body?.target ?? body?.to);
  if (!source || !target) {
    throw new HttpError(400, "source / target 必须是 CPA 或 SUB2API", "INVALID_PAYLOAD");
  }
  if (source === target) {
    throw new HttpError(400, "远端互传不允许 source 与 target 相同", "SAME_SIDE_TRANSFER");
  }

  const items = normalizeTransferItems(body?.items ?? body?.accounts ?? body?.files, source);
  const maxBatch = target === TARGET_SUB2API ? maxSub2apiAccounts(env) : maxCpaFiles(env);
  const maxSourceFetch =
    source === TARGET_CPA ? maxCpaAuthDownloadFiles(env) : maxSub2apiExportAccounts(env);
  const maxAllowed = Math.min(maxBatch, maxSourceFetch);
  if (items.length > maxAllowed) {
    throw new HttpError(400, `单批最多互传 ${maxAllowed} 个账号`, "BATCH_TOO_LARGE");
  }

  const { sourceOverride, targetOverride } = extractDualConfigOverrides(body || {});
  // 预校验两端配置，避免拉完源才发现目标未配置
  resolveTargetConfig(env, source, sourceOverride);
  resolveTargetConfig(env, target, targetOverride);

  const convertOptions = normalizeConvertOptions(body?.convert ?? body?.convertOptions ?? {});
  const uploadOpts = body?.upload && typeof body.upload === "object" ? body.upload : {};
  const skipExpired =
    uploadOpts.skipExpired === true ||
    uploadOpts.skipExpiredAccounts === true ||
    body?.skipExpired === true;
  const maxAttempts = resolveRequestedAttempts(
    uploadOpts.maxAttempts ?? body?.maxAttempts,
    target === TARGET_SUB2API ? maxSub2apiUploadAttempts(env) : maxCpaUploadAttempts(env),
    target === TARGET_SUB2API
      ? DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS
      : DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS
  );
  const retryAmbiguous = uploadOpts.retryAmbiguous === true || body?.retryAmbiguous === true;
  const timezone = body?.timezone ?? body?.time_zone ?? body?.tz;

  /** @type {Map<string, any>} */
  const accountByKey = new Map();
  /** @type {Map<string, string>} */
  const fetchErrorByKey = new Map();

  if (source === TARGET_CPA) {
    const names = items.map((item) => item.name);
    const downloaded = await downloadCpaAuthFiles(env, names, sourceOverride, clientSignal);
    const fileMap = new Map();
    for (const file of downloaded.files || []) {
      if (!file?.name) continue;
      fileMap.set(String(file.name), file);
    }
    for (const item of items) {
      const file = fileMap.get(item.key);
      if (!file) {
        fetchErrorByKey.set(item.key, "源站未返回该认证文件");
        continue;
      }
      if (!file.ok || file.content == null) {
        fetchErrorByKey.set(item.key, file.error || "下载认证文件失败");
        continue;
      }
      try {
        let content = file.content;
        if (typeof content === "string") {
          content = JSON.parse(content);
        }
        if (!content || typeof content !== "object") {
          fetchErrorByKey.set(item.key, "认证文件内容无效");
          continue;
        }
        if (isCpaRecord(content) || content.access_token || content.email) {
          accountByKey.set(item.key, normalizeCpa(content));
        } else if (isSub2Account(content) || content.credentials) {
          accountByKey.set(item.key, normalizeSub2(content));
        } else {
          fetchErrorByKey.set(item.key, "无法识别的认证文件结构");
        }
      } catch (error) {
        fetchErrorByKey.set(item.key, publicErrorMessage(error) || "解析认证文件失败");
      }
    }
  } else {
    const ids = items.map((item) => item.id);
    let exported;
    try {
      exported = await exportSub2apiAccounts(env, ids, sourceOverride, clientSignal, timezone);
    } catch (error) {
      // 整批硬失败（如 step-up）：所有项记失败
      const message = publicErrorMessage(error);
      const results = items.map((item) =>
        transferResultBase(item, {
          error: message,
          code: error?.code || "SOURCE_EXPORT_FAILED",
        })
      );
      return {
        source,
        target,
        requestedCount: items.length,
        okCount: 0,
        failedCount: items.length,
        skippedCount: 0,
        results,
      };
    }
    const byId = new Map();
    const packAccounts = Array.isArray(exported?.pack?.accounts) ? exported.pack.accounts : [];
    const successIds = Array.isArray(exported?.successIds)
      ? exported.successIds.map((id) => String(id))
      : [];
    for (let i = 0; i < packAccounts.length; i++) {
      const account = packAccounts[i];
      const matched =
        account?.id != null
          ? String(account.id)
          : successIds[i] || (ids[i] != null ? String(ids[i]) : "");
      if (!matched) continue;
      try {
        if (isSub2Account(account) || account?.credentials) {
          byId.set(matched, normalizeSub2(account));
        } else if (isCpaRecord(account)) {
          byId.set(matched, normalizeCpa(account));
        }
      } catch {
        // 单条解析失败下面统一记
      }
    }
    for (const fail of exported?.failures || []) {
      if (fail?.id != null) {
        fetchErrorByKey.set(String(fail.id), fail.error || "导出失败");
      }
    }
    for (const item of items) {
      const account = byId.get(item.key);
      if (account) {
        accountByKey.set(item.key, account);
      } else if (!fetchErrorByKey.has(item.key)) {
        fetchErrorByKey.set(item.key, "源站未返回该账号完整凭证");
      }
    }
  }

  const readyUploads = [];
  const earlyResults = [];
  let skippedCount = 0;

  for (const item of items) {
    if (fetchErrorByKey.has(item.key)) {
      earlyResults.push(
        transferResultBase(item, {
          error: fetchErrorByKey.get(item.key),
          code: "SOURCE_FETCH_FAILED",
        })
      );
      continue;
    }
    const rawAccount = accountByKey.get(item.key);
    if (!rawAccount) {
      earlyResults.push(
        transferResultBase(item, {
          error: "缺少源账号数据",
          code: "SOURCE_FETCH_FAILED",
        })
      );
      continue;
    }

    const sourceFormat =
      source === TARGET_CPA
        ? detectSourceFormat(rawAccount) || "cpa"
        : detectSourceFormat(rawAccount) || "sub2api";

    if (skipExpired) {
      const expiresAt = resolveExpiresAtFromAccount(rawAccount, sourceFormat);
      if (isExpiredUnix(expiresAt)) {
        skippedCount += 1;
        earlyResults.push(
          transferResultBase(item, {
            ok: false,
            skipped: true,
            error: "已跳过失效账号",
            code: "SKIPPED_EXPIRED",
            ...summarizeAccountForResult(rawAccount, sourceFormat),
          })
        );
        continue;
      }
    }

    const proxyId =
      item.proxyId != null
        ? item.proxyId
        : convertOptions.defaultProxyId != null
          ? convertOptions.defaultProxyId
          : parseProxyId(rawAccount.proxy_id);

    try {
      const converted = convertAccountTo(rawAccount, sourceFormat, target, {
        ...convertOptions,
        proxyId,
        defaultProxyId: convertOptions.defaultProxyId,
      });
      const summary = summarizeAccountForResult(rawAccount, sourceFormat);
      readyUploads.push({ item, converted, summary });
    } catch (error) {
      earlyResults.push(
        transferResultBase(item, {
          error: publicErrorMessage(error) || "转换失败",
          code: "CONVERT_FAILED",
          ...summarizeAccountForResult(rawAccount, sourceFormat),
        })
      );
    }
  }

  /** @type {Map<string, any>} */
  const uploadResultByKey = new Map();

  if (readyUploads.length) {
    if (target === TARGET_SUB2API) {
      try {
        const upload = await uploadSub2api(
          env,
          readyUploads.map((entry) => entry.converted),
          Boolean(body?.skipDefaultGroupBind),
          clientSignal,
          targetOverride,
          maxAttempts,
          retryAmbiguous
        );
        for (const entry of readyUploads) {
          uploadResultByKey.set(entry.item.key, {
            ok: true,
            attempts: upload?.attempts || 1,
            ...entry.summary,
          });
        }
      } catch (error) {
        const message = publicErrorMessage(error);
        const code = error?.code || "TARGET_UPLOAD_FAILED";
        const status = error?.status;
        const unknown =
          !status || [408, 425, 429, 499, 500, 502, 503, 504].includes(Number(status));
        for (const entry of readyUploads) {
          uploadResultByKey.set(entry.item.key, {
            ok: false,
            error: message,
            code,
            unknown,
            attempts: error?.attempts || 1,
            ...entry.summary,
          });
        }
      }
    } else {
      const files = uniqueCpaFilenames(readyUploads.map((entry) => entry.converted)).map(
        (row, index) => ({
          name: row.filename,
          account: row.account,
          key: readyUploads[index].item.key,
          summary: readyUploads[index].summary,
        })
      );
      const uploadResults = await uploadCpaFiles(
        env,
        files.map((f) => ({ name: f.name, account: f.account })),
        clientSignal,
        targetOverride,
        maxAttempts
      );
      const byName = new Map((uploadResults || []).map((row) => [row.name, row]));
      for (const file of files) {
        const row = byName.get(file.name);
        if (row?.ok) {
          uploadResultByKey.set(file.key, {
            ok: true,
            attempts: row.attempts || 1,
            filename: file.name,
            ...file.summary,
          });
        } else {
          uploadResultByKey.set(file.key, {
            ok: false,
            error: row?.error || "目标站上传失败",
            code: "TARGET_UPLOAD_FAILED",
            attempts: row?.attempts || 1,
            filename: file.name,
            ...file.summary,
          });
        }
      }
    }
  }

  const results = [];
  const earlyByKey = new Map(earlyResults.map((row) => [row.key, row]));
  for (const item of items) {
    if (earlyByKey.has(item.key)) {
      results.push(earlyByKey.get(item.key));
      continue;
    }
    const uploaded = uploadResultByKey.get(item.key);
    if (uploaded) {
      results.push(transferResultBase(item, uploaded));
    } else {
      results.push(
        transferResultBase(item, {
          error: "未处理",
          code: "NOT_PROCESSED",
        })
      );
    }
  }

  const okCount = results.filter((row) => row.ok).length;
  const failedCount = results.filter((row) => !row.ok && !row.skipped).length;
  return {
    source,
    target,
    requestedCount: items.length,
    okCount,
    failedCount,
    skippedCount,
    results,
  };
}
