// End-to-end reply-delivery probe for iterate on Windows.
// Drives the real chain with public release binaries:
//   MCP client (this script) -> mcp-server.exe (stdio) -> iterate.exe --serve -> popup (WebView2)
// The popup is driven through WebView2's DevTools port instead of a mouse click, and the
// result of `send_mcp_response` is recorded verbatim, so the real error is not hidden
// behind the popup's fixed "连接已断开，回复未确认送达" message.
//
// Usage: node e2e/run.mjs --dir <extracted app dir> --label <name> --scenario <A|C|D|E> --out <dir>
//   A: reply after 3 s
//   C: reply after 90 s (client keeps waiting)
//   D: at 60 s send notifications/cancelled (what Codex does on tool timeout), reply at 70 s
//   E: at 60 s kill mcp-server (client gone), reply at 70 s
// No user content, tokens or keys are involved; the runner is ephemeral.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1]])
  return acc
}, []))
const appDir = path.resolve(args.dir)
const label = args.label || path.basename(appDir)
const scenario = (args.scenario || 'A').toUpperCase()
const outDir = path.resolve(args.out || 'out')
const cdpPort = Number(args.cdp || 9333)
fs.mkdirSync(outDir, { recursive: true })
const tag = `${label}-${scenario}`
const logFile = path.join(outDir, `${tag}.log`)
fs.writeFileSync(logFile, '')
const t0 = Date.now()
const sec = () => ((Date.now() - t0) / 1000).toFixed(1)
function log(...parts) {
  const line = `[${sec()}s] ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}`
  console.log(`[${tag}] ${line}`)
  fs.appendFileSync(logFile, `${line}\n`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const summary = { label, scenario, os: `${os.type()} ${os.release()}`, steps: {}, delivery_status_timeline: [] }

function findExe(name) {
  const stack = [appDir]
  while (stack.length) {
    const d = stack.pop()
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name.toLowerCase() === name) return p
    }
  }
  throw new Error(`${name} not found under ${appDir}`)
}
const iterateExe = findExe('iterate.exe')
const mcpExe = findExe('mcp-server.exe')
log('exes', { iterateExe, mcpExe })

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-project-'))
const env = {
  ...process.env,
  ITERATE_UI_COMMAND: iterateExe,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
}

// ---- MCP stdio client ----
const mcp = spawn(mcpExe, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let mcpExited = null
mcp.on('exit', (code, signal) => { mcpExited = { code, signal }; log('mcp-server exited', mcpExited) })
mcp.stderr.on('data', d => fs.appendFileSync(path.join(outDir, `${tag}.mcp-stderr.log`), d))
let buf = ''
const pending = new Map()
mcp.stdout.on('data', (d) => {
  buf += d.toString('utf8')
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { log('mcp non-json stdout', line.slice(0, 200)); continue }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    else log('mcp message', JSON.stringify(msg).slice(0, 300))
  }
})
let nextId = 1
function rpc(method, params) {
  const id = nextId++
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return { id, done: new Promise(r => pending.set(id, r)) }
}
const notify = (method, params) => mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)

