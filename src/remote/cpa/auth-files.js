import { resolveTargetConfig } from "../../config.js";
import { cpaRequest, cpaRequestRaw, mapWithConcurrency } from "../../http.js";
import { HttpError } from "../../errors.js";
import {
  VERIFY_TIMEOUT_MS,
  UPSTREAM_TIMEOUT_MS,
  CPA_DOWNLOAD_CONCURRENCY,
} from "../../constants.js";
import { publicErrorMessage } from "../../responses.js";
import { sanitizeJsonFilename } from "../../upload.js";
import { unixFromIsoOrNumber } from "../../shared/account-convert.js";

// ---------------------------------------------------------------------------
// CPA 远端认证文件 list / download
// ---------------------------------------------------------------------------

export function pickFirstDefined(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  }
  return undefined;
}

export function asBoolFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on", "disabled", "inactive"].includes(value.trim().toLowerCase());
  }
  return false;
}

export function normalizeProviderLabel(value) {
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

export function parseCpaAuthFileItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const nameRaw = pickFirstDefined(item, ["name", "file_name", "fileName", "id"]);
  if (nameRaw == null || nameRaw === "") return null;
  const name = String(nameRaw);
  const statusRaw = pickFirstDefined(item, ["status", "state"]);
  const status = statusRaw == null || statusRaw === "" ? "" : String(statusRaw).trim();
  let disabled;
  if ("disabled" in item) {
    disabled = asBoolFlag(item.disabled);
  } else {
    const statusLower = status.toLowerCase();
    disabled = statusLower === "disabled" || statusLower === "inactive";
  }
  const unavailable = "unavailable" in item ? asBoolFlag(item.unavailable) : false;
  const updatedAt = unixFromIsoOrNumber(
    pickFirstDefined(item, [
      "updated_at",
      "updatedAt",
      "modified_at",
      "modifiedAt",
      "modtime",
      "mtime",
    ])
  );
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
    unavailable,
    // 源站运行状态，如 active；快载时用于主表「账号状态」
    status,
    // 列表阶段没有 token 过期时间，先用文件更新时间占位；补全凭证后会替换为真实过期
    updatedAt: updatedAt != null && Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null,
  };
}

export function parseCpaAuthFilesListPayload(data) {
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

export async function listCpaAuthFiles(env, override = null, clientSignal = undefined) {
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

export async function downloadOneCpaAuthFile(config, fileName, clientSignal) {
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

export async function downloadCpaAuthFiles(env, names, override = null, clientSignal = undefined) {
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
