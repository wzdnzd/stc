function setCpaRemoteStatus(text, type = "") {
  const el = $("cpaRemoteStatus");
  if (!el) return;
  el.textContent = text || "";
  el.className = `config-status ${type}`.trim();
}

function setSub2RemoteStatus(text, type = "") {
  const el = $("sub2RemoteStatus");
  if (!el) return;
  el.textContent = text || "";
  el.className = `config-status ${type}`.trim();
}

function formatCpaRemoteRowMeta(file) {
  const parts = [];
  if (file?.provider) parts.push(file.provider);
  if (file?.account) parts.push(file.account);
  else if (file?.accountId) parts.push(file.accountId);
  if (file?.authIndex) parts.push(`index=${file.authIndex}`);
  return parts.join(" · ") || "无附加信息";
}

function formatSub2RemoteRowMeta(account) {
  const parts = [];
  if (account?.platform) parts.push(account.platform);
  if (account?.type) parts.push(account.type);
  if (account?.status != null && account.status !== "") parts.push(`状态=${account.status}`);
  // expiresAt 来自 summarizeDedupeAccount，为 unix 秒
  const exp = formatExpiryDisplay(account?.expiresAt);
  if (exp) parts.push(`过期=${exp}`);
  return parts.join(" · ") || "无附加信息";
}

function getCpaRemoteFilteredFiles() {
  const q = String(cpaRemoteSearch || "")
    .trim()
    .toLowerCase();
  let list = cpaRemoteFiles;
  if (cpaRemoteFailedOnly) {
    list = list.filter((file) => cpaRemoteResultByName.get(String(file.name || "")) === "err");
  }
  if (!q) return list.slice();
  return list.filter((file) => {
    const hay = [file.name, file.provider, file.account, file.accountId, file.authIndex]
      .map((v) => String(v || "").toLowerCase())
      .join(" ");
    return hay.includes(q);
  });
}

function getSub2RemoteFilteredAccounts() {
  const q = String(sub2RemoteSearch || "")
    .trim()
    .toLowerCase();
  let list = sub2RemoteAccounts;
  if (sub2RemoteFailedOnly) {
    list = list.filter((account) => sub2RemoteResultById.get(String(account.id ?? "")) === "err");
  }
  if (!q) return list.slice();
  return list.filter((account) => {
    const hay = [
      account.id,
      account.name,
      account.email,
      account.platform,
      account.type,
      account.status,
    ]
      .map((v) => String(v || "").toLowerCase())
      .join(" ");
    return hay.includes(q);
  });
}

function countCpaRemoteFailed() {
  let n = 0;
  for (const status of cpaRemoteResultByName.values()) if (status === "err") n += 1;
  return n;
}

function countSub2RemoteFailed() {
  let n = 0;
  for (const status of sub2RemoteResultById.values()) if (status === "err") n += 1;
  return n;
}

function updateCpaRemoteSelectionMeta() {
  const meta = $("cpaRemoteSelectionMeta");
  const btn = $("btnDownloadCpaRemoteSelected");
  const selectFailedBtn = $("btnCpaRemoteSelectFailed");
  const total = cpaRemoteFiles.length;
  const selected = cpaRemoteSelected.size;
  const filtered = getCpaRemoteFilteredFiles().length;
  const failed = countCpaRemoteFailed();
  if (meta) {
    const parts = [`已选 ${selected} 个`, `共 ${total} 个`];
    if (filtered < total) parts.push(`当前筛选 ${filtered} 个`);
    if (failed > 0) parts.push(`失败 ${failed} 个`);
    meta.textContent = parts.join("，");
  }
  if (btn) btn.disabled = selected === 0 || cpaRemoteBusy;
  if (selectFailedBtn) selectFailedBtn.disabled = failed === 0 || cpaRemoteBusy;
}

function updateSub2RemoteSelectionMeta() {
  const meta = $("sub2RemoteSelectionMeta");
  const btn = $("btnExportSub2RemoteSelected");
  const selectFailedBtn = $("btnSub2RemoteSelectFailed");
  const total = sub2RemoteAccounts.length;
  const selected = sub2RemoteSelected.size;
  const filtered = getSub2RemoteFilteredAccounts().length;
  const failed = countSub2RemoteFailed();
  if (meta) {
    const parts = [`已选 ${selected} 个`, `共 ${total} 个`];
    if (filtered < total) parts.push(`当前筛选 ${filtered} 个`);
    if (failed > 0) parts.push(`失败 ${failed} 个`);
    meta.textContent = parts.join("，");
  }
  if (btn) btn.disabled = selected === 0 || sub2RemoteBusy;
  if (selectFailedBtn) selectFailedBtn.disabled = failed === 0 || sub2RemoteBusy;
}

function cpaRemoteResultTag(name, file) {
  const result = cpaRemoteResultByName.get(name);
  if (result === "ok") return `<span class="remote-tag ok">已成功</span>`;
  if (result === "err") return `<span class="remote-tag err">失败</span>`;
  if (file?.disabled) return `<span class="remote-tag disabled">已禁用</span>`;
  return `<span class="remote-tag">${escapeHtml(file?.provider || "file")}</span>`;
}

function sub2RemoteResultTag(id, account) {
  const result = sub2RemoteResultById.get(id);
  if (result === "ok") return `<span class="remote-tag ok">已成功</span>`;
  if (result === "err") return `<span class="remote-tag err">失败</span>`;
  if (account?.normal) return `<span class="remote-tag">正常</span>`;
  return `<span class="remote-tag disabled">${escapeHtml(String(account?.status || "异常"))}</span>`;
}

