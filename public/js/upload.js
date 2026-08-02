function markProxyValidity(list, validIdSet) {
  const invalid = [];
  for (const item of list) {
    const proxyId = getItemProxyId(item);
    if (proxyId == null) {
      item.proxyValid = null;
      continue;
    }
    const ok = validIdSet.has(proxyId);
    item.proxyValid = ok;
    if (!ok) invalid.push(item);
  }
  return invalid;
}

function groupInvalidByProxyId(invalidItems) {
  const map = new Map();
  for (const item of invalidItems) {
    const id = getItemProxyId(item);
    if (id == null) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(item);
  }
  return map;
}

function setBatchProxyStatus(text, type = "") {
  const el = $("batchProxyStatus");
  if (!el) return;
  el.textContent = text || "";
  el.className = `config-status ${type}`.trim();
}

function setProxyValidateStatus(text, type = "") {
  const el = $("proxyValidateStatus");
  if (!el) return;
  el.textContent = text || "";
  el.className = `config-status ${type}`.trim();
}

function openBatchProxyModal() {
  const selected = items.filter((item) => item.selected && !item.error && item.account);
  if (!selected.length) {
    showMsg("请先勾选要设置代理的账号", "err");
    return;
  }
  $("batchProxyHint").textContent = `为已选 ${selected.length} 个账号设置 SUB2API 代理 ID`;
  $("batchProxyIdInput").value = "";
  $("batchProxyMode").value = "overwrite";
  setBatchProxyStatus("");
  $("batchProxyModal").classList.add("show");
  setTimeout(() => $("batchProxyIdInput").focus(), 0);
}

function closeBatchProxyModal() {
  $("batchProxyModal").classList.remove("show");
  setBatchProxyStatus("");
}

function applyBatchProxySettings() {
  const selected = items.filter((item) => item.selected && !item.error && item.account);
  if (!selected.length) {
    setBatchProxyStatus("没有已选账号", "err");
    return false;
  }
  const raw = String($("batchProxyIdInput").value ?? "").trim();
  if (raw === "") {
    setBatchProxyStatus("请输入代理 ID，或改用「批量清除」", "err");
    return false;
  }
  const proxyId = parseProxyId(raw);
  if (proxyId == null) {
    setBatchProxyStatus("代理 ID 必须是 0 或正整数", "err");
    return false;
  }
  const mode = $("batchProxyMode").value === "fill-empty" ? "fill-empty" : "overwrite";
  let changed = 0;
  for (const item of selected) {
    if (mode === "fill-empty" && getItemProxyId(item) != null) continue;
    setItemProxyId(item, proxyId);
    changed += 1;
  }
  closeBatchProxyModal();
  renderTable();
  showMsg(
    mode === "fill-empty"
      ? `已为 ${changed} 个空代理账号设置代理 ID ${proxyId}`
      : `已为 ${changed} 个账号设置代理 ID ${proxyId}`,
    "ok"
  );
  return true;
}

function batchClearSelectedProxies() {
  const selected = items.filter((item) => item.selected && !item.error && item.account);
  if (!selected.length) {
    showMsg("请先勾选要清除代理的账号", "err");
    return;
  }
  const withProxy = selected.filter((item) => getItemProxyId(item) != null);
  if (!withProxy.length) {
    showMsg("已选账号均未设置代理 ID", "info");
    return;
  }
  if (
    !window.confirm(
      `将清除已选 ${withProxy.length} 个账号的代理 ID，上传时将不绑定代理。是否继续？`
    )
  ) {
    return;
  }
  for (const item of withProxy) setItemProxyId(item, null);
  renderTable();
  showMsg(`已清除 ${withProxy.length} 个账号的代理 ID`, "ok");
}

function selectVisibleByProxyFilter(kind) {
  if (!selectionMode) {
    selectionMode = true;
  }
  for (const { item } of getVisibleItems()) {
    if (item.error || !item.account) {
      item.selected = false;
      continue;
    }
    const proxyId = getItemProxyId(item);
    if (kind === "has") item.selected = proxyId != null;
    else if (kind === "none") item.selected = proxyId == null;
    else if (kind === "invalid") item.selected = item.proxyValid === false;
    else item.selected = false;
  }
  renderTable();
}

function settleProxyValidateDialog(action) {
  const resolver = proxyValidateResolver;
  proxyValidateResolver = null;
  if (resolver) resolver(action);
}

function closeProxyValidateModal(action = "cancel") {
  $("proxyValidateModal").classList.remove("show");
  settleProxyValidateDialog(action);
}

function renderProxyValidateModal(invalidItems, proxyIds) {
  const grouped = groupInvalidByProxyId(invalidItems);
  proxyValidateInvalidIds = invalidItems.map((item) => item.id);
  $("proxyValidateSummary").textContent =
    `共 ${invalidItems.length} 个账号的代理 ID 在目标服务器不存在。可强制上传、跳过这些账号，或先修正后再传。`;
  const summaryEl = $("proxyInvalidSummary");
  summaryEl.innerHTML = Array.from(grouped.entries())
    .map(
      ([id, list]) => `<div class="proxy-summary-item">
        <span>代理 ID <b>${escapeHtml(String(id))}</b>，${list.length} 个账号</span>
        <button type="button" class="btn-ghost btn-sm" data-select-invalid-id="${escapeHtml(String(id))}">选中这批</button>
      </div>`
    )
    .join("");
  const listEl = $("proxyAvailableList");
  const ids = Array.isArray(proxyIds) ? proxyIds : [];
  if (!ids.length) {
    listEl.innerHTML = `<span class="mono">服务器未返回可用代理 ID</span>`;
  } else {
    listEl.innerHTML = ids
      .map(
        (id) =>
          `<button type="button" class="proxy-chip" data-pick-proxy-id="${escapeHtml(String(id))}" title="代理 ID ${escapeHtml(String(id))}"><span class="proxy-chip-text">${escapeHtml(String(id))}</span></button>`
      )
      .join("");
  }
  $("proxyFixIdInput").value = "";
  setProxyValidateStatus("");
  $("proxyValidateModal").classList.add("show");
}

function openProxyValidateDialog(invalidItems, proxyIds) {
  if (proxyValidateResolver) settleProxyValidateDialog("cancel");
  renderProxyValidateModal(invalidItems, proxyIds);
  return new Promise((resolve) => {
    proxyValidateResolver = resolve;
  });
}

function selectInvalidItemsByIds(ids) {
  const idSet = new Set(ids);
  selectionMode = true;
  for (const item of items) {
    item.selected = idSet.has(item.id);
  }
  renderTable();
}

