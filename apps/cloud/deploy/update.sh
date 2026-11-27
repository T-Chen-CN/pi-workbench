#!/usr/bin/env bash
# Pi Cloud 按需拉取更新脚本（Pull 模式，服务器零构建；手动触发，不设定时自动重启）：
# 1. 拉取 GitHub Release (cloud-latest) 的 pi-cloud-manifest.json，对比已安装 sha256；
# 2. 有新版才下载 manifest.asset 指定的带版本号不可变压缩包，严格校验 SHA-256 与可选构建溯源签名；
# 3. 安全解压到 /opt/pi-cloud/releases/<releaseId>，更新前做 SQLite 快照，原子替换 current 软链并重启；
# 4. 轮询 /v1/health（20s），失败自动原子回滚到旧版本并复检回滚后的健康状态；
# 5. 自动清理陈旧版本（默认保留最近 5 个，永不删 current 与上一回滚点）。
set -euo pipefail

REPO="${PI_CLOUD_REPO:-T-Chen-CN/pi-workbench}"
RELEASE_TAG="${PI_CLOUD_RELEASE_TAG:-cloud-latest}"
ROOT_DIR="${PI_CLOUD_ROOT:-/opt/pi-cloud}"
RELEASES_DIR="${ROOT_DIR}/releases"
CURRENT_LINK="${ROOT_DIR}/current"
DATA_DIR="${PI_CLOUD_DATA_DIR:-/var/lib/pi-cloud}"
BACKUP_DIR="${PI_CLOUD_BACKUP_DIR:-/var/backups/pi-cloud}"
SERVICE_NAME="${PI_CLOUD_SERVICE:-pi-cloud}"
SERVICE_USER="${PI_CLOUD_USER:-pi-cloud}"
HEALTH_URL="${PI_CLOUD_HEALTH_URL:-http://127.0.0.1:8787/v1/health}"
KEEP_RELEASES="${PI_CLOUD_KEEP_RELEASES:-5}"
LOCK_FILE="${PI_CLOUD_UPDATE_LOCK:-/run/pi-cloud-update.lock}"
VERIFY_ATTESTATION="${PI_CLOUD_VERIFY_ATTESTATION:-auto}"

DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    *)
      echo "usage: $0 [--dry-run] [--force]" >&2
      exit 2
      ;;
  esac
done

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[pi-cloud-update] another update is already running, skipping"
  exit 0
fi

BASE_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}"
MANIFEST_CURL_ARGS=(-sSL --connect-timeout 10 --max-time 30 --retry 2 --retry-delay 2)
CURL_ARGS=(-fsSL --connect-timeout 10 --retry 2 --retry-delay 2)
if [ -n "${PI_CLOUD_GITHUB_TOKEN:-}" ]; then
  MANIFEST_CURL_ARGS+=(-H "Authorization: Bearer ${PI_CLOUD_GITHUB_TOKEN}")
  CURL_ARGS+=(-H "Authorization: Bearer ${PI_CLOUD_GITHUB_TOKEN}")
fi

TMP_DIR="$(mktemp -d /tmp/pi-cloud-update.XXXXXX)"
trap 'rm -rf "$TMP_DIR"; rm -f "${CURRENT_LINK}.tmp"' EXIT

atomic_swap_current() {
  local target="$1"
  rm -f "${CURRENT_LINK}.tmp"
  ln -s "$target" "${CURRENT_LINK}.tmp" && mv -Tf "${CURRENT_LINK}.tmp" "$CURRENT_LINK"
}

wait_for_health() {
  local attempt body
  for attempt in $(seq 1 20); do
    body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
    if [ -n "$body" ] && node -e '
      const h = JSON.parse(process.argv[1]);
      if (h.ok !== true) process.exit(1);
      // 已配置模型时必须等 Agent 会话就绪（ready === true），避免损坏的 SDK/SQLite 版本通过健康检查
      if (h.hasConfig === true && h.ready !== true) process.exit(1);
    ' "$body" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

verify_bundle_attestation() {
  local archive="$1"
  case "$VERIFY_ATTESTATION" in
    0|false|no)
      return 0
      ;;
    1|true|yes)
      if ! command -v gh >/dev/null 2>&1; then
        echo "[pi-cloud-update] PI_CLOUD_VERIFY_ATTESTATION=1 requires GitHub CLI (gh)" >&2
        exit 1
      fi
      echo "[pi-cloud-update] verifying build provenance attestation via gh..."
      GH_TOKEN="${PI_CLOUD_GITHUB_TOKEN:-${GH_TOKEN:-}}" \
        gh attestation verify "$archive" --repo "$REPO"
      ;;
    *)
      if command -v gh >/dev/null 2>&1; then
        if [ -n "${PI_CLOUD_GITHUB_TOKEN:-${GH_TOKEN:-}}" ] || gh auth status >/dev/null 2>&1; then
          echo "[pi-cloud-update] verifying build provenance attestation via gh..."
          GH_TOKEN="${PI_CLOUD_GITHUB_TOKEN:-${GH_TOKEN:-}}" \
            gh attestation verify "$archive" --repo "$REPO"
        else
          echo "[pi-cloud-update] gh CLI not authenticated; skipping provenance attestation (set PI_CLOUD_VERIFY_ATTESTATION=1 to enforce)"
        fi
      fi
      ;;
  esac
}