function renderCpaRemoteList() {
  const host = $("cpaRemoteList");
  if (!host) return;
  const filtered = getCpaRemoteFilteredFiles();
  if (!cpaRemoteFiles.length) {
    host.innerHTML = `<div class="remote-picker-empty">服务端没有可下载的认证文件</div>`;
    updateCpaRemoteSelectionMeta();
    return;
  }
  if (!filtered.length) {
    host.innerHTML = `<div class="remote-picker-empty">${
      cpaRemoteFailedOnly ? "没有标记为失败的文件" : "没有匹配当前搜索的文件"
    }</div>`;
    updateCpaRemoteSelectionMeta();
    return;
  }
  const visible = filtered.slice(0, REMOTE_PICKER_RENDER_LIMIT);
  const rows = visible
    .map((file) => {
      const name = String(file.name || "");
      const checked = cpaRemoteSelected.has(name) ? "checked" : "";
      const result = cpaRemoteResultByName.get(name);
      const rowClass = result === "err" ? " is-err" : result === "ok" ? " is-ok" : "";
      return `<label class="remote-picker-row${rowClass}">
        <input type="checkbox" data-cpa-remote-name="${escapeHtml(name)}" ${checked} />
        <div class="remote-picker-main">
          <strong>${escapeHtml(name)}</strong>
          <div class="remote-picker-sub">${escapeHtml(formatCpaRemoteRowMeta(file))}</div>
        </div>
        ${cpaRemoteResultTag(name, file)}
      </label>`;
    })
    .join("");
  const moreNote =
    filtered.length > visible.length
      ? `<div class="remote-picker-empty">列表仅展示前 ${visible.length} 条，全选仍作用于当前筛选全部 ${filtered.length} 条，可用搜索缩小范围</div>`
      : "";
  host.innerHTML = rows + moreNote;
  updateCpaRemoteSelectionMeta();
}

function renderSub2RemoteList() {
  const host = $("sub2RemoteList");
  if (!host) return;
  const filtered = getSub2RemoteFilteredAccounts();
  if (!sub2RemoteAccounts.length) {
    host.innerHTML = `<div class="remote-picker-empty">服务端没有可导出的账号</div>`;
    updateSub2RemoteSelectionMeta();
    return;
  }
  if (!filtered.length) {
    host.innerHTML = `<div class="remote-picker-empty">${
      sub2RemoteFailedOnly ? "没有标记为失败的账号" : "没有匹配当前搜索的账号"
    }</div>`;
    updateSub2RemoteSelectionMeta();
    return;
  }
  const visible = filtered.slice(0, REMOTE_PICKER_RENDER_LIMIT);
  const rows = visible
    .map((account) => {
      const id = String(account.id ?? "");
      const checked = sub2RemoteSelected.has(id) ? "checked" : "";
      const title = account.email || account.name || `id=${id}`;
      const result = sub2RemoteResultById.get(id);
      const rowClass = result === "err" ? " is-err" : result === "ok" ? " is-ok" : "";
      return `<label class="remote-picker-row${rowClass}">
        <input type="checkbox" data-sub2-remote-id="${escapeHtml(id)}" ${checked} />
        <div class="remote-picker-main">
          <strong>${escapeHtml(String(title))}</strong>
          <div class="remote-picker-sub">id=${escapeHtml(id)}，${escapeHtml(
            formatSub2RemoteRowMeta(account)
          )}</div>
        </div>
        ${sub2RemoteResultTag(id, account)}
      </label>`;
    })
    .join("");
  const moreNote =
    filtered.length > visible.length
      ? `<div class="remote-picker-empty">列表仅展示前 ${visible.length} 条，全选仍作用于当前筛选全部 ${filtered.length} 条，可用搜索缩小范围</div>`
      : "";
  host.innerHTML = rows + moreNote;
  updateSub2RemoteSelectionMeta();
}

function cpaRemoteAbortLabel() {
  if (cpaRemoteCancelRequested) return "正在取消…";
  return cpaRemotePhase === "list" ? "取消拉取" : "取消下载";
}

function sub2RemoteAbortLabel() {
  if (sub2RemoteCancelRequested) return "正在取消…";
  return sub2RemotePhase === "list" ? "取消拉取" : "取消导出";
}

function setCpaRemoteBusy(busy, phase = "") {
  cpaRemoteBusy = Boolean(busy);
  cpaRemotePhase = cpaRemoteBusy ? phase || cpaRemotePhase || "" : "";
  const controls = [
    "btnRefreshCpaRemoteList",
    "btnCpaRemoteSelectAll",
    "btnCpaRemoteSelectNone",
    "btnCpaRemoteSelectFailed",
    "cpaRemoteSearch",
    "cpaRemoteFailedOnly",
    "btnCloseCpaRemoteDownload",
    "btnCancelCpaRemoteDownload",
  ];
  for (const id of controls) {
    const el = $(id);
    if (el) el.disabled = cpaRemoteBusy;
  }
  const downloadBtn = $("btnDownloadCpaRemoteSelected");
  if (downloadBtn) {
    downloadBtn.disabled = cpaRemoteBusy || cpaRemoteSelected.size === 0;
    if (cpaRemoteBusy && cpaRemotePhase === "download") {
      downloadBtn.innerHTML = '<span class="busy-spin"></span>下载中';
    } else if (!cpaRemoteBusy) {
      downloadBtn.textContent = "下载所选";
    }
  }
  const abortBtn = $("btnAbortCpaRemoteDownload");
  if (abortBtn) {
    const showAbort = cpaRemoteBusy && (cpaRemotePhase === "download" || cpaRemotePhase === "list");
    abortBtn.hidden = !showAbort;
    abortBtn.disabled = !showAbort || cpaRemoteCancelRequested;
    abortBtn.textContent = cpaRemoteAbortLabel();
  }
  const topBtn = $("btnCpaRemoteDownload");
  if (topBtn) {
    if (cpaRemoteBusy) {
      topBtn.innerHTML =
        cpaRemotePhase === "download"
          ? '<span class="busy-spin"></span>正在下载认证文件'
          : '<span class="busy-spin"></span>正在拉取列表';
    }
  }
  refreshRemoteActionButtons();
  updateCpaRemoteSelectionMeta();
}

