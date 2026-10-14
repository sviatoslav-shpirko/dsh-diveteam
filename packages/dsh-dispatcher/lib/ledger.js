import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Board columns. A task lives in exactly one. */
export const TASK_STATUSES = ['backlog', 'todo', 'running', 'done', 'failed']

/** Core built-in roles; custom roles created in `roles/*.md` are also accepted. */
export const TASK_ROLES = ['shturman', 'arch', 'dev', 'qa', 'sre', 'reg']

/** Validate a role identifier (lowercase alphanumeric, hyphen, underscore). */
export function isValidRoleId(role) {
  return typeof role === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(role.trim())
}

/** Fields `update` coerces to strings (or null when patched with null). */
const STRING_FIELDS = ['title', 'description', 'prompt', 'phase', 'isolationMode', 'parentId', 'repoPath', 'worktreePath', 'branchName', 'baseBranch', 'qaNotes', 'qaVerdict', 'approvalRequested', 'vaultPath']

/** Normalize a raw input object into a complete task record. */
function normalizeTask(input) {
  const now = new Date().toISOString()
  const rawDeps = Array.isArray(input.dependsOn)
    ? input.dependsOn
    : typeof input.dependsOn === 'string' && input.dependsOn.trim()
      ? input.dependsOn.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  const roleStr = typeof input.role === 'string' ? input.role.trim() : ''
  const id = input.id ?? `t-${randomUUID().slice(0, 8)}`
  const parentIdRaw = input.parentId != null && String(input.parentId).trim() !== '' ? String(input.parentId).trim() : null
  const isolationRaw = input.isolationMode != null && String(input.isolationMode).trim() !== '' ? String(input.isolationMode).trim() : null
  return {
    id,
    title: String(input.title ?? ''),
    description: String(input.description ?? ''),
    prompt: String(input.prompt ?? ''),
    role: isValidRoleId(roleStr) ? roleStr : 'dev',
    isolationMode: isolationRaw,
    parentId: parentIdRaw === id ? null : parentIdRaw,
    dependsOn: [...new Set(rawDeps.map((d) => String(d).trim()).filter((d) => d && d !== id))],
    status: TASK_STATUSES.includes(input.status) ? input.status : 'backlog',
    phase: String(input.phase ?? 'draft'),
    repoPath: input.repoPath != null ? String(input.repoPath) : null,
    worktreePath: input.worktreePath != null ? String(input.worktreePath) : null,
    branchName: input.branchName != null ? String(input.branchName) : null,
    baseBranch: input.baseBranch != null ? String(input.baseBranch) : null,
    attemptCount: Number(input.attemptCount ?? 0),
    qaNotes: input.qaNotes != null ? String(input.qaNotes) : null,
    qaVerdict: input.qaVerdict != null ? String(input.qaVerdict) : null,
    approvalRequested: input.approvalRequested != null ? String(input.approvalRequested) : null,
    exportedToVault: Boolean(input.exportedToVault),
    vaultPath: input.vaultPath != null ? String(input.vaultPath) : null,
    comments: Array.isArray(input.comments) ? input.comments : [],
    activity: Array.isArray(input.activity) ? input.activity : [],
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  }
}

/**
 * A file-backed task ledger. The dispatcher owns the single instance; the board
 * UI reads/writes it through the /diveteam/tasks routes (with /farvater/tasks alias). Zero dependencies.
 * @param filePath - JSON file storing the task array.
 */
