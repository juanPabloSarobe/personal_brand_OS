import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Ejecuta un nodo Code de n8n simulando $json / $('Nodo') / $input. */
export function runCodeNode(file, { json = {}, nodes = {} } = {}) {
  const code = readFileSync(path.join(HERE, '../../n8n/src', file), 'utf8')
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`nodo no simulado: ${name}`)
    return { first: () => ({ json: nodes[name] }) }
  }
  const $input = { all: () => [{ json }], first: () => ({ json }) }
  const fn = new Function('$json', '$', '$input', code)
  return fn(json, $, $input)
}