function setSub2RemoteBusy(busy, phase = "") {
  sub2RemoteBusy = Boolean(busy);
  sub2RemotePhase = sub2RemoteBusy ? phase || sub2RemotePhase || "" : "";
  const controls = [
    "btnRefreshSub2RemoteList",
    "btnSub2RemoteSelectAll",
    "btnSub2RemoteSelectNone",
    "btnSub2RemoteSelectFailed",
    "sub2RemoteSearch",
    "sub2RemoteFailedOnly",
    "btnCloseSub2RemoteExport",
    "btnCancelSub2RemoteExport",
  ];
  for (const id of controls) {
    const el = $(id);
    if (el) el.disabled = sub2RemoteBusy;
  }
  const exportBtn = $("btnExportSub2RemoteSelected");
  if (exportBtn) {
    exportBtn.disabled = sub2RemoteBusy || sub2RemoteSelected.size === 0;
    if (sub2RemoteBusy && sub2RemotePhase === "export") {
      exportBtn.innerHTML = '<span class="busy-spin"></span>导出中';
    } else if (!sub2RemoteBusy) {
      exportBtn.textContent = "导出所选";
    }
  }
  const abortBtn = $("btnAbortSub2RemoteExport");
  if (abortBtn) {
    const showAbort =
      sub2RemoteBusy && (sub2RemotePhase === "export" || sub2RemotePhase === "list");
    abortBtn.hidden = !showAbort;
    abortBtn.disabled = !showAbort || sub2RemoteCancelRequested;
    abortBtn.textContent = sub2RemoteAbortLabel();
  }
  const topBtn = $("btnSub2RemoteExport");
  if (topBtn) {
    if (sub2RemoteBusy) {
      topBtn.innerHTML =
        sub2RemotePhase === "export"
          ? '<span class="busy-spin"></span>正在导出账号'
          : '<span class="busy-spin"></span>正在拉取列表';
    }
  }
  refreshRemoteActionButtons();
  updateSub2RemoteSelectionMeta();
}

function createRemoteCancelledError(message) {
  const error = new Error(message || "用户已取消操作");
  error.name = "RemoteCancelledError";
  return error;
}

function throwIfCpaRemoteCancelled() {
  if (cpaRemoteCancelRequested || cpaRemoteAbortController?.signal?.aborted) {
    throw createRemoteCancelledError(
      cpaRemotePhase === "list" ? "用户已取消拉取列表" : "用户已取消下载"
    );
  }
}

function throwIfSub2RemoteCancelled() {
  if (sub2RemoteCancelRequested || sub2RemoteAbortController?.signal?.aborted) {
    throw createRemoteCancelledError(
      sub2RemotePhase === "list" ? "用户已取消拉取列表" : "用户已取消导出"
    );
  }
}

function cancelCpaRemoteTask() {
  if (!cpaRemoteBusy || cpaRemoteCancelRequested) return;
  cpaRemoteCancelRequested = true;
  const abortBtn = $("btnAbortCpaRemoteDownload");
  if (abortBtn) {
    abortBtn.disabled = true;
    abortBtn.textContent = "正在取消…";
  }
  const tip =
    cpaRemotePhase === "list" ? "正在取消拉取列表" : "正在取消，当前请求结束后停止后续批次";
  setCpaRemoteStatus(tip, "info");
  showMsg(cpaRemotePhase === "list" ? "正在取消 CPA 列表拉取" : "正在取消 CPA 下载", "info");
  cpaRemoteAbortController?.abort(new DOMException("cpa remote cancelled", "AbortError"));
}

function cancelSub2RemoteTask() {
  if (!sub2RemoteBusy || sub2RemoteCancelRequested) return;
  sub2RemoteCancelRequested = true;
  const abortBtn = $("btnAbortSub2RemoteExport");
  if (abortBtn) {
    abortBtn.disabled = true;
    abortBtn.textContent = "正在取消…";
  }
  const tip =
    sub2RemotePhase === "list" ? "正在取消拉取列表" : "正在取消，当前请求结束后停止后续批次";
  setSub2RemoteStatus(tip, "info");
  showMsg(
    sub2RemotePhase === "list" ? "正在取消 SUB2API 列表拉取" : "正在取消 SUB2API 导出",
    "info"
  );
  sub2RemoteAbortController?.abort(new DOMException("sub2 remote cancelled", "AbortError"));
}

function resetCpaRemoteModalView() {
  cpaRemoteFiles = [];
  cpaRemoteSelected = new Set();
  cpaRemoteResultByName = new Map();
  cpaRemoteSearch = "";
  cpaRemoteFailedOnly = false;
  const search = $("cpaRemoteSearch");
  if (search) search.value = "";
  const failedOnly = $("cpaRemoteFailedOnly");
  if (failedOnly) failedOnly.checked = false;
  const list = $("cpaRemoteList");
  if (list) list.innerHTML = `<div class="remote-picker-empty">尚未加载列表</div>`;
  $("cpaRemoteDownloadHint").textContent = "先拉取服务端认证文件列表，勾选后打包为 ZIP 下载";
  setCpaRemoteStatus("");
  updateCpaRemoteSelectionMeta();
}

function resetSub2RemoteModalView() {
  sub2RemoteAccounts = [];
  sub2RemoteSelected = new Set();
  sub2RemoteResultById = new Map();
  sub2RemoteSearch = "";
  sub2RemoteFailedOnly = false;
  const search = $("sub2RemoteSearch");
  if (search) search.value = "";
  const failedOnly = $("sub2RemoteFailedOnly");
  if (failedOnly) failedOnly.checked = false;
  const list = $("sub2RemoteList");
  if (list) list.innerHTML = `<div class="remote-picker-empty">尚未加载列表</div>`;
  $("sub2RemoteExportHint").textContent = "勾选服务端账号后导出";
  setSub2RemoteStatus("");
  updateSub2RemoteSelectionMeta();
}

function openCpaRemoteDownloadModal() {
  if (!hasCpaConfigReady()) {
    openConfigDialog({
      target: TARGET_CPA,
      reason: "从 CPA 下载需要有效配置",
      mode: "ensure",
    });
    showMsg("请先配置 CPA 后再下载", "err");
    return;
  }
  resetCpaRemoteModalView();
  $("cpaRemoteDownloadModal")?.classList.add("show");
  loadCpaRemoteAuthList().catch((error) => {
    setCpaRemoteStatus(`加载失败：${apiErrorMessage(error)}`, "err");
  });
}

function closeCpaRemoteDownloadModal() {
  if (cpaRemoteBusy) return;
  $("cpaRemoteDownloadModal")?.classList.remove("show");
  resetCpaRemoteModalView();
}