function applyProxyFixToInvalid(proxyId) {
  const idSet = new Set(proxyValidateInvalidIds);
  let changed = 0;
  for (const item of items) {
    if (!idSet.has(item.id)) continue;
    setItemProxyId(item, proxyId);
    if (proxyId == null) item.proxyValid = null;
    else item.proxyValid = cachedSub2ProxyIdSet.has(proxyId) ? true : false;
    changed += 1;
  }
  return changed;
}

function refreshInvalidAfterFix() {
  const stillInvalid = items.filter(
    (item) => proxyValidateInvalidIds.includes(item.id) && item.proxyValid === false
  );
  proxyValidateInvalidIds = stillInvalid.map((item) => item.id);
  if (!stillInvalid.length) {
    setProxyValidateStatus("无效代理已全部处理，将继续上传", "ok");
    $("proxyInvalidSummary").innerHTML =
      `<div class="proxy-summary-item"><span>没有剩余无效账号</span></div>`;
    // 全部修正后自动继续上传，避免用户再点一次
    setTimeout(() => closeProxyValidateModal("continue"), 280);
    return [];
  }
  renderProxyValidateModal(stillInvalid, cachedSub2ProxyIds);
  setProxyValidateStatus(`仍有 ${stillInvalid.length} 个账号代理无效`, "err");
  return stillInvalid;
}

/**
 * 上传 SUB2API 前：补全默认代理 → 拉代理 ID 列表 → 校验 proxy_id
 * 返回 { ok, items, skippedInvalid, forced }
 */
async function prepareSub2UploadItems(uploadItems, configPayload) {
  const filled = applyDefaultProxyToItems(uploadItems);
  if (filled) {
    // 默认代理写入会清掉 SUB2 的 converted 缓存，这里按当前目标重转一次
    for (const item of uploadItems) {
      if (item.error || !item.account || itemNeedsHydration(item)) continue;
      if (item.converted && item.targetFormat === TARGET_SUB2API) continue;
      try {
        item.converted = convertItemTo(item, TARGET_SUB2API);
        item.targetFormat = TARGET_SUB2API;
      } catch (e) {
        item.error = "转换失败: " + e.message;
      }
    }
    converted = items.some((item) => item.converted);
    showMsg(`已按默认代理补全 ${filled} 个账号的代理 ID`, "info");
    renderTable();
    scheduleWorkspaceSave({ immediate: true });
  }

  showMsg("正在拉取 SUB2API 代理 ID 列表并校验…", "info");
  let proxyIds = [];
  try {
    proxyIds = await fetchSub2apiProxyIds(configPayload);
  } catch (error) {
    throw new Error(`拉取代理 ID 列表失败：${apiErrorMessage(error)}`);
  }

  const invalid = markProxyValidity(uploadItems, cachedSub2ProxyIdSet);
  renderTable();
  if (!invalid.length) {
    return { ok: true, items: uploadItems, skippedInvalid: [], forced: false };
  }

  const action = await openProxyValidateDialog(invalid, proxyIds);
  if (action === "continue") {
    const still = markProxyValidity(uploadItems, cachedSub2ProxyIdSet);
    renderTable();
    if (still.length) {
      showMsg(`仍有 ${still.length} 个账号代理 ID 无效，已取消上传`, "err");
      return { ok: false, items: [], skippedInvalid: still, forced: false };
    }
    return { ok: true, items: uploadItems, skippedInvalid: [], forced: false };
  }
  if (action === "force") {
    return { ok: true, items: uploadItems, skippedInvalid: [], forced: true };
  }
  if (action === "skip") {
    const invalidIds = new Set(invalid.map((item) => item.id));
    const kept = uploadItems.filter((item) => !invalidIds.has(item.id));
    for (const item of invalid) {
      setItemUploadState(
        item,
        UPLOAD_STATUS.SKIPPED,
        TARGET_SUB2API,
        `已跳过，代理 ID ${getItemProxyId(item) ?? "-"} 无效`,
        0
      );
    }
    if (!kept.length) {
      showMsg("全部账号因代理 ID 无效被跳过，已取消上传", "err");
      return { ok: false, items: [], skippedInvalid: invalid, forced: false };
    }
    renderTable();
    return { ok: true, items: kept, skippedInvalid: invalid, forced: false };
  }
  // cancel / 返回修改
  showMsg(`有 ${invalid.length} 个账号代理 ID 无效，已取消上传`, "err");
  return { ok: false, items: [], skippedInvalid: invalid, forced: false };
}

function clearCurrentLocalConfig() {
  const target = configDialogTarget;
  clearLocalTarget(target);
  $("cfgApiKey").value = "";
  fillConfigDialogForm(target);
  updateRuntimeConfigUi();
  const envReady = Boolean(targetConfigInfo(target)?.configured);
  setConfigStatus(
    envReady
      ? `已清除 ${target} 本机配置，将回退环境变量`
      : `已清除 ${target} 本机配置，且无环境变量可用`,
    envReady ? "ok" : "err"
  );
}

async function ensureVerifiedConfig(target, forceShow = false) {
  if (!runtimeTargetStatus) await loadRuntimeConfigStatus(false);
  if (forceShow) {
    await openConfigDialog({
      target,
      reason: "",
      mode: "manage",
    });
    return false;
  }

  // 最多：缺配置引导一次 + 验证失败再引导一次；弹窗内「验证并保存」已含一次成功验证
  for (let attempt = 0; attempt < 2; attempt++) {
    let effective = getEffectiveClientConfig(target);
    if (!effective) {
      const saved = await openConfigDialog({
        target,
        reason: `${target} 尚未配置，请填写地址与密钥后验证`,
        mode: "ensure",
      });
      // ensure 模式下验证并保存成功会关闭弹窗并返回 true（已验证）
      if (saved) return true;
      return false;
    }

    try {
      showMsg(
        `正在验证 ${target} 服务器配置 · ${effective.source === "local" ? "本机" : "环境变量"}…`,
        "info"
      );
      const override =
        effective.source === "local"
          ? {
              baseUrl: effective.baseUrl,
              apiKey: effective.apiKey,
              cpaAuthMode: effective.cpaAuthMode,
            }
          : null;
      const verified = await verifyServerConfig(target, override);
      showMsg(verified.message || `${target} 配置验证成功`, "ok");
      return true;
    } catch (error) {
      const saved = await openConfigDialog({
        target,
        reason: `${target} 验证失败：${apiErrorMessage(error)}`,
        mode: "ensure",
      });
      if (saved) return true;
      return false;
    }
  }
  return false;
}