export function createTaskLedger(filePath) {
  let tasks = read()

  function read() {
    if (!existsSync(filePath)) return []
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      return Array.isArray(data) ? data.map(normalizeTask) : []
    } catch {
      return []
    }
  }

  function write() {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(tasks, null, 2) + '\n', 'utf8')
  }

  function resolveDepTask(depId, taskList = tasks) {
    return taskList.find((t) => t.id === depId || t.id.startsWith(depId))
  }

  function wouldCreateCycle(sourceId, candidateDepId, taskList = tasks) {
    const startTask = resolveDepTask(candidateDepId, taskList)
    if (!startTask) return false
    if (startTask.id === sourceId || sourceId.startsWith(startTask.id)) return true
    const visited = new Set()
    const stack = [startTask]
    while (stack.length > 0) {
      const curr = stack.pop()
      if (!curr || visited.has(curr.id)) continue
      visited.add(curr.id)
      for (const nextDepId of curr.dependsOn || []) {
        if (nextDepId === sourceId || sourceId.startsWith(nextDepId)) return true
        const nextTask = resolveDepTask(nextDepId, taskList)
        if (nextTask) {
          if (nextTask.id === sourceId) return true
          stack.push(nextTask)
        }
      }
    }
    return false
  }

  function sanitizeDependsOn(taskId, rawDeps) {
    const list = Array.isArray(rawDeps)
      ? rawDeps
      : typeof rawDeps === 'string' && rawDeps.trim()
        ? rawDeps.split(',').map((s) => s.trim()).filter(Boolean)
        : []
    const unique = [...new Set(list.map((d) => String(d).trim()).filter(Boolean))]
    return unique.filter((depId) => depId !== taskId && !taskId.startsWith(depId) && !wouldCreateCycle(taskId, depId))
  }

  return {
    /** Every task, most recently created last. */
    list() {
      return tasks
    },
    /** One task by id, or undefined. */
    get(id) {
      return tasks.find((t) => t.id === id)
    },
    /** Create one task from the given fields. */
    create(input) {
      const task = normalizeTask(input)
      task.dependsOn = sanitizeDependsOn(task.id, task.dependsOn)
      tasks = [...tasks, task]
      write()
      return task
    },
    /** Patch a task's fields; undefined is skipped, null clears nullable strings. */
    update(id, patch) {
      const index = tasks.findIndex((t) => t.id === id)
      if (index === -1) return undefined
      const next = { ...tasks[index] }
      for (const field of STRING_FIELDS) {
        if (patch[field] !== undefined) {
          const val = patch[field] == null ? null : String(patch[field])
          next[field] = (field === 'parentId' || field === 'isolationMode') && val !== null && val.trim() === ''
            ? null
            : val
        }
      }
      if (next.parentId === next.id) next.parentId = null
      if (patch.role !== undefined && isValidRoleId(patch.role)) next.role = patch.role.trim()
      if (TASK_STATUSES.includes(patch.status)) next.status = patch.status
      if (patch.attemptCount !== undefined) next.attemptCount = Number(patch.attemptCount)
      if (patch.exportedToVault !== undefined) next.exportedToVault = Boolean(patch.exportedToVault)
      if (patch.dependsOn !== undefined) {
        next.dependsOn = sanitizeDependsOn(next.id, patch.dependsOn)
      }
      if (Array.isArray(patch.comments)) next.comments = patch.comments
      if (Array.isArray(patch.activity)) next.activity = patch.activity
      next.updatedAt = new Date().toISOString()
      tasks = tasks.map((t, i) => (i === index ? next : t))
      write()
      return next
    },
    /** Append a timestamped comment. Returns the task, or undefined when absent. */
    addComment(id, author, text) {
      const index = tasks.findIndex((t) => t.id === id)
      if (index === -1) return undefined
      const comment = { author: String(author || 'unknown'), text: String(text || ''), at: new Date().toISOString() }
      const next = { ...tasks[index], comments: [...tasks[index].comments, comment], updatedAt: new Date().toISOString() }
      tasks = tasks.map((t, i) => (i === index ? next : t))
      write()
      return next
    },
    /** Append a timestamped agent activity item (message, tool call, created file content, output). */
    addActivity(id, item) {
      const index = tasks.findIndex((t) => t.id === id)
      if (index === -1) return undefined
      const bodyText = String(item?.text ?? item?.content ?? '')
      const entry = {
        role: String(item?.role || 'agent'),
        kind: String(item?.kind || 'step'),
        title: String(item?.title || ''),
        text: bodyText,
        content: bodyText,
        at: item?.at || new Date().toISOString(),
      }
      const prevActivity = Array.isArray(tasks[index].activity) ? tasks[index].activity : []
      const next = { ...tasks[index], activity: [...prevActivity, entry], updatedAt: new Date().toISOString() }
      tasks = tasks.map((t, i) => (i === index ? next : t))
      write()
      return next
    },
    /** Delete a task by id. Returns true if removed. */
    remove(id) {
      const before = tasks.length
      tasks = tasks.filter((t) => t.id !== id)
      if (tasks.length === before) return false
      write()
      return true
    },
  }
}
