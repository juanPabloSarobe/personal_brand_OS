#!/usr/bin/env bash
# Restaura un backup cifrado generado por scripts/backup.sh.
#
# Uso:
#   ./scripts/restore.sh backups/pbos-2026-07-17.tar.gz.enc
#
# Qué hace:
#   1. Descifra el archivo (pide BACKUP_PASSPHRASE de .env, misma passphrase
#      usada para cifrar).
#   2. Para los contenedores (docker compose down) — restaurar con los
#      servicios corriendo puede corromper el archivo SQLite.
#   3. Borra el contenido actual del volumen `pbos_data` y extrae el backup
#      ahí adentro.
#   4. Recuerda levantar todo de nuevo con `docker compose up -d`.
#
# ADVERTENCIA: esto reemplaza todos los datos actuales del volumen. No hay
# vuelta atrás salvo que tengas otro backup del estado previo.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

ENV_FILE="$REPO_DIR/.env"
VOLUME_NAME="pbos_data"

if [ $# -ne 1 ]; then
  echo "Uso: $0 <archivo-backup.tar.gz.enc>" >&2
  exit 1
fi

ENC_FILE="$1"

if [ ! -f "$ENC_FILE" ]; then
  echo "❌ No existe el archivo: $ENC_FILE" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ No existe $ENV_FILE — no se puede leer BACKUP_PASSPHRASE." >&2
  exit 1
fi

BACKUP_PASSPHRASE="$(grep -E '^BACKUP_PASSPHRASE=' "$ENV_FILE" | tail -n1 | cut -d'=' -f2-)"

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "❌ BACKUP_PASSPHRASE está vacía en $ENV_FILE." >&2
  exit 1
fi

TMP_TAR="$(mktemp -t pbos-restore-XXXXXX.tar.gz)"
trap 'rm -f "$TMP_TAR"' EXIT

echo "🔓 Descifrando $ENC_FILE ..."
BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass env:BACKUP_PASSPHRASE \
  -in "$ENC_FILE" \
  -out "$TMP_TAR"

echo "⏸️  Parando los contenedores (docker compose down) ..."
docker compose down

echo "🗑️  Vaciando el volumen '$VOLUME_NAME' actual ..."
docker run --rm -v "${VOLUME_NAME}:/data" alpine sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null || true'

echo "📥 Restaurando datos desde el backup ..."
docker run --rm \
  -v "${VOLUME_NAME}:/data" \
  -v "$(dirname "$TMP_TAR"):/backup" \
  alpine tar xzf "/backup/$(basename "$TMP_TAR")" -C /data --strip-components=1

echo "✅ Restore completo."
echo "👉 Levantá todo de nuevo con: docker compose up -d"
