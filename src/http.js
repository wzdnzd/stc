import { HttpError } from "./errors.js";

export async function sub2apiRequest(
  config,
  path,
  init,
  timeoutMs,
  maxAttempts,
  clientSignal,
  retryOptions = {}
) {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");
  headers.set("x-api-key", config.apiKey);
  return requestJsonWithRetry(
    `${config.baseUrl}${path}`,
    { ...init, headers },
    {
      timeoutMs,
      maxAttempts,
      validate(data) {
        if (data && data.code !== undefined && data.code !== 0 && data.code !== "0") {
          const message = data.message || `SUB2API 业务错误：${data.code}`;
          throw new HttpError(400, message, "UPSTREAM_BUSINESS_ERROR", data);
        }
      },
      clientSignal,
      retryAmbiguous: retryOptions.retryAmbiguous === true,
      writeOperation: retryOptions.writeOperation === true,
    }
  );
}

export async function cpaRequest(config, path, init, timeoutMs, maxAttempts, clientSignal) {
  const modes = cpaAuthModes(config.cpaAuthMode);
  let lastError;
  for (const mode of modes) {
    const headers = new Headers(init.headers || {});
    headers.set("Accept", "application/json");
    if (mode === "x-management-key") headers.set("X-Management-Key", config.apiKey);
    else headers.set("Authorization", `Bearer ${config.apiKey}`);

    try {
      const result = await requestJsonWithRetry(
        `${config.baseUrl}${path}`,
        { ...init, headers },
        {
          timeoutMs,
          maxAttempts,
          clientSignal,
        }
      );
      return { ...result, authMode: mode };
    } catch (error) {
      lastError = error;
      if (![401, 403].includes(error?.status)) throw error;
    }
  }
  throw lastError || new HttpError(401, "CPA 管理密钥验证失败", "UPSTREAM_AUTH_FAILED");
}

/**
 * CPA 请求（原始文本/JSON 均可）。
 * 用于 auth-files/download：正文是认证 JSON 文件，可能被 parse 成对象或 { raw }。
 * 鉴权模式回退与 cpaRequest 一致。
 */
export async function cpaRequestRaw(config, path, init, timeoutMs, maxAttempts, clientSignal) {
  const modes = cpaAuthModes(config.cpaAuthMode);
  let lastError;
  for (const mode of modes) {
    const headers = new Headers(init.headers || {});
    headers.set("Accept", "*/*");
    if (mode === "x-management-key") headers.set("X-Management-Key", config.apiKey);
    else headers.set("Authorization", `Bearer ${config.apiKey}`);

    try {
      const result = await requestJsonWithRetry(
        `${config.baseUrl}${path}`,
        { ...init, headers },
        {
          timeoutMs,
          maxAttempts,
          clientSignal,
        }
      );
      return { ...result, authMode: mode };
    } catch (error) {
      lastError = error;
      if (![401, 403].includes(error?.status)) throw error;
    }
  }
  throw lastError || new HttpError(401, "CPA 管理密钥验证失败", "UPSTREAM_AUTH_FAILED");
}

export function cpaAuthModes(preferred) {
  if (preferred === "bearer") return ["bearer"];
  if (preferred === "x-management-key") return ["x-management-key"];
  return ["bearer", "x-management-key"];
}

export async function requestJsonWithRetry(url, init, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const maxAttempts = options.maxAttempts || 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (options.clientSignal?.aborted) {
        throw new HttpError(499, "客户端已取消上传", "CLIENT_ABORTED");
      }
      const response = await fetchWithTimeout(url, init, timeoutMs, options.clientSignal);
      const text = await response.text();
      const data = parseResponseBody(text);
      if (!response.ok) {
        const detail =
          data?.message || data?.error || data?.code || data?.raw || response.statusText;
        const error = new HttpError(
          response.status,
          `上游 HTTP ${response.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
          "UPSTREAM_HTTP_ERROR",
          data
        );
        error.attempts = attempt;
        throw error;
      }
      if (options.validate) options.validate(data);
      return { response, data, attempts: attempt };
    } catch (error) {
      lastError = normalizeUpstreamError(error);
      lastError.attempts = attempt;
      const canRetry = options.writeOperation
        ? isRetryableWrite(lastError, options.retryAmbiguous === true)
        : isRetryable(lastError);
      if (attempt >= maxAttempts || !canRetry) throw lastError;
      await sleep(700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300));
    }
  }
  throw lastError;
}

export async function fetchWithTimeout(url, init, timeoutMs, clientSignal) {
  const controller = new AbortController();
  const timeoutError = new DOMException("upstream timeout", "TimeoutError");
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const onClientAbort = () => {
    controller.abort(new DOMException("client cancelled", "AbortError"));
  };

  if (clientSignal) {
    if (clientSignal.aborted) onClientAbort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } catch (error) {
    if (clientSignal?.aborted) {
      throw new HttpError(499, "客户端已取消上传", "CLIENT_ABORTED");
    }
    if (controller.signal.aborted) {
      throw new HttpError(
        504,
        "上游请求超时，服务器可能已经接收并处理本批数据，请先核对后再重试",
        "UPSTREAM_TIMEOUT"
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    clientSignal?.removeEventListener?.("abort", onClientAbort);
  }
}

export function normalizeUpstreamError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(
    502,
    `无法连接上游服务器：${error?.message || String(error)}`,
    "UPSTREAM_NETWORK_ERROR"
  );
}

export function isRetryable(error) {
  if (!error?.status) return true;
  return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
}

// 写操作（尤其 SUB2API bulk）更保守：
// - 安全重试：无 status 网络错误、429、502/503 等较可能未落库的情况
// - 模糊重试（可选）：超时 504 / 500 —— 可能已写入，仅当调用方明确允许时重试
export function isRetryableWrite(error, retryAmbiguous = false) {
  if (error?.code === "CLIENT_ABORTED" || error?.status === 499) return false;
  if (error?.code === "UPSTREAM_BUSINESS_ERROR") return false;
  if (
    error?.status &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  ) {
    return false;
  }
  if (!error?.status) return true;
  if ([408, 425, 429, 502, 503].includes(error.status)) return true;
  if (retryAmbiguous && [500, 504].includes(error.status)) return true;
  if (error?.code === "UPSTREAM_TIMEOUT") return Boolean(retryAmbiguous);
  if (error?.code === "UPSTREAM_NETWORK_ERROR") return true;
  return false;
}

export function parseResponseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function readJsonBody(request, maxBytes) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new HttpError(413, "请求体过大", "PAYLOAD_TOO_LARGE");
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new HttpError(413, "请求体过大", "PAYLOAD_TOO_LARGE");
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new HttpError(400, "请求体不是有效 JSON", "INVALID_JSON");
  }
}
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
