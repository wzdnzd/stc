function setRemoteImportStatus(text, type = "info", options = {}) {
  const raw = String(text || "").trim();
  if (!raw) return;
  const { toast = false, toastMs, skipMsg = false } = options;
  if (!skipMsg) {
    if (type === "err") showMsg(raw, "err");
    else if (type === "ok") showMsg(raw, "ok");
    else showMsg(raw, "info");
  }
  if (toast) {
    showToast(raw, type === "err" ? "err" : type === "ok" ? "ok" : "info", toastMs);
  }
}

function describeRemoteSource(target) {
  const effective = getEffectiveClientConfig(target);
  if (effective?.baseUrl) return String(effective.baseUrl).trim();
  if (effective?.source === "env") {
    const baseUrl = targetConfigInfo(target)?.baseUrl || "";
    if (baseUrl) return String(baseUrl).trim();
    return "环境变量已配置";
  }
  if (effective?.source === "local") return "本机已配置";
  return "未配置";
}

function normalizeRemoteSourceTarget(value) {
  const raw = String(value || "").toUpperCase();
  return raw === TARGET_SUB2API || raw === "SUB2API" ? TARGET_SUB2API : TARGET_CPA;
}

function setRemoteSourceTarget(value, options = {}) {
  if (remoteImportBusy && !options.force) return;
  remoteSourceTarget = normalizeRemoteSourceTarget(value);
  const select = $("remoteSourceSelect");
  if (select && select.value !== remoteSourceTarget) select.value = remoteSourceTarget;
  refreshRemoteImportUi();
}

function setImportMode(mode) {
  if (remoteImportBusy && mode !== importMode) {
    showMsg("远端导入进行中，请先取消或等待完成", "err");
    return;
  }
  importMode = mode === "remote" || mode === "transfer" ? "remote" : "local";
  const toggle = $("btnImportModeToggle");
  const localLabel = $("importModeLabelLocal");
  const remoteLabel = $("importModeLabelRemote");
  const localPanel = $("importPanelLocal");
  const remotePanel = $("importPanelRemote");
  if (toggle) {
    toggle.classList.toggle("is-remote", importMode === "remote");
    toggle.setAttribute("aria-checked", importMode === "remote" ? "true" : "false");
    toggle.setAttribute("aria-label", importMode === "remote" ? "远端导入" : "本地导入");
  }
  if (localLabel) localLabel.classList.toggle("is-active", importMode === "local");
  if (remoteLabel) remoteLabel.classList.toggle("is-active", importMode === "remote");
  if (localPanel) localPanel.hidden = importMode !== "local";
  if (remotePanel) remotePanel.hidden = importMode !== "remote";
  refreshRemoteImportUi();
}

function clearConvertedState() {
  converted = false;
  for (const item of items) {
    item.converted = null;
    item.targetFormat = null;
    item.exportStatus = EXPORT_STATUS.NONE;
    item.exportTarget = "";
    item.exportMessage = "";
  }
}

function applyDirectionLockUi() {
  const select = $("direction");
  const note = $("directionLockNote");
  if (select) select.disabled = Boolean(directionLockedByRemote);
  if (note) note.hidden = !directionLockedByRemote;
}

function lockDirectionForRemoteSource(sourceTarget = remoteSourceTarget) {
  const value =
    normalizeRemoteSourceTarget(sourceTarget) === TARGET_SUB2API ? "to-cpa" : "to-SUB2API";
  const select = $("direction");
  if (select) select.value = value;
  directionLockedByRemote = true;
  clearConvertedState();
  applyDirectionLockUi();
  saveUiSettingsSoon();
  renderTable();
  scheduleWorkspaceSave();
}

function unlockDirection(options = {}) {
  const { silent = false } = options;
  if (!directionLockedByRemote) {
    applyDirectionLockUi();
    return;
  }
  directionLockedByRemote = false;
  applyDirectionLockUi();
  if (!silent) {
    showMsg("已解除转换方向锁定", "info");
    showToast("已解除转换方向锁定", "info", 2600);
  }
  saveUiSettingsSoon();
}

function hasEffectiveConfig(target) {
  return Boolean(getEffectiveClientConfig(target));
}

