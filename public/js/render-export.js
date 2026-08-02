function updateStats() {
  const files = new Set(items.map((i) => i.sourceFile));
  $("statFiles").textContent = String(files.size);
  $("statAccounts").textContent = String(items.length);
  $("statCpa").textContent = String(items.filter((i) => i.sourceFormat === "cpa").length);
  $("statSub2").textContent = String(items.filter((i) => i.sourceFormat === "sub2api").length);
  $("statErr").textContent = String(items.filter((i) => i.error).length);
}

function setItemExportState(item, status, target = "", message = "") {
  if (!item) return;
  item.exportStatus = status || EXPORT_STATUS.NONE;
  item.exportTarget = target || "";
  item.exportMessage = message || "";
  scheduleWorkspaceSave();
}

function statusDetailTip(primary, secondary = "") {
  const parts = [primary, secondary].map((s) => String(s || "").trim()).filter(Boolean);
  return parts.join(" · ");
}

function exportStatusHtml(item) {
  const tip = statusDetailTip(item.exportTarget, item.exportMessage);
  const tipAttr = tip
    ? ` data-tip="${escapeHtml(tip)}" title="${escapeHtml(tip)}" tabindex="0"`
    : "";
  if (item.exportStatus === EXPORT_STATUS.PREPARING) {
    return `<span class="tag tag-exporting"${tipAttr}>准备中</span>`;
  }
  if (item.exportStatus === EXPORT_STATUS.SUCCESS) {
    return `<span class="tag tag-export-ok"${tipAttr}>已导出</span>`;
  }
  if (item.exportStatus === EXPORT_STATUS.FAILED) {
    return `<span class="tag tag-export-fail"${tipAttr}>失败</span>`;
  }
  return `<span class="tag tag-export-none">未导出</span>`;
}

function uploadStatusHtml(item) {
  const tip = statusDetailTip(item.uploadTarget, item.uploadMessage);
  const tipAttr = tip
    ? ` data-tip="${escapeHtml(tip)}" title="${escapeHtml(tip)}" tabindex="0"`
    : "";
  if (item.uploadStatus === UPLOAD_STATUS.QUEUED) {
    return `<span class="tag tag-upload-queued"${tipAttr}>待上传</span>`;
  }
  if (item.uploadStatus === UPLOAD_STATUS.UPLOADING) {
    return `<span class="tag tag-uploading"${tipAttr}>上传中</span>`;
  }
  if (item.uploadStatus === UPLOAD_STATUS.SUCCESS) {
    return `<span class="tag tag-upload-ok"${tipAttr}>成功</span>`;
  }
  if (item.uploadStatus === UPLOAD_STATUS.FAILED) {
    return `<span class="tag tag-upload-fail"${tipAttr}>失败</span>`;
  }
  if (item.uploadStatus === UPLOAD_STATUS.UNKNOWN) {
    return `<span class="tag tag-upload-unknown"${tipAttr}>未知</span>`;
  }
  if (item.uploadStatus === UPLOAD_STATUS.CANCELLED) {
    return `<span class="tag tag-upload-cancelled"${tipAttr}>已取消</span>`;
  }
  if (item.uploadStatus === UPLOAD_STATUS.SKIPPED) {
    const skipTip =
      String(item.uploadMessage || "")
        .replace(/^已跳过\s*[，,·•-]?\s*/, "")
        .trim() || item.uploadMessage || "已跳过";
    const skipTipAttr = skipTip
      ? ` data-tip="${escapeHtml(skipTip)}" title="${escapeHtml(skipTip)}" tabindex="0"`
      : tipAttr;
    return `<span class="tag tag-upload-skipped"${skipTipAttr}>已跳过</span>`;
  }
  // 兼容旧快照：曾用 NONE +「已跳过…」文案标记跳过
  if (item.uploadMessage && String(item.uploadMessage).startsWith("已跳过")) {
    const skipTip =
      String(item.uploadMessage)
        .replace(/^已跳过\s*[，,·•-]?\s*/, "")
        .trim() || "账号已过期";
    return `<span class="tag tag-upload-skipped" data-tip="${escapeHtml(skipTip)}" title="${escapeHtml(skipTip)}" tabindex="0">已跳过</span>`;
  }
  return `<span class="tag tag-upload-none">未上传</span>`;
}

