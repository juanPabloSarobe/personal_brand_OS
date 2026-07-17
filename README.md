# Personal Brand OS 🚀

Motor configurable de marca personal: capturás evidencia (fotos, audios, textos,
links) por Telegram y el sistema la convierte en contenido profesional por marca,
publicado en tus redes.

- **Diseño:** [`docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md`](docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md)
- **Estado:** Plan D (publicadores y scheduler) — ver `docs/superpowers/plans/`

## Levantar en la Mac mini

```bash
cp .env.example .env   # completar MASTER_KEY (openssl rand -hex 32) y ADMIN_CHAT_ID
docker compose up -d --build
curl http://localhost:3000/health   # → {"ok":true}
```

### IA (opcional pero recomendado)

Con `GROQ_API_KEY` configurada (gratis en [console.groq.com](https://console.groq.com)),
cada evidencia se procesa al entrar: los audios se transcriben (Whisper), las fotos se
describen (visión) y se detectan entidades (personas, empresas, tecnologías, lugares).
Sin la key, la captura funciona igual — solo no se procesa.

## Captura por Telegram (Plan B2)

Flujo: **Telegram → puente (long polling) → n8n → core-api (IA) → respuesta del bot.**
La Mac mini no expone ningún puerto a Internet: el puente sale a buscar los mensajes.

### Setup (una sola vez)

1. **Crear el bot:** hablarle a [@BotFather](https://t.me/BotFather) → `/newbot` → copiar el
   token a `TELEGRAM_BOT_TOKEN` en `.env`.
2. **Tu chat ID:** mandarle un mensaje a [@userinfobot](https://t.me/userinfobot) y copiar el
   `Id` a `ADMIN_CHAT_ID` en `.env` (es el que autoriza tu usuario; cualquier otro remitente
   recibe silencio).
3. **Levantar todo:** `docker compose up -d --build`
4. **Importar el workflow en n8n (primera vez):** abrir [http://localhost:5678](http://localhost:5678),
   crear el usuario local, *Workflows → Import from file* → `n8n/workflow.json` → activarlo
   (toggle **Active**).
   El workflow se genera desde código: si se toca algo en `n8n/src/`, regenerar con
   `node n8n/build-workflow.mjs` y re-importar.

### Probar

1. `/start` → el bot responde la ayuda.
2. Mandar texto, foto o audio → archiva como evidencia (E-XXXX) + propone una idea con botones
   (✍️ Desarrollar, 💡 Otra idea, 🗑️ Descartar).
3. Tocar **✍️ Desarrollar** → el bot genera un boceto con la voz de la marca. Responder con texto
   (feedback) → el bot refina el boceto. Tocar **✅ Aprobar** → elegir cuándo publicar:
   - 🚀 Ahora
   - 🌅 Mañana 9hs (usa `TZ_OFFSET_MINUTES` de `.env` para tu zona horaria)
   - ⏳ A la cola (para programar luego)
4. `/cola` → muestra los posts pendientes de programar.
5. `/idea <texto>` → crea una idea manualmente sin capturar evidencia.
6. Mensaje desde un Telegram no autorizado (distinto de `ADMIN_CHAT_ID`) → silencio absoluto.

**IMPORTANTE (primera vez):**
- Abrir [http://localhost:5678](http://localhost:5678) (n8n)
- Workflows → Import from file → `n8n/workflow.json` → activarlo (toggle **Active**)
- Verificar que el nodo "Switch camino" muestre exactamente **3 salidas** sin errores de validación:
  1. `evidencia` (foto/audio/video)
  2. `turno` (texto/botón/comando)
  3. `ayuda` (fallback)
- Si el import falla, regenerar con `node n8n/build-workflow.mjs` y re-importar.

## Publicación automática (Plan D)

El scheduler despacha contenido aprobado hacia tus redes sin intervención manual:

**Ciclo:** aprobado → programada (con hora) → publicada (o entregada manual si falla).

### Cómo funciona

1. **Scheduler (cada 60s):** busca versiones programadas vencidas y las publica en el canal configurado.
2. **Reintentos inteligentes:** si un canal falla (ej. red caída), reintentar en 1, 5 y 15 minutos. Tras 3 fallos → paquete manual por Telegram.
3. **Degradación honesta:** si el canal no puede automatizarse (ej. Instagram sin URL pública), directamente paquete manual.
4. **Avisos automáticos:** 
   - ✅ Publicado en {canal}: {url}
   - ⚠️ {canal} no respondió; te mandé el paquete para publicarlo a mano.
   - 🔑 El token de {canal} vence en 3 días. Reconéctalo.

### Paquete manual (fallback universal)

Cuando algo falla o no puede automatizarse, recibes por Telegram una foto (si hay) con el texto + hashtags + instrucción:
- **WA Status:** "Subilo a tu estado de WhatsApp 👆"
- Otros canales: "Listo para pegar en {canal} 👆"

### DRY_RUN para probar sin publicar

Configura `DRY_RUN=1` en `.env` para simular el ciclo completo (aprobado → programada → publicada en logs) sin llamar APIs reales. Útil para probar el flujo antes de conectar credenciales.

### Cargar credenciales de canal

Por ahora, se cargan vía curl. Ejemplo:

```bash
# LinkedIn (access_token + person_urn)
curl -X POST http://localhost:3000/api/profiles/:profileId/channels \
  -H "Content-Type: application/json" \
  -d '{
    "channel_code": "linkedin",
    "credentials": {
      "access_token": "YOUR_LINKEDIN_TOKEN",
      "person_urn": "urn:li:person:ABC123"
    }
  }'

# Instagram (access_token + ig_user_id + MEDIA_PUBLIC_BASE_URL en .env)
curl -X POST http://localhost:3000/api/profiles/:profileId/channels \
  -H "Content-Type: application/json" \
  -d '{
    "channel_code": "instagram",
    "credentials": {
      "access_token": "YOUR_IG_TOKEN",
      "ig_user_id": "123456789"
    }
  }'
```

**Nota:** En el Plan E, esto será conversacional (directo en Telegram). Por ahora, curl. Las credenciales se cifran en la base de datos.

## Desarrollo local

```bash
cd core-api && npm install && npm test
```