function refreshRemoteImportUi() {
  const sourceTarget = normalizeRemoteSourceTarget(remoteSourceTarget);
  remoteSourceTarget = sourceTarget;
  const sourceSelect = $("remoteSourceSelect");
  if (sourceSelect) {
    sourceSelect.value = sourceTarget;
    sourceSelect.disabled = remoteImportBusy;
  }

  const sourceValue = $("remoteSourceValue");
  if (sourceValue) {
    const label = describeRemoteSource(sourceTarget);
    sourceValue.textContent = label;
    sourceValue.title = label;
    sourceValue.classList.toggle("is-empty", !hasEffectiveConfig(sourceTarget));
  }

  const toggle = $("btnImportModeToggle");
  if (toggle) toggle.disabled = remoteImportBusy;

  const configBtn = $("btnRemoteConfigSource");
  if (configBtn) {
    configBtn.disabled = remoteImportBusy;
    configBtn.textContent = hasEffectiveConfig(sourceTarget) ? "管理" : "配置";
  }

  const pullBtn = $("btnRemotePullList");
  if (pullBtn) {
    pullBtn.disabled =
      remoteImportBusy ||
      uploadBusy ||
      exportBusy ||
      cpaRemoteBusy ||
      sub2RemoteBusy ||
      sub2DedupeBusy;
    if (remoteImportBusy) {
      pullBtn.innerHTML = '<span class="busy-spin"></span>正在拉取';
    } else {
      pullBtn.textContent = "拉取列表";
    }
  }

  const dedupeBtn = $("btnRemoteSub2Dedupe");
  if (dedupeBtn) {
    const showDedupe =
      sourceTarget === TARGET_SUB2API &&
      (listHasRemoteOrigin(TARGET_SUB2API) || hasSub2apiConfigReady());
    dedupeBtn.hidden = !showDedupe;
    dedupeBtn.disabled =
      !showDedupe ||
      remoteImportBusy ||
      uploadBusy ||
      exportBusy ||
      sub2DedupeBusy ||
      sub2RemoteBusy ||
      !hasSub2apiConfigReady();
    if (!sub2DedupeBusy) dedupeBtn.innerHTML = "服务端去重";
  }

  const abortBtn = $("btnRemoteAbort");
  if (abortBtn) {
    abortBtn.hidden = !remoteImportBusy;
    abortBtn.disabled = !remoteImportBusy || remoteImportCancelRequested;
    abortBtn.textContent = remoteImportCancelRequested ? "正在取消…" : "取消";
  }

  applyDirectionLockUi();
}

function setRemoteImportBusy(busy) {
  remoteImportBusy = Boolean(busy);
  refreshActionButtons();
}

function throwIfRemoteImportCancelled() {
  if (remoteImportCancelRequested || remoteImportAbortController?.signal?.aborted) {
    const err = new Error("已取消");
    err.name = "RemoteCancelledError";
    throw err;
  }
}

function cancelRemoteImport() {
  if (!remoteImportBusy) return;
  remoteImportCancelRequested = true;
  remoteImportAbortController?.abort();
  refreshRemoteImportUi();
  setRemoteImportStatus("正在取消拉取，当前请求结束后停止", "info", { toast: true });
}

function itemFromRemoteCpaContent(name, content, index = 0) {
  const sourceFile = String(name || `cpa-remote-${index + 1}.json`);
  let parsedItems = [];
  if (content == null) {
    parsedItems = [
      prepareItem({
        sourceFile,
        sourceFormat: "unknown",
        account: null,
        error: "下载内容为空",
      }),
    ];
  } else if (typeof content === "string") {
    parsedItems = parseFileContent(sourceFile, content);
  } else if (typeof content === "object") {
    try {
      parsedItems = parseFileContent(sourceFile, JSON.stringify(content));
    } catch (error) {
      parsedItems = [
        prepareItem({
          sourceFile,
          sourceFormat: "unknown",
          account: null,
          error: "解析失败: " + (error?.message || error),
        }),
      ];
    }
  } else {
    parsedItems = [
      prepareItem({
        sourceFile,
        sourceFormat: "unknown",
        account: null,
        error: "无法识别的下载内容",
      }),
    ];
  }
  return (parsedItems || []).map((item) => {
    item.remoteOrigin = TARGET_CPA;
    item.remoteRef = { kind: "cpa", name: sourceFile };
    item.needsHydration = false;
    return item;
  });
}

