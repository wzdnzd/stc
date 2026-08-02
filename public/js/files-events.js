async function handleFiles(fileList) {
  if (uploadBusy) {
    showMsg("上传进行中，请先取消或等待完成后再导入", "err");
    return;
  }
  if (remoteImportBusy) {
    showMsg("远端导入进行中，请先取消或等待完成后再导入", "err");
    return;
  }
  clearMsg();
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const incoming = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const parsed = parseFileContent(file.name, text);
      incoming.push(...parsed);
    } catch (e) {
      incoming.push(
        prepareItem({
          sourceFile: file.name,
          sourceFormat: "unknown",
          account: null,
          error: "读取失败: " + e.message,
        })
      );
    }
  }
  if (!incoming.length) {
    showMsg("未从所选文件中解析到账号", "err");
    return;
  }

  const result = await commitIncomingItems(incoming, {
    sourceLabel: "本机文件",
    emptyMessage: "未从所选文件中解析到账号",
    resetFileInput: true,
    unlockDirectionOnSuccess: true,
  });
  if (!result) return;

  const msg = formatCommitMessage(result, [`已导入 ${files.length} 个文件`]);
  showMsg(msg, "ok");
}

function clearAll() {
  if (uploadBusy) {
    showMsg("上传进行中，无法清空", "err");
    return;
  }
  if (exportBusy) {
    showMsg("导出进行中，无法清空", "err");
    return;
  }
  if (remoteImportBusy) {
    showMsg("远端导入进行中，无法清空", "err");
    return;
  }
  items = [];
  converted = false;
  activeExportItemIds = null;
  fileInput.value = "";
  selectionMode = false;
  tableSearch = "";
  tableSort = { key: "", dir: "asc" };
  proxyEditingItemId = null;
  restoredJobMeta = null;
  hasPendingRemoteHydration = false;
  unlockDirection({ silent: true });
  $("accountSearch").value = "";
  clearTableFilters({ render: false });
  setUploadProgressVisible(false);
  clearMsg();
  renderTable();
  clearWorkspaceSnapshot();
  pendingWorkspaceSnapshot = null;
  hideWorkspaceRestoreBanner();
  const discardBtn = $("btnDiscardWorkspace");
  if (discardBtn) discardBtn.textContent = "丢弃快照";
}

function commitProxyInlineEdit(itemId, rawValue) {
  const item = items.find((row) => row.id === itemId);
  if (!item) return false;
  const text = String(rawValue ?? "").trim();
  if (text === "") {
    setItemProxyId(item, null);
  } else {
    const proxyId = parseProxyId(text);
    if (proxyId == null) {
      showMsg("代理 ID 必须是 0 或正整数", "err");
      return false;
    }
    setItemProxyId(item, proxyId);
    if (cachedSub2ProxyIdSet.size) {
      item.proxyValid = cachedSub2ProxyIdSet.has(proxyId);
    }
  }
  proxyEditingItemId = null;
  renderTable();
  scheduleWorkspaceSave({ immediate: true });
  return true;
}

function cancelProxyInlineEdit() {
  proxyEditingItemId = null;
  renderTable();
}

// events
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => handleFiles(fileInput.files));
$("btnImportModeToggle")?.addEventListener("click", () => {
  setImportMode(importMode === "remote" ? "local" : "remote");
});
$("remoteSourceSelect")?.addEventListener("change", (event) => {
  setRemoteSourceTarget(event.target.value);
});
$("btnRemoteConfigSource")?.addEventListener("click", async () => {
  const sourceTarget = normalizeRemoteSourceTarget(remoteSourceTarget);
  await openConfigDialog({
    target: sourceTarget,
    reason: `配置源端 ${sourceTarget} 后可拉取账号列表`,
    mode: "manage",
  });
  refreshRemoteImportUi();
});
$("btnRemotePullList")?.addEventListener("click", () => {
  pullRemoteAccountList().catch((error) => {
    const detail = apiErrorMessage(error);
    setRemoteImportStatus(`拉取失败：${detail}`, "err", { toast: true });
    remoteImportAbortController = null;
    remoteImportCancelRequested = false;
    setRemoteImportBusy(false);
    refreshRemoteImportUi();
  });
});
$("btnRemoteSub2Dedupe")?.addEventListener("click", () => startSub2apiDedupe());
$("btnRemoteAbort")?.addEventListener("click", cancelRemoteImport);
$("btnUnlockDirection")?.addEventListener("click", () => unlockDirection());
$("btnExportSub2").addEventListener("click", exportSub2);
$("btnExportCpaZip").addEventListener("click", exportCpaZip);
$("btnUploadSub2").addEventListener("click", (event) =>
  uploadToServer(TARGET_SUB2API, event.shiftKey)
);
$("btnUploadCpa").addEventListener("click", (event) => uploadToServer(TARGET_CPA, event.shiftKey));
$("btnCancelUpload").addEventListener("click", cancelCurrentUpload);
$("btnClear").addEventListener("click", clearAll);

