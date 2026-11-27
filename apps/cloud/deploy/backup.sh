#!/usr/bin/env bash
# Pi Cloud 每日备份：SQLite 持久化状态库（cloud.db）与云端会话/记忆文件。
#
# 备份目标是「能恢复出同一台云端」，必须包含：
#   cloud.db（管理员口令哈希、AES 加密配置、设备/配对/授权/工单/单元/任务 diff；解密仍需同一把 PI_CLOUD_ENC_KEY）
#   agent/sessions/（云端会话 JSONL —— 历史与导出的唯一真相源）
#   memory/（长期记忆与留存文档）
# 禁止直接打包运行中的 SQLite/WAL 文件：必须经 sqlite3 .backup 生成一致性快照并校验完整性。
# 保留 7 天；备份目录不在 releases 里，更新不会碰它。
set -euo pipefail
umask 077

DATA_DIR="${PI_CLOUD_DATA_DIR:-/var/lib/pi-cloud}"
BACKUP_DIR="${PI_CLOUD_BACKUP_DIR:-/var/backups/pi-cloud}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${BACKUP_DIR}/pi-cloud-${STAMP}.tar.gz"

mkdir -p "${BACKUP_DIR}"

if [ ! -d "${DATA_DIR}" ]; then
  echo "data dir missing: ${DATA_DIR}" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 1) 拷贝非数据库持久文件（agent/、memory/ 等），显式排除运行中的 SQLite/WAL 与缓存/临时文件
tar -cf - \
  -C "${DATA_DIR}" \
  --exclude='./workspace' \
  --exclude='./cache' \
  --exclude='./cloud.db' \
  --exclude='./cloud.db-wal' \
  --exclude='./cloud.db-shm' \
  --exclude='./cloud.db-journal' \
  --exclude='*.tmp' \
  . | tar -xf - -C "${STAGE}"

# 2) 使用 sqlite3 在线备份一致性快照并校验完整性，绝不直接打包运行中的 WAL 文件
if [ -f "${DATA_DIR}/cloud.db" ]; then
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "sqlite3 CLI is required to snapshot ${DATA_DIR}/cloud.db safely" >&2
    exit 1
  fi
  sqlite3 "${DATA_DIR}/cloud.db" ".timeout 5000" ".backup '${STAGE}/cloud.db'"
  if ! sqlite3 "${STAGE}/cloud.db" "PRAGMA integrity_check;" | grep -qx ok; then
    echo "sqlite integrity_check failed for backup snapshot: ${STAGE}/cloud.db" >&2
    exit 1
  fi
fi

# 3) 原子写入压缩归档（umask 077 保证归档从创建起仅属主可读）
tar -czf "${ARCHIVE}.part" -C "${STAGE}" .
chmod 600 "${ARCHIVE}.part"
mv "${ARCHIVE}.part" "${ARCHIVE}"

# 留 7 天
find "${BACKUP_DIR}" -name 'pi-cloud-*.tar.gz' -type f -mtime +7 -delete

echo "backup written: ${ARCHIVE} ($(du -h "${ARCHIVE}" | cut -f1))"
