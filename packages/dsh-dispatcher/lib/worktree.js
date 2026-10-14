import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/**
 * Run a git command synchronously inside `cwd`.
 */
function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  }).trim()
}

/**
 * Detect the primary branch (`main` or `master` or current HEAD branch) of a git repository.
 */
export function detectBaseBranch(repoPath) {
  try {
    const branches = runGit(repoPath, ['branch', '--format=%(refname:short)']).split('\n').map(s => s.trim())
    if (branches.includes('main')) return 'main'
    if (branches.includes('master')) return 'master'
    const current = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return current || 'main'
  } catch {
    return 'main'
  }
}

/**
 * Ensure an isolated git workspace exists for a task (`dev` / `qa`).
 * Uses a self-contained local clone so `.git/` lives inside `worktreePath`
 * and is 100% writable inside `dsh`'s `bwrap` workspace sandbox.
 */
export function ensureTaskWorktree(repoPath, taskId, worktreesRoot) {
  const canonicalRepo = resolve(repoPath)
  if (!existsSync(join(canonicalRepo, '.git'))) {
    throw new Error(`Repository at ${canonicalRepo} is not a git repository`)
  }
  const shortId = String(taskId).slice(0, 8)
  const repoSlug = basename(canonicalRepo)
  const branchName = `task/${shortId}`
  const worktreePath = join(resolve(worktreesRoot), repoSlug, `task-${shortId}`)
  const baseBranch = detectBaseBranch(canonicalRepo)

  if (existsSync(worktreePath)) {
    const gitEntry = join(worktreePath, '.git')
    if (existsSync(gitEntry) && statSync(gitEntry).isDirectory()) {
      return { worktreePath, branchName, baseBranch }
    }
    // Migrate away from old `git worktree` pointer file whose .git dir was outside bwrap mount
    try { runGit(canonicalRepo, ['worktree', 'remove', '--force', worktreePath]) } catch { /* ignore */ }
    rmSync(worktreePath, { recursive: true, force: true })
  }

  mkdirSync(join(resolve(worktreesRoot), repoSlug), { recursive: true })
  try { runGit(canonicalRepo, ['worktree', 'prune']) } catch { /* ignore */ }

  runGit(canonicalRepo, ['clone', '--local', '--no-hardlinks', '--branch', baseBranch, canonicalRepo, worktreePath])

  // Copy git user.name / user.email from canonicalRepo so commits inside the clone succeed
  try {
    const userName = runGit(canonicalRepo, ['config', 'user.name'])
    if (userName) runGit(worktreePath, ['config', 'user.name', userName])
  } catch { /* use global config */ }
  try {
    const userEmail = runGit(canonicalRepo, ['config', 'user.email'])
    if (userEmail) runGit(worktreePath, ['config', 'user.email', userEmail])
  } catch { /* use global config */ }

  runGit(worktreePath, ['checkout', '-B', branchName])

  return { worktreePath, branchName, baseBranch }
}

/**
 * Collect git status and diff summary from a worktree for QA handover.
 */