$("btnSelectMode").addEventListener("click", () => {
  selectionMode = !selectionMode;
  if (!selectionMode) {
    for (const item of items) item.selected = false;
    clearTableFilters({ render: false });
  }
  renderTable();
});
$("btnExitSelection").addEventListener("click", () => {
  selectionMode = false;
  for (const item of items) item.selected = false;
  clearTableFilters({ render: false });
  renderTable();
});
$("btnSelectVisible").addEventListener("click", () => {
  selectVisibleFilterResults();
  renderTable();
});
$("btnClearSelection").addEventListener("click", () => {
  for (const item of items) item.selected = false;
  renderTable();
});
tbody.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".row-check");
  if (!checkbox) return;
  const item = items.find((row) => row.id === checkbox.dataset.itemId);
  if (item) item.selected = checkbox.checked;
  renderTable();
});

// 主列表多选筛选：同行下拉，选项来自当前列表实际字段值
$("tableFilterBar")?.addEventListener("click", (event) => {
  // 菜单在 fixed 定位下仍挂在 filter bar 内；内部点击不关闭
  if (event.target.closest(".msel-menu")) {
    event.stopPropagation();
    return;
  }
  const btn = event.target.closest(".msel-btn");
  if (!btn) return;
  event.preventDefault();
  event.stopPropagation();
  const root = btn.closest(".msel[data-filter-key]");
  const key = root?.getAttribute("data-filter-key") || "";
  if (!key || btn.disabled) return;
  openTableFilterKey = openTableFilterKey === key ? null : key;
  syncTableFilterControls();
});
$("tableFilterBar")?.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-filter-key][data-filter-value]");
  if (!input) return;
  event.stopPropagation();
  const key = input.getAttribute("data-filter-key") || "";
  const value = input.getAttribute("data-filter-value") || "";
  if (!key || !tableFilters[key]) return;
  if (input.checked) tableFilters[key].add(value);
  else tableFilters[key].delete(value);
  // 勾选筛选条件后，自动选中当前筛选结果
  selectVisibleFilterResults();
  renderTable();
});
$("btnClearTableFilters")?.addEventListener("click", () => {
  clearTableFilters({ render: false });
  // 清除筛选后按当前可见结果重新同步勾选
  selectVisibleFilterResults();
  renderTable();
});
document.addEventListener("click", (event) => {
  if (!openTableFilterKey) return;
  if (event.target.closest?.("#tableFilterBar") || event.target.closest?.(".msel-menu")) return;
  closeOpenTableFilter();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openTableFilterKey) {
    closeOpenTableFilter();
  }
});
window.addEventListener(
  "resize",
  () => {
    if (openTableFilterKey) syncTableFilterControls();
  },
  { passive: true }
);
window.addEventListener(
  "scroll",
  () => {
    if (openTableFilterKey) syncTableFilterControls();
  },
  { passive: true, capture: true }
);

$("btnSearchToggle").addEventListener("click", () => {
  searchVisible = !searchVisible;
  renderTable();
  if (searchVisible) setTimeout(() => $("accountSearch").focus(), 0);
});
$("accountSearch").addEventListener("input", (event) => {
  tableSearch = event.target.value;
  renderTable();
});
$("btnClearSearch").addEventListener("click", () => {
  tableSearch = "";
  $("accountSearch").value = "";
  renderTable();
  $("accountSearch").focus();
});

