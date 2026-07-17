import { config, runOnce } from './bridge.js'

const deps = config()
let offset = 0
console.log('puente-telegram escuchando (long polling, sin puertos expuestos)')

while (true) {
  try {
    offset = await runOnce(offset, deps)
  } catch (err) {
    console.error(`puente: ciclo falló: ${err} — reintento en 5s`)
    await new Promise((r) => setTimeout(r, 5000))
  }
}
