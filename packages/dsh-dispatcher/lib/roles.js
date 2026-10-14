import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Parse simple YAML frontmatter + Markdown body from a role file (`roles/*.md`).
 * Zero external dependencies.
 */
export function parseRoleMarkdown(content, filename = '') {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { meta: {}, body: normalized.trim() }
  }
  const endIdx = normalized.indexOf('\n---\n', 4)
  if (endIdx === -1) {
    return { meta: {}, body: normalized.trim() }
  }
  const rawYaml = normalized.slice(4, endIdx)
  const body = normalized.slice(endIdx + 5).trim()
  const meta = {}
  for (const line of rawYaml.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim()
    let val = trimmed.slice(colon + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    } else if (val === 'true') {
      val = true
    } else if (val === 'false') {
      val = false
    } else if (/^-?\d+$/.test(val)) {
      val = Number(val)
    }
    meta[key] = val
  }
  if (!meta.id && filename) {
    meta.id = filename.replace(/\.md$/, '')
  }
  return { meta, body }
}

/**
 * Load all role definitions from `rolesDir` and combine with `CORE.md` if present.
 */
export function loadRoles(rolesDir, coreMdPath) {
  const coreText = coreMdPath && existsSync(coreMdPath)
    ? readFileSync(coreMdPath, 'utf8').trim()
    : ''
  const roles = new Map()
  if (!existsSync(rolesDir)) return roles

  const files = readdirSync(rolesDir).filter(f => f.endsWith('.md')).sort()
  for (const file of files) {
    const fullPath = join(rolesDir, file)
    const raw = readFileSync(fullPath, 'utf8')
    const { meta, body } = parseRoleMarkdown(raw, file)
    const id = String(meta.id || file.replace(/\.md$/, ''))
    const systemPrompt = coreText
      ? `${body}\n\n---\n${coreText}`
      : body
    roles.set(id, {
      id,
      name: String(meta.name || id),
      description: String(meta.description || ''),
      order: typeof meta.order === 'number' ? meta.order : 50,
      defaultProvider: String(meta.defaultProvider || 'opencode-go'),
      defaultModel: String(meta.defaultModel || 'deepseek-v4.1-flash'),
      isolationMode: String(meta.isolationMode || 'none'),
      heavyWorker: Boolean(meta.heavyWorker),
      body,
      systemPrompt,
    })
  }
  return roles
}

/** Render one scalar as a plain YAML value (bare when safe, else double-quoted). */
function yamlValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value !== 'string') return '""'
  if (/^[a-zA-Z0-9._/-]+$/.test(value)) return value
  return JSON.stringify(value)
}

/**
 * Serialize one role back to the `roles/<id>.md` file format:
 * YAML frontmatter (`id`, `name`, `description`, `order`, `defaultProvider`,
 * `defaultModel`, `isolationMode`, `heavyWorker`) + Markdown body.
 * @param role - role fields including `body` (the role's own prompt, without CORE.md).
 * @returns the full file content.
 */
export function serializeRoleMarkdown(role) {
  const fields = [
    ['id', role.id],
    ['name', role.name],
    ['description', role.description],
    ['order', role.order],
    ['defaultProvider', role.defaultProvider],
    ['defaultModel', role.defaultModel],
    ['isolationMode', role.isolationMode],
    ['heavyWorker', role.heavyWorker],
  ]
  const lines = ['---']
  for (const [key, value] of fields) {
    if (value === undefined || value === null || value === '') continue
    lines.push(`${key}: ${yamlValue(value)}`)
  }
  lines.push('---', String(role.body ?? '').trim())
  return lines.join('\n') + '\n'
}
