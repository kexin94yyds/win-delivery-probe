// Runs e2e/run.mjs for each build x scenario on a Windows runner and writes a summary table.
// Builds come from the public release repo kexin94yyds/iterate-releases (already public),
// or from EXTRA_ZIP_URL. Env: VERSIONS="v0.6.4 v0.7.2", SCENARIOS="A C D E", EXTRA_ZIP_URL, EXTRA_LABEL.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve('e2e-work')
const out = path.resolve('e2e-out')
fs.mkdirSync(root, { recursive: true })
fs.mkdirSync(out, { recursive: true })
const versions = (process.env.VERSIONS || 'v0.6.4 v0.7.2').split(/\s+/).filter(Boolean)
const scenarios = (process.env.SCENARIOS || 'A C D E').split(/\s+/).filter(Boolean)
const builds = versions.map(v => ({ label: v, url: `https://github.com/kexin94yyds/iterate-releases/releases/download/${v}/iterate-windows-x64.zip` }))
if (process.env.EXTRA_ZIP_URL) builds.push({ label: process.env.EXTRA_LABEL || 'extra', url: process.env.EXTRA_ZIP_URL })

const ps = cmd => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).stdout.trim()
const env = {
  temp: os.tmpdir(),
  temp_fs: ps('(Get-Volume -DriveLetter ($env:TEMP[0])).FileSystemType'),
  windows: ps('(Get-CimInstance Win32_OperatingSystem).Caption + \' \' + (Get-CimInstance Win32_OperatingSystem).BuildNumber'),
  webview2: ps('(Get-ItemProperty \'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}\' -ErrorAction SilentlyContinue).pv'),
}
try {
  const a = path.join(os.tmpdir(), `probe-link-${process.pid}.txt`)
  fs.writeFileSync(a, 'x')
  fs.linkSync(a, `${a}.link`)
  env.temp_hard_link = 'ok'
  fs.unlinkSync(`${a}.link`)
  fs.unlinkSync(a)
}
catch (e) { env.temp_hard_link = `failed: ${e.code} ${e.message}` }
console.log('ENV', JSON.stringify(env))
const selfcheck = () => {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'e2e/selfcheck.ps1'], { encoding: 'utf8', timeout: 5 * 60 * 1000 })
  return `exit=${r.status}\n${r.stdout}\n${r.stderr}`
}

const rows = []
for (const b of builds) {
  const dir = path.join(root, b.label)
  const zip = `${dir}.zip`
  try {
    const res = await fetch(b.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${dir}'`])
  }
  catch (e) { rows.push({ build: b.label, scenario: '-', result: `download failed: ${e.message}` }); continue }
  // Self-check with this build's processes absent, so its report sections are exercised on real Windows.
  fs.writeFileSync(path.join(out, `${b.label}.selfcheck.txt`), selfcheck())
  for (const s of scenarios) {
    for (const im of ['iterate.exe', 'mcp-server.exe']) spawnSync('taskkill', ['/F', '/IM', im], { stdio: 'ignore' })
    for (const n of fs.readdirSync(os.tmpdir())) {
      if (/^iterate_(response|delivery|request|ready)|\.response\.claim$/.test(n)) { try { fs.rmSync(path.join(os.tmpdir(), n), { force: true }) } catch {} }
    }
    spawnSync(process.execPath, ['e2e/run.mjs', '--dir', dir, '--label', b.label, '--scenario', s, '--out', out], { stdio: 'inherit', timeout: 6 * 60 * 1000 })
    let sum = {}
    try { sum = JSON.parse(fs.readFileSync(path.join(out, `${b.label}-${s}.summary.json`), 'utf8')) } catch {}
    const st = sum.steps || {}
    const send = st.send_mcp_response
    rows.push({
      build: b.label,
      scenario: s,
      popup: st.popup_request ? (st.popup_request.id ? 'loaded' : String(st.popup_request)) : String(st.popup_devtools || st.harness_error || '?'),
      send_mcp_response: send ? (send.ok ? 'ok' : `ERR ${send.e || send.eval_error}`) : '-',
      client_received: st.client_received || '-',
      delivery_status: (sum.delivery_status_timeline || []).join(' → '),
    })
  }
}
const md = [
  `### iterate Windows reply delivery (e2e)`,
  '',
  '```',
  JSON.stringify(env, null, 2),
  '```',
  '',
  '| build | scenario | popup | send_mcp_response | client received | delivery status |',
  '|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.build} | ${r.scenario} | ${r.popup ?? ''} | ${(r.send_mcp_response ?? r.result ?? '').replace(/\|/g, '/')} | ${(r.client_received ?? '').replace(/\|/g, '/')} | ${r.delivery_status ?? ''} |`),
].join('\n')
fs.writeFileSync(path.join(out, 'SUMMARY.md'), md)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
console.log(md)
