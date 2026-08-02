function b64urlDecode(seg) {
  return AccountConvert.b64urlDecode(seg);
}

function decodeJwtPayload(token) {
  return AccountConvert.decodeJwtPayload(token);
}

function isoFromUnix(sec) {
  return AccountConvert.isoFromUnix(sec);
}

function unixFromIsoOrNumber(v) {
  return AccountConvert.unixFromIsoOrNumber(v);
}

function safeFilename(s) {
  return AccountConvert.safeFilename(s);
}

function cpaFilename(record) {
  return AccountConvert.cpaFilename(record);
}

function isCpaRecord(obj) {
  return AccountConvert.isCpaRecord(obj);
}

function isSub2Account(obj) {
  return AccountConvert.isSub2Account(obj);
}

function isSub2Export(obj) {
  return AccountConvert.isSub2Export(obj);
}

function normalizeCpa(raw) {
  return AccountConvert.normalizeCpa(raw);
}

function normalizeSub2(raw) {
  return AccountConvert.normalizeSub2(raw);
}

function cpaToSub2(cpa) {
  return AccountConvert.cpaToSub2(cpa, readConvertOptionsFromUi());
}

function sub2ToCpa(sub2) {
  return AccountConvert.sub2ToCpa(sub2, readConvertOptionsFromUi());
}

function parseFileContent(filename, text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return [
      prepareItem({
        sourceFile: filename,
        sourceFormat: "unknown",
        account: null,
        error: "JSON 解析失败: " + e.message,
      }),
    ];
  }

  const out = [];

  if (isSub2Export(data)) {
    if (!data.accounts.length) {
      out.push(
        prepareItem({
          sourceFile: filename,
          sourceFormat: "sub2api-export",
          account: null,
          error: "accounts 为空",
        })
      );
      return out;
    }
    for (const acc of data.accounts) {
      if (isSub2Account(acc) || (acc && acc.credentials)) {
        out.push(
          prepareItem({
            sourceFile: filename,
            sourceFormat: "sub2api",
            account: normalizeSub2(acc),
          })
        );
      } else if (isCpaRecord(acc)) {
        out.push(
          prepareItem({
            sourceFile: filename,
            sourceFormat: "cpa",
            account: normalizeCpa(acc),
          })
        );
      } else {
        out.push(
          prepareItem({
            sourceFile: filename,
            sourceFormat: "unknown",
            account: null,
            error: "accounts 内对象无法识别",
          })
        );
      }
    }
    return out;
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      if (isSub2Account(item)) {
        out.push(
          prepareItem({
            sourceFile: filename,
            sourceFormat: "sub2api",
            account: normalizeSub2(item),
          })
        );
      } else if (isCpaRecord(item)) {
        out.push(
          prepareItem({
            sourceFile: filename,
            sourceFormat: "cpa",
            account: normalizeCpa(item),
          })
        );
      } else {
        out.push(
          prepareItem({
            sourceFile: filename,
            sourceFormat: "unknown",
            account: null,
            error: "数组元素无法识别",
          })
        );
      }
    }
    return out;
  }

  if (isSub2Account(data)) {
    out.push(
      prepareItem({
        sourceFile: filename,
        sourceFormat: "sub2api",
        account: normalizeSub2(data),
      })
    );
    return out;
  }

  if (isCpaRecord(data)) {
    out.push(
      prepareItem({ sourceFile: filename, sourceFormat: "cpa", account: normalizeCpa(data) })
    );
    return out;
  }

  // 兼容 grok auth 合并字典：key = issuer::client_id
  if (data && typeof data === "object") {
    const values = Object.values(data);
    const looksMerged = values.some(
      (v) =>
        v &&
        typeof v === "object" &&
        (v.refresh_token || v.key || v.access_token) &&
        (v.user_id || v.oidc_client_id || v.auth_mode)
    );
    if (looksMerged) {
      for (const v of values) {
        if (!v || typeof v !== "object") continue;
        const flat = {
          access_token: v.access_token || v.key || "",
          refresh_token: v.refresh_token || "",
          id_token: v.id_token || "",
          email: v.email || "",
          sub: v.user_id || v.principal_id || "",
          token_type: "Bearer",
          expired: v.expires_at || "",
          last_refresh: v.create_time || "",
          base_url: BASE_URL,
        };
        out.push(
          prepareItem({
            sourceFile: filename,
            sourceFormat: "cpa",
            account: normalizeCpa(flat),
          })
        );
      }
      if (out.length) return out;
    }
  }

  out.push(
    prepareItem({
      sourceFile: filename,
      sourceFormat: "unknown",
      account: null,
      error: "无法识别的 JSON 结构",
    })
  );
  return out;
}

