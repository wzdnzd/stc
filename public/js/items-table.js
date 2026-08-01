var $ = (id) => document.getElementById(id);
var dropzone = $("dropzone");
var fileInput = $("fileInput");
var tbody = $("tbody");
var msgEl = $("msg");

function showMsg(text, type = "info") {
  msgEl.textContent = text;
  msgEl.className = "msg show " + type;
}
function clearMsg() {
  msgEl.className = "msg";
  msgEl.textContent = "";
}

function showToast(text, type = "info", durationMs = 3200) {
  const host = $("toastHost");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = text;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  const hideMs = Math.max(1200, Number(durationMs) || 3200);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 220);
  }, hideMs);
}

function makeItemId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 解析代理 ID：空/无效 → null；0 与正整数保留 */
function parseProxyId(value) {
  return AccountConvert.parseProxyId(value);
}

function extractProxyIdFromAccount(account) {
  return AccountConvert.extractProxyIdFromAccount(account);
}

function getItemProxyId(item) {
  if (!item) return null;
  if (item.proxyId != null) return parseProxyId(item.proxyId);
  return extractProxyIdFromAccount(item.account);
}

function setItemProxyId(item, proxyId, { markConvertedDirty = true } = {}) {
  if (!item) return;
  const normalized = parseProxyId(proxyId);
  item.proxyId = normalized;
  item.proxyValid = null;
  if (item.account && typeof item.account === "object") {
    if (normalized == null) delete item.account.proxy_id;
    else item.account.proxy_id = normalized;
  }
  if (markConvertedDirty && item.converted && item.targetFormat === TARGET_SUB2API) {
    item.converted = null;
    item.targetFormat = null;
    converted = false;
  }
  scheduleWorkspaceSave();
}

function clearProxyValidity(itemsOrAll = null) {
  const list = Array.isArray(itemsOrAll) ? itemsOrAll : items;
  for (const item of list) item.proxyValid = null;
}

function readDefaultProxyId() {
  return parseProxyId($("defaultProxyId")?.value);
}

function applyDefaultProxyToItems(list) {
  const defaultId = readDefaultProxyId();
  if (defaultId == null) return 0;
  let filled = 0;
  for (const item of list) {
    if (getItemProxyId(item) != null) continue;
    setItemProxyId(item, defaultId, { markConvertedDirty: true });
    filled += 1;
  }
  return filled;
}

function applyProxyIdToAccountPayload(account, proxyId) {
  return AccountConvert.applyProxyIdToAccountPayload(account, proxyId);
}

/** 从页面读取转换/补全选项，供本地转换与远端直传共用 */
function readConvertOptionsFromUi(extra = {}) {
  return AccountConvert.normalizeConvertOptions({
    nameStrategy: $("nameStrategy")?.value || "email",
    concurrency: $("concurrency")?.value || 1,
    priority: $("priority")?.value || 1,
    rateMultiplier: $("rateMultiplier")?.value || 1,
    autoPauseOnExpired: Boolean($("autoPause")?.checked),
    keepSso: Boolean($("keepSso")?.checked),
    keepHeaders: Boolean($("keepHeaders")?.checked),
    defaultProxyId: readDefaultProxyId(),
    ...extra,
  });
}

function prepareItem(item) {
  const base = {
    id: makeItemId(),
    selected: false,
    uploadStatus: UPLOAD_STATUS.NONE,
    uploadTarget: "",
    uploadMessage: "",
    uploadAttempts: 0,
    exportStatus: EXPORT_STATUS.NONE,
    exportTarget: "",
    exportMessage: "",
    accountStatus: ACCOUNT_STATUS.UNKNOWN,
    expiresAt: null,
    proxyId: null,
    proxyValid: null,
    needsHydration: false,
    remoteOrigin: null,
    remoteRef: null,
    ...item,
  };
  if (base.proxyId == null) {
    base.proxyId = extractProxyIdFromAccount(base.account);
  } else {
    base.proxyId = parseProxyId(base.proxyId);
  }
  if (base.remoteOrigin != null) {
    const origin = String(base.remoteOrigin || "").toUpperCase();
    base.remoteOrigin =
      origin === TARGET_SUB2API || origin === "SUB2API"
        ? TARGET_SUB2API
        : origin === TARGET_CPA || origin === "CPA"
          ? TARGET_CPA
          : null;
  }
  if (base.remoteRef != null && typeof base.remoteRef !== "object") {
    base.remoteRef = null;
  }
  base.needsHydration = Boolean(base.needsHydration);
  const expiry = resolveAccountExpiry(base);
  base.expiresAt = expiry.expiresAt;
  base.accountStatus = expiry.accountStatus;
  return base;
}

function itemNeedsHydration(item) {
  return Boolean(item?.needsHydration && item.remoteRef && !item.error);
}

function itemRemoteOrigin(item) {
  if (!item) return null;
  if (item.remoteOrigin === TARGET_CPA || item.remoteOrigin === TARGET_SUB2API) {
    return item.remoteOrigin;
  }
  return null;
}

