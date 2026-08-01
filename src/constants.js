export const COOKIE_NAME = "converter_session";
export const DEFAULT_SESSION_TTL_HOURS = 168;

// 单批数量：代码默认 / 绝对上限默认（均可被环境变量覆盖）
export const DEFAULT_MAX_SUB2API_ACCOUNTS = 100;
export const DEFAULT_MAX_CPA_FILES = 20;
export const DEFAULT_ABSOLUTE_MAX_SUB2API_ACCOUNTS = 5000;
export const DEFAULT_ABSOLUTE_MAX_CPA_FILES = 500;
// 导入单批平台天花板（最高上限）
export const HARD_MAX_BATCH_SUB2API = 50000;
export const HARD_MAX_BATCH_CPA = 50000;

// 远端导出 / 下载 / 去重删除：代码默认 / 绝对上限默认（均可被环境变量覆盖）
export const DEFAULT_MAX_CPA_AUTH_DOWNLOAD_FILES = 500;
export const DEFAULT_ABSOLUTE_MAX_CPA_AUTH_DOWNLOAD_FILES = 2000;
export const HARD_MAX_CPA_AUTH_DOWNLOAD_FILES = 50000;
export const DEFAULT_MAX_SUB2API_EXPORT_ACCOUNTS = 500;
export const DEFAULT_ABSOLUTE_MAX_SUB2API_EXPORT_ACCOUNTS = 2000;
export const HARD_MAX_SUB2API_EXPORT_ACCOUNTS = 50000;
export const DEFAULT_MAX_SUB2API_DEDUPE_IDS = 5000;
export const DEFAULT_ABSOLUTE_MAX_SUB2API_DEDUPE_IDS = 10000;
export const HARD_MAX_SUB2API_DEDUPE_IDS = 50000;

// 上传并发
export const DEFAULT_MAX_UPLOAD_CONCURRENCY_SUB2API = 3;
export const DEFAULT_MAX_UPLOAD_CONCURRENCY_CPA = 8;
export const DEFAULT_ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API = 50;
export const DEFAULT_ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA = 150;
export const HARD_MAX_UPLOAD_CONCURRENCY = 1000;

// 上传重试次数（含首次）
export const DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS = 3;
export const DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS = 3;
export const DEFAULT_ABSOLUTE_MAX_UPLOAD_ATTEMPTS = 10;
export const HARD_MAX_UPLOAD_ATTEMPTS = 30;

export const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
export const VERIFY_TIMEOUT_MS = 30 * 1000;

/** 代理 id→key 映射缓存 TTL：默认 30 分钟，覆盖大批量多批上传；可用 PROXY_MAP_CACHE_TTL_SECONDS 覆盖 */
export const DEFAULT_PROXY_MAP_CACHE_TTL_SECONDS = 1800;
export const MIN_PROXY_MAP_CACHE_TTL_SECONDS = 60;
export const MAX_PROXY_MAP_CACHE_TTL_SECONDS = 86400;

export const DEDUPE_PAGE_SIZE = 200;
export const DEDUPE_SCAN_CONCURRENCY = 4;
export const DEDUPE_DELETE_CONCURRENCY = 4;
export const CPA_DOWNLOAD_CONCURRENCY = 4;
export const DEDUPE_NORMAL_STATUSES = new Set([
  "active",
  "normal",
  "enabled",
  "ok",
  "running",
  "success",
  "valid",
  "healthy",
  "1",
  "true",
]);