function itemsFromSub2RemoteAccounts(accounts, options = {}) {
  const { asStub = false } = options;
  const out = [];
  for (const account of accounts || []) {
    const idPart =
      account?.id != null
        ? String(account.id)
        : account?.email || account?.name || account?.credentials?.email || "unknown";
    const sourceFile = `sub2api-remote:${idPart}`;
    if (asStub) {
      const email = String(account?.email || account?.name || "").trim();
      const expiresAt =
        unixFromIsoOrNumber(account?.expiresAt) ||
        unixFromIsoOrNumber(account?.expires_at) ||
        unixFromIsoOrNumber(account?.credentials?.expires_at) ||
        null;
      // 列表摘要可能已带 proxyId；也兼容原始 proxy_id / proxy.id
      const proxyId = parseProxyId(
        account?.proxyId ?? account?.proxy_id ?? account?.proxy?.id ?? account?.proxy?.proxy_id
      );
      const status = account?.status ?? "";
      const stubAccount = {
        id: account?.id,
        name: account?.name || email || `id=${idPart}`,
        credentials: email ? { email } : {},
        extra: email ? { email } : {},
        status,
        platform: account?.platform,
        type: account?.type,
        normal: account?.normal,
      };
      if (proxyId != null) stubAccount.proxy_id = proxyId;
      if (expiresAt != null) {
        stubAccount.credentials.expires_at = expiresAt;
      }
      out.push(
        prepareItem({
          sourceFile,
          sourceFormat: "sub2api",
          account: stubAccount,
          needsHydration: true,
          remoteOrigin: TARGET_SUB2API,
          remoteRef: {
            kind: "sub2",
            id: account?.id != null ? account.id : idPart,
            email,
            name: account?.name || "",
          },
          expiresAt,
          proxyId,
          remoteStatus: status,
          remoteNormal: account?.normal,
        })
      );
      continue;
    }
    if (isSub2Account(account) || (account && account.credentials)) {
      const normalized = normalizeSub2(account);
      out.push(
        prepareItem({
          sourceFile,
          sourceFormat: "sub2api",
          account: normalized,
          needsHydration: false,
          remoteOrigin: TARGET_SUB2API,
          remoteRef: {
            kind: "sub2",
            id: account?.id != null ? account.id : idPart,
          },
          proxyId: extractProxyIdFromAccount(normalized),
        })
      );
    } else if (isCpaRecord(account)) {
      out.push(
        prepareItem({
          sourceFile,
          sourceFormat: "cpa",
          account: normalizeCpa(account),
          needsHydration: false,
          remoteOrigin: TARGET_SUB2API,
          remoteRef: {
            kind: "sub2",
            id: account?.id != null ? account.id : idPart,
          },
        })
      );
    } else {
      out.push(
        prepareItem({
          sourceFile,
          sourceFormat: "unknown",
          account: null,
          error: "账号结构无法识别",
          remoteOrigin: TARGET_SUB2API,
          remoteRef: {
            kind: "sub2",
            id: account?.id != null ? account.id : idPart,
          },
        })
      );
    }
  }
  return out;
}

function stubsFromCpaRemoteFiles(files) {
  const out = [];
  for (const file of files || []) {
    const name = String(file?.name || "").trim();
    if (!name) continue;
    const label = file?.account || file?.accountId || name.replace(/\.json$/i, "") || name;
    // 列表阶段没有 token 过期时间：用 updated_at 占位，补全凭证后 refreshAccountExpiry 会换成真实过期
    const provisionalExpiry =
      unixFromIsoOrNumber(file?.updatedAt ?? file?.updated_at ?? file?.modified_at) || null;
    // 快载用 provider 作为账号类型；补全后改为完整数据的 type
    const provider = String(file?.provider || "").trim();
    const status = String(file?.status || "").trim();
    const account = {
      type: provider || "xai",
      provider,
      auth_kind: "oauth",
      email: String(label),
      name,
      status,
      disabled: Boolean(file?.disabled),
      unavailable: Boolean(file?.unavailable),
    };
    if (provisionalExpiry != null) {
      account._exp = provisionalExpiry;
      account.expired = isoFromUnix(provisionalExpiry);
    }
    out.push(
      prepareItem({
        sourceFile: name,
        sourceFormat: "cpa",
        account,
        needsHydration: true,
        remoteOrigin: TARGET_CPA,
        remoteRef: { kind: "cpa", name },
        expiresAt: provisionalExpiry,
        remoteStatus: status,
      })
    );
  }
  return out;
}

/**
 * 将解析后的账号写入主列表；供本地导入与远端导入共用
 * @returns {Promise<null|{mode:string,mergeInfo:any,internalDropped:number,count:number}>}
 */