function proxyCellHtml(item) {
  if (item.error || !item.account) {
    return `<span class="mono">—</span>`;
  }
  if (proxyEditingItemId === item.id) {
    const current = getItemProxyId(item);
    return `<div class="proxy-inline-edit" data-proxy-edit="${escapeHtml(item.id)}">
      <input type="number" min="0" step="1" inputmode="numeric" value="${current == null ? "" : escapeHtml(String(current))}" aria-label="编辑代理 ID" />
      <button type="button" class="proxy-mini-btn ok" data-proxy-save="${escapeHtml(item.id)}" title="保存" aria-label="保存代理 ID">✔</button>
      <button type="button" class="proxy-mini-btn cancel" data-proxy-cancel="${escapeHtml(item.id)}" title="取消" aria-label="取消编辑">✖</button>
    </div>`;
  }
  const proxyId = getItemProxyId(item);
  if (proxyId == null) {
    return `<button type="button" class="proxy-id-btn is-empty" data-proxy-edit-start="${escapeHtml(item.id)}" title="点击设置代理 ID" ${uploadBusy ? "disabled" : ""}>-</button>`;
  }
  let cls = "proxy-id-btn";
  let icon = "";
  let tip = `代理 ID ${proxyId} · 点击修改`;
  if (item.proxyValid === true) {
    cls += " is-valid";
    icon = `<span class="proxy-status-icon ok" aria-hidden="true">✓</span>`;
    tip = `代理 ID ${proxyId} 合法 · 点击修改`;
  } else if (item.proxyValid === false) {
    cls += " is-invalid";
    icon = `<span class="proxy-status-icon bad" aria-hidden="true">⚠</span>`;
    tip = `代理 ID ${proxyId} 在目标服务器不存在 · 点击修改`;
  }
  return `<button type="button" class="${cls}" data-proxy-edit-start="${escapeHtml(item.id)}" data-tip="${escapeHtml(tip)}" title="${escapeHtml(tip)}" ${uploadBusy ? "disabled" : ""}><span>${escapeHtml(String(proxyId))}</span>${icon}</button>`;
}