function setItemUploadState(item, status, target, message = "", attempts = 0) {
  item.uploadStatus = status;
  item.uploadTarget = target;
  item.uploadMessage = message;
  item.uploadAttempts = attempts;
  // 上传状态变更较频繁：防抖写入；批次结束处会 immediate flush
  scheduleWorkspaceSave();
}

function isUploadCancellation(error) {
  return (
    uploadCancelRequested || error?.name === "UploadCancelledError" || error?.name === "AbortError"
  );
}

function isAmbiguousUploadError(error) {
  if (!error?.status) return true;
  return [408, 425, 429, 499, 500, 502, 503, 504].includes(Number(error.status));
}

function isSafeRetryUploadError(error) {
  if (!error) return false;
  if (isUploadCancellation(error)) return false;
  const status = Number(error.status);
  if (!status) return true;
  return [408, 425, 429, 502, 503].includes(status);
}

function throwIfUploadCancelled() {
  if (!uploadCancelRequested) return;
  const error = new Error("用户已取消上传");
  error.name = "UploadCancelledError";
  throw error;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUploadCooldown() {
  while (Date.now() < uploadCooldownUntil) {
    throwIfUploadCancelled();
    const remain = Math.max(0, uploadCooldownUntil - Date.now());
    showMsg(`上传并发已临时降低，冷却 ${Math.ceil(remain / 1000)}s 后继续…`, "info");
    await sleepMs(Math.min(1000, remain || 1));
  }
}

function noteUploadBatchOutcome(ok, ambiguous) {
  if (!noteUploadBatchOutcome.window) {
    noteUploadBatchOutcome.window = [];
    noteUploadBatchOutcome.successStreak = 0;
  }
  noteUploadBatchOutcome.window.push({ ok: Boolean(ok), ambiguous: Boolean(ambiguous) });
  if (noteUploadBatchOutcome.window.length > 8) noteUploadBatchOutcome.window.shift();

  if (ok) {
    noteUploadBatchOutcome.successStreak += 1;
    if (
      adaptiveUploadConcurrency < noteUploadBatchOutcome.desired &&
      noteUploadBatchOutcome.successStreak >= 3
    ) {
      adaptiveUploadConcurrency = Math.min(
        noteUploadBatchOutcome.desired,
        adaptiveUploadConcurrency + 1
      );
      noteUploadBatchOutcome.successStreak = 0;
    }
    return;
  }

  noteUploadBatchOutcome.successStreak = 0;
  // 仅在模糊失败或密集失败时降并发，明确业务失败不降
  if (!ambiguous) return;
  const recent = noteUploadBatchOutcome.window.slice(-6);
  const ambiguousCount = recent.filter((item) => item.ambiguous).length;
  if (ambiguousCount >= 2 || recent.filter((item) => !item.ok).length >= 3) {
    if (adaptiveUploadConcurrency > 1) {
      adaptiveUploadConcurrency = Math.max(1, Math.floor(adaptiveUploadConcurrency / 2));
      uploadCooldownUntil =
        Date.now() +
        Math.min(15000, 3000 * (noteUploadBatchOutcome.desired - adaptiveUploadConcurrency + 1));
    }
  }
}

function resetAdaptiveUpload(desired) {
  noteUploadBatchOutcome.window = [];
  noteUploadBatchOutcome.successStreak = 0;
  noteUploadBatchOutcome.desired = Math.max(1, desired);
  adaptiveUploadConcurrency = noteUploadBatchOutcome.desired;
  uploadCooldownUntil = 0;
}

async function runWithAdaptiveConcurrency(items, getLimit, workerFn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  let active = 0;
  let rejectOnce = null;
  let resolveOnce = null;
  let finished = false;

  return new Promise((resolve, reject) => {
    resolveOnce = resolve;
    rejectOnce = reject;

    const pump = () => {
      if (finished) return;
      if (nextIndex >= items.length && active === 0) {
        finished = true;
        resolveOnce(results);
        return;
      }
      const limit = Math.max(1, Number(getLimit()) || 1);
      while (active < limit && nextIndex < items.length) {
        const index = nextIndex++;
        active += 1;
        (async () => {
          await waitUploadCooldown();
          throwIfUploadCancelled();
          results[index] = await workerFn(items[index], index);
        })()
          .catch((error) => {
            if (isUploadCancellation(error)) {
              if (!finished) {
                finished = true;
                rejectOnce(error);
              }
              return;
            }
            results[index] = error;
          })
          .finally(() => {
            active -= 1;
            if (!finished) pump();
          });
      }
    };

    pump();
  });
}

async function confirmAmbiguousRetry(batchNumber, batchCount, message) {
  return new Promise((resolve) => {
    const ok = window.confirm(
      `第 ${batchNumber}/${batchCount} 批结果未知：\n${message}\n\n` +
        `自动再次提交同一批可能导致 SUB2API 重复创建账号\n是否仍要重试该批？`
    );
    resolve(Boolean(ok));
  });
}

function setUploadProgressVisible(visible) {
  const el = $("uploadProgress");
  if (!el) return;
  el.hidden = !visible;
  el.classList.toggle("show", visible);
}

function uploadProgressMessage(target, total) {
  const scope = activeUploadItemIds
    ? items.filter((item) => activeUploadItemIds.has(item.id))
    : getOperationItems();
  // 跳过项保留 uploadTarget；兼容旧快照中 target 被清空的跳过标记
  const count = (status) =>
    scope.filter((item) => {
      if (item.uploadStatus !== status) return false;
      if (status === UPLOAD_STATUS.SKIPPED) {
        return !item.uploadTarget || item.uploadTarget === target;
      }
      return item.uploadTarget === target;
    }).length;
  const success = count(UPLOAD_STATUS.SUCCESS);
  const failed = count(UPLOAD_STATUS.FAILED);
  const unknown = count(UPLOAD_STATUS.UNKNOWN);
  const cancelled = count(UPLOAD_STATUS.CANCELLED);
  const skipped = count(UPLOAD_STATUS.SKIPPED);
  const uploading = count(UPLOAD_STATUS.UPLOADING);
  const queued = count(UPLOAD_STATUS.QUEUED);
  // 各终态之和 + 进行中应等于 total；跳过必须计入 settled
  const settled = success + failed + unknown + cancelled + skipped;
  const pct = total > 0 ? Math.min(100, Math.round((settled / total) * 100)) : 0;

  setUploadProgressVisible(true);
  $("uploadProgressTitle").textContent = `${target} 上传进度`;
  $("uploadProgressPct").textContent = `${pct}% ${settled}/${total}`;
  const desired = noteUploadBatchOutcome.desired || adaptiveUploadConcurrency || 1;
  $("uploadProgressMeta").innerHTML =
    `<span>成功：<b>${success}</b></span>` +
    `<span>失败：<b>${failed}</b></span>` +
    `<span>未知：<b>${unknown}</b></span>` +
    `<span>跳过：<b>${skipped}</b></span>` +
    `<span>处理中：<b>${uploading}</b></span>` +
    `<span>等待：<b>${queued}</b></span>` +
    `<span>已取消：<b>${cancelled}</b></span>` +
    `<span>并发：<b>${adaptiveUploadConcurrency}/${desired}</b></span>` +
    `<span>共：<b>${total}</b></span>`;

  const fill = $("uploadProgressFill");
  fill.style.width = `${pct}%`;
  fill.classList.remove("is-ok", "is-warn", "is-danger");
  if (failed || unknown) fill.classList.add(failed ? "is-danger" : "is-warn");
  else if (settled >= total && total > 0 && !uploading && !queued) fill.classList.add("is-ok");
}

function markBatchAfterRequestError(entries, target, error) {
  const message = apiErrorMessage(error);
  const attempts = Number(error?.data?.attempts || error?.attempts || 1);
  const ambiguous = isAmbiguousUploadError(error);
  for (const entry of entries) {
    setItemUploadState(
      entry.item,
      ambiguous ? UPLOAD_STATUS.UNKNOWN : UPLOAD_STATUS.FAILED,
      target,
      ambiguous
        ? `请求结果未知：${message}。该批次可能已被服务器处理，请先到目标服务器核对，避免直接重试造成重复`
        : message,
      attempts
    );
  }
}

async function uploadSub2Batch(
  entries,
  total,
  batchNumber,
  batchCount,
  configPayload,
  uploadOptions = {}
) {
  throwIfUploadCancelled();
  for (const entry of entries) {
    setItemUploadState(
      entry.item,
      UPLOAD_STATUS.UPLOADING,
      TARGET_SUB2API,
      `正在处理第 ${batchNumber}/${batchCount} 批，本批 ${entries.length} 个`
    );
  }
  uploadProgressMessage(TARGET_SUB2API, total);
  renderTable();

  const maxAttempts = Math.max(1, Number(uploadOptions.maxAttempts) || DEFAULT_UPLOAD_ATTEMPTS);
  const ambiguousPolicy = uploadOptions.ambiguousRetry || DEFAULT_SUB2_AMBIGUOUS_RETRY;
  // Worker 侧：安全错误可重试；模糊错误仅 auto 时自动重试
  let retryAmbiguous = ambiguousPolicy === "auto";
  let confirmedAmbiguous = false;

  try {
    while (true) {
      throwIfUploadCancelled();
      try {
        const body = {
          accounts: entries.map((entry) => entry.account),
          skipDefaultGroupBind: false,
          maxAttempts,
          retryAmbiguous,
        };
        if (configPayload) body.config = configPayload;
        const { data } = await fetchJson(
          "/api/upload/sub2api",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: uploadAbortController?.signal,
          },
          660000
        );
        const attempts = Number(data?.attempts || 1);
        for (const entry of entries) {
          setItemUploadState(
            entry.item,
            UPLOAD_STATUS.SUCCESS,
            TARGET_SUB2API,
            "服务器已确认导入成功",
            attempts
          );
        }
        noteUploadBatchOutcome(true, false);
        break;
      } catch (error) {
        if (isUploadCancellation(error)) {
          for (const entry of entries) {
            setItemUploadState(
              entry.item,
              UPLOAD_STATUS.CANCELLED,
              TARGET_SUB2API,
              "上传已取消；当前批次可能已经被 SUB2API 接收，请先核对后再决定是否重试"
            );
          }
          throw error;
        }

        const ambiguous = isAmbiguousUploadError(error);
        const message = apiErrorMessage(error);

        // 等待确认：模糊失败时询问一次，用户同意后再以 retryAmbiguous 重打
        if (ambiguous && ambiguousPolicy === "confirm" && !confirmedAmbiguous && !retryAmbiguous) {
          const ok = await confirmAmbiguousRetry(batchNumber, batchCount, message);
          if (ok) {
            confirmedAmbiguous = true;
            retryAmbiguous = true;
            for (const entry of entries) {
              setItemUploadState(
                entry.item,
                UPLOAD_STATUS.UPLOADING,
                TARGET_SUB2API,
                `用户确认后重试第 ${batchNumber}/${batchCount} 批`
              );
            }
            uploadProgressMessage(TARGET_SUB2API, total);
            renderTable();
            continue;
          }
        }

        markBatchAfterRequestError(entries, TARGET_SUB2API, error);
        noteUploadBatchOutcome(false, ambiguous);
        break;
      }
    }
  } finally {
    uploadProgressMessage(TARGET_SUB2API, total);
    renderTable();
    // 每批结束强制落盘，刷新后可从成功点续传
    flushWorkspaceSave({ interrupted: true });
  }
}

