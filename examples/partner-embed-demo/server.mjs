import { createPartnerDemo, loadDemoConfig } from './src/demo-server.mjs'

const config = loadDemoConfig()
const demo = createPartnerDemo({ config })
const origin = await demo.start()

console.log(`[partner-demo] listening on ${origin}`)
console.log(`[partner-demo] RabbitVis API: ${config.apiBaseUrl}`)
console.log(`[partner-demo] Embed SDK: ${config.sdkDir || config.sdkUrl}`)
console.log(`[partner-demo] login users: /login?user=alice or /login?user=bob`)
if (!config.controlToken) {
  console.log('[partner-demo] control API disabled (set PARTNER_DEMO_CONTROL_TOKEN to enable it)')
}

let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`[partner-demo] received ${signal}; closing`)
  await demo.close()
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
