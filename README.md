# Personal Brand OS 🚀

Motor configurable de marca personal: capturás evidencia (fotos, audios, textos,
links) por Telegram y el sistema la convierte en contenido profesional por marca,
publicado en tus redes.

- **Diseño:** [`docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md`](docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md)
- **Estado:** Plan B2 (captura por Telegram) — ver `docs/superpowers/plans/`

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

1. `/start` al bot → responde la ayuda.
2. Mandar una nota de voz → `📎 Evidencia E-0001 guardada. 🎙️ Escuché: «...»`.
3. Mandar una foto con caption → descripción de visión + entidades detectadas.
4. Desde otro Telegram (no autorizado) → silencio absoluto.

## Desarrollo local

```bash
cd core-api && npm install && npm test
```
