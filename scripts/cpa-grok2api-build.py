#!/usr/bin/env python3
"""将 CPA xAI OAuth 账号 JSON 转换为 GROK2API grok_build 导入格式

支持：
  - local：读取本地单文件或目录
  - remote：从 CPA 管理接口拉取 type=xai 的认证文件
  - 仅转换 type/provider 为 xai 的账号
  - 按 --max-per-file 自动切分输出文件，范围 1~10000
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MIN_PER_FILE = 1
MAX_PER_FILE = 10000
DEFAULT_MAX_PER_FILE = 10000
DEFAULT_DOWNLOAD_CONCURRENCY = 8
REQUEST_TIMEOUT_SEC = 60
REQUEST_MAX_ATTEMPTS = 3

XAI_ALIASES = frozenset({"xai", "x-ai", "grok"})


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------


def print_progress(current: int, total: int, prefix: str = "", width: int = 32) -> None:
    """简易进度条，不依赖第三方库"""
    if total <= 0:
        return
    ratio = min(max(current / total, 0.0), 1.0)
    filled = int(width * ratio)
    bar = "█" * filled + "░" * (width - filled)
    percent = ratio * 100
    end = "\n" if current >= total else "\r"
    sys.stdout.write(f"\r{prefix}[{bar}] {current}/{total} {percent:5.1f}%")
    sys.stdout.write(end)
    sys.stdout.flush()


def b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def decode_jwt_payload(token: str) -> dict[str, Any]:
    """解析 JWT payload，失败时返回空字典"""
    if not token or token.count(".") < 2:
        return {}
    try:
        payload_part = token.split(".")[1]
        raw = b64url_decode(payload_part)
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def normalize_expires_at(value: Any) -> str:
    """把各种过期时间统一成 RFC3339 字符串"""
    if value is None or value == "":
        return ""

    if isinstance(value, (int, float)):
        try:
            dt = datetime.fromtimestamp(float(value), tz=timezone.utc)
            return dt.isoformat().replace("+00:00", "Z")
        except (OverflowError, OSError, ValueError):
            return ""

    text = str(value).strip()
    if not text:
        return ""

    if re.fullmatch(r"\d+(\.\d+)?", text):
        return normalize_expires_at(float(text))

    candidates = [
        text,
        text.replace("Z", "+00:00"),
        text.replace(" ", "T"),
    ]
    for item in candidates:
        try:
            dt = datetime.fromisoformat(item)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except ValueError:
            continue
    return text


def first_non_empty(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def normalize_provider(value: Any) -> str:
    text = str(value or "").strip().lower()
    aliases = {
        "x-ai": "xai",
        "grok": "xai",
        "openai": "codex",
        "chatgpt": "codex",
        "google": "gemini",
        "anthropic": "claude",
    }
    return aliases.get(text, text)


def is_cpa_auth_data(data: Any) -> bool:
    """判断是否符合 CPA 认证文件基本结构"""
    if not isinstance(data, dict) or isinstance(data, list):
        return False

    access_token = first_non_empty(data.get("access_token"))
    refresh_token = first_non_empty(data.get("refresh_token"))
    if not access_token and not refresh_token:
        return False

    # 有 type / auth_kind / token_endpoint / base_url 任一特征即可
    has_type = bool(first_non_empty(data.get("type"), data.get("provider"), data.get("auth_type")))
    has_auth_kind = bool(first_non_empty(data.get("auth_kind"), data.get("authKind")))
    has_endpoint = bool(
        first_non_empty(
            data.get("token_endpoint"),
            data.get("base_url"),
            data.get("redirect_uri"),
        )
    )
    has_identity = bool(
        first_non_empty(
            data.get("email"),
            data.get("sub"),
            data.get("user_id"),
            data.get("client_id"),
        )
    )
    return has_type or has_auth_kind or has_endpoint or has_identity


def is_xai_cpa_data(data: dict[str, Any]) -> bool:
    """判断 CPA 文件内容是否为 xai 类型"""
    if not is_cpa_auth_data(data):
        return False

    provider = normalize_provider(first_non_empty(data.get("type"), data.get("provider"), data.get("auth_type")))
    if provider in XAI_ALIASES:
        return True

    # 无 type 时，用 xai token 端点 / base_url 兜底识别
    token_endpoint = str(data.get("token_endpoint") or "").lower()
    base_url = str(data.get("base_url") or "").lower()
    if "auth.x.ai" in token_endpoint or "x.ai" in token_endpoint:
        return True
    if "grok.com" in base_url or "x.ai" in base_url:
        return True
    return False


def sanitize_json_filename(name: str) -> str:
    text = str(name or "").strip()
    text = text.replace("\\", "/").split("/")[-1]
    text = re.sub(r'[\x00-\x1f<>:"|?*]', "", text)
    return text


def parse_max_per_file(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--max-per-file 必须是整数") from exc
    if value < MIN_PER_FILE or value > MAX_PER_FILE:
        raise argparse.ArgumentTypeError(f"--max-per-file 必须在 {MIN_PER_FILE}~{MAX_PER_FILE} 之间，当前为 {value}")
    return value


def parse_name_filter(raw: str) -> re.Pattern[str]:
    """解析并校验文件名过滤正则"""
    pattern = str(raw or "").strip()
    if not pattern:
        raise argparse.ArgumentTypeError("--name-filter 不能为空")
    try:
        return re.compile(pattern)
    except re.error as exc:
        raise argparse.ArgumentTypeError(f"--name-filter 不是合法正则：{exc}") from exc


# ---------------------------------------------------------------------------
# 转换核心
# ---------------------------------------------------------------------------


def cpa_to_account(cpa_data: dict[str, Any], source_name: str = "") -> dict[str, Any]:
    """把单个 CPA JSON 对象转成 grok_build 账号条目"""
    if not isinstance(cpa_data, dict):
        raise ValueError("CPA 文件内容必须是 JSON 对象")

    if not is_xai_cpa_data(cpa_data):
        raise ValueError("非 xai 类型账号，已跳过")

    access_token = first_non_empty(cpa_data.get("access_token"))
    refresh_token = first_non_empty(cpa_data.get("refresh_token"))
    id_token = first_non_empty(cpa_data.get("id_token"))

    if not access_token and not refresh_token:
        raise ValueError("缺少 access_token 和 refresh_token")

    claims = decode_jwt_payload(access_token) or decode_jwt_payload(id_token)

    email = first_non_empty(
        cpa_data.get("email"),
        claims.get("email"),
        claims.get("preferred_username"),
    )
    user_id = first_non_empty(
        cpa_data.get("sub"),
        cpa_data.get("user_id"),
        claims.get("sub"),
        claims.get("principal_id"),
        claims.get("user_id"),
    )
    team_id = first_non_empty(
        cpa_data.get("team_id"),
        claims.get("team_id"),
    )
    principal_id = first_non_empty(
        cpa_data.get("principal_id"),
        claims.get("principal_id"),
        user_id,
    )
    aud = claims.get("aud")
    client_id = first_non_empty(
        cpa_data.get("client_id"),
        claims.get("client_id"),
        aud if isinstance(aud, str) else "",
    )
    if not client_id:
        client_id = str(uuid.uuid4())

    name = first_non_empty(
        cpa_data.get("name"),
        email,
        user_id,
        Path(source_name).stem if source_name else "",
        "unknown",
    )

    expires_at = normalize_expires_at(
        first_non_empty(
            cpa_data.get("expired"),
            cpa_data.get("expires_at"),
            claims.get("exp"),
        )
    )

    expires_in = cpa_data.get("expires_in", 0)
    try:
        expires_in = int(expires_in or 0)
    except (TypeError, ValueError):
        expires_in = 0

    token_type = first_non_empty(cpa_data.get("token_type"), "Bearer") or "Bearer"
    scope = first_non_empty(cpa_data.get("scope"), claims.get("scope"))

    return {
        "provider": "grok_build",
        "name": name,
        "client_id": client_id,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "id_token": id_token,
        "token_type": token_type,
        "scope": scope,
        "expires_at": expires_at,
        "expires_in": expires_in,
        "email": email,
        "user_id": user_id,
        "principal_id": principal_id,
        "team_id": team_id,
    }


def build_output_document(accounts: list[dict[str, Any]]) -> dict[str, Any]:
    return {"accounts": accounts}


def chunk_accounts(accounts: list[dict[str, Any]], max_per_file: int) -> list[list[dict[str, Any]]]:
    if max_per_file < MIN_PER_FILE or max_per_file > MAX_PER_FILE:
        raise ValueError(f"max_per_file 必须在 {MIN_PER_FILE}~{MAX_PER_FILE} 之间")
    if not accounts:
        return []
    return [accounts[i : i + max_per_file] for i in range(0, len(accounts), max_per_file)]


def resolve_output_targets(
    output: str | None,
    mode: str,
    input_path: Path | None,
    part_count: int,
) -> list[Path]:
    """根据输出参数与分片数量，生成最终输出路径列表"""
    if part_count <= 0:
        raise ValueError("没有可写入的账号")

    if output:
        raw = Path(output).expanduser()
        looks_like_dir = str(output).endswith(("/", "\\")) or raw.suffix == "" or (raw.exists() and raw.is_dir())
        if looks_like_dir:
            directory = raw.resolve()
            directory.mkdir(parents=True, exist_ok=True)
            if part_count == 1:
                return [directory / "grok2api-build-accounts.json"]
            return [directory / f"grok2api-build-accounts-{idx:03d}.json" for idx in range(1, part_count + 1)]

        base = raw.resolve()
        base.parent.mkdir(parents=True, exist_ok=True)
        if part_count == 1:
            return [base]
        stem = base.stem or "grok2api-build-accounts"
        suffix = base.suffix or ".json"
        return [base.with_name(f"{stem}-{idx:03d}{suffix}") for idx in range(1, part_count + 1)]

    if mode == "local" and input_path is not None:
        if input_path.is_file():
            base_dir = input_path.parent
            stem = f"{input_path.stem}.grok_build"
        else:
            base_dir = input_path
            stem = "grok2api-build-accounts"
    else:
        base_dir = Path.cwd()
        stem = "grok2api-build-accounts"

    if part_count == 1:
        return [base_dir / f"{stem}.json"]
    return [base_dir / f"{stem}-{idx:03d}.json" for idx in range(1, part_count + 1)]


def write_account_parts(
    accounts: list[dict[str, Any]],
    output: str | None,
    mode: str,
    input_path: Path | None,
    max_per_file: int,
) -> list[Path]:
    chunks = chunk_accounts(accounts, max_per_file)
    targets = resolve_output_targets(output, mode, input_path, len(chunks))
    written: list[Path] = []
    for path, chunk in zip(targets, chunks):
        document = build_output_document(chunk)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="\n") as f:
            json.dump(document, f, ensure_ascii=False, indent=2)
            f.write("\n")
        written.append(path)
        print(f"  已写入 {len(chunk)} 个账号 → {path}")
    return written


# ---------------------------------------------------------------------------
# 本地模式
# ---------------------------------------------------------------------------


def collect_local_candidate_files(
    input_path: Path,
    name_filter: re.Pattern[str] | None = None,
) -> list[Path]:
    if not input_path.exists():
        raise FileNotFoundError(f"输入路径不存在：{input_path}")

    if input_path.is_file():
        if input_path.suffix.lower() != ".json":
            raise ValueError(f"单文件模式仅支持 .json：{input_path}")
        if name_filter is not None and not name_filter.search(input_path.name):
            raise ValueError(f"文件名不匹配 --name-filter：{input_path.name}")
        return [input_path]

    if not input_path.is_dir():
        raise ValueError(f"输入路径既不是文件也不是目录：{input_path}")

    files: list[Path] = []
    for path in sorted(input_path.iterdir()):
        if not path.is_file():
            continue
        if path.suffix.lower() != ".json":
            continue
        if name_filter is not None and not name_filter.search(path.name):
            continue
        files.append(path)
    return files


def load_cpa_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("根节点必须是 JSON 对象")
    return data


def convert_local(
    input_path: Path,
    max_per_file: int,
    output: str | None,
    name_filter: re.Pattern[str] | None = None,
) -> dict[str, Any]:
    candidates = collect_local_candidate_files(input_path, name_filter=name_filter)
    if not candidates:
        if name_filter is not None:
            raise FileNotFoundError(f"未找到匹配 --name-filter 的 json 文件：{input_path}")
        raise FileNotFoundError(f"未找到可扫描的 json 文件：{input_path}")

    accounts: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []
    total = len(candidates)

    filter_desc = name_filter.pattern if name_filter is not None else "全部 .json 文件"
    print(f"[local] 候选文件 {total} 个，过滤规则：{filter_desc}")
    print("[local] 开始校验 CPA 格式并转换 xai 账号")
    print_progress(0, total, prefix="进度 ")

    for idx, file_path in enumerate(candidates, start=1):
        try:
            cpa_data = load_cpa_json(file_path)
            if not is_cpa_auth_data(cpa_data):
                skipped.append({"file": file_path.name, "reason": "不符合 CPA 认证文件格式"})
            elif not is_xai_cpa_data(cpa_data):
                skipped.append({"file": file_path.name, "reason": "非 xai 类型"})
            else:
                account = cpa_to_account(cpa_data, source_name=file_path.name)
                accounts.append(account)
        except Exception as exc:  # noqa: BLE001
            failed.append({"file": file_path.name, "error": str(exc)})
        print_progress(idx, total, prefix="进度 ")

    if not accounts:
        details = []
        details.extend(f'{item["file"]}: {item["error"]}' for item in failed[:5])
        details.extend(f'{item["file"]}: {item["reason"]}' for item in skipped[:5])
        message = "没有可转换的 xai 账号"
        if details:
            message = f"{message}。示例：{'; '.join(details)}"
        raise RuntimeError(message)

    written = write_account_parts(
        accounts=accounts,
        output=output,
        mode="local",
        input_path=input_path,
        max_per_file=max_per_file,
    )

    return {
        "mode": "local",
        "input": str(input_path),
        "name_filter": name_filter.pattern if name_filter is not None else "",
        "outputs": [str(p) for p in written],
        "candidate_files": total,
        "converted": len(accounts),
        "skipped": len(skipped),
        "failed": len(failed),
        "failed_files": failed,
        "skipped_files": skipped,
        "parts": len(written),
        "max_per_file": max_per_file,
    }


# ---------------------------------------------------------------------------
# 远端模式 CPA management API
# ---------------------------------------------------------------------------


def normalize_base_url(raw: str) -> str:
    value = str(raw or "").strip()
    if not value:
        raise ValueError("CPA 服务地址不能为空")
    if not re.match(r"^https?://", value, re.IGNORECASE):
        value = f"https://{value}"
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("CPA 服务地址仅支持 HTTP/HTTPS")
    path = parsed.path.rstrip("/")
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def cpa_auth_modes(preferred: str | None) -> list[str]:
    mode = (preferred or "").strip().lower()
    if mode in ("bearer", "authorization"):
        return ["bearer"]
    if mode in ("x-management-key", "management-key", "management"):
        return ["x-management-key"]
    return ["bearer", "x-management-key"]


def apply_auth_header(headers: dict[str, str], api_key: str, mode: str) -> None:
    if mode == "x-management-key":
        headers["X-Management-Key"] = api_key
    else:
        headers["Authorization"] = f"Bearer {api_key}"


def parse_response_body(text: str) -> Any:
    text = text.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}


def http_request_json(
    url: str,
    api_key: str,
    preferred_auth_mode: str | None = None,
    method: str = "GET",
    accept: str = "application/json",
    timeout: int = REQUEST_TIMEOUT_SEC,
    max_attempts: int = REQUEST_MAX_ATTEMPTS,
) -> tuple[Any, str]:
    """带鉴权回退与重试的 HTTP JSON 请求，返回 data 与 auth_mode"""
    modes = cpa_auth_modes(preferred_auth_mode)
    last_error: Exception | None = None

    for mode in modes:
        for attempt in range(1, max_attempts + 1):
            headers = {
                "Accept": accept,
                "User-Agent": "grok-shell/0.2.111 (linux; x86_64)",
            }
            apply_auth_header(headers, api_key, mode)
            req = urllib.request.Request(url, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw = resp.read()
                    text = raw.decode("utf-8-sig", errors="replace")
                    data = parse_response_body(text)
                    return data, mode
            except urllib.error.HTTPError as exc:
                body = ""
                try:
                    body = exc.read().decode("utf-8", errors="replace")
                except Exception:
                    body = ""
                last_error = RuntimeError(f"HTTP {exc.code}: {body or exc.reason}")
                if exc.code in (401, 403):
                    break
                if exc.code in (408, 425, 429, 500, 502, 503, 504) and attempt < max_attempts:
                    time.sleep(0.4 * (2 ** (attempt - 1)))
                    continue
                raise last_error from exc
            except Exception as exc:  # noqa: BLE001
                last_error = RuntimeError(f"请求失败：{exc}")
                if attempt < max_attempts:
                    time.sleep(0.4 * (2 ** (attempt - 1)))
                    continue
                raise last_error from exc

    raise RuntimeError(f"CPA 管理密钥验证失败：{last_error}")


def pick_first_defined(obj: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        if key in obj and obj[key] is not None and obj[key] != "":
            return obj[key]
    return None


def parse_cpa_auth_file_item(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    name_raw = pick_first_defined(item, ["name", "file_name", "fileName", "id"])
    if name_raw is None or name_raw == "":
        return None
    name = sanitize_json_filename(str(name_raw))
    if not name:
        return None
    provider = normalize_provider(pick_first_defined(item, ["provider", "type"]))
    return {
        "name": name,
        "id": str(pick_first_defined(item, ["id"]) or ""),
        "provider": provider,
        "account": str(pick_first_defined(item, ["account", "email", "display_account", "displayAccount"]) or ""),
    }


def parse_cpa_auth_files_list_payload(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        nested = None
        for key in ("auth_files", "authFiles", "files", "items", "data"):
            if isinstance(data.get(key), list):
                nested = data[key]
                break
        if nested is not None:
            items = nested
        elif pick_first_defined(data, ["name", "file_name", "fileName", "id"]) is not None:
            items = [data]
        else:
            items = []
            for key, value in data.items():
                if isinstance(value, dict):
                    items.append({**value, "name": value.get("name") or key})
                elif value is True or value is None or isinstance(value, str):
                    items.append({"name": key})
    else:
        raise RuntimeError("CPA 返回了非预期的认证文件列表")

    files: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        parsed = parse_cpa_auth_file_item(item)
        if not parsed or not parsed["name"] or parsed["name"] in seen:
            continue
        seen.add(parsed["name"])
        files.append(parsed)
    files.sort(key=lambda x: str(x["name"]))
    return files


def unwrap_download_content(content: Any) -> dict[str, Any]:
    """下载结果可能是对象，也可能是 raw 字符串包装"""
    if isinstance(content, dict):
        if "raw" in content and isinstance(content.get("raw"), str) and len(content) == 1:
            try:
                parsed = json.loads(content["raw"])
            except json.JSONDecodeError as exc:
                raise ValueError("下载内容 raw 字段不是合法 JSON") from exc
            if not isinstance(parsed, dict):
                raise ValueError("下载内容不是 JSON 对象")
            return parsed
        return content
    if isinstance(content, str):
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            raise ValueError("下载内容不是 JSON 对象")
        return parsed
    raise ValueError("下载内容格式无效")


class CpaRemoteClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        auth_mode: str | None = None,
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        self.api_key = str(api_key).strip()
        self.auth_mode = auth_mode
        if not self.api_key:
            raise ValueError("CPA API Key 不能为空")

    def verify(self) -> dict[str, Any]:
        """验证服务地址与 Key：成功列出 auth-files 即视为有效"""
        url = f"{self.base_url}/v0/management/auth-files"
        data, mode = http_request_json(
            url=url,
            api_key=self.api_key,
            preferred_auth_mode=self.auth_mode,
        )
        files = parse_cpa_auth_files_list_payload(data)
        self.auth_mode = mode
        return {
            "base_url": self.base_url,
            "auth_mode": mode,
            "count": len(files),
            "files": files,
        }

    def download_one(self, file_name: str) -> dict[str, Any]:
        safe_name = sanitize_json_filename(file_name)
        query = urllib.parse.urlencode({"name": safe_name})
        url = f"{self.base_url}/v0/management/auth-files/download?{query}"
        data, mode = http_request_json(
            url=url,
            api_key=self.api_key,
            preferred_auth_mode=self.auth_mode,
            accept="*/*",
        )
        content = unwrap_download_content(data)
        return {"name": safe_name, "content": content, "auth_mode": mode}


def convert_remote(
    base_url: str,
    api_key: str,
    max_per_file: int,
    output: str | None,
    auth_mode: str | None = None,
    concurrency: int = DEFAULT_DOWNLOAD_CONCURRENCY,
    name_filter: re.Pattern[str] | None = None,
) -> dict[str, Any]:
    client = CpaRemoteClient(base_url=base_url, api_key=api_key, auth_mode=auth_mode)

    print("[remote] 正在验证 CPA 服务地址与 API Key")
    verify_result = client.verify()
    print(f"[remote] 验证成功，鉴权方式 {verify_result['auth_mode']}，" f"列表共 {verify_result['count']} 个文件")

    listed = verify_result["files"]
    if name_filter is not None:
        listed = [item for item in listed if name_filter.search(str(item.get("name") or ""))]
        print(f"[remote] 应用 --name-filter 后剩余 {len(listed)} 个文件")

    has_provider = any(bool(item.get("provider")) for item in listed)
    if has_provider:
        file_items = [item for item in listed if item.get("provider") in XAI_ALIASES]
        print(f"[remote] 列表中 xai 文件：{len(file_items)}")
    else:
        file_items = listed
        print(f"[remote] 列表未标注 provider，将下载全部 {len(file_items)} 个文件后按内容过滤 xai")

    if not file_items:
        raise RuntimeError("远端没有可下载的 xai 认证文件")

    accounts: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []
    total = len(file_items)
    workers = max(1, min(concurrency, total))

    print(f"[remote] 开始下载并转换，并发 {workers}")
    print_progress(0, total, prefix="进度 ")

    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {pool.submit(client.download_one, item["name"]): item for item in file_items}
        for future in as_completed(future_map):
            meta = future_map[future]
            name = meta["name"]
            try:
                downloaded = future.result()
                content = downloaded["content"]
                if not is_cpa_auth_data(content):
                    skipped.append({"file": name, "reason": "不符合 CPA 认证文件格式"})
                elif not is_xai_cpa_data(content):
                    skipped.append({"file": name, "reason": "非 xai 类型"})
                else:
                    account = cpa_to_account(content, source_name=name)
                    accounts.append(account)
            except Exception as exc:  # noqa: BLE001
                failed.append({"file": name, "error": str(exc)})
            done += 1
            print_progress(done, total, prefix="进度 ")

    if not accounts:
        details = []
        details.extend(f'{item["file"]}: {item["error"]}' for item in failed[:5])
        details.extend(f'{item["file"]}: {item["reason"]}' for item in skipped[:5])
        message = "远端没有可转换的 xai 账号"
        if details:
            message = f"{message}。示例：{'; '.join(details)}"
        raise RuntimeError(message)

    written = write_account_parts(
        accounts=accounts,
        output=output,
        mode="remote",
        input_path=None,
        max_per_file=max_per_file,
    )

    return {
        "mode": "remote",
        "base_url": client.base_url,
        "auth_mode": client.auth_mode,
        "name_filter": name_filter.pattern if name_filter is not None else "",
        "outputs": [str(p) for p in written],
        "listed_files": verify_result["count"],
        "download_targets": total,
        "converted": len(accounts),
        "skipped": len(skipped),
        "failed": len(failed),
        "failed_files": failed,
        "skipped_files": skipped,
        "parts": len(written),
        "max_per_file": max_per_file,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    prog = Path(sys.argv[0]).name or "cpa-grok2api-build.py"
    parser = argparse.ArgumentParser(
        prog=prog,
        description="将 CPA xAI 账号转为 GROK2API grok_build 导入文件，支持 local / remote",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""示例:
  # 本地：转换单个文件
  python {prog} --mode local -i ./account.json -o ./out.json

  # 本地：转换目录全部 .json，仅保留符合 CPA 且为 xai 的账号，每文件最多 500 个
  python {prog} --mode local -i ./accounts -o ./export/ --max-per-file 500

  # 本地：自定义文件名过滤正则
  python {prog} --mode local -i ./accounts --name-filter '^cpa-.*\\.json$' -o ./export/

  # 远端：从环境变量 CPA_BASE_URL / CPA_MANAGEMENT_KEY 读取
  python {prog} --mode remote -o ./export/

  # 远端：显式指定服务地址与 Key
  python {prog} --mode remote \\
    --cpa-url https://cpa.example.com \\
    --cpa-key YOUR_MANAGEMENT_KEY \\
    -o ./grok2api-build-accounts.json \\
    --max-per-file 1000
""",
    )
    parser.add_argument(
        "--mode",
        choices=["local", "remote"],
        default="local",
        help="运行模式：local 为本地文件，remote 为 CPA 远端 API",
    )
    parser.add_argument(
        "-i",
        "--input",
        default=None,
        help="local 模式必填：CPA 账号文件，或包含 json 的目录",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help="输出文件路径；也可传目录，自动生成 grok2api-build-accounts*.json",
    )
    parser.add_argument(
        "--max-per-file",
        type=parse_max_per_file,
        default=DEFAULT_MAX_PER_FILE,
        help=f"单个输出文件最多包含的账号数，范围 {MIN_PER_FILE}~{MAX_PER_FILE}，默认 {DEFAULT_MAX_PER_FILE}",
    )
    parser.add_argument(
        "--name-filter",
        type=parse_name_filter,
        default=None,
        help="可选文件名正则过滤。未指定时扫描全部 .json，再按 CPA 认证格式校验",
    )
    parser.add_argument(
        "--cpa-url",
        default=None,
        help="remote 模式：CPA 服务地址，默认读环境变量 CPA_BASE_URL",
    )
    parser.add_argument(
        "--cpa-key",
        default=None,
        help="remote 模式：CPA 管理密钥，默认读环境变量 CPA_MANAGEMENT_KEY",
    )
    parser.add_argument(
        "--cpa-auth-mode",
        choices=["auto", "bearer", "x-management-key"],
        default="auto",
        help="remote 鉴权方式，默认 auto：先 Bearer 再 X-Management-Key",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=DEFAULT_DOWNLOAD_CONCURRENCY,
        help=f"remote 下载并发数，默认 {DEFAULT_DOWNLOAD_CONCURRENCY}",
    )
    return parser