function renderTable() {
  document.body.classList.toggle("is-empty", items.length === 0);
  syncTableControls();
  syncSortHeaders();
  const visibleItems = getVisibleItems();
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="mono">尚未导入文件</td></tr>`;
    updateStats();
    refreshActionButtons();
    return;
  }
  if (!visibleItems.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="mono">没有匹配的账号</td></tr>`;
    updateStats();
    refreshActionButtons();
    return;
  }
  tbody.innerHTML = visibleItems
    .map(({ item, index }, rowIndex) => {
      refreshAccountExpiry(item);
      const srcTag =
        item.sourceFormat === "cpa"
          ? `<span class="tag tag-cpa">CPA</span>`
          : item.sourceFormat === "sub2api"
            ? `<span class="tag tag-sub2">SUB2API</span>`
            : `<span class="tag tag-err">unknown</span>`;
      const targetKey = resolveItemTargetKey(item);
      let target = "-";
      if (item.error || targetKey === "skip") {
        target = `<span class="tag tag-err">跳过</span>`;
      } else if (targetKey === "cpa") {
        target = `<span class="tag tag-cpa">CPA</span>`;
      } else if (targetKey === "sub2api") {
        target = `<span class="tag tag-sub2">SUB2API</span>`;
      }
      const status = item.error
        ? `<span class="tag tag-err">${escapeHtml(item.error)}</span>`
        : itemNeedsHydration(item)
          ? `<span class="tag tag-exporting">待补全</span>`
          : isItemConverted(item)
            ? `<span class="tag tag-ok">已转换</span>`
            : `<span class="tag tag-ok">待转换</span>`;
      const rowNo = tableSort.key ? rowIndex + 1 : index + 1;
      const firstCell = selectionMode
        ? `<label class="row-select-cell"><input type="checkbox" class="row-check" data-item-id="${escapeHtml(item.id)}" ${item.selected ? "checked" : ""} /><span>${rowNo}</span></label>`
        : `${rowNo}`;
      return `<tr class="${item.selected && selectionMode ? "selected-row" : ""}" data-row-id="${escapeHtml(item.id)}">
      <td class="cell-tag">${firstCell}</td>
      <td class="mono cell-file" title="${escapeHtml(item.sourceFile)}">${escapeHtml(item.sourceFile)}</td>
      <td class="cell-tag">${srcTag}</td>
      <td class="cell-tag">${target}</td>
      <td class="email" title="${escapeHtml(accountLabel(item))}">${escapeHtml(accountLabel(item))}</td>
      <td class="cell-tag">${accountTypeHtml(item)}</td>
      <td class="cell-tag">${accountStatusHtml(item)}</td>
      <td class="cell-expiry">${accountExpiryHtml(item)}</td>
      <td class="cell-tag">${proxyCellHtml(item)}</td>
      <td class="cell-tag">${status}</td>
      <td class="cell-tag">${exportStatusHtml(item)}</td>
      <td class="cell-tag">${uploadStatusHtml(item)}</td>
    </tr>`;
    })
    .join("");
  updateStats();
  refreshActionButtons();
  if (proxyEditingItemId) {
    const input = tbody.querySelector(
      `[data-proxy-edit="${CSS.escape(proxyEditingItemId)}"] input`
    );
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveTarget(sourceFormat) {
  const dir = $("direction").value;
  if (dir === "to-cpa") return "cpa";
  if (dir === "to-SUB2API") return TARGET_SUB2API;
  if (sourceFormat === "cpa") return TARGET_SUB2API;
  if (sourceFormat === "sub2api") return "cpa";
  return null;
}

function stripInternal(obj) {
  return AccountConvert.stripInternal(obj);
}

function finalizeCpa(c) {
  return AccountConvert.finalizeCpa(c, readConvertOptionsFromUi());
}

function finalizeSub2(account, preserveExtra, proxyId = null) {
  return AccountConvert.finalizeSub2(account, {
    ...readConvertOptionsFromUi({ proxyId }),
    preserveExtra: Boolean(preserveExtra),
    proxyId: proxyId != null ? proxyId : null,
  });
}

function convertItemTo(item, target) {
  if (!item || item.error || !item.account) throw new Error("账号不可用");
  const proxyId = getItemProxyId(item);
  return AccountConvert.convertAccountTo(
    item.account,
    item.sourceFormat,
    target,
    readConvertOptionsFromUi({ proxyId })
  );
}

function normalizeExportTarget(target) {
  if (target === TARGET_SUB2API || target === "sub2api") return TARGET_SUB2API;
  return TARGET_CPA;
}

function setExportBusy(busy) {
  exportBusy = Boolean(busy);
  if (!exportBusy) activeExportItemIds = null;
  refreshActionButtons();
}

function exportProgressMessage(target, total, phaseText = "") {
  const scope = activeExportItemIds
    ? items.filter((item) => activeExportItemIds.has(item.id))
    : getOperationItems().filter((item) => canExportFormat(item));
  const success = scope.filter((item) => item.exportStatus === EXPORT_STATUS.SUCCESS).length;
  const failed = scope.filter((item) => item.exportStatus === EXPORT_STATUS.FAILED).length;
  const preparing = scope.filter((item) => item.exportStatus === EXPORT_STATUS.PREPARING).length;
  const settled = success + failed;
  const pct = total > 0 ? Math.min(100, Math.round((settled / total) * 100)) : 0;
  const label = target === TARGET_SUB2API ? "SUB2API" : "CPA";
  setUploadProgressVisible(true);
  $("uploadProgressTitle").textContent = phaseText || `${label} 导出进度`;
  $("uploadProgressPct").textContent = `${pct}% ${settled}/${total}`;
  $("uploadProgressMeta").innerHTML =
    `<span>已导出：<b>${success}</b></span>` +
    `<span>失败：<b>${failed}</b></span>` +
    `<span>准备中：<b>${preparing}</b></span>` +
    `<span>共：<b>${total}</b></span>`;
  const fill = $("uploadProgressFill");
  fill.style.width = `${pct}%`;
  fill.classList.remove("is-ok", "is-warn", "is-danger");
  if (failed) fill.classList.add("is-danger");
  else if (settled >= total && total > 0 && !preparing) fill.classList.add("is-ok");
  else if (preparing) fill.classList.add("is-warn");
}

/**
 * 导出/上传前：按目标补全凭证并自动转换
 * @returns {Promise<{items:any[], skipped:any[], cancelled:boolean}|null>}
 */
async function prepareItemsForTarget(target, options = {}) {
  const { progressLabel = "操作", trackExport = false, announceEmpty = true } = options;
  const exportTarget = normalizeExportTarget(target);
  if (remoteImportBusy && !exportBusy) {
    showMsg(`远端导入进行中，请稍后再${progressLabel}`, "err");
    return null;
  }
  if (uploadBusy) {
    showMsg(`上传进行中，请稍后再${progressLabel}`, "err");
    return null;
  }
  // 导出不受转换方向限制：操作集内可导出项均可转到目标格式
  const operationItems = getOperationItems().filter((item) => canExportFormat(item));
  if (!operationItems.length) {
    if (announceEmpty) {
      showMsg(
        selectionMode ? `请先选择可${progressLabel}的账号` : `没有可${progressLabel}的账号`,
        "err"
      );
    }
    return null;
  }

  if (trackExport) {
    activeExportItemIds = new Set(operationItems.map((item) => item.id));
    for (const item of operationItems) {
      setItemExportState(item, EXPORT_STATUS.PREPARING, exportTarget, "补全凭证与转换中");
    }
    exportProgressMessage(exportTarget, operationItems.length, `${progressLabel}准备中`);
    renderTable();
  }

  try {
    const hydrate = await ensureItemsHydrated(operationItems, {
      progressLabel,
      allowPartial: true,
      allowDuringExport: trackExport || exportBusy,
    });
    if (hydrate.cancelled) {
      if (trackExport) {
        for (const item of operationItems) {
          if (item.exportStatus === EXPORT_STATUS.PREPARING) {
            setItemExportState(item, EXPORT_STATUS.NONE, "", "已取消");
          }
        }
        renderTable();
      }
      showMsg("已取消补全凭证", "info");
      return { items: [], skipped: [], cancelled: true };
    }
  } catch (error) {
    if (trackExport) {
      for (const item of operationItems) {
        setItemExportState(
          item,
          EXPORT_STATUS.FAILED,
          exportTarget,
          `补全凭证失败：${apiErrorMessage(error)}`
        );
      }
      exportProgressMessage(exportTarget, operationItems.length, `${progressLabel}失败`);
      renderTable();
    }
    showMsg(`补全凭证失败：${apiErrorMessage(error)}`, "err");
    return null;
  }

  let convertFailed = 0;
  for (const item of operationItems) {
    if (itemNeedsHydration(item) || item.error || !item.account) {
      if (trackExport) {
        setItemExportState(item, EXPORT_STATUS.FAILED, exportTarget, item.error || "凭证未补全");
      }
      convertFailed += 1;
      continue;
    }
    const already =
      item.converted &&
      (exportTarget === TARGET_SUB2API
        ? item.targetFormat === TARGET_SUB2API
        : item.targetFormat === "cpa" || item.targetFormat === TARGET_CPA);
    if (already) continue;
    try {
      item.converted = convertItemTo(item, exportTarget);
      item.targetFormat = exportTarget === TARGET_SUB2API ? TARGET_SUB2API : "cpa";
    } catch (e) {
      item.error = "转换失败: " + e.message;
      convertFailed += 1;
      if (trackExport) {
        setItemExportState(item, EXPORT_STATUS.FAILED, exportTarget, item.error);
      }
    }
  }
  converted = items.some((item) => item.converted);

  const ready = operationItems.filter((item) => {
    if (item.error || !item.account || itemNeedsHydration(item) || !item.converted) {
      return false;
    }
    if (exportTarget === TARGET_SUB2API) return item.targetFormat === TARGET_SUB2API;
    return item.targetFormat === "cpa" || item.targetFormat === TARGET_CPA;
  });
  const { items: list, skipped } = filterExportOrUploadItems(ready, {
    announce: false,
    actionLabel: progressLabel,
  });
  if (trackExport) {
    for (const item of skipped) {
      setItemExportState(item, EXPORT_STATUS.FAILED, exportTarget, "已跳过失效账号");
    }
    for (const item of operationItems) {
      if (
        item.exportStatus === EXPORT_STATUS.PREPARING &&
        !list.includes(item) &&
        !skipped.includes(item)
      ) {
        setItemExportState(item, EXPORT_STATUS.FAILED, exportTarget, item.error || "无法导出");
      }
    }
    exportProgressMessage(exportTarget, operationItems.length, `${progressLabel}准备中`);
    renderTable();
    scheduleWorkspaceSave({ immediate: true });
  } else {
    renderTable();
    scheduleWorkspaceSave({ immediate: true });
  }

  if (!list.length) {
    if (announceEmpty) {
      showMsg(
        skipped.length
          ? `没有可${progressLabel}的账号，跳过 ${skipped.length} 个失效账号`
          : convertFailed
            ? `没有可${progressLabel}的账号，转换/补全失败 ${convertFailed} 个`
            : `没有可${progressLabel}的账号`,
        "err"
      );
    }
    return { items: [], skipped, cancelled: false };
  }
  return { items: list, skipped, cancelled: false };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadJson(obj, filename) {
  const text = JSON.stringify(obj, null, 2);
  downloadBlob(new Blob([text], { type: "application/json;charset=utf-8" }), filename);
}

function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

async function exportSub2() {
  if (exportBusy || uploadBusy || remoteImportBusy || sub2DedupeBusy) {
    showMsg("其他任务进行中，请稍后再导出", "err");
    return;
  }
  clearMsg();
  setExportBusy(true);
  try {
    const prepared = await prepareItemsForTarget(TARGET_SUB2API, {
      progressLabel: "导出 SUB2API",
      trackExport: true,
    });
    if (!prepared || prepared.cancelled) return;
    const { items: list, skipped } = prepared;
    if (!list.length) return;
    const accounts = list.map((i) => i.converted);
    const pack = {
      exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      proxies: [],
      accounts,
    };
    downloadJson(pack, `SUB2API-account-${tsStamp()}.json`);
    for (const item of list) {
      setItemExportState(item, EXPORT_STATUS.SUCCESS, TARGET_SUB2API, "已写入本机文件");
    }
    exportProgressMessage(TARGET_SUB2API, activeExportItemIds?.size || list.length);
    renderTable();
    scheduleWorkspaceSave({ immediate: true });
    showMsg(
      `已导出 ${accounts.length} 个账号` +
        (skipped.length ? `，跳过 ${skipped.length} 个失效账号` : ""),
      "ok"
    );
  } finally {
    setExportBusy(false);
  }
}

// ---- minimal ZIP (STORE) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function u16(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255]);
}
function u32(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}
function concat(chunks) {
  const len = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function buildZip(files) {
  // files: [{name, data: Uint8Array}]
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concat(centrals);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, centralDir, end]);
}

