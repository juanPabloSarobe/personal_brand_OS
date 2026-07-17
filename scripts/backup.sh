#!/usr/bin/env bash
# Backup diario cifrado del volumen de datos de Personal Brand OS.
#
# Qué hace:
#   1. Vuelca el volumen Docker `pbos_data` (SQLite + media) a un .tar.gz vía
#      un contenedor `alpine` descartable (no hace falta parar los servicios:
#      SQLite en modo WAL + una lectura de `docker run --rm` es consistente
#      para uso doméstico).
#   2. Cifra el .tar.gz con AES-256-CBC (passphrase en `BACKUP_PASSPHRASE`,
#      variable en `.env`) y borra el .tar.gz sin cifrar.
#   3. Borra backups cifrados de más de 30 días.
#
# Falla ruidosamente: un backup roto se tiene que notar (código de salida
# distinto de 0, mensaje por stderr), nunca fallar en silencio.
#
# Uso manual:
#   ./scripts/backup.sh
#
# Uso por cron (ver README.md → sección "Backup"):
#   0 3 * * * cd /ruta/al/repo && ./scripts/backup.sh >> backup.log 2>&1

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

ENV_FILE="$REPO_DIR/.env"
BACKUP_DIR="$REPO_DIR/backups"
VOLUME_NAME="pbos_data"
RETENTION_DAYS=30
FECHA="$(date +%F)"
TAR_NAME="pbos-${FECHA}.tar.gz"
ENC_NAME="${TAR_NAME}.enc"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ No existe $ENV_FILE — no se puede leer BACKUP_PASSPHRASE." >&2
  exit 1
fi

# Carga solo BACKUP_PASSPHRASE del .env, sin ejecutar el resto del archivo.
BACKUP_PASSPHRASE="$(grep -E '^BACKUP_PASSPHRASE=' "$ENV_FILE" | tail -n1 | cut -d'=' -f2-)"

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "❌ BACKUP_PASSPHRASE está vacía en $ENV_FILE. Generar con: openssl rand -base64 32" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Si el volumen no existe, `docker run -v` lo crea vacío en silencio y el
# backup "funciona" sobre nada. Falla ruidosamente antes de eso.
docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 || {
  echo "❌ El volumen $VOLUME_NAME no existe. ¿Corriste docker compose up?" >&2
  exit 1
}

echo "📦 Volcando el volumen '$VOLUME_NAME' a $BACKUP_DIR/$TAR_NAME ..."
docker run --rm \
  -v "${VOLUME_NAME}:/data" \
  -v "$BACKUP_DIR:/backup" \
  alpine tar czf "/backup/$TAR_NAME" -C / data

echo "🔒 Cifrando con AES-256-CBC ..."
BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" openssl enc -aes-256-cbc -pbkdf2 -salt \
  -pass env:BACKUP_PASSPHRASE \
  -in "$BACKUP_DIR/$TAR_NAME" \
  -out "$BACKUP_DIR/$ENC_NAME"

rm -f "$BACKUP_DIR/$TAR_NAME"

# Sanity check: un backup cifrado sospechosamente chico probablemente viene
# de un volumen vacío o de un fallo silencioso a mitad de camino. Mejor
# fallar ruidosamente acá que "tener éxito" con un backup inútil.
MIN_BYTES=1024
ENC_FILE="$BACKUP_DIR/$ENC_NAME"
ENC_SIZE="$(wc -c <"$ENC_FILE" | tr -d ' ')"
if [ ! -s "$ENC_FILE" ] || [ "$ENC_SIZE" -lt "$MIN_BYTES" ]; then
  echo "❌ El backup cifrado ($ENC_FILE) pesa $ENC_SIZE bytes — sospechosamente chico (mínimo esperado: $MIN_BYTES). ¿El volumen estaba vacío?" >&2
  exit 1
fi

echo "🧹 Borrando backups cifrados de más de $RETENTION_DAYS días ..."
find "$BACKUP_DIR" -maxdepth 1 -name 'pbos-*.tar.gz.enc' -mtime "+${RETENTION_DAYS}" -print -delete

echo "✅ Backup listo: $BACKUP_DIR/$ENC_NAME"