function openSub2RemoteExportModal() {
  if (!hasSub2apiConfigReady()) {
    openConfigDialog({
      target: TARGET_SUB2API,
      reason: "从 SUB2API 导出需要有效配置",
      mode: "ensure",
    });
    showMsg("请先配置 SUB2API 后再导出", "err");
    return;
  }
  resetSub2RemoteModalView();
  $("sub2RemoteExportModal")?.classList.add("show");
  loadSub2RemoteAccountList().catch((error) => {
    setSub2RemoteStatus(`加载失败：${apiErrorMessage(error)}`, "err");
  });
}

function closeSub2RemoteExportModal() {
  if (sub2RemoteBusy) return;
  $("sub2RemoteExportModal")?.classList.remove("show");
  resetSub2RemoteModalView();
}

function selectAllCpaRemoteVisible() {
  // 全选作用于当前筛选全部，不限于列表渲染上限
  for (const file of getCpaRemoteFilteredFiles()) {
    if (file?.name) cpaRemoteSelected.add(String(file.name));
  }
  renderCpaRemoteList();
}

function clearCpaRemoteSelection() {
  cpaRemoteSelected = new Set();
  renderCpaRemoteList();
}

function selectCpaRemoteFailed() {
  cpaRemoteSelected = new Set();
  for (const [name, status] of cpaRemoteResultByName.entries()) {
    if (status === "err" && name) cpaRemoteSelected.add(name);
  }
  renderCpaRemoteList();
  const failed = cpaRemoteSelected.size;
  if (failed > 0) {
    setCpaRemoteStatus(`已勾选 ${failed} 个失败文件，可再次下载补全`, "info");
  } else {
    setCpaRemoteStatus("当前没有标记为失败的文件", "info");
  }
}

function selectAllSub2RemoteVisible() {
  for (const account of getSub2RemoteFilteredAccounts()) {
    if (account?.id != null && account.id !== "") {
      sub2RemoteSelected.add(String(account.id));
    }
  }
  renderSub2RemoteList();
}

function clearSub2RemoteSelection() {
  sub2RemoteSelected = new Set();
  renderSub2RemoteList();
}

function selectSub2RemoteFailed() {
  sub2RemoteSelected = new Set();
  for (const [id, status] of sub2RemoteResultById.entries()) {
    if (status === "err" && id) sub2RemoteSelected.add(id);
  }
  renderSub2RemoteList();
  const failed = sub2RemoteSelected.size;
  if (failed > 0) {
    setSub2RemoteStatus(`已勾选 ${failed} 个失败账号，可再次导出补全`, "info");
  } else {
    setSub2RemoteStatus("当前没有标记为失败的账号", "info");
  }
}

function focusCpaRemoteFailedAfterRun() {
  const failedNames = [];
  for (const [name, status] of cpaRemoteResultByName.entries()) {
    if (status === "err" && name) failedNames.push(name);
  }
  if (!failedNames.length) return;
  cpaRemoteSelected = new Set(failedNames);
  cpaRemoteFailedOnly = true;
  const failedOnly = $("cpaRemoteFailedOnly");
  if (failedOnly) failedOnly.checked = true;
  renderCpaRemoteList();
}

function focusSub2RemoteFailedAfterRun() {
  const failedIds = [];
  for (const [id, status] of sub2RemoteResultById.entries()) {
    if (status === "err" && id) failedIds.push(id);
  }
  if (!failedIds.length) return;
  sub2RemoteSelected = new Set(failedIds);
  sub2RemoteFailedOnly = true;
  const failedOnly = $("sub2RemoteFailedOnly");
  if (failedOnly) failedOnly.checked = true;
  renderSub2RemoteList();
}

function applyCpaRemoteChunkResults(chunk, files) {
  const seen = new Set();
  if (Array.isArray(files) && files.length) {
    for (const item of files) {
      const name = String(item?.name || "");
      if (!name) continue;
      seen.add(name);
      if (item?.ok && item.content != null) {
        cpaRemoteResultByName.set(name, "ok");
      } else {
        cpaRemoteResultByName.set(name, "err");
      }
    }
  }
  for (const name of chunk) {
    const key = String(name || "");
    if (!key || seen.has(key)) continue;
    cpaRemoteResultByName.set(key, "err");
  }
}

function applySub2RemoteChunkResults(chunk, successIds, failures, opts = {}) {
  const okIds = new Set();
  if (Array.isArray(successIds)) {
    for (const raw of successIds) {
      if (raw == null || raw === "") continue;
      const id = String(raw);
      okIds.add(id);
      sub2RemoteResultById.set(id, "ok");
    }
  }
  const failedIds = new Set();
  if (Array.isArray(failures)) {
    for (const item of failures) {
      if (item?.id == null || item.id === "") continue;
      const id = String(item.id);
      // 同一 id 若已在 successIds，以成功为准
      if (okIds.has(id)) continue;
      failedIds.add(id);
      sub2RemoteResultById.set(id, "err");
    }
  }
  const okCount = Number(opts.okCount) || 0;
  const failedCount = Number(opts.failedCount);
  const hasFailedCount = Number.isFinite(failedCount);
  // 本批导出账号数已覆盖 chunk，且无失败计数：整批成功
  // 兼容官方包去掉/改写 id 导致 successIds 对不上的情况
  if (chunk.length > 0 && okCount >= chunk.length && (!hasFailedCount || failedCount === 0)) {
    for (const raw of chunk) {
      const id = String(raw ?? "");
      if (id) sub2RemoteResultById.set(id, "ok");
    }
    return;
  }
  // 旧接口无 successIds 且本批全部成功时，整批记为成功
  if (!okIds.size && !failedIds.size && (!hasFailedCount || failedCount === 0) && okCount > 0) {
    for (const raw of chunk) {
      const id = String(raw ?? "");
      if (id) sub2RemoteResultById.set(id, "ok");
    }
    return;
  }
  for (const raw of chunk) {
    const id = String(raw ?? "");
    if (!id) continue;
    if (okIds.has(id) || failedIds.has(id)) continue;
    // 已有成功账号数覆盖本批、且未声明失败时，剩余也视为成功
    if (okCount >= chunk.length && (!hasFailedCount || failedCount === 0)) {
      sub2RemoteResultById.set(id, "ok");
      continue;
    }
    // 本批无明细时按失败处理
    sub2RemoteResultById.set(id, "err");
  }
}