async function commitIncomingItems(incoming, options = {}) {
  const {
    sourceLabel = "导入",
    emptyMessage = "未解析到可导入账号",
    resetFileInput = false,
    unlockDirectionOnSuccess = false,
    lockDirectionAfter = null,
  } = options;

  if (uploadBusy) {
    showMsg("上传进行中，请先取消或等待完成后再导入", "err");
    return null;
  }
  if (remoteImportBusy && !options.allowDuringRemoteImport) {
    showMsg("远端导入进行中，请稍后再导入", "err");
    return null;
  }
  if (!Array.isArray(incoming) || !incoming.length) {
    showMsg(emptyMessage, "err");
    return null;
  }

  if (!items.length && pendingWorkspaceSnapshot?.items?.length) {
    const snapCount = pendingWorkspaceSnapshot.items.length;
    const go = window.confirm(
      `本机还有上次 ${snapCount} 个账号的工作区快照尚未恢复。\n` +
        `确定继续导入将丢弃该快照，仅使用本次数据。\n\n` +
        `点击「取消」可先恢复快照。`
    );
    if (!go) {
      if (resetFileInput && fileInput) fileInput.value = "";
      return null;
    }
    await clearWorkspaceSnapshot();
  }

  let mode = "merge";
  if (items.length) {
    mode = await openImportConflictModal({
      existingCount: items.length,
      incomingCount: incoming.length,
    });
    if (mode === "cancel") {
      if (resetFileInput && fileInput) fileInput.value = "";
      showMsg("已取消本次导入", "info");
      return null;
    }
  }

  const incomingDeduped = dedupeItemList(incoming);
  const internalDropped = incoming.length - incomingDeduped.length;

  let finalItems = [];
  let mergeInfo = { replaced: 0, keptOld: 0, added: 0 };
  if (mode === "replace" || !items.length) {
    finalItems = incomingDeduped;
    mergeInfo = { replaced: 0, keptOld: 0, added: incomingDeduped.length };
    converted = false;
    restoredJobMeta = null;
  } else {
    mergeInfo = mergeItemsByIdentity(items, incomingDeduped, {
      preferIncomingOnTie: true,
    });
    finalItems = mergeInfo.items;
    converted = finalItems.some((item) => item.converted);
  }

  items = finalItems;
  for (const item of items) item.selected = false;
  // 导入后列表非空时默认进入多选，方便直接用筛选
  selectionMode = items.length > 0;
  if (resetFileInput && fileInput) fileInput.value = "";
  hideWorkspaceRestoreBanner();
  pendingWorkspaceSnapshot = null;
  const discardBtn = $("btnDiscardWorkspace");
  if (discardBtn) discardBtn.textContent = "丢弃快照";

  if (unlockDirectionOnSuccess) unlockDirection({ silent: true });
  if (lockDirectionAfter) lockDirectionForRemoteSource(lockDirectionAfter);
  refreshPendingRemoteHydrationFlag();

  renderTable();
  scheduleWorkspaceSave({ immediate: true });

  return {
    mode,
    mergeInfo,
    internalDropped,
    count: items.length,
    sourceLabel,
  };
}

function formatCommitMessage(result, extras = []) {
  if (!result) return "";
  const parts = [];
  if (extras.length) parts.push(...extras);
  if (result.mode === "replace") parts.push("已替换原列表");
  else if (result.mergeInfo?.added) parts.push(`新增：${result.mergeInfo.added}`);
  if (result.mergeInfo?.replaced) parts.push(`更新：${result.mergeInfo.replaced}`);
  if (result.mergeInfo?.keptOld) parts.push(`保留较新已有：${result.mergeInfo.keptOld}`);
  if (result.internalDropped > 0) parts.push(`导入内去重：${result.internalDropped}`);
  parts.push(`当前共 ${result.count} 个账号`);
  return parts.join(", ");
}

async function listCpaRemoteFilesMeta(signal) {
  const effective = getEffectiveClientConfig(TARGET_CPA);
  if (!effective) throw new Error("请先配置 CPA");
  const body = {};
  const config = uploadConfigPayload(effective);
  if (config) body.config = config;
  const { data } = await fetchJson(
    "/api/cpa/auth-files/list",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
    2 * 60 * 1000
  );
  return Array.isArray(data?.files) ? data.files : [];
}

async function listSub2RemoteAccountsMeta(signal) {
  const effective = getEffectiveClientConfig(TARGET_SUB2API);
  if (!effective) throw new Error("请先配置 SUB2API");
  const body = {};
  const config = uploadConfigPayload(effective);
  if (config) body.config = config;
  const { data } = await fetchJson(
    "/api/sub2api/accounts/list",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
    10 * 60 * 1000
  );
  return Array.isArray(data?.accounts) ? data.accounts : [];
}