var tableHead = document.querySelector(".table-wrap thead");
if (tableHead) {
  tableHead.addEventListener("click", (event) => {
    if (event.target.closest("button, input, label, a")) return;
    const th = event.target.closest("th[data-sort]");
    if (!th || !tableHead.contains(th)) return;
    toggleTableSort(th.getAttribute("data-sort") || "");
  });
  tableHead.addEventListener("keydown", (event) => {
    if (event.target.closest("button, input, label, a")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const th = event.target.closest("th[data-sort]");
    if (!th || !tableHead.contains(th)) return;
    event.preventDefault();
    toggleTableSort(th.getAttribute("data-sort") || "");
  });
}

$("direction").addEventListener("change", () => {
  if (directionLockedByRemote) {
    // 锁定期间 select 应为 disabled；若仍触发则忽略
    return;
  }
  clearConvertedState();
  renderTable();
  saveUiSettingsSoon();
  scheduleWorkspaceSave();
});

function bindClampedNumber(inputId, getMax, getFallback) {
  const input = $(inputId);
  const normalize = () => {
    const max = getMax();
    const value = clampInt(input.value, 1, max, getFallback(max));
    input.value = String(value);
    saveUiSettingsSoon();
  };
  input.addEventListener("change", normalize);
  input.addEventListener("blur", normalize);
}
bindClampedNumber(
  "batchSub2",
  () => currentMaxBatch(TARGET_SUB2API),
  (max) => Math.min(DEFAULT_BATCH_SUB2API, max)
);
bindClampedNumber(
  "batchCpa",
  () => currentMaxBatch(TARGET_CPA),
  (max) => Math.min(DEFAULT_BATCH_CPA, max)
);
bindClampedNumber(
  "uploadConcurrencySub2",
  () => currentMaxUploadConcurrency(TARGET_SUB2API),
  () => DEFAULT_UPLOAD_CONCURRENCY
);
bindClampedNumber(
  "uploadConcurrencyCpa",
  () => currentMaxUploadConcurrency(TARGET_CPA),
  () => DEFAULT_UPLOAD_CONCURRENCY
);
bindClampedNumber(
  "sub2UploadAttempts",
  () => currentMaxUploadAttempts(TARGET_SUB2API),
  (max) => Math.min(DEFAULT_UPLOAD_ATTEMPTS, max)
);
bindClampedNumber(
  "cpaUploadAttempts",
  () => currentMaxUploadAttempts(TARGET_CPA),
  (max) => Math.min(DEFAULT_UPLOAD_ATTEMPTS, max)
);

for (const id of [
  "nameStrategy",
  "concurrency",
  "priority",
  "rateMultiplier",
  "defaultProxyId",
  "sub2AmbiguousRetry",
  "skipExpiredAccounts",
]) {
  $(id).addEventListener("change", saveUiSettingsSoon);
}
$("defaultProxyId")?.addEventListener("blur", () => {
  const raw = String($("defaultProxyId").value ?? "").trim();
  if (raw === "") {
    $("defaultProxyId").value = "";
    saveUiSettingsSoon();
    return;
  }
  const proxyId = parseProxyId(raw);
  if (proxyId == null) {
    showMsg("默认代理 ID 必须是 0 或正整数，或留空", "err");
    $("defaultProxyId").value = "";
  } else {
    $("defaultProxyId").value = String(proxyId);
  }
  saveUiSettingsSoon();
});
for (const id of ["autoPause", "keepSso", "keepHeaders"]) {
  $(id).addEventListener("change", saveUiSettingsSoon);
}

applyUiSettings(readUiSettings());
updateUploadLimitHints();

$("themeSwitch")?.addEventListener("click", (event) => {
  const btn = event.target?.closest?.("[data-theme-mode]");
  if (!btn || !$("themeSwitch").contains(btn)) return;
  applyThemeMode(btn.getAttribute("data-theme-mode"));
});

try {
  const themeMedia = window.matchMedia("(prefers-color-scheme: light)");
  const onThemeMediaChange = () => {
    if (getThemeMode() === "auto") applyThemeMode("auto", { persist: false });
  };
  if (typeof themeMedia.addEventListener === "function") {
    themeMedia.addEventListener("change", onThemeMediaChange);
  } else if (typeof themeMedia.addListener === "function") {
    themeMedia.addListener(onThemeMediaChange);
  }
} catch {}

$("btnCloseConfig").addEventListener("click", () => closeConfigDialog(false));
$("btnCancelConfig").addEventListener("click", () => closeConfigDialog(false));
$("serverConfigModal").addEventListener("click", (event) => {
  if (event.target === $("serverConfigModal")) closeConfigDialog(false);
});
$("btnSaveVerifyConfig").addEventListener("click", () => {
  saveAndVerifyCurrentConfigForm().catch((error) => {
    setConfigStatus(apiErrorMessage(error), "err");
  });
});
$("btnClearLocalConfig").addEventListener("click", () => clearCurrentLocalConfig());
// 顶栏徽章点击：打开对应目标的单目标配置（无 Tab 切换）
$("badgeSub2Config").addEventListener("click", () => {
  openConfigDialog({ target: TARGET_SUB2API, reason: "", mode: "manage" });
});
$("badgeCpaConfig").addEventListener("click", () => {
  openConfigDialog({ target: TARGET_CPA, reason: "", mode: "manage" });
});
$("btnCloseSub2Dedupe")?.addEventListener("click", () => closeSub2DedupeModal());
$("btnCancelSub2Dedupe")?.addEventListener("click", () => closeSub2DedupeModal());
$("sub2DedupeModal")?.addEventListener("click", (event) => {
  if (event.target === $("sub2DedupeModal")) closeSub2DedupeModal();
});
$("btnScanSub2Dedupe")?.addEventListener("click", () => {
  scanSub2apiDuplicates().catch((error) => {
    setSub2DedupeStatus(apiErrorMessage(error), "err");
  });
});
$("btnApplySub2Dedupe")?.addEventListener("click", () => {
  applySub2apiDuplicates().catch((error) => {
    setSub2DedupeStatus(apiErrorMessage(error), "err");
  });
});
$("sub2DedupeGroups")?.addEventListener("click", (event) => {
  const btn = event.target?.closest?.("button[data-dedupe-keep-id]");
  if (!btn || !$("sub2DedupeGroups").contains(btn)) return;
  const groupIndex = Number(btn.getAttribute("data-dedupe-keep-group"));
  const accountId = btn.getAttribute("data-dedupe-keep-id");
  if (!Number.isFinite(groupIndex) || accountId == null || accountId === "") return;
  setSub2DedupeKeepSelection(groupIndex, accountId);
});

// 从 SUB2API 导出 / 从 CPA 下载
$("btnCpaRemoteDownload")?.addEventListener("click", () => openCpaRemoteDownloadModal());
$("btnCloseCpaRemoteDownload")?.addEventListener("click", () => closeCpaRemoteDownloadModal());
$("btnCancelCpaRemoteDownload")?.addEventListener("click", () => closeCpaRemoteDownloadModal());
$("cpaRemoteDownloadModal")?.addEventListener("click", (event) => {
  if (event.target === $("cpaRemoteDownloadModal")) closeCpaRemoteDownloadModal();
});
$("btnRefreshCpaRemoteList")?.addEventListener("click", () => {
  loadCpaRemoteAuthList().catch((error) => {
    setCpaRemoteStatus(`加载失败：${apiErrorMessage(error)}`, "err");
  });
});
$("btnCpaRemoteSelectAll")?.addEventListener("click", () => selectAllCpaRemoteVisible());
$("btnCpaRemoteSelectNone")?.addEventListener("click", () => clearCpaRemoteSelection());
$("btnCpaRemoteSelectFailed")?.addEventListener("click", () => selectCpaRemoteFailed());
$("cpaRemoteFailedOnly")?.addEventListener("change", (event) => {
  cpaRemoteFailedOnly = Boolean(event.target?.checked);
  renderCpaRemoteList();
});
$("cpaRemoteSearch")?.addEventListener("input", (event) => {
  cpaRemoteSearch = event.target.value || "";
  renderCpaRemoteList();
});
$("cpaRemoteList")?.addEventListener("change", (event) => {
  const input = event.target?.closest?.("input[data-cpa-remote-name]");
  if (!input) return;
  const name = input.getAttribute("data-cpa-remote-name") || "";
  if (!name) return;
  if (input.checked) cpaRemoteSelected.add(name);
  else cpaRemoteSelected.delete(name);
  updateCpaRemoteSelectionMeta();
});
$("btnDownloadCpaRemoteSelected")?.addEventListener("click", () => {
  downloadSelectedCpaRemoteAuth().catch((error) => {
    setCpaRemoteStatus(`下载失败：${apiErrorMessage(error)}`, "err");
  });
});
$("btnAbortCpaRemoteDownload")?.addEventListener("click", () => cancelCpaRemoteTask());

$("btnSub2RemoteExport")?.addEventListener("click", () => openSub2RemoteExportModal());
$("btnCloseSub2RemoteExport")?.addEventListener("click", () => closeSub2RemoteExportModal());
$("btnCancelSub2RemoteExport")?.addEventListener("click", () => closeSub2RemoteExportModal());
$("btnAbortSub2RemoteExport")?.addEventListener("click", () => cancelSub2RemoteTask());
$("sub2RemoteExportModal")?.addEventListener("click", (event) => {
  if (event.target === $("sub2RemoteExportModal")) closeSub2RemoteExportModal();
});
$("btnRefreshSub2RemoteList")?.addEventListener("click", () => {
  loadSub2RemoteAccountList().catch((error) => {
    setSub2RemoteStatus(`加载失败：${apiErrorMessage(error)}`, "err");
  });
});
$("btnSub2RemoteSelectAll")?.addEventListener("click", () => selectAllSub2RemoteVisible());
$("btnSub2RemoteSelectNone")?.addEventListener("click", () => clearSub2RemoteSelection());
$("btnSub2RemoteSelectFailed")?.addEventListener("click", () => selectSub2RemoteFailed());
$("sub2RemoteFailedOnly")?.addEventListener("change", (event) => {
  sub2RemoteFailedOnly = Boolean(event.target?.checked);
  renderSub2RemoteList();
});
$("sub2RemoteSearch")?.addEventListener("input", (event) => {
  sub2RemoteSearch = event.target.value || "";
  renderSub2RemoteList();
});
$("sub2RemoteList")?.addEventListener("change", (event) => {
  const input = event.target?.closest?.("input[data-sub2-remote-id]");
  if (!input) return;
  const id = input.getAttribute("data-sub2-remote-id") || "";
  if (!id) return;
  if (input.checked) sub2RemoteSelected.add(id);
  else sub2RemoteSelected.delete(id);
  updateSub2RemoteSelectionMeta();
});
$("btnExportSub2RemoteSelected")?.addEventListener("click", () => {
  exportSelectedSub2RemoteAccounts().catch((error) => {
    setSub2RemoteStatus(`导出失败：${apiErrorMessage(error)}`, "err");
  });
});

// 代理：批量 / 校验弹窗 / 行内编辑
$("btnBatchSetProxy")?.addEventListener("click", openBatchProxyModal);
$("btnBatchClearProxy")?.addEventListener("click", batchClearSelectedProxies);
$("btnRefreshProxyCache")?.addEventListener("click", () => refreshSub2apiProxyCache());
$("btnCloseBatchProxy")?.addEventListener("click", closeBatchProxyModal);
$("btnCancelBatchProxy")?.addEventListener("click", closeBatchProxyModal);
$("batchProxyModal")?.addEventListener("click", (event) => {
  if (event.target === $("batchProxyModal")) closeBatchProxyModal();
});
$("btnApplyBatchProxy")?.addEventListener("click", () => applyBatchProxySettings());
$("batchProxyIdInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyBatchProxySettings();
  }
});

