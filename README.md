# Personal Brand OS 🚀

Motor configurable de marca personal: capturás evidencia (fotos, audios, textos,
links) por Telegram y el sistema la convierte en contenido profesional por marca,
publicado en tus redes.

- **Diseño:** [`docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md`](docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md)
- **Estado:** Plan E (v1 completo) — ver `docs/superpowers/plans/`

## Levantar en la Mac mini

```bash
cp .env.example .env   # completar MASTER_KEY (openssl rand -hex 32), ADMIN_CHAT_ID
                        # e INTERNAL_API_SECRET (openssl rand -hex 32, igual que MASTER_KEY)
docker compose up -d --build
curl http://localhost:3000/health   # → {"ok":true}
```

**`INTERNAL_API_SECRET` es obligatorio** para que funcione el sistema de invitaciones
(`/unirme <código>`): sin él, la redención de invitaciones falla de forma silenciosa (fail-closed
por diseño — nunca da de alta a alguien sin validar bien). Generarlo igual que `MASTER_KEY`:
`openssl rand -hex 32`.

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
- Verificar que el nodo "Switch camino" muestre exactamente **4 salidas** sin errores de validación:
  1. `evidencia` (foto/audio/video)
  2. `turno` (texto/botón/comando)
  3. `ayuda` (fallback)
  4. `unirme` (`/unirme <código>`, redención de invitaciones)
- Si el import falla, regenerar con `node n8n/build-workflow.mjs` y re-importar.
- **Si ya importaste el workflow antes de este cambio**, hay que volver a importar
  `n8n/workflow.json` (Workflows → Import from file, sobrescribir) para que `/unirme` funcione —
  si no, esos mensajes se pierden silenciosamente.

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

Desde el Plan E, el camino principal es 100% conversacional con `/conectar` (ver más abajo) —
no requiere curl ni tocar ninguna terminal. Los ejemplos de curl de abajo quedan para scripting
o uso avanzado; ambos caminos usan el mismo helper interno, así que el resultado es idéntico.
Como toda la API autenticada, necesitan el header `X-Telegram-Chat-Id` con tu `ADMIN_CHAT_ID`
(el mismo que autoriza tu usuario en Telegram):

```bash
# LinkedIn (access_token + person_urn)
curl -X POST http://localhost:3000/api/profiles/:profileId/channels \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Chat-Id: <ADMIN_CHAT_ID>" \
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
  -H "X-Telegram-Chat-Id: <ADMIN_CHAT_ID>" \
  -d '{
    "channel_code": "instagram",
    "credentials": {
      "access_token": "YOUR_IG_TOKEN",
      "ig_user_id": "123456789"
    }
  }'
```

## Multiusuario e invitaciones (Plan E)

Sumar una marca nueva o invitar a alguien (community manager, socio) es pura
conversación con el bot — cero código, cero curl.

- **`/marca <nombre>`** — solo el administrador. Crea la marca y auto-conecta
  WhatsApp Status (el canal manual: no necesita credenciales). Ejemplo:
  `/marca SkyTrace` → `✅ Marca "SkyTrace" creada. WhatsApp Status ya está
  listo para paquetes manuales. Usá /conectar para sumar LinkedIn o
  Instagram.`
- **`/invitar <rol>`** — solo el `owner` de la marca. Rol opcional
  (`owner|editor|approver`, default `editor`). Genera un código de 8
  caracteres válido 48 horas: `🎟️ Código para sumar a {marca} como {rol}:
  {CODE}`. Si sos owner de más de una marca, el bot pregunta cuál con
  botones antes de generar el código.
- **`/unirme <código>`** — lo escribe la persona invitada, hablándole al bot
  por primera vez. No requiere estar dado de alta de antemano: el código la
  da de alta automáticamente con el rol que le asignaron. Código inválido,
  vencido, ya usado, o cuenta suspendida → mensaje de rechazo genérico (nunca
  filtra a qué marca pertenece un código ajeno).
- **`/conectar`** — solo el `owner`. Flujo guiado con botones
  (LinkedIn / Instagram) que pide cada credencial de a una (nunca todo
  junto). Confirma con los últimos 4 caracteres del token nomás — el token
  completo nunca aparece en la conversación, ni en los mensajes intermedios.

**Roles:** `owner` (todo, incluye invitar y conectar canales), `approver`
(aprueba y programa contenido), `editor` (redacta y desarrolla bocetos).

## Backup

Todo lo que importa vive en el volumen Docker `pbos_data` (la base SQLite +
los archivos de media). `scripts/backup.sh` lo respalda cifrado, sin necesidad
de parar los contenedores.

> **Si ya corriste `docker compose up` antes de que se fijara el nombre del
> volumen** (`name: pbos_data` en `docker-compose.yml`): Docker Compose puede
> haber creado el volumen con el nombre autogenerado viejo (algo como
> `personal_brand_os_pbos_data`), que es donde vive tus datos reales. Migralo
> al volumen `pbos_data` antes de confiar en los backups, o vas a estar
> respaldando (o restaurando) un volumen `pbos_data` vacío:
>
> ```bash
> docker run --rm -v personal_brand_os_pbos_data:/from -v pbos_data:/to \
>   alpine sh -c "cp -a /from/. /to/"
> ```

### Configurar

Generar un valor y pegarlo (no funciona poner el comando literal en `.env` —
`.env` no evalúa `$(...)`, quedaría guardado el texto del comando en vez del secreto):

```bash
openssl rand -base64 32
```

Copiar el resultado a `BACKUP_PASSPHRASE=` en `.env` (no lo subas a git, `.env` ya está en
`.gitignore`).