async function fetchAllCpaRemoteAuthContents(names, options = {}) {
  const { signal, onProgress, cancelChecker } = options;
  const checkCancel =
    typeof cancelChecker === "function" ? cancelChecker : throwIfRemoteImportCancelled;
  const effective = getEffectiveClientConfig(TARGET_CPA);
  if (!effective) throw new Error("请先配置 CPA");
  const maxPerRequest = currentMaxCpaAuthDownload();
  const chunkSize = Math.max(1, Math.min(REMOTE_CPA_DOWNLOAD_CHUNK_DEFAULT, maxPerRequest));
  const chunks = chunkArray(names, chunkSize);
  const config = uploadConfigPayload(effective);
  const okFiles = [];
  let failedCount = 0;
  let cancelled = false;

  for (let i = 0; i < chunks.length; i++) {
    checkCancel();
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const chunk = chunks[i];
    if (typeof onProgress === "function") {
      onProgress({
        phase: "download",
        chunkIndex: i + 1,
        chunkTotal: chunks.length,
        chunkSize: chunk.length,
        okCount: okFiles.length,
        failedCount,
      });
    }
    const body = { names: chunk };
    if (config) body.config = config;
    try {
      const { data } = await fetchJson(
        "/api/cpa/auth-files/download",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
        10 * 60 * 1000
      );
      checkCancel();
      const files = Array.isArray(data?.files) ? data.files : [];
      const okNames = new Set();
      for (const item of files) {
        if (item?.ok && item.content != null) {
          okFiles.push(item);
          okNames.add(String(item.name || ""));
        }
      }
      for (const name of chunk) {
        if (!okNames.has(String(name || ""))) failedCount += 1;
      }
    } catch (chunkError) {
      if (
        chunkError?.name === "RemoteCancelledError" ||
        chunkError?.name === "AbortError" ||
        signal?.aborted
      ) {
        cancelled = true;
        break;
      }
      const files = Array.isArray(chunkError?.data?.files) ? chunkError.data.files : [];
      const okNames = new Set();
      for (const item of files) {
        if (item?.ok && item.content != null) {
          okFiles.push(item);
          okNames.add(String(item.name || ""));
        }
      }
      for (const name of chunk) {
        if (!okNames.has(String(name || ""))) failedCount += 1;
      }
    }
    await yieldToBrowser();
  }

  return { files: okFiles, failedCount, cancelled };
}

async function fetchAllSub2RemoteAccounts(ids, options = {}) {
  const { signal, onProgress, cancelChecker } = options;
  const checkCancel =
    typeof cancelChecker === "function" ? cancelChecker : throwIfRemoteImportCancelled;
  const effective = getEffectiveClientConfig(TARGET_SUB2API);
  if (!effective) throw new Error("请先配置 SUB2API");
  const maxPerRequest = currentMaxSub2apiExport();
  const chunkSize = Math.max(1, Math.min(REMOTE_EXPORT_CHUNK_DEFAULT, maxPerRequest));
  const chunks = chunkArray(ids, chunkSize);
  const config = uploadConfigPayload(effective);
  const accounts = [];
  /** @type {Map<string, any>} */
  const accountById = new Map();
  let failedCount = 0;
  let hardError = null;
  let cancelled = false;
  let exportedAt = "";

  for (let i = 0; i < chunks.length; i++) {
    checkCancel();
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const chunk = chunks[i];
    if (typeof onProgress === "function") {
      onProgress({
        phase: "export",
        chunkIndex: i + 1,
        chunkTotal: chunks.length,
        chunkSize: chunk.length,
        okCount: accounts.length,
        failedCount,
      });
    }
    const body = { ids: chunk };
    if (config) body.config = config;
    body.timezone =
      (typeof Intl !== "undefined" && Intl.DateTimeFormat?.().resolvedOptions?.().timeZone) ||
      "UTC";
    try {
      const { data } = await fetchJson(
        "/api/sub2api/accounts/export",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
        10 * 60 * 1000
      );
      checkCancel();
      const pack = data?.pack;
      if (pack?.exported_at && !exportedAt) exportedAt = pack.exported_at;
      const packAccounts = Array.isArray(pack?.accounts) ? pack.accounts : [];
      const successIds = Array.isArray(data?.successIds)
        ? data.successIds.map((id) => String(id))
        : [];
      if (packAccounts.length) {
        accounts.push(...packAccounts);
        for (let idx = 0; idx < packAccounts.length; idx++) {
          const account = packAccounts[idx];
          const matchedId =
            account?.id != null
              ? String(account.id)
              : successIds[idx] || (chunk[idx] != null ? String(chunk[idx]) : "");
          if (matchedId) accountById.set(matchedId, account);
        }
      }
      const reportedFailed = Number(data?.failedCount || 0);
      if (packAccounts.length >= chunk.length && reportedFailed === 0) {
        // 整批成功
      } else if (reportedFailed > 0) {
        failedCount += reportedFailed;
      } else if (packAccounts.length < chunk.length) {
        failedCount += chunk.length - packAccounts.length;
      }
    } catch (chunkError) {
      if (
        chunkError?.name === "RemoteCancelledError" ||
        chunkError?.name === "AbortError" ||
        signal?.aborted
      ) {
        cancelled = true;
        break;
      }
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
      const partialAccounts = Array.isArray(chunkError?.data?.pack?.accounts)
        ? chunkError.data.pack.accounts
        : [];
      if (partialAccounts.length) {
        accounts.push(...partialAccounts);
        const successIds = Array.isArray(chunkError?.data?.successIds)
          ? chunkError.data.successIds.map((id) => String(id))
          : [];
        for (let idx = 0; idx < partialAccounts.length; idx++) {
          const account = partialAccounts[idx];
          const matchedId =
            account?.id != null
              ? String(account.id)
              : successIds[idx] || (chunk[idx] != null ? String(chunk[idx]) : "");
          if (matchedId) accountById.set(matchedId, account);
        }
      }
      const reportedFailed = Number(
        chunkError?.data?.failedCount ?? chunk.length - partialAccounts.length
      );
      failedCount += Math.max(0, reportedFailed);
      const softIncomplete =
        chunkError?.data?.code === "INCOMPLETE_ACCOUNT_DATA" || chunkError?.status === 502;
      if (!hardError && !softIncomplete) hardError = chunkError;
    }
    await yieldToBrowser();
  }

  return { accounts, accountById, failedCount, hardError, cancelled, exportedAt };
}