function accountLabel(item) {
  if (item.error || !item.account) return "-";
  if (item.sourceFormat === "cpa") {
    return item.account.email || item.account.sub || "无邮箱";
  }
  return item.account.credentials?.email || item.account.name || item.account._sub || "无邮箱";
}

/** 账号稳定标识：优先 email，其次 sub；无标识则返回空（不做跨条去重） */
function accountIdentityKey(item) {
  if (!item?.account || item.error) return "";
  const acc = item.account;
  let email = "";
  let sub = "";
  if (item.sourceFormat === "cpa" || acc.email || acc.sub) {
    email = String(acc.email || "")
      .trim()
      .toLowerCase();
    sub = String(acc.sub || acc._sub || "").trim();
  }
  if (!email && acc.credentials) {
    email = String(acc.credentials.email || "")
      .trim()
      .toLowerCase();
  }
  if (!email && acc.extra?.email) {
    email = String(acc.extra.email || "")
      .trim()
      .toLowerCase();
  }
  if (!sub) sub = String(acc._sub || "").trim();
  if (email) return `email:${email}`;
  if (sub) return `sub:${sub}`;
  return "";
}

function accountExpiryRank(item) {
  refreshAccountExpiry(item);
  const exp = Number(item?.expiresAt);
  return Number.isFinite(exp) && exp > 0 ? exp : 0;
}

/**
 * 合并去重：同 identity 保留过期时间较大者；
 * 过期相同则优先保留「已有上传成功/更完整状态」的旧项，否则保留后出现者。
 * 无 identity 的项（含解析错误）一律保留，不去重。
 */
function mergeItemsByIdentity(baseList, incomingList, { preferIncomingOnTie = true } = {}) {
  const result = [];
  const indexByKey = new Map();
  let replaced = 0;
  let keptOld = 0;
  let added = 0;

  const consider = (item, fromIncoming) => {
    if (!item) return;
    const key = accountIdentityKey(item);
    if (!key) {
      result.push(item);
      if (fromIncoming) added += 1;
      return;
    }
    const existingIdx = indexByKey.get(key);
    if (existingIdx == null) {
      indexByKey.set(key, result.length);
      result.push(item);
      if (fromIncoming) added += 1;
      return;
    }
    const existing = result[existingIdx];
    const oldRank = accountExpiryRank(existing);
    const newRank = accountExpiryRank(item);
    let takeNew = false;
    if (newRank > oldRank) takeNew = true;
    else if (newRank < oldRank) takeNew = false;
    else if (preferIncomingOnTie && fromIncoming) takeNew = true;
    else if (!preferIncomingOnTie && fromIncoming) takeNew = false;
    else takeNew = fromIncoming;

    // 同过期时：若旧项已成功上传，默认保住成功状态（除非新项过期明显更新，上面已处理）
    if (fromIncoming && newRank === oldRank && existing.uploadStatus === UPLOAD_STATUS.SUCCESS) {
      takeNew = false;
    }

    if (takeNew) {
      // 仅当过期时间相同（重复导入/并列）时继承旧上传状态；
      // 过期明显更新说明 token 已换新，应重新上传，不沿用 success。
      if (
        newRank === oldRank &&
        (!item.uploadStatus || item.uploadStatus === UPLOAD_STATUS.NONE) &&
        existing.uploadStatus &&
        existing.uploadStatus !== UPLOAD_STATUS.NONE
      ) {
        item.uploadStatus = existing.uploadStatus;
        item.uploadTarget = existing.uploadTarget || item.uploadTarget || "";
        item.uploadMessage = existing.uploadMessage || item.uploadMessage || "";
        item.uploadAttempts = existing.uploadAttempts || item.uploadAttempts || 0;
      }
      // 代理：新项空则继承旧代理（直接写字段，避免合并过程触发快照保存）
      if (getItemProxyId(item) == null && getItemProxyId(existing) != null) {
        const inherited = getItemProxyId(existing);
        item.proxyId = inherited;
        if (item.account && typeof item.account === "object") {
          item.account.proxy_id = inherited;
        }
        item.proxyValid = existing.proxyValid;
      }
      result[existingIdx] = item;
      replaced += 1;
    } else {
      keptOld += 1;
    }
  };

  for (const item of baseList || []) consider(item, false);
  for (const item of incomingList || []) consider(item, true);
  return { items: result, replaced, keptOld, added };
}