$("btnCloseProxyValidate")?.addEventListener("click", () => closeProxyValidateModal("cancel"));
$("btnCancelProxyValidate")?.addEventListener("click", () => closeProxyValidateModal("cancel"));
$("btnForceUploadInvalid")?.addEventListener("click", () => closeProxyValidateModal("force"));
$("btnSkipInvalidUpload")?.addEventListener("click", () => closeProxyValidateModal("skip"));
$("proxyValidateModal")?.addEventListener("click", (event) => {
  if (event.target === $("proxyValidateModal")) closeProxyValidateModal("cancel");
});
$("btnSelectInvalidInModal")?.addEventListener("click", () => {
  selectInvalidItemsByIds(proxyValidateInvalidIds);
  setProxyValidateStatus(`已选中 ${proxyValidateInvalidIds.length} 个无效代理账号`, "ok");
});
$("btnClearInvalidProxies")?.addEventListener("click", () => {
  const changed = applyProxyFixToInvalid(null);
  renderTable();
  refreshInvalidAfterFix();
  setProxyValidateStatus(`已清除 ${changed} 个账号的无效代理 ID`, "ok");
});
$("btnApplyProxyFix")?.addEventListener("click", () => {
  const raw = String($("proxyFixIdInput").value ?? "").trim();
  if (raw === "") {
    setProxyValidateStatus("请输入要应用的代理 ID", "err");
    return;
  }
  const proxyId = parseProxyId(raw);
  if (proxyId == null) {
    setProxyValidateStatus("代理 ID 必须是 0 或正整数", "err");
    return;
  }
  if (cachedSub2ProxyIdSet.size && !cachedSub2ProxyIdSet.has(proxyId)) {
    setProxyValidateStatus(`代理 ID ${proxyId} 仍不在服务器列表中`, "err");
    return;
  }
  const changed = applyProxyFixToInvalid(proxyId);
  renderTable();
  const still = refreshInvalidAfterFix();
  if (!still.length) {
    setProxyValidateStatus(`已将 ${changed} 个账号改为代理 ID ${proxyId}`, "ok");
  }
});
$("proxyInvalidSummary")?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-select-invalid-id]");
  if (!btn) return;
  const proxyId = Number(btn.dataset.selectInvalidId);
  const ids = items
    .filter((item) => proxyValidateInvalidIds.includes(item.id) && getItemProxyId(item) === proxyId)
    .map((item) => item.id);
  selectInvalidItemsByIds(ids);
  setProxyValidateStatus(`已选中代理 ID ${proxyId} 的 ${ids.length} 个账号`, "ok");
});
$("proxyAvailableList")?.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-pick-proxy-id]");
  if (!chip) return;
  $("proxyFixIdInput").value = chip.dataset.pickProxyId || "";
  $("proxyFixIdInput").focus();
});

