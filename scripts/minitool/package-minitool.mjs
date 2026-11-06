#!/usr/bin/env node
// 小红书小工具打包：把 vite.minitool.config.ts 的构建结果整理成可上传的 zip。
// 合并自 Lot 665 音乐盒 scripts/package-minitool.mjs 和 POT POT tools/minitool/package.py。
//
//   node scripts/minitool/package-minitool.mjs [buildDir] [zipPath] [--force]
//
// 步骤：写 index.html → 拷 EXTRA_DIR → check-minitool → 官方 audit（目录）→ zip（index.html 在根）
//      → 官方 audit（zip）→ 体积门槛 → SHA-256 → 在 zip 旁写 validation.json
// 已有同名 zip 默认不覆盖（旧版本留着对比、回退），确认要覆盖再加 --force。
// 在项目根目录运行（npm script 默认就是）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ── 按项目改这里 ─────────────────────────────────────────
const TITLE = '杏花 · Almond Blossom'
const LANG = 'zh-CN'
const BACKGROUND = '#659fa8' // 首帧背景色，和作品主色一致，避免白屏闪一下
const BUILD_DIR = 'dist-minitool'
const ZIP_PATH = 'release/almond-blossom-minitool-v2.zip' // 每次出新包递增版本号，旧包保留
const EXTRA_DIR = 'minitool/static' // 这里的文件原样拷进包根（海报、字体、许可证……）；没有就算了
const JS_ENTRY = 'assets/app.js'
const CSS_ENTRY = 'assets/app.css' // 没有样式表就写 ''
const WRITE_INDEX_HTML = false // 手写 index.html 的项目（单文件 Canvas 之类）改成 false
// ────────────────────────────────────────────────────────

const root = process.cwd()
const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const force = process.argv.includes('--force')
const dist = path.resolve(root, args[0] || BUILD_DIR)
const zipPath = path.resolve(root, args[1] || ZIP_PATH)
const MIB = 1048576
const step = (s) => console.log(`\n── ${s}`)
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0

if (!fs.existsSync(dist)) {
  console.error(`${dist} 不存在，先构建`)
  process.exit(1)
}
if (!fs.existsSync(path.join(dist, JS_ENTRY)) && WRITE_INDEX_HTML) {
  console.error(`${path.join(dist, JS_ENTRY)} 不存在，先构建：vite build --config vite.minitool.config.ts`)
  process.exit(1)
}
if (fs.existsSync(zipPath) && !force) {
  console.error(`${zipPath} 已存在：要覆盖加 --force，或者把 ZIP_PATH 的版本号加一`)
  process.exit(1)
}

// 官方 skill：项目里的副本和全局那份都找，用版本最高的
function findSkill() {
  const candidates = [
    process.env.MINITOOL_SKILL_DIR,
    path.join(root, '.claude/skills/minitool-zip-builder'),
    path.join(root, '.codex/skills/minitool-zip-builder'),
    path.join(root, '.agents/skills/minitool-zip-builder'),
    path.join(root, '.codex/minitool-zip-builder'),
    path.join(os.homedir(), '.claude/skills/minitool-zip-builder'),
    path.join(os.homedir(), '.codex/skills/minitool-zip-builder'),
  ].filter((d) => d && fs.existsSync(path.join(d, 'scripts')))
  const version = (d) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, 'skill-package.json'), 'utf8')).version || '0'
    } catch {
      return '0'
    }
  }
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
    return 0
  }
  candidates.sort((a, b) => cmp(version(b), version(a)))
  return candidates[0] ? { dir: candidates[0], version: version(candidates[0]) } : null
}
const skill = findSkill()
const audit = (target) => {
  if (!skill) return { status: null, note: '没找到 minitool-zip-builder，未运行官方 audit' }
  const py = path.join(skill.dir, 'scripts/audit_artifact.py')
  const mjs = path.join(skill.dir, 'scripts/audit_artifact.mjs')
  // 下载来的脚本：用隔离模式跑（-I：不从脚本目录 / 当前目录加载模块）
  const python = fs.existsSync('/opt/homebrew/bin/python3.11') ? '/opt/homebrew/bin/python3.11' : has('python3') ? 'python3' : null
  const r =
    python && fs.existsSync(py)
      ? spawnSync(python, ['-I', py, target], { stdio: 'inherit' })
      : spawnSync(process.execPath, [mjs, target], { stdio: 'inherit' })
  return { status: r.status }
}

if (WRITE_INDEX_HTML) {
  step('index.html')
  const css = CSS_ENTRY && fs.existsSync(path.join(dist, CSS_ENTRY)) ? `\n  <link rel="stylesheet" href="./${CSS_ENTRY}" />` : ''
  fs.writeFileSync(
    path.join(dist, 'index.html'),
    `<!DOCTYPE html>
<html lang="${LANG}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <title>${TITLE}</title>
  <!-- 空 favicon：免得 PC 模拟器去请求 /favicon.ico -->
  <link rel="icon" href="data:," />
  <style>
    html, body { height: 100%; margin: 0; background: ${BACKGROUND}; }
    body { -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
  </style>${css}
</head>
<body>
  <div id="root"></div>
  <script src="./${JS_ENTRY}"></script>
</body>
</html>
`,
  )
  console.log('已写入')
}

