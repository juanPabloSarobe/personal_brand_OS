import { createApp } from './app.js'
import { openDb } from './db.js'
import { tick } from './services/scheduler.js'

const db = openDb()
const app = createApp(db)
const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`core-api escuchando en :${port}`)
  tick(db).catch(e => console.error('scheduler tick:', e))
  setInterval(() => tick(db).catch(e => console.error('scheduler tick:', e)), 60000)
})