function uniqueCpaUploadEntries(operationItems) {
  const used = new Map();
  const entries = operationItems.map((item) => {
    const account = convertItemTo(item, TARGET_CPA);
    item.converted = account;
    item.targetFormat = "cpa";
    let filename = cpaFilename(account);
    const count = (used.get(filename) || 0) + 1;
    used.set(filename, count);
    if (count > 1) filename = filename.replace(/\.json$/i, `-${count}.json`);
    return { item, account, filename };
  });
  converted = items.some((row) => row.converted);
  return entries;
}

async function uploadCpaBatch(
  entries,
  total,
  batchNumber,
  batchCount,
  configPayload,
  uploadOptions = {}
) {
  throwIfUploadCancelled();
  for (const entry of entries) {
    setItemUploadState(
      entry.item,
      UPLOAD_STATUS.UPLOADING,
      TARGET_CPA,
      `正在处理第 ${batchNumber}/${batchCount} 批，本批 ${entries.length} 个`,
      0
    );
  }
  uploadProgressMessage(TARGET_CPA, total);
  renderTable();
  try {
    const body = {
      files: entries.map((entry) => ({ name: entry.filename, account: entry.account })),
      maxAttempts: Math.max(1, Number(uploadOptions.maxAttempts) || DEFAULT_UPLOAD_ATTEMPTS),
    };
    if (configPayload) body.config = configPayload;
    const { data } = await fetchJson(
      "/api/upload/cpa",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: uploadAbortController?.signal,
      },
      180000
    );
    const resultMap = new Map((data?.results || []).map((result) => [result.name, result]));
    let batchOk = true;
    for (const entry of entries) {
      const result = resultMap.get(entry.filename);
      if (result?.ok) {
        setItemUploadState(
          entry.item,
          UPLOAD_STATUS.SUCCESS,
          TARGET_CPA,
          `上传成功，Worker 尝试 ${result.attempts || 1} 次`,
          result.attempts || 1
        );
      } else {
        batchOk = false;
        setItemUploadState(
          entry.item,
          UPLOAD_STATUS.FAILED,
          TARGET_CPA,
          result?.error || "服务器未返回该文件的处理结果",
          result?.attempts || 1
        );
      }
    }
    noteUploadBatchOutcome(batchOk, false);
  } catch (error) {
    if (isUploadCancellation(error)) {
      for (const entry of entries) {
        setItemUploadState(
          entry.item,
          UPLOAD_STATUS.CANCELLED,
          TARGET_CPA,
          "上传已取消；当前文件可能已被 CPA 接收，请先核对后再决定是否重试"
        );
      }
      throw error;
    }
    markBatchAfterRequestError(entries, TARGET_CPA, error);
    noteUploadBatchOutcome(false, isAmbiguousUploadError(error));
  } finally {
    uploadProgressMessage(TARGET_CPA, total);
    renderTable();
    flushWorkspaceSave({ interrupted: true });
  }
}