async function exportCpaZip() {
  if (exportBusy || uploadBusy || remoteImportBusy || sub2DedupeBusy) {
    showMsg("其他任务进行中，请稍后再导出", "err");
    return;
  }
  clearMsg();
  setExportBusy(true);
  try {
    const prepared = await prepareItemsForTarget(TARGET_CPA, {
      progressLabel: "导出 CPA",
      trackExport: true,
    });
    if (!prepared || prepared.cancelled) return;
    const { items: list, skipped } = prepared;
    if (!list.length) return;
    const enc = new TextEncoder();
    const used = new Map();
    const files = list.map((item) => {
      let name = cpaFilename(item.converted);
      if (used.has(name)) {
        const n = used.get(name) + 1;
        used.set(name, n);
        name = name.replace(/\.json$/i, `-${n}.json`);
      } else {
        used.set(name, 1);
      }
      const text = JSON.stringify(item.converted, null, 2);
      return { name, data: enc.encode(text) };
    });
    const zipBytes = buildZip(files);
    downloadBlob(new Blob([zipBytes], { type: "application/zip" }), `cpa-auth-${tsStamp()}.zip`);
    for (const item of list) {
      setItemExportState(item, EXPORT_STATUS.SUCCESS, TARGET_CPA, "已写入本机 ZIP");
    }
    exportProgressMessage(TARGET_CPA, activeExportItemIds?.size || list.length);
    renderTable();
    scheduleWorkspaceSave({ immediate: true });
    showMsg(
      `已导出 CPA ${files.length} 个文件` +
        (skipped.length ? `，跳过 ${skipped.length} 个失效账号` : ""),
      "ok"
    );
  } finally {
    setExportBusy(false);
  }
}