export function inspectWorktreeChanges(worktreePath, baseBranch = 'main') {
  if (!existsSync(worktreePath)) return { hasCommits: false, summary: 'Worktree does not exist' }
  try {
    // Auto-commit any uncommitted changes left by dev so QA tests a clean commit
    const status = runGit(worktreePath, ['status', '--porcelain'])
    if (status.length > 0) {
      runGit(worktreePath, ['add', '-A'])
      runGit(worktreePath, ['commit', '-m', 'chore(auto): snapshot uncommitted dev work before QA'])
    }
    const log = runGit(worktreePath, ['log', '--oneline', `${baseBranch}..HEAD`])
    const stat = runGit(worktreePath, ['diff', '--stat', `${baseBranch}...HEAD`])
    return {
      hasCommits: log.length > 0,
      summary: [
        '### Коммиты в ветке задачи:',
        log || '(нет новых коммитов)',
        '',
        '### Затронутые файлы:',
        stat || '(нет изменений относительно базовой ветки)',
      ].join('\n'),
    }
  } catch (err) {
    return { hasCommits: false, summary: `Ошибка чтения git worktree: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Sequential in-process mutex for `merge.lock` so two parallel QA passes never merge simultaneously.
 */
export class MergeLockQueue {
  #chain = Promise.resolve()
  #busy = false
  #pendingCount = 0

  get busy() {
    return this.#busy
  }

  get pendingCount() {
    return this.#pendingCount
  }

  runExclusive(fn) {
    this.#pendingCount += 1
    const run = async () => {
      this.#pendingCount = Math.max(0, this.#pendingCount - 1)
      this.#busy = true
      try {
        return await fn()
      } finally {
        this.#busy = false
      }
    }
    const next = this.#chain.then(run, run)
    this.#chain = next.catch(() => {})
    return next
  }
}

/**
 * Merge a verified task branch back into `baseBranch` inside `repoPath` and clean up the worktree.
 */
export function mergeTaskWorktree(repoPath, worktreePath, branchName, baseBranch = 'main') {
  const canonicalRepo = resolve(repoPath)
  try {
    // Ensure worktree has no dirty files
    if (existsSync(worktreePath)) {
      const wtStatus = runGit(worktreePath, ['status', '--porcelain'])
      if (wtStatus.length > 0) {
        runGit(worktreePath, ['add', '-A'])
        runGit(worktreePath, ['commit', '-m', 'chore(auto): commit remaining changes before merge'])
      }
    }

    // Checkout baseBranch in main repo if not already there
    const currentBranch = runGit(canonicalRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (currentBranch !== baseBranch) {
      runGit(canonicalRepo, ['checkout', baseBranch])
    }

    // Fetch task branch from isolated clone into canonicalRepo
    if (existsSync(worktreePath)) {
      runGit(canonicalRepo, ['fetch', '--force', worktreePath, `${branchName}:${branchName}`])
    }

    // Attempt merge --no-ff
    try {
      const mergeOut = runGit(canonicalRepo, ['merge', '--no-ff', branchName, '-m', `Merge branch '${branchName}' (QA passed)`])
      // Clean up worktree and branch after successful merge
      if (existsSync(worktreePath)) {
        try { runGit(canonicalRepo, ['worktree', 'remove', '--force', worktreePath]) } catch { /* ignore */ }
        rmSync(worktreePath, { recursive: true, force: true })
      }
      try { runGit(canonicalRepo, ['worktree', 'prune']) } catch { /* ignore */ }
      try { runGit(canonicalRepo, ['branch', '-D', branchName]) } catch { /* ignore */ }
      return { ok: true, conflict: false, output: mergeOut }
    } catch (mergeErr) {
      // Abort merge so main repo stays clean, and report conflict back to dev!
      try { runGit(canonicalRepo, ['merge', '--abort']) } catch { /* ignore */ }
      return {
        ok: false,
        conflict: true,
        error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
      }
    }
  } catch (err) {
    return {
      ok: false,
      conflict: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * List all active task worktrees under `worktreesRoot` and enrich with ledger task metadata.
 */
export function listActiveWorktrees(worktreesRoot, ledgerTasks = []) {
  const root = resolve(worktreesRoot)
  if (!existsSync(root)) return []
  const items = []
  let repoDirs = []
  try {
    repoDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return []
  }

  for (const repoDir of repoDirs) {
    const repoSlug = repoDir.name
    const repoGroupPath = join(root, repoSlug)
    let wtDirs = []
    try {
      wtDirs = readdirSync(repoGroupPath, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      continue
    }

    for (const wtEntry of wtDirs) {
      const worktreePath = join(repoGroupPath, wtEntry.name)
      const shortId = wtEntry.name.startsWith('task-') ? wtEntry.name.slice('task-'.length) : wtEntry.name
      const matchedTask = ledgerTasks.find(
        (t) =>
          t.worktreePath === worktreePath
          || t.id === shortId
          || t.id.startsWith(shortId)
      )

      let branchName = matchedTask?.branchName || `task/${shortId}`
      let dirty = false
      let dirtyFilesCount = 0
      let originUrl = null
      try {
        const revBranch = runGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
        if (revBranch) branchName = revBranch
      } catch { /* ignore */ }
      try {
        const st = runGit(worktreePath, ['status', '--porcelain'])
        if (st.length > 0) {
          dirty = true
          dirtyFilesCount = st.split('\n').filter(Boolean).length
        }
      } catch { /* ignore */ }
      try {
        const remoteUrl = runGit(worktreePath, ['config', '--get', 'remote.origin.url'])
        if (remoteUrl) originUrl = remoteUrl
      } catch { /* ignore */ }

      items.push({
        worktreePath,
        repoSlug,
        repoPath: matchedTask?.repoPath || originUrl || null,
        branchName,
        baseBranch: matchedTask?.baseBranch || 'main',
        dirty,
        dirtyFilesCount,
        taskId: matchedTask?.id || shortId,
        taskTitle: matchedTask?.title || null,
        taskStatus: matchedTask?.status || null,
        taskRole: matchedTask?.role || null,
      })
    }
  }
  return items
}

/**
 * Force-remove an isolated task worktree and optionally delete its task branch in the main repository.
 */
export function removeWorktreeByPath(repoPath, worktreePath, branchName) {
  try {
    if (repoPath && existsSync(repoPath)) {
      const canonicalRepo = resolve(repoPath)
      if (worktreePath && existsSync(worktreePath)) {
        try { runGit(canonicalRepo, ['worktree', 'remove', '--force', worktreePath]) } catch { /* ignore */ }
      }
      try { runGit(canonicalRepo, ['worktree', 'prune']) } catch { /* ignore */ }
      if (branchName && branchName !== 'main' && branchName !== 'master') {
        try { runGit(canonicalRepo, ['branch', '-D', branchName]) } catch { /* ignore */ }
      }
    }
    if (worktreePath && existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true })
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * File-based mutex lock (`host.lock`) for SRE `host_exclusive` tasks.
 */
export class HostExclusiveLock {
  constructor(lockFilePath = '/tmp/diveteam-host.lock') {
    this.lockFilePath = lockFilePath
  }

  isLocked() {
    if (!existsSync(this.lockFilePath)) return false
    try {
      const data = JSON.parse(readFileSync(this.lockFilePath, 'utf8'))
      if (data.pid && Number.isInteger(data.pid)) {
        try {
          process.kill(data.pid, 0)
          return true
        } catch {
          // Stale lock from dead process
          unlinkSync(this.lockFilePath)
          return false
        }
      }
      return true
    } catch {
      return false
    }
  }

  acquire(taskId) {
    if (this.isLocked()) {
      const current = this.readOwner()
      if (current?.taskId === taskId) return true
      return false
    }
    writeFileSync(this.lockFilePath, JSON.stringify({
      pid: process.pid,
      taskId,
      acquiredAt: Date.now(),
    }, null, 2), 'utf8')
    return true
  }

  release(taskId) {
    if (!existsSync(this.lockFilePath)) return
    try {
      const current = this.readOwner()
      if (!taskId || !current || current.taskId === taskId) {
        unlinkSync(this.lockFilePath)
      }
    } catch { /* ignore */ }
  }

  readOwner() {
    try {
      return JSON.parse(readFileSync(this.lockFilePath, 'utf8'))
    } catch {
      return null
    }
  }
}