tbody.addEventListener("click", (event) => {
  if (uploadBusy) return;
  const startBtn = event.target.closest("[data-proxy-edit-start]");
  if (startBtn) {
    event.preventDefault();
    proxyEditingItemId = startBtn.dataset.proxyEditStart;
    renderTable();
    return;
  }
  const saveBtn = event.target.closest("[data-proxy-save]");
  if (saveBtn) {
    event.preventDefault();
    const wrap = saveBtn.closest("[data-proxy-edit]");
    const input = wrap?.querySelector("input");
    commitProxyInlineEdit(saveBtn.dataset.proxySave, input?.value);
    return;
  }
  const cancelBtn = event.target.closest("[data-proxy-cancel]");
  if (cancelBtn) {
    event.preventDefault();
    cancelProxyInlineEdit();
  }
});
tbody.addEventListener("keydown", (event) => {
  const wrap = event.target.closest?.("[data-proxy-edit]");
  if (!wrap) return;
  if (event.key === "Enter") {
    event.preventDefault();
    commitProxyInlineEdit(wrap.dataset.proxyEdit, event.target.value);
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelProxyInlineEdit();
  }
});

// 工作区恢复横幅
$("btnRestoreWorkspace")?.addEventListener("click", () => {
  restoreWorkspaceFromPending({ resume: false }).catch((error) =>
    showMsg(error?.message || String(error), "err")
  );
});
$("btnRestoreListOnly")?.addEventListener("click", () => {
  restoreWorkspaceFromPending({ resume: false }).catch((error) =>
    showMsg(error?.message || String(error), "err")
  );
});
$("btnRestoreAndResume")?.addEventListener("click", () => {
  restoreWorkspaceFromPending({ resume: true }).catch((error) =>
    showMsg(error?.message || String(error), "err")
  );
});
$("btnDiscardWorkspace")?.addEventListener("click", () => {
  discardPendingWorkspace().catch((error) => showMsg(error?.message || String(error), "err"));
});

