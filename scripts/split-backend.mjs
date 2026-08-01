import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const srcPath = path.join(root, "src", "index.js");
const lines = fs.readFileSync(srcPath, "utf8").split(/\r?\n/);

function sliceLines(start, end) {
  return lines.slice(start - 1, end).join("\n");
}

function exportify(body) {
  return body
    .split("\n")
    .map((line) => {
      if (/^async function /.test(line)) return `export ${line}`;
      if (/^function /.test(line)) return `export ${line}`;
      if (/^class /.test(line)) return `export ${line}`;
      if (/^const [A-Za-z_$]/.test(line)) return `export ${line}`;
      return line;
    })
    .join("\n");
}

function write(rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (!content.endsWith("\n")) content += "\n";
  fs.writeFileSync(full, content, "utf8");
  console.log(`wrote ${rel}: ${content.split("\n").length - 1} lines`);
}

write("src/errors.js", exportify(sliceLines(63, 71)));
write("src/constants.js", exportify(sliceLines(19, 61)));

write(
  "src/limits.js",
  `import { HttpError } from "./errors.js";
import {
  DEFAULT_MAX_SUB2API_ACCOUNTS,
  DEFAULT_MAX_CPA_FILES,
  DEFAULT_ABSOLUTE_MAX_SUB2API_ACCOUNTS,
  DEFAULT_ABSOLUTE_MAX_CPA_FILES,
  HARD_MAX_BATCH_SUB2API,
  HARD_MAX_BATCH_CPA,
  DEFAULT_MAX_CPA_AUTH_DOWNLOAD_FILES,
  DEFAULT_ABSOLUTE_MAX_CPA_AUTH_DOWNLOAD_FILES,
  HARD_MAX_CPA_AUTH_DOWNLOAD_FILES,
  DEFAULT_MAX_SUB2API_EXPORT_ACCOUNTS,
  DEFAULT_ABSOLUTE_MAX_SUB2API_EXPORT_ACCOUNTS,
  HARD_MAX_SUB2API_EXPORT_ACCOUNTS,
  DEFAULT_MAX_SUB2API_DEDUPE_IDS,
  DEFAULT_ABSOLUTE_MAX_SUB2API_DEDUPE_IDS,
  HARD_MAX_SUB2API_DEDUPE_IDS,
  DEFAULT_MAX_UPLOAD_CONCURRENCY_SUB2API,
  DEFAULT_MAX_UPLOAD_CONCURRENCY_CPA,
  DEFAULT_ABSOLUTE_MAX_UPLOAD_CONCURRENCY_SUB2API,
  DEFAULT_ABSOLUTE_MAX_UPLOAD_CONCURRENCY_CPA,
  HARD_MAX_UPLOAD_CONCURRENCY,
  DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS,
  DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS,
  DEFAULT_ABSOLUTE_MAX_UPLOAD_ATTEMPTS,
  HARD_MAX_UPLOAD_ATTEMPTS,
} from "./constants.js";

${exportify(sliceLines(317, 654))}
`
);

write("src/responses.js", exportify(sliceLines(3381, 3499)));

write(
  "src/http.js",
  `import { HttpError } from "./errors.js";
import { UPSTREAM_TIMEOUT_MS } from "./constants.js";

${exportify(`${sliceLines(3135, 3379)}\n${sliceLines(3501, 3503)}`)}
`
);

write(
  "src/auth.js",
  `import { COOKIE_NAME, DEFAULT_SESSION_TTL_HOURS } from "./constants.js";
import { HttpError } from "./errors.js";
import { htmlResponse, renderLoginPage, securityHeaders } from "./responses.js";

${exportify(sliceLines(656, 811))}
`
);

write(
  "src/config.js",
  `import { HttpError } from "./errors.js";
import { VERIFY_TIMEOUT_MS } from "./constants.js";
import { firstEnv } from "./limits.js";
import { cpaRequest, sub2apiRequest } from "./http.js";

${exportify(sliceLines(813, 1010))}
`
);

write(
  "src/proxy-cache.js",
  `import { HttpError } from "./errors.js";
import {
  DEFAULT_PROXY_MAP_CACHE_TTL_SECONDS,
  MIN_PROXY_MAP_CACHE_TTL_SECONDS,
  MAX_PROXY_MAP_CACHE_TTL_SECONDS,
} from "./constants.js";
import { firstEnv, parsePositiveIntText } from "./limits.js";
import { resolveTargetConfig } from "./config.js";
import { sub2apiRequest } from "./http.js";
import { parseProxyId } from "./shared/account-convert.js";

${exportify(sliceLines(1012, 1414))}
`
);

write(
  "src/sub2api/accounts.js",
  `import { resolveTargetConfig } from "../config.js";
import { sub2apiRequest } from "../http.js";
import { HttpError } from "../errors.js";
import { summarizeDedupeAccount } from "./dedupe.js";

${exportify(`${sliceLines(1416, 1532)}\n${sliceLines(2409, 2421)}`)}
`
);

