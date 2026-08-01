function apiErrorMessage(error) {
  if (!error) return "未知错误";
  if (error.name === "UploadCancelledError") return "用户已取消上传";
  if (error.name === "RemoteCancelledError") {
    return error.message || "用户已取消操作";
  }
  if (error.name === "AbortError") {
    if (uploadCancelRequested) return "用户已取消上传";
    if (sub2RemoteCancelRequested) return "用户已取消导出";
    if (cpaRemoteCancelRequested) return "用户已取消下载";
    // fetchJson 超时也用 AbortError；无取消标志时按超时处理
    if (/timeout/i.test(String(error.message || ""))) return "请求超时";
    return "请求已中断";
  }
  const raw = error.message || String(error);
  // Cloudflare 边缘连不上源站时常返回 522；与密钥无关
  if (/\b522\b/.test(raw) || /error code:\s*522/i.test(raw)) {
    return `${raw} · Cloudflare 连不上源站，请确认目标为公网 HTTPS 可达`;
  }
  if (/\b5(2[1-4]|30)\b/.test(raw)) {
    return `${raw} · 上游网络/网关错误，请检查目标是否公网可达`;
  }
  return raw;
}

async function fetchJson(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const timer = setTimeout(
    () => controller.abort(new DOMException("request timeout", "TimeoutError")),
    timeoutMs
  );
  const onExternalAbort = () =>
    controller.abort(new DOMException("upload cancelled", "AbortError"));
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const { signal: _ignoredSignal, ...fetchOptions } = options;
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (response.status === 401 && data?.code === "AUTH_REQUIRED") {
      location.reload();
      throw new Error("登录状态已失效");
    }
    if (!response.ok) {
      const detail = data?.error || data?.message || data?.code || data?.raw || response.statusText;
      const error = new Error(
        `HTTP ${response.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
      );
      error.status = response.status;
      error.code = data?.code;
      error.data = data;
      throw error;
    }
    return { response, data };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.("abort", onExternalAbort);
  }
}

function shouldRetry(error) {
  if (!error || error.name === "AbortError") return true;
  if (!error.status) return true;
  return (
    error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(task, attempts = 3, onAttempt = null) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (onAttempt) onAttempt(attempt);
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      const jitter = Math.floor(Math.random() * 250);
      await sleep(700 * 2 ** (attempt - 1) + jitter);
    }
  }
  throw lastError;
}

function updateRuntimeConfigUi() {
  for (const [target, badgeId] of [
    [TARGET_SUB2API, "badgeSub2Config"],
    [TARGET_CPA, "badgeCpaConfig"],
  ]) {
    const badge = $(badgeId);
    const local = loadLocalTarget(target);
    const envInfo = targetConfigInfo(target);
    const clickHint = `点击管理 ${target} 配置`;
    if (local) {
      badge.textContent = `${target} · 本机`;
      badge.className = "runtime-badge ok";
      badge.title = `${local.baseUrl || "本机配置"} · ${clickHint}`;
    } else if (envInfo?.configured) {
      badge.textContent = `${target} · 环境变量`;
      badge.className = "runtime-badge ok";
      badge.title = `${envInfo.baseUrl || "环境变量"} · ${clickHint}`;
    } else if (!runtimeTargetStatus) {
      badge.textContent = `${target} · …`;
      badge.className = "runtime-badge";
      badge.title = clickHint;
    } else {
      badge.textContent = `${target} · 未配置`;
      badge.className = "runtime-badge bad";
      const missing = (envInfo?.missing || []).join(", ");
      badge.title = missing ? `${missing} · ${clickHint}` : clickHint;
    }
    badge.style.cursor = "pointer";
  }
  if ($("serverConfigModal").classList.contains("show")) {
    // 仅刷新 env 回退信息，避免覆盖用户正在编辑的表单
    refreshConfigEnvFallback(configDialogTarget);
  }
  refreshSub2DedupeButton();
  refreshActionButtons();
  refreshRemoteImportUi();
}

async function loadRuntimeConfigStatus(showError = false) {
  try {
    const { data } = await fetchJson("/api/config/status", { method: "GET" }, 30000);
    runtimeTargetStatus = data;
    applyServerLimits(data);
    updateRuntimeConfigUi();
    return data;
  } catch (error) {
    runtimeTargetStatus = null;
    applyServerLimits(null);
    updateRuntimeConfigUi();
    if (showError) setConfigStatus(apiErrorMessage(error), "err");
    return null;
  }
}

function setConfigStatus(text, type = "") {
  const el = $("configStatus");
  el.textContent = text;
  el.className = `config-status ${type}`.trim();
}

function settleConfigDialog(result) {
  const resolver = configDialogResolver;
  configDialogResolver = null;
  if (resolver) resolver(result);
}

function closeConfigDialog(result = false) {
  $("serverConfigModal").classList.remove("show");
  settleConfigDialog(result);
}

function setConfigDialogTarget(target) {
  // 单目标弹窗：按当前上传/管理的目标锁定，不提供 Tab 切换
  configDialogTarget = target === TARGET_CPA ? TARGET_CPA : TARGET_SUB2API;
  $("serverConfigTitle").textContent = `${configDialogTarget} 服务器配置`;
  $("cfgAuthModeField").hidden = configDialogTarget !== TARGET_CPA;
  const help = $("cfgEnvHelp");
  if (help) {
    help.innerHTML =
      configDialogTarget === TARGET_CPA
        ? `环境变量：<code>CPA_BASE_URL</code> + <code>CPA_MANAGEMENT_KEY</code>`
        : `环境变量：<code>SUB2API_BASE_URL</code> + <code>SUB2API_ADMIN_API_KEY</code>`;
  }
  fillConfigDialogForm(configDialogTarget);
}

function refreshConfigEnvFallback(target) {
  const envInfo = targetConfigInfo(target);
  const envTag = $("cfgEnvTag");
  if (envInfo?.configured) {
    envTag.textContent = "可用";
    envTag.className = "tag tag-upload-ok";
    $("cfgEnvStatus").textContent = "已配置，可作回退";
    $("cfgEnvBaseUrl").textContent = envInfo.baseUrl || "-";
  } else if (!runtimeTargetStatus) {
    envTag.textContent = "…";
    envTag.className = "tag tag-upload-none";
    $("cfgEnvStatus").textContent = "读取中";
    $("cfgEnvBaseUrl").textContent = "-";
  } else {
    envTag.textContent = "不可用";
    envTag.className = "tag tag-upload-fail";
    const missing = envInfo?.missing?.length ? envInfo.missing.join(", ") : "未配置";
    $("cfgEnvStatus").textContent = envInfo?.urlError
      ? `地址错误：${envInfo.urlError}`
      : `缺少 ${missing}`;
    $("cfgEnvBaseUrl").textContent = envInfo?.baseUrl || "未设置";
  }
  $("cfgEnvVars").innerHTML = envInfo?.variables
    ? `<code>${escapeHtml(envInfo.variables.baseUrl)}</code> + <code>${escapeHtml(envInfo.variables.apiKey)}</code>`
    : "-";
}

function fillConfigDialogForm(target) {
  const local = loadLocalTarget(target);
  const envInfo = targetConfigInfo(target);
  // 无本机地址时，用 env 地址预填，方便改成本机配置；密钥仍需用户填写
  $("cfgBaseUrl").value = local?.baseUrl || envInfo?.baseUrl || "";
  $("cfgApiKey").value = "";
  if (local?.apiKey) {
    $("cfgApiKey").placeholder = "已保存，留空沿用";
    $("cfgApiKeyHint").textContent =
      `已保存 · ${local.apiKey.slice(0, 2)}***${local.apiKey.slice(-2)}，留空继续使用`;
  } else {
    $("cfgApiKey").placeholder = "API Key / Management Key";
    $("cfgApiKeyHint").textContent = envInfo?.configured
      ? "未保存；可关闭后直接用环境变量上传"
      : "本机未保存密钥";
  }
  if (target === TARGET_CPA) {
    $("cfgAuthMode").value = local?.cpaAuthMode || "auto";
  }
  refreshConfigEnvFallback(target);
}

function openConfigDialog(options = {}) {
  const { target = TARGET_SUB2API, reason = "", mode = "manage" } = options;
  configDialogMode = mode;
  if (configDialogResolver) settleConfigDialog(false);
  setConfigStatus(reason, reason ? "err" : "");
  $("serverConfigModal").classList.add("show");
  const ready = (async () => {
    if (!runtimeTargetStatus) await loadRuntimeConfigStatus(true);
    setConfigDialogTarget(target);
    updateRuntimeConfigUi();
  })();
  return new Promise((resolve) => {
    configDialogResolver = resolve;
    ready.catch(() => {});
  });
}

async function verifyServerConfig(target, override = null) {
  const body = { target };
  if (override?.baseUrl && override?.apiKey) {
    body.baseUrl = override.baseUrl;
    body.apiKey = override.apiKey;
    if (override.cpaAuthMode) body.cpaAuthMode = override.cpaAuthMode;
  }
  const { data } = await fetchJson(
    "/api/config/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    60000
  );
  return data;
}

async function saveAndVerifyCurrentConfigForm() {
  const target = configDialogTarget;
  const baseUrl = String($("cfgBaseUrl").value || "").trim();
  const typedKey = String($("cfgApiKey").value || "");
  const local = loadLocalTarget(target);
  const apiKey = typedKey.trim() || local?.apiKey || "";
  if (!baseUrl) {
    setConfigStatus("请填写服务器地址", "err");
    return false;
  }
  if (!apiKey) {
    setConfigStatus("请填写管理员密钥", "err");
    return false;
  }
  const override = { baseUrl, apiKey };
  if (target === TARGET_CPA) override.cpaAuthMode = $("cfgAuthMode").value || "auto";

  $("btnSaveVerifyConfig").disabled = true;
  $("btnClearLocalConfig").disabled = true;
  setConfigStatus(`正在验证 ${target} 配置…`);
  try {
    const verified = await verifyServerConfig(target, override);
    saveLocalTarget(target, override);
    updateRuntimeConfigUi();
    const okMsg = verified.message || `${target} 验证成功，已保存到本机`;
    setConfigStatus(okMsg, "ok");
    // 验证成功后自动关闭弹窗，并用 toast 提示
    closeConfigDialog(true);
    showToast(okMsg, "ok");
    return true;
  } catch (error) {
    setConfigStatus(`${target} 验证失败：${apiErrorMessage(error)}`, "err");
    return false;
  } finally {
    $("btnSaveVerifyConfig").disabled = false;
    $("btnClearLocalConfig").disabled = false;
  }
}

/**
 * 拉取可用代理 ID 列表。
 * 服务端不返回 proxy_key；forceRefresh 会跳过 Worker 内存/KV 并回写缓存。
 */
async function fetchSub2apiProxyIds(configPayload, { forceRefresh = false } = {}) {
  const body = {};
  if (configPayload) body.config = configPayload;
  if (forceRefresh) body.refresh = true;
  const { data } = await fetchJson(
    "/api/sub2api/proxies",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    60000
  );
  const rawList = Array.isArray(data?.proxyIds) ? data.proxyIds : [];
  const ids = [];
  const seen = new Set();
  for (const entry of rawList) {
    const n = Number(entry);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || seen.has(n)) continue;
    seen.add(n);
    ids.push(n);
  }
  cachedSub2ProxyIds = ids;
  cachedSub2ProxyIdSet = new Set(ids);
  return ids;
}

function setSub2DedupeStatus(text, type = "") {
  const el = $("sub2DedupeStatus");
  if (!el) return;
  el.textContent = text || "";
  el.className = `config-status ${type}`.trim();
}

function formatDedupeKeyLabel(key) {
  const raw = String(key || "");
  if (raw.startsWith("email:")) return raw.slice(6) || "(空邮箱)";
  if (raw.startsWith("name:")) return raw.slice(5) || "(空名称)";
  return raw || "-";
}

function formatDedupeAccountLine(account) {
  if (!account) return "-";
  const parts = [];
  parts.push(`id=${account.id ?? "-"}`);
  if (account.email) parts.push(account.email);
  else if (account.name) parts.push(account.name);
  if (account.status != null && account.status !== "") {
    parts.push(`状态=${account.status}`);
  }
  const exp = formatExpiryDisplay(account.expiresAt);
  if (exp) parts.push(`过期=${exp}`);
  else if (account.expiresAt == null) parts.push("过期=未知");
  return parts.join(" · ");
}

function resetSub2DedupeModalView() {
  sub2DedupeScan = null;
  sub2DedupePhase = null;
  const summary = $("sub2DedupeSummary");
  const groups = $("sub2DedupeGroups");
  if (summary) {
    summary.hidden = true;
    summary.innerHTML = "";
  }
  if (groups) {
    groups.hidden = true;
    groups.innerHTML = "";
  }
  const applyBtn = $("btnApplySub2Dedupe");
  if (applyBtn) applyBtn.hidden = true;
  const scanBtn = $("btnScanSub2Dedupe");
  if (scanBtn) {
    // 初次打开会立刻扫描；空态隐藏扫描按钮，结果页再显示「重新扫描」
    scanBtn.hidden = true;
    scanBtn.disabled = false;
    scanBtn.textContent = "重新扫描";
  }
  $("sub2DedupeHint").textContent =
    "按邮箱优先、其次名称分组检测重复，默认可自动判断保留项，也可点选调整，每组仅保留 1 条";
  setSub2DedupeStatus("");
}

function getSub2DedupeGroupMembers(group) {
  if (Array.isArray(group?.members) && group.members.length) return group.members;
  const keep = group?.keep ? [group.keep] : [];
  const del = Array.isArray(group?.delete) ? group.delete : [];
  return [...keep, ...del];
}

function normalizeSub2DedupeGroups(data) {
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  for (const group of groups) {
    const members = getSub2DedupeGroupMembers(group);
    group.members = members;
    let keepId = group?.selectedKeepId != null ? String(group.selectedKeepId) : "";
    if (!keepId && group?.keep?.id != null) keepId = String(group.keep.id);
    if (!keepId && members[0]?.id != null) keepId = String(members[0].id);
    if (!members.some((item) => String(item?.id ?? "") === keepId) && members[0]?.id != null) {
      keepId = String(members[0].id);
    }
    group.selectedKeepId = keepId;
    group.keep = members.find((item) => String(item?.id ?? "") === keepId) || members[0] || null;
    group.delete = members.filter((item) => String(item?.id ?? "") !== keepId);
    group.count = members.length;
  }
  data.groups = groups;
  data.duplicateGroupCount = groups.length;
  data.accountsInDuplicateGroups = groups.reduce(
    (sum, group) => sum + (Array.isArray(group.members) ? group.members.length : 0),
    0
  );
  data.plannedDeletionCount = groups.reduce(
    (sum, group) => sum + (Array.isArray(group.delete) ? group.delete.length : 0),
    0
  );
  return data;
}

function collectSub2DedupeDeleteIds(data = sub2DedupeScan) {
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const ids = [];
  const seen = new Set();
  for (const group of groups) {
    const keepId = String(group?.selectedKeepId ?? group?.keep?.id ?? "");
    const members = getSub2DedupeGroupMembers(group);
    for (const account of members) {
      if (account?.id == null || account?.id === "") continue;
      const marker = String(account.id);
      if (marker === keepId || seen.has(marker)) continue;
      seen.add(marker);
      ids.push(account.id);
    }
  }
  return ids;
}

function setSub2DedupeKeepSelection(groupIndex, accountId) {
  if (sub2DedupeBusy || sub2DedupePhase !== "review" || !sub2DedupeScan) return;
  const groups = Array.isArray(sub2DedupeScan.groups) ? sub2DedupeScan.groups : [];
  const group = groups[groupIndex];
  if (!group) return;
  const members = getSub2DedupeGroupMembers(group);
  const targetId = String(accountId ?? "");
  if (!members.some((item) => String(item?.id ?? "") === targetId)) return;
  group.selectedKeepId = targetId;
  group.keep = members.find((item) => String(item?.id ?? "") === targetId) || null;
  group.delete = members.filter((item) => String(item?.id ?? "") !== targetId);
  group.count = members.length;
  sub2DedupeScan.plannedDeletionCount = groups.reduce(
    (sum, row) => sum + Math.max(0, getSub2DedupeGroupMembers(row).length - 1),
    0
  );
  renderSub2DedupeScan(sub2DedupeScan, { preserveStatus: true });
}

function renderSub2DedupeScan(data, options = {}) {
  const { preserveStatus = false } = options;
  sub2DedupeScan = normalizeSub2DedupeGroups(data || { groups: [] });
  sub2DedupePhase = "review";
  const summary = $("sub2DedupeSummary");
  const groupsEl = $("sub2DedupeGroups");
  const applyBtn = $("btnApplySub2Dedupe");
  const scanBtn = $("btnScanSub2Dedupe");

  const accountCount = Number(sub2DedupeScan?.accountCount) || 0;
  const groupCount = Number(sub2DedupeScan?.duplicateGroupCount) || 0;
  const planned = Number(sub2DedupeScan?.plannedDeletionCount) || 0;
  const inGroups = Number(sub2DedupeScan?.accountsInDuplicateGroups) || 0;
  const groups = Array.isArray(sub2DedupeScan?.groups) ? sub2DedupeScan.groups : [];

  if (summary) {
    summary.hidden = false;
    summary.innerHTML = `
      <div class="dedupe-summary-card"><span class="label">扫描账号</span><span class="value">${escapeHtml(String(accountCount))}</span></div>
      <div class="dedupe-summary-card"><span class="label">重复组</span><span class="value">${escapeHtml(String(groupCount))}</span></div>
      <div class="dedupe-summary-card"><span class="label">涉及账号</span><span class="value">${escapeHtml(String(inGroups))}</span></div>
      <div class="dedupe-summary-card"><span class="label">计划删除</span><span class="value">${escapeHtml(String(planned))}</span></div>
    `;
  }

  if (groupsEl) {
    if (!groups.length) {
      groupsEl.hidden = true;
      groupsEl.innerHTML = "";
    } else {
      const preview = groups.slice(0, 40);
      groupsEl.hidden = false;
      groupsEl.innerHTML =
        preview
          .map((group, index) => {
            const members = getSub2DedupeGroupMembers(group);
            const keepId = String(group?.selectedKeepId ?? group?.keep?.id ?? "");
            const rows = members
              .map((account) => {
                const accountId = String(account?.id ?? "");
                const isKeep = accountId === keepId;
                return `<div class="dedupe-account-row">
                  <div class="dedupe-account-meta"><strong>${escapeHtml(formatDedupeAccountLine(account))}</strong></div>
                  <button
                    type="button"
                    class="dedupe-tag ${isKeep ? "keep" : "delete"}"
                    data-dedupe-keep-group="${index}"
                    data-dedupe-keep-id="${escapeHtml(accountId)}"
                    ${sub2DedupeBusy ? "disabled" : ""}
                    title="${isKeep ? "当前保留" : "点选为保留，同组其余将删除"}"
                  >${isKeep ? "保留" : "删除"}</button>
                </div>`;
              })
              .join("");
            return `<div class="dedupe-group">
              <div class="dedupe-group-head">
                <span class="dedupe-group-key">组 ${index + 1} · ${escapeHtml(formatDedupeKeyLabel(group.key))}</span>
                <span class="mono">${escapeHtml(String(group.count || members.length))} 个</span>
              </div>
              ${rows}
            </div>`;
          })
          .join("") +
        (groups.length > preview.length
          ? `<div class="hint" style="margin:4px 0 0">仅预览前 ${preview.length} 组，共 ${groups.length} 组</div>`
          : "");
    }
  }

  if (applyBtn) {
    applyBtn.hidden = planned <= 0;
    applyBtn.disabled = planned <= 0 || sub2DedupeBusy;
    applyBtn.textContent = planned > 0 ? `确认删除 ${planned} 个重复` : "确认删除重复";
  }
  if (scanBtn) {
    scanBtn.hidden = false;
    scanBtn.disabled = sub2DedupeBusy;
    if (sub2DedupeBusy) {
      scanBtn.innerHTML = '<span class="busy-spin"></span>扫描中';
    } else {
      scanBtn.textContent = "重新扫描";
    }
  }

  if (planned > 0) {
    $("sub2DedupeHint").textContent =
      `即将删除 ${planned} 个重复账号，每组仅保留 1 条，删除后不可恢复；点选标签切换保留项，每组只能保留 1 条`;
    if (!preserveStatus) {
      setSub2DedupeStatus(
        `扫描完成，共 ${accountCount} 个账号，${groupCount} 组重复，计划删除 ${planned} 个`,
        "ok"
      );
    }
  } else {
    $("sub2DedupeHint").textContent = "当前未发现可去重的重复账号，分组规则为邮箱优先、其次名称";
    if (!preserveStatus) {
      setSub2DedupeStatus(`扫描完成，共 ${accountCount} 个账号，未发现重复`, "ok");
    }
  }
}

function renderSub2DedupeApplyResult(data, plannedGroups = []) {
  const applyBtn = $("btnApplySub2Dedupe");
  const scanBtn = $("btnScanSub2Dedupe");
  const groupsEl = $("sub2DedupeGroups");
  const summary = $("sub2DedupeSummary");
  const deleted = Number(data?.deletedCount) || 0;
  const absent = Number(data?.alreadyAbsentCount) || 0;
  const failed = Number(data?.failedCount) || 0;
  const requested = Number(data?.requestedCount) || 0;
  const results = Array.isArray(data?.results) ? data.results : [];
  const resultById = new Map();
  for (const item of results) {
    if (item?.id == null || item?.id === "") continue;
    resultById.set(String(item.id), item);
  }
  for (const item of Array.isArray(data?.failures) ? data.failures : []) {
    if (item?.id == null || item?.id === "") continue;
    const key = String(item.id);
    if (!resultById.has(key)) {
      resultById.set(key, { id: item.id, status: "failed", error: item.error });
    }
  }

  sub2DedupePhase = "done";
  if (summary) {
    summary.hidden = true;
    summary.innerHTML = "";
  }

  if (groupsEl) {
    const groups = Array.isArray(plannedGroups) ? plannedGroups : [];
    if (!groups.length) {
      groupsEl.hidden = true;
      groupsEl.innerHTML = "";
    } else {
      groupsEl.hidden = false;
      groupsEl.innerHTML = groups
        .map((group, index) => {
          const members = getSub2DedupeGroupMembers(group);
          const keepId = String(group?.selectedKeepId ?? group?.keep?.id ?? "");
          const rows = members
            .map((account) => {
              const accountId = String(account?.id ?? "");
              const isKeep = accountId === keepId;
              let tagClass = "keep";
              let tagText = "已保留";
              if (!isKeep) {
                const result = resultById.get(accountId);
                const status = String(result?.status || "");
                if (status === "failed") {
                  tagClass = "failed";
                  tagText = "失败";
                } else if (status === "already_absent" || status === "deleted" || !result) {
                  tagClass = "delete";
                  tagText = "已删除";
                } else {
                  tagClass = "failed";
                  tagText = "失败";
                }
              }
              return `<div class="dedupe-account-row">
                <div class="dedupe-account-meta"><strong>${escapeHtml(formatDedupeAccountLine(account))}</strong></div>
                <span class="dedupe-tag ${tagClass}">${tagText}</span>
              </div>`;
            })
            .join("");
          return `<div class="dedupe-group">
            <div class="dedupe-group-head">
              <span class="dedupe-group-key">组 ${index + 1} · ${escapeHtml(formatDedupeKeyLabel(group.key))}</span>
              <span class="mono">${escapeHtml(String(group.count || members.length))} 个</span>
            </div>
            ${rows}
          </div>`;
        })
        .join("");
    }
  }

  if (applyBtn) applyBtn.hidden = true;
  if (scanBtn) {
    scanBtn.hidden = false;
    scanBtn.disabled = false;
    scanBtn.textContent = "再次扫描";
  }

  $("sub2DedupeHint").textContent = "删除结果如下，可再次扫描检查是否仍有重复";
  const ok = failed === 0;
  const msg =
    absent > 0
      ? `删除完成，共请求 ${requested} 次，成功：${deleted}，已不存在：${absent}，失败：${failed}`
      : `删除完成，共请求 ${requested} 次，成功：${deleted}，失败：${failed}`;
  setSub2DedupeStatus(msg, ok ? "ok" : "err");
  showMsg(msg, ok ? "ok" : "err");
  showToast(msg, ok ? "ok" : "err", 4200);
  sub2DedupeScan = null;
}

function isSub2DedupeModalOpen() {
  return Boolean($("sub2DedupeModal")?.classList.contains("show"));
}

/** 远端「服务端去重」入口：扫描中不弹窗，只置灰按钮；扫完再弹结果 */
function startSub2apiDedupe() {
  if (!hasSub2apiConfigReady()) {
    openConfigDialog({
      target: TARGET_SUB2API,
      reason: "SUB2API 去重需要有效配置",
      mode: "ensure",
    });
    showMsg("请先配置 SUB2API 后再去重", "err");
    return;
  }
  if (sub2DedupeBusy) return;
  if (uploadBusy || remoteImportBusy) {
    showMsg(remoteImportBusy ? "远端导入进行中，请稍后再去重" : "上传进行中，请稍后再去重", "err");
    return;
  }
  scanSub2apiDuplicates({ openModalOnSuccess: true }).catch((error) => {
    showMsg(`SUB2API 去重扫描失败：${apiErrorMessage(error)}`, "err");
  });
}

function closeSub2DedupeModal() {
  // 扫描/删除中禁止关闭，避免中途丢状态
  if (sub2DedupeBusy) return;
  $("sub2DedupeModal")?.classList.remove("show");
  resetSub2DedupeModalView();
}

function setSub2DedupeBusy(busy, phase = "") {
  sub2DedupeBusy = Boolean(busy);
  const scanBtn = $("btnScanSub2Dedupe");
  const applyBtn = $("btnApplySub2Dedupe");
  const closeBtn = $("btnCloseSub2Dedupe");
  const cancelBtn = $("btnCancelSub2Dedupe");
  const remoteBtn = $("btnRemoteSub2Dedupe");
  const modalOpen = isSub2DedupeModalOpen();
  if (scanBtn) {
    scanBtn.disabled = sub2DedupeBusy;
    if (sub2DedupeBusy && phase === "scan" && modalOpen) {
      scanBtn.hidden = false;
      scanBtn.innerHTML = '<span class="busy-spin"></span>扫描中';
    }
  }
  if (applyBtn) {
    applyBtn.disabled = sub2DedupeBusy || applyBtn.hidden;
    if (sub2DedupeBusy && phase === "apply" && !applyBtn.hidden) {
      applyBtn.innerHTML = '<span class="busy-spin"></span>删除中';
    }
  }
  if (closeBtn) closeBtn.disabled = sub2DedupeBusy;
  if (cancelBtn) cancelBtn.disabled = sub2DedupeBusy;
  if (remoteBtn) {
    if (sub2DedupeBusy) {
      remoteBtn.disabled = true;
      remoteBtn.innerHTML =
        phase === "apply"
          ? '<span class="busy-spin"></span>删除中'
          : '<span class="busy-spin"></span>扫描中';
    } else {
      remoteBtn.innerHTML = "服务端去重";
    }
  }
  const groupBtns = document.querySelectorAll("#sub2DedupeGroups button[data-dedupe-keep-id]");
  for (const btn of groupBtns) btn.disabled = sub2DedupeBusy || sub2DedupePhase !== "review";
  refreshRemoteActionButtons();
}

async function scanSub2apiDuplicates(options = {}) {
  const { openModalOnSuccess = false } = options;
  if (sub2DedupeBusy) return;
  if (uploadBusy || remoteImportBusy) {
    const msg = remoteImportBusy ? "远端导入进行中，请稍后再扫描" : "上传进行中，请稍后再扫描";
    if (isSub2DedupeModalOpen()) setSub2DedupeStatus(msg, "err");
    else showMsg(msg, "err");
    return;
  }
  const effective = getEffectiveClientConfig(TARGET_SUB2API);
  if (!effective) {
    if (isSub2DedupeModalOpen()) setSub2DedupeStatus("请先配置 SUB2API", "err");
    else showMsg("请先配置 SUB2API", "err");
    return;
  }

  const modalOpen = isSub2DedupeModalOpen();
  // 结果页内重新扫描：保留当前列表，仅按钮进入「扫描中」；扫完再原地更新
  if (modalOpen) {
    setSub2DedupeStatus("正在扫描重复账号", "info");
  }

  setSub2DedupeBusy(true, "scan");
  showMsg("正在扫描重复账号", "info");
  try {
    const body = {};
    const config = uploadConfigPayload(effective);
    if (config) body.config = config;
    const { data } = await fetchJson(
      "/api/sub2api/dedupe/scan",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      10 * 60 * 1000
    );
    // 首次从外部入口：扫完再弹结果；结果页内：原地刷新，不切换到空扫描态
    if (openModalOnSuccess || isSub2DedupeModalOpen()) {
      if (!isSub2DedupeModalOpen()) {
        resetSub2DedupeModalView();
        $("sub2DedupeModal")?.classList.add("show");
      }
      renderSub2DedupeScan(data);
    } else {
      sub2DedupeScan = normalizeSub2DedupeGroups(data || { groups: [] });
      sub2DedupePhase = "review";
    }
    const planned = Number(sub2DedupeScan?.plannedDeletionCount) || 0;
    showMsg(
      planned > 0
        ? `扫描完成，发现 ${sub2DedupeScan.duplicateGroupCount} 组重复，计划删除 ${planned} 个`
        : `扫描完成，共 ${sub2DedupeScan?.accountCount || 0} 个账号，未发现重复`,
      planned > 0 ? "info" : "ok"
    );
  } catch (error) {
    if (isSub2DedupeModalOpen()) {
      setSub2DedupeStatus(`扫描失败：${apiErrorMessage(error)}`, "err");
    }
    showMsg(`SUB2API 去重扫描失败：${apiErrorMessage(error)}`, "err");
  } finally {
    setSub2DedupeBusy(false);
    if (sub2DedupeScan && sub2DedupePhase === "review" && isSub2DedupeModalOpen()) {
      renderSub2DedupeScan(sub2DedupeScan, { preserveStatus: true });
    } else if (isSub2DedupeModalOpen()) {
      const scanBtn = $("btnScanSub2Dedupe");
      if (scanBtn) {
        scanBtn.hidden = false;
        scanBtn.disabled = false;
        scanBtn.textContent = "重新扫描";
      }
    }
  }
}

async function applySub2apiDuplicates() {
  if (sub2DedupeBusy) return;
  if (uploadBusy || remoteImportBusy) {
    setSub2DedupeStatus(
      remoteImportBusy ? "远端导入进行中，请稍后再删除" : "上传进行中，请稍后再删除",
      "err"
    );
    return;
  }
  if (!sub2DedupeScan || sub2DedupePhase !== "review") {
    setSub2DedupeStatus("请先扫描重复账号", "err");
    return;
  }
  const plannedGroups = Array.isArray(sub2DedupeScan.groups)
    ? sub2DedupeScan.groups.map((group) => ({
        key: group.key,
        count: group.count,
        selectedKeepId: group.selectedKeepId,
        keep: group.keep,
        delete: Array.isArray(group.delete) ? group.delete.slice() : [],
        members: getSub2DedupeGroupMembers(group).slice(),
      }))
    : [];
  const ids = collectSub2DedupeDeleteIds(sub2DedupeScan);
  if (!ids.length) {
    setSub2DedupeStatus("没有可删除的重复账号", "err");
    return;
  }

  const effective = getEffectiveClientConfig(TARGET_SUB2API);
  if (!effective) {
    setSub2DedupeStatus("请先配置 SUB2API", "err");
    return;
  }

  const maxPerRequest = currentMaxSub2apiDedupe();
  const chunks = chunkArray(ids, Math.max(1, maxPerRequest));
  setSub2DedupeBusy(true, "apply");
  setSub2DedupeStatus(
    chunks.length > 1
      ? `正在删除 ${ids.length} 个重复账号，分 ${chunks.length} 批`
      : `正在并发删除 ${ids.length} 个重复账号`,
    "info"
  );
  showMsg(`正在删除 ${ids.length} 个 SUB2API 重复账号`, "info");
  try {
    const config = uploadConfigPayload(effective);
    const merged = {
      requestedCount: 0,
      deletedCount: 0,
      alreadyAbsentCount: 0,
      failedCount: 0,
      results: [],
      failures: [],
    };
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunks.length > 1) {
        setSub2DedupeStatus(
          `正在删除第 ${i + 1}/${chunks.length} 批，本批 ${chunk.length} 个，累计已删 ${merged.deletedCount} 个`,
          "info"
        );
      }
      const body = { ids: chunk };
      if (config) body.config = config;
      const { data } = await fetchJson(
        "/api/sub2api/dedupe/apply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        10 * 60 * 1000
      );
      merged.requestedCount += Number(data?.requestedCount) || chunk.length;
      merged.deletedCount += Number(data?.deletedCount) || 0;
      merged.alreadyAbsentCount += Number(data?.alreadyAbsentCount) || 0;
      merged.failedCount += Number(data?.failedCount) || 0;
      if (Array.isArray(data?.results)) merged.results.push(...data.results);
      if (Array.isArray(data?.failures)) merged.failures.push(...data.failures);
      await yieldToBrowser();
    }
    renderSub2DedupeApplyResult(merged, plannedGroups);
  } catch (error) {
    setSub2DedupeStatus(`删除失败：${apiErrorMessage(error)}`, "err");
    showMsg(`SUB2API 去重删除失败：${apiErrorMessage(error)}`, "err");
    const applyBtn = $("btnApplySub2Dedupe");
    const planned = collectSub2DedupeDeleteIds(sub2DedupeScan).length;
    if (applyBtn && planned > 0) {
      applyBtn.hidden = false;
      applyBtn.disabled = false;
      applyBtn.textContent = `确认删除 ${planned} 个重复`;
    }
  } finally {
    setSub2DedupeBusy(false);
  }
}

// ---------------------------------------------------------------------------
// 远端 CPA 下载 / SUB2API 导出
// ---------------------------------------------------------------------------