function applyHydratedAccountToItem(item, fullAccount) {
  if (!item || !fullAccount) return false;
  const origin = itemRemoteOrigin(item) || remoteSourceTarget;
  if (origin === TARGET_CPA || item.sourceFormat === "cpa") {
    if (isCpaRecord(fullAccount) || fullAccount.email || fullAccount.access_token) {
      item.account = normalizeCpa(fullAccount);
      item.sourceFormat = "cpa";
    } else if (isSub2Account(fullAccount) || fullAccount.credentials) {
      item.account = normalizeSub2(fullAccount);
      item.sourceFormat = "sub2api";
    } else {
      return false;
    }
  } else {
    if (isSub2Account(fullAccount) || fullAccount.credentials) {
      item.account = normalizeSub2(fullAccount);
      item.sourceFormat = "sub2api";
    } else if (isCpaRecord(fullAccount)) {
      item.account = normalizeCpa(fullAccount);
      item.sourceFormat = "cpa";
    } else {
      return false;
    }
  }
  item.needsHydration = false;
  item.error = "";
  item.converted = null;
  item.targetFormat = null;
  if (item.proxyId == null) item.proxyId = extractProxyIdFromAccount(item.account);
  refreshAccountExpiry(item);
  return true;
}

async function ensureItemsHydrated(targetItems, options = {}) {
  const { progressLabel = "操作", allowPartial = true, signal: externalSignal = null } = options;
  const pending = (targetItems || []).filter((item) => itemNeedsHydration(item));
  if (!pending.length) {
    return { okCount: 0, failedCount: 0, cancelled: false, pending: 0 };
  }

  const cpaNames = [];
  const sub2Ids = [];
  /** @type {Map<string, any[]>} */
  const cpaItemsByName = new Map();
  /** @type {Map<string, any[]>} */
  const sub2ItemsById = new Map();

  for (const item of pending) {
    const ref = item.remoteRef || {};
    if (ref.kind === "cpa" || itemRemoteOrigin(item) === TARGET_CPA) {
      const name = String(ref.name || item.sourceFile || "").trim();
      if (!name) continue;
      cpaNames.push(name);
      if (!cpaItemsByName.has(name)) cpaItemsByName.set(name, []);
      cpaItemsByName.get(name).push(item);
    } else {
      const id =
        ref.id != null ? ref.id : String(item.sourceFile || "").replace(/^sub2-remote:/, "");
      if (id == null || id === "") continue;
      const key = String(id);
      sub2Ids.push(id);
      if (!sub2ItemsById.has(key)) sub2ItemsById.set(key, []);
      sub2ItemsById.get(key).push(item);
    }
  }

  const uniqueCpaNames = [...new Set(cpaNames.filter(Boolean))];
  const uniqueSub2Ids = [];
  const seenSub2 = new Set();
  for (const id of sub2Ids) {
    const key = String(id);
    if (seenSub2.has(key)) continue;
    seenSub2.add(key);
    uniqueSub2Ids.push(id);
  }

  if (!uniqueCpaNames.length && !uniqueSub2Ids.length) {
    return {
      okCount: 0,
      failedCount: pending.length,
      cancelled: false,
      pending: pending.length,
    };
  }

  let localController = null;
  let signal = externalSignal;
  let ownBusy = false;
  if (!signal) {
    if (remoteImportBusy || uploadBusy || (exportBusy && !options.allowDuringExport)) {
      throw new Error("其他任务进行中，请稍后再补全凭证");
    }
    remoteImportCancelRequested = false;
    localController = new AbortController();
    remoteImportAbortController = localController;
    signal = localController.signal;
    setRemoteImportBusy(true);
    ownBusy = true;
  }

  let okCount = 0;
  let failedCount = 0;
  let cancelled = false;
  let hardError = null;

  try {
    showMsg(`正在为${progressLabel}补全 ${pending.length} 个远端账号凭证`, "info");
    setRemoteImportStatus(`正在补全凭证，待处理 ${pending.length} 个账号`, "info");

    if (uniqueCpaNames.length) {
      const verified = await ensureVerifiedConfig(TARGET_CPA, false);
      if (!verified) throw new Error("请先配置 CPA 后再补全凭证");
      const {
        files,
        failedCount: cpaFailed,
        cancelled: cpaCancelled,
      } = await fetchAllCpaRemoteAuthContents(uniqueCpaNames, {
        signal,
        cancelChecker: throwIfRemoteImportCancelled,
        onProgress: ({ chunkIndex, chunkTotal, okCount: done }) => {
          setRemoteImportStatus(
            `正在补全 CPA 凭证第 ${chunkIndex}/${chunkTotal} 批，累计 ${done} 个`,
            "info"
          );
        },
      });
      if (cpaCancelled) cancelled = true;
      failedCount += cpaFailed;
      const gotNames = new Set();
      for (const file of files) {
        const name = String(file?.name || "");
        if (!name || file?.content == null) continue;
        gotNames.add(name);
        const parsed = itemFromRemoteCpaContent(name, file.content);
        const full = parsed.find((row) => row && !row.error && row.account);
        const targets = cpaItemsByName.get(name) || [];
        if (!full) {
          failedCount += targets.length || 1;
          for (const item of targets) {
            item.error = "补全凭证失败：内容无法识别";
          }
          continue;
        }
        for (const item of targets) {
          if (applyHydratedAccountToItem(item, full.account)) okCount += 1;
          else {
            failedCount += 1;
            item.error = "补全凭证失败：无法应用到列表项";
          }
        }
      }
      for (const name of uniqueCpaNames) {
        if (gotNames.has(name)) continue;
        for (const item of cpaItemsByName.get(name) || []) {
          if (itemNeedsHydration(item)) {
            item.error = item.error || "补全凭证失败";
          }
        }
      }
    }

    if (!cancelled && uniqueSub2Ids.length) {
      const verified = await ensureVerifiedConfig(TARGET_SUB2API, false);
      if (!verified) throw new Error("请先配置 SUB2API 后再补全凭证");
      const {
        accountById,
        failedCount: sub2Failed,
        hardError: sub2HardError,
        cancelled: sub2Cancelled,
      } = await fetchAllSub2RemoteAccounts(uniqueSub2Ids, {
        signal,
        cancelChecker: throwIfRemoteImportCancelled,
        onProgress: ({ chunkIndex, chunkTotal, okCount: done }) => {
          setRemoteImportStatus(
            `正在补全 SUB2API 凭证第 ${chunkIndex}/${chunkTotal} 批，累计 ${done} 个`,
            "info"
          );
        },
      });
      if (sub2Cancelled) cancelled = true;
      failedCount += sub2Failed;
      if (sub2HardError) hardError = sub2HardError;
      const stepUpBlocked =
        hardError?.code === "SUB2API_STEP_UP_REQUIRED" ||
        hardError?.data?.code === "SUB2API_STEP_UP_REQUIRED" ||
        hardError?.code === "SUB2API_TOTP_ENABLED" ||
        hardError?.data?.code === "SUB2API_TOTP_ENABLED" ||
        /totp|step[_ -]?up|two-factor|二次验证/i.test(String(hardError?.message || ""));
      if (stepUpBlocked) {
        const detail =
          apiErrorMessage(hardError) ||
          "源端 SUB2API 已开启二次验证，Admin API Key 无法导出完整凭证";
        throw Object.assign(new Error(detail), {
          code: hardError?.code || "SUB2API_STEP_UP_REQUIRED",
          data: hardError?.data,
        });
      }
      for (const id of uniqueSub2Ids) {
        const key = String(id);
        const account = accountById.get(key);
        const targets = sub2ItemsById.get(key) || [];
        if (!account) {
          failedCount += targets.length || 1;
          for (const item of targets) {
            if (itemNeedsHydration(item)) item.error = item.error || "补全凭证失败";
          }
          continue;
        }
        for (const item of targets) {
          if (applyHydratedAccountToItem(item, account)) okCount += 1;
          else {
            failedCount += 1;
            item.error = "补全凭证失败：无法应用到列表项";
          }
        }
      }
    }

    refreshPendingRemoteHydrationFlag();
    converted = items.some((item) => item.converted);
    renderTable();
    scheduleWorkspaceSave({ immediate: true });

    if (cancelled) {
      setRemoteImportStatus(
        `已取消补全，成功 ${okCount} 个` + (failedCount ? `，失败 ${failedCount} 个` : ""),
        "info"
      );
    } else if (failedCount && !okCount) {
      setRemoteImportStatus(`补全凭证失败 ${failedCount} 个`, "err");
    } else if (failedCount) {
      setRemoteImportStatus(
        `已补全 ${okCount} 个，失败 ${failedCount} 个`,
        allowPartial ? "info" : "err"
      );
    } else {
      setRemoteImportStatus(`已补全 ${okCount} 个账号凭证`, "ok");
    }

    return {
      okCount,
      failedCount,
      cancelled,
      pending: pending.length,
      hardError,
    };
  } finally {
    if (ownBusy) {
      remoteImportAbortController = null;
      remoteImportCancelRequested = false;
      setRemoteImportBusy(false);
      refreshRemoteImportUi();
    }
  }
}