def resolve_remote_credentials(args: argparse.Namespace) -> tuple[str, str, str | None]:
    base_url = first_non_empty(args.cpa_url, os.environ.get("CPA_BASE_URL"))
    api_key = first_non_empty(args.cpa_key, os.environ.get("CPA_MANAGEMENT_KEY"))
    if not base_url:
        raise ValueError("remote 模式需要 --cpa-url 或环境变量 CPA_BASE_URL")
    if not api_key:
        raise ValueError("remote 模式需要 --cpa-key 或环境变量 CPA_MANAGEMENT_KEY")
    auth_mode = None if args.cpa_auth_mode == "auto" else args.cpa_auth_mode
    return base_url, api_key, auth_mode


def print_result(result: dict[str, Any]) -> None:
    print("转换完成")
    print(f"模式：{result.get('mode')}")
    if result.get("mode") == "local":
        print(f"输入：{result.get('input')}")
        print(f"候选文件：{result.get('candidate_files')}")
        if result.get("name_filter"):
            print(f"文件名过滤：{result.get('name_filter')}")
    else:
        print(f"CPA：{result.get('base_url')}")
        print(f"鉴权：{result.get('auth_mode')}")
        print(f"列表文件：{result.get('listed_files')}")
        print(f"下载目标：{result.get('download_targets')}")
        if result.get("name_filter"):
            print(f"文件名过滤：{result.get('name_filter')}")

    print(f"成功转换 xai 账号：{result.get('converted')}")
    print(f"跳过：{result.get('skipped')}")
    print(f"失败：{result.get('failed')}")
    print(f"输出分片：{result.get('parts')}，每文件最多 {result.get('max_per_file')}")
    for path in result.get("outputs") or []:
        print(f"  - {path}")

    failed_files = result.get("failed_files") or []
    if failed_files:
        print("失败明细：")
        for item in failed_files[:20]:
            print(f"  - {item.get('file')}: {item.get('error')}")
        if len(failed_files) > 20:
            print(f"  … 另有 {len(failed_files) - 20} 条")

    skipped_files = result.get("skipped_files") or []
    if skipped_files and len(skipped_files) <= 20:
        print("跳过明细：")
        for item in skipped_files:
            print(f"  - {item.get('file')}: {item.get('reason')}")
    elif skipped_files:
        print(f"跳过明细：共 {len(skipped_files)} 个，已省略列表")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.concurrency < 1:
        print("错误：--concurrency 必须 >= 1", file=sys.stderr)
        return 1

    try:
        if args.mode == "local":
            if not args.input:
                raise ValueError("local 模式必须提供 -i/--input")
            input_path = Path(args.input).expanduser().resolve()
            result = convert_local(
                input_path=input_path,
                max_per_file=args.max_per_file,
                output=args.output,
                name_filter=args.name_filter,
            )
        else:
            base_url, api_key, auth_mode = resolve_remote_credentials(args)
            result = convert_remote(
                base_url=base_url,
                api_key=api_key,
                max_per_file=args.max_per_file,
                output=args.output,
                auth_mode=auth_mode,
                concurrency=args.concurrency,
                name_filter=args.name_filter,
            )
    except Exception as exc:  # noqa: BLE001
        print(f"错误：{exc}", file=sys.stderr)
        return 1

    print_result(result)
    return 0 if int(result.get("converted") or 0) > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