function dedupeItemList(list) {
  return mergeItemsByIdentity([], list, { preferIncomingOnTie: true }).items;
}

function openWorkspaceDb() {
  if (workspaceDb) return Promise.resolve(workspaceDb);
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("当前浏览器不支持 IndexedDB"));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WORKSPACE_DB_NAME, WORKSPACE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WORKSPACE_STORE)) {
        db.createObjectStore(WORKSPACE_STORE);
      }
    };
    req.onsuccess = () => {
      workspaceDb = req.result;
      workspaceDb.onversionchange = () => {
        try {
          workspaceDb?.close();
        } catch {}
        workspaceDb = null;
      };
      resolve(workspaceDb);
    };
    req.onerror = () => reject(req.error || new Error("打开工作区数据库失败"));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB 请求失败"));
  });
}

function serializeWorkspaceItem(item) {
  return {
    id: item.id,
    sourceFile: item.sourceFile,
    sourceFormat: item.sourceFormat,
    account: item.account,
    error: item.error || "",
    converted: item.converted || null,
    targetFormat: item.targetFormat || null,
    selected: Boolean(item.selected),
    accountStatus: item.accountStatus || ACCOUNT_STATUS.UNKNOWN,
    expiresAt: item.expiresAt ?? null,
    proxyId: item.proxyId ?? null,
    proxyValid: item.proxyValid ?? null,
    uploadStatus: item.uploadStatus || UPLOAD_STATUS.NONE,
    uploadTarget: item.uploadTarget || "",
    uploadMessage: item.uploadMessage || "",
    uploadAttempts: item.uploadAttempts || 0,
    exportStatus: item.exportStatus || EXPORT_STATUS.NONE,
    exportTarget: item.exportTarget || "",
    exportMessage: item.exportMessage || "",
    needsHydration: Boolean(item.needsHydration),
    remoteOrigin: item.remoteOrigin || null,
    remoteRef: item.remoteRef || null,
  };
}

function reviveWorkspaceItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const item = prepareItem({
    id: raw.id || makeItemId(),
    sourceFile: raw.sourceFile || "restored",
    sourceFormat: raw.sourceFormat || "unknown",
    account: raw.account ?? null,
    error: raw.error || "",
    converted: raw.converted || null,
    targetFormat: raw.targetFormat || null,
    selected: Boolean(raw.selected),
    uploadStatus: raw.uploadStatus || UPLOAD_STATUS.NONE,
    uploadTarget: raw.uploadTarget || "",
    uploadMessage: raw.uploadMessage || "",
    uploadAttempts: Number(raw.uploadAttempts) || 0,
    exportStatus: raw.exportStatus || EXPORT_STATUS.NONE,
    exportTarget: raw.exportTarget || "",
    exportMessage: raw.exportMessage || "",
    proxyId: raw.proxyId ?? null,
    proxyValid: raw.proxyValid ?? null,
    needsHydration: Boolean(raw.needsHydration),
    remoteOrigin: raw.remoteOrigin || null,
    remoteRef: raw.remoteRef || null,
    // 快载 stub 的过期时间可能只在 item.expiresAt，需带回 prepareItem 再解析
    expiresAt: raw.expiresAt ?? null,
  });
  // prepareItem 会重算过期；保留快照里的上传/导出字段
  if (raw.uploadStatus) item.uploadStatus = raw.uploadStatus;
  if (raw.uploadTarget) item.uploadTarget = raw.uploadTarget;
  if (raw.uploadMessage) item.uploadMessage = raw.uploadMessage;
  if (raw.uploadAttempts != null) item.uploadAttempts = Number(raw.uploadAttempts) || 0;
  if (raw.exportStatus) item.exportStatus = raw.exportStatus;
  if (raw.exportTarget) item.exportTarget = raw.exportTarget;
  if (raw.exportMessage) item.exportMessage = raw.exportMessage;
  if (raw.converted) {
    item.converted = raw.converted;
    item.targetFormat = raw.targetFormat || null;
  }
  return item;
}

