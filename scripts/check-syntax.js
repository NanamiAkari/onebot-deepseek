const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const ignoredDirs = new Set(['.git', 'node_modules'])
const files = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(path.join(dir, entry.name))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(dir, entry.name))
  }
}

walk(root)

let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) failed = true
}

if (failed) process.exit(1)
console.log(`Checked ${files.length} JavaScript files`)