async function loadCpaRemoteAuthList() {
  if (cpaRemoteBusy) return;
  if (uploadBusy || remoteImportBusy) {
    setCpaRemoteStatus(
      remoteImportBusy ? "远端导入进行中，请稍后再拉取列表" : "上传进行中，请稍后再拉取列表",
      "err"
    );
    return;
  }
  const effective = getEffectiveClientConfig(TARGET_CPA);
  if (!effective) {
    setCpaRemoteStatus("请先配置 CPA", "err");
    return;
  }
  cpaRemoteCancelRequested = false;
  cpaRemoteAbortController = new AbortController();
  setCpaRemoteBusy(true, "list");
  setCpaRemoteStatus("正在拉取 CPA 认证文件列表", "info");
  showMsg("正在拉取 CPA 认证文件列表", "info");
  try {
    const body = {};
    const config = uploadConfigPayload(effective);
    if (config) body.config = config;
    const { data } = await fetchJson(
      "/api/cpa/auth-files/list",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: cpaRemoteAbortController.signal,
      },
      2 * 60 * 1000
    );
    throwIfCpaRemoteCancelled();
    cpaRemoteFiles = Array.isArray(data?.files) ? data.files : [];
    cpaRemoteSelected = new Set(cpaRemoteFiles.map((f) => String(f.name)).filter(Boolean));
    cpaRemoteResultByName = new Map();
    cpaRemoteFailedOnly = false;
    const failedOnly = $("cpaRemoteFailedOnly");
    if (failedOnly) failedOnly.checked = false;
    renderCpaRemoteList();
    const count = cpaRemoteFiles.length;
    if (count > 0) {
      $("cpaRemoteDownloadHint").textContent =
        `共 ${count} 个认证文件，可搜索后全选或勾选子集再打包下载`;
      setCpaRemoteStatus(`列表加载完成，共 ${count} 个文件，已默认全选`, "ok");
      showMsg(`CPA 认证文件列表已加载，共 ${count} 个`, "ok");
    } else {
      $("cpaRemoteDownloadHint").textContent = "服务端当前没有可下载的认证文件";
      setCpaRemoteStatus("列表为空", "info");
      showMsg("CPA 服务端没有可下载的认证文件", "info");
    }
  } catch (error) {
    if (error?.name === "RemoteCancelledError" || cpaRemoteCancelRequested) {
      setCpaRemoteStatus("已取消拉取列表", "info");
      showMsg("已取消拉取 CPA 认证文件列表", "info");
    } else {
      cpaRemoteFiles = [];
      cpaRemoteSelected = new Set();
      cpaRemoteResultByName = new Map();
      cpaRemoteFailedOnly = false;
      const failedOnly = $("cpaRemoteFailedOnly");
      if (failedOnly) failedOnly.checked = false;
      renderCpaRemoteList();
      setCpaRemoteStatus(`加载失败：${apiErrorMessage(error)}`, "err");
      showMsg(`拉取 CPA 认证文件列表失败：${apiErrorMessage(error)}`, "err");
    }
  } finally {
    cpaRemoteAbortController = null;
    cpaRemoteCancelRequested = false;
    setCpaRemoteBusy(false);
  }
}