function buildWorkspaceSnapshot({ interrupted = false } = {}) {
  let uploadJob = null;
  if (uploadBusy || interrupted) {
    uploadJob = {
      active: Boolean(uploadBusy),
      interrupted: true,
      target: activeUploadTarget || restoredJobMeta?.target || "",
      itemIds: activeUploadItemIds
        ? Array.from(activeUploadItemIds)
        : restoredJobMeta?.itemIds || [],
      updatedAt: new Date().toISOString(),
    };
  } else if (restoredJobMeta?.target) {
    // 仅恢复列表后仍保留任务元信息，便于稍后续传 / 刷新后再次提示
    uploadJob = {
      active: false,
      interrupted: false,
      target: restoredJobMeta.target,
      itemIds: restoredJobMeta.itemIds || [],
      updatedAt: new Date().toISOString(),
    };
  } else {
    // 从当前条目反推最近一次上传目标，避免成功态刷新后丢失核对信息
    const targeted = items.find(
      (item) => item.uploadTarget && item.uploadStatus !== UPLOAD_STATUS.NONE
    );
    if (targeted?.uploadTarget) {
      const target = targeted.uploadTarget;
      uploadJob = {
        active: false,
        interrupted: false,
        target,
        itemIds: items
          .filter((item) => item.uploadTarget === target || !item.uploadTarget)
          .map((item) => item.id),
        updatedAt: new Date().toISOString(),
      };
    }
  }
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    items: items.map(serializeWorkspaceItem),
    converted: Boolean(converted),
    selectionMode: Boolean(selectionMode),
    tableSearch: tableSearch || "",
    tableSort: tableSort && tableSort.key ? { ...tableSort } : { key: "", dir: "asc" },
    uploadJob,
  };
}

function countUploadStats(list, target = "") {
  const scope = Array.isArray(list) ? list : [];
  const match = (item) => !target || !item.uploadTarget || item.uploadTarget === target;
  const count = (status) =>
    scope.filter((item) => match(item) && item.uploadStatus === status).length;
  // 旧快照可能用 NONE +「已跳过」文案表示跳过
  const legacySkipped = scope.filter(
    (item) =>
      match(item) &&
      item.uploadStatus === UPLOAD_STATUS.NONE &&
      item.uploadMessage &&
      String(item.uploadMessage).startsWith("已跳过")
  ).length;
  return {
    total: scope.length,
    success: count(UPLOAD_STATUS.SUCCESS),
    failed: count(UPLOAD_STATUS.FAILED),
    unknown: count(UPLOAD_STATUS.UNKNOWN),
    cancelled: count(UPLOAD_STATUS.CANCELLED),
    skipped: count(UPLOAD_STATUS.SKIPPED) + legacySkipped,
    queued: count(UPLOAD_STATUS.QUEUED),
    uploading: count(UPLOAD_STATUS.UPLOADING),
    none: Math.max(0, count(UPLOAD_STATUS.NONE) - legacySkipped),
  };
}

function summarizeResumeCandidates(list, target, { includeUnknown = false, itemIds = null } = {}) {
  const idSet = Array.isArray(itemIds) && itemIds.length ? new Set(itemIds) : null;
  return (list || []).filter((item) => {
    // 本地上传需完整 account；远端互传 stub 仅需 remoteRef 即可续传
    if (item.error) return false;
    if (
      !item.account &&
      !(target && canRemoteTransferItem(item, target)) &&
      !itemNeedsHydration(item)
    ) {
      return false;
    }
    if (idSet && !idSet.has(item.id)) return false;
    if (
      target &&
      item.uploadTarget &&
      item.uploadTarget !== target &&
      item.uploadStatus !== UPLOAD_STATUS.NONE
    ) {
      return false;
    }
    if (item.uploadStatus === UPLOAD_STATUS.SUCCESS) return false;
    // 跳过项不参与续传；兼容旧快照文案标记
    if (
      item.uploadStatus === UPLOAD_STATUS.SKIPPED ||
      (item.uploadMessage && String(item.uploadMessage).startsWith("已跳过"))
    ) {
      return false;
    }
    if (
      item.uploadStatus === UPLOAD_STATUS.UNKNOWN ||
      item.uploadStatus === UPLOAD_STATUS.UPLOADING
    ) {
      return Boolean(includeUnknown);
    }
    return RESUMABLE_UPLOAD_STATUSES.has(item.uploadStatus || UPLOAD_STATUS.NONE);
  });
}

