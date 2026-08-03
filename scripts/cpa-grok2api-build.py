#!/usr/bin/env python3
"""CPA / CLIProxyAPI 与 GROK2API grok_build 账号双向转换

通过 --source / --target 指定方向，二者必填且不能相同：
  - --source cpa --target grok2api
  - --source grok2api --target cpa
  - --target 也可写 cliproxyapi，与 cpa 同义

模式：
  - local：读本地单文件或目录
  - remote：
      source=cpa 时从 CPA 管理接口拉 type=xai 认证文件
      source=grok2api 时用 Admin Bearer Token 调导出接口

CPA 输出文件名：从 grok2api 账号提取 ${provider}-${email}.json
  provider 中的下划线会转成中划线

鉴权说明：
  - CPA remote：Authorization Bearer 或 X-Management-Key
  - grok2api remote：管理接口仅接受 Authorization: Bearer <accessToken>
    accessToken 来自 POST /api/admin/v1/auth/login，或直接传已有 token
  - grok2api 导出：GET /api/admin/v1/accounts/export?provider=grok_build
    超 10000 时用 limit/afterId/snapshotMaxId 游标分批
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
G2A_PROVIDER_ALIASES = frozenset({"grok_build", "grok-build", "build", "xai", "grok"})

# 与 src/shared/account-convert.js 保持一致的 CPA xai 默认值
CPA_REDIRECT_URI = "http://127.0.0.1:56121/callback"
CPA_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token"
CPA_BASE_URL = "https://cli-chat-proxy.grok.com/v1"
CPA_DEFAULT_HEADERS = {
    "User-Agent": "grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-identifier": "grok-pager",
    "x-grok-client-version": "0.2.93",
}
DEFAULT_G2A_EXPORT_PAGE_SIZE = 1000
DEFAULT_G2A_PROVIDER = "grok_build"

# 转换格式标识
FORMAT_CPA = "cpa"
FORMAT_GROK2API = "grok2api"
FORMAT_CLIPROXYAPI = "cliproxyapi"


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


def is_g2a_account(data: Any) -> bool:
    """判断是否为 grok2api grok_build 账号条目"""
    if not isinstance(data, dict) or isinstance(data, list):
        return False
    access_token = first_non_empty(data.get("access_token"))
    refresh_token = first_non_empty(data.get("refresh_token"))
    if not access_token and not refresh_token:
        return False
    provider = normalize_provider(first_non_empty(data.get("provider"), data.get("type"), data.get("auth_type")))
    if provider in G2A_PROVIDER_ALIASES or provider == "grok_build":
        return True
    # 无 provider 时：有 client_id + token 且不是 CPA 特征字段齐全的，也当作 g2a
    if first_non_empty(data.get("client_id")) and not first_non_empty(data.get("token_endpoint")):
        return True
    return False


def is_g2a_document(data: Any) -> bool:
    if isinstance(data, dict) and isinstance(data.get("accounts"), list):
        return True
    return is_g2a_account(data)


def extract_g2a_accounts(data: Any) -> list[dict[str, Any]]:
    """从 grok2api 导出/导入 JSON 中提取账号列表

    兼容：
      {accounts:[...]}
      {data:{accounts:[...]}}
      {data:[...]}
      [...]
      单条账号对象
    """
    payload = unwrap_api_payload(data)
    # 若 unwrap 后仍是包装且内含 accounts，再取一次
    if isinstance(payload, dict) and "accounts" not in payload and isinstance(payload.get("data"), (dict, list)):
        payload = unwrap_api_payload(payload)

    if isinstance(payload, dict) and isinstance(payload.get("accounts"), list):
        return [item for item in payload["accounts"] if isinstance(item, dict)]
    if isinstance(data, dict) and isinstance(data.get("accounts"), list):
        return [item for item in data["accounts"] if isinstance(item, dict)]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        # 导出有时是 {items:[...]} / {list:[...]}
        for key in ("items", "list", "records", "rows"):
            if isinstance(payload.get(key), list):
                return [item for item in payload[key] if isinstance(item, dict)]
        # 单条账号
        if first_non_empty(payload.get("access_token"), payload.get("refresh_token"), payload.get("email")):
            return [payload]
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        return [data]
    return []


def g2a_to_cpa(account: dict[str, Any]) -> dict[str, Any]:
    """把单个 grok_build 账号转成 CPA xai 认证文件内容"""
    if not isinstance(account, dict):
        raise ValueError("账号内容必须是 JSON 对象")
    if not is_g2a_account(account):
        raise ValueError("非 grok2api grok_build 账号，已跳过")

    access_token = first_non_empty(account.get("access_token"))
    refresh_token = first_non_empty(account.get("refresh_token"))
    id_token = first_non_empty(account.get("id_token"))
    if not access_token and not refresh_token:
        raise ValueError("缺少 access_token 和 refresh_token")

    claims = decode_jwt_payload(access_token) or decode_jwt_payload(id_token)
    email = first_non_empty(
        account.get("email"),
        claims.get("email"),
        claims.get("preferred_username"),
        account.get("name"),
    )
    sub = first_non_empty(
        account.get("sub"),
        account.get("user_id"),
        account.get("principal_id"),
        claims.get("sub"),
        claims.get("principal_id"),
        claims.get("user_id"),
    )

    expired = normalize_expires_at(
        first_non_empty(
            account.get("expires_at"),
            account.get("expired"),
            claims.get("exp"),
        )
    )

    expires_in = account.get("expires_in")
    if expires_in is None or expires_in == "":
        exp = claims.get("exp")
        iat = claims.get("iat")
        try:
            if exp is not None and iat is not None:
                expires_in = int(exp) - int(iat)
            else:
                expires_in = None
        except (TypeError, ValueError):
            expires_in = None
    else:
        try:
            expires_in = int(expires_in)
        except (TypeError, ValueError):
            expires_in = None

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    record: dict[str, Any] = {
        "type": "xai",
        "auth_kind": "oauth",
        "email": email,
        "sub": sub,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "id_token": id_token,
        "token_type": first_non_empty(account.get("token_type"), "Bearer") or "Bearer",
        "expires_in": expires_in,
        "expired": expired,
        "last_refresh": now,
        "redirect_uri": CPA_REDIRECT_URI,
        "token_endpoint": CPA_TOKEN_ENDPOINT,
        "base_url": CPA_BASE_URL,
        "disabled": False,
        "headers": dict(CPA_DEFAULT_HEADERS),
    }
    return record


def normalize_provider_for_filename(provider: Any) -> str:
    """provider 用于文件名：去空白、下划线转中划线，非法字符剔除"""
    text = str(provider or "").strip()
    if not text:
        text = "xai"
    text = text.replace("_", "-")
    text = re.sub(r'[\x00-\x1f<>:"|?*\\/]', "", text)
    text = text.strip("-. ") or "xai"
    return text


def extract_email_for_filename(data: dict[str, Any]) -> str:
    """从账号数据提取 email，缺失时回退 sub / user_id / name"""
    email = first_non_empty(
        data.get("email"),
        data.get("sub"),
        data.get("user_id"),
        data.get("name"),
        "unknown",
    )
    safe = sanitize_json_filename(email)
    if not safe:
        safe = "unknown"
    if safe.lower().endswith(".json"):
        safe = safe[:-5]
    return safe or "unknown"


def cpa_account_filename(
    cpa_data: dict[str, Any],
    used: set[str] | None = None,
    source_account: dict[str, Any] | None = None,
) -> str:
    """生成 ${provider}-${email}.json

    provider / email 优先取自 grok2api 源账号，否则取自转换后的 CPA 数据
    provider 下划线转中划线；冲突时追加 -2、-3…
    """
    src = source_account if isinstance(source_account, dict) else {}
    provider = first_non_empty(
        src.get("provider"),
        src.get("type"),
        cpa_data.get("type"),
        cpa_data.get("provider"),
        "xai",
    )
    provider_part = normalize_provider_for_filename(provider)
    email_src = src if src else cpa_data
    email_part = extract_email_for_filename(email_src)
    # 若 email 已带 provider- 前缀则不再重复拼接
    email_lower = email_part.lower()
    provider_lower = provider_part.lower()
    if email_lower == provider_lower or email_lower.startswith(f"{provider_lower}-"):
        base = email_part
    else:
        base = f"{provider_part}-{email_part}"
    name = f"{base}.json"
    if used is None:
        return name
    if name not in used:
        used.add(name)
        return name
    idx = 2
    while True:
        candidate = f"{base}-{idx}.json"
        if candidate not in used:
            used.add(candidate)
            return candidate
        idx += 1


def write_cpa_files(
    records: list[dict[str, Any]],
    output_dir: Path,
    source_accounts: list[dict[str, Any]] | None = None,
) -> list[Path]:
    """每个 CPA 账号写独立文件，文件名为 ${provider}-${email}.json"""
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    used: set[str] = set()
    written: list[Path] = []
    sources = source_accounts or []
    for idx, record in enumerate(records):
        source = sources[idx] if idx < len(sources) else None
        filename = cpa_account_filename(record, used=used, source_account=source)
        path = output_dir / filename
        with path.open("w", encoding="utf-8", newline="\n") as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
            f.write("\n")
        written.append(path)
        print(f"  已写入 → {path}")
    return written


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
# g2a-to-cpa：本地 / 远端
# ---------------------------------------------------------------------------


def resolve_cpa_output_dir(output: str | None, input_path: Path | None = None) -> Path:
    if output:
        path = Path(output).expanduser().resolve()
        if path.suffix.lower() == ".json" and not path.is_dir():
            # 反向转换输出是目录下多个文件；若误传文件路径则用其父目录
            path = path.parent
        path.mkdir(parents=True, exist_ok=True)
        return path
    if input_path is not None:
        base = input_path.parent if input_path.is_file() else input_path
        out = (base / "cpa-accounts").resolve()
        out.mkdir(parents=True, exist_ok=True)
        return out
    out = (Path.cwd() / "cpa-accounts").resolve()
    out.mkdir(parents=True, exist_ok=True)
    return out


def convert_g2a_local(
    input_path: Path,
    output: str | None,
    name_filter: re.Pattern[str] | None = None,
) -> dict[str, Any]:
    candidates = collect_local_candidate_files(input_path, name_filter=name_filter)
    if not candidates:
        if name_filter is not None:
            raise FileNotFoundError(f"未找到匹配 --name-filter 的 json 文件：{input_path}")
        raise FileNotFoundError(f"未找到可扫描的 json 文件：{input_path}")

    records: list[dict[str, Any]] = []
    source_accounts: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []
    total = len(candidates)
    filter_desc = name_filter.pattern if name_filter is not None else "全部 .json 文件"
    print(f"[grok2api→cpa/local] 候选文件 {total} 个，过滤规则：{filter_desc}")
    print("[grok2api→cpa/local] 开始解析 grok2api 账号并转换为 CPA")
    print_progress(0, total, prefix="进度 ")

    for idx, file_path in enumerate(candidates, start=1):
        try:
            with file_path.open("r", encoding="utf-8-sig") as f:
                data = json.load(f)
            accounts = extract_g2a_accounts(data)
            if not accounts:
                skipped.append({"file": file_path.name, "reason": "未找到账号条目"})
            else:
                for account in accounts:
                    try:
                        if not is_g2a_account(account):
                            skipped.append(
                                {
                                    "file": file_path.name,
                                    "reason": "非 grok_build 账号条目",
                                }
                            )
                            continue
                        records.append(g2a_to_cpa(account))
                        source_accounts.append(account)
                    except Exception as exc:  # noqa: BLE001
                        label = first_non_empty(account.get("email"), account.get("name"), "item")
                        failed.append({"file": f"{file_path.name}:{label}", "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            failed.append({"file": file_path.name, "error": str(exc)})
        print_progress(idx, total, prefix="进度 ")

    if not records:
        details = []
        details.extend(f'{item["file"]}: {item["error"]}' for item in failed[:5])
        details.extend(f'{item["file"]}: {item["reason"]}' for item in skipped[:5])
        message = "没有可转换的 grok2api 账号"
        if details:
            message = f"{message}。示例：{'; '.join(details)}"
        raise RuntimeError(message)

    out_dir = resolve_cpa_output_dir(output, input_path=input_path)
    print(f"[grok2api→cpa/local] 输出目录：{out_dir}")
    written = write_cpa_files(records, out_dir, source_accounts=source_accounts)
    return {
        "source": FORMAT_GROK2API,
        "target": FORMAT_CPA,
        "mode": "local",
        "input": str(input_path),
        "name_filter": name_filter.pattern if name_filter is not None else "",
        "outputs": [str(p) for p in written],
        "output_dir": str(out_dir),
        "candidate_files": total,
        "converted": len(records),
        "skipped": len(skipped),
        "failed": len(failed),
        "failed_files": failed,
        "skipped_files": skipped,
        "parts": len(written),
    }


def normalize_g2a_base_url(raw: str) -> str:
    value = str(raw or "").strip()
    if not value:
        raise ValueError("grok2api 服务地址不能为空")
    if not re.match(r"^https?://", value, re.IGNORECASE):
        value = f"https://{value}"
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("grok2api 服务地址仅支持 HTTP/HTTPS")
    path = parsed.path.rstrip("/")
    # 允许用户传入带 /api/admin/v1 的地址，统一剥掉
    for suffix in ("/api/admin/v1", "/api/admin", "/api"):
        if path.lower().endswith(suffix):
            path = path[: -len(suffix)]
            break
    path = path.rstrip("/")
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def g2a_http_request(
    url: str,
    access_token: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    accept: str = "application/json",
    timeout: int = REQUEST_TIMEOUT_SEC,
    max_attempts: int = REQUEST_MAX_ATTEMPTS,
) -> tuple[Any, dict[str, str], int]:
    """grok2api 管理接口请求：仅 Authorization Bearer

    返回 data、响应头字典、HTTP 状态码
    """
    token = str(access_token or "").strip()
    if not token:
        raise ValueError("grok2api Admin accessToken 不能为空")
    # 允许用户误传 "Bearer xxx"
    if token.lower().startswith("bearer "):
        token = token[7:].strip()

    last_error: Exception | None = None
    payload = None
    headers_base = {
        "Accept": accept,
        "Authorization": f"Bearer {token}",
        "User-Agent": "cpa-grok2api-build/1.0",
    }
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers_base["Content-Type"] = "application/json"

    for attempt in range(1, max_attempts + 1):
        req = urllib.request.Request(url, data=payload, headers=headers_base, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                text = raw.decode("utf-8-sig", errors="replace")
                data = parse_response_body(text)
                header_map = {k.lower(): v for k, v in resp.headers.items()}
                return data, header_map, resp.status
        except urllib.error.HTTPError as exc:
            body_text = ""
            try:
                body_text = exc.read().decode("utf-8", errors="replace")
            except Exception:
                body_text = ""
            last_error = RuntimeError(f"HTTP {exc.code}: {body_text or exc.reason}")
            if exc.code in (401, 403):
                raise RuntimeError(
                    f"grok2api 管理鉴权失败，请检查 Admin accessToken。"
                    f" 管理接口要求 Authorization: Bearer <accessToken>。"
                    f" 详情：{last_error}"
                ) from exc
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

    raise RuntimeError(f"grok2api 请求失败：{last_error}")


def unwrap_api_payload(data: Any) -> Any:
    """解开常见 API 包装：{data: {...}} / {result: {...}} / {payload: {...}}"""
    if not isinstance(data, dict):
        return data
    for key in ("data", "result", "payload", "body"):
        inner = data.get(key)
        if isinstance(inner, (dict, list)):
            return inner
    return data


def extract_access_token_from_login(data: Any) -> str:
    """从 login 响应提取 accessToken

    兼容多种形态，例如：
      {tokens:{accessToken}}
      {data:{tokens:{accessToken}}}   ← 浏览器实际返回
      {data:{accessToken}}
      {accessToken}
    """
    if not isinstance(data, dict):
        return ""

    candidates: list[dict[str, Any]] = [data]
    # 一层包装
    for key in ("data", "result", "payload", "body"):
        inner = data.get(key)
        if isinstance(inner, dict):
            candidates.append(inner)
            # 再剥一层，如 data.result
            for key2 in ("data", "result", "payload", "body"):
                nested = inner.get(key2)
                if isinstance(nested, dict):
                    candidates.append(nested)

    for obj in candidates:
        direct = first_non_empty(
            obj.get("accessToken"),
            obj.get("access_token"),
            obj.get("token"),
        )
        if direct:
            return direct
        tokens = obj.get("tokens")
        if isinstance(tokens, dict):
            nested = first_non_empty(
                tokens.get("accessToken"),
                tokens.get("access_token"),
                tokens.get("token"),
            )
            if nested:
                return nested
        # 个别实现把 tokens 放成 list
        if isinstance(tokens, list):
            for item in tokens:
                if not isinstance(item, dict):
                    continue
                nested = first_non_empty(
                    item.get("accessToken"),
                    item.get("access_token"),
                    item.get("token"),
                )
                if nested:
                    return nested
    return ""


def g2a_login(base_url: str, username: str, password: str) -> str:
    """POST /api/admin/v1/auth/login，返回 accessToken"""
    root = normalize_g2a_base_url(base_url)
    user = str(username or "").strip()
    pwd = str(password or "")
    if not user or not pwd:
        raise ValueError("grok2api 登录需要用户名与密码")
    url = f"{root}/api/admin/v1/auth/login"
    payload = json.dumps({"username": user, "password": pwd}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "cpa-grok2api-build/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
            raw = resp.read().decode("utf-8-sig", errors="replace")
            data = parse_response_body(raw)
    except urllib.error.HTTPError as exc:
        body_text = ""
        try:
            body_text = exc.read().decode("utf-8", errors="replace")
        except Exception:
            body_text = ""
        raise RuntimeError(f"grok2api 登录失败 HTTP {exc.code}: {body_text or exc.reason}") from exc
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"grok2api 登录失败：{exc}") from exc

    token = extract_access_token_from_login(data)
    if not token:
        # 给出结构提示，便于排查，但不泄露 token 值
        top_keys = list(data.keys()) if isinstance(data, dict) else type(data).__name__
        raise RuntimeError(
            f"grok2api 登录成功但响应中无 accessToken。"
            f" 期望路径 data.tokens.accessToken 或 tokens.accessToken，"
            f" 当前顶层字段：{top_keys}"
        )
    return token


class Grok2ApiRemoteClient:
    """grok2api 管理端客户端

    认证：Authorization: Bearer <admin accessToken>
    导出：GET /api/admin/v1/accounts/export
    """

    def __init__(self, base_url: str, access_token: str, provider: str = DEFAULT_G2A_PROVIDER) -> None:
        self.base_url = normalize_g2a_base_url(base_url)
        self.access_token = str(access_token or "").strip()
        self.provider = first_non_empty(provider, DEFAULT_G2A_PROVIDER) or DEFAULT_G2A_PROVIDER
        if not self.access_token:
            raise ValueError("grok2api Admin accessToken 不能为空")

    def _url(self, path: str, query: dict[str, Any] | None = None) -> str:
        base = f"{self.base_url}{path}"
        if not query:
            return base
        return f"{base}?{urllib.parse.urlencode(query)}"

    def verify(self) -> dict[str, Any]:
        """验证 token：优先 GET /api/admin/v1/me，失败则试导出 limit=1"""
        me_url = self._url("/api/admin/v1/me")
        try:
            data, _, _ = g2a_http_request(me_url, self.access_token)
            payload = unwrap_api_payload(data)
            admin = payload if isinstance(payload, dict) else {}
            # me 可能是 {admin:{...}} 或直接 admin 字段
            if isinstance(admin.get("admin"), dict):
                admin = admin["admin"]
            return {
                "base_url": self.base_url,
                "auth": "bearer",
                "admin": admin if isinstance(admin, dict) else {},
                "via": "me",
            }
        except Exception as me_error:  # noqa: BLE001
            # 兼容部分部署未暴露 /me 的情况
            export_url = self._url(
                "/api/admin/v1/accounts/export",
                {"provider": self.provider, "limit": 1, "afterId": "0"},
            )
            try:
                _, headers, _ = g2a_http_request(export_url, self.access_token)
                return {
                    "base_url": self.base_url,
                    "auth": "bearer",
                    "admin": {},
                    "via": "export",
                    "exported": headers.get("x-exported-accounts", ""),
                    "me_error": str(me_error),
                }
            except Exception as export_error:  # noqa: BLE001
                raise RuntimeError(
                    f"grok2api 验证失败。/me：{me_error}；export：{export_error}"
                ) from export_error

    def export_all_accounts(self, page_size: int = DEFAULT_G2A_EXPORT_PAGE_SIZE) -> list[dict[str, Any]]:
        """游标导出全部账号凭据，合并为账号列表"""
        limit = max(1, min(int(page_size or DEFAULT_G2A_EXPORT_PAGE_SIZE), MAX_PER_FILE))
        after_id = "0"
        snapshot_max_id = "0"
        all_accounts: list[dict[str, Any]] = []
        page = 0

        while True:
            page += 1
            query = {
                "provider": self.provider,
                "limit": limit,
                "afterId": after_id,
                "snapshotMaxId": snapshot_max_id,
            }
            url = self._url("/api/admin/v1/accounts/export", query)
            data, headers, _ = g2a_http_request(url, self.access_token, accept="*/*")
            batch = extract_g2a_accounts(data)
            all_accounts.extend(batch)
            exported = headers.get("x-exported-accounts") or str(len(batch))
            has_more = str(headers.get("x-export-has-more", "")).lower() in ("1", "true", "yes")
            next_id = headers.get("x-export-next-id") or ""
            snap = headers.get("x-export-snapshot-max-id") or snapshot_max_id
            print(
                f"[grok2api→cpa/remote] 第 {page} 批导出 {exported} 条，"
                f"累计 {len(all_accounts)}，has_more={has_more}"
            )
            if not has_more or not next_id:
                # 若服务端未开游标头且本批为空，结束
                if not batch and page > 1:
                    break
                if not has_more:
                    break
                # 无游标信息时，尝试一次全量导出兜底后结束
                if page == 1 and not next_id:
                    break
                break
            after_id = next_id
            snapshot_max_id = snap or snapshot_max_id

        # 若游标首批为空，再试一次不分页全量导出
        if not all_accounts:
            url = self._url("/api/admin/v1/accounts/export", {"provider": self.provider})
            data, headers, _ = g2a_http_request(url, self.access_token, accept="*/*")
            all_accounts = extract_g2a_accounts(data)
            print(f"[grok2api→cpa/remote] 全量导出 {headers.get('x-exported-accounts') or len(all_accounts)} 条")
        return all_accounts


def convert_g2a_remote(
    base_url: str,
    access_token: str,
    output: str | None,
    provider: str = DEFAULT_G2A_PROVIDER,
    page_size: int = DEFAULT_G2A_EXPORT_PAGE_SIZE,
) -> dict[str, Any]:
    client = Grok2ApiRemoteClient(base_url=base_url, access_token=access_token, provider=provider)
    print("[grok2api→cpa/remote] 正在验证 grok2api 服务地址与 Admin Token")
    verify_result = client.verify()
    via = verify_result.get("via")
    admin = verify_result.get("admin") or {}
    admin_name = first_non_empty(admin.get("username"), admin.get("id"), "")
    extra = f"，管理员 {admin_name}" if admin_name else ""
    print(f"[grok2api→cpa/remote] 验证成功，鉴权 Bearer，校验方式 {via}{extra}")

    print(f"[grok2api→cpa/remote] 开始导出 provider={client.provider}")
    accounts = client.export_all_accounts(page_size=page_size)
    if not accounts:
        raise RuntimeError("远端没有可导出的 grok2api 账号")

    records: list[dict[str, Any]] = []
    source_accounts: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []
    total = len(accounts)
    print(f"[grok2api→cpa/remote] 开始转换为 CPA，共 {total} 条")
    print_progress(0, total, prefix="进度 ")
    for idx, account in enumerate(accounts, start=1):
        label = first_non_empty(account.get("email"), account.get("name"), f"#{idx}")
        try:
            if not is_g2a_account(account):
                skipped.append({"file": label, "reason": "非 grok_build 账号条目"})
            else:
                records.append(g2a_to_cpa(account))
                source_accounts.append(account)
        except Exception as exc:  # noqa: BLE001
            failed.append({"file": label, "error": str(exc)})
        print_progress(idx, total, prefix="进度 ")

    if not records:
        details = []
        details.extend(f'{item["file"]}: {item["error"]}' for item in failed[:5])
        details.extend(f'{item["file"]}: {item["reason"]}' for item in skipped[:5])
        message = "远端没有可转换的 grok2api 账号"
        if details:
            message = f"{message}。示例：{'; '.join(details)}"
        raise RuntimeError(message)

    out_dir = resolve_cpa_output_dir(output, input_path=None)
    print(f"[grok2api→cpa/remote] 输出目录：{out_dir}")
    written = write_cpa_files(records, out_dir, source_accounts=source_accounts)
    return {
        "source": FORMAT_GROK2API,
        "target": FORMAT_CPA,
        "mode": "remote",
        "base_url": client.base_url,
        "auth_mode": "bearer",
        "provider": client.provider,
        "outputs": [str(p) for p in written],
        "output_dir": str(out_dir),
        "exported_accounts": total,
        "converted": len(records),
        "skipped": len(skipped),
        "failed": len(failed),
        "failed_files": failed,
        "skipped_files": skipped,
        "parts": len(written),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def normalize_format_name(raw: str | None, flag: str) -> str:
    """规范化 --source / --target：必填，映射别名到 cpa / grok2api"""
    text = str(raw or "").strip().lower().replace("_", "-")
    if not text:
        raise argparse.ArgumentTypeError(f"{flag} 不能为空")
    cpa_aliases = {
        "cpa",
        "cliproxyapi",
        "cli-proxy-api",
        "cliproxy",
        "cli-proxy",
    }
    g2a_aliases = {
        "grok2api",
        "grok-2-api",
        "g2a",
        "grok-build",
        "grokbuild",
        "grok_build",
    }
    # 兼容用户写成 grok_build
    text_us = str(raw or "").strip().lower().replace("-", "_")
    if text in cpa_aliases or text_us in {"cliproxyapi", "cpa"}:
        return FORMAT_CPA
    if text in g2a_aliases or text_us in {"grok2api", "g2a", "grok_build", "grokbuild"}:
        return FORMAT_GROK2API
    raise argparse.ArgumentTypeError(f"{flag} 仅支持 cpa / cliproxyapi / grok2api，当前为 {raw!r}")


def parse_source(raw: str) -> str:
    return normalize_format_name(raw, "--source")


def parse_target(raw: str) -> str:
    return normalize_format_name(raw, "--target")


def resolve_convert_route(source: str, target: str) -> str:
    """校验 source/target 非空且不同，返回内部路由键"""
    src = str(source or "").strip().lower()
    tgt = str(target or "").strip().lower()
    if not src:
        raise ValueError("--source 不能为空")
    if not tgt:
        raise ValueError("--target 不能为空")
    if src == tgt:
        raise ValueError(f"--source 与 --target 不能相同，当前均为 {src}")
    if src == FORMAT_CPA and tgt == FORMAT_GROK2API:
        return "cpa-to-g2a"
    if src == FORMAT_GROK2API and tgt == FORMAT_CPA:
        return "g2a-to-cpa"
    raise ValueError(f"不支持的转换：--source {src} --target {tgt}。" f" 仅支持 cpa↔grok2api")


def parse_page_size(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--g2a-page-size 必须是整数") from exc
    if value < MIN_PER_FILE or value > MAX_PER_FILE:
        raise argparse.ArgumentTypeError(f"--g2a-page-size 必须在 {MIN_PER_FILE}~{MAX_PER_FILE} 之间，当前为 {value}")
    return value


def build_parser() -> argparse.ArgumentParser:
    prog = Path(sys.argv[0]).name or "cpa-grok2api-build.py"
    parser = argparse.ArgumentParser(
        prog=prog,
        description=(
            "CPA / CLIProxyAPI 与 GROK2API grok_build 账号双向转换。"
            " 用 --source 与 --target 指定方向，二者必填且不能相同"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""示例:
  # CPA → grok2api：本地单文件
  python {prog} --source cpa --target grok2api --mode local -i ./account.json -o ./out.json

  # CPA → grok2api：本地目录，每文件最多 500 个
  python {prog} --source cpa --target grok2api --mode local -i ./accounts -o ./export/ --max-per-file 500

  # CPA → grok2api：远端 CPA 管理接口
  python {prog} --source cpa --target grok2api --mode remote \\
    --cpa-url https://cpa.example.com \\
    --cpa-key YOUR_MANAGEMENT_KEY \\
    -o ./grok2api-build-accounts.json

  # grok2api → CPA：本地导出 JSON，输出 ${{provider}}-${{email}}.json
  python {prog} --source grok2api --target cpa --mode local \\
    -i ./grok2api-build-accounts.json -o ./cpa-accounts/

  # grok2api → cliproxyapi：与 target=cpa 同义
  python {prog} --source grok2api --target cliproxyapi --mode local \\
    -i ./export.json -o ./cpa-accounts/

  # grok2api → CPA：远端 Admin Token 导出
  python {prog} --source grok2api --target cpa --mode remote \\
    --g2a-url https://g2a.example.com \\
    --g2a-token YOUR_ADMIN_ACCESS_TOKEN \\
    -o ./cpa-accounts/

  # grok2api → CPA：远端用户名密码登录后导出
  python {prog} --source grok2api --target cpa --mode remote \\
    --g2a-url https://g2a.example.com \\
    --g2a-username admin --g2a-password secret \\
    -o ./cpa-accounts/
""",
    )
    parser.add_argument(
        "--source",
        type=parse_source,
        required=True,
        help="源格式：cpa / cliproxyapi / grok2api，不能为空，且须与 --target 不同",
    )
    parser.add_argument(
        "--target",
        type=parse_target,
        required=True,
        help="目标格式：cpa / cliproxyapi / grok2api，不能为空，且须与 --source 不同",
    )
    parser.add_argument(
        "--mode",
        choices=["local", "remote"],
        default="local",
        help="运行模式：local 读本地文件，remote 调远端 API",
    )
    parser.add_argument(
        "-i",
        "--input",
        default=None,
        help="local 模式必填：输入文件或包含 json 的目录",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help=(
            "source=cpa 时：输出文件或目录，目录下生成 grok2api-build-accounts*.json；"
            "source=grok2api 时：输出目录，每个账号写 ${provider}-${email}.json"
        ),
    )
    parser.add_argument(
        "--max-per-file",
        type=parse_max_per_file,
        default=DEFAULT_MAX_PER_FILE,
        help=(
            f"仅 cpa→grok2api：单个输出文件最多账号数，"
            f"范围 {MIN_PER_FILE}~{MAX_PER_FILE}，默认 {DEFAULT_MAX_PER_FILE}"
        ),
    )
    parser.add_argument(
        "--name-filter",
        type=parse_name_filter,
        default=None,
        help="可选文件名正则过滤。未指定时扫描全部 .json",
    )
    parser.add_argument(
        "--cpa-url",
        default=None,
        help="source=cpa remote：CPA 服务地址，默认读 CPA_BASE_URL",
    )
    parser.add_argument(
        "--cpa-key",
        default=None,
        help="source=cpa remote：CPA 管理密钥，默认读 CPA_MANAGEMENT_KEY",
    )
    parser.add_argument(
        "--cpa-auth-mode",
        choices=["auto", "bearer", "x-management-key"],
        default="auto",
        help="source=cpa remote 鉴权方式，默认 auto：先 Bearer 再 X-Management-Key",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=DEFAULT_DOWNLOAD_CONCURRENCY,
        help=f"source=cpa remote 下载并发数，默认 {DEFAULT_DOWNLOAD_CONCURRENCY}",
    )
    parser.add_argument(
        "--g2a-url",
        default=None,
        help="source=grok2api remote：服务地址，默认读 G2A_BASE_URL 或 GROK2API_BASE_URL",
    )
    parser.add_argument(
        "--g2a-token",
        default=None,
        help=("source=grok2api remote：Admin accessToken，" "默认读 G2A_TOKEN / GROK2API_TOKEN / G2A_ACCESS_TOKEN"),
    )
    parser.add_argument(
        "--g2a-username",
        default=None,
        help="source=grok2api remote：无 token 时用管理员用户名登录，默认读 G2A_USERNAME",
    )
    parser.add_argument(
        "--g2a-password",
        default=None,
        help="source=grok2api remote：管理员密码，默认读 G2A_PASSWORD",
    )
    parser.add_argument(
        "--g2a-provider",
        default=DEFAULT_G2A_PROVIDER,
        help=f"source=grok2api remote 导出 provider，默认 {DEFAULT_G2A_PROVIDER}",
    )
    parser.add_argument(
        "--g2a-page-size",
        type=parse_page_size,
        default=DEFAULT_G2A_EXPORT_PAGE_SIZE,
        help=(
            f"source=grok2api remote 导出分页大小，"
            f"范围 {MIN_PER_FILE}~{MAX_PER_FILE}，默认 {DEFAULT_G2A_EXPORT_PAGE_SIZE}"
        ),
    )
    return parser