function cancelCurrentUpload() {
  if (!uploadBusy || uploadCancelRequested) return;
  uploadCancelRequested = true;
  $("btnCancelUpload").disabled = true;
  $("btnCancelUpload").textContent = "正在取消…";
  showMsg(
    `正在取消 ${activeUploadTarget} 上传。尚未开始的批次会立即停止；当前批次若已到达目标服务器，仍可能完成`,
    "info"
  );
  uploadAbortController?.abort();
}

function canRemoteTransferItem(item, target) {
  if (!item || item.error) return false;
  const origin = itemRemoteOrigin(item);
  if (!origin || origin === target) return false;
  const ref = item.remoteRef || {};
  if (origin === TARGET_CPA) {
    return Boolean(String(ref.name || item.sourceFile || "").trim());
  }
  if (origin === TARGET_SUB2API) {
    if (ref.id != null && ref.id !== "") return true;
    const fromFile = String(item.sourceFile || "").replace(/^sub2-remote:/, "");
    return Boolean(fromFile);
  }
  return false;
}

function shouldUseRemoteTransfer(list, target) {
  if (!Array.isArray(list) || !list.length) return false;
  return list.every((item) => canRemoteTransferItem(item, target));
}

function remoteTransferSourceOf(list) {
  for (const item of list || []) {
    const origin = itemRemoteOrigin(item);
    if (origin) return origin;
  }
  return null;
}

function buildTransferItemPayload(item, source) {
  const ref = item.remoteRef || {};
  const proxyId = getItemProxyId(item);
  if (source === TARGET_CPA) {
    const name = String(ref.name || item.sourceFile || "").trim();
    return {
      name,
      clientId: item.id,
      ...(proxyId != null ? { proxyId } : {}),
    };
  }
  const id =
    ref.id != null && ref.id !== ""
      ? ref.id
      : String(item.sourceFile || "").replace(/^sub2-remote:/, "");
  return {
    id,
    clientId: item.id,
    ...(proxyId != null ? { proxyId } : {}),
  };
}

async function uploadTransferBatch(
  entries,
  total,
  batchNumber,
  batchCount,
  source,
  target,
  sourceConfigPayload,
  targetConfigPayload,
  uploadOptions = {}
) {
  throwIfUploadCancelled();
  for (const entry of entries) {
    setItemUploadState(
      entry.item,
      UPLOAD_STATUS.UPLOADING,
      target,
      `远端直传第 ${batchNumber}/${batchCount} 批，本批 ${entries.length} 个`
    );
  }
  uploadProgressMessage(target, total);
  renderTable();

  const body = {
    source,
    target,
    items: entries.map((entry) => entry.payload),
    convert: readConvertOptionsFromUi(),
    upload: {
      maxAttempts: Math.max(1, Number(uploadOptions.maxAttempts) || DEFAULT_UPLOAD_ATTEMPTS),
      retryAmbiguous: uploadOptions.ambiguousRetry === "auto",
      skipExpired: shouldSkipExpiredAccounts(),
    },
  };
  if (sourceConfigPayload) body.sourceConfig = sourceConfigPayload;
  if (targetConfigPayload) body.targetConfig = targetConfigPayload;
  if (source === TARGET_SUB2API) {
    body.timezone =
      (typeof Intl !== "undefined" && Intl.DateTimeFormat?.().resolvedOptions?.().timeZone) ||
      "UTC";
  }

  try {
    const { data } = await fetchJson(
      "/api/transfer/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: uploadAbortController?.signal,
      },
      660000
    );
    const resultMap = new Map();
    for (const row of data?.results || []) {
      if (row?.clientId) resultMap.set(String(row.clientId), row);
      if (row?.key != null && row.key !== "") resultMap.set(String(row.key), row);
    }
    let batchOk = true;
    let batchAmbiguous = false;
    for (const entry of entries) {
      const payloadKey = String(entry.payload.id ?? entry.payload.name ?? "");
      const row =
        resultMap.get(String(entry.item.id)) ||
        (payloadKey ? resultMap.get(payloadKey) : null) ||
        null;
      if (row?.ok) {
        setItemUploadState(
          entry.item,
          UPLOAD_STATUS.SUCCESS,
          target,
          row.email ? `远端直传成功 · ${row.email}` : "远端直传成功，服务器已确认",
          row.attempts || 1
        );
        // 直传不把完整凭证拉回前端；仅标记目标格式已处理
        entry.item.targetFormat = target === TARGET_SUB2API ? TARGET_SUB2API : "cpa";
      } else if (row?.skipped) {
        // 保留 uploadTarget，进度条才能把跳过计入总数
        setItemUploadState(
          entry.item,
          UPLOAD_STATUS.SKIPPED,
          target,
          row.error || "已跳过失效账号",
          0
        );
      } else if (row?.unknown) {
        batchOk = false;
        batchAmbiguous = true;
        setItemUploadState(
          entry.item,
          UPLOAD_STATUS.UNKNOWN,
          target,
          row.error ? `请求结果未知：${row.error}` : "请求结果未知，请先到目标服务器核对",
          row.attempts || 1
        );
      } else {
        batchOk = false;
        setItemUploadState(
          entry.item,
          UPLOAD_STATUS.FAILED,
          target,
          row?.error || "远端直传失败",
          row?.attempts || 1
        );
      }
    }
    noteUploadBatchOutcome(batchOk, batchAmbiguous);
  } catch (error) {
    if (isUploadCancellation(error)) {
      for (const entry of entries) {
        setItemUploadState(
          entry.item,
          UPLOAD_STATUS.CANCELLED,
          target,
          "上传已取消；当前批次可能已在目标站处理，请先核对"
        );
      }
      throw error;
    }
    markBatchAfterRequestError(entries, target, error);
    noteUploadBatchOutcome(false, isAmbiguousUploadError(error));
  } finally {
    uploadProgressMessage(target, total);
    renderTable();
    flushWorkspaceSave({ interrupted: true });
  }
}