async function writeWorkspaceSnapshot(snapshot) {
  const db = await openWorkspaceDb();
  const tx = db.transaction(WORKSPACE_STORE, "readwrite");
  tx.objectStore(WORKSPACE_STORE).put(snapshot, WORKSPACE_KEY);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("保存工作区失败"));
    tx.onabort = () => reject(tx.error || new Error("保存工作区已中止"));
  });
}

async function readWorkspaceSnapshot() {
  try {
    const db = await openWorkspaceDb();
    const tx = db.transaction(WORKSPACE_STORE, "readonly");
    const raw = await idbRequest(tx.objectStore(WORKSPACE_STORE).get(WORKSPACE_KEY));
    if (!raw || typeof raw !== "object") return null;
    if (Number(raw.schemaVersion) !== WORKSPACE_SCHEMA_VERSION) return null;
    if (!Array.isArray(raw.items) || !raw.items.length) return null;
    return raw;
  } catch {
    return null;
  }
}

async function clearWorkspaceSnapshot() {
  try {
    const db = await openWorkspaceDb();
    const tx = db.transaction(WORKSPACE_STORE, "readwrite");
    tx.objectStore(WORKSPACE_STORE).delete(WORKSPACE_KEY);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("清除工作区失败"));
      tx.onabort = () => reject(tx.error || new Error("清除工作区已中止"));
    });
  } catch {}
  pendingWorkspaceSnapshot = null;
  hideWorkspaceRestoreBanner();
}

function scheduleWorkspaceSave({ immediate = false, interrupted = false } = {}) {
  if (workspaceHydrating) return;
  workspaceDirty = true;
  const run = () => {
    workspaceSaveTimer = null;
    if (!workspaceDirty && !immediate && !interrupted) return;
    workspaceDirty = false;
    const snapshot = buildWorkspaceSnapshot({ interrupted });
    workspaceSaveChain = workspaceSaveChain
      .catch(() => {})
      .then(async () => {
        if (!snapshot.items.length) {
          await clearWorkspaceSnapshot();
          return;
        }
        await writeWorkspaceSnapshot(snapshot);
      })
      .catch((error) => {
        console.warn("[workspace] save failed", error);
      });
    return workspaceSaveChain;
  };
  if (immediate) {
    clearTimeout(workspaceSaveTimer);
    workspaceSaveTimer = null;
    return run();
  }
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(run, 320);
}

async function flushWorkspaceSave({ interrupted = false } = {}) {
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = null;
  workspaceDirty = true;
  await scheduleWorkspaceSave({ immediate: true, interrupted });
  try {
    await workspaceSaveChain;
  } catch {}
}

function hideWorkspaceRestoreBanner() {
  const el = $("workspaceRestoreBanner");
  if (!el) return;
  el.hidden = true;
  el.classList.remove("show");
}