MANIFEST_FILE="${TMP_DIR}/manifest.json"
HTTP_CODE="$(curl "${MANIFEST_CURL_ARGS[@]}" \
  -w '%{http_code}' -o "$MANIFEST_FILE" "${BASE_URL}/pi-cloud-manifest.json" || echo "000")"

if [ "$HTTP_CODE" = "404" ]; then
  echo "[pi-cloud-update] release ${RELEASE_TAG} not published yet (HTTP 404), skipping"
  exit 0
fi
if [ "$HTTP_CODE" != "200" ]; then
  echo "[pi-cloud-update] failed to fetch manifest (HTTP ${HTTP_CODE}) from ${BASE_URL}/pi-cloud-manifest.json" >&2
  exit 1
fi

# 使用 Node 24 解析并严格校验字段，不依赖 jq，同时防止路径穿越或命令注入
PARSED="$(node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const okId = typeof m.releaseId === "string" && /^[A-Za-z0-9._-]+$/.test(m.releaseId);
  const okSha = typeof m.sha256 === "string" && /^[a-f0-9]{64}$/.test(m.sha256);
  const okAsset = typeof m.asset === "string" && /^[A-Za-z0-9._-]+\.tar\.gz$/.test(m.asset);
  if (!okId || !okSha || !okAsset) {
    console.error("invalid manifest fields");
    process.exit(1);
  }
  console.log([m.releaseId, m.sha256, m.asset, m.shortSha || ""].join("\t"));
' "$MANIFEST_FILE")"

IFS=$'\t' read -r RELEASE_ID EXPECTED_SHA ASSET SHORT_SHA <<<"$PARSED"

INSTALLED_SHA=""
INSTALLED_ID=""
META_FILE="${CURRENT_LINK}/.cloud-release.json"
if [ -f "$META_FILE" ]; then
  INSTALLED_PAIR="$(node -e '
    const fs = require("fs");
    try {
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.log([m.sha256 || "", m.releaseId || ""].join("\t"));
    } catch {
      console.log("\t");
    }
  ' "$META_FILE")"
  IFS=$'\t' read -r INSTALLED_SHA INSTALLED_ID <<<"$INSTALLED_PAIR"
fi

if [ "$FORCE" -eq 0 ] && [ -n "$INSTALLED_SHA" ] && [ "$INSTALLED_SHA" = "$EXPECTED_SHA" ]; then
  echo "[pi-cloud-update] already up to date (${INSTALLED_ID:-$RELEASE_ID})"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[pi-cloud-update] dry-run: update available (${INSTALLED_ID:-unknown} -> ${RELEASE_ID}, asset=${ASSET}, sha256=${EXPECTED_SHA:0:12})"
  exit 0
fi

echo "[pi-cloud-update] downloading ${ASSET} for release ${RELEASE_ID} (${SHORT_SHA})..."
ARCHIVE_FILE="${TMP_DIR}/${ASSET}"
curl "${CURL_ARGS[@]}" --max-time 300 "${BASE_URL}/${ASSET}" -o "$ARCHIVE_FILE"

ACTUAL_SHA="$(sha256sum "$ARCHIVE_FILE" | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "[pi-cloud-update] sha256 mismatch: expected ${EXPECTED_SHA}, got ${ACTUAL_SHA}" >&2
  exit 1
fi

verify_bundle_attestation "$ARCHIVE_FILE"

PREV_TARGET=""
if [ -L "$CURRENT_LINK" ] || [ -e "$CURRENT_LINK" ]; then
  PREV_TARGET="$(readlink -f "$CURRENT_LINK" || true)"
fi