async function uploadToServer(target, showConfigOnly = false, options = {}) {
  if (uploadBusy) return;
  if (exportBusy) {
    showMsg("导出进行中，请稍后再上传", "err");
    return;
  }
  if (remoteImportBusy) {
    showMsg("远端导入进行中，请先取消或等待完成后再上传", "err");
    return;
  }
  if (!showConfigOnly && sameSideUploadBlocked(target)) {
    showMsg(
      target === TARGET_SUB2API
        ? "列表含从 SUB2API 远端载入的账号，不可回传到 SUB2API"
        : "列表含从 CPA 远端载入的账号，不可回传到 CPA",
      "err"
    );
    return;
  }
  let operationItems = Array.isArray(options.itemsOverride)
    ? options.itemsOverride.filter(
        (item) =>
          item &&
          !item.error &&
          (item.account || itemNeedsHydration(item) || canRemoteTransferItem(item, target))
      )
    : getOperationItems().filter((item) => canTargetFormat(item, target));
  if (!showConfigOnly && !operationItems.length) {
    showMsg(
      options.itemsOverride
        ? "没有可续传的账号"
        : selectionMode
          ? "请先勾选要上传的账号"
          : "没有可上传的账号",
      "err"
    );
    return;
  }

  const useRemoteTransfer = !showConfigOnly && shouldUseRemoteTransfer(operationItems, target);
  const transferSource = useRemoteTransfer ? remoteTransferSourceOf(operationItems) : null;

  // 本地路径：上传前补全凭证并转换；远端互传：Worker 内拉转传，不把完整 JSON 回前端
  let expiredItems = [];
  let uploadItems = operationItems;
  if (!showConfigOnly && !useRemoteTransfer) {
    try {
      const hydrate = await ensureItemsHydrated(operationItems, {
        progressLabel: "上传",
        allowPartial: true,
      });
      if (hydrate.cancelled) {
        showMsg("已取消补全凭证", "info");
        return;
      }
      if (hydrate.failedCount && !hydrate.okCount && hydrate.pending) {
        showMsg(`补全凭证失败 ${hydrate.failedCount} 个，无法上传`, "err");
        return;
      }
    } catch (error) {
      showMsg(`补全凭证失败：${apiErrorMessage(error)}`, "err");
      return;
    }

    let convertFailed = 0;
    for (const item of operationItems) {
      if (itemNeedsHydration(item) || item.error || !item.account) {
        convertFailed += 1;
        continue;
      }
      const already =
        item.converted &&
        (target === TARGET_SUB2API
          ? item.targetFormat === TARGET_SUB2API
          : item.targetFormat === "cpa" || item.targetFormat === TARGET_CPA);
      if (already) continue;
      try {
        item.converted = convertItemTo(item, target);
        item.targetFormat = target === TARGET_SUB2API ? TARGET_SUB2API : "cpa";
      } catch (e) {
        item.error = "转换失败: " + e.message;
        convertFailed += 1;
      }
    }
    converted = items.some((item) => item.converted);

    uploadItems = operationItems.filter((item) => {
      if (item.error || !item.account || itemNeedsHydration(item) || !item.converted) {
        return false;
      }
      if (target === TARGET_SUB2API) return item.targetFormat === TARGET_SUB2API;
      return item.targetFormat === "cpa" || item.targetFormat === TARGET_CPA;
    });
    if (!uploadItems.length) {
      showMsg(
        convertFailed
          ? `没有可上传的账号，转换/补全失败 ${convertFailed} 个`
          : "没有可上传的账号，请先补全远端凭证",
        "err"
      );
      renderTable();
      scheduleWorkspaceSave({ immediate: true });
      return;
    }

    if (shouldSkipExpiredAccounts()) {
      const filtered = filterExportOrUploadItems(uploadItems);
      expiredItems = filtered.skipped;
      uploadItems = filtered.items;
      if (expiredItems.length) {
        for (const item of expiredItems) {
          const expiredText = item.expiresAt
            ? `已于 ${formatExpiryDisplay(item.expiresAt) || item.expiresAt} 过期`
            : "账号已过期";
          setItemUploadState(
            item,
            UPLOAD_STATUS.SKIPPED,
            target,
            `已跳过，${expiredText}`,
            0
          );
        }
        renderTable();
      }
      if (!uploadItems.length) {
        showMsg(
          expiredItems.length
            ? `所选 ${expiredItems.length} 个账号均已失效，可在「过期处理」中改为仍包含`
            : selectionMode
              ? "请先勾选要上传的账号"
              : "没有可上传的账号",
          "err"
        );
        return;
      }
    }
    renderTable();
    scheduleWorkspaceSave({ immediate: true });
  } else if (!showConfigOnly && useRemoteTransfer) {
    // stub 上若已有过期信息，先在前端过滤；其余由 Worker 拉完后再判断
    if (shouldSkipExpiredAccounts()) {
      const filtered = filterExportOrUploadItems(operationItems);
      expiredItems = filtered.skipped;
      uploadItems = filtered.items;
      if (expiredItems.length) {
        for (const item of expiredItems) {
          const expiredText = item.expiresAt
            ? `已于 ${formatExpiryDisplay(item.expiresAt) || item.expiresAt} 过期`
            : "账号已过期";
          setItemUploadState(
            item,
            UPLOAD_STATUS.SKIPPED,
            target,
            `已跳过，${expiredText}`,
            0
          );
        }
        renderTable();
      }
      if (!uploadItems.length) {
        showMsg(
          expiredItems.length
            ? `所选 ${expiredItems.length} 个账号均已失效，可在「过期处理」中改为仍包含`
            : "没有可上传的账号",
          "err"
        );
        return;
      }
    } else {
      uploadItems = operationItems;
    }
  }

  if (!showConfigOnly && !runtimeTargetStatus) await loadRuntimeConfigStatus(false);
  const batchSize = showConfigOnly ? null : readBatchSize(target);
  if (!showConfigOnly && !batchSize) return;
  const uploadConcurrency = showConfigOnly ? null : readUploadConcurrency(target);
  if (!showConfigOnly && !uploadConcurrency) return;
  const uploadAttempts = showConfigOnly ? null : readUploadAttempts(target);
  if (!showConfigOnly && !uploadAttempts) return;
  const ambiguousRetry =
    target === TARGET_SUB2API ? readSub2AmbiguousRetry() : DEFAULT_SUB2_AMBIGUOUS_RETRY;
  saveUiSettingsSoon();

  const verified = await ensureVerifiedConfig(target, showConfigOnly);
  if (!verified) return;

  let sourceConfigPayload = undefined;
  if (useRemoteTransfer) {
    const sourceVerified = await ensureVerifiedConfig(transferSource, false);
    if (!sourceVerified) {
      showMsg(`请先配置源端 ${transferSource} 后再远端直传`, "err");
      return;
    }
    const sourceEffective = getEffectiveClientConfig(transferSource);
    if (!sourceEffective) {
      showMsg(`${transferSource} 配置无效，已取消上传`, "err");
      return;
    }
    sourceConfigPayload = uploadConfigPayload(sourceEffective);
  }

  const effective = getEffectiveClientConfig(target);
  if (!effective) {
    showMsg(`${target} 配置无效，已取消上传`, "err");
    return;
  }
  const configPayload = uploadConfigPayload(effective);

  let skippedInvalidProxy = [];
  let forcedInvalidProxy = false;
  if (target === TARGET_SUB2API && !showConfigOnly) {
    try {
      // 直传路径也套用默认代理 ID，并做目标站代理存在性校验
      const prepared = await prepareSub2UploadItems(uploadItems, configPayload);
      if (!prepared.ok) return;
      uploadItems = prepared.items;
      skippedInvalidProxy = prepared.skippedInvalid || [];
      forcedInvalidProxy = Boolean(prepared.forced);
    } catch (error) {
      showMsg(error?.message || String(error), "err");
      renderTable();
      return;
    }
    if (!uploadItems.length) {
      showMsg("没有可上传的账号", "err");
      return;
    }
  }

  // 进度与完成统计的「共」= 实际上传 + 上传前已跳过，保证各状态之和可对上
  const preSkippedItems = [];
  const seenProgressId = new Set();
  for (const item of [...expiredItems, ...skippedInvalidProxy]) {
    if (!item?.id || seenProgressId.has(item.id)) continue;
    seenProgressId.add(item.id);
    preSkippedItems.push(item);
  }
  const progressTotal = uploadItems.length + preSkippedItems.length;
  activeUploadItemIds = new Set([
    ...uploadItems.map((item) => item.id),
    ...preSkippedItems.map((item) => item.id),
  ]);
  restoredJobMeta = {
    target,
    itemIds: Array.from(activeUploadItemIds),
  };
  uploadCancelRequested = false;
  uploadAbortController = new AbortController();
  resetAdaptiveUpload(uploadConcurrency);
  setUploadBusy(true, target);
  clearMsg();
  const preSkipNotes = [];
  if (useRemoteTransfer) preSkipNotes.push("远端直传");
  if (expiredItems.length) preSkipNotes.push(`跳过 ${expiredItems.length} 个失效账号`);
  if (skippedInvalidProxy.length)
    preSkipNotes.push(`跳过 ${skippedInvalidProxy.length} 个无效代理账号`);
  if (forcedInvalidProxy) preSkipNotes.push("含强制上传的无效代理账号");
  if (preSkipNotes.length) {
    showMsg(`${preSkipNotes.join("，")}，开始上传 ${uploadItems.length} 个`, "info");
  }
  for (const item of uploadItems) {
    setItemUploadState(
      item,
      UPLOAD_STATUS.QUEUED,
      target,
      useRemoteTransfer ? "等待远端直传批次" : "等待上传批次",
      0
    );
  }
  uploadProgressMessage(target, progressTotal);
  renderTable();
  try {
    if (useRemoteTransfer) {
      const entries = uploadItems.map((item) => ({
        item,
        payload: buildTransferItemPayload(item, transferSource),
      }));
      const batches = [];
      for (let i = 0; i < entries.length; i += batchSize) {
        batches.push(entries.slice(i, i + batchSize));
      }
      await runWithAdaptiveConcurrency(
        batches,
        () => adaptiveUploadConcurrency,
        async (batchEntries, index) =>
          uploadTransferBatch(
            batchEntries,
            progressTotal,
            index + 1,
            batches.length,
            transferSource,
            target,
            sourceConfigPayload,
            configPayload,
            { maxAttempts: uploadAttempts, ambiguousRetry }
          )
      );
    } else if (target === TARGET_SUB2API) {
      const entries = uploadItems.map((item) => {
        const account = convertItemTo(item, TARGET_SUB2API);
        item.converted = account;
        item.targetFormat = TARGET_SUB2API;
        return { item, account };
      });
      converted = items.some((row) => row.converted);
      const batches = [];
      for (let i = 0; i < entries.length; i += batchSize) {
        batches.push(entries.slice(i, i + batchSize));
      }
      await runWithAdaptiveConcurrency(
        batches,
        () => adaptiveUploadConcurrency,
        async (batchEntries, index) =>
          uploadSub2Batch(batchEntries, progressTotal, index + 1, batches.length, configPayload, {
            maxAttempts: uploadAttempts,
            ambiguousRetry,
          })
      );
    } else {
      const entries = uniqueCpaUploadEntries(uploadItems);
      const batches = [];
      for (let i = 0; i < entries.length; i += batchSize) {
        batches.push(entries.slice(i, i + batchSize));
      }
      await runWithAdaptiveConcurrency(
        batches,
        () => adaptiveUploadConcurrency,
        async (batchEntries, index) =>
          uploadCpaBatch(batchEntries, progressTotal, index + 1, batches.length, configPayload, {
            maxAttempts: uploadAttempts,
          })
      );
    }
    // 统计范围与进度条一致：上传项 + 上传前跳过项
    const statScope = [...uploadItems, ...preSkippedItems];
    const success = statScope.filter((item) => item.uploadStatus === UPLOAD_STATUS.SUCCESS).length;
    const failed = statScope.filter((item) => item.uploadStatus === UPLOAD_STATUS.FAILED).length;
    const unknown = statScope.filter((item) => item.uploadStatus === UPLOAD_STATUS.UNKNOWN).length;
    const cancelled = statScope.filter(
      (item) => item.uploadStatus === UPLOAD_STATUS.CANCELLED
    ).length;
    const skipped = statScope.filter((item) => item.uploadStatus === UPLOAD_STATUS.SKIPPED).length;
    uploadProgressMessage(target, progressTotal);
    const parts = [
      `成功：${success}`,
      `失败：${failed}`,
      `未知：${unknown}`,
      `跳过：${skipped}`,
    ];
    if (cancelled) parts.push(`已取消：${cancelled}`);
    // 成功+失败+未知+跳过+已取消 应等于本次账号总数
    const accounted = success + failed + unknown + cancelled + skipped;
    if (progressTotal > 0 && accounted !== progressTotal) {
      parts.push(`未归类：${Math.max(0, progressTotal - accounted)}`);
    }
    if (expiredItems.length) parts.push(`失效：${expiredItems.length}`);
    if (skippedInvalidProxy.length) parts.push(`无效代理：${skippedInvalidProxy.length}`);
    if (forcedInvalidProxy) parts.push("含强制上传");
    showMsg(
      `${target} ${useRemoteTransfer ? "远端直传" : "上传"}完成，${parts.join("，")}`,
      failed || unknown ? "info" : "ok"
    );
  } catch (error) {
    if (isUploadCancellation(error)) {
      for (const item of uploadItems) {
        if ([UPLOAD_STATUS.QUEUED, UPLOAD_STATUS.UPLOADING].includes(item.uploadStatus)) {
          setItemUploadState(
            item,
            UPLOAD_STATUS.CANCELLED,
            target,
            "尚未完成，用户已取消上传",
            item.uploadAttempts
          );
        }
      }
      showMsg(
        `${target} 上传已取消。当前批次可能已被服务器处理，状态为“已取消”的账号请先到服务器核对`,
        "info"
      );
    } else {
      const message = apiErrorMessage(error);
      for (const item of uploadItems) {
        if ([UPLOAD_STATUS.QUEUED, UPLOAD_STATUS.UPLOADING].includes(item.uploadStatus)) {
          setItemUploadState(
            item,
            UPLOAD_STATUS.UNKNOWN,
            target,
            `上传中止：${message}；请先核对服务器`,
            item.uploadAttempts
          );
        }
      }
      showMsg(`${target} 上传中止：${message}`, "err");
    }
  } finally {
    activeUploadItemIds = null;
    uploadAbortController = null;
    uploadCancelRequested = false;
    $("btnCancelUpload").textContent = "取消上传";
    setUploadBusy(false);
    renderTable();
    flushWorkspaceSave({ interrupted: false });
  }
}