async function downloadSelectedCpaRemoteAuth() {
  if (cpaRemoteBusy) return;
  if (uploadBusy || remoteImportBusy) {
    setCpaRemoteStatus(
      remoteImportBusy ? "远端导入进行中，请稍后再下载" : "上传进行中，请稍后再下载",
      "err"
    );
    return;
  }
  const names = [...cpaRemoteSelected];
  if (!names.length) {
    setCpaRemoteStatus("请先勾选要下载的文件", "err");
    return;
  }
  const effective = getEffectiveClientConfig(TARGET_CPA);
  if (!effective) {
    setCpaRemoteStatus("请先配置 CPA", "err");
    return;
  }
  const maxPerRequest = currentMaxCpaAuthDownload();
  const chunkSize = Math.max(1, Math.min(REMOTE_CPA_DOWNLOAD_CHUNK_DEFAULT, maxPerRequest));
  const chunks = chunkArray(names, chunkSize);
  // 本次下载会覆盖所选文件的成功/失败标记
  for (const name of names) cpaRemoteResultByName.delete(String(name || ""));
  cpaRemoteCancelRequested = false;
  cpaRemoteAbortController = new AbortController();
  setCpaRemoteBusy(true, "download");
  setCpaRemoteStatus(`正在下载 ${names.length} 个认证文件，分 ${chunks.length} 批`, "info");
  showMsg(`正在从 CPA 下载 ${names.length} 个认证文件`, "info");
  try {
    const config = uploadConfigPayload(effective);
    const okFiles = [];
    let cancelled = false;
    for (let i = 0; i < chunks.length; i++) {
      throwIfCpaRemoteCancelled();
      const chunk = chunks[i];
      setCpaRemoteStatus(
        `正在下载第 ${i + 1}/${chunks.length} 批，本批 ${chunk.length} 个，累计成功 ${okFiles.length} 个`,
        "info"
      );
      const body = { names: chunk };
      if (config) body.config = config;
      try {
        const { data } = await fetchJson(
          "/api/cpa/auth-files/download",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: cpaRemoteAbortController.signal,
          },
          10 * 60 * 1000
        );
        throwIfCpaRemoteCancelled();
        const files = Array.isArray(data?.files) ? data.files : [];
        applyCpaRemoteChunkResults(chunk, files);
        for (const item of files) {
          if (item?.ok && item.content != null) okFiles.push(item);
        }
      } catch (chunkError) {
        if (
          chunkError?.name === "RemoteCancelledError" ||
          chunkError?.name === "AbortError" ||
          cpaRemoteCancelRequested
        ) {
          cancelled = true;
          break;
        }
        const files = Array.isArray(chunkError?.data?.files) ? chunkError.data.files : [];
        applyCpaRemoteChunkResults(chunk, files);
        for (const item of files) {
          if (item?.ok && item.content != null) okFiles.push(item);
        }
      }
      await yieldToBrowser();
    }
    if (cancelled || cpaRemoteCancelRequested) {
      if (okFiles.length) {
        const enc = new TextEncoder();
        const used = new Map();
        const zipFiles = okFiles.map((item, index) => {
          let name = sanitizeRemoteCpaFilename(item.name, index);
          if (used.has(name)) {
            const n = used.get(name) + 1;
            used.set(name, n);
            name = name.replace(/\.json$/i, `-${n}.json`);
          } else {
            used.set(name, 1);
          }
          const text =
            typeof item.content === "string" ? item.content : JSON.stringify(item.content, null, 2);
          return { name, data: enc.encode(text) };
        });
        const zipBytes = buildZip(zipFiles);
        downloadBlob(
          new Blob([zipBytes], { type: "application/zip" }),
          `cpa-auth-remote-partial-${tsStamp()}.zip`
        );
        renderCpaRemoteList();
        const msg = `已取消下载，已打包此前成功的 ${okFiles.length} 个文件`;
        setCpaRemoteStatus(msg, "info");
        showMsg(msg, "info");
        showToast(msg, "info", 4200);
      } else {
        renderCpaRemoteList();
        setCpaRemoteStatus("已取消下载", "info");
        showMsg("已取消从 CPA 下载", "info");
      }
      return;
    }
    let failedCount = 0;
    for (const name of names) {
      if (cpaRemoteResultByName.get(String(name || "")) === "err") failedCount += 1;
    }
    if (!okFiles.length) {
      focusCpaRemoteFailedAfterRun();
      setCpaRemoteStatus(
        failedCount
          ? `下载失败，全部 ${failedCount} 个文件未成功，已勾选失败项可二次下载`
          : "下载失败，没有可用文件",
        "err"
      );
      showMsg("从 CPA 下载认证文件失败", "err");
      return;
    }
    const enc = new TextEncoder();
    const used = new Map();
    const zipFiles = okFiles.map((item, index) => {
      let name = sanitizeRemoteCpaFilename(item.name, index);
      if (used.has(name)) {
        const n = used.get(name) + 1;
        used.set(name, n);
        name = name.replace(/\.json$/i, `-${n}.json`);
      } else {
        used.set(name, 1);
      }
      const text =
        typeof item.content === "string" ? item.content : JSON.stringify(item.content, null, 2);
      return { name, data: enc.encode(text) };
    });
    const zipBytes = buildZip(zipFiles);
    downloadBlob(
      new Blob([zipBytes], { type: "application/zip" }),
      `cpa-auth-remote-${tsStamp()}.zip`
    );
    if (failedCount > 0) focusCpaRemoteFailedAfterRun();
    else renderCpaRemoteList();
    const msg =
      failedCount > 0
        ? `下载完成，成功：${okFiles.length}，失败：${failedCount}，已勾选失败项可二次下载`
        : `已打包下载 ${okFiles.length} 个认证文件`;
    setCpaRemoteStatus(msg, failedCount ? "err" : "ok");
    showMsg(msg, failedCount ? "err" : "ok");
    showToast(msg, failedCount ? "err" : "ok", 4200);
  } catch (error) {
    if (error?.name === "RemoteCancelledError" || cpaRemoteCancelRequested) {
      setCpaRemoteStatus("已取消下载", "info");
      showMsg("已取消从 CPA 下载", "info");
      renderCpaRemoteList();
    } else {
      setCpaRemoteStatus(`下载失败：${apiErrorMessage(error)}`, "err");
      showMsg(`从 CPA 下载失败：${apiErrorMessage(error)}`, "err");
      renderCpaRemoteList();
    }
  } finally {
    cpaRemoteAbortController = null;
    cpaRemoteCancelRequested = false;
    setCpaRemoteBusy(false);
  }
}

function sanitizeRemoteCpaFilename(name, index = 0) {
  let base = String(name || `account-${index + 1}.json`)
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
  if (!base.toLowerCase().endsWith(".json")) base += ".json";
  if (base.length > 180) base = `${base.slice(0, 175)}.json`;
  return base || `account-${index + 1}.json`;
}

async function loadSub2RemoteAccountList() {
  if (sub2RemoteBusy) return;
  if (uploadBusy || remoteImportBusy) {
    setSub2RemoteStatus(
      remoteImportBusy ? "远端导入进行中，请稍后再拉取列表" : "上传进行中，请稍后再拉取列表",
      "err"
    );
    return;
  }
  const effective = getEffectiveClientConfig(TARGET_SUB2API);
  if (!effective) {
    setSub2RemoteStatus("请先配置 SUB2API", "err");
    return;
  }
  sub2RemoteCancelRequested = false;
  sub2RemoteAbortController = new AbortController();
  setSub2RemoteBusy(true, "list");
  setSub2RemoteStatus("正在拉取 SUB2API 账号列表", "info");
  showMsg("正在拉取 SUB2API 账号列表", "info");
  try {
    const body = {};
    const config = uploadConfigPayload(effective);
    if (config) body.config = config;
    const { data } = await fetchJson(
      "/api/sub2api/accounts/list",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: sub2RemoteAbortController.signal,
      },
      10 * 60 * 1000
    );
    throwIfSub2RemoteCancelled();
    sub2RemoteAccounts = Array.isArray(data?.accounts) ? data.accounts : [];
    sub2RemoteSelected = new Set(
      sub2RemoteAccounts
        .map((account) => (account?.id == null ? "" : String(account.id)))
        .filter(Boolean)
    );
    sub2RemoteResultById = new Map();
    sub2RemoteFailedOnly = false;
    const failedOnly = $("sub2RemoteFailedOnly");
    if (failedOnly) failedOnly.checked = false;
    renderSub2RemoteList();
    const count = sub2RemoteAccounts.length;
    if (count > 0) {
      $("sub2RemoteExportHint").textContent = `共 ${count} 个账号，可搜索后全选或勾选子集`;
      setSub2RemoteStatus(`列表加载完成，共 ${count} 个账号，已默认全选`, "ok");
      showMsg(`SUB2API 账号列表已加载，共 ${count} 个`, "ok");
    } else {
      $("sub2RemoteExportHint").textContent = "服务端当前没有可导出的账号";
      setSub2RemoteStatus("列表为空", "info");
      showMsg("SUB2API 服务端没有可导出的账号", "info");
    }
  } catch (error) {
    if (error?.name === "RemoteCancelledError" || sub2RemoteCancelRequested) {
      setSub2RemoteStatus("已取消拉取列表", "info");
      showMsg("已取消拉取 SUB2API 账号列表", "info");
    } else {
      sub2RemoteAccounts = [];
      sub2RemoteSelected = new Set();
      sub2RemoteResultById = new Map();
      sub2RemoteFailedOnly = false;
      const failedOnly = $("sub2RemoteFailedOnly");
      if (failedOnly) failedOnly.checked = false;
      renderSub2RemoteList();
      setSub2RemoteStatus(`加载失败：${apiErrorMessage(error)}`, "err");
      showMsg(`拉取 SUB2API 账号列表失败：${apiErrorMessage(error)}`, "err");
    }
  } finally {
    sub2RemoteAbortController = null;
    sub2RemoteCancelRequested = false;
    setSub2RemoteBusy(false);
  }
}

