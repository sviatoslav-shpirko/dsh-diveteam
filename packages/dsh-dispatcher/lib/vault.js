import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const VAULT_CATEGORIES = [
  { dir: 'memory', filter: (f) => f === 'CORE.md', category: 'core' },
  { dir: 'memory/proposals', filter: (f) => f.endsWith('.md'), category: 'proposals' },
  { dir: 'memory/lessons', filter: (f) => f.endsWith('.md'), category: 'lessons' },
  { dir: 'notes', filter: (f) => f.endsWith('.md'), category: 'notes' },
  { dir: 'inbox', filter: (f) => f.endsWith('.md'), category: 'inbox' },
  { dir: 'tasks/done', filter: (f) => f.endsWith('.md'), category: 'tasks' },
  { dir: 'graphify-out', filter: (f) => f === 'GRAPH_REPORT.md', category: 'graph' },
]

/**
 * Resolve a relative path safely inside `vaultDir`. Throws on path traversal.
 */
export function resolveVaultPath(vaultDir, relPath) {
  const root = resolve(vaultDir)
  const cleaned = String(relPath || '').replace(/^[/\\]+/, '')
  if (!cleaned) throw new Error('Empty path')
  const full = resolve(root, cleaned)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('Path traversal forbidden')
  }
  return { full, rel: relative(root, full).split(sep).join('/') }
}

/**
 * List all markdown files in the vault grouped by category, plus graphify stats.
 */
export function inspectVault(vaultDir) {
  const root = resolve(vaultDir)
  const files = []

  for (const spec of VAULT_CATEGORIES) {
    const folder = join(root, spec.dir)
    if (!existsSync(folder)) continue
    let entries = []
    try {
      entries = readdirSync(folder)
    } catch {
      continue
    }
    for (const name of entries.sort()) {
      if (!spec.filter(name)) continue
      const full = join(folder, name)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        const rel = relative(root, full).split(sep).join('/')
        files.push({
          path: rel,
          name,
          category: spec.category,
          size: st.size,
          updatedAt: st.mtime.toISOString(),
        })
      } catch {
        // ignore unreadable entry
      }
    }
  }

  const graphPath = join(root, 'graphify-out', 'graph.json')
  let graphSummary = {
    exists: false,
    nodesCount: 0,
    edgesCount: 0,
    communities: [],
    builtAtCommit: null,
    updatedAt: null,
  }
  if (existsSync(graphPath)) {
    try {
      const st = statSync(graphPath)
      const raw = JSON.parse(readFileSync(graphPath, 'utf8'))
      const nodes = Array.isArray(raw.nodes) ? raw.nodes : []
      const edges = Array.isArray(raw.links) ? raw.links : (Array.isArray(raw.edges) ? raw.edges : [])
      const commSet = new Set()
      for (const n of nodes) {
        if (n.community_name) commSet.add(String(n.community_name))
      }
      graphSummary = {
        exists: true,
        nodesCount: nodes.length,
        edgesCount: edges.length,
        communities: [...commSet].slice(0, 20),
        builtAtCommit: raw.built_at_commit || null,
        updatedAt: st.mtime.toISOString(),
      }
    } catch {
      // ignore malformed graph.json
    }
  }

  return { files, graphSummary }
}

/**
 * Read one file from `vaultDir`.
 */
export function readVaultFile(vaultDir, relPath) {
  const { full, rel } = resolveVaultPath(vaultDir, relPath)
  if (!existsSync(full)) throw new Error(`File not found: ${rel}`)
  return {
    path: rel,
    content: readFileSync(full, 'utf8'),
  }
}

/**
 * Write one file inside `vaultDir`, optionally syncing roles if `CORE.md` changed.
 */
export function writeVaultFile(vaultDir, relPath, content, projectRoot) {
  const { full, rel } = resolveVaultPath(vaultDir, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, String(content ?? ''), 'utf8')
  if (rel === 'memory/CORE.md' && projectRoot) {
    const syncScript = join(projectRoot, 'scripts', 'sync-roles.mjs')
    if (existsSync(syncScript)) {
      try {
        execFileSync(process.execPath, [syncScript], { cwd: projectRoot, stdio: 'pipe' })
      } catch { /* best-effort */ }
    }
  }
  return { path: rel }
}

/**
 * Delete a file inside `vaultDir` (protects `memory/CORE.md`).
 */
export function deleteVaultFile(vaultDir, relPath) {
  const { full, rel } = resolveVaultPath(vaultDir, relPath)
  if (rel === 'memory/CORE.md') throw new Error('Cannot delete memory/CORE.md')
  if (existsSync(full)) unlinkSync(full)
  return { deleted: rel }
}