async function pullRemoteAccountList() {
  if (remoteImportBusy) return;
  if (uploadBusy) {
    setRemoteImportStatus("上传进行中，请先取消或等待完成后再拉取", "err", {
      toast: true,
    });
    return;
  }
  if (exportBusy) {
    setRemoteImportStatus("导出进行中，请先等待完成后再拉取", "err", { toast: true });
    return;
  }
  if (cpaRemoteBusy || sub2RemoteBusy || sub2DedupeBusy) {
    setRemoteImportStatus("其他远端任务进行中，请稍后再拉取", "err", { toast: true });
    return;
  }

  const sourceTarget = normalizeRemoteSourceTarget(remoteSourceTarget);
  const verified = await ensureVerifiedConfig(sourceTarget, false);
  if (!verified) {
    setRemoteImportStatus(`请先配置源端 ${sourceTarget} 后再拉取`, "err", { toast: true });
    refreshRemoteImportUi();
    return;
  }

  remoteImportCancelRequested = false;
  remoteImportAbortController = new AbortController();
  setRemoteImportBusy(true);
  clearMsg();
  refreshRemoteImportUi();

  try {
    if (sourceTarget === TARGET_CPA) {
      setRemoteImportStatus("正在拉取 CPA 认证文件列表", "info");
      const files = await listCpaRemoteFilesMeta(remoteImportAbortController.signal);
      throwIfRemoteImportCancelled();
      if (!files.length) {
        setRemoteImportStatus("源端 CPA 没有可拉取的认证文件", "info", { toast: true });
        return;
      }
      const incoming = stubsFromCpaRemoteFiles(files);
      const result = await commitIncomingItems(incoming, {
        sourceLabel: "CPA",
        emptyMessage: "从 CPA 未解析到可用账号",
        allowDuringRemoteImport: true,
        lockDirectionAfter: TARGET_CPA,
      });
      if (!result) {
        setRemoteImportStatus("已取消写入主列表", "info", { toast: true });
        return;
      }
      const msg = formatCommitMessage(result, [
        `已从 CPA 快载 ${incoming.length} 个账号`,
        "完整凭证将在转换或上传时获取",
      ]);
      setRemoteImportStatus(msg, "ok", { toast: true, toastMs: 4200 });
      showToast("已按远端来源锁定为全部 → SUB2API", "ok", 3600);
      return;
    }

    setRemoteImportStatus("正在拉取 SUB2API 账号列表", "info");
    const accounts = await listSub2RemoteAccountsMeta(remoteImportAbortController.signal);
    throwIfRemoteImportCancelled();
    if (!accounts.length) {
      setRemoteImportStatus("源端 SUB2API 没有可拉取的账号", "info", { toast: true });
      return;
    }
    const incoming = itemsFromSub2RemoteAccounts(accounts, { asStub: true });
    const result = await commitIncomingItems(incoming, {
      sourceLabel: "SUB2API",
      emptyMessage: "从 SUB2API 未解析到可用账号",
      allowDuringRemoteImport: true,
      lockDirectionAfter: TARGET_SUB2API,
    });
    if (!result) {
      setRemoteImportStatus("已取消写入主列表", "info", { toast: true });
      return;
    }
    const msg = formatCommitMessage(result, [
      `已从 SUB2API 快载 ${incoming.length} 个账号`,
      "完整凭证将在转换或上传时获取",
    ]);
    setRemoteImportStatus(msg, "ok", { toast: true, toastMs: 4200 });
    showToast("已按远端来源锁定为全部 → CPA", "ok", 3600);
  } catch (error) {
    if (error?.name === "RemoteCancelledError" || remoteImportCancelRequested) {
      setRemoteImportStatus("已取消拉取", "info", { toast: true });
    } else {
      const detail = apiErrorMessage(error);
      setRemoteImportStatus(`拉取失败：${detail}`, "err", { toast: true });
    }
  } finally {
    remoteImportAbortController = null;
    remoteImportCancelRequested = false;
    setRemoteImportBusy(false);
    refreshRemoteImportUi();
  }
}