def resolve_cpa_remote_credentials(args: argparse.Namespace) -> tuple[str, str, str | None]:
    base_url = first_non_empty(args.cpa_url, os.environ.get("CPA_BASE_URL"))
    api_key = first_non_empty(args.cpa_key, os.environ.get("CPA_MANAGEMENT_KEY"))
    if not base_url:
        raise ValueError("source=cpa remote 需要 --cpa-url 或环境变量 CPA_BASE_URL")
    if not api_key:
        raise ValueError("source=cpa remote 需要 --cpa-key 或环境变量 CPA_MANAGEMENT_KEY")
    auth_mode = None if args.cpa_auth_mode == "auto" else args.cpa_auth_mode
    return base_url, api_key, auth_mode


def resolve_g2a_remote_credentials(args: argparse.Namespace) -> tuple[str, str]:
    base_url = first_non_empty(
        args.g2a_url,
        os.environ.get("G2A_BASE_URL"),
        os.environ.get("GROK2API_BASE_URL"),
    )
    if not base_url:
        raise ValueError("source=grok2api remote 需要 --g2a-url 或环境变量 G2A_BASE_URL / GROK2API_BASE_URL")

    token = first_non_empty(
        args.g2a_token,
        os.environ.get("G2A_TOKEN"),
        os.environ.get("GROK2API_TOKEN"),
        os.environ.get("G2A_ACCESS_TOKEN"),
        os.environ.get("GROK2API_ACCESS_TOKEN"),
    )
    if token:
        return base_url, token

    username = first_non_empty(args.g2a_username, os.environ.get("G2A_USERNAME"))
    password = first_non_empty(args.g2a_password, os.environ.get("G2A_PASSWORD"))
    if not username or not password:
        raise ValueError("source=grok2api remote 需要 --g2a-token，或 --g2a-username 与 --g2a-password 登录")
    print("[grok2api→cpa/remote] 未提供 token，正在用用户名密码登录")
    token = g2a_login(base_url, username, password)
    print("[grok2api→cpa/remote] 登录成功，已取得 accessToken")
    return base_url, token


