/**
 * Host half of @diveteam/dsh-client-diveteam-ui.
 *
 * Serves the roles editor's HTTP surface: list the `roles/*.md` definitions and
 * write one role back (re-running `sync-roles.mjs` so the agent presets stay in
 * sync). The browser half reads/writes these same-origin routes.
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the webServer Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import { loadRoles, serializeRoleMarkdown } from '../../dsh-dispatcher/lib/roles.js'

export const name = 'diveteam-ui'

export const inject = ['webServer']

const DEFAULT_PROJECT_ROOT = '/home/slava/Projects/DSH'
const API_PREFIX = '/diveteam'
const LEGACY_API_PREFIX = '/farvater'
const CORE_ROLE_IDS = new Set(['shturman', 'arch', 'dev', 'qa', 'sre', 'reg'])

export const Config = z.object({
  projectRoot: z.string().default(DEFAULT_PROJECT_ROOT),
})

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Browser same-origin tripwire: a bare curl sends neither header and is refused.
 * The browser sets `sec-fetch-site: same-origin` (or an Origin) on its own fetch,
 * which a cross-site page cannot forge.
 */
function isTrusted(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true
  if (typeof req.headers.origin === 'string') return true
  return false
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

/** Activate the host half: register the roles list + write/create/delete routes. */
export function apply(ctx: any, config: Record<string, unknown> = {}): void {
  const projectRoot = resolve(String(config.projectRoot || DEFAULT_PROJECT_ROOT))
  const rolesDir = join(projectRoot, 'roles')
  const coreMdPath = join(projectRoot, 'vault', 'memory', 'CORE.md')
  const syncScript = join(projectRoot, 'scripts', 'sync-roles.mjs')

  const rolesRoute: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/roles`,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
      if (req.method === 'GET') {
        const roles = [...loadRoles(rolesDir, coreMdPath).values()]
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
          .map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            order: r.order,
            defaultProvider: r.defaultProvider,
            defaultModel: r.defaultModel,
            isolationMode: r.isolationMode,
            heavyWorker: r.heavyWorker,
            body: r.body,
            isCore: CORE_ROLE_IDS.has(r.id),
          }))
        return writeJson(res, 200, { ok: true, roles })
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        let body: any
        try {
          body = await readJson(req)
        } catch {
          return writeJson(res, 400, { ok: false, error: 'invalid-json' })
        }
        const id = String(body?.id ?? '').trim().toLowerCase()
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
          return writeJson(res, 400, { ok: false, error: 'Некорректный ID роли (только латинские буквы, цифры, дефис или подчёркивание)' })
        }
        const roleFile = join(rolesDir, `${id}.md`)
        if (req.method === 'POST' && existsSync(roleFile) && body?.overwrite !== true) {
          return writeJson(res, 409, { ok: false, error: `Роль с ID "${id}" уже существует` })
        }
        const role = {
          id,
          name: String(body.name ?? id),
          description: String(body.description ?? ''),
          order: Number.isFinite(Number(body.order)) ? Number(body.order) : 70,
          defaultProvider: String(body.defaultProvider || 'opencode-go'),
          defaultModel: String(body.defaultModel || 'deepseek-v4.1-flash'),
          isolationMode: String(body.isolationMode || 'none'),
          heavyWorker: Boolean(body.heavyWorker),
          body: String(body.body ?? ''),
        }
        writeFileSync(roleFile, serializeRoleMarkdown(role), 'utf8')
        try {
          execFileSync(process.execPath, [syncScript], { cwd: projectRoot, stdio: 'pipe' })
        } catch (error) {
          return writeJson(res, 500, { ok: false, error: `sync-failed: ${error instanceof Error ? error.message : String(error)}` })
        }
        return writeJson(res, 200, { ok: true, id, role })
      }
      if (req.method === 'DELETE') {
        let body: any = {}
        try {
          body = await readJson(req)
        } catch { /* ignore */ }
        const urlObj = new URL(req.url || '/diveteam/roles', 'http://localhost')
        const id = String(body?.id || urlObj.searchParams.get('id') || '').trim().toLowerCase()
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
          return writeJson(res, 400, { ok: false, error: 'invalid-id' })
        }
        if (CORE_ROLE_IDS.has(id)) {
          return writeJson(res, 400, { ok: false, error: `Базовую роль "${id}" нельзя удалить` })
        }
        const roleFile = join(rolesDir, `${id}.md`)
        if (!existsSync(roleFile)) {
          return writeJson(res, 404, { ok: false, error: 'not-found' })
        }
        unlinkSync(roleFile)
        try {
          execFileSync(process.execPath, [syncScript], { cwd: projectRoot, stdio: 'pipe' })
        } catch (error) {
          return writeJson(res, 500, { ok: false, error: `sync-failed: ${error instanceof Error ? error.message : String(error)}` })
        }
        return writeJson(res, 200, { ok: true, id })
      }
      return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    },
  }

  const legacyRolesRoute: WebRoute = {
    kind: 'exact',
    path: `${LEGACY_API_PREFIX}/roles`,
    handler: rolesRoute.handler,
  }

  ctx.effect(() => {
    ctx.webServer.register(rolesRoute)
    ctx.webServer.register(legacyRolesRoute)
  }, 'diveteam-ui: roles routes')
}