function listHasRemoteOrigin(target) {
  return items.some((item) => itemRemoteOrigin(item) === target);
}

function refreshPendingRemoteHydrationFlag() {
  hasPendingRemoteHydration = items.some((item) => itemNeedsHydration(item));
  return hasPendingRemoteHydration;
}

function sameSideUploadBlocked(target) {
  return listHasRemoteOrigin(target);
}

/**
 * 从源账号解析过期时间：
 * - CPA：account.expired（ISO）或 _exp
 * - SUB2API：credentials.expires_at（unix 秒）
 */
function resolveAccountExpiry(item) {
  if (!item?.account || item.error) {
    return { expiresAt: null, accountStatus: ACCOUNT_STATUS.UNKNOWN };
  }
  let expiresAt = null;
  if (item.sourceFormat === "cpa") {
    expiresAt =
      unixFromIsoOrNumber(item.account.expired) ||
      (item.account._exp != null ? Number(item.account._exp) : null) ||
      null;
  } else if (item.sourceFormat === "sub2api") {
    const cred = item.account.credentials || {};
    expiresAt = unixFromIsoOrNumber(cred.expires_at) || null;
  }
  if (expiresAt == null || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { expiresAt: null, accountStatus: ACCOUNT_STATUS.UNKNOWN };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    expiresAt,
    accountStatus: expiresAt < nowSec ? ACCOUNT_STATUS.EXPIRED : ACCOUNT_STATUS.VALID,
  };
}

function refreshAccountExpiry(item) {
  if (!item) return item;
  const expiry = resolveAccountExpiry(item);
  item.expiresAt = expiry.expiresAt;
  item.accountStatus = expiry.accountStatus;
  return item;
}

function isAccountExpired(item) {
  refreshAccountExpiry(item);
  return item?.accountStatus === ACCOUNT_STATUS.EXPIRED;
}

function accountStatusLabel(status) {
  if (status === ACCOUNT_STATUS.VALID) return "有效";
  if (status === ACCOUNT_STATUS.EXPIRED) return "失效";
  return "未知";
}