**Dónde guardar la passphrase:** en un gestor de contraseñas (1Password,
Bitwarden, o el llavero del Mac). **NUNCA** en el repo, ni en un archivo de
texto plano en el Escritorio, ni en un mensaje de Telegram — sin ella, los
backups cifrados son inútiles (y con ella, cualquiera que la tenga puede
leerlos).

### Backup manual

```bash
./scripts/backup.sh
# → backups/pbos-2026-07-17.tar.gz.enc
```

Falla ruidosamente (`set -euo pipefail`): si algo se rompe, el script corta
con código de salida distinto de 0 y un mensaje claro — nunca falla en
silencio dejándote sin backup y sin saberlo.

### Backup automático (cron, en la Mac mini)

```bash
crontab -e
# agregar (todos los días a las 3am, log acumulado en el repo):
0 3 * * * cd /ruta/al/repo && ./scripts/backup.sh >> backup.log 2>&1
```

Retención: se borran automáticamente los backups cifrados de más de 30 días.

### Restaurar

```bash
./scripts/restore.sh backups/pbos-2026-07-17.tar.gz.enc
```

Esto descifra el archivo, para los contenedores (`docker compose down`),
reemplaza el contenido del volumen `pbos_data` por el del backup, y te avisa
que levantes todo de nuevo con `docker compose up -d`. **Reemplaza todos los
datos actuales** — no hay vuelta atrás salvo tener otro backup de antes de
restaurar.

Si usás Docker Desktop en Mac con file sharing personalizado, asegurate de que la carpeta
temporal del sistema (`$TMPDIR`, normalmente bajo `/var/folders` o `/private`) esté compartida
con Docker — por default lo está.

## OAuth y acceso remoto (Tailscale)

**Carga de credenciales manual, no OAuth automático (v1):** conectar LinkedIn
o Instagram con `/conectar` (o vía `curl`, arriba) pide el `access_token` ya
generado — el bot no hace el flujo OAuth completo (redirect + callback) por
vos. Eso queda para v1.5/SaaS, cuando el sistema tenga una URL pública fija
para recibir el callback de cada plataforma. Para v1, alcanza con generar el
token a mano una vez (dura semanas/meses según la plataforma) y pegarlo.

### Generar los tokens a mano

- **LinkedIn:** [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps) →
  crear una app → productos `Share on LinkedIn` / `Sign In with LinkedIn` →
  generar un `access_token` con los scopes de publicación (`w_member_social`)
  desde la pestaña Auth → copiarlo y pegarlo cuando `/conectar` lo pida, junto
  con tu `person_urn` (aparece en la misma pantalla o vía
  `GET /v2/me` con el token).
- **Instagram:** [Meta for Developers](https://developers.facebook.com/apps/) →
  crear una app tipo Business → producto Instagram Graph API → generar un
  token de larga duración desde el Graph API Explorer con permisos
  `instagram_content_publish` → copiarlo junto con el `ig_user_id` de tu
  cuenta profesional.

### Acceso remoto seguro con Tailscale

La Mac mini no expone ningún puerto a Internet (ver "Captura por Telegram"
más arriba). Para administrar n8n o el tablero desde otra máquina sin abrir
puertos, instalar [Tailscale](https://tailscale.com/) crea una VPN privada
entre tus dispositivos:

1. Instalar en la Mac mini: `brew install tailscale` (o el `.pkg` de
   [tailscale.com/download](https://tailscale.com/download)) → `sudo
   tailscale up` → iniciar sesión con tu cuenta.
2. Instalar Tailscale en tu laptop/teléfono con la misma cuenta.
3. Ambos dispositivos ahora se ven por una IP privada `100.x.x.x` (o el
   nombre `mac-mini.tailnet-nombre.ts.net`) sin exponer nada a Internet
   público.
4. Acceder a n8n: `http://100.x.x.x:5678` (o el nombre Tailscale) en vez de
   `localhost:5678`.

No hace falta abrir puertos en el router ni configurar DNS — Tailscale
resuelve el ruteo y el cifrado (WireGuard) automáticamente.

## Cierre del v1

Con el Plan E se completa el ciclo descripto en el spec: **capturar evidencia
por Telegram → convertirla en contenido con la voz de cada marca → aprobarla
→ publicarla (automática o manualmente) → sumar marcas y personas nuevas sin
tocar código.** De punta a punta, v1 entrega:

- **Captura conversacional** (Plan B2/C2): fotos, audios, textos y links por
  Telegram, con IA opcional (transcripción, descripción de imagen, extracción
  de entidades).
- **Cerebro conversacional** (Plan C1/C2): de evidencia a boceto con la voz
  de marca, refinamiento por feedback, aprobación y elección de cuándo
  publicar.
- **Publicación automática** (Plan D): scheduler con reintentos, degradación
  honesta a paquete manual, avisos de estado y de tokens por vencer.
- **Multiusuario y onboarding sin código** (Plan E, este): crear marcas,
  invitar personas con roles, y conectar canales — todo por conversación.
- **Operación en la Mac mini** (este documento): backup diario cifrado con
  restore documentado, y acceso remoto seguro sin exponer puertos.

Para el historial completo de decisiones de diseño y cómo se construyó cada
pieza, ver:

- [`docs/superpowers/specs/`](docs/superpowers/specs/) — spec de diseño del
  v1 y los reportes de cada tarea implementada.
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — los siete planes
  (A, B1, B2, C1, C2, D, E) con sus interfaces, tests y decisiones
  documentadas tarea por tarea.

## Desarrollo local

```bash
cd core-api && npm install && npm test
```
