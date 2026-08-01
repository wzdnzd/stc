var AccountConvert = window.AccountConvert;
if (!AccountConvert) {
  throw new Error("共享转换模块 /shared/account-convert.js 未加载");
}
var CLIENT_ID = AccountConvert.CLIENT_ID;
var REDIRECT_URI = AccountConvert.REDIRECT_URI;
var TOKEN_ENDPOINT = AccountConvert.TOKEN_ENDPOINT;
var BASE_URL = AccountConvert.BASE_URL;
var DEFAULT_HEADERS = { ...AccountConvert.DEFAULT_HEADERS };

/** @type {Array<{id:string,sourceFile:string,sourceFormat:string,account:any,error?:string,converted?:any,targetFormat?:string,selected:boolean,accountStatus:string,expiresAt:number|null,proxyId:number|null,proxyValid:boolean|null,uploadStatus:string,uploadTarget:string,uploadMessage:string,uploadAttempts:number}>} */
var items = [];
var converted = false;
var selectionMode = false;
var searchVisible = false;
var tableSearch = "";
/** @type {{key:string, dir:"asc"|"desc"}} */
var tableSort = { key: "", dir: "asc" };
var uploadBusy = false;
var activeUploadTarget = "";
var uploadAbortController = null;
var uploadCancelRequested = false;
var runtimeTargetStatus = null;
var activeUploadItemIds = null;
var configDialogTarget = "SUB2API";
var configDialogResolver = null;
var configDialogMode = "manage"; // manage | ensure
/** @type {string|null} */
var proxyEditingItemId = null;
/** @type {number[]} 仅缓存服务器上存在的代理 ID */
var cachedSub2ProxyIds = [];
/** @type {Set<number>} */
var cachedSub2ProxyIdSet = new Set();
/** @type {((action:string)=>void)|null} */
var proxyValidateResolver = null;
/** @type {string[]} */
var proxyValidateInvalidIds = [];
/** @type {any|null} SUB2API 去重扫描结果 */
var sub2DedupeScan = null;
var sub2DedupeBusy = false;
/** @type {"review"|"done"|null} */
var sub2DedupePhase = null;

/** CPA 远端下载：列表与勾选 */
var cpaRemoteFiles = [];
/** @type {Set<string>} */
var cpaRemoteSelected = new Set();
/** @type {Map<string, "ok"|"err">} 最近一次下载逐项结果 */
var cpaRemoteResultByName = new Map();
var cpaRemoteSearch = "";
var cpaRemoteFailedOnly = false;
var cpaRemoteBusy = false;
/** @type {""|"list"|"download"} */
var cpaRemotePhase = "";
/** @type {AbortController|null} */
var cpaRemoteAbortController = null;
var cpaRemoteCancelRequested = false;

/** SUB2API 远端导出：列表与勾选 */
var sub2RemoteAccounts = [];
/** @type {Set<string>} */
var sub2RemoteSelected = new Set();
/** @type {Map<string, "ok"|"err">} 最近一次导出逐项结果 */
var sub2RemoteResultById = new Map();
var sub2RemoteSearch = "";
var sub2RemoteFailedOnly = false;
var sub2RemoteBusy = false;
/** @type {""|"list"|"export"} */
var sub2RemotePhase = "";
/** @type {AbortController|null} */
var sub2RemoteAbortController = null;
var sub2RemoteCancelRequested = false;