// 导入冲突弹窗
$("btnCloseImportConflict")?.addEventListener("click", () => closeImportConflictModal("cancel"));
$("btnCancelImportConflict")?.addEventListener("click", () => closeImportConflictModal("cancel"));
$("importConflictModal")?.addEventListener("click", (event) => {
  if (event.target === $("importConflictModal")) closeImportConflictModal("cancel");
});
$("importConflictModal")?.addEventListener("click", (event) => {
  const btn = event.target.closest?.("[data-import-action]");
  if (!btn) return;
  closeImportConflictModal(btn.getAttribute("data-import-action") || "cancel");
});

// 续传确认弹窗
$("btnCloseResumeUpload")?.addEventListener("click", () =>
  closeResumeUploadModal({ ok: false, includeUnknown: false })
);
$("btnCancelResumeUpload")?.addEventListener("click", () =>
  closeResumeUploadModal({ ok: false, includeUnknown: false })
);
$("resumeUploadModal")?.addEventListener("click", (event) => {
  if (event.target === $("resumeUploadModal")) {
    closeResumeUploadModal({ ok: false, includeUnknown: false });
  }
});
$("btnConfirmResumeUpload")?.addEventListener("click", () => {
  closeResumeUploadModal({
    ok: true,
    includeUnknown: Boolean($("resumeIncludeUnknown")?.checked),
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if ($("resumeUploadModal")?.classList.contains("show")) {
    closeResumeUploadModal({ ok: false, includeUnknown: false });
    return;
  }
  if ($("cpaRemoteDownloadModal")?.classList.contains("show")) {
    closeCpaRemoteDownloadModal();
    return;
  }
  if ($("sub2RemoteExportModal")?.classList.contains("show")) {
    closeSub2RemoteExportModal();
    return;
  }
  if ($("sub2DedupeModal")?.classList.contains("show")) {
    closeSub2DedupeModal();
    return;
  }
  if ($("importConflictModal")?.classList.contains("show")) {
    closeImportConflictModal("cancel");
    return;
  }
  if ($("proxyValidateModal")?.classList.contains("show")) {
    closeProxyValidateModal("cancel");
    return;
  }
  if ($("batchProxyModal")?.classList.contains("show")) {
    closeBatchProxyModal();
    return;
  }
  if ($("serverConfigModal").classList.contains("show")) {
    closeConfigDialog(false);
    return;
  }
  if (proxyEditingItemId) {
    cancelProxyInlineEdit();
  }
});

// 表格内 data-tip 使用 fixed 浮层，避免 .table-wrap overflow 裁切
var floatingTipEl = document.createElement("div");
floatingTipEl.className = "floating-tip";
floatingTipEl.setAttribute("role", "tooltip");
document.body.appendChild(floatingTipEl);
var floatingTipAnchor = null;

function hideFloatingTip() {
  floatingTipAnchor = null;
  floatingTipEl.classList.remove("show", "is-below", "align-start", "align-end");
  floatingTipEl.textContent = "";
  floatingTipEl.style.maxWidth = "";
}

function positionFloatingTip(anchor) {
  if (!anchor || !floatingTipEl.classList.contains("show")) return;
  const rect = anchor.getBoundingClientRect();
  // 优先钳在表格容器内，避免 tip 伸出卡片边缘
  const wrap = anchor.closest(".table-wrap");
  const bounds = wrap ? wrap.getBoundingClientRect() : null;
  const margin = 8;
  const minX = Math.max(margin, bounds ? bounds.left + margin : margin);
  const maxX = Math.min(
    window.innerWidth - margin,
    bounds ? bounds.right - margin : window.innerWidth - margin
  );
  const available = Math.max(120, maxX - minX);
  floatingTipEl.style.maxWidth = `${Math.min(320, available)}px`;

  const tipWidth = floatingTipEl.offsetWidth || Math.min(200, available);
  const tipHeight = floatingTipEl.offsetHeight || 36;
  const gap = 10;
  const centerX = rect.left + rect.width / 2;
  const half = tipWidth / 2;

  floatingTipEl.classList.remove("align-start", "align-end");
  let left = centerX;
  // 贴右/贴左时改为边缘对齐，保证整段 tip 落在表格可视区内
  if (centerX + half > maxX) {
    floatingTipEl.classList.add("align-end");
    left = Math.min(rect.right, maxX);
    if (left - tipWidth < minX) left = minX + tipWidth;
  } else if (centerX - half < minX) {
    floatingTipEl.classList.add("align-start");
    left = Math.max(rect.left, minX);
    if (left + tipWidth > maxX) left = Math.max(minX, maxX - tipWidth);
  }

  const spaceAbove = rect.top - (bounds ? bounds.top : 0);
  const placeBelow = spaceAbove < tipHeight + gap + margin;
  floatingTipEl.classList.toggle("is-below", placeBelow);
  const top = placeBelow ? rect.bottom : rect.top;
  floatingTipEl.style.left = `${Math.round(left)}px`;
  floatingTipEl.style.top = `${Math.round(top)}px`;
}

function showFloatingTip(anchor) {
  const tip = anchor?.getAttribute?.("data-tip");
  if (!tip) {
    hideFloatingTip();
    return;
  }
  floatingTipAnchor = anchor;
  floatingTipEl.textContent = tip;
  floatingTipEl.classList.add("show");
  floatingTipEl.classList.remove("is-below", "align-start", "align-end");
  positionFloatingTip(anchor);
  // 二次定位：内容写入后宽高更准
  requestAnimationFrame(() => positionFloatingTip(anchor));
}

function floatingTipTargetFrom(node) {
  if (!node || node.nodeType !== 1) return null;
  return (
    node.closest?.(
      ".tag[data-tip], [data-tip].tag, .proxy-id-btn[data-tip], [data-tip].proxy-id-btn"
    ) || null
  );
}

document.addEventListener(
  "mouseover",
  (event) => {
    const target = floatingTipTargetFrom(event.target);
    if (!target) return;
    if (target === floatingTipAnchor) return;
    showFloatingTip(target);
  },
  true
);

document.addEventListener(
  "mouseout",
  (event) => {
    if (!floatingTipAnchor) return;
    const related = event.relatedTarget;
    if (related && floatingTipAnchor.contains(related)) return;
    if (floatingTipTargetFrom(related) === floatingTipAnchor) return;
    if (event.target === floatingTipAnchor || floatingTipAnchor.contains(event.target)) {
      hideFloatingTip();
    }
  },
  true
);

document.addEventListener(
  "focusin",
  (event) => {
    const target = floatingTipTargetFrom(event.target);
    if (target) showFloatingTip(target);
  },
  true
);

document.addEventListener(
  "focusout",
  (event) => {
    if (!floatingTipAnchor) return;
    if (event.target === floatingTipAnchor) hideFloatingTip();
  },
  true
);

window.addEventListener(
  "scroll",
  () => {
    if (floatingTipAnchor) positionFloatingTip(floatingTipAnchor);
  },
  true
);

window.addEventListener("resize", () => {
  if (floatingTipAnchor) positionFloatingTip(floatingTipAnchor);
});

bindBeforeUnloadGuard();
setRemoteSourceTarget(TARGET_CPA, { force: true });
setImportMode("local");
applyDirectionLockUi();
renderTable();
updateRuntimeConfigUi();
loadRuntimeConfigStatus(false);

// 启动时检测本机工作区快照（不自动灌入，避免干扰新导入）
(async () => {
  try {
    const snapshot = await readWorkspaceSnapshot();
    if (!snapshot?.items?.length) return;
    pendingWorkspaceSnapshot = snapshot;
    // 规范化展示用副本中的 uploading → 文案统计
    const previewItems = snapshot.items.map((raw) => ({ ...raw }));
    for (const item of previewItems) {
      if (item.uploadStatus === UPLOAD_STATUS.UPLOADING) {
        item.uploadStatus = UPLOAD_STATUS.UNKNOWN;
      }
    }
    showWorkspaceRestoreBanner({
      ...snapshot,
      items: previewItems,
    });
  } catch (error) {
    console.warn("[workspace] restore probe failed", error);
  }
})();
