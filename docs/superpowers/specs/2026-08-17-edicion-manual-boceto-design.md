# Edición manual del boceto — diseño

**Fecha:** 2026-08-17
**Estado:** diseño aprobado, sin implementar (se implementa el 2026-08-18)

## Problema

Hoy el único modo de corregir un boceto es mandarle feedback en texto, que dispara
`refinarBoceto` y hace que la IA **reescriba el post entero**. Cuando el usuario quiere
cambiar dos palabras ("hay partes que me gustan, otras no"), recibe un texto nuevo y pierde
lo que ya le servía.

El caso que lo disparó: la transcripción de un audio dejó "Cloud Code" (por Claude Code) y
"la IA Grok" (por Groq). El sistema los reprodujo fielmente — correcto según las reglas
anti-invención, pero publicaría la marca técnica del usuario con dos nombres mal escritos.
Pedirle a la IA "corregí Grok por Groq" es exactamente donde se va por las nubes.

Hay un segundo problema, encontrado al explorar el código: **el usuario nunca ve lo que se
publica**. `adaptarVersion` (`next-turn.js:640`) corre *después* de aprobar y le pide a la
IA que reescriba el texto para cada canal. Aunque el boceto quedara perfecto, la IA lo
vuelve a tocar antes de publicar.

## Decisión central

**Lo que el usuario lee es lo que se publica.** Una vez que edita a mano, la IA no toca
más el texto: ni para refinar, ni para adaptar al canal.

## Alcance

### 1. Nuevo botón

`BOTONES_BOCETO` (`next-turn.js:23`) pasa de 3 a 4 opciones:

```
✅ Aprobar · ✏️ Editar a mano · 🔄 Otra versión · 🗑 Descartar
```

### 2. Estado nuevo: `editando_boceto`

Al tocar `boceto_editar`, la sesión pasa a `editando_boceto` con los mismos datos que
`refinando_boceto` (`ideaId`, `profileId`, `draftId`, `queue`). El bot responde con el
texto del post en un **bloque de código copiable de un toque**, seguido de los hashtags
propuestos. Sin encabezado ni negritas: solo lo publicable.

### 3. El texto entrante se toma literal

En `editando_boceto`, el siguiente mensaje de texto **reemplaza el contenido del draft sin
pasar por la IA** (`updateDraft` directo, sin `refinarBoceto`). El bot devuelve el texto
resultante con `✅ Aprobar · ✏️ Editar de nuevo · 🗑 Descartar`.

Esto elimina la ambigüedad de modos: en `refinando_boceto` un texto es *feedback*; en
`editando_boceto` es *el post*. Nunca se confunden.

### 4. Congelar el texto (lo esencial)

Se agrega a `drafts` una bandera `edited_by_user INTEGER NOT NULL DEFAULT 0` (migración).
Se marca en 1 al guardar una edición manual.

En la etapa de programación, **si el draft tiene `edited_by_user = 1` no se llama a
`adaptarVersion`**: el `text_content` de `channel_versions` se copia literal del draft y
solo se adjuntan los hashtags que el usuario ya aprobó.

Sin esto, la feature no sirve: la IA reescribiría la edición al programar.

### 5. Hashtags

Los propone la IA junto con el texto y **se editan en el mismo bloque**. Si el usuario los
cambia, valen los suyos. Un solo lugar donde manda él.

### 6. `parse_mode` en n8n

El nodo "Enviar por Telegram" manda el mensaje sin `parse_mode`, por lo que hoy se ven
asteriscos crudos (`*Lic. Sarobe Juan Pablo*`) en el chat. Se agrega `parse_mode: MarkdownV2`
(o HTML) para:

- habilitar el bloque de código copiable de un toque, que es lo que hace usable la edición
- eliminar los asteriscos crudos que ya se ven hoy

**Riesgo:** toca `n8n/workflow.json`, que se genera desde `n8n/src/` con
`node n8n/build-workflow.mjs` y hay que reimportar en n8n. Además MarkdownV2 exige escapar
caracteres especiales (`.`, `-`, `!`, `(`, `)`), y un escape mal hecho hace que Telegram
rechace el mensaje entero con 400. Si se elige HTML, el escape es más simple (`<`, `>`, `&`).
**Recomendación: HTML**, por el escape más chico y menos superficie de error.

## Fuera de alcance

- Ediciones parciales (buscar y reemplazar, "cambiá X por Y").
- Editar cada canal por separado. Con un solo canal real conectado, el reemplazo completo
  del boceto alcanza.
- Editar la imagen o el formato del post.

## Tests

- `editando_boceto` guarda el texto **literal**, sin llamar a la IA (verificar que no se
  hace ninguna llamada `fetch` al LLM en ese turno).
- Un texto en `refinando_boceto` sigue yendo a `refinarBoceto` (no se rompe el modo viejo).
- Un draft con `edited_by_user = 1` produce un `channel_versions.text_content` **idéntico**
  al del draft.
- Un draft sin la bandera sigue pasando por `adaptarVersion` (no se rompe el flujo normal).
- La migración agrega la columna sin romper la base existente.

## Notas de implementación

- Migración: hay un patrón previo en `tests/migracion.test.js`; seguirlo.
- `presentarBoceto` se reutiliza para el modo lectura, pero el modo edición necesita su
  propia función sin encabezado ni formato.