async function resumeRestoredUploadJob() {
  const target = restoredJobMeta?.target || activeUploadTarget || "";
  if (!target) {
    showMsg("没有可续传的上传任务", "info");
    return;
  }
  if (uploadBusy) {
    showMsg("上传进行中", "err");
    return;
  }
  const jobItemIds = restoredJobMeta?.itemIds || null;
  const stats = countUploadStats(
    jobItemIds ? items.filter((item) => jobItemIds.includes(item.id)) : items,
    target
  );
  const resumable = summarizeResumeCandidates(items, target, {
    includeUnknown: false,
    itemIds: jobItemIds,
  });
  const unknownCount = summarizeResumeCandidates(items, target, {
    includeUnknown: true,
    itemIds: jobItemIds,
  }).filter(
    (item) =>
      item.uploadStatus === UPLOAD_STATUS.UNKNOWN || item.uploadStatus === UPLOAD_STATUS.UPLOADING
  ).length;
  if (!resumable.length && !unknownCount) {
    showMsg(`${target} 没有可续传的账号，成功：${stats.success}`, "info");
    hideWorkspaceRestoreBanner();
    return;
  }
  const decision = await openResumeUploadModal({
    target,
    resumableCount: resumable.length,
    unknownCount,
    successCount: stats.success,
  });
  if (!decision?.ok) {
    showMsg("已取消续传", "info");
    return;
  }
  const toUpload = summarizeResumeCandidates(items, target, {
    includeUnknown: Boolean(decision.includeUnknown),
    itemIds: jobItemIds,
  });
  if (!toUpload.length) {
    showMsg("没有符合条件的续传账号", "err");
    return;
  }
  selectionMode = false;
  for (const item of items) item.selected = false;
  hideWorkspaceRestoreBanner();
  renderTable();
  await uploadToServer(target, false, { itemsOverride: toUpload });
}

