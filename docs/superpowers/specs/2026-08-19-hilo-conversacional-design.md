# Hilo conversacional: una idea, muchas piezas — diseño

**Fecha:** 2026-08-19
**Estado:** diseño aprobado, sin implementar

## Problema

El bot asume que **cada mensaje es una historia distinta**: una evidencia entra, se crea
una idea y se propone contenido. En el uso real una historia se arma con varias piezas —
la foto, el audio que la explica, la corrección que aparece después.

El caso que lo disparó: el usuario mandó la foto del logo de Ollama y después un audio
explicando que había implementado un LLM local con Qwen. El sistema generó **dos ideas
distintas**, ninguna con el material completo. Su reacción: "está más difícil que la mierda".

Un segundo síntoma del mismo problema: las transcripciones traen errores ("LAMA" por
"Llama", "Ollarma" por "ollama") y hoy el usuario recién los descubre en el post final,
cuando ya no hay forma barata de corregirlos sin que la IA reescriba todo.

## Decisión central

**Una conversación es una idea.** Todo lo que el usuario manda se acumula sobre la idea en
curso hasta que pide generar el post. La captura al vuelo sigue disponible, pero como
salida explícita (`📥 Solo guardar`), no como comportamiento por defecto.

## Alcance

### 1. Estado `hilo_abierto`

El primer mensaje sin sesión activa crea una idea (sin título todavía), guarda la pieza
como evidencia, la vincula con `idea_evidence` y abre el hilo. La sesión guarda `ideaId` y
la cuenta de piezas.

Las piezas siguientes — texto, audio o foto — se guardan como evidencia **de la misma
idea**. El modelo de datos ya lo soporta: `createIdea` acepta una lista de evidencias y
`idea_evidence` es una relación de muchos a muchos. Lo que cambia es el flujo del bot.

### 2. Acuse por pieza

Cada pieza devuelve **qué entendió el sistema** en una línea (la transcripción del audio o
la descripción de la foto), la cantidad de piezas acumuladas, y los botones:

```
🎤 "probamos LAMA local para texto e imágenes"
3 piezas en esta idea

✍️ Generar post · 📥 Solo guardar · 🗑 Descartar
```

Mostrar lo que se entendió es lo que permite cazar los errores de transcripción **antes**
de que lleguen al post. El acuse no llama a la IA de redacción: es rápido y barato.

### 3. Las correcciones son evidencia

Un texto como "es Llama, no LAMA" entra como una pieza más y el redactor lo lee junto al
resto. No hace falta un modo especial de corrección ni sintaxis de buscar-y-reemplazar: el
contexto acumulado alcanza.

### 4. Generar

`✍️ Generar post` (o `/listo`) toma **todas** las piezas de la idea, les pone título con
`proponerIdea` y arma el boceto con `redactarBoceto`. Desde ahí sigue el flujo actual:
Aprobar / Otra versión / Descartar (y `✏️ Editar a mano` cuando se implemente
[el otro spec](2026-08-17-edicion-manual-boceto-design.md)).

Al aprobar y programar, o al descartar, el hilo se cierra. El próximo mensaje abre uno nuevo.

### 5. Escape para captura al vuelo

`📥 Solo guardar` cierra el hilo sin generar nada. La idea queda disponible en `/cola`.
Es lo que preserva el caso "saco una foto en el Polo y sigo con mi día" sin obligar a
abrir y cerrar una conversación.

### 6. Expiración a las 24 horas

Un hilo sin actividad por 24 horas se cierra solo. Sin esto, una foto mandada el jueves se
pegaría a una idea abierta el lunes y el post saldría mezclado. Al expirar, el próximo
mensaje abre un hilo nuevo.

### 7. Los comandos no son evidencia

`/cola`, `/marca`, `/conectar`, `/invitar` siguen funcionando dentro del hilo sin guardarse
como piezas. `/listo` equivale a tocar Generar.

## Fuera de alcance

- Editar o sacar una pieza ya cargada (se descarta el hilo entero y se empieza de nuevo).
- Varios hilos abiertos en paralelo.
- Reabrir un hilo ya cerrado.

## Tests

- Dos evidencias seguidas quedan en **una** idea, no en dos (es la regresión que motiva todo).
- El acuse incluye la transcripción o la descripción de la foto.
- `✍️ Generar post` arma el boceto con **todas** las evidencias del hilo.
- `📥 Solo guardar` cierra el hilo sin llamar a la IA de redacción.
- Un hilo con más de 24 horas de inactividad no recibe piezas nuevas: abre uno nuevo.
- Un comando dentro del hilo no se guarda como evidencia.
- Una foto en el hilo sigue disparando el formato con imagen al programar
  (`fotoDeIdea` ya busca por idea, así que debería seguir andando; verificarlo).

## Impacto en tests existentes

`tests/next-turn-texto.test.js` y los de evidencia asumen "una evidencia = una idea" y van
a fallar. Hay que actualizarlos: es un cambio de comportamiento buscado, no una regresión.