TARGET_DIR="${RELEASES_DIR}/${RELEASE_ID}"
if [ -e "$TARGET_DIR" ]; then
  TARGET_DIR="${RELEASES_DIR}/${RELEASE_ID}-$(date -u +%H%M%S)"
fi

mkdir -p "$TARGET_DIR"
# 以 root 解压不可信归档时必须禁用保留属主与特权位（setuid/setgid）
tar --no-same-owner --no-same-permissions -xzf "$ARCHIVE_FILE" -C "$TARGET_DIR"

if [ ! -f "${TARGET_DIR}/dist/main.js" ] || [ ! -f "${TARGET_DIR}/web/index.html" ]; then
  echo "[pi-cloud-update] extracted bundle missing dist/main.js or web/index.html" >&2
  rm -rf "$TARGET_DIR"
  exit 1
fi

cp "$MANIFEST_FILE" "${TARGET_DIR}/.cloud-release.json"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$TARGET_DIR"

# 重启前尽力为 SQLite 数据库留一份更新前快照，便于 schema/数据异常时快速恢复
if [ -f "${DATA_DIR}/cloud.db" ] && command -v sqlite3 >/dev/null 2>&1; then
  PRE_UPDATE_BACKUP="${BACKUP_DIR}/pre-update-$(date -u +%Y%m%dT%H%M%SZ).db"
  if mkdir -p "$BACKUP_DIR" 2>/dev/null && (umask 077 && sqlite3 "${DATA_DIR}/cloud.db" ".timeout 5000" ".backup '${PRE_UPDATE_BACKUP}'"); then
    chown "${SERVICE_USER}:${SERVICE_USER}" "$PRE_UPDATE_BACKUP" 2>/dev/null || true
    chmod 600 "$PRE_UPDATE_BACKUP" 2>/dev/null || true
    echo "[pi-cloud-update] pre-update sqlite snapshot written: ${PRE_UPDATE_BACKUP}"
  else
    echo "[pi-cloud-update] warning: pre-update sqlite snapshot failed (continuing update)" >&2
  fi
fi

atomic_swap_current "$TARGET_DIR"
systemctl restart "$SERVICE_NAME"

if ! wait_for_health; then
  echo "[pi-cloud-update] health check failed for ${RELEASE_ID}, rolling back!" >&2
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true
  if [ -n "$PREV_TARGET" ] && [ -d "$PREV_TARGET" ]; then
    atomic_swap_current "$PREV_TARGET"
    if ! systemctl restart "$SERVICE_NAME"; then
      echo "[pi-cloud-update] CRITICAL: rollback restart failed for ${PREV_TARGET}" >&2
      rm -rf "$TARGET_DIR"
      exit 1
    fi
    if ! wait_for_health; then
      echo "[pi-cloud-update] CRITICAL: rollback to ${PREV_TARGET} ALSO failed /v1/health check! Service ${SERVICE_NAME} requires immediate manual intervention." >&2
      journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true
      rm -rf "$TARGET_DIR"
      exit 1
    fi
    echo "[pi-cloud-update] rollback to ${PREV_TARGET} succeeded and passed /v1/health" >&2
  else
    echo "[pi-cloud-update] CRITICAL: no previous release available for rollback!" >&2
  fi
  rm -rf "$TARGET_DIR"
  exit 1
fi

echo "[pi-cloud-update] deployed ${RELEASE_ID} (prev: ${PREV_TARGET:-none})"

# 清理过旧版本：按修改时间保留最近 KEEP_RELEASES 个，且绝不删除当前版本和上一回滚点
if [ -d "$RELEASES_DIR" ] && [ "$KEEP_RELEASES" -gt 0 ]; then
  TARGET_REAL="$(readlink -f "$TARGET_DIR")"
  mapfile -t ALL_RELEASES < <(ls -1dt "${RELEASES_DIR}"/* 2>/dev/null || true)
  COUNT=0
  for dir in "${ALL_RELEASES[@]}"; do
    [ -d "$dir" ] || continue
    REAL_DIR="$(readlink -f "$dir")"
    if [ "$REAL_DIR" = "$TARGET_REAL" ] || [ "$REAL_DIR" = "$PREV_TARGET" ]; then
      COUNT=$((COUNT + 1))
      continue
    fi
    COUNT=$((COUNT + 1))
    if [ "$COUNT" -gt "$KEEP_RELEASES" ]; then
      echo "[pi-cloud-update] pruning old release: ${REAL_DIR}"
      rm -rf "$REAL_DIR"
    fi
  done
fi