var DEFAULT_BATCH_SUB2API = 100;
var DEFAULT_BATCH_CPA = 20;
var DEFAULT_UPLOAD_CONCURRENCY = 1;
var DEFAULT_UPLOAD_ATTEMPTS = 3;
var DEFAULT_SUB2_AMBIGUOUS_RETRY = "none";
var DEFAULT_SKIP_EXPIRED_ACCOUNTS = "skip";
var FALLBACK_MAX_SUB2API = 100;
var FALLBACK_MAX_CPA = 20;
var FALLBACK_MAX_UPLOAD_CONCURRENCY_SUB2 = 3;
var FALLBACK_MAX_UPLOAD_CONCURRENCY_CPA = 8;
var FALLBACK_MAX_UPLOAD_ATTEMPTS = 3;
var FALLBACK_MAX_CPA_AUTH_DOWNLOAD = 500;
var FALLBACK_MAX_SUB2API_EXPORT = 500;
var FALLBACK_MAX_SUB2API_DEDUPE = 5000;
/** 远端勾选列表最多同时渲染的行数，避免成千上万 DOM 卡死 */
var REMOTE_PICKER_RENDER_LIMIT = 300;
/** 前端分批调用 Worker 的默认块大小，实际会再钳到 serverLimits */
var REMOTE_EXPORT_CHUNK_DEFAULT = 200;
var REMOTE_CPA_DOWNLOAD_CHUNK_DEFAULT = 100;
var LOCAL_CONFIG_STORAGE_KEY = "cpa2sub.targetConfig.v1";
var LOCAL_UI_SETTINGS_KEY = "cpa2sub.uiSettings.v1";
var WORKSPACE_DB_NAME = "cpa2sub.workspace";
var WORKSPACE_DB_VERSION = 1;
var WORKSPACE_STORE = "snapshots";
var WORKSPACE_KEY = "current";
var WORKSPACE_SCHEMA_VERSION = 1;
var serverLimits = {
  maxSub2apiAccounts: FALLBACK_MAX_SUB2API,
  maxCpaFiles: FALLBACK_MAX_CPA,
  maxUploadConcurrencySub2api: FALLBACK_MAX_UPLOAD_CONCURRENCY_SUB2,
  maxUploadConcurrencyCpa: FALLBACK_MAX_UPLOAD_CONCURRENCY_CPA,
  maxSub2apiUploadAttempts: FALLBACK_MAX_UPLOAD_ATTEMPTS,
  maxCpaUploadAttempts: FALLBACK_MAX_UPLOAD_ATTEMPTS,
  maxCpaAuthDownloadFiles: FALLBACK_MAX_CPA_AUTH_DOWNLOAD,
  maxSub2apiExportAccounts: FALLBACK_MAX_SUB2API_EXPORT,
  maxSub2apiDedupeIds: FALLBACK_MAX_SUB2API_DEDUPE,
};
var uiSettingsSaveTimer = null;
var adaptiveUploadConcurrency = 1;
var uploadCooldownUntil = 0;
/** @type {IDBDatabase|null} */
var workspaceDb = null;
var workspaceSaveTimer = null;
var workspaceSaveChain = Promise.resolve();
var workspaceHydrating = false;
var workspaceDirty = false;
/** @type {any|null} 启动时读到的快照；用户处理前不自动灌入列表 */
var pendingWorkspaceSnapshot = null;
/** @type {{target:string, itemIds:string[]|null}|null} 恢复后仍可续传的任务元信息 */
var restoredJobMeta = null;
/** @type {((action:string)=>void)|null} */
var importConflictResolver = null;
/** @type {((result:{ok:boolean, includeUnknown:boolean})=>void)|null} */
var resumeUploadResolver = null;
var beforeUnloadBound = false;

var TARGET_SUB2API = "SUB2API";
var TARGET_CPA = "CPA";
var UPLOAD_STATUS = Object.freeze({
  NONE: "not-uploaded",
  QUEUED: "queued",
  UPLOADING: "uploading",
  SUCCESS: "success",
  FAILED: "failed",
  UNKNOWN: "unknown",
  CANCELLED: "cancelled",
});
var EXPORT_STATUS = Object.freeze({
  NONE: "not-exported",
  PREPARING: "preparing",
  SUCCESS: "exported",
  FAILED: "failed",
});
var ACCOUNT_STATUS = Object.freeze({
  VALID: "valid",
  EXPIRED: "expired",
  UNKNOWN: "unknown",
});
var RESUMABLE_UPLOAD_STATUSES = new Set([
  UPLOAD_STATUS.NONE,
  UPLOAD_STATUS.QUEUED,
  UPLOAD_STATUS.FAILED,
  UPLOAD_STATUS.CANCELLED,
]);

/** 导入模式：本地文件 | 远端服务器 */
var importMode = "local";
/** 远端源服务器：SUB2API | CPA */
var remoteSourceTarget = TARGET_CPA;
var remoteImportBusy = false;
/** @type {AbortController|null} */
var remoteImportAbortController = null;
var remoteImportCancelRequested = false;
/** 远端加载后锁定转换方向 */
var directionLockedByRemote = false;
/** 当前主列表中是否含待补全凭证的远端账号 */
var hasPendingRemoteHydration = false;
/** @type {Set<string>|null} 当前导出操作涉及的 item id */
var activeExportItemIds = null;
var exportBusy = false;