function formatExpiryDisplay(sec) {
  if (sec == null || sec === "") return "";
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function accountStatusHtml(item) {
  if (item.error || !item.account) {
    return `<span class="tag tag-account-unknown">—</span>`;
  }
  if (item.accountStatus === ACCOUNT_STATUS.VALID) {
    return `<span class="tag tag-account-valid">有效</span>`;
  }
  if (item.accountStatus === ACCOUNT_STATUS.EXPIRED) {
    return `<span class="tag tag-account-expired">失效</span>`;
  }
  return `<span class="tag tag-account-unknown">未知</span>`;
}

function accountExpiryHtml(item) {
  if (item.error || !item.account) {
    return `<span class="mono">—</span>`;
  }
  const text = formatExpiryDisplay(item.expiresAt);
  if (!text) return `<span class="mono">—</span>`;
  return `<span class="mono" title="${escapeHtml(text)}">${escapeHtml(text)}</span>`;
}

function shouldSkipExpiredAccounts() {
  const value = $("skipExpiredAccounts")?.value || DEFAULT_SKIP_EXPIRED_ACCOUNTS;
  return value !== "include";
}

/** 导出/上传候选：按选项过滤失效账号 */
function filterExportOrUploadItems(list, { announce = false, actionLabel = "处理" } = {}) {
  const source = Array.isArray(list) ? list : [];
  if (!shouldSkipExpiredAccounts()) {
    return { items: source, skipped: [] };
  }
  const items = [];
  const skipped = [];
  for (const item of source) {
    if (isAccountExpired(item)) skipped.push(item);
    else items.push(item);
  }
  if (announce && skipped.length) {
    showMsg(
      `${actionLabel}时跳过 ${skipped.length} 个失效账号，剩余 ${items.length} 个`,
      items.length ? "info" : "err"
    );
  }
  return { items, skipped };
}

function resolveItemTargetKey(item) {
  if (!item || item.error) return "skip";
  if (item.targetFormat === "cpa") return "cpa";
  if (item.targetFormat === TARGET_SUB2API) return "sub2api";
  const dir = $("direction")?.value;
  if (dir === "to-cpa") return "cpa";
  if (dir === "to-SUB2API") return "sub2api";
  if (item.sourceFormat === "cpa") return "sub2api";
  if (item.sourceFormat === "sub2api") return "cpa";
  return "";
}

function isItemConverted(item) {
  if (!item || item.error) return false;
  if (itemNeedsHydration(item)) return false;
  if (item.converted) return true;
  // 导出/上传成功意味着当时已完成转换；代理变更等可能清掉 converted 缓存，仍按已处理展示
  if (item.exportStatus === EXPORT_STATUS.SUCCESS) return true;
  if (item.uploadStatus === UPLOAD_STATUS.SUCCESS) return true;
  return false;
}

function convertSortRank(item) {
  if (item.error) return 3;
  if (itemNeedsHydration(item)) return 0;
  if (isItemConverted(item)) return 2;
  return 1;
}

function exportSortRank(item) {
  switch (item.exportStatus) {
    case EXPORT_STATUS.NONE:
      return 0;
    case EXPORT_STATUS.PREPARING:
      return 1;
    case EXPORT_STATUS.SUCCESS:
      return 2;
    case EXPORT_STATUS.FAILED:
      return 3;
    default:
      return 8;
  }
}

function accountStatusSortRank(item) {
  if (item.error || !item.account) return 9;
  if (item.accountStatus === ACCOUNT_STATUS.VALID) return 1;
  if (item.accountStatus === ACCOUNT_STATUS.UNKNOWN) return 2;
  if (item.accountStatus === ACCOUNT_STATUS.EXPIRED) return 3;
  return 8;
}

function uploadSortRank(item) {
  if (item.uploadMessage && String(item.uploadMessage).startsWith("已跳过")) return 7;
  switch (item.uploadStatus) {
    case UPLOAD_STATUS.NONE:
      return 0;
    case UPLOAD_STATUS.QUEUED:
      return 1;
    case UPLOAD_STATUS.UPLOADING:
      return 2;
    case UPLOAD_STATUS.SUCCESS:
      return 3;
    case UPLOAD_STATUS.FAILED:
      return 4;
    case UPLOAD_STATUS.UNKNOWN:
      return 5;
    case UPLOAD_STATUS.CANCELLED:
      return 6;
    default:
      return 8;
  }
}

function compareNullableNumber(a, b) {
  const aEmpty = a == null || !Number.isFinite(Number(a));
  const bEmpty = b == null || !Number.isFinite(Number(b));
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  return Number(a) - Number(b);
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

function getSortValue(item, index, key) {
  switch (key) {
    case "index":
      return index;
    case "sourceFile":
      return item.sourceFile || "";
    case "source":
      return item.sourceFormat || "";
    case "target":
      return resolveItemTargetKey(item);
    case "email":
      return accountLabel(item);
    case "accountStatus":
      return accountStatusSortRank(item);
    case "expiresAt":
      return item.expiresAt;
    case "proxyId":
      return getItemProxyId(item);
    case "convert":
      return convertSortRank(item);
    case "export":
      return exportSortRank(item);
    case "upload":
      return uploadSortRank(item);
    default:
      return index;
  }
}

function compareSortValues(a, b, key) {
  if (key === "expiresAt" || key === "proxyId" || key === "index") {
    return compareNullableNumber(a, b);
  }
  if (key === "accountStatus" || key === "convert" || key === "export" || key === "upload") {
    return Number(a) - Number(b);
  }
  return compareText(a, b);
}

function sortVisibleRows(rows) {
  const key = tableSort.key;
  if (!key) return rows;
  const dir = tableSort.dir === "desc" ? -1 : 1;
  return rows.slice().sort((left, right) => {
    const av = getSortValue(left.item, left.index, key);
    const bv = getSortValue(right.item, right.index, key);
    const cmp = compareSortValues(av, bv, key);
    if (cmp !== 0) return cmp * dir;
    return left.index - right.index;
  });
}

function syncSortHeaders() {
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    const key = th.getAttribute("data-sort") || "";
    const active = Boolean(tableSort.key) && tableSort.key === key;
    th.classList.toggle("is-sorted", active);
    th.classList.toggle("is-sorted-asc", active && tableSort.dir === "asc");
    th.classList.toggle("is-sorted-desc", active && tableSort.dir === "desc");
    th.setAttribute(
      "aria-sort",
      active ? (tableSort.dir === "asc" ? "ascending" : "descending") : "none"
    );
  });
}

function toggleTableSort(key) {
  if (!key) return;
  if (tableSort.key === key) {
    if (tableSort.dir === "asc") tableSort = { key, dir: "desc" };
    else tableSort = { key: "", dir: "asc" };
  } else {
    tableSort = { key, dir: "asc" };
  }
  renderTable();
}

