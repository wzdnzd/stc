/* CPA ↔ SUB2API 转换共享模块（浏览器）。由 src/shared/account-convert.js 同步生成，请勿手改逻辑。 */
(function (global) {
  "use strict";
  /**
   * CPA ↔ SUB2API 账号转换与规范化（前后端共用）
   * - Worker：ESM import
   * - 浏览器：由 public/shared/account-convert.js 同步暴露为 window.AccountConvert
   */

  const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
  const REDIRECT_URI = "http://127.0.0.1:56121/callback";
  const TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
  const BASE_URL = "https://cli-chat-proxy.grok.com/v1";
  const DEFAULT_HEADERS = Object.freeze({
    "User-Agent": "grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-identifier": "grok-pager",
    "x-grok-client-version": "0.2.93",
  });

  const TARGET_SUB2API = "SUB2API";
  const TARGET_CPA = "CPA";

  const DEFAULT_CONVERT_OPTIONS = Object.freeze({
    nameStrategy: "email",
    concurrency: 1,
    priority: 1,
    rateMultiplier: 1,
    autoPauseOnExpired: true,
    defaultProxyId: null,
    keepSso: true,
    keepHeaders: true,
    preserveExtra: false,
  });

  function b64urlDecode(seg) {
    if (!seg || typeof seg !== "string") return "";
    const s = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
    try {
      if (typeof atob === "function") {
        try {
          return decodeURIComponent(
            Array.from(atob(pad), (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(
              ""
            )
          );
        } catch {
          return atob(pad);
        }
      }
      // Worker / Node 回退；浏览器走 atob
      if (typeof globalThis.Buffer !== "undefined") {
        return globalThis.Buffer.from(pad, "base64").toString("utf8");
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  function decodeJwtPayload(token) {
    if (!token || typeof token !== "string" || token.split(".").length < 2) return {};
    try {
      return JSON.parse(b64urlDecode(token.split(".")[1]));
    } catch {
      return {};
    }
  }

  function isoFromUnix(sec) {
    if (sec == null || sec === "") return "";
    const n = Number(sec);
    if (!Number.isFinite(n)) return "";
    return new Date(n * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function unixFromIsoOrNumber(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number" && Number.isFinite(v)) {
      return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    }
    const s = String(v).trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n > 1e12 ? Math.floor(n / 1000) : n;
    }
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    return Math.floor(t / 1000);
  }

  function parseProxyId(value) {
    if (value == null) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
    return n;
  }

  function extractProxyIdFromAccount(account) {
    if (!account || typeof account !== "object") return null;
    return parseProxyId(account.proxy_id ?? account.proxyId ?? null);
  }

  function applyProxyIdToAccountPayload(account, proxyId) {
    if (!account || typeof account !== "object") return account;
    if (proxyId == null) {
      delete account.proxy_id;
      return account;
    }
    account.proxy_id = proxyId;
    return account;
  }

  function safeFilename(s) {
    const t = String(s || "unknown").trim() || "unknown";
    return t.replace(/[^a-zA-Z0-9._@-]/g, "_");
  }

  function cpaFilename(record) {
    const ident = String(record?.email || record?.sub || "unknown").trim() || "unknown";
    const safe = safeFilename(ident);
    const base = safe.toLowerCase().startsWith("xai") ? safe : `xai-${safe}`;
    return `${base}.json`;
  }

  function isCpaRecord(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    if (obj.type === "xai") return true;
    if (obj.auth_kind === "oauth" && (obj.access_token || obj.refresh_token)) return true;
    if (
      obj.access_token &&
      obj.refresh_token &&
      !obj.credentials &&
      !obj.accounts &&
      !obj.platform
    ) {
      return true;
    }
    return false;
  }

  function isSub2Account(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    if (obj.platform === "grok" || obj.platform === "xai") return true;
    if (obj.credentials && (obj.credentials.access_token || obj.credentials.refresh_token)) {
      return true;
    }
    return false;
  }

  function isSub2Export(obj) {
    return obj && typeof obj === "object" && Array.isArray(obj.accounts);
  }

  function normalizeConvertOptions(raw = {}) {
    const src = raw && typeof raw === "object" ? raw : {};
    const nameStrategy = ["email", "local", "sub"].includes(String(src.nameStrategy || ""))
      ? String(src.nameStrategy)
      : DEFAULT_CONVERT_OPTIONS.nameStrategy;
    const concurrency = Math.max(
      1,
      Math.floor(
        Number(src.concurrency ?? src.accountConcurrency) || DEFAULT_CONVERT_OPTIONS.concurrency
      )
    );
    const priority = Math.max(
      0,
      Math.floor(Number(src.priority ?? src.accountPriority) || DEFAULT_CONVERT_OPTIONS.priority)
    );
    const rateMultiplierRaw = Number(
      src.rateMultiplier ?? src.rate_multiplier ?? DEFAULT_CONVERT_OPTIONS.rateMultiplier
    );
    const rateMultiplier = Number.isFinite(rateMultiplierRaw)
      ? rateMultiplierRaw
      : DEFAULT_CONVERT_OPTIONS.rateMultiplier;
    const autoPauseOnExpired = src.autoPauseOnExpired ?? src.auto_pause_on_expired ?? src.autoPause;
    const keepSso = src.keepSso ?? src.keep_sso;
    const keepHeaders = src.keepHeaders ?? src.keep_headers;
    const preserveExtra = src.preserveExtra === true || src.preserve_extra === true;
    const defaultProxyId = parseProxyId(
      src.defaultProxyId ?? src.default_proxy_id ?? src.proxyId ?? src.proxy_id
    );
    const proxyId = parseProxyId(src.proxyId ?? src.proxy_id);

    return {
      nameStrategy,
      concurrency,
      priority,
      rateMultiplier,
      autoPauseOnExpired:
        autoPauseOnExpired == null
          ? DEFAULT_CONVERT_OPTIONS.autoPauseOnExpired
          : Boolean(autoPauseOnExpired),
      keepSso: keepSso == null ? DEFAULT_CONVERT_OPTIONS.keepSso : Boolean(keepSso),
      keepHeaders: keepHeaders == null ? DEFAULT_CONVERT_OPTIONS.keepHeaders : Boolean(keepHeaders),
      preserveExtra,
      defaultProxyId,
      proxyId,
    };
  }

  function normalizeCpa(raw) {
    if (!raw || typeof raw !== "object") {
      throw new Error("CPA 账号无效");
    }
    const access = raw.access_token || raw.key || "";
    const refresh = raw.refresh_token || "";
    const idToken = raw.id_token || "";
    const payload = decodeJwtPayload(access);
    const idPayload = decodeJwtPayload(idToken);
    const email = raw.email || idPayload.email || payload.email || "";
    const sub = raw.sub || payload.sub || idPayload.sub || "";
    let expired = raw.expired || "";
    if (!expired && payload.exp) expired = isoFromUnix(payload.exp);
    if (!expired && raw.expires_in != null) {
      expired = isoFromUnix(Math.floor(Date.now() / 1000) + Number(raw.expires_in));
    }
    return {
      type: "xai",
      auth_kind: raw.auth_kind || "oauth",
      email,
      sub,
      access_token: access,
      refresh_token: refresh,
      id_token: idToken,
      token_type: raw.token_type || "Bearer",
      expires_in: raw.expires_in ?? null,
      expired,
      last_refresh: raw.last_refresh || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      redirect_uri: raw.redirect_uri || REDIRECT_URI,
      token_endpoint: raw.token_endpoint || TOKEN_ENDPOINT,
      base_url: raw.base_url || BASE_URL,
      disabled: !!raw.disabled,
      headers:
        raw.headers && typeof raw.headers === "object" ? raw.headers : { ...DEFAULT_HEADERS },
      sso: raw.sso || "",
      _scope: payload.scope || "",
      _client_id: payload.aud || payload.client_id || CLIENT_ID,
      _exp: payload.exp || unixFromIsoOrNumber(expired),
    };
  }

  function normalizeSub2(raw) {
    if (!raw || typeof raw !== "object") {
      throw new Error("SUB2API 账号无效");
    }
    const cred = raw.credentials || {};
    const access = cred.access_token || "";
    const refresh = cred.refresh_token || "";
    const idToken = cred.id_token || "";
    const payload = decodeJwtPayload(access);
    const idPayload = decodeJwtPayload(idToken);
    const email =
      cred.email ||
      (raw.extra && raw.extra.email) ||
      idPayload.email ||
      payload.email ||
      raw.name ||
      "";
    const expiresAt =
      unixFromIsoOrNumber(cred.expires_at) || (payload.exp ? Number(payload.exp) : null);
    const normalized = {
      name: raw.name || email || "",
      platform: raw.platform || "grok",
      type: raw.type || "oauth",
      credentials: {
        access_token: access,
        base_url: cred.base_url || BASE_URL,
        client_id: cred.client_id || payload.aud || payload.client_id || CLIENT_ID,
        email,
        expires_at: expiresAt,
        id_token: idToken,
        refresh_token: refresh,
        scope: cred.scope || payload.scope || "",
        token_type: cred.token_type || "Bearer",
      },
      extra: raw.extra && typeof raw.extra === "object" ? { ...raw.extra } : { email },
      concurrency: raw.concurrency ?? 1,
      priority: raw.priority ?? 1,
      rate_multiplier: raw.rate_multiplier ?? 1,
      auto_pause_on_expired: raw.auto_pause_on_expired !== false,
      _sub: payload.sub || idPayload.sub || "",
      _sso: (raw.extra && raw.extra.sso) || raw.sso || "",
      _headers: (raw.extra && raw.extra.headers) || null,
      _redirect_uri: (raw.extra && raw.extra.redirect_uri) || "",
      _token_endpoint: (raw.extra && raw.extra.token_endpoint) || "",
      _expires_in: payload.exp && payload.iat ? Number(payload.exp) - Number(payload.iat) : null,
      _last_refresh: (raw.extra && raw.extra.last_refresh) || "",
    };
    const proxyId = extractProxyIdFromAccount(raw);
    if (proxyId != null) normalized.proxy_id = proxyId;
    return normalized;
  }

  function stripInternal(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const out = { ...obj };
    for (const key of Object.keys(out)) {
      if (key.startsWith("_")) delete out[key];
    }
    return out;
  }

  function cpaToSub2(cpaInput, options = {}) {
    const opts = normalizeConvertOptions(options);
    const cpa =
      isCpaRecord(cpaInput) || cpaInput?.access_token || cpaInput?.email
        ? normalizeCpa(cpaInput)
        : cpaInput;
    const email = cpa.email || "";
    const sub = cpa.sub || "";
    let name = email || sub || "unknown";
    if (opts.nameStrategy === "local" && email.includes("@")) name = email.split("@")[0];
    if (opts.nameStrategy === "sub" && sub) name = sub;

    const expiresAt = cpa._exp || unixFromIsoOrNumber(cpa.expired) || null;
    const account = {
      name,
      platform: "grok",
      type: "oauth",
      credentials: {
        access_token: cpa.access_token || "",
        base_url: cpa.base_url || BASE_URL,
        client_id: cpa._client_id || CLIENT_ID,
        email,
        expires_at: expiresAt,
        id_token: cpa.id_token || "",
        refresh_token: cpa.refresh_token || "",
        scope: cpa._scope || "",
        token_type: cpa.token_type || "Bearer",
      },
      extra: { email },
      concurrency: opts.concurrency,
      priority: opts.priority,
      rate_multiplier: opts.rateMultiplier,
      auto_pause_on_expired: opts.autoPauseOnExpired,
    };

    if (cpa.sso) account.extra.sso = cpa.sso;
    if (cpa.last_refresh) account.extra.last_refresh = cpa.last_refresh;
    if (cpa.redirect_uri) account.extra.redirect_uri = cpa.redirect_uri;
    if (cpa.token_endpoint) account.extra.token_endpoint = cpa.token_endpoint;
    if (cpa.headers) account.extra.headers = cpa.headers;
    if (sub) account.extra.sub = sub;

    return account;
  }

  function sub2ToCpa(sub2Input, options = {}) {
    const opts = normalizeConvertOptions(options);
    const sub2 =
      isSub2Account(sub2Input) || sub2Input?.credentials ? normalizeSub2(sub2Input) : sub2Input;
    const email = sub2.credentials?.email || "";
    const access = sub2.credentials?.access_token || "";
    const payload = decodeJwtPayload(access);
    const expired =
      sub2.credentials?.expires_at != null
        ? isoFromUnix(sub2.credentials.expires_at)
        : payload.exp
          ? isoFromUnix(payload.exp)
          : "";

    const record = {
      type: "xai",
      auth_kind: "oauth",
      email,
      sub: sub2._sub || payload.sub || "",
      access_token: access,
      refresh_token: sub2.credentials?.refresh_token || "",
      id_token: sub2.credentials?.id_token || "",
      token_type: sub2.credentials?.token_type || "Bearer",
      expires_in: sub2._expires_in,
      expired,
      last_refresh: sub2._last_refresh || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      redirect_uri: sub2._redirect_uri || REDIRECT_URI,
      token_endpoint: sub2._token_endpoint || TOKEN_ENDPOINT,
      base_url: sub2.credentials?.base_url || BASE_URL,
      disabled: false,
    };

    if (opts.keepHeaders) {
      record.headers = sub2._headers || { ...DEFAULT_HEADERS };
    }
    if (opts.keepSso && sub2._sso) {
      record.sso = sub2._sso;
    }
    return record;
  }

  function finalizeCpa(c, options = {}) {
    const opts = normalizeConvertOptions(options);
    const record = {
      type: "xai",
      auth_kind: "oauth",
      email: c.email || "",
      sub: c.sub || "",
      access_token: c.access_token || "",
      refresh_token: c.refresh_token || "",
      id_token: c.id_token || "",
      token_type: c.token_type || "Bearer",
      expires_in: c.expires_in ?? null,
      expired: c.expired || "",
      last_refresh: c.last_refresh || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      redirect_uri: c.redirect_uri || REDIRECT_URI,
      token_endpoint: c.token_endpoint || TOKEN_ENDPOINT,
      base_url: c.base_url || BASE_URL,
      disabled: !!c.disabled,
    };
    if (opts.keepHeaders) {
      record.headers =
        c.headers && typeof c.headers === "object" ? c.headers : { ...DEFAULT_HEADERS };
    }
    if (opts.keepSso && c.sso) {
      record.sso = c.sso;
    }
    return record;
  }

  function finalizeSub2(account, options = {}) {
    const opts = normalizeConvertOptions(options);
    const preserveExtra = opts.preserveExtra;
    const proxyId =
      opts.proxyId != null
        ? opts.proxyId
        : parseProxyId(options.proxyId) != null
          ? parseProxyId(options.proxyId)
          : null;
    const out = {
      name: account.name || account.credentials?.email || "unknown",
      platform: account.platform || "grok",
      type: account.type || "oauth",
      credentials: { ...(account.credentials || {}) },
      extra: { ...(account.extra || {}) },
      concurrency: opts.concurrency || account.concurrency || 1,
      priority: opts.priority ?? account.priority ?? 1,
      rate_multiplier: opts.rateMultiplier || account.rate_multiplier || 1,
      auto_pause_on_expired: opts.autoPauseOnExpired,
    };
    if (!out.extra.email && out.credentials.email) out.extra.email = out.credentials.email;
    if (preserveExtra && account.extra && account.extra.grok_usage_snapshot) {
      out.extra.grok_usage_snapshot = account.extra.grok_usage_snapshot;
    }
    applyProxyIdToAccountPayload(out, proxyId);
    return out;
  }

  /**
   * 统一转换入口
   * @param {any} account 源账号对象
   * @param {"cpa"|"sub2api"|string} sourceFormat
   * @param {"SUB2API"|"CPA"|"sub2api"|"cpa"|string} target
   * @param {object} options convert options + proxyId
   */
  function convertAccountTo(account, sourceFormat, target, options = {}) {
    if (!account || typeof account !== "object") {
      throw new Error("账号不可用");
    }
    const opts = normalizeConvertOptions(options);
    const targetNorm = normalizeTargetFormat(target);
    const source = String(sourceFormat || "").toLowerCase();

    if (targetNorm === TARGET_SUB2API) {
      const proxyId =
        opts.proxyId != null
          ? opts.proxyId
          : opts.defaultProxyId != null
            ? opts.defaultProxyId
            : extractProxyIdFromAccount(account);

      if (source === "cpa" || isCpaRecord(account)) {
        return finalizeSub2(cpaToSub2(account, opts), {
          ...opts,
          proxyId,
          preserveExtra: false,
        });
      }

      // sub2 → sub2：经 cpa 中转以统一字段，并套用调度参数
      const normalized = finalizeSub2(cpaToSub2(normalizeCpa(sub2ToCpa(account, opts)), opts), {
        ...opts,
        proxyId,
        preserveExtra: true,
      });
      if (account.name) normalized.name = account.name;
      applyProxyIdToAccountPayload(normalized, proxyId);
      return normalized;
    }

    if (targetNorm === TARGET_CPA) {
      if (source === "sub2api" || source === "sub2" || isSub2Account(account)) {
        return finalizeCpa(sub2ToCpa(account, opts), opts);
      }
      return finalizeCpa(
        stripInternal(isCpaRecord(account) ? normalizeCpa(account) : account),
        opts
      );
    }

    throw new Error("无法判定目标格式");
  }

  function normalizeTargetFormat(target) {
    const t = String(target || "")
      .trim()
      .toUpperCase();
    if (t === "SUB2API" || t === "SUB2") return TARGET_SUB2API;
    if (t === "CPA") return TARGET_CPA;
    const lower = String(target || "")
      .trim()
      .toLowerCase();
    if (lower === "sub2api" || lower === "sub2") return TARGET_SUB2API;
    if (lower === "cpa") return TARGET_CPA;
    return "";
  }

  function detectSourceFormat(account) {
    if (isSub2Account(account)) return "sub2api";
    if (isCpaRecord(account)) return "cpa";
    return "";
  }

  /** 解析账号过期 unix 秒；无法判断时返回 null */
  function resolveExpiresAtFromAccount(account, sourceFormat = "") {
    if (!account || typeof account !== "object") return null;
    const source = String(sourceFormat || detectSourceFormat(account)).toLowerCase();
    if (source === "cpa" || isCpaRecord(account)) {
      return (
        unixFromIsoOrNumber(account.expired) ||
        (account._exp != null ? Number(account._exp) : null) ||
        null
      );
    }
    if (source === "sub2api" || source === "sub2" || isSub2Account(account)) {
      const cred = account.credentials || {};
      return unixFromIsoOrNumber(cred.expires_at) || null;
    }
    return (
      unixFromIsoOrNumber(account.expired) ||
      unixFromIsoOrNumber(account.credentials?.expires_at) ||
      null
    );
  }

  function isExpiredUnix(expiresAt, nowSec = Math.floor(Date.now() / 1000)) {
    if (expiresAt == null || !Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= 0) {
      return false;
    }
    return Number(expiresAt) < nowSec;
  }

  /** 结果摘要：绝不包含 token */
  function summarizeAccountForResult(account, sourceFormat = "") {
    const source = String(sourceFormat || detectSourceFormat(account)).toLowerCase();
    const expiresAt = resolveExpiresAtFromAccount(account, source);
    const email =
      source === "cpa" || isCpaRecord(account)
        ? String(account?.email || "").trim()
        : String(account?.credentials?.email || account?.extra?.email || "").trim();
    const name =
      source === "cpa" || isCpaRecord(account)
        ? email || String(account?.sub || "").trim()
        : String(account?.name || email || "").trim();
    return {
      email: email || "",
      name: name || "",
      expiresAt: expiresAt != null && Number.isFinite(Number(expiresAt)) ? Number(expiresAt) : null,
    };
  }

  function uniqueCpaFilenames(records) {
    const used = new Map();
    return (records || []).map((account, index) => {
      let filename = cpaFilename(account);
      const count = (used.get(filename) || 0) + 1;
      used.set(filename, count);
      if (count > 1) filename = filename.replace(/\.json$/i, `-${count}.json`);
      if (!filename) filename = `xai-account-${index + 1}.json`;
      return { filename, account };
    });
  }

  global.AccountConvert = {
    CLIENT_ID,
    REDIRECT_URI,
    TOKEN_ENDPOINT,
    BASE_URL,
    DEFAULT_HEADERS,
    TARGET_SUB2API,
    TARGET_CPA,
    DEFAULT_CONVERT_OPTIONS,
    b64urlDecode,
    decodeJwtPayload,
    isoFromUnix,
    unixFromIsoOrNumber,
    parseProxyId,
    extractProxyIdFromAccount,
    applyProxyIdToAccountPayload,
    safeFilename,
    cpaFilename,
    isCpaRecord,
    isSub2Account,
    isSub2Export,
    normalizeConvertOptions,
    normalizeCpa,
    normalizeSub2,
    stripInternal,
    cpaToSub2,
    sub2ToCpa,
    finalizeCpa,
    finalizeSub2,
    convertAccountTo,
    normalizeTargetFormat,
    detectSourceFormat,
    resolveExpiresAtFromAccount,
    isExpiredUnix,
    summarizeAccountForResult,
    uniqueCpaFilenames,
  };
})(typeof window !== "undefined" ? window : globalThis);
