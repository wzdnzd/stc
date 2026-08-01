import {
  getAccessSetupProblem,
  buildPublicLimits,
  maxSub2apiAccounts,
  maxCpaFiles,
  maxCpaAuthDownloadFiles,
  maxSub2apiExportAccounts,
  maxSub2apiDedupeIds,
  maxSub2apiUploadAttempts,
  maxCpaUploadAttempts,
  resolveRequestedAttempts,
} from "./limits.js";
import {
  handleLogin,
  isAuthenticated,
  assertTrustedMutation,
  clearSessionCookie,
  sessionTtlHours,
} from "./auth.js";
import {
  htmlResponse,
  jsonResponse,
  withSecurityHeaders,
  renderSetupPage,
  renderLoginPage,
  securityHeaders,
} from "./responses.js";
import {
  publicTargetStatus,
  normalizeTarget,
  extractConfigOverride,
  verifyTarget,
} from "./config.js";
import { uploadSub2api, uploadCpaFiles } from "./upload.js";
import { listSub2apiProxies } from "./proxy-cache.js";
import { scanSub2apiDuplicates, applySub2apiDedupe } from "./remote/sub2api/dedupe.js";
import { listCpaAuthFiles, downloadCpaAuthFiles } from "./remote/cpa/auth-files.js";
import { listSub2apiAccountsMeta } from "./remote/sub2api/accounts.js";
import { exportSub2apiAccounts } from "./remote/sub2api/export.js";
import { transferRemoteBatch } from "./transfer.js";
import { readJsonBody } from "./http.js";
import { HttpError } from "./errors.js";
import {
  DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS,
  DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS,
} from "./constants.js";

export async function handleRequest(request, env) {
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

export async function handleApi(request, env, url) {
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
  // 上游官方接口：GET /api/v1/admin/accounts/data?ids=...&timezone=...
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
    const timezone = body?.timezone ?? body?.time_zone ?? body?.tz;
    const result = await exportSub2apiAccounts(env, ids, override, request.signal, timezone);
    return jsonResponse({ ok: true, target: "SUB2API", ...result });
  }

  // 远端互传：源站拉凭证 → 转换 → 直传目标站；完整 JSON 不回前端
  if (url.pathname === "/api/transfer/batch" && request.method === "POST") {
    const body = await readJsonBody(request, 2 * 1024 * 1024);
    const result = await transferRemoteBatch(env, body, request.signal);
    return jsonResponse({ ok: result.failedCount === 0, ...result });
  }

  throw new HttpError(404, "API 路径不存在", "NOT_FOUND");
}