// ---- CDP client ----
async function cdpTarget(deadlineMs) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await sleep(500)
  }
  return null
}
function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const waits = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); return }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
      fs.appendFileSync(path.join(outDir, `${tag}.console.log`), `[${sec()}s] ${msg.params.type} ${text}\n`)
    }
    else if (msg.method === 'Runtime.exceptionThrown') {
      fs.appendFileSync(path.join(outDir, `${tag}.console.log`), `[${sec()}s] EXCEPTION ${JSON.stringify(msg.params.exceptionDetails).slice(0, 1000)}\n`)
    }
  }
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id
    waits.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || 'exception' }
    return { value: r.result?.result?.value }
  }
  return { opened, send, evaluate, close: () => ws.close() }
}
const invokeExpr = (cmd, a) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(a)}).then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e && (e.message || e)) }))`

function tempArtifacts() {
  const tmp = os.tmpdir()
  return fs.readdirSync(tmp).filter(n => /^iterate_(response|delivery|request|ready)|\.response\.claim$|\.pending-/.test(n))
    .map((n) => { try { const s = fs.statSync(path.join(tmp, n)); return `${n} ${s.size}` } catch { return n } })
}

async function main() {
  const init = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'win-delivery-probe', version: '1' } })
  const initRes = await Promise.race([init.done, sleep(20000).then(() => null)])
  summary.steps.initialize = initRes ? 'ok' : 'timeout'
  log('initialize', initRes ? initRes.result?.serverInfo : 'timeout')
  notify('notifications/initialized', {})
  const tools = await rpc('tools/list', {}).done
  const names = (tools.result?.tools || []).map(t => t.name)
  const toolName = names.includes('call_zhi') ? 'call_zhi' : names.includes('zhi') ? 'zhi' : names[0]
  log('tools', names, 'using', toolName)

  const call = rpc('tools/call', { name: toolName, arguments: { message: `probe ${tag}`, project_path: projectDir, predefined_options: ['选项1', '选项2'], is_markdown: true } })
  let callResult = null
  call.done.then((r) => { callResult = r; log('tools/call returned', JSON.stringify(r).slice(0, 600)) })
  const callStarted = Date.now()

  const target = await cdpTarget(120000)
  summary.steps.popup_devtools = target ? target.url : 'not found within 120s'
  log('cdp target', target ? target.url : null)
  if (!target) return
  const cdp = cdpSession(target.webSocketDebuggerUrl)
  await cdp.opened
  await cdp.send('Runtime.enable')

  // Wait for the Tauri bridge and the request file.
  let request = null
  for (let i = 0; i < 120 && !request; i++) {
    const r = await cdp.evaluate(`(async () => { if (!window.__TAURI_INTERNALS__) return null; const a = await window.__TAURI_INTERNALS__.invoke('get_cli_args'); const f = a && a.mcp_request; if (!f) return { args: a }; const req = await window.__TAURI_INTERNALS__.invoke('read_mcp_request', { filePath: f }); return { file: f, id: req && req.id, project_path: req && req.project_path } })()`)
    if (r.value && r.value.id) request = r.value
    else await sleep(500)
  }
  summary.steps.popup_request = request || 'not loaded'
  log('popup request', request)
  if (!request) return

  // Poll delivery status in the background (newer builds only).
  let polling = true
  ;(async () => {
    let last = null
    while (polling) {
      const r = await cdp.evaluate(invokeExpr('get_mcp_delivery_status', {}))
      const s = r.value ? (r.value.ok ? r.value.v : `ERR:${r.value.e}`) : `EVAL:${r.error}`
      if (s !== last) { summary.delivery_status_timeline.push(`${sec()}s ${s}`); log('delivery status', s); last = s }
      await sleep(1000)
    }
  })()

  const sinceCall = () => Date.now() - callStarted
  const waitUntil = async ms => { while (sinceCall() < ms) await sleep(200) }
  if (scenario === 'A') await waitUntil(3000)
  else if (scenario === 'C') await waitUntil(90000)
  else if (scenario === 'D') {
    await waitUntil(60000)
    notify('notifications/cancelled', { requestId: call.id, reason: 'timed out (probe simulates Codex tool_timeout_sec=60)' })
    log('sent notifications/cancelled')
    await waitUntil(70000)
  }
  else if (scenario === 'E') {
    await waitUntil(60000)
    // Only the mcp-server process; its serve child must survive, like when Codex drops the server.
    mcp.kill()
    log('killed mcp-server (client side gone)')
    await waitUntil(70000)
  }

  summary.temp_before_reply = tempArtifacts()
  const reply = await cdp.evaluate(invokeExpr('send_mcp_response', {
    response: { user_input: `probe-reply ${tag}`, selected_options: ['选项1'], images: [], metadata: { request_id: request.id, source: 'popup' } },
    projectPath: request.project_path || projectDir,
    requestId: request.id,
    timelineRouteId: null,
  }))
  summary.steps.send_mcp_response = reply.value || { eval_error: reply.error }
  log('send_mcp_response', summary.steps.send_mcp_response)
  summary.temp_right_after_reply = tempArtifacts()

  const end = Date.now() + 30000
  while (!callResult && !mcpExited && Date.now() < end) await sleep(200)
  polling = false
  await sleep(1200)
  const text = JSON.stringify(callResult || {})
  summary.steps.client_received = callResult ? (text.includes('probe-reply') ? 'reply delivered' : `returned without reply: ${text.slice(0, 400)}`) : (mcpExited ? 'mcp-server gone' : 'no result within 30s')
  log('client_received', summary.steps.client_received)
  cdp.close()
}

try { await main() }
catch (e) { summary.steps.harness_error = String(e && e.stack || e); log('harness error', String(e)) }
finally {
  summary.temp_at_end = tempArtifacts()
  const tmp = os.tmpdir()
  for (const f of ['iterate-instance-debug.log']) {
    try { fs.copyFileSync(path.join(tmp, f), path.join(outDir, `${tag}.${f}`)) } catch {}
  }
  fs.writeFileSync(path.join(outDir, `${tag}.summary.json`), JSON.stringify(summary, null, 2))
  console.log(`SUMMARY ${JSON.stringify(summary)}`)
  try { mcp.kill() } catch {}
  for (const im of ['iterate.exe', 'mcp-server.exe']) {
    try { execFileSync('taskkill', ['/F', '/IM', im], { stdio: 'ignore' }) } catch {}
  }
  process.exit(0)
}