async function restoreWorkspaceFromPending({ resume = false } = {}) {
  // 列表已在内存中时，「继续续传」只走续传，不再重新灌快照
  if (!pendingWorkspaceSnapshot && items.length && restoredJobMeta?.target && resume) {
    await resumeRestoredUploadJob();
    return;
  }
  const snapshot = pendingWorkspaceSnapshot || (await readWorkspaceSnapshot());
  if (!snapshot?.items?.length) {
    if (items.length && restoredJobMeta?.target && resume) {
      await resumeRestoredUploadJob();
      return;
    }
    showMsg("没有可恢复的工作区快照", "info");
    hideWorkspaceRestoreBanner();
    return;
  }
  if (uploadBusy) {
    showMsg("上传进行中，无法恢复快照", "err");
    return;
  }
  if (items.length && pendingWorkspaceSnapshot) {
    const ok = window.confirm(
      `当前列表已有 ${items.length} 个账号。恢复快照将替换当前列表，是否继续？`
    );
    if (!ok) return;
  }
  const target = snapshot.uploadJob?.target || "";
  applyWorkspaceSnapshot(snapshot, { normalizeUpload: true });
  showMsg(`已恢复 ${items.length} 个账号到本地列表`, "ok");
  if (resume && target) {
    await resumeRestoredUploadJob();
    return;
  }
  if (target) showPostRestoreResumeBanner(target);
}

async function discardPendingWorkspace() {
  if (uploadBusy) {
    showMsg("上传进行中，无法丢弃快照", "err");
    return;
  }
  // 列表已恢复后的「关闭提示」：只隐藏横幅，不删快照
  if (!pendingWorkspaceSnapshot && items.length) {
    hideWorkspaceRestoreBanner();
    const discardBtn = $("btnDiscardWorkspace");
    if (discardBtn) discardBtn.textContent = "丢弃快照";
    return;
  }
  const count = pendingWorkspaceSnapshot?.items?.length || 0;
  const ok = window.confirm(
    count ? `确定丢弃本机保存的 ${count} 个账号快照？此操作不可恢复。` : "确定丢弃本机工作区快照？"
  );
  if (!ok) return;
  restoredJobMeta = null;
  await clearWorkspaceSnapshot();
  showMsg("已丢弃本地工作区快照", "info");
}
