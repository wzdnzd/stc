import { COOKIE_NAME, DEFAULT_SESSION_TTL_HOURS } from "./constants.js";
import { HttpError } from "./errors.js";
import { readJsonBody, sleep } from "./http.js";
import { htmlResponse, renderLoginPage, securityHeaders } from "./responses.js";

export async function handleLogin(request, env) {
  if (request.method === "GET") return htmlResponse(renderLoginPage(), 200);
  if (request.method !== "POST")
    throw new HttpError(405, "Method Not Allowed", "METHOD_NOT_ALLOWED");

  // 登录请求不做严格 Origin 比对。Cloudflare Dashboard/Preview、自定义域名
  // 或边缘代理可能使浏览器的 Origin 与 Worker 看到的 request.url 不完全一致，
  // 从而误判为跨站。登录仍受访问密码、失败延迟和后续 SameSite 会话 Cookie 保护。
  const contentType = request.headers.get("content-type") || "";
  let password;
  if (contentType.includes("application/json")) {
    const body = await readJsonBody(request, 16 * 1024);
    password = String(body?.password || "");
  } else {
    const form = await request.formData();
    password = String(form.get("password") || "");
  }

  if (!constantTimeEqual(password, String(env.APP_PASSWORD))) {
    await sleep(650);
    return htmlResponse(renderLoginPage("访问密码不正确"), 401);
  }

  const token = await createSessionToken(env);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": sessionCookie(token, sessionTtlHours(env)),
      ...securityHeaders(),
    },
  });
}

export function sessionTtlHours(env) {
  const parsed = Number(env.SESSION_TTL_HOURS || DEFAULT_SESSION_TTL_HOURS);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_TTL_HOURS;
  return Math.min(24 * 30, Math.max(1, Math.floor(parsed)));
}

export function parsePositiveIntEnv(raw, fallback, absoluteMax) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  if (floored < 1) return fallback;
  return Math.min(absoluteMax, floored);
}

export async function createSessionToken(env) {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + sessionTtlHours(env) * 3600,
    nonce: crypto.randomUUID(),
  };
  const encoded = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSign(encoded, String(env.SESSION_SECRET));
  return `${encoded}.${signature}`;
}

export async function isAuthenticated(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;

  const expected = await hmacSign(payload, String(env.SESSION_SECRET));
  if (!constantTimeEqual(signature, expected)) return false;

  try {
    const data = JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));
    return Number.isFinite(data.exp) && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64urlEncode(new Uint8Array(signature));
}

export function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

export function base64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64urlDecode(value) {
  const base64 =
    value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name)
      return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

export function sessionCookie(token, ttlHours) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttlHours * 3600}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function assertTrustedMutation(request) {
  const fetchSite = String(request.headers.get("Sec-Fetch-Site") || "").toLowerCase();

  // 浏览器明确标记为 cross-site 时拒绝。允许 same-origin、same-site 和 none；
  // 这比直接比较 Origin 与 request.url 更适合 Workers 的预览 URL、自定义域名
  // 以及可能存在的边缘代理，同时仍可阻止普通跨站表单/Fetch 携带会话执行写操作。
  if (fetchSite === "cross-site") {
    throw new HttpError(403, "拒绝跨站请求", "CROSS_SITE_REQUEST");
  }

  // 某些非浏览器客户端不发送 Sec-Fetch-Site。此时若提供了正常 Origin，
  // 仍进行传统同源检查；Origin: null 不参与判断，避免沙箱预览误伤。
  if (!fetchSite) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== "null") {
      let parsedOrigin;
      try {
        parsedOrigin = new URL(origin).origin;
      } catch {
        throw new HttpError(403, "拒绝跨站请求", "CROSS_SITE_REQUEST");
      }
      if (parsedOrigin !== new URL(request.url).origin) {
        throw new HttpError(403, "拒绝跨站请求", "CROSS_SITE_REQUEST");
      }
    }
  }
}