// 访达打开过构建目录就会生成 .DS_Store；构建目录是一次性产物，直接清掉
for (const junk of ['.DS_Store', '__MACOSX']) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.name === junk) fs.rmSync(p, { recursive: true, force: true })
      else if (e.isDirectory()) walk(p)
    }
  }
  walk(dist)
}

const extra = path.resolve(root, EXTRA_DIR)
if (fs.existsSync(extra)) {
  step(`额外文件（${EXTRA_DIR}）`)
  fs.cpSync(extra, dist, { recursive: true })
  console.log(fs.readdirSync(extra).join('  '))
}

step('check-minitool')
const check = spawnSync(process.execPath, [path.join(here, 'check-minitool.mjs'), dist], { stdio: 'inherit' })

step(`官方 audit：目录（${skill ? `minitool-zip-builder ${skill.version}，${skill.dir.replace(os.homedir(), '~')}` : '未找到 skill'}）`)
const dirAudit = audit(dist)

step('打 zip（压缩目录内容，index.html 在根）')
fs.mkdirSync(path.dirname(zipPath), { recursive: true })
const partial = zipPath + '.partial'
fs.rmSync(partial, { force: true })
execFileSync('zip', ['-r', '-X', '-q', '-9', partial, '.', '-x', '*.DS_Store', '-x', '*.map', '-x', '__MACOSX/*'], { cwd: dist })
fs.renameSync(partial, zipPath)
const bytes = fs.statSync(zipPath).size
console.log(`${path.relative(root, zipPath)}  ${(bytes / MIB).toFixed(2)} MiB`)

step('官方 audit：zip')
const zipAudit = audit(zipPath)

step('zip 回读')
const listing = execFileSync('unzip', ['-Z1', zipPath]).toString().trim().split('\n')
const zipProblems = []
if (!listing.includes('index.html')) zipProblems.push('根目录没有 index.html')
for (const name of listing) {
  if (name.endsWith('/')) continue
  if (!/\.(html|css|js|json|png|jpe?g|gif|webp|svg|woff2?)$/i.test(name)) zipProblems.push(`白名单外的文件：${name}`)
  if (name.startsWith('/') || name.includes('../')) zipProblems.push(`路径不安全：${name}`)
}
const integrity = spawnSync('unzip', ['-tq', zipPath]).status === 0
if (!integrity) zipProblems.push('unzip -t 完整性测试失败')
zipProblems.forEach((p) => console.log(`ERROR: ${p}`))
console.log(`${listing.filter((n) => !n.endsWith('/')).length} 个文件，完整性 ${integrity ? 'OK' : '失败'}`)

const sizeError = bytes > 10 * MIB
const sizeWarn = bytes > 2 * MIB
if (sizeError) console.log('ERROR: zip 超过 10 MiB 硬上限')
else if (sizeWarn) console.log('NOTE: zip 超过 2 MiB 建议值，交付说明里写清楚原因')

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
const ok = check.status === 0 && dirAudit.status === 0 && zipAudit.status === 0 && !zipProblems.length && !sizeError
const report = {
  zip: path.relative(root, zipPath),
  bytes,
  mib: Number((bytes / MIB).toFixed(2)),
  sha256,
  files: listing.filter((n) => !n.endsWith('/')).length,
  builtAt: new Date().toISOString(),
  skill: skill ? `minitool-zip-builder ${skill.version}` : null,
  checks: {
    checkMinitool: check.status === 0 ? 'PASS' : 'FAIL',
    officialAuditDir: dirAudit.status === 0 ? 'PASS' : dirAudit.status === null ? 'NOT RUN' : 'FAIL',
    officialAuditZip: zipAudit.status === 0 ? 'PASS' : zipAudit.status === null ? 'NOT RUN' : 'FAIL',
    zipReadback: zipProblems.length ? zipProblems : 'PASS',
    size: sizeError ? 'FAIL (>10 MiB)' : sizeWarn ? 'WARN (>2 MiB)' : 'PASS',
  },
  pending: ['创服平台模拟器完整流程', 'Android 真机扫码', 'iOS 真机扫码'],
  passed: ok,
}
const reportPath = zipPath.replace(/\.zip$/, '') + '.validation.json'
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')

console.log(`\nSHA-256 ${sha256}`)
console.log(`校验记录 ${path.relative(root, reportPath)}`)
console.log(ok ? `\nREADY：${path.relative(root, zipPath)}（还要：创服平台模拟器 → Android 真机 → iOS 真机）` : '\nNOT READY：看上面的 ERROR')
process.exitCode = ok ? 0 : 1