function getVisibleItems() {
  const q = tableSearch.trim().toLowerCase();
  let rows = items.map((item, index) => ({ item, index }));
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    rows = rows.filter(({ item }) => {
      const proxyId = getItemProxyId(item);
      const haystack = [
        item.sourceFile,
        item.sourceFormat,
        item.targetFormat,
        accountLabel(item),
        item.uploadTarget,
        item.uploadMessage,
        item.uploadStatus,
        item.exportTarget,
        item.exportMessage,
        item.exportStatus,
        item.exportStatus === EXPORT_STATUS.NONE
          ? "未导出"
          : item.exportStatus === EXPORT_STATUS.PREPARING
            ? "准备中"
            : item.exportStatus === EXPORT_STATUS.SUCCESS
              ? "已导出"
              : item.exportStatus === EXPORT_STATUS.FAILED
                ? "导出失败"
                : "",
        accountStatusLabel(item.accountStatus),
        item.accountStatus,
        formatExpiryDisplay(item.expiresAt),
        proxyId == null ? "" : String(proxyId),
        proxyId == null ? "无代理" : "有代理",
        item.proxyValid === false ? "无效代理" : "",
        item.proxyValid === true ? "合法代理" : "",
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }
  return sortVisibleRows(rows);
}

function getOperationItems() {
  const usable = (item) => !item.error && (Boolean(item.account) || itemNeedsHydration(item));
  if (!selectionMode) return items.filter(usable);
  return items.filter((item) => item.selected && usable(item));
}

function selectedCount() {
  return items.filter((item) => item.selected).length;
}

function syncTableControls() {
  const panel = $("tableControlPanel");
  const selection = $("selectionToolbar");
  const search = $("searchToolbar");
  selection.classList.toggle("show", selectionMode);
  search.classList.toggle("show", searchVisible);
  panel.classList.toggle("show", selectionMode || searchVisible);
  $("btnSelectMode").classList.toggle("active", selectionMode);
  $("btnSearchToggle").classList.toggle("active", searchVisible);
  $("selectedCount").textContent = String(selectedCount());
  const visible = getVisibleItems().length;
  $("searchResultCount").textContent = tableSearch
    ? `匹配 ${visible}，共 ${items.length}`
    : `共 ${items.length}`;
}

function targetConfigInfo(target) {
  return runtimeTargetStatus?.targets?.[target] || null;
}

function readAllLocalConfigs() {
  try {
    const raw = localStorage.getItem(LOCAL_CONFIG_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    try {
      localStorage.removeItem(LOCAL_CONFIG_STORAGE_KEY);
    } catch {}
    return {};
  }
}

function writeAllLocalConfigs(all) {
  localStorage.setItem(LOCAL_CONFIG_STORAGE_KEY, JSON.stringify(all || {}));
}

function loadLocalTarget(target) {
  const entry = readAllLocalConfigs()[target];
  if (!entry || typeof entry !== "object") return null;
  const baseUrl = String(entry.baseUrl || "").trim();
  const apiKey = String(entry.apiKey || "").trim();
  if (!baseUrl || !apiKey) return null;
  const cfg = { baseUrl, apiKey, savedAt: entry.savedAt || "" };
  if (target === TARGET_CPA) {
    const mode = String(entry.cpaAuthMode || "auto").toLowerCase();
    cfg.cpaAuthMode = ["auto", "bearer", "x-management-key"].includes(mode) ? mode : "auto";
  }
  return cfg;
}

function saveLocalTarget(target, cfg) {
  const all = readAllLocalConfigs();
  const next = {
    baseUrl: String(cfg.baseUrl || "").trim(),
    apiKey: String(cfg.apiKey || "").trim(),
    savedAt: new Date().toISOString(),
  };
  if (!next.baseUrl || !next.apiKey) {
    throw new Error("本机配置必须同时包含服务器地址和密钥");
  }
  if (target === TARGET_CPA) {
    next.cpaAuthMode = String(cfg.cpaAuthMode || "auto");
  }
  all[target] = next;
  writeAllLocalConfigs(all);
  return next;
}

function clearLocalTarget(target) {
  const all = readAllLocalConfigs();
  delete all[target];
  writeAllLocalConfigs(all);
}

function getEffectiveClientConfig(target) {
  const local = loadLocalTarget(target);
  if (local) {
    return {
      source: "local",
      baseUrl: local.baseUrl,
      apiKey: local.apiKey,
      cpaAuthMode: local.cpaAuthMode,
    };
  }
  if (targetConfigInfo(target)?.configured) {
    return { source: "env" };
  }
  return null;
}

function uploadConfigPayload(effective) {
  if (!effective || effective.source !== "local") return undefined;
  const payload = {
    baseUrl: effective.baseUrl,
    apiKey: effective.apiKey,
  };
  if (effective.cpaAuthMode) payload.cpaAuthMode = effective.cpaAuthMode;
  return payload;
}

function targetConfigTooltip(target) {
  const effective = getEffectiveClientConfig(target);
  if (effective?.source === "local") {
    return `${target} 使用本机配置 · ${effective.baseUrl}；点击后会先验证`;
  }
  if (effective?.source === "env") {
    const baseUrl = targetConfigInfo(target)?.baseUrl || "";
    return `${target} 使用 Worker 环境变量${baseUrl ? ` · ${baseUrl}` : ""}；点击后会先验证`;
  }
  return `${target} 尚未配置；点击上传将引导填写本机配置，也可依赖 Worker 环境变量`;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function currentMaxBatch(target) {
  if (target === TARGET_SUB2API) {
    return Math.max(1, Number(serverLimits.maxSub2apiAccounts) || FALLBACK_MAX_SUB2API);
  }
  return Math.max(1, Number(serverLimits.maxCpaFiles) || FALLBACK_MAX_CPA);
}

function currentMaxUploadConcurrency(target) {
  if (target === TARGET_SUB2API) {
    return Math.max(
      1,
      Number(serverLimits.maxUploadConcurrencySub2api) || FALLBACK_MAX_UPLOAD_CONCURRENCY_SUB2
    );
  }
  return Math.max(
    1,
    Number(serverLimits.maxUploadConcurrencyCpa) || FALLBACK_MAX_UPLOAD_CONCURRENCY_CPA
  );
}

function currentMaxUploadAttempts(target) {
  if (target === TARGET_SUB2API) {
    return Math.max(
      1,
      Number(serverLimits.maxSub2apiUploadAttempts) || FALLBACK_MAX_UPLOAD_ATTEMPTS
    );
  }
  return Math.max(1, Number(serverLimits.maxCpaUploadAttempts) || FALLBACK_MAX_UPLOAD_ATTEMPTS);
}

function defaultBatchSize(target) {
  const max = currentMaxBatch(target);
  const preferred = target === TARGET_SUB2API ? DEFAULT_BATCH_SUB2API : DEFAULT_BATCH_CPA;
  return Math.min(preferred, max);
}

function readUiSettings() {
  try {
    const raw = localStorage.getItem(LOCAL_UI_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    try {
      localStorage.removeItem(LOCAL_UI_SETTINGS_KEY);
    } catch {}
    return {};
  }
}

function normalizeThemeMode(value) {
  const mode = String(value || "").trim();
  return mode === "light" || mode === "dark" || mode === "auto" ? mode : "dark";
}

function resolveTheme(mode) {
  const normalized = normalizeThemeMode(mode);
  if (normalized === "light" || normalized === "dark") return normalized;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function getThemeMode() {
  const attr = document.documentElement.getAttribute("data-theme-mode");
  if (attr === "light" || attr === "dark" || attr === "auto") return attr;
  return normalizeThemeMode(readUiSettings().theme);
}

function syncThemeSwitchUi(mode = getThemeMode()) {
  const normalized = normalizeThemeMode(mode);
  const root = $("themeSwitch");
  if (!root) return;
  root.querySelectorAll("[data-theme-mode]").forEach((btn) => {
    const active = btn.getAttribute("data-theme-mode") === normalized;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function applyThemeMode(mode, { persist = true } = {}) {
  const normalized = normalizeThemeMode(mode);
  const resolved = resolveTheme(normalized);
  document.documentElement.setAttribute("data-theme-mode", normalized);
  document.documentElement.setAttribute("data-theme", resolved);
  syncThemeSwitchUi(normalized);
  if (persist) saveUiSettingsSoon();
  return resolved;
}

function collectUiSettings() {
  return {
    direction: $("direction")?.value || "auto",
    nameStrategy: $("nameStrategy")?.value || "email",
    concurrency: $("concurrency")?.value || "1",
    priority: $("priority")?.value || "1",
    rateMultiplier: $("rateMultiplier")?.value || "1",
    defaultProxyId:
      $("defaultProxyId")?.value === "" || $("defaultProxyId")?.value == null
        ? ""
        : String($("defaultProxyId").value),
    autoPause: Boolean($("autoPause")?.checked),
    keepSso: Boolean($("keepSso")?.checked),
    keepHeaders: Boolean($("keepHeaders")?.checked),
    batchSub2: $("batchSub2")?.value || String(DEFAULT_BATCH_SUB2API),
    batchCpa: $("batchCpa")?.value || String(DEFAULT_BATCH_CPA),
    uploadConcurrencySub2: $("uploadConcurrencySub2")?.value || String(DEFAULT_UPLOAD_CONCURRENCY),
    uploadConcurrencyCpa: $("uploadConcurrencyCpa")?.value || String(DEFAULT_UPLOAD_CONCURRENCY),
    sub2UploadAttempts: $("sub2UploadAttempts")?.value || String(DEFAULT_UPLOAD_ATTEMPTS),
    cpaUploadAttempts: $("cpaUploadAttempts")?.value || String(DEFAULT_UPLOAD_ATTEMPTS),
    sub2AmbiguousRetry: $("sub2AmbiguousRetry")?.value || DEFAULT_SUB2_AMBIGUOUS_RETRY,
    skipExpiredAccounts: $("skipExpiredAccounts")?.value || DEFAULT_SKIP_EXPIRED_ACCOUNTS,
    theme: getThemeMode(),
    savedAt: new Date().toISOString(),
  };
}

function saveUiSettingsSoon() {
  clearTimeout(uiSettingsSaveTimer);
  uiSettingsSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LOCAL_UI_SETTINGS_KEY, JSON.stringify(collectUiSettings()));
    } catch {}
  }, 120);
}

function applyUiSettings(settings = {}) {
  const setVal = (id, value) => {
    if (value === undefined || value === null || !$(id)) return;
    $(id).value = String(value);
  };
  const setCheck = (id, value, fallback = true) => {
    if (!$(id)) return;
    $(id).checked = value === undefined ? fallback : Boolean(value);
  };
  setVal("direction", settings.direction || "auto");
  setVal("nameStrategy", settings.nameStrategy || "email");
  setVal("concurrency", settings.concurrency ?? "1");
  setVal("priority", settings.priority ?? "1");
  setVal("rateMultiplier", settings.rateMultiplier ?? "1");
  if (settings.defaultProxyId === "" || settings.defaultProxyId == null) {
    if ($("defaultProxyId")) $("defaultProxyId").value = "";
  } else {
    setVal("defaultProxyId", settings.defaultProxyId);
  }
  setCheck("autoPause", settings.autoPause, true);
  setCheck("keepSso", settings.keepSso, true);
  setCheck("keepHeaders", settings.keepHeaders, true);
  setVal("batchSub2", settings.batchSub2 ?? String(defaultBatchSize(TARGET_SUB2API)));
  setVal("batchCpa", settings.batchCpa ?? String(defaultBatchSize(TARGET_CPA)));
  setVal(
    "uploadConcurrencySub2",
    settings.uploadConcurrencySub2 ?? String(DEFAULT_UPLOAD_CONCURRENCY)
  );
  setVal(
    "uploadConcurrencyCpa",
    settings.uploadConcurrencyCpa ?? String(DEFAULT_UPLOAD_CONCURRENCY)
  );
  setVal("sub2UploadAttempts", settings.sub2UploadAttempts ?? String(DEFAULT_UPLOAD_ATTEMPTS));
  setVal("cpaUploadAttempts", settings.cpaUploadAttempts ?? String(DEFAULT_UPLOAD_ATTEMPTS));
  const ambiguous = String(settings.sub2AmbiguousRetry || DEFAULT_SUB2_AMBIGUOUS_RETRY);
  $("sub2AmbiguousRetry").value = ["none", "auto", "confirm"].includes(ambiguous)
    ? ambiguous
    : DEFAULT_SUB2_AMBIGUOUS_RETRY;
  const skipExpired = String(settings.skipExpiredAccounts || DEFAULT_SKIP_EXPIRED_ACCOUNTS);
  $("skipExpiredAccounts").value = ["skip", "include"].includes(skipExpired)
    ? skipExpired
    : DEFAULT_SKIP_EXPIRED_ACCOUNTS;
  applyThemeMode(settings.theme || getThemeMode(), { persist: false });
}

function updateUploadLimitHints() {
  const maxSub2 = currentMaxBatch(TARGET_SUB2API);
  const maxCpa = currentMaxBatch(TARGET_CPA);
  const maxConcSub2 = currentMaxUploadConcurrency(TARGET_SUB2API);
  const maxConcCpa = currentMaxUploadConcurrency(TARGET_CPA);
  const maxAttemptsSub2 = currentMaxUploadAttempts(TARGET_SUB2API);
  const maxAttemptsCpa = currentMaxUploadAttempts(TARGET_CPA);

  const batchSub2 = $("batchSub2");
  const batchCpa = $("batchCpa");
  batchSub2.min = "1";
  batchSub2.max = String(maxSub2);
  batchCpa.min = "1";
  batchCpa.max = String(maxCpa);
  $("batchSub2Hint").textContent = `上限：${maxSub2}`;
  $("batchCpaHint").textContent = `上限：${maxCpa}`;
  batchSub2.value = String(clampInt(batchSub2.value, 1, maxSub2, defaultBatchSize(TARGET_SUB2API)));
  batchCpa.value = String(clampInt(batchCpa.value, 1, maxCpa, defaultBatchSize(TARGET_CPA)));

  const concSub2 = $("uploadConcurrencySub2");
  const concCpa = $("uploadConcurrencyCpa");
  concSub2.min = "1";
  concSub2.max = String(maxConcSub2);
  concCpa.min = "1";
  concCpa.max = String(maxConcCpa);
  $("uploadConcurrencySub2Hint").textContent = `上限：${maxConcSub2}`;
  $("uploadConcurrencyCpaHint").textContent = `上限：${maxConcCpa}`;
  concSub2.value = String(clampInt(concSub2.value, 1, maxConcSub2, DEFAULT_UPLOAD_CONCURRENCY));
  concCpa.value = String(clampInt(concCpa.value, 1, maxConcCpa, DEFAULT_UPLOAD_CONCURRENCY));

  const attemptsSub2 = $("sub2UploadAttempts");
  const attemptsCpa = $("cpaUploadAttempts");
  attemptsSub2.min = "1";
  attemptsSub2.max = String(maxAttemptsSub2);
  attemptsCpa.min = "1";
  attemptsCpa.max = String(maxAttemptsCpa);
  $("sub2UploadAttemptsHint").textContent = `含首次 · 上限：${maxAttemptsSub2}`;
  $("cpaUploadAttemptsHint").textContent = `含首次 · 上限：${maxAttemptsCpa}`;
  attemptsSub2.value = String(
    clampInt(
      attemptsSub2.value,
      1,
      maxAttemptsSub2,
      Math.min(DEFAULT_UPLOAD_ATTEMPTS, maxAttemptsSub2)
    )
  );
  attemptsCpa.value = String(
    clampInt(
      attemptsCpa.value,
      1,
      maxAttemptsCpa,
      Math.min(DEFAULT_UPLOAD_ATTEMPTS, maxAttemptsCpa)
    )
  );
}

function readPositiveIntInput(input, label, max, { silent = false, min = 1 } = {}) {
  const raw = String(input.value ?? "").trim();
  if (raw === "") {
    if (!silent) showMsg(`${label} 不能为空，请输入 ${min}–${max} 的整数`, "err");
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    if (!silent) showMsg(`${label} 必须是整数，可选范围 ${min}–${max}`, "err");
    return null;
  }
  if (n < min || n > max) {
    if (!silent) showMsg(`${label} 超出范围：请输入 ${min}–${max} 的整数`, "err");
    return null;
  }
  input.value = String(n);
  return n;
}

function readBatchSize(target, { silent = false } = {}) {
  const max = currentMaxBatch(target);
  const input = target === TARGET_SUB2API ? $("batchSub2") : $("batchCpa");
  const label = target === TARGET_SUB2API ? "SUB2API 每批账号数" : "CPA 每批文件数";
  return readPositiveIntInput(input, label, max, { silent });
}

function readUploadConcurrency(target, { silent = false } = {}) {
  const max = currentMaxUploadConcurrency(target);
  const input = target === TARGET_SUB2API ? $("uploadConcurrencySub2") : $("uploadConcurrencyCpa");
  const label = target === TARGET_SUB2API ? "SUB2API 上传并发" : "CPA 上传并发";
  return readPositiveIntInput(input, label, max, { silent });
}

function readUploadAttempts(target, { silent = false } = {}) {
  const max = currentMaxUploadAttempts(target);
  const input = target === TARGET_SUB2API ? $("sub2UploadAttempts") : $("cpaUploadAttempts");
  const label = target === TARGET_SUB2API ? "SUB2API 上传重试次数" : "CPA 上传重试次数";
  return readPositiveIntInput(input, label, max, { silent });
}

function readSub2AmbiguousRetry() {
  const value = $("sub2AmbiguousRetry")?.value || DEFAULT_SUB2_AMBIGUOUS_RETRY;
  return ["none", "auto", "confirm"].includes(value) ? value : DEFAULT_SUB2_AMBIGUOUS_RETRY;
}

function applyServerLimits(data) {
  const limits = data?.limits || {};
  const maxSub2 = Number(limits.maxSub2apiAccounts);
  const maxCpa = Number(limits.maxCpaFiles);
  const maxConcSub2 = Number(limits.maxUploadConcurrencySub2api);
  const maxConcCpa = Number(limits.maxUploadConcurrencyCpa);
  const maxAttemptsSub2 = Number(limits.maxSub2apiUploadAttempts);
  const maxAttemptsCpa = Number(limits.maxCpaUploadAttempts);
  const maxCpaDownload = Number(limits.maxCpaAuthDownloadFiles);
  const maxSub2Export = Number(limits.maxSub2apiExportAccounts);
  const maxSub2Dedupe = Number(limits.maxSub2apiDedupeIds);
  serverLimits = {
    maxSub2apiAccounts:
      Number.isFinite(maxSub2) && maxSub2 >= 1 ? Math.floor(maxSub2) : FALLBACK_MAX_SUB2API,
    maxCpaFiles: Number.isFinite(maxCpa) && maxCpa >= 1 ? Math.floor(maxCpa) : FALLBACK_MAX_CPA,
    maxUploadConcurrencySub2api:
      Number.isFinite(maxConcSub2) && maxConcSub2 >= 1
        ? Math.floor(maxConcSub2)
        : FALLBACK_MAX_UPLOAD_CONCURRENCY_SUB2,
    maxUploadConcurrencyCpa:
      Number.isFinite(maxConcCpa) && maxConcCpa >= 1
        ? Math.floor(maxConcCpa)
        : FALLBACK_MAX_UPLOAD_CONCURRENCY_CPA,
    maxSub2apiUploadAttempts:
      Number.isFinite(maxAttemptsSub2) && maxAttemptsSub2 >= 1
        ? Math.floor(maxAttemptsSub2)
        : FALLBACK_MAX_UPLOAD_ATTEMPTS,
    maxCpaUploadAttempts:
      Number.isFinite(maxAttemptsCpa) && maxAttemptsCpa >= 1
        ? Math.floor(maxAttemptsCpa)
        : FALLBACK_MAX_UPLOAD_ATTEMPTS,
    maxCpaAuthDownloadFiles:
      Number.isFinite(maxCpaDownload) && maxCpaDownload >= 1
        ? Math.floor(maxCpaDownload)
        : FALLBACK_MAX_CPA_AUTH_DOWNLOAD,
    maxSub2apiExportAccounts:
      Number.isFinite(maxSub2Export) && maxSub2Export >= 1
        ? Math.floor(maxSub2Export)
        : FALLBACK_MAX_SUB2API_EXPORT,
    maxSub2apiDedupeIds:
      Number.isFinite(maxSub2Dedupe) && maxSub2Dedupe >= 1
        ? Math.floor(maxSub2Dedupe)
        : FALLBACK_MAX_SUB2API_DEDUPE,
  };
  updateUploadLimitHints();
  saveUiSettingsSoon();
}

function currentMaxCpaAuthDownload() {
  return Math.max(
    1,
    Number(serverLimits.maxCpaAuthDownloadFiles) || FALLBACK_MAX_CPA_AUTH_DOWNLOAD
  );
}

function currentMaxSub2apiExport() {
  return Math.max(1, Number(serverLimits.maxSub2apiExportAccounts) || FALLBACK_MAX_SUB2API_EXPORT);
}

function currentMaxSub2apiDedupe() {
  return Math.max(1, Number(serverLimits.maxSub2apiDedupeIds) || FALLBACK_MAX_SUB2API_DEDUPE);
}

function chunkArray(list, size) {
  const out = [];
  const step = Math.max(1, size | 0);
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function canTargetFormat(item, target) {
  // 上传候选：遵循转换方向。远端 stub 仅有元数据时也可点，点击后再补全与转换
  if (!item || item.error) return false;
  if (!item.account && !itemNeedsHydration(item)) return false;
  const key = resolveItemTargetKey(item);
  if (target === TARGET_SUB2API) return key === "sub2api" || key === TARGET_SUB2API;
  if (target === TARGET_CPA || target === "cpa") return key === "cpa";
  return false;
}

function canExportFormat(item) {
  // 导出不受转换方向与同源限制：任意可操作账号都可导出到 CPA 或 SUB2API，点击后再补全并自动转换
  if (!item || item.error) return false;
  return Boolean(item.account) || itemNeedsHydration(item);
}

function refreshActionButtons() {
  const operationItems = getOperationItems();
  const hasItems = operationItems.length > 0;
  const anyBusy = uploadBusy || exportBusy || remoteImportBusy || sub2DedupeBusy;
  const idleUsable = hasItems && !anyBusy;
  const blockUploadSub2 = sameSideUploadBlocked(TARGET_SUB2API);
  const blockUploadCpa = sameSideUploadBlocked(TARGET_CPA);
  // 无配置时也可点击，点击后弹窗引导配置；远端同源禁止回传
  $("btnUploadSub2").disabled = !idleUsable || blockUploadSub2;
  $("btnUploadCpa").disabled = !idleUsable || blockUploadCpa;
  $("btnUploadSub2").title = blockUploadSub2
    ? "列表含从 SUB2API 远端载入的账号，不可回传到 SUB2API"
    : targetConfigTooltip(TARGET_SUB2API);
  $("btnUploadCpa").title = blockUploadCpa
    ? "列表含从 CPA 远端载入的账号，不可回传到 CPA"
    : targetConfigTooltip(TARGET_CPA);
  $("btnClear").disabled = !items.length || anyBusy;
  // 导出不受同源与转换方向限制；导出时再按目标自动转换
  const canExport = operationItems.some((item) => canExportFormat(item));
  $("btnExportSub2").disabled = !canExport || anyBusy;
  $("btnExportCpaZip").disabled = !canExport || anyBusy;
  $("btnExportSub2").title = canExport ? "导出为 SUB2API 格式；必要时自动补全凭证并转换" : "";
  $("btnExportCpaZip").title = canExport ? "导出为 CPA 格式；必要时自动补全凭证并转换" : "";
  $("btnCancelUpload").hidden = !uploadBusy;
  $("btnCancelUpload").disabled = !uploadBusy || uploadCancelRequested;
  refreshRemoteActionButtons();
  refreshRemoteImportUi();
}

function hasSub2apiConfigReady() {
  return Boolean(getEffectiveClientConfig(TARGET_SUB2API));
}

function hasCpaConfigReady() {
  return Boolean(getEffectiveClientConfig(TARGET_CPA));
}

function refreshSub2DedupeButton() {
  // 去重入口已并入远端导入面板；保留函数名供 setSub2DedupeBusy 调用
  refreshRemoteImportUi();
}

function refreshRemoteActionButtons() {
  // 顶栏远端导出/下载已并入「远端」导入；仅刷新远端面板与去重入口
  refreshRemoteImportUi();
}

function setUploadBusy(busy, target = "") {
  uploadBusy = busy;
  activeUploadTarget = busy ? target : "";
  $("btnUploadSub2").innerHTML =
    busy && target === TARGET_SUB2API
      ? '<span class="busy-spin"></span>正在上传到 SUB2API'
      : "上传到 SUB2API";
  $("btnUploadCpa").innerHTML =
    busy && target === TARGET_CPA ? '<span class="busy-spin"></span>正在上传到 CPA' : "上传到 CPA";
  // 上传结束后保留进度条，便于核对；下次开始上传时会刷新
  refreshActionButtons();
  scheduleWorkspaceSave({ immediate: true, interrupted: Boolean(busy) });
}