async function exportSelectedSub2RemoteAccounts() {
  if (sub2RemoteBusy) return;
  if (uploadBusy || remoteImportBusy) {
    setSub2RemoteStatus(
      remoteImportBusy ? "远端导入进行中，请稍后再导出" : "上传进行中，请稍后再导出",
      "err"
    );
    return;
  }
  const ids = [...sub2RemoteSelected];
  if (!ids.length) {
    setSub2RemoteStatus("请先勾选要导出的账号", "err");
    return;
  }
  const effective = getEffectiveClientConfig(TARGET_SUB2API);
  if (!effective) {
    setSub2RemoteStatus("请先配置 SUB2API", "err");
    return;
  }
  // 前端分批请求，避免单次拉全量详情导致 Worker 超时 / 浏览器卡死
  const maxPerRequest = currentMaxSub2apiExport();
  const chunkSize = Math.max(1, Math.min(REMOTE_EXPORT_CHUNK_DEFAULT, maxPerRequest));
  const chunks = chunkArray(ids, chunkSize);
  for (const id of ids) sub2RemoteResultById.delete(String(id ?? ""));
  sub2RemoteCancelRequested = false;
  sub2RemoteAbortController = new AbortController();
  setSub2RemoteBusy(true, "export");
  setSub2RemoteStatus(`正在导出 ${ids.length} 个账号，分 ${chunks.length} 批`, "info");
  showMsg(`正在从 SUB2API 导出 ${ids.length} 个账号`, "info");
  try {
    const config = uploadConfigPayload(effective);
    const accounts = [];
    let exportedAt = "";
    let hardError = null;
    let cancelled = false;
    for (let i = 0; i < chunks.length; i++) {
      throwIfSub2RemoteCancelled();
      const chunk = chunks[i];
      setSub2RemoteStatus(
        `正在导出第 ${i + 1}/${chunks.length} 批，本批 ${chunk.length} 个，累计成功 ${accounts.length} 个`,
        "info"
      );
      const body = { ids: chunk };
      if (config) body.config = config;
      try {
        // 与官方后台导出一致：Worker 转发 GET /api/v1/admin/accounts/data?ids=&timezone=
        body.timezone =
          (typeof Intl !== "undefined" && Intl.DateTimeFormat?.().resolvedOptions?.().timeZone) ||
          "UTC";
        const { data } = await fetchJson(
          "/api/sub2api/accounts/export",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: sub2RemoteAbortController.signal,
          },
          10 * 60 * 1000
        );
        throwIfSub2RemoteCancelled();
        const pack = data?.pack;
        if (pack?.exported_at && !exportedAt) exportedAt = pack.exported_at;
        const packAccounts = Array.isArray(pack?.accounts) ? pack.accounts : [];
        if (packAccounts.length) accounts.push(...packAccounts);
        // successIds 优先；若官方包 id 对不上，用本批导出数量兜底，避免「成功 N / 失败 N」
        const chunkSuccessIds = Array.isArray(data?.successIds) ? data.successIds : undefined;
        const resolvedSuccessIds =
          Array.isArray(chunkSuccessIds) && chunkSuccessIds.length
            ? chunkSuccessIds
            : packAccounts.length >= chunk.length && Number(data?.failedCount || 0) === 0
              ? chunk
              : chunkSuccessIds;
        applySub2RemoteChunkResults(chunk, resolvedSuccessIds, data?.failures, {
          failedCount: data?.failedCount,
          okCount: packAccounts.length || data?.count || 0,
        });
      } catch (chunkError) {
        if (
          chunkError?.name === "RemoteCancelledError" ||
          chunkError?.name === "AbortError" ||
          sub2RemoteCancelRequested
        ) {
          cancelled = true;
          break;
        }
        // totp + step_up 同时开启时 Admin API Key 无法导出：整次任务终止，避免把全部账号标成无凭证
        if (
          chunkError?.code === "SUB2API_STEP_UP_REQUIRED" ||
          chunkError?.data?.code === "SUB2API_STEP_UP_REQUIRED" ||
          chunkError?.code === "SUB2API_TOTP_ENABLED" ||
          chunkError?.data?.code === "SUB2API_TOTP_ENABLED" ||
          /totp|step[_ -]?up|two-factor|二次验证/i.test(String(chunkError?.message || ""))
        ) {
          hardError = chunkError;
          break;
        }
        // 单批全失败时 Worker 返回 502；分批场景下累计失败后继续下一批
        const partialAccounts = Array.isArray(chunkError?.data?.pack?.accounts)
          ? chunkError.data.pack.accounts
          : [];
        if (partialAccounts.length) accounts.push(...partialAccounts);
        applySub2RemoteChunkResults(
          chunk,
          chunkError?.data?.successIds,
          chunkError?.data?.failures,
          {
            failedCount: chunkError?.data?.failedCount ?? chunk.length,
            okCount: partialAccounts.length,
          }
        );
        const softIncomplete =
          chunkError?.data?.code === "INCOMPLETE_ACCOUNT_DATA" || chunkError?.status === 502;
        if (!hardError && !softIncomplete) hardError = chunkError;
      }
      await yieldToBrowser();
    }
    if (cancelled || sub2RemoteCancelRequested) {
      if (accounts.length) {
        const exportPack = {
          exported_at: exportedAt || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          proxies: [],
          accounts,
        };
        downloadJson(exportPack, `sub2api-account-partial-${tsStamp()}.json`);
        renderSub2RemoteList();
        const msg = `已取消导出，已保存此前成功的 ${accounts.length} 个账号`;
        setSub2RemoteStatus(msg, "info");
        showMsg(msg, "info");
        showToast(msg, "info", 4200);
      } else {
        renderSub2RemoteList();
        setSub2RemoteStatus("已取消导出", "info");
        showMsg("已取消从 SUB2API 导出", "info");
      }
      return;
    }
    let failedCount = 0;
    let markedOkCount = 0;
    for (const id of ids) {
      const status = sub2RemoteResultById.get(String(id ?? ""));
      if (status === "err") failedCount += 1;
      else if (status === "ok") markedOkCount += 1;
    }
    // 已拿到可导出账号，但结果图因 id 对不上全标失败时，按实际导出数纠正
    if (accounts.length > 0 && failedCount >= ids.length && markedOkCount === 0) {
      for (const id of ids) sub2RemoteResultById.set(String(id ?? ""), "ok");
      failedCount = 0;
      markedOkCount = ids.length;
    } else if (
      accounts.length >= ids.length &&
      failedCount > 0 &&
      markedOkCount + failedCount === ids.length &&
      markedOkCount < accounts.length
    ) {
      // 导出数覆盖全选，残留失败多半是 id 匹配问题
      for (const id of ids) {
        if (sub2RemoteResultById.get(String(id ?? "")) === "err") {
          sub2RemoteResultById.set(String(id ?? ""), "ok");
        }
      }
      failedCount = 0;
      markedOkCount = ids.length;
    }
    if (!accounts.length) {
      const detail = hardError ? apiErrorMessage(hardError) : "";
      const stepUpBlocked =
        hardError?.code === "SUB2API_STEP_UP_REQUIRED" ||
        hardError?.data?.code === "SUB2API_STEP_UP_REQUIRED" ||
        hardError?.code === "SUB2API_TOTP_ENABLED" ||
        hardError?.data?.code === "SUB2API_TOTP_ENABLED" ||
        /totp|step[_ -]?up|two-factor|二次验证/i.test(detail);
      if (stepUpBlocked) {
        // 不把全部账号标失败，避免「无完整凭证」误导
        renderSub2RemoteList();
        const msg = detail || "目标已同时开启 totp_enabled 与 step_up_enabled，无法用 API Key 导出";
        setSub2RemoteStatus(`导出失败：${msg}`, "err");
        showMsg(`从 SUB2API 导出失败：${msg}`, "err");
        showToast(msg, "err", 5200);
        return;
      }
      focusSub2RemoteFailedAfterRun();
      setSub2RemoteStatus(
        failedCount
          ? `导出失败，全部 ${failedCount} 个账号无完整凭证${detail ? `，${detail}` : ""}，已勾选失败项可再次导出`
          : detail
            ? `导出失败：${detail}`
            : "导出失败，没有可用账号数据",
        "err"
      );
      showMsg("从 SUB2API 导出失败，没有可用账号数据", "err");
      return;
    }
    // 与样例 sub2api-account.json 对齐：exported_at + proxies + accounts
    const exportPack = {
      exported_at: exportedAt || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      proxies: [],
      accounts,
    };
    downloadJson(exportPack, `sub2api-account-${tsStamp()}.json`);
    if (failedCount > 0) focusSub2RemoteFailedAfterRun();
    else renderSub2RemoteList();
    const msg =
      failedCount > 0
        ? `导出完成，成功：${accounts.length}，失败：${failedCount}，已勾选失败项可二次导出`
        : `已导出 ${accounts.length} 个账号`;
    setSub2RemoteStatus(msg, failedCount ? "err" : "ok");
    showMsg(msg, failedCount ? "err" : "ok");
    showToast(msg, failedCount ? "err" : "ok", 4200);
  } catch (error) {
    if (error?.name === "RemoteCancelledError" || sub2RemoteCancelRequested) {
      setSub2RemoteStatus("已取消导出", "info");
      showMsg("已取消从 SUB2API 导出", "info");
      renderSub2RemoteList();
    } else {
      setSub2RemoteStatus(`导出失败：${apiErrorMessage(error)}`, "err");
      showMsg(`从 SUB2API 导出失败：${apiErrorMessage(error)}`, "err");
      renderSub2RemoteList();
    }
  } finally {
    sub2RemoteAbortController = null;
    sub2RemoteCancelRequested = false;
    setSub2RemoteBusy(false);
  }
}

async function refreshSub2apiProxyCache() {
  if (uploadBusy) {
    showMsg("上传进行中，请稍后再刷新代理缓存", "err");
    return;
  }
  const effective = getEffectiveClientConfig(TARGET_SUB2API);
  if (!effective) {
    openConfigDialog({
      target: TARGET_SUB2API,
      reason: "刷新代理缓存需要有效配置",
      mode: "ensure",
    });
    showMsg("请先配置 SUB2API 后再刷新代理缓存", "err");
    return;
  }
  const btn = $("btnRefreshProxyCache");
  if (btn) btn.disabled = true;
  try {
    showMsg("正在强制刷新代理缓存…", "info");
    const ids = await fetchSub2apiProxyIds(uploadConfigPayload(effective), {
      forceRefresh: true,
    });
    // 刷新后按新列表重算当前账号合法性
    if (items.length) {
      markProxyValidity(items, cachedSub2ProxyIdSet);
      renderTable();
    }
    showMsg(`代理缓存已刷新，共 ${ids.length} 个可用代理 ID`, "ok");
    showToast(`代理缓存已刷新，共 ${ids.length} 个`, "ok");
  } catch (error) {
    showMsg(`刷新代理缓存失败：${apiErrorMessage(error)}`, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}