def print_result(result: dict[str, Any]) -> None:
    source = result.get("source") or ""
    target = result.get("target") or ""
    mode = result.get("mode")
    print("转换完成")
    print(f"源：{source}")
    print(f"目标：{target}")
    print(f"模式：{mode}")

    if source == FORMAT_GROK2API and target == FORMAT_CPA:
        if mode == "local":
            print(f"输入：{result.get('input')}")
            print(f"候选文件：{result.get('candidate_files')}")
            if result.get("name_filter"):
                print(f"文件名过滤：{result.get('name_filter')}")
        else:
            print(f"grok2api：{result.get('base_url')}")
            print(f"鉴权：{result.get('auth_mode')}")
            print(f"provider：{result.get('provider')}")
            print(f"导出账号：{result.get('exported_accounts')}")
        print(f"成功转换 CPA 文件：{result.get('converted')}")
        print(f"跳过：{result.get('skipped')}")
        print(f"失败：{result.get('failed')}")
        print(f"输出目录：{result.get('output_dir')}")
        print(f"写出文件数：{result.get('parts')}")
    else:
        if mode == "local":
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
        route = resolve_convert_route(args.source, args.target)
        if route == "g2a-to-cpa":
            if args.mode == "local":
                if not args.input:
                    raise ValueError("source=grok2api local 必须提供 -i/--input")
                input_path = Path(args.input).expanduser().resolve()
                result = convert_g2a_local(
                    input_path=input_path,
                    output=args.output,
                    name_filter=args.name_filter,
                )
            else:
                base_url, access_token = resolve_g2a_remote_credentials(args)
                result = convert_g2a_remote(
                    base_url=base_url,
                    access_token=access_token,
                    output=args.output,
                    provider=args.g2a_provider,
                    page_size=args.g2a_page_size,
                )
            # 保留用户原始 target 文案语义：cliproxyapi 也归一为 cpa
            result = {**result, "source": FORMAT_GROK2API, "target": FORMAT_CPA}
        else:
            if args.mode == "local":
                if not args.input:
                    raise ValueError("source=cpa local 必须提供 -i/--input")
                input_path = Path(args.input).expanduser().resolve()
                result = convert_local(
                    input_path=input_path,
                    max_per_file=args.max_per_file,
                    output=args.output,
                    name_filter=args.name_filter,
                )
            else:
                base_url, api_key, auth_mode = resolve_cpa_remote_credentials(args)
                result = convert_remote(
                    base_url=base_url,
                    api_key=api_key,
                    max_per_file=args.max_per_file,
                    output=args.output,
                    auth_mode=auth_mode,
                    concurrency=args.concurrency,
                    name_filter=args.name_filter,
                )
            result = {**result, "source": FORMAT_CPA, "target": FORMAT_GROK2API}
    except Exception as exc:  # noqa: BLE001
        print(f"错误：{exc}", file=sys.stderr)
        return 1

    print_result(result)
    return 0 if int(result.get("converted") or 0) > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