write(
  "src/sub2api/dedupe.js",
  `import { resolveTargetConfig } from "../config.js";
import { listAllSub2apiAccounts } from "./accounts.js";
import { sub2apiRequest, mapWithConcurrency } from "../http.js";
import { HttpError } from "../errors.js";
import { isExpiredUnix, resolveExpiresAtFromAccount } from "../shared/account-convert.js";

${exportify(sliceLines(1534, 1761))}
`
);

write(
  "src/cpa/auth-files.js",
  `import { resolveTargetConfig } from "../config.js";
import { cpaRequest, cpaRequestRaw, mapWithConcurrency } from "../http.js";
import { HttpError } from "../errors.js";

${exportify(sliceLines(1763, 1972))}
`
);

write(
  "src/sub2api/export.js",
  `import { resolveTargetConfig } from "../config.js";
import { sub2apiRequest, mapWithConcurrency } from "../http.js";
import { HttpError } from "../errors.js";
import { listAllSub2apiAccounts } from "./accounts.js";

${exportify(`${sliceLines(1974, 2407)}\n${sliceLines(2423, 2602)}`)}
`
);

write(
  "src/upload.js",
  `import { resolveTargetConfig } from "./config.js";
import {
  getSub2apiProxyIdKeyMap,
  accountsNeedProxyMap,
  rewriteAccountsProxyIdToKey,
} from "./proxy-cache.js";
import { sub2apiRequest, cpaRequest, mapWithConcurrency } from "./http.js";

${exportify(sliceLines(3006, 3133))}
`
);

write(
  "src/transfer.js",
  `import {
  TARGET_CPA,
  TARGET_SUB2API,
  convertAccountTo,
  normalizeConvertOptions,
  normalizeTargetFormat,
  summarizeAccountForResult,
} from "./shared/account-convert.js";
import { HttpError } from "./errors.js";
import { extractConfigOverride } from "./config.js";
import { downloadCpaAuthFiles } from "./cpa/auth-files.js";
import { exportSub2apiAccounts } from "./sub2api/export.js";
import { uploadCpaFiles, uploadSub2api } from "./upload.js";
import {
  maxCpaAuthDownloadFiles,
  maxCpaFiles,
  maxSub2apiAccounts,
  maxSub2apiExportAccounts,
  resolveRequestedAttempts,
  maxSub2apiUploadAttempts,
  maxCpaUploadAttempts,
} from "./limits.js";
import {
  DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS,
  DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS,
} from "./constants.js";

${exportify(sliceLines(2604, 3004))}
`
);

write(
  "src/router.js",
  `import {
  getAccessSetupProblem,
  buildPublicLimits,
  maxSub2apiAccounts,
  maxCpaFiles,
  maxCpaAuthDownloadFiles,
  maxSub2apiExportAccounts,
  maxSub2apiDedupeIds,
  maxSub2apiUploadAttempts,
  maxCpaUploadAttempts,
  resolveRequestedAttempts,
} from "./limits.js";
import {
  handleLogin,
  isAuthenticated,
  assertTrustedMutation,
  clearSessionCookie,
  sessionTtlHours,
} from "./auth.js";
import {
  htmlResponse,
  jsonResponse,
  withSecurityHeaders,
  renderSetupPage,
  renderLoginPage,
  securityHeaders,
} from "./responses.js";
import {
  publicTargetStatus,
  normalizeTarget,
  extractConfigOverride,
  verifyTarget,
} from "./config.js";
import { uploadSub2api, uploadCpaFiles } from "./upload.js";
import { listSub2apiProxies } from "./proxy-cache.js";
import { scanSub2apiDuplicates, applySub2apiDedupe } from "./sub2api/dedupe.js";
import { listCpaAuthFiles, downloadCpaAuthFiles } from "./cpa/auth-files.js";
import { listSub2apiAccountsMeta } from "./sub2api/accounts.js";
import { exportSub2apiAccounts } from "./sub2api/export.js";
import { transferRemoteBatch } from "./transfer.js";
import { readJsonBody } from "./http.js";
import { HttpError } from "./errors.js";
import {
  DEFAULT_MAX_SUB2API_UPLOAD_ATTEMPTS,
  DEFAULT_MAX_CPA_UPLOAD_ATTEMPTS,
} from "./constants.js";

${exportify(sliceLines(87, 315))}
`
);

write(
  "src/index.js",
  `import { handleRequest } from "./router.js";
import { errorResponse, htmlResponse, renderErrorPage } from "./responses.js";

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Unhandled error", error?.stack || error);
      if (new URL(request.url).pathname.startsWith("/api/")) {
        return errorResponse(error);
      }
      return htmlResponse(renderErrorPage(error), error?.status || 500);
    }
  },
};
`
);

console.log("backend split complete");