function showWorkspaceRestoreBanner(snapshot) {
  const el = $("workspaceRestoreBanner");
  if (!el || !snapshot) return;
  const stats = countUploadStats(snapshot.items, snapshot.uploadJob?.target || "");
  const savedAt = snapshot.savedAt
    ? (() => {
        try {
          return new Date(snapshot.savedAt).toLocaleString();
        } catch {
          return snapshot.savedAt;
        }
      })()
    : "未知时间";
  const job = snapshot.uploadJob;
  const interrupted = Boolean(job?.interrupted || job?.active);
  const jobItemIds = Array.isArray(job?.itemIds) ? job.itemIds : null;
  const resumable = summarizeResumeCandidates(snapshot.items, job?.target || "", {
    includeUnknown: false,
    itemIds: jobItemIds,
  }).length;
  const unknown = stats.unknown + stats.uploading;
  let text = `共 ${stats.total} 个账号，保存于 ${savedAt}`;
  if (interrupted && job?.target) {
    text += `，上次 ${job.target} 上传中断，成功：${stats.success}, 失败：${stats.failed}, 未知：${unknown}, 可续传：${resumable}`;
  } else if (job?.target && (resumable > 0 || unknown > 0)) {
    text += `，${job.target} 仍有未完成项，成功：${stats.success}, 可续传：${resumable}, 未知：${unknown}`;
  } else if (stats.success || stats.failed || stats.unknown) {
    text += `，上传痕迹 成功：${stats.success}, 失败：${stats.failed}, 未知：${stats.unknown}`;
  } else {
    text += "，可恢复账号列表与状态";
  }
  $("workspaceRestoreText").textContent = text;
  $("workspaceRestoreTitle").textContent = interrupted
    ? "检测到未完成的上传任务"
    : "检测到本地工作区快照";
  const canResume = Boolean(job?.target && (resumable > 0 || unknown > 0));
  const resumeBtn = $("btnRestoreAndResume");
  if (resumeBtn) {
    resumeBtn.hidden = !canResume;
    resumeBtn.textContent = "恢复并续传";
  }
  const restoreBtn = $("btnRestoreWorkspace");
  const listOnly = $("btnRestoreListOnly");
  if (interrupted && canResume) {
    if (restoreBtn) restoreBtn.hidden = true;
    if (listOnly) {
      listOnly.hidden = false;
      listOnly.textContent = "仅恢复列表";
    }
  } else {
    if (restoreBtn) {
      restoreBtn.hidden = false;
      restoreBtn.textContent = "恢复列表";
    }
    if (listOnly) listOnly.hidden = true;
  }
  const discardBtn = $("btnDiscardWorkspace");
  if (discardBtn) discardBtn.textContent = "丢弃快照";
  el.hidden = false;
  el.classList.add("show");
}

function normalizeInterruptedUploadItems(list) {
  let changed = 0;
  for (const item of list || []) {
    if (item.uploadStatus === UPLOAD_STATUS.UPLOADING) {
      setItemUploadState(
        item,
        UPLOAD_STATUS.UNKNOWN,
        item.uploadTarget || "",
        item.uploadMessage?.includes("中断")
          ? item.uploadMessage
          : `页面中断时正在上传；该账号可能已写入目标服务器，请先核对后再决定是否重试`,
        item.uploadAttempts || 0
      );
      changed += 1;
    } else if (item.uploadStatus === UPLOAD_STATUS.QUEUED) {
      setItemUploadState(
        item,
        UPLOAD_STATUS.CANCELLED,
        item.uploadTarget || "",
        "页面中断，批次尚未发出",
        item.uploadAttempts || 0
      );
      changed += 1;
    }
  }
  return changed;
}

function showPostRestoreResumeBanner(target) {
  const el = $("workspaceRestoreBanner");
  if (!el || !target) return;
  const resumable = summarizeResumeCandidates(items, target, {
    includeUnknown: false,
    itemIds: restoredJobMeta?.itemIds,
  }).length;
  const unknownCount = summarizeResumeCandidates(items, target, {
    includeUnknown: true,
    itemIds: restoredJobMeta?.itemIds,
  }).filter(
    (item) =>
      item.uploadStatus === UPLOAD_STATUS.UNKNOWN || item.uploadStatus === UPLOAD_STATUS.UPLOADING
  ).length;
  if (!resumable && !unknownCount) {
    hideWorkspaceRestoreBanner();
    return;
  }
  $("workspaceRestoreTitle").textContent = "列表已恢复，仍可续传";
  $("workspaceRestoreText").textContent =
    `目标 ${target}，可安全续传：${resumable}` +
    (unknownCount ? `, 状态未知：${unknownCount}` : "") +
    "。已成功的账号默认不会再传。";
  const resumeBtn = $("btnRestoreAndResume");
  if (resumeBtn) {
    resumeBtn.hidden = false;
    resumeBtn.textContent = "继续续传";
  }
  const restoreBtn = $("btnRestoreWorkspace");
  if (restoreBtn) restoreBtn.hidden = true;
  const listOnly = $("btnRestoreListOnly");
  if (listOnly) listOnly.hidden = true;
  const discardBtn = $("btnDiscardWorkspace");
  if (discardBtn) discardBtn.textContent = "关闭提示";
  el.hidden = false;
  el.classList.add("show");
}