/**
 * Apply a proposal from `memory/proposals/*.md` into `memory/CORE.md` and remove the proposal file.
 */
export function applyCoreProposal(vaultDir, proposalRelPath, projectRoot) {
  const { full: propFull, rel: propRel } = resolveVaultPath(vaultDir, proposalRelPath)
  if (!existsSync(propFull)) throw new Error(`Proposal not found: ${propRel}`)
  const proposalText = readFileSync(propFull, 'utf8')

  // Extract lines inside ```diff ... ``` or append cleaned proposal body
  const diffMatches = [...proposalText.matchAll(/```diff\n([\s\S]*?)```/g)]
  let extracted = ''
  if (diffMatches.length > 0) {
    const rawDiff = diffMatches[diffMatches.length - 1][1]
    const addedLines = rawDiff
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
    extracted = addedLines.length > 0 ? addedLines.join('\n').trim() : rawDiff.trim()
  } else {
    extracted = proposalText.trim()
  }

  const corePath = join(resolve(vaultDir), 'memory', 'CORE.md')
  const prevCore = existsSync(corePath) ? readFileSync(corePath, 'utf8').trimEnd() : '# CORE.md'
  const nextCore = `${prevCore}\n\n<!-- Применено из ${propRel} (${new Date().toISOString().slice(0, 10)}) -->\n${extracted}\n`
  writeFileSync(corePath, nextCore, 'utf8')
  unlinkSync(propFull)

  if (projectRoot) {
    const syncScript = join(projectRoot, 'scripts', 'sync-roles.mjs')
    if (existsSync(syncScript)) {
      try {
        execFileSync(process.execPath, [syncScript], { cwd: projectRoot, stdio: 'pipe' })
      } catch { /* best-effort */ }
    }
  }

  return { applied: propRel, coreContent: nextCore }
}

/**
 * Query `vault/graphify-out/graph.json` and markdown files in `vaultDir`.
 */
export function queryVaultGraph(vaultDir, queryText) {
  const root = resolve(vaultDir)
  const q = String(queryText || '').trim().toLowerCase()
  const terms = q.split(/\s+/).filter(Boolean)

  const graphPath = join(root, 'graphify-out', 'graph.json')
  const matchedNodes = []
  const matchedEdges = []

  if (existsSync(graphPath)) {
    try {
      const raw = JSON.parse(readFileSync(graphPath, 'utf8'))
      const nodes = Array.isArray(raw.nodes) ? raw.nodes : []
      const edges = Array.isArray(raw.links) ? raw.links : (Array.isArray(raw.edges) ? raw.edges : [])
      const nodeMap = new Map(nodes.map((n) => [n.id, n]))

      for (const n of nodes) {
        const hay = [
          n.id,
          n.label,
          n.community_name,
          n.source_file,
          n.frontmatter ? JSON.stringify(n.frontmatter) : '',
        ].join(' ').toLowerCase()

        const matches = terms.length === 0 || terms.every((t) => hay.includes(t))
        if (matches) {
          matchedNodes.push({
            id: n.id,
            label: n.label || n.id,
            kind: n.node_kind || 'node',
            community: n.community_name || null,
            sourceFile: n.source_file || null,
            sourceLocation: n.source_location || null,
          })
        }
      }

      const matchedIds = new Set(matchedNodes.slice(0, 40).map((n) => n.id))
      for (const e of edges) {
        if (matchedIds.has(e.source) || matchedIds.has(e.target)) {
          const srcNode = nodeMap.get(e.source)
          const tgtNode = nodeMap.get(e.target)
          matchedEdges.push({
            source: srcNode?.label || e.source,
            target: tgtNode?.label || e.target,
            relation: e.relation || 'related',
            sourceFile: e.source_file || srcNode?.source_file || null,
          })
        }
      }
    } catch {
      // ignore
    }
  }

  // Also search markdown file contents in vault
  const { files } = inspectVault(root)
  const fileMatches = []
  if (terms.length > 0) {
    for (const f of files) {
      try {
        const text = readFileSync(join(root, f.path), 'utf8')
        const lower = text.toLowerCase()
        if (terms.some((t) => lower.includes(t))) {
          const lines = text.split('\n')
          const snippets = []
          for (let i = 0; i < lines.length; i++) {
            const lineLower = lines[i].toLowerCase()
            if (terms.some((t) => lineLower.includes(t))) {
              snippets.push(`L${i + 1}: ${lines[i].trim()}`)
              if (snippets.length >= 4) break
            }
          }
          fileMatches.push({
            path: f.path,
            category: f.category,
            snippets,
          })
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    query: queryText,
    nodes: matchedNodes.slice(0, 30),
    edges: matchedEdges.slice(0, 40),
    fileMatches: fileMatches.slice(0, 20),
  }
}
