# Personal Brand OS 🚀

Motor configurable de marca personal: capturás evidencia (fotos, audios, textos,
links) por Telegram y el sistema la convierte en contenido profesional por marca,
publicado en tus redes.

- **Diseño:** [`docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md`](docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md)
- **Estado:** Plan B1 (capa de IA + evidencia) — ver `docs/superpowers/plans/`

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

## Desarrollo local

```bash
cd core-api && npm install && npm test
```