function applyWorkspaceSnapshot(snapshot, { normalizeUpload = true } = {}) {
  workspaceHydrating = true;
  try {
    const revived = (snapshot.items || []).map(reviveWorkspaceItem).filter(Boolean);
    if (normalizeUpload) normalizeInterruptedUploadItems(revived);
    items = revived;
    converted = items.some((item) => item.converted);
    selectionMode = false;
    for (const item of items) item.selected = false;
    tableSearch = "";
    if ($("accountSearch")) $("accountSearch").value = "";
    tableSort =
      snapshot.tableSort && snapshot.tableSort.key
        ? {
            key: String(snapshot.tableSort.key || ""),
            dir: snapshot.tableSort.dir === "desc" ? "desc" : "asc",
          }
        : { key: "", dir: "asc" };
    activeUploadItemIds = null;
    uploadBusy = false;
    activeUploadTarget = "";
    uploadCancelRequested = false;
    uploadAbortController = null;
    proxyEditingItemId = null;
    restoredJobMeta = snapshot.uploadJob?.target
      ? {
          target: snapshot.uploadJob.target,
          itemIds: Array.isArray(snapshot.uploadJob.itemIds) ? snapshot.uploadJob.itemIds : null,
        }
      : null;
    hideWorkspaceRestoreBanner();
    pendingWorkspaceSnapshot = null;
    renderTable();
    if (snapshot.uploadJob?.target) {
      const jobIds = restoredJobMeta?.itemIds;
      const total = jobIds?.length
        ? items.filter((item) => jobIds.includes(item.id)).length
        : items.length;
      uploadProgressMessage(snapshot.uploadJob.target, total || items.length);
    }
  } finally {
    workspaceHydrating = false;
  }
  scheduleWorkspaceSave({ immediate: true });
}

function bindBeforeUnloadGuard() {
  if (beforeUnloadBound) return;
  beforeUnloadBound = true;
  window.addEventListener("beforeunload", (event) => {
    if (!uploadBusy && !workspaceDirty) return;
    // 尽量同步落盘；浏览器不保证异步完成
    try {
      if (uploadBusy || items.length) {
        const snapshot = buildWorkspaceSnapshot({ interrupted: Boolean(uploadBusy) });
        // 启动一个不 await 的写入；同时用 sendBeacon 无法写 IDB
        writeWorkspaceSnapshot(snapshot).catch(() => {});
      }
    } catch {}
    if (uploadBusy) {
      event.preventDefault();
      event.returnValue = "上传仍在进行，离开后进度仅保留在本机快照。确定离开？";
      return event.returnValue;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && (uploadBusy || items.length)) {
      flushWorkspaceSave({ interrupted: Boolean(uploadBusy) });
    }
  });
}

function openImportConflictModal({ existingCount, incomingCount }) {
  return new Promise((resolve) => {
    importConflictResolver = resolve;
    $("importConflictSummary").textContent =
      `当前列表已有 ${existingCount} 个账号，本次将导入 ${incomingCount} 个。请选择处理方式。`;
    $("importConflictModal").classList.add("show");
  });
}

function closeImportConflictModal(action = "cancel") {
  $("importConflictModal")?.classList.remove("show");
  const resolver = importConflictResolver;
  importConflictResolver = null;
  if (resolver) resolver(action);
}

function openResumeUploadModal({ target, resumableCount, unknownCount, successCount }) {
  return new Promise((resolve) => {
    resumeUploadResolver = resolve;
    $("resumeUploadSummary").textContent =
      `目标 ${target}，可安全续传：${resumableCount}` +
      (unknownCount ? `, 状态未知：${unknownCount}` : "") +
      `, 已成功：${successCount} 将默认跳过`;
    $("resumeIncludeUnknown").checked = false;
    $("resumeUploadStatus").textContent = "";
    $("resumeUploadStatus").className = "config-status";
    $("resumeUploadModal").classList.add("show");
  });
}

function closeResumeUploadModal(result = { ok: false, includeUnknown: false }) {
  $("resumeUploadModal")?.classList.remove("show");
  const resolver = resumeUploadResolver;
  resumeUploadResolver = null;
  if (resolver) resolver(result);
}
