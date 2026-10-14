import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { loadRoles, serializeRoleMarkdown } from './roles.js'
import { createTaskLedger } from './ledger.js'
import { TelegramBridge } from './telegram.js'
import {
  applyCoreProposal,
  deleteVaultFile,
  inspectVault,
  queryVaultGraph,
  readVaultFile,
  writeVaultFile,
} from './vault.js'
import {
  ensureTaskWorktree,
  HostExclusiveLock,
  inspectWorktreeChanges,
  listActiveWorktrees,
  MergeLockQueue,
  mergeTaskWorktree,
  removeWorktreeByPath,
} from './worktree.js'

export const name = 'diveteam-dispatcher'
export const inject = ['sessionController', 'agents', 'webServer']

const HEAVY_ROLES = new Set(['dev', 'qa', 'sre'])
const DEFAULT_PROJECT_ROOT = '/home/slava/Projects/DSH'
const API_PREFIX = '/diveteam'

export const Config = z.object({
  projectRoot: z.string().default(DEFAULT_PROJECT_ROOT),
  maxHeavyWorkers: z.number().default(3),
  maxQaRetries: z.number().default(2),
  maxDailyTokens: z.number().default(2_000_000),
  hostLockPath: z.string().default('/tmp/diveteam-host.lock'),
})

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function isTrusted(req) {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true
  if (typeof req.headers.origin === 'string') return true
  return false
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export const DEFAULT_WORKFLOW_RULES = {
  pipeline: {
    autoHandoffDevToQa: true,
    requireDiffForQa: true,
    autoMergeOnQaPass: true,
    maxQaRetries: 2,
    qaEscalationTarget: 'arch',
    escalationNotifyTelegram: true,
    conflictFallback: 'dev',
    requireSreApproval: true,
    autoReleaseHostLock: true,
    parentAutoRollup: true,
    exportReportToVault: true,
    autoRunRegArchivist: true,
    maxHeavyWorkers: 3,
    maxDailyTokens: 2_000_000,
  },
  roleTransitions: {
    dev: {
      label: '💻 Разработка (Dev)',
      isolationMode: 'git_worktree',
      onSuccess: 'qa',
      onFailure: 'failed',
      requireApproval: false,
      description: 'Разработка в изолированном git_worktree. При успехе передаётся в QA.',
    },
    qa: {
      label: '🧪 Проверка (QA)',
      isolationMode: 'git_worktree',
      onSuccess: 'merge_and_done',
      onFailure: 'dev_or_escalate',
      requireApproval: false,
      description: 'Проверка в том же worktree. PASS -> merge.lock; FAIL -> возврат в dev или эскалация.',
    },
    sre: {
      label: '🛠️ Инфраструктура (SRE)',
      isolationMode: 'host_exclusive',
      onSuccess: 'done',
      onFailure: 'failed',
      requireApproval: true,
      description: 'Системные операции под host.lock. Опасные действия требуют аппрува @slava.',
    },
    arch: {
      label: '🏛️ Архитектор (Arch)',
      isolationMode: 'none',
      onSuccess: 'done',
      onFailure: 'clarify',
      requireApproval: false,
      description: 'Декомпозиция задач на подзадачи с dependsOn. Вопросы Славе через Clarify.',
    },
    shturman: {
      label: '🧭 Штурман (Shturman)',
      isolationMode: 'none',
      onSuccess: 'done',
      onFailure: 'clarify',
      requireApproval: false,
      description: 'Главный координатор и чат (Web / Telegram). Планирует или направляет на Arch.',
    },
    reg: {
      label: '📚 Регистратор (Reg)',
      isolationMode: 'notes_vault',
      onSuccess: 'done',
      onFailure: 'failed',
      requireApproval: false,
      description: 'Архивирование уроков в vault, пересборка графа graphify и git push в memvault.',
    },
  },
}

export class DiveTeamDispatcher {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = config
    this.projectRoot = resolve(config.projectRoot || DEFAULT_PROJECT_ROOT)
    this.rolesDir = join(this.projectRoot, 'roles')
    this.vaultDir = join(this.projectRoot, 'vault')
    this.worktreesRoot = join(this.projectRoot, 'worktrees')
    this.maxHeavyWorkers = Number(config.maxHeavyWorkers ?? 3)
    this.maxQaRetries = Number(config.maxQaRetries ?? 2)
    this.maxDailyTokens = Number(config.maxDailyTokens ?? 2_000_000)

    this.workflowRulesPath = join(this.projectRoot, 'workflow-rules.json')
    this.workflowRules = this.loadWorkflowRules()
    if (this.workflowRules?.pipeline?.maxHeavyWorkers && config.maxHeavyWorkers === undefined) {
      this.maxHeavyWorkers = Number(this.workflowRules.pipeline.maxHeavyWorkers)
    }
    if (this.workflowRules?.pipeline?.maxDailyTokens && config.maxDailyTokens === undefined) {
      this.maxDailyTokens = Number(this.workflowRules.pipeline.maxDailyTokens)
    }
    if (this.workflowRules?.pipeline?.maxQaRetries && config.maxQaRetries === undefined) {
      this.maxQaRetries = Number(this.workflowRules.pipeline.maxQaRetries)
    }

    this.roles = loadRoles(this.rolesDir, join(this.vaultDir, 'memory', 'CORE.md'))
    this.ledger = createTaskLedger(join(this.projectRoot, 'ledger.json'))
    this.mergeLock = new MergeLockQueue()
    this.hostLock = new HostExclusiveLock(config.hostLockPath || '/tmp/diveteam-host.lock')

    /** Active sessions launched by the Dispatcher: sessionId -> { taskId, role, worktreePath, repoPath, branchName, baseBranch, startedAt } */
    this.activeRuns = new Map()
    this.backgroundSessions = new Set()
    this.regArchivistRuns = new Map()
    this.telegramShturmanRuns = new Map()
    this.telegramSessionFile = join(this.projectRoot, '.dsh-telegram-session.json')
    this.telegramSessionId = null
    this.telegramSessionTitle = 'Telegram · Штурман (@slava)'
    this.telegramSessionMessageCount = 0
    this.telegramSessionUpdatedAt = null
    this.loadTelegramSessionState()

    this.launchingTaskIds = new Set()
    this.processingQueue = false
    this.queuePaused = false
    this.dispatcherEvents = []
    this.pendingQaVerdicts = new Map()
    this.pendingApprovals = new Map()
    this.queueTimer = null
    this.dailyTokensUsed = 0
    this.dailyKey = new Date().toISOString().slice(0, 10)
    this.circuitBreakerTripped = false

    const isTestRoot = this.projectRoot !== DEFAULT_PROJECT_ROOT && !config.enableTelegram
    this.telegram = new TelegramBridge({
      token: isTestRoot ? (config.telegramToken ?? '') : config.telegramToken,
      chatId: config.telegramChatId || process.env.DIVETEAM_TG_CHAT_ID || process.env.FARVATER_TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '81815557',
      userId: config.telegramUserId || process.env.DIVETEAM_TG_USER_ID || process.env.FARVATER_TG_USER_ID || '81815557',
      logger: ctx.logger || console,
      onCommand: (text, msg) => this.handleTelegramCommand(text, msg),
    })
  }

  loadTelegramSessionState() {
    try {
      if (!existsSync(this.telegramSessionFile)) return
      const data = JSON.parse(readFileSync(this.telegramSessionFile, 'utf8'))
      const sid = typeof data?.sessionId === 'string' ? data.sessionId.trim() : ''
      if (sid) {
        this.telegramSessionId = sid
        this.telegramSessionTitle = (data.title || 'Telegram · Штурман (@slava)').replace(/✈️?\s*/g, '')
        this.telegramSessionMessageCount = Number(data.messageCount || 0)
        this.telegramSessionUpdatedAt = data.updatedAt || null
        this.backgroundSessions.add(sid)
        this.telegramShturmanRuns.set(sid, {
          sessionId: sid,
          title: this.telegramSessionTitle,
          lastAssistantText: '',
        })
      }
    } catch { /* ignore invalid state file */ }
  }

  saveTelegramSessionState() {
    try {
      if (!this.telegramSessionId) return
      writeFileSync(
        this.telegramSessionFile,
        JSON.stringify(
          {
            sessionId: this.telegramSessionId,
            title: this.telegramSessionTitle,
            messageCount: this.telegramSessionMessageCount,
            updatedAt: this.telegramSessionUpdatedAt,
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch { /* best-effort persistence */ }
  }

  getTelegramSessionInfo() {
    return {
      sessionId: this.telegramSessionId || null,
      title: this.telegramSessionTitle,
      messageCount: this.telegramSessionMessageCount,
      updatedAt: this.telegramSessionUpdatedAt || null,
    }
  }

  loadWorkflowRules() {
    let loaded = null
    try {
      if (existsSync(this.workflowRulesPath)) {
        loaded = JSON.parse(readFileSync(this.workflowRulesPath, 'utf8'))
      }
    } catch (err) {
      this.ctx?.logger?.warn?.(`[diveteam-dispatcher] Failed to parse workflow-rules.json: ${err?.message || err}`)
    }

    const merged = {
      pipeline: {
        ...DEFAULT_WORKFLOW_RULES.pipeline,
        ...(loaded?.pipeline || {}),
      },
      roleTransitions: {
        ...DEFAULT_WORKFLOW_RULES.roleTransitions,
        ...(loaded?.roleTransitions || {}),
      },
    }

    if (!existsSync(this.workflowRulesPath)) {
      try {
        writeFileSync(this.workflowRulesPath, JSON.stringify(merged, null, 2), 'utf8')
      } catch { /* best-effort write */ }
    }
    return merged
  }

  saveWorkflowRules(newRules) {
    if (!newRules || typeof newRules !== 'object') {
      throw new Error('Некорректный формат правил воркфлоу')
    }
    const current = this.workflowRules || DEFAULT_WORKFLOW_RULES
    const pipeline = {
      ...current.pipeline,
      ...(newRules.pipeline || {}),
    }
    const roleTransitions = {
      ...current.roleTransitions,
      ...(newRules.roleTransitions || {}),
    }
    this.workflowRules = { pipeline, roleTransitions }

    if (pipeline.maxHeavyWorkers !== undefined) {
      this.maxHeavyWorkers = Math.max(1, Number(pipeline.maxHeavyWorkers) || 3)
    }
    if (pipeline.maxQaRetries !== undefined) {
      this.maxQaRetries = Math.max(1, Number(pipeline.maxQaRetries) || 2)
    }
    if (pipeline.maxDailyTokens !== undefined) {
      this.maxDailyTokens = Math.max(10_000, Number(pipeline.maxDailyTokens) || 2_000_000)
    }

    try {
      writeFileSync(this.workflowRulesPath, JSON.stringify(this.workflowRules, null, 2), 'utf8')
    } catch { /* best-effort write */ }

    this.logDispatcherEvent('workflow', '⚙️ Правила воркфлоу сохранены и применены в Диспетчере')
    return this.workflowRules
  }

  logDispatcherEvent(kind, message, meta = {}) {
    const entry = {
      id: randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      kind: String(kind || 'info'),
      taskId: meta.taskId ? String(meta.taskId) : null,
      role: meta.role ? String(meta.role) : null,
      message: String(message || ''),
    }
    this.dispatcherEvents.push(entry)
    if (this.dispatcherEvents.length > 100) {
      this.dispatcherEvents = this.dispatcherEvents.slice(-100)
    }
    return entry
  }

  start() {
    this.runStartupJanitor()
    this.registerTools()
    this.queueTimer = setInterval(() => { void this.processQueue() }, 3000)
    this.telegram.startPolling()
    void this.processQueue()
  }

  stop() {
    if (this.queueTimer) {
      clearInterval(this.queueTimer)
      this.queueTimer = null
    }
    this.telegram.stopPolling()
  }

  getTask(taskId) {
    return this.ledger.get(taskId)
  }

  updateTask(taskId, patch) {
    return this.ledger.update(taskId, patch)
  }

  runStartupJanitor() {
    mkdirSync(this.worktreesRoot, { recursive: true })
    mkdirSync(join(this.vaultDir, 'tasks', 'done'), { recursive: true })
    mkdirSync(join(this.vaultDir, 'memory', 'lessons'), { recursive: true })
    mkdirSync(join(this.vaultDir, 'memory', 'proposals'), { recursive: true })
    mkdirSync(join(this.vaultDir, 'inbox'), { recursive: true })
    mkdirSync(join(this.vaultDir, 'notes'), { recursive: true })
    this.ensureGithubTokenEnv()
    this.ensureTelegramTokenEnv()
    this.hostLock.isLocked()
    // Return tasks stranded in 'running' (e.g. after a restart) to 'todo'.
    let recoveredCount = 0
    for (const task of this.ledger.list()) {
      if (task.status === 'running' && !this.isTaskCurrentlyRunning(task.id)) {
        this.updateTask(task.id, { status: 'todo', phase: 'ready' })
        recoveredCount += 1
      }
    }
    this.logDispatcherEvent(
      'janitor',
      recoveredCount > 0
        ? `🧹 Startup Janitor: возвращено зависших задач в очередь: ${recoveredCount}`
        : '🧹 Startup Janitor: проверка окружения и блокировок выполнена',
    )
  }

  ensureGithubTokenEnv() {
    try {
      const tokenScript = join(this.projectRoot, 'scripts', 'dsh-github-token')
      if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && existsSync(tokenScript)) {
        const tok = execFileSync(tokenScript, ['print'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
        }).trim()
        if (tok) {
          process.env.GH_TOKEN = tok
          process.env.GITHUB_TOKEN = tok
          process.env.DIVETEAM_GITHUB_TOKEN = tok
          process.env.FARVATER_GITHUB_TOKEN = tok
        }
      }
      const credHelper = join(homedir(), '.local', 'bin', 'dsh-git-credential-helper')
      process.env.GIT_TERMINAL_PROMPT = '0'
      // Git-конфиг держим в единой форме GIT_CONFIG_PARAMETERS: она не попадает под фильтр DSH
      // SENSITIVE_ENV_PATTERN=/KEY|PASSWORD|SECRET|TOKEN/i, который вычищает из дочернего
      // окружения индексированную форму (COUNT + <KEY>_n + VALUE_n), оставляя COUNT без ключей
      // -> git падал с "missing config key", exit 128. Залежи от родителя удаляем.
      const gitConfigKeyPrefix = `GIT_CONFIG_${'KEY'}_`
      const gitConfigCountName = `GIT_CONFIG_${'COUNT'}`
      for (const envName of Object.keys(process.env)) {
        if (envName === gitConfigCountName || envName.startsWith(gitConfigKeyPrefix) || envName.startsWith('GIT_CONFIG_VALUE_')) {
          delete process.env[envName]
        }
      }
      if (existsSync(credHelper)) {
        process.env.GIT_CONFIG_PARAMETERS = `'credential.https://github.com.helper=!${credHelper}' 'url.https://github.com/.insteadOf=git@github.com:' 'url.https://github.com/.insteadOf=ssh://git@github.com/'`
      }
    } catch { /* best-effort token resolution */ }
  }

  ensureTelegramTokenEnv() {
    if (this.config?.telegramToken === '') return
    if (this.projectRoot !== DEFAULT_PROJECT_ROOT && !this.config?.enableTelegram) return
    try {
      let tok = (process.env.DIVETEAM_TG_BOT_TOKEN || process.env.FARVATER_TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim()
      let source = tok
        ? (process.env.DIVETEAM_TG_BOT_TOKEN ? 'env:DIVETEAM_TG_BOT_TOKEN' : (process.env.FARVATER_TG_BOT_TOKEN ? 'env:FARVATER_TG_BOT_TOKEN' : 'env:TELEGRAM_BOT_TOKEN'))
        : 'none'

      if (!tok) {
        for (const ramPath of [
          '/dev/shm/hermes-creds/DIVETEAM_TG_BOT_TOKEN',
          '/dev/shm/hermes-creds/FARVATER_TG_BOT_TOKEN',
          '/dev/shm/hermes-creds/TELEGRAM_BOT_TOKEN',
        ]) {
          if (existsSync(ramPath)) {
            const val = readFileSync(ramPath, 'utf8').trim()
            if (val) {
              tok = val
              source = `tmpfs:${ramPath}`
              break
            }
          }
        }
      }

      if (!tok) {
        const scriptCandidates = [
          join(this.projectRoot, 'scripts', 'dsh-telegram-token'),
          join(homedir(), '.local', 'bin', 'dsh-telegram-token'),
        ]
        for (const candidate of scriptCandidates) {
          if (existsSync(candidate)) {
            try {
              const out = execFileSync(candidate, ['print'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 5000,
              }).trim()
              if (out) {
                tok = out
                source = 'kdewallet:Telegram_bot_tokens/diveteam_shturman_bot'
                break
              }
            } catch { /* try next */ }
          }
        }
      }

      if (!tok) {
        for (const entry of ['diveteam_shturman_bot', 'farvater_shturman_bot']) {
          try {
            const kwOut = execFileSync(
              'kwallet-query',
              ['-f', 'Telegram_bot_tokens', '-r', entry, 'kdewallet'],
              { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
            ).trim()
            if (kwOut && !kwOut.toLowerCase().startsWith('failed')) {
              tok = kwOut
              source = `kdewallet:Telegram_bot_tokens/${entry}`
              break
            }
          } catch { /* ignore */ }
        }
      }

      const allowedId = process.env.DIVETEAM_TG_CHAT_ID || process.env.FARVATER_TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '81815557'
      const allowedUser = process.env.DIVETEAM_TG_USER_ID || process.env.FARVATER_TG_USER_ID || allowedId
      process.env.DIVETEAM_TG_CHAT_ID = allowedId
      process.env.DIVETEAM_TG_USER_ID = allowedUser
      process.env.FARVATER_TG_CHAT_ID = allowedId
      process.env.FARVATER_TG_USER_ID = allowedUser
      process.env.TELEGRAM_CHAT_ID = allowedId

      if (tok) {
        process.env.DIVETEAM_TG_BOT_TOKEN = tok
        process.env.FARVATER_TG_BOT_TOKEN = tok
        process.env.TELEGRAM_BOT_TOKEN = tok
        this.telegram.configure({
          token: tok,
          allowedChatId: allowedId,
          allowedUserId: allowedUser,
          tokenSource: source,
          kwalletEntry: source.startsWith('kdewallet:') ? source : undefined,
        })
      }
    } catch { /* best-effort telegram token resolution */ }
  }

  appendTaskLog(taskId, author, text) {
    this.ledger.addComment(taskId, author, text)
  }

  appendTaskActivity(taskId, item) {
    this.ledger.addActivity(taskId, item)
  }

  isHeavyRole(role) {
    const roleDef = this.roles.get(role)
    if (roleDef && typeof roleDef.heavyWorker === 'boolean') return roleDef.heavyWorker
    return HEAVY_ROLES.has(role)
  }

  getEffectiveIsolationMode(task, role) {
    if (task?.isolationMode) return String(task.isolationMode)
    const roleDef = this.roles.get(role)
    if (roleDef?.isolationMode) return String(roleDef.isolationMode)
    if (role === 'dev' || role === 'qa') return 'git_worktree'
    if (role === 'sre') return 'host_exclusive'
    if (role === 'reg') return 'notes_vault'
    return 'none'
  }

  countActiveHeavyWorkers() {
    let count = 0
    for (const run of this.activeRuns.values()) {
      if (this.isHeavyRole(run.role)) count += 1
    }
    return count
  }

  isTaskCurrentlyRunning(taskId) {
    if (this.launchingTaskIds.has(taskId)) return true
    for (const run of this.activeRuns.values()) {
      if (run.taskId === taskId) return true
    }
    return false
  }

  evaluateTaskReadiness(task) {
    const allTasks = this.ledger.list()
    const rawDeps = Array.isArray(task.dependsOn) ? task.dependsOn : []
    const dependencyStates = rawDeps.map((depId) => {
      const dep = this.ledger.get(depId) || allTasks.find((t) => t.id.startsWith(depId))
      return {
        id: dep?.id || depId,
        title: dep?.title || depId,
        status: dep?.status || 'missing',
        phase: dep?.phase || null,
      }
    })
    const blockedBy = dependencyStates.filter((d) => d.status !== 'done')
    const role = String(task.role || 'dev')
    const phase = String(task.phase || 'ready').toLowerCase()
    const isoMode = this.getEffectiveIsolationMode(task, role)

    if (this.isTaskCurrentlyRunning(task.id)) {
      return {
        canStart: false,
        reasonCode: 'already_running',
        waitingReason: '⚙️ Сессия уже выполняется',
        blockedBy,
        dependencyStates,
      }
    }
    if (phase === 'clarify' || Boolean(task.approvalRequested)) {
      return {
        canStart: false,
        reasonCode: 'clarify',
        waitingReason: '⏸️ Ожидает решения @slava (Clarify)',
        blockedBy,
        dependencyStates,
      }
    }
    if (phase === 'done' || task.status === 'done') {
      return {
        canStart: false,
        reasonCode: 'done',
        waitingReason: '✅ Задача уже выполнена',
        blockedBy,
        dependencyStates,
      }
    }
    if (blockedBy.length > 0) {
      const failedDeps = blockedBy.filter((d) => d.status === 'failed' || d.status === 'missing')
      if (failedDeps.length > 0) {
        const label = failedDeps.map((d) => `${d.title} (#${d.id.slice(0, 8)}: ${d.status})`).join(', ')
        return {
          canStart: false,
          reasonCode: 'dep_failed',
          waitingReason: `⛔ Зависимость в статусе ошибки/не найдена: ${label}`,
          blockedBy,
          dependencyStates,
        }
      }
      const doneCount = dependencyStates.length - blockedBy.length
      const waitingList = blockedBy.map((d) => `${d.title} (#${d.id.slice(0, 8)}: ${d.status})`).join(', ')
      return {
        canStart: false,
        reasonCode: 'waiting_deps',
        waitingReason: `🔗 Ждёт зависимости (${doneCount}/${dependencyStates.length}): ${waitingList}`,
        blockedBy,
        dependencyStates,
      }
    }
    if (this.circuitBreakerTripped) {
      return {
        canStart: false,
        reasonCode: 'circuit_breaker',
        waitingReason: '🚨 Остановлено аварийным Стоп-краном',
        blockedBy,
        dependencyStates,
      }
    }
    if (this.queuePaused) {
      return {
        canStart: false,
        reasonCode: 'queue_paused',
        waitingReason: '⏸️ Очередь поставлена на паузу',
        blockedBy,
        dependencyStates,
      }
    }
    if (this.isHeavyRole(role) && this.countActiveHeavyWorkers() >= this.maxHeavyWorkers) {
      return {
        canStart: false,
        reasonCode: 'heavy_quota_full',
        waitingReason: `⏳ Все тяжёлые слоты заняты (${this.countActiveHeavyWorkers()}/${this.maxHeavyWorkers})`,
        blockedBy,
        dependencyStates,
      }
    }
    if ((role === 'sre' || isoMode === 'host_exclusive') && this.hostLock.isLocked()) {
      const owner = this.hostLock.readOwner()
      if (owner?.taskId !== task.id) {
        return {
          canStart: false,
          reasonCode: 'host_lock_busy',
          waitingReason: `🔒 Ожидает освобождения host.lock (${owner?.taskId?.slice(0, 8) || 'занят'})`,
          blockedBy,
          dependencyStates,
        }
      }
    }
    return {
      canStart: true,
      reasonCode: 'ready',
      waitingReason: '🟢 Готова к запуску',
      blockedBy: [],
      dependencyStates,
    }
  }

  async processQueue() {
    if (this.circuitBreakerTripped || this.queuePaused || this.processingQueue) return
    this.processingQueue = true
    try {
      this.roles = loadRoles(this.rolesDir, join(this.vaultDir, 'memory', 'CORE.md'))
      for (const task of this.ledger.list()) {
        const isUnstartedRunning = task.status === 'running' && task.phase !== 'merge_pending' && !this.isTaskCurrentlyRunning(task.id)
        if (task.status !== 'todo' && !isUnstartedRunning) continue
        const readiness = this.evaluateTaskReadiness(task)
        if (!readiness.canStart) continue
        const role = String(task.role || 'dev')
        const isoMode = this.getEffectiveIsolationMode(task, role)
        if ((role === 'sre' || isoMode === 'host_exclusive') && !this.hostLock.acquire(task.id)) continue

        await this.launchTaskStep(task, role)
      }
    } finally {
      this.processingQueue = false
    }
  }

  async launchTaskStep(task, role) {
    const shortId = task.id.slice(0, 8)
    let cwd = task.repoPath || this.projectRoot
    let worktreePath = task.worktreePath
    let branchName = task.branchName
    let baseBranch = task.baseBranch || 'main'
    let sessionId = null

    this.launchingTaskIds.add(task.id)
    this.roles = loadRoles(this.rolesDir, join(this.vaultDir, 'memory', 'CORE.md'))
    const isoMode = this.getEffectiveIsolationMode(task, role)
    try {
      if (role === 'dev' || role === 'qa' || isoMode === 'git_worktree') {
        const repoPath = task.repoPath || this.projectRoot
        const wt = ensureTaskWorktree(repoPath, task.id, this.worktreesRoot)
        worktreePath = wt.worktreePath
        branchName = wt.branchName
        baseBranch = wt.baseBranch
        cwd = worktreePath
        this.logDispatcherEvent(
          'worktree',
          `🌿 Изолированный worktree готов: ветка ${branchName} (${worktreePath})`,
          { taskId: task.id, role },
        )
      } else if (role === 'reg' || isoMode === 'notes_vault') {
        cwd = this.vaultDir
      }

      const phase = role === 'dev' ? 'dev_running' : role === 'qa' ? 'qa_running' : `${role}_running`
      this.updateTask(task.id, {
        role,
        phase,
        isolationMode: isoMode,
        repoPath: task.repoPath || this.projectRoot,
        ...(worktreePath ? { worktreePath, branchName, baseBranch } : {}),
        attemptCount: Number(task.attemptCount || 0),
        status: 'running',
      })
      this.logDispatcherEvent(
        'launch',
        `🚀 Запущена сессия роли @${role} для задачи «${task.title}» (#${shortId}, изоляция: ${isoMode})`,
        { taskId: task.id, role },
      )

      const created = await this.ctx.sessionController.create({
        cwd,
        agentPreset: this.roles.has(role) ? role : 'standard',
      })
      sessionId = created.sessionId
      await this.ctx.sessionController.rename({
        sessionId,
        title: `[${role.toUpperCase()}] ${task.title} (${shortId})`,
      })

      const roleDef = this.roles.get(role)
      if (roleDef?.defaultProvider && roleDef?.defaultModel) {
        const normalizedModel = String(roleDef.defaultModel).trim().includes(' ')
          ? String(roleDef.defaultModel).trim().toLowerCase().replace(/\s+/g, '-')
          : String(roleDef.defaultModel).trim()
        try {
          await this.ctx.sessionController.selectModel({
            sessionId,
            provider: roleDef.defaultProvider,
            model: normalizedModel,
          })
        } catch { /* fallback to default model if route not active */ }
      }

      this.activeRuns.set(sessionId, {
        taskId: task.id,
        role,
        isolationMode: isoMode,
        worktreePath,
        repoPath: task.repoPath || this.projectRoot,
        branchName,
        baseBranch,
        startedAt: Date.now(),
        lastAssistantText: '',
      })

      const promptText = this.composeStepPrompt(task, role, {
        worktreePath,
        branchName,
        baseBranch,
        qaNotes: task.qaNotes,
        attemptCount: Number(task.attemptCount || 0),
      })

      await this.ctx.sessionController.prompt(
        {
          sessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text: promptText }],
        },
        new AbortController().signal,
      )
    } catch (err) {
      if (sessionId) this.activeRuns.delete(sessionId)
      if (role === 'sre' || isoMode === 'host_exclusive') this.hostLock.release(task.id)
      const msg = err instanceof Error ? err.message : String(err)
      this.appendTaskLog(task.id, 'dispatcher-error', `Ошибка запуска роли ${role}: ${msg}`)
      try {
        this.updateTask(task.id, { status: 'failed' })
      } catch { /* ignore */ }
    } finally {
      this.launchingTaskIds.delete(task.id)
    }
  }

  composeStepPrompt(task, role, ctxInfo) {
    const lines = [
      `# Задача [${task.id}]: ${task.title}`,
      `**Назначенная роль:** \`${role}\``,
      '',
      '## Описание:',
      task.description || '(без дополнительного описания)',
      '',
      '## Инструкция к выполнению:',
      task.prompt || task.description || task.title,
      '',
      '> **Важно (фоновый режим Канбана):** НИКОГДА не вызывай интерактивный инструмент `ask_user_question` (он заблокирует фоновый воркер). Если требуется решение или уточнение от `@slava`, вызови `diveteam_request_approval(taskId, summary)` (или `farvater_request_approval`) и заверши ход.',
    ]
    if (ctxInfo.worktreePath) {
      lines.push(
        '',
        '## Изолированное окружение (Git Worktree):',
        `- Рабочая директория (\`cwd\`): \`${ctxInfo.worktreePath}\``,
        `- Ветка задачи: \`${ctxInfo.branchName}\` (базовая ветка: \`${ctxInfo.baseBranch}\`)`,
      )
    }
    if (role === 'dev' && ctxInfo.qaNotes) {
      lines.push(
        '',
        `## ⚠️ Возврат на доработку (Попытка #${ctxInfo.attemptCount + 1}):`,
        ctxInfo.qaNotes,
      )
    }
    if (role === 'qa' && ctxInfo.worktreePath) {
      const diffInfo = inspectWorktreeChanges(ctxInfo.worktreePath, ctxInfo.baseBranch)
      lines.push(
        '',
        '## Отчёт по изменениям от `dev` для проверки QA:',
        diffInfo.summary,
        '',
        `По итогам проверки ОБЯЗАТЕЛЬНО вызови инструмент \`diveteam_qa_verdict\` с \`taskId: "${task.id}"\` и \`verdict: "pass"\` или \`"fail"\`.`,
      )
    }
    return lines.join('\n')
  }

  onSessionEvent(session, event) {
    this.accountTokensFromEvent(event)
    const sessionId = session?.id
    if (!sessionId) return

    if (this.telegramShturmanRuns.has(sessionId) || sessionId === this.telegramSessionId) {
      let tgRun = this.telegramShturmanRuns.get(sessionId)
      if (!tgRun) {
        tgRun = { sessionId, title: this.telegramSessionTitle, lastAssistantText: '' }
        this.telegramShturmanRuns.set(sessionId, tgRun)
      }
      if (event.type === 'assistant/message') {
        const parts = event.data?.message?.content
        if (Array.isArray(parts)) {
          const text = parts
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n')
            .trim()
          if (text) tgRun.lastAssistantText = text
        }
        return
      }
      if (event.type === 'turn/end') {
        this.telegram.stopTypingLoop()
        const reply = (tgRun.lastAssistantText || '').trim()
        tgRun.lastAssistantText = ''
        this.telegramSessionUpdatedAt = new Date().toISOString()
        this.saveTelegramSessionState()
        if (reply) {
          void this.telegram.sendMessage(reply)
        }
      }
      return
    }

    if (this.regArchivistRuns.has(sessionId)) {
      if (event.type === 'turn/end') {
        const regInfo = this.regArchivistRuns.get(sessionId)
        this.regArchivistRuns.delete(sessionId)
        this.runAutoVaultSyncAfterReg(regInfo)
      }
      return
    }

    if (!this.activeRuns.has(sessionId)) return
    const run = this.activeRuns.get(sessionId)

    if (event.type === 'assistant/message') {
      const parts = event.data?.message?.content
      if (Array.isArray(parts)) {
        const text = parts
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n')
          .trim()
        if (text) {
          run.lastAssistantText = text
          this.appendTaskActivity(run.taskId, {
            role: run.role,
            kind: 'message',
            title: `💬 Сообщение (${run.role})`,
            text,
          })
        }
      }
      return
    }

    if (event.type === 'tool/call') {
      const toolName = String(event.data?.name || 'tool')
      let parsedArgs = {}
      try {
        parsedArgs = typeof event.data?.arguments === 'string'
          ? JSON.parse(event.data.arguments)
          : (event.data?.arguments || {})
      } catch {
        parsedArgs = { raw: String(event.data?.arguments || '') }
      }

      if (toolName === 'write' || toolName === 'create_file') {
        const filePath = parsedArgs.path || parsedArgs.file_path || parsedArgs.target_file || '(файл)'
        const fileContent = String(parsedArgs.content ?? parsedArgs.code_content ?? '')
        this.appendTaskActivity(run.taskId, {
          role: run.role,
          kind: 'file',
          title: `📄 Создан/записан файл: ${filePath}`,
          text: fileContent,
        })
      } else if (toolName === 'edit' || toolName === 'replace_in_file') {
        const filePath = parsedArgs.path || parsedArgs.file_path || '(файл)'
        const newContent = String(parsedArgs.new_string ?? parsedArgs.replacement ?? JSON.stringify(parsedArgs, null, 2))
        this.appendTaskActivity(run.taskId, {
          role: run.role,
          kind: 'file',
          title: `✏️ Правка файла: ${filePath}`,
          text: newContent,
        })
      } else if (toolName === 'bash' || toolName === 'shell') {
        const cmd = String(parsedArgs.command || parsedArgs.cmd || JSON.stringify(parsedArgs))
        this.appendTaskActivity(run.taskId, {
          role: run.role,
          kind: 'tool',
          title: `💻 Команда (${run.role})`,
          text: `$ ${cmd}`,
        })
      } else if (toolName === 'ask_user_question') {
        const qText = JSON.stringify(parsedArgs.questions || parsedArgs, null, 2)
        this.pendingApprovals.set(run.taskId, { summary: `Агент задал вопрос:\n${qText}` })
        this.appendTaskActivity(run.taskId, {
          role: run.role,
          kind: 'tool',
          title: `❓ Вопрос к пользователю (${run.role})`,
          text: qText,
        })
        try {
          this.ctx.sessionController.cancel({ sessionId })
        } catch { /* ignore */ }
      } else {
        this.appendTaskActivity(run.taskId, {
          role: run.role,
          kind: 'tool',
          title: `🔧 Вызов инструмента: ${toolName}`,
          text: JSON.stringify(parsedArgs, null, 2),
        })
      }
      return
    }

    if (event.type === 'tool/result') {
      const parts = event.data?.message?.content
      if (Array.isArray(parts)) {
        const text = parts
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n')
          .trim()
        if (text) {
          const clipped = text.length > 6000 ? `${text.slice(0, 6000)}\n… (обрезано, всего ${text.length} симв.)` : text
          this.appendTaskActivity(run.taskId, {
            role: run.role,
            kind: 'output',
            title: `↳ Вывод инструмента`,
            text: clipped,
          })
        }
      }
      return
    }

    if (event.type !== 'turn/end') return
    this.activeRuns.delete(sessionId)
    const reasonKind = event.data?.reason?.kind || 'unknown'
    void this.settleRoleRun(run, reasonKind)
  }

  accountTokensFromEvent(event) {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.dailyKey) {
      this.dailyKey = today
      this.dailyTokensUsed = 0
    }
    const usage = event?.data?.usage || event?.data?.response?.usage
    if (usage && typeof usage === 'object') {
      const input = Number(usage.inputTokens ?? usage.prompt_tokens ?? 0)
      const output = Number(usage.outputTokens ?? usage.completion_tokens ?? 0)
      if (Number.isFinite(input + output) && input + output > 0) {
        this.dailyTokensUsed += input + output
        if (!this.circuitBreakerTripped && this.dailyTokensUsed >= this.maxDailyTokens) {
          void this.tripCircuitBreaker()
        }
      }
    }
  }

  async tripCircuitBreaker() {
    this.circuitBreakerTripped = true
    this.logDispatcherEvent(
      'circuit_breaker',
      `🚨 Сработал аварийный Стоп-кран (${this.dailyTokensUsed} / ${this.maxDailyTokens} токенов). Все активные сессии остановлены.`,
    )
    try {
      for (const agent of this.ctx.agents.list()) {
        try { agent.interrupt() } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    await this.telegram.sendMessage(
      `🚨 [СТОП-КРАН ФАРВАТЕР] Превышен дневной лимит токенов (${this.dailyTokensUsed} / ${this.maxDailyTokens}). Все активные агенты остановлены, очередь задач на паузе.`
    )
  }

  async settleRoleRun(run, reasonKind) {
    const { taskId, role, isolationMode, worktreePath, repoPath, branchName, baseBranch } = run
    const isHostExcl = role === 'sre' || isolationMode === 'host_exclusive'
    const task = this.getTask(taskId)
    if (!task) {
      if (isHostExcl) this.hostLock.release(taskId)
      return
    }

    if (this.pendingApprovals.has(taskId)) {
      const approval = this.pendingApprovals.get(taskId)
      this.pendingApprovals.delete(taskId)
      if (isHostExcl) this.hostLock.release(taskId)
      this.updateTask(taskId, { phase: 'clarify', status: 'backlog', approvalRequested: approval.summary })
      this.appendTaskLog(taskId, `${role} -> @slava (Clarify)`, approval.summary)
      this.logDispatcherEvent(
        'clarify',
        `⏸️ Задача «${task.title}» (#${taskId.slice(0, 8)}) переведена в Clarify (@slava)`,
        { taskId, role },
      )
      await this.telegram.sendMessage(
        `⏸️ [${role.toUpperCase()}] Задача "${task.title}" (${taskId.slice(0, 8)}) ждёт твоего решения (@slava):\n\n${approval.summary}\n\nОтветь /approve ${taskId.slice(0, 8)} или /reject ${taskId.slice(0, 8)} <комментарий>`
      )
      void this.processQueue()
      return
    }

    if (reasonKind !== 'completed') {
      if (isHostExcl) this.hostLock.release(taskId)
      this.appendTaskLog(taskId, role, `Ход завершился со статусом: ${reasonKind}`)
      this.logDispatcherEvent(
        'error',
        `❌ Сессия роли @${role} для «${task.title}» (#${taskId.slice(0, 8)}) завершилась со статусом ${reasonKind}`,
        { taskId, role },
      )
      try { this.updateTask(taskId, { status: 'failed' }) } catch { /* ignore */ }
      void this.processQueue()
      return
    }

    if (role === 'dev') {
      const autoHandoff = this.workflowRules?.pipeline?.autoHandoffDevToQa ?? true
      if (autoHandoff) {
        const diffInfo = inspectWorktreeChanges(worktreePath, baseBranch)
        this.appendTaskLog(taskId, 'dev', `Завершил разработку в ветке \`${branchName}\`. Передаю в QA.\n${diffInfo.summary}`)
        this.logDispatcherEvent(
          'handover',
          `🧪 Dev завершил работу в ветке ${branchName} → передача задачи «${task.title}» (#${taskId.slice(0, 8)}) в QA`,
          { taskId, role: 'dev' },
        )
        this.updateTask(taskId, { role: 'qa', phase: 'ready', status: 'todo' })
      } else {
        const nextRole = this.workflowRules?.roleTransitions?.dev?.onSuccess || 'done'
        if (nextRole === 'done') {
          this.appendTaskLog(taskId, 'dev', `Завершил разработку в ветке \`${branchName}\`. QA отключён в воркфлоу, задача переходит в Done.`)
          this.updateTask(taskId, { phase: 'done', status: 'done' })
          await this.handleTaskMovedToDone(taskId)
        } else {
          this.updateTask(taskId, { role: nextRole, phase: 'ready', status: 'todo' })
        }
      }
      void this.processQueue()
      return
    }

    if (role === 'qa') {
      const verdictObj = this.pendingQaVerdicts.get(taskId) ?? { verdict: 'pass', notes: 'QA завершил проверку без замечаний.' }
      this.pendingQaVerdicts.delete(taskId)

      if (verdictObj.verdict === 'pass') {
        this.appendTaskLog(taskId, 'qa', `✅ QA PASS: ${verdictObj.notes}`)
        const autoMerge = this.workflowRules?.pipeline?.autoMergeOnQaPass ?? true
        if (autoMerge) {
          this.logDispatcherEvent(
            'qa_pass',
            `✅ QA PASS по задаче «${task.title}» (#${taskId.slice(0, 8)}) → отправка в merge.lock`,
            { taskId, role: 'qa' },
          )
          this.updateTask(taskId, { phase: 'merge_pending', qaVerdict: 'pass', qaNotes: verdictObj.notes })

          const mergeRes = await this.mergeLock.runExclusive(async () =>
            mergeTaskWorktree(repoPath, worktreePath, branchName, baseBranch)
          )

          if (mergeRes.ok) {
            this.appendTaskLog(taskId, 'merge.lock', `Ветка \`${branchName}\` успешно влита в \`${baseBranch}\`, worktree очищен.`)
            this.logDispatcherEvent(
              'merge',
              `🔀 merge.lock: ветка ${branchName} успешно влита в ${baseBranch}, worktree удалён`,
              { taskId, role: 'qa' },
            )
            this.updateTask(taskId, { phase: 'done', status: 'done', worktreePath: null })
            await this.handleTaskMovedToDone(taskId)
          } else {
            const attemptCount = Number(task.attemptCount || 0) + 1
            const conflictNote = `Конфликт при слиянии ветки \`${branchName}\` в \`${baseBranch}\`: ${mergeRes.error}. Выполни \`git rebase ${baseBranch}\` и разреши конфликты.`
            this.appendTaskLog(taskId, 'merge.lock', `⚠️ ${conflictNote}`)
            const fallback = this.workflowRules?.pipeline?.conflictFallback || 'dev'
            this.logDispatcherEvent(
              'merge_conflict',
              `⚠️ merge.lock: конфликт при слиянии ${branchName} в ${baseBranch} (направлен на @${fallback}, попытка #${attemptCount})`,
              { taskId, role: fallback },
            )
            if (fallback === 'arch') {
              this.updateTask(taskId, { role: 'arch', phase: 'clarify', status: 'backlog', attemptCount, qaVerdict: 'fail', qaNotes: conflictNote })
            } else {
              this.updateTask(taskId, { role: 'dev', phase: 'ready', status: 'todo', attemptCount, qaVerdict: 'fail', qaNotes: conflictNote })
            }
          }
        } else {
          this.appendTaskLog(taskId, 'qa', `⏸️ QA PASS: авто-слияние отключено в воркфлоу, требуется одобрение @slava перед merge.lock.`)
          this.updateTask(taskId, {
            phase: 'clarify',
            status: 'backlog',
            qaVerdict: 'pass',
            qaNotes: verdictObj.notes,
            approvalRequested: `QA PASS: подтвердите слияние ветки ${branchName} в ${baseBranch}`,
          })
          await this.telegram.sendMessage(
            `⏸️ [ПОДТВЕРЖДЕНИЕ СЛИЯНИЯ] Задача "${task.title}" (#${taskId.slice(0, 8)}) прошла QA.\nПодтвердите слияние: /approve ${taskId.slice(0, 8)}`
          )
        }
      } else {
        const attemptCount = Number(task.attemptCount || 0) + 1
        const maxRetries = Number(this.workflowRules?.pipeline?.maxQaRetries ?? this.maxQaRetries)
        this.appendTaskLog(taskId, 'qa', `❌ QA FAIL (попытка ${attemptCount}): ${verdictObj.notes}`)
        this.logDispatcherEvent(
          'qa_fail',
          `❌ QA FAIL по задаче «${task.title}» (#${taskId.slice(0, 8)}, попытка ${attemptCount}/${maxRetries})`,
          { taskId, role: 'qa' },
        )

        if (attemptCount >= maxRetries) {
          const escalation = this.workflowRules?.pipeline?.qaEscalationTarget || 'arch'
          if (escalation === 'slava') {
            this.updateTask(taskId, {
              phase: 'clarify',
              status: 'backlog',
              attemptCount,
              qaVerdict: 'fail',
              qaNotes: verdictObj.notes,
              approvalRequested: `Превышен лимит попыток QA (${attemptCount}/${maxRetries}): ${verdictObj.notes}`,
            })
          } else if (escalation === 'failed') {
            this.updateTask(taskId, { status: 'failed', phase: 'failed', attemptCount, qaVerdict: 'fail', qaNotes: verdictObj.notes })
          } else {
            this.updateTask(taskId, { role: 'arch', phase: 'clarify', status: 'backlog', attemptCount, qaVerdict: 'fail', qaNotes: verdictObj.notes })
          }
          if (this.workflowRules?.pipeline?.escalationNotifyTelegram ?? true) {
            await this.telegram.sendMessage(
              `⚠️ [ЭСКАЛАЦИЯ] Задача "${task.title}" (${taskId.slice(0, 8)}) не прошла QA после ${attemptCount} попыток.\nНаправлена на: ${escalation}.\nПричина: ${verdictObj.notes}`
            )
          }
        } else {
          this.updateTask(taskId, { role: 'dev', phase: 'ready', status: 'todo', attemptCount, qaVerdict: 'fail', qaNotes: verdictObj.notes })
        }
      }
      void this.processQueue()
      return
    }

    if (isHostExcl) {
      this.hostLock.release(taskId)
      this.appendTaskLog(taskId, role, run.lastAssistantText || 'Инфраструктурная задача успешно выполнена.')
      this.logDispatcherEvent(
        'host_lock',
        `🔓 Задача @${role} «${task.title}» (#${taskId.slice(0, 8)}) выполнена, host.lock освобождён`,
        { taskId, role },
      )
      this.updateTask(taskId, { phase: 'done', status: 'done' })
      await this.handleTaskMovedToDone(taskId)
      void this.processQueue()
      return
    }

    // Custom role with git_worktree or arch / reg / shturman tasks:
    if (isolationMode === 'git_worktree' && worktreePath && branchName) {
      const mergeRes = await this.mergeLock.runExclusive(async () =>
        mergeTaskWorktree(repoPath, worktreePath, branchName, baseBranch)
      )
      if (mergeRes.ok) {
        this.appendTaskLog(taskId, 'merge.lock', `Ветка \`${branchName}\` роли \`${role}\` успешно влита в \`${baseBranch}\`, worktree очищен.`)
        this.logDispatcherEvent(
          'merge',
          `🔀 merge.lock: ветка ${branchName} роли @${role} успешно влита в ${baseBranch}`,
          { taskId, role },
        )
      }
    }
    this.appendTaskLog(taskId, role, run.lastAssistantText || 'Задача успешно выполнена.')
    this.logDispatcherEvent(
      'done',
      `✅ Задача «${task.title}» (#${taskId.slice(0, 8)}, @${role}) перешла в Done`,
      { taskId, role },
    )
    this.updateTask(taskId, { phase: 'done', status: 'done' })
    await this.handleTaskMovedToDone(taskId)
    void this.processQueue()
  }

  async handleTaskMovedToDone(taskId) {
    const task = this.getTask(taskId)
    if (!task) return

    const exportEnabled = this.workflowRules?.pipeline?.exportReportToVault ?? true
    const regEnabled = this.workflowRules?.pipeline?.autoRunRegArchivist ?? true

    if (exportEnabled && !task.exportedToVault) {
      const shortId = task.id.slice(0, 8)
      const exportPath = join(this.vaultDir, 'tasks', 'done', `TASK-${shortId}.md`)
      const logs = Array.isArray(task.comments) ? task.comments.map((c) => `[${c.at.slice(0, 19).replace('T', ' ')}] **${c.author}**: ${c.text}`).join('\n\n') : ''
      const md = [
        '---',
        `id: ${task.id}`,
        `title: ${JSON.stringify(task.title)}`,
        `role: ${task.role}`,
        `completedAt: ${new Date().toISOString()}`,
        '---',
        `# ${task.title}`,
        '',
        '## Описание и Промпт',
        task.description || '',
        '',
        task.prompt || '',
        '',
        '## Журнал выполнения',
        logs || '(без записей)',
        '',
      ].join('\n')

      writeFileSync(exportPath, md, 'utf8')
      this.updateTask(taskId, { exportedToVault: true, vaultPath: exportPath })
      this.logDispatcherEvent(
        'vault',
        `📚 Отчёт по задаче «${task.title}» сохранён в Vault: tasks/done/TASK-${shortId}.md`,
        { taskId: task.id, role: task.role },
      )

      if (regEnabled && task.role !== 'reg') {
        await this.spawnBackgroundArchivist(task, exportPath)
      }
    }

    // Check if this task is a subtask of a parent task (`parentId`)
    const rollupEnabled = this.workflowRules?.pipeline?.parentAutoRollup ?? true
    if (rollupEnabled && task.parentId) {
      const allTasks = this.ledger.list()
      const parent = this.ledger.get(task.parentId) || allTasks.find((t) => t.id.startsWith(task.parentId))
      if (parent && parent.id !== task.id) {
        const parentShort = parent.id.slice(0, 8)
        const subtasks = allTasks.filter(
          (t) => t.id !== parent.id && (t.parentId === parent.id || t.parentId === parentShort)
        )
        if (subtasks.length > 0 && subtasks.every((st) => st.status === 'done')) {
          const summaryMsg = `✅ Все подзадачи (${subtasks.length}/${subtasks.length}) успешно выполнены.`
          const freshParent = this.getTask(parent.id)
          const alreadyLogged = freshParent?.comments?.some((c) => c.text === summaryMsg)
          if (!alreadyLogged) {
            this.appendTaskLog(parent.id, 'dispatcher', summaryMsg)
            this.logDispatcherEvent(
              'parent_done',
              `🎯 Все подзадачи (${subtasks.length}/${subtasks.length}) родительской задачи «${parent.title}» (#${parentShort}) выполнены`,
              { taskId: parent.id, role: parent.role },
            )
          }
          if (freshParent && (freshParent.status === 'backlog' || freshParent.status === 'todo')) {
            this.updateTask(parent.id, { status: 'done', phase: 'done' })
            await this.handleTaskMovedToDone(parent.id)
          }
        }
      }
    }
  }

  async spawnBackgroundArchivist(completedTask, exportPath) {
    try {
      const shortId = completedTask.id.slice(0, 8)
      const created = await this.ctx.sessionController.create({
        cwd: this.vaultDir,
        agentPreset: this.roles.has('reg') ? 'reg' : 'standard',
      })
      const sessionId = created.sessionId
      this.backgroundSessions.add(sessionId)
      this.regArchivistRuns.set(sessionId, {
        taskId: completedTask.id,
        shortId,
        title: completedTask.title,
      })
      await this.ctx.sessionController.rename({
        sessionId,
        title: `[REG] Выжимка по TASK-${shortId}: ${completedTask.title}`,
      })
      await this.ctx.sessionController.prompt(
        {
          sessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{
            type: 'text',
            text: [
              `Задача **${completedTask.title}** (\`${completedTask.id}\`) перешла в статус \`Done\`.`,
              `Отчёт сохранён в файл: \`${exportPath}\`.`,
              '',
              '1. Прочитай этот отчёт.',
              '2. Если в задаче есть полезный технический урок или решение проблемы — создай краткую заметку в `memory/lessons/YYYY-MM-DD-<тема>.md`.',
              '3. Если считаешь нужным предложить правило в `memory/CORE.md` — НЕ редактируй `CORE.md` напрямую, а вызови инструмент `diveteam_propose_core_diff` (или `farvater_propose_core_diff`).',
              `4. В конце обязательно выполни синхронизацию графа и Git-репозитория: \`/home/slava/.local/bin/vault-sync -m "vault(reg): update after TASK-${shortId}"\`.`,
            ].join('\n'),
          }],
        },
        new AbortController().signal,
      )
    } catch { /* best-effort background archivist */ }
  }

  runAutoVaultSyncAfterReg(regInfo) {
    const shortId = regInfo?.shortId || 'task'
    this.logDispatcherEvent(
      'vault_sync',
      `🔄 reg завершил дистилляцию TASK-${shortId} → выполнена авто-синхронизация vault-sync`,
      { taskId: regInfo?.taskId || null, role: 'reg' },
    )
    if (this.projectRoot !== DEFAULT_PROJECT_ROOT && !this.config?.enableVaultSync) return
    try {
      const syncBins = [
        join(homedir(), '.local', 'bin', 'vault-sync'),
        join(this.projectRoot, 'scripts', 'vault-sync'),
      ]
      for (const bin of syncBins) {
        if (existsSync(bin)) {
          execFileSync(bin, ['-m', `reg: auto-distill TASK-${shortId}`], {
            cwd: this.vaultDir,
            stdio: 'ignore',
            timeout: 60_000,
          })
          break
        }
      }
    } catch { /* best-effort vault-sync */ }
  }

  findTaskByPrefix(prefix) {
    const clean = String(prefix || '').trim().replace(/^#/, '')
    if (!clean) return undefined
    const all = this.ledger.list()
    return (
      all.find((t) => t.id === clean)
      || all.find((t) => t.id.startsWith(clean))
      || all.find((t) => t.id.replace(/^t-/, '').startsWith(clean.replace(/^t-/, '')))
    )
  }

  async handleTelegramCommand(text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return
    const firstWord = trimmed.split(/\s+/)[0].replace(/@[A-Za-z0-9_]+$/, '').toLowerCase()

    if (firstWord === '/new' || firstWord === '/reset') {
      const sid = await this.ensureTelegramShturmanSession({ forceNew: true })
      const shortSid = sid ? sid.slice(0, 12) : 'new'
      await this.telegram.sendMessage(
        `🔄 Создана новая сессия диалога со Штурманом: «${this.telegramSessionTitle}» (\`${shortSid}\`). Контекст очищен — пиши вопрос или задачу!`
      )
      return
    }

    if (firstWord === '/status' || firstWord === '/help') {
      const allTasks = this.ledger.list()
      const counts = {
        backlog: allTasks.filter((t) => t.status === 'backlog').length,
        todo: allTasks.filter((t) => t.status === 'todo').length,
        running: allTasks.filter((t) => t.status === 'running').length,
        done: allTasks.filter((t) => t.status === 'done').length,
        failed: allTasks.filter((t) => t.status === 'failed').length,
        clarify: allTasks.filter((t) => t.phase === 'clarify' || Boolean(t.approvalRequested)).length,
      }
      const stateLabel = this.circuitBreakerTripped
        ? '🚨 СТОП-КРАН СРАБОТАЛ (Пауза)'
        : this.queuePaused
          ? '⏸️ Очередь на паузе'
          : '🟢 Активен'
      const hostStatus = this.hostLock.isLocked()
        ? `🔒 Занят (${this.hostLock.readOwner()?.taskId?.slice(0, 8) || 'PID'})`
        : '🔓 Свободен'
      const mergeStatus = this.mergeLock.busy
        ? `🔒 Идёт слияние (в очереди: ${this.mergeLock.pendingCount})`
        : '🟢 Свободен'
      const botTag = this.telegram.botProfile?.username
        ? `@${this.telegram.botProfile.username}`
        : '@diveteam_shturman_bot'
      const sessionLabel = this.telegramSessionId
        ? `${this.telegramSessionTitle} (${this.telegramSessionId.slice(0, 12)}, сообщ.: ${this.telegramSessionMessageCount})`
        : 'будет создана при первом сообщении'

      const lines = [
        `🧭 Сводка системы «Фарватер» / «DiveTeam» (${botTag})`,
        `• Сессия Штурмана: ${sessionLabel}`,
        `• Планировщик: ${stateLabel}`,
        `• Тяжёлые воркеры (dev/qa/sre): ${this.countActiveHeavyWorkers()} / ${this.maxHeavyWorkers}`,
        `• Очередь: К выполнению: ${counts.todo} | В работе: ${counts.running} | ⏸️ Уточнение (@slava): ${counts.clarify} | Бэклог: ${counts.backlog} | Готово: ${counts.done} | Ошибка: ${counts.failed}`,
        `• Изоляция: host.lock: ${hostStatus} | merge.lock: ${mergeStatus}`,
        `• Токены (${this.dailyKey}): ${this.dailyTokensUsed.toLocaleString()} / ${this.maxDailyTokens.toLocaleString()}`,
        '',
        'Команды: /new (сброс сессии), /status, /tasks, /approve <id> [комментарий], /reject <id> [причина], /note <текст> или просто пиши Штурману в свободной форме.',
      ]
      await this.telegram.sendMessage(lines.join('\n'))
      return
    }

    if (firstWord === '/tasks') {
      const allTasks = this.ledger.list()
      const activeOrPending = allTasks.filter((t) => t.status !== 'done').slice(-15)
      if (activeOrPending.length === 0) {
        await this.telegram.sendMessage('📋 На доске сейчас нет незавершённых задач (все в статусе Готово).')
        return
      }
      const lines = ['📋 Активные и ожидающие задачи на доске DiveTeam / Фарватер:']
      for (const t of activeOrPending) {
        const clarifyMark = t.phase === 'clarify' || t.approvalRequested ? ' ⏸️ [Ждёт @slava]' : ''
        lines.push(`• #${t.id.slice(0, 8)} [${t.status.toUpperCase()} · @${t.role}] ${t.title}${clarifyMark}`)
      }
      await this.telegram.sendMessage(lines.join('\n'))
      return
    }

    if (firstWord === '/approve') {
      const rest = trimmed.replace(/^\/approve(?:@[A-Za-z0-9_]+)?\s*/i, '').trim()
      const spaceIdx = rest.indexOf(' ')
      const prefix = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx).trim()
      const commentText = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim()
      const task = this.findTaskByPrefix(prefix)
      if (!task) {
        await this.telegram.sendMessage(`❌ Задача с префиксом "${prefix}" не найдена.`)
        return
      }
      this.appendTaskLog(
        task.id,
        '@slava (Telegram)',
        commentText ? `✅ Одобрено через Telegram (/approve): ${commentText}` : '✅ Одобрено через Telegram (/approve).',
      )
      this.updateTask(task.id, { phase: 'ready', status: 'todo', approvalRequested: null })
      this.logDispatcherEvent(
        'telegram_approve',
        `✅ @slava одобрил задачу «${task.title}» (#${task.id.slice(0, 8)}) через Telegram`,
        { taskId: task.id, role: task.role },
      )
      await this.telegram.sendMessage(`▶️ Задача "${task.title}" (${task.id.slice(0, 8)}) одобрена и возвращена в очередь выполнения!`)
      void this.processQueue()
      return
    }

    if (firstWord === '/reject') {
      const rest = trimmed.replace(/^\/reject(?:@[A-Za-z0-9_]+)?\s*/i, '').trim()
      const spaceIdx = rest.indexOf(' ')
      const prefix = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx).trim()
      const reason = spaceIdx === -1 ? 'Отклонено пользователем' : rest.slice(spaceIdx + 1).trim()
      const task = this.findTaskByPrefix(prefix)
      if (!task) {
        await this.telegram.sendMessage(`❌ Задача с префиксом "${prefix}" не найдена.`)
        return
      }
      this.appendTaskLog(task.id, '@slava (Telegram)', `❌ Отклонено: ${reason}`)
      this.updateTask(task.id, { status: 'failed', phase: 'failed', approvalRequested: null })
      this.logDispatcherEvent(
        'telegram_reject',
        `🛑 @slava отклонил задачу «${task.title}» (#${task.id.slice(0, 8)}) через Telegram: ${reason}`,
        { taskId: task.id, role: task.role },
      )
      await this.telegram.sendMessage(`🛑 Задача "${task.title}" (${task.id.slice(0, 8)}) остановлена.`)
      return
    }

    if (firstWord === '/note') {
      const noteText = trimmed.replace(/^\/note(?:@[A-Za-z0-9_]+)?\s*/i, '').trim()
      if (!noteText) {
        await this.telegram.sendMessage('📝 Укажи текст заметки: `/note <текст>`')
        return
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const inboxFile = join(this.vaultDir, 'inbox', `tg-${stamp}.md`)
      writeFileSync(inboxFile, `# Заметка из Telegram (${new Date().toISOString()})\n\n${noteText}\n`, 'utf8')
      const inboxName = inboxFile.split('/').pop()
      await this.telegram.sendMessage(`📝 Заметка сохранена в \`vault/inbox/${inboxName}\`.`)
      return
    }

    if (firstWord === '/start') {
      await this.forwardTelegramMessageToShturman(
        'Привет! Я открыл чат в Telegram (/start). Подтверди связь коротко в 1-2 предложениях без вызова инструментов.'
      )
      return
    }

    await this.forwardTelegramMessageToShturman(trimmed)
  }

  async ensureTelegramShturmanSession({ forceNew = false } = {}) {
    if (!this.ctx?.sessionController?.create) return null
    if (!forceNew && this.telegramSessionId) {
      this.backgroundSessions.add(this.telegramSessionId)
      if (!this.telegramShturmanRuns.has(this.telegramSessionId)) {
        this.telegramShturmanRuns.set(this.telegramSessionId, {
          sessionId: this.telegramSessionId,
          title: this.telegramSessionTitle,
          lastAssistantText: '',
        })
      }
      return this.telegramSessionId
    }

    if (this.telegramSessionId) {
      this.telegramShturmanRuns.delete(this.telegramSessionId)
    }

    this.roles = loadRoles(this.rolesDir, join(this.vaultDir, 'memory', 'CORE.md'))
    const created = await this.ctx.sessionController.create({
      cwd: this.projectRoot,
      agentPreset: this.roles.has('shturman') ? 'shturman' : 'standard',
    })
    const sessionId = created.sessionId
    this.telegramSessionId = sessionId
    this.telegramSessionTitle = 'Telegram · Штурман (@slava)'
    this.telegramSessionMessageCount = 0
    this.telegramSessionUpdatedAt = new Date().toISOString()

    this.backgroundSessions.add(sessionId)
    this.telegramShturmanRuns.set(sessionId, {
      sessionId,
      title: this.telegramSessionTitle,
      lastAssistantText: '',
    })

    await this.ctx.sessionController.rename({
      sessionId,
      title: this.telegramSessionTitle,
    })

    const roleDef = this.roles.get('shturman')
    if (roleDef?.defaultProvider && roleDef?.defaultModel && this.ctx.sessionController.selectModel) {
      try {
        await this.ctx.sessionController.selectModel({
          sessionId,
          provider: roleDef.defaultProvider,
          model: String(roleDef.defaultModel).trim(),
        })
      } catch { /* fallback */ }
    }

    this.saveTelegramSessionState()
    this.logDispatcherEvent(
      'telegram_session',
      `Подключена постоянная сессия Штурмана для Telegram: «${this.telegramSessionTitle}» (${sessionId.slice(0, 12)})`,
      { role: 'shturman' },
    )
    return sessionId
  }

  async forwardTelegramMessageToShturman(text, options = {}) {
    if (!this.ctx?.sessionController?.create) return
    this.telegram.startTypingLoop()
    try {
      let sessionId = await this.ensureTelegramShturmanSession({ forceNew: Boolean(options.forceNew) })
      if (!sessionId) {
        this.telegram.stopTypingLoop()
        return
      }

      const sendPromptToSession = async (targetSid, isFirstTurn) => {
        const tgRun = this.telegramShturmanRuns.get(targetSid)
        if (tgRun) tgRun.lastAssistantText = ''
        const promptText = isFirstTurn
          ? `[Канал: Telegram (@slava, chat_id: 81815557)]\n${text}`
          : text
        await this.ctx.sessionController.prompt(
          {
            sessionId: targetSid,
            requestId: randomUUID(),
            mode: 'queue',
            content: [{
              type: 'text',
              text: promptText,
            }],
          },
          new AbortController().signal,
        )
      }

      const isFirst = this.telegramSessionMessageCount === 0
      try {
        await sendPromptToSession(sessionId, isFirst)
      } catch {
        // If the persisted session was deleted in Web UI or expired, create a fresh one and retry
        sessionId = await this.ensureTelegramShturmanSession({ forceNew: true })
        if (!sessionId) {
          this.telegram.stopTypingLoop()
          return
        }
        await sendPromptToSession(sessionId, true)
      }

      this.telegramSessionMessageCount += 1
      this.telegramSessionUpdatedAt = new Date().toISOString()
      this.saveTelegramSessionState()
    } catch {
      this.telegram.stopTypingLoop()
    }
  }

  resolveToolRegistry() {
    try {
      const tools = this.ctx.get('tools')
      return tools && typeof tools.register === 'function' ? tools : undefined
    } catch {
      return undefined
    }
  }

  registerTools() {
    const registry = this.resolveToolRegistry()
    if (!registry) return

    const registerPair = (def, altName) => {
      registry.register(defineTool(def))
      registry.register(defineTool({
        ...def,
        name: altName,
      }))
    }

    registerPair({
      name: 'diveteam_dispatch_task',
      description: 'Создать и поставить в очередь задачу или подзадачу для роли (arch, dev, qa, sre, reg или любой пользовательской роли из roles/*.md) на Канбан-доске DiveTeam.',
      parameters: {
        title: { type: 'string', required: true, description: 'Короткий заголовок задачи' },
        description: { type: 'string', required: true, description: 'Описание контекста и критериев приёмки' },
        prompt: { type: 'string', required: true, description: 'Конкретная инструкция для агента-исполнителя' },
        role: { type: 'string', required: true, description: 'Роль исполнителя: arch | dev | qa | sre | reg | <custom_role_id>' },
        isolationMode: { type: 'string', description: 'Режим изоляции: git_worktree | host_exclusive | notes_vault | none' },
        repoPath: { type: 'string', description: 'Абсолютный путь к Git-репозиторию (для dev/qa и git_worktree)' },
        parentId: { type: 'string', description: 'ID родительской задачи (если это подзадача)' },
        dependsOn: { type: 'string', description: 'ID задач-зависимостей через запятую (задача стартует только после их перехода в Done)' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args) => {
        const role = String(args.role || 'dev').trim()
        this.roles = loadRoles(this.rolesDir, join(this.vaultDir, 'memory', 'CORE.md'))
        const roleDef = this.roles.get(role)
        const defaultIso = roleDef?.isolationMode
          || (role === 'dev' || role === 'qa'
            ? 'git_worktree'
            : role === 'sre'
              ? 'host_exclusive'
              : role === 'reg'
                ? 'notes_vault'
                : 'none')
        const isolationMode = args.isolationMode ? String(args.isolationMode).trim() : defaultIso
        const repoPath = args.repoPath ? resolve(String(args.repoPath)) : this.projectRoot
        const task = this.ledger.create({
          title: args.title,
          description: args.description,
          prompt: args.prompt,
          role,
          isolationMode,
          parentId: args.parentId || null,
          dependsOn: args.dependsOn || [],
          status: 'todo',
          phase: 'ready',
          repoPath,
          attemptCount: 0,
        })
        void this.processQueue()
        return { ok: true, taskId: task.id, role, isolationMode, status: task.status, repoPath, dependsOn: task.dependsOn }
      },
    }, 'farvater_dispatch_task')

    registerPair({
      name: 'diveteam_create_role',
      description: 'Создать новую или обновить существующую роль агента в системе DiveTeam (сохраняет roles/<id>.md и синхронизирует пресеты DSH).',
      parameters: {
        id: { type: 'string', required: true, description: 'Уникальный ID роли латиницей (например: analyst, designer, secops)' },
        name: { type: 'string', required: true, description: 'Название роли с эмодзи (например: 📊 7. Analyst (Аналитик))' },
        description: { type: 'string', required: true, description: 'Краткое описание назначения роли' },
        prompt: { type: 'string', required: true, description: 'Системный промпт роли в формате Markdown (без CORE.md — он подключается автоматически)' },
        order: { type: 'number', description: 'Порядок сортировки в списке (по умолчанию 70)' },
        defaultProvider: { type: 'string', description: 'Провайдер модели по умолчанию (opencode-go | google)' },
        defaultModel: { type: 'string', description: 'Модель по умолчанию (например: deepseek-v4.1-flash)' },
        isolationMode: { type: 'string', description: 'Режим изоляции: none | git_worktree | host_exclusive | notes_vault' },
        heavyWorker: { type: 'boolean', description: 'Считать ли роль тяжёлым воркером в квоте maxHeavyWorkers=3' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args) => {
        const id = String(args.id || '').trim().toLowerCase()
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
          return { ok: false, error: 'Некорректный ID роли (допустимы латинские буквы, цифры, дефис и подчёркивание).' }
        }
        mkdirSync(this.rolesDir, { recursive: true })
        const roleObj = {
          id,
          name: String(args.name || id),
          description: String(args.description || ''),
          order: Number.isFinite(Number(args.order)) ? Number(args.order) : 70,
          defaultProvider: String(args.defaultProvider || 'opencode-go'),
          defaultModel: String(args.defaultModel || 'deepseek-v4.1-flash'),
          isolationMode: String(args.isolationMode || 'none'),
          heavyWorker: Boolean(args.heavyWorker),
          body: String(args.prompt || ''),
        }
        const filePath = join(this.rolesDir, `${id}.md`)
        writeFileSync(filePath, serializeRoleMarkdown(roleObj), 'utf8')
        this.roles = loadRoles(this.rolesDir, join(this.vaultDir, 'memory', 'CORE.md'))
        const syncScript = join(this.projectRoot, 'scripts', 'sync-roles.mjs')
        if (existsSync(syncScript)) {
          try {
            execFileSync(process.execPath, [syncScript], { cwd: this.projectRoot, stdio: 'pipe' })
          } catch { /* best-effort sync in test/custom root */ }
        }
        return { ok: true, id, filePath, role: roleObj }
      },
    }, 'farvater_create_role')

    registerPair({
      name: 'diveteam_qa_verdict',
      description: 'Вынести вердикт проверки QA по задаче: "pass" (отправить в merge.lock и Done) или "fail" (вернуть на dev или эскалировать на arch).',
      parameters: {
        taskId: { type: 'string', required: true, description: 'ID проверяемой задачи' },
        verdict: { type: 'string', required: true, description: '"pass" или "fail"' },
        notes: { type: 'string', required: true, description: 'Отчёт о проверке или подробное описание найденного бага' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args) => {
        const verdict = args.verdict === 'pass' ? 'pass' : 'fail'
        this.pendingQaVerdicts.set(args.taskId, { verdict, notes: args.notes })
        return {
          ok: true,
          taskId: args.taskId,
          verdict,
          message: verdict === 'pass'
            ? 'Вердикт PASS записан. По завершении текущего хода Диспетчер выполнит слияние ветки через merge.lock.'
            : 'Вердикт FAIL записан. По завершении текущего хода задача будет возвращена на доработку (или эскалирована на arch).',
        }
      },
    }, 'farvater_qa_verdict')

    registerPair({
      name: 'diveteam_request_approval',
      description: 'Перевести задачу в статус Clarify на @slava и отправить уведомление в Telegram (используется SRE перед боевым деплоем/удалением или Arch для уточняющих вопросов).',
      parameters: {
        taskId: { type: 'string', required: true, description: 'ID задачи' },
        summary: { type: 'string', required: true, description: 'Вопрос пользователю или описание подготовленного деплоя/команд для аппрува' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args) => {
        this.pendingApprovals.set(args.taskId, { summary: args.summary })
        return {
          ok: true,
          taskId: args.taskId,
          status: 'clarify_queued',
          message: 'Запрос аппрува/уточнения записан. Заверши текущий ход — карточка перейдёт на @slava с уведомлением в Telegram.',
        }
      },
    }, 'farvater_request_approval')

    registerPair({
      name: 'diveteam_record_decision',
      description: 'Записать решение пользователя или координатора (@slava) по задаче в статусе Clarify / Approval (approve или reject).',
      parameters: {
        taskId: { type: 'string', required: true, description: 'ID согласуемой задачи (или её короткий префикс)' },
        decision: { type: 'string', required: true, description: '"approve" (одобрить) или "reject" (отклонить)' },
        comment: { type: 'string', description: 'Комментарий к решению (опционально)' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args) => {
        const targetId = String(args.taskId || args.id || '').trim()
        const decision = String(args.decision || '').trim().toLowerCase()
        const note = String(args.comment || args.note || '').trim()
        const task = this.ledger.get(targetId) || this.findTaskByPrefix(targetId)
        if (!task) return { ok: false, error: 'task-not-found' }
        if (decision === 'approve') {
          this.appendTaskLog(task.id, '@slava', note ? `✅ Одобрено: ${note}` : '✅ Одобрено пользователем (@slava).')
          const updated = this.updateTask(task.id, { phase: 'ready', status: 'todo', approvalRequested: null })
          void this.processQueue()
          return { ok: true, taskId: task.id, status: updated?.status || 'todo', decision: 'approve' }
        }
        if (decision === 'reject') {
          this.appendTaskLog(task.id, '@slava', `❌ Отклонено: ${note || 'Отклонено пользователем'}`)
          const updated = this.updateTask(task.id, { status: 'failed', approvalRequested: null })
          return { ok: true, taskId: task.id, status: updated?.status || 'failed', decision: 'reject' }
        }
        return { ok: false, error: 'invalid-decision (expected "approve" or "reject")' }
      },
    }, 'farvater_record_decision')

    registerPair({
      name: 'diveteam_propose_core_diff',
      description: 'Создать дифф-предложение для файла глобальной памяти vault/memory/CORE.md без его прямого редактирования и отправить превью Славе.',
      parameters: {
        taskId: { type: 'string', description: 'ID связанной задачи (опционально)' },
        reason: { type: 'string', required: true, description: 'Почему это правило важно добавить в CORE.md' },
        diffContent: { type: 'string', required: true, description: 'Предлагаемый блок текста или unified diff для CORE.md' },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args) => {
        const proposalId = (args.taskId || randomUUID()).slice(0, 8)
        const filePath = join(this.vaultDir, 'memory', 'proposals', `CORE-diff-${proposalId}.md`)
        const content = [
          `# Предложение правки CORE.md (${proposalId})`,
          `- **Дата:** ${new Date().toISOString()}`,
          `- **Причина:** ${args.reason}`,
          '',
          '## Предлагаемый дифф / дополнение:',
          '```diff',
          args.diffContent.trim(),
          '```',
          '',
        ].join('\n')
        writeFileSync(filePath, content, 'utf8')
        await this.telegram.sendMessage(
          `📚 [REG: Предложение для CORE.md]\nПричина: ${args.reason}\nФайл: ${filePath}\n\n${args.diffContent.trim()}\n\nЧтобы применить, поручи Штурману: "Примени дифф ${proposalId} в CORE.md".`
        )
        return { ok: true, proposalId, filePath }
      },
    }, 'farvater_propose_core_diff')
  }

  taskRoutes() {
    const self = this
    const listCreate = {
      kind: 'exact',
      path: `${API_PREFIX}/tasks`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method === 'GET') return writeJson(res, 200, { ok: true, tasks: self.ledger.list() })
        if (req.method === 'POST') {
          let body
          try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
          const task = self.ledger.create(body)
          void self.processQueue()
          return writeJson(res, 200, { ok: true, task })
        }
        return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      },
    }
    const update = {
      kind: 'exact',
      path: `${API_PREFIX}/tasks/update`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body
        try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
        const targetId = String(body?.id ?? '')
        if (body?.status === 'todo' || body?.status === 'backlog' || body?.status === 'failed') {
          for (const [sid, run] of self.activeRuns.entries()) {
            if (run.taskId === targetId) {
              self.activeRuns.delete(sid)
              try { await self.ctx.sessionController.cancel({ sessionId: sid }) } catch { /* ignore */ }
            }
          }
        }
        if ((body?.status === 'todo' || body?.status === 'running') && !body?.phase) {
          body = { ...body, phase: 'ready' }
        }
        const task = self.ledger.update(targetId, body)
        if (task === undefined) return writeJson(res, 404, { ok: false, error: 'not-found' })
        void self.processQueue()
        return writeJson(res, 200, { ok: true, task })
      },
    }
    const comment = {
      kind: 'exact',
      path: `${API_PREFIX}/tasks/comment`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body
        try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
        const task = self.ledger.addComment(String(body?.id ?? ''), body?.author, body?.text)
        if (task === undefined) return writeJson(res, 404, { ok: false, error: 'not-found' })
        return writeJson(res, 200, { ok: true, task })
      },
    }
    const deleteRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/tasks/delete`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body
        try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
        const targetId = String(body?.id ?? '')
        for (const [sid, run] of self.activeRuns.entries()) {
          if (run.taskId === targetId) {
            self.activeRuns.delete(sid)
            try { await self.ctx.sessionController.cancel({ sessionId: sid }) } catch { /* ignore */ }
          }
        }
        const removed = self.ledger.remove(targetId)
        if (!removed) return writeJson(res, 404, { ok: false, error: 'not-found' })
        return writeJson(res, 200, { ok: true, id: targetId })
      },
    }
    const decisionRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/tasks/decision`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body
        try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
        const targetId = String(body?.id ?? '')
        const decision = String(body?.decision ?? '')
        const note = String(body?.comment ?? '').trim()
        const task = self.ledger.get(targetId)
        if (!task) return writeJson(res, 404, { ok: false, error: 'not-found' })
        if (decision === 'approve') {
          self.appendTaskLog(targetId, '@slava', note ? `✅ Одобрено: ${note}` : '✅ Одобрено пользователем (@slava).')
          const updated = self.updateTask(targetId, { phase: 'ready', status: 'todo', approvalRequested: null })
          void self.processQueue()
          return writeJson(res, 200, { ok: true, task: updated })
        }
        if (decision === 'reject') {
          self.appendTaskLog(targetId, '@slava', `❌ Отклонено: ${note || 'Отклонено пользователем'}`)
          const updated = self.updateTask(targetId, { status: 'failed', approvalRequested: null })
          return writeJson(res, 200, { ok: true, task: updated })
        }
        return writeJson(res, 400, { ok: false, error: 'invalid-decision' })
      },
    }
    const memoryRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/memory`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method === 'GET') {
          const info = inspectVault(self.vaultDir)
          return writeJson(res, 200, { ok: true, ...info })
        }
        if (req.method === 'POST') {
          let body
          try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
          const action = String(body?.action ?? '')
          try {
            if (action === 'read') {
              const file = readVaultFile(self.vaultDir, body?.path)
              return writeJson(res, 200, { ok: true, ...file })
            }
            if (action === 'write') {
              const saved = writeVaultFile(self.vaultDir, body?.path, body?.content, self.projectRoot)
              return writeJson(res, 200, { ok: true, ...saved })
            }
            if (action === 'delete') {
              const deleted = deleteVaultFile(self.vaultDir, body?.path)
              return writeJson(res, 200, { ok: true, ...deleted })
            }
            if (action === 'apply_proposal') {
              const resApply = applyCoreProposal(self.vaultDir, body?.path, self.projectRoot)
              return writeJson(res, 200, { ok: true, ...resApply })
            }
            if (action === 'query_graph') {
              const result = queryVaultGraph(self.vaultDir, body?.query)
              return writeJson(res, 200, { ok: true, ...result })
            }
            return writeJson(res, 400, { ok: false, error: 'unknown-action' })
          } catch (err) {
            return writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      },
    }
    const memoryFileRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/memory/file`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        const urlObj = new URL(req.url || `${API_PREFIX}/memory/file`, 'http://localhost')
        if (req.method === 'GET') {
          const filePath = urlObj.searchParams.get('path')
          if (!filePath) return writeJson(res, 400, { ok: false, error: 'missing-path' })
          try {
            const file = readVaultFile(self.vaultDir, filePath)
            return writeJson(res, 200, { ok: true, ...file })
          } catch (err) {
            return writeJson(res, 404, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'POST') {
          let body
          try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
          try {
            const saved = writeVaultFile(self.vaultDir, body?.path, body?.content, self.projectRoot)
            return writeJson(res, 200, { ok: true, ...saved })
          } catch (err) {
            return writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        if (req.method === 'DELETE') {
          let body = {}
          try { body = await readJson(req) } catch { /* ignore */ }
          const targetPath = body?.path || urlObj.searchParams.get('path')
          if (!targetPath) return writeJson(res, 400, { ok: false, error: 'missing-path' })
          try {
            const deleted = deleteVaultFile(self.vaultDir, targetPath)
            return writeJson(res, 200, { ok: true, ...deleted })
          } catch (err) {
            return writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        }
        return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      },
    }
    const telegramRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/telegram`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        const getClarifyTasks = () =>
          self.ledger.list().filter((t) => t.phase === 'clarify' || Boolean(t.approvalRequested))
        const buildTelegramResponse = (extra = {}) => ({
          ok: true,
          ...self.telegram.status(),
          telegramSession: self.getTelegramSessionInfo(),
          clarifyTasks: getClarifyTasks(),
          ...extra,
        })

        if (!self.telegram.hasToken) {
          self.ensureTelegramTokenEnv()
        }
        if (self.telegram.enabled && !self.telegram.botProfile) {
          await self.telegram.refreshBotProfile()
        }

        if (req.method === 'GET') {
          return writeJson(res, 200, buildTelegramResponse())
        }
        if (req.method === 'POST') {
          let body
          try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
          const action = String(body?.action ?? '')
          if (action === 'send_test') {
            const text = String(body?.text || '🧭 Проверка связи из панели «DiveTeam»')
            const delivered = await self.telegram.sendMessage(text)
            return writeJson(res, 200, buildTelegramResponse({ delivered }))
          }
          if (action === 'reload_kwallet') {
            self.ensureTelegramTokenEnv()
            await self.telegram.refreshBotProfile()
            return writeJson(res, 200, buildTelegramResponse())
          }
          if (action === 'new_session') {
            await self.ensureTelegramShturmanSession({ forceNew: true })
            return writeJson(res, 200, buildTelegramResponse())
          }
          if (action === 'command') {
            const text = String(body?.text ?? '').trim()
            if (!text) return writeJson(res, 400, { ok: false, error: 'empty-command' })
            self.telegram.recordEvent('in', text, { chatId: 'web-ui', delivered: true })
            await self.handleTelegramCommand(text)
            return writeJson(res, 200, buildTelegramResponse())
          }
          if (action === 'configure') {
            self.telegram.configure({
              token: body?.token,
              allowedChatId: body?.allowedChatId,
              allowedUserId: body?.allowedUserId || body?.allowedChatId,
            })
            await self.telegram.refreshBotProfile()
            return writeJson(res, 200, buildTelegramResponse())
          }
          return writeJson(res, 400, { ok: false, error: 'unknown-action' })
        }
        return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      },
    }
    const telegramSendRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/telegram/send`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body
        try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
        const text = String(body?.text ?? '').trim()
        if (!text) return writeJson(res, 400, { ok: false, error: 'empty-text' })
        const delivered = await self.telegram.sendMessage(text)
        return writeJson(res, 200, { ok: true, delivered })
      },
    }
    const handleMonitoringOrDispatcher = async (req, res) => {
      if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
      const buildSnapshot = () => {
        const allTasks = self.ledger.list()
        const queueCounts = {
          backlog: allTasks.filter((t) => t.status === 'backlog').length,
          todo: allTasks.filter((t) => t.status === 'todo').length,
          running: allTasks.filter((t) => t.status === 'running').length,
          done: allTasks.filter((t) => t.status === 'done').length,
          failed: allTasks.filter((t) => t.status === 'failed').length,
          clarify: allTasks.filter((t) => t.phase === 'clarify' || Boolean(t.approvalRequested)).length,
        }
        const activeRuns = []
        for (const [sessionId, run] of self.activeRuns.entries()) {
          const task = self.ledger.get(run.taskId)
          activeRuns.push({
            sessionId,
            taskId: run.taskId,
            taskTitle: task?.title || run.taskId,
            role: run.role,
            isolationMode: run.isolationMode || self.getEffectiveIsolationMode(task, run.role),
            isHeavy: self.isHeavyRole(run.role),
            worktreePath: run.worktreePath || null,
            repoPath: run.repoPath || task?.repoPath || null,
            branchName: run.branchName || null,
            startedAt: new Date(run.startedAt).toISOString(),
            elapsedSec: Math.max(0, Math.round((Date.now() - run.startedAt) / 1000)),
          })
        }

        const todoTasks = allTasks.filter(
          (t) =>
            t.status === 'todo'
            || t.phase === 'clarify'
            || Boolean(t.approvalRequested)
            || (t.status === 'backlog' && Array.isArray(t.dependsOn) && t.dependsOn.length > 0)
        )
        const todoDiagnostics = todoTasks.map((t) => {
          const readiness = self.evaluateTaskReadiness(t)
          const parentTask = t.parentId
            ? self.ledger.get(t.parentId) || allTasks.find((x) => x.id.startsWith(t.parentId))
            : null
          return {
            id: t.id,
            title: t.title,
            role: t.role,
            status: t.status,
            phase: t.phase,
            isolationMode: self.getEffectiveIsolationMode(t, t.role),
            parentId: t.parentId || null,
            parentTitle: parentTask?.title || null,
            dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
            dependencyStates: readiness.dependencyStates,
            canStart: readiness.canStart,
            reasonCode: readiness.reasonCode,
            waitingReason: readiness.waitingReason,
          }
        })

        const dependencyChains = allTasks
          .map((t) => {
            const shortId = t.id.slice(0, 8)
            const subtasks = allTasks.filter(
              (st) => st.id !== t.id && (st.parentId === t.id || st.parentId === shortId)
            )
            const deps = Array.isArray(t.dependsOn) ? t.dependsOn : []
            if (subtasks.length === 0 && deps.length === 0 && !t.parentId) return null
            return {
              id: t.id,
              title: t.title,
              role: t.role,
              status: t.status,
              parentId: t.parentId || null,
              dependsOn: deps,
              subtasksCount: subtasks.length,
              subtasksDone: subtasks.filter((st) => st.status === 'done').length,
            }
          })
          .filter(Boolean)

        const worktrees = listActiveWorktrees(self.worktreesRoot, allTasks)

        return {
          ok: true,
          queuePaused: self.queuePaused,
          circuitBreakerTripped: self.circuitBreakerTripped,
          activeHeavyWorkers: self.countActiveHeavyWorkers(),
          maxHeavyWorkers: self.maxHeavyWorkers,
          activeRuns,
          queueCounts,
          todoDiagnostics,
          dependencyChains,
          worktrees,
          mergeLock: {
            busy: self.mergeLock.busy,
            pendingCount: self.mergeLock.pendingCount,
          },
          hostLock: {
            locked: self.hostLock.isLocked(),
            owner: self.hostLock.readOwner(),
            lockFilePath: self.hostLock.lockFilePath,
          },
          tokens: {
            dailyTokensUsed: self.dailyTokensUsed,
            maxDailyTokens: self.maxDailyTokens,
            dailyKey: self.dailyKey,
          },
          workflowRules: self.workflowRules,
          dispatcherEvents: [...self.dispatcherEvents].reverse(),
        }
      }

      if (req.method === 'GET') {
        return writeJson(res, 200, buildSnapshot())
      }
      if (req.method === 'POST') {
        let body
        try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
        const action = String(body?.action ?? '')
        if (action === 'pause_queue') {
          self.queuePaused = true
          self.logDispatcherEvent('queue', '⏸️ Очередь задач поставлена на паузу из панели Диспетчера')
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'resume_queue') {
          self.queuePaused = false
          self.logDispatcherEvent('queue', '▶️ Очередь задач возобновлена из панели Диспетчера')
          await self.processQueue()
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'process_queue_now') {
          self.logDispatcherEvent('queue', '🔄 Принудительный тик очереди (processQueue)')
          await self.processQueue()
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'run_janitor') {
          self.runStartupJanitor()
          await self.processQueue()
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'force_start_task') {
          const taskId = String(body?.taskId ?? '').trim()
          const task = self.ledger.get(taskId)
          if (!task) return writeJson(res, 404, { ok: false, error: 'task-not-found' })
          if (!self.isTaskCurrentlyRunning(task.id)) {
            const role = String(task.role || 'dev')
            const isoMode = self.getEffectiveIsolationMode(task, role)
            if (role === 'sre' || isoMode === 'host_exclusive') {
              self.hostLock.acquire(task.id)
            }
            const updated = self.updateTask(task.id, { status: 'todo', phase: 'ready', approvalRequested: null }) || task
            self.logDispatcherEvent(
              'force_start',
              `⚡ Принудительный запуск задачи «${updated.title}» (#${updated.id.slice(0, 8)}, @${role}) вне очереди/квот`,
              { taskId: updated.id, role },
            )
            await self.launchTaskStep(updated, role)
          }
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'remove_worktree') {
          const wtPath = String(body?.worktreePath ?? '').trim()
          const repoPath = String(body?.repoPath || self.projectRoot).trim()
          const branchName = body?.branchName ? String(body.branchName).trim() : null
          const taskId = body?.taskId ? String(body.taskId).trim() : null
          if (!wtPath) return writeJson(res, 400, { ok: false, error: 'missing-worktreePath' })
          const rmRes = removeWorktreeByPath(repoPath, wtPath, branchName)
          if (!rmRes.ok) return writeJson(res, 400, { ok: false, error: rmRes.error })
          if (taskId) {
            const t = self.ledger.get(taskId)
            if (t) self.updateTask(t.id, { worktreePath: null })
          }
          self.logDispatcherEvent(
            'worktree',
            `🗑️ Удалён worktree ${wtPath}${branchName ? ` (ветка ${branchName})` : ''}`,
            { taskId },
          )
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'merge_worktree') {
          const taskId = String(body?.taskId ?? '').trim()
          const task = self.ledger.get(taskId)
          const wtPath = String(body?.worktreePath || task?.worktreePath || '').trim()
          const repoPath = String(body?.repoPath || task?.repoPath || self.projectRoot).trim()
          const branchName = String(body?.branchName || task?.branchName || '').trim()
          const baseBranch = String(body?.baseBranch || task?.baseBranch || 'main').trim()
          if (!wtPath || !branchName) {
            return writeJson(res, 400, { ok: false, error: 'missing-worktree-or-branch' })
          }
          const mergeRes = await self.mergeLock.runExclusive(async () =>
            mergeTaskWorktree(repoPath, wtPath, branchName, baseBranch)
          )
          if (!mergeRes.ok) {
            self.logDispatcherEvent(
              'merge_conflict',
              `⚠️ Ошибка ручного слияния ветки ${branchName} в ${baseBranch}: ${mergeRes.error}`,
              { taskId: task?.id || taskId },
            )
            return writeJson(res, 400, { ok: false, error: mergeRes.error })
          }
          self.logDispatcherEvent(
            'merge',
            `🔀 Ручное слияние через merge.lock: ветка ${branchName} влита в ${baseBranch}, worktree очищен`,
            { taskId: task?.id || taskId },
          )
          if (task) {
            self.appendTaskLog(task.id, 'merge.lock (Manual)', `Ветка \`${branchName}\` вручную влита в \`${baseBranch}\`, worktree очищен.`)
            self.updateTask(task.id, { status: 'done', phase: 'done', worktreePath: null })
            await self.handleTaskMovedToDone(task.id)
          }
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'clear_events') {
          self.dispatcherEvents = []
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'trip_breaker') {
          await self.tripCircuitBreaker()
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'reset_breaker') {
          self.circuitBreakerTripped = false
          self.logDispatcherEvent('circuit_breaker', '🟢 Аварийный Стоп-кран сброшен пользователем')
          await self.processQueue()
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'release_host_lock') {
          const owner = self.hostLock.readOwner()
          self.hostLock.release(owner?.taskId)
          self.logDispatcherEvent('host_lock', `🔓 Принудительно снята блокировка host.lock (владелец: ${owner?.taskId || 'нет'})`)
          await self.processQueue()
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'cancel_run') {
          const sid = String(body?.sessionId ?? '')
          const run = self.activeRuns.get(sid)
          if (run) {
            self.activeRuns.delete(sid)
            if (run.role === 'sre' || run.isolationMode === 'host_exclusive') {
              self.hostLock.release(run.taskId)
            }
            try { await self.ctx.sessionController.cancel({ sessionId: sid }) } catch { /* ignore */ }
            self.updateTask(run.taskId, { status: 'backlog', phase: 'draft' })
            self.logDispatcherEvent(
              'cancel',
              `⏹️ Прервана сессия @${run.role} для задачи #${run.taskId.slice(0, 8)}`,
              { taskId: run.taskId, role: run.role },
            )
          }
          return writeJson(res, 200, buildSnapshot())
        }
        if (action === 'update_limits') {
          if (Number.isFinite(Number(body?.maxDailyTokens)) && Number(body.maxDailyTokens) > 0) {
            self.maxDailyTokens = Number(body.maxDailyTokens)
          }
          if (Number.isFinite(Number(body?.maxHeavyWorkers)) && Number(body.maxHeavyWorkers) >= 1) {
            self.maxHeavyWorkers = Number(body.maxHeavyWorkers)
          }
          self.logDispatcherEvent(
            'limits',
            `⚙️ Обновлены лимиты: maxHeavyWorkers=${self.maxHeavyWorkers}, maxDailyTokens=${self.maxDailyTokens.toLocaleString()}`,
          )
          await self.processQueue()
          return writeJson(res, 200, buildSnapshot())
        }
        return writeJson(res, 400, { ok: false, error: 'unknown-action' })
      }
      return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    const monitoringRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/monitoring`,
      handler: handleMonitoringOrDispatcher,
    }
    const dispatcherRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/dispatcher`,
      handler: handleMonitoringOrDispatcher,
    }
    const workflowRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/workflow`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method === 'GET') {
          return writeJson(res, 200, {
            ok: true,
            rules: self.workflowRules,
            defaultRules: DEFAULT_WORKFLOW_RULES,
          })
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          let body
          try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
          try {
            const updated = self.saveWorkflowRules(body?.rules || body)
            void self.processQueue()
            return writeJson(res, 200, { ok: true, rules: updated })
          } catch (err) {
            return writeJson(res, 400, { ok: false, error: err?.message || String(err) })
          }
        }
        return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      },
    }
    const workflowResetRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/workflow/reset`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        self.workflowRules = JSON.parse(JSON.stringify(DEFAULT_WORKFLOW_RULES))
        try {
          writeFileSync(self.workflowRulesPath, JSON.stringify(self.workflowRules, null, 2), 'utf8')
        } catch { /* best-effort write */ }
        self.logDispatcherEvent('workflow', '🔄 Правила воркфлоу сброшены к стандартным')
        void self.processQueue()
        return writeJson(res, 200, { ok: true, rules: self.workflowRules })
      },
    }
    const rolesRoute = {
      kind: 'exact',
      path: `${API_PREFIX}/roles`,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
        self.roles = loadRoles(self.rolesDir, join(self.vaultDir, 'memory', 'CORE.md'))
        const urlObj = new URL(req.url || `${API_PREFIX}/roles`, 'http://localhost')
        if (req.method === 'GET') {
          return writeJson(res, 200, { ok: true, roles: Array.from(self.roles.values()) })
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          let body
          try { body = await readJson(req) } catch { return writeJson(res, 400, { ok: false, error: 'invalid-json' }) }
          const id = String(body?.id ?? '').trim().toLowerCase()
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
            return writeJson(res, 400, { ok: false, error: 'Некорректный ID роли (только латинские буквы, цифры, дефис или подчёркивание)' })
          }
          const roleFile = join(self.rolesDir, `${id}.md`)
          if (req.method === 'POST' && existsSync(roleFile) && body?.overwrite !== true) {
            return writeJson(res, 409, { ok: false, error: `Роль с ID "${id}" уже существует` })
          }
          mkdirSync(self.rolesDir, { recursive: true })
          const role = {
            id,
            name: String(body.name ?? id),
            description: String(body.description ?? ''),
            order: Number.isFinite(Number(body.order)) ? Number(body.order) : 70,
            defaultProvider: String(body.defaultProvider || 'opencode-go'),
            defaultModel: String(body.defaultModel || 'deepseek-v4.1-flash'),
            isolationMode: String(body.isolationMode || 'none'),
            heavyWorker: Boolean(body.heavyWorker),
            body: String(body.prompt || body.body || ''),
          }
          writeFileSync(roleFile, serializeRoleMarkdown(role), 'utf8')
          self.roles = loadRoles(self.rolesDir, join(self.vaultDir, 'memory', 'CORE.md'))
          const syncScript = join(self.projectRoot, 'scripts', 'sync-roles.mjs')
          if (existsSync(syncScript)) {
            try {
              execFileSync(process.execPath, [syncScript], { cwd: self.projectRoot, stdio: 'pipe' })
            } catch { /* best-effort sync */ }
          }
          return writeJson(res, 200, { ok: true, id, role })
        }
        if (req.method === 'DELETE') {
          let body = {}
          try { body = await readJson(req) } catch { /* ignore */ }
          const id = String(body?.id || urlObj.searchParams.get('id') || '').trim().toLowerCase()
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
            return writeJson(res, 400, { ok: false, error: 'invalid-id' })
          }
          const CORE_ROLE_IDS = new Set(['shturman', 'arch', 'dev', 'qa', 'sre', 'reg'])
          if (CORE_ROLE_IDS.has(id)) {
            return writeJson(res, 400, { ok: false, error: `Базовую роль "${id}" нельзя удалить` })
          }
          const roleFile = join(self.rolesDir, `${id}.md`)
          if (!existsSync(roleFile)) {
            return writeJson(res, 404, { ok: false, error: 'not-found' })
          }
          unlinkSync(roleFile)
          self.roles = loadRoles(self.rolesDir, join(self.vaultDir, 'memory', 'CORE.md'))
          const syncScript = join(self.projectRoot, 'scripts', 'sync-roles.mjs')
          if (existsSync(syncScript)) {
            try {
              execFileSync(process.execPath, [syncScript], { cwd: self.projectRoot, stdio: 'pipe' })
            } catch { /* best-effort sync */ }
          }
          return writeJson(res, 200, { ok: true, id })
        }
        return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      },
    }

    const primaryRoutes = [
      listCreate,
      update,
      comment,
      deleteRoute,
      decisionRoute,
      memoryRoute,
      memoryFileRoute,
      telegramRoute,
      telegramSendRoute,
      monitoringRoute,
      dispatcherRoute,
      workflowRoute,
      workflowResetRoute,
      rolesRoute,
    ]
    const allRoutes = []
    for (const route of primaryRoutes) {
      allRoutes.push(route)
      if (route.path.startsWith('/diveteam')) {
        allRoutes.push({
          ...route,
          path: route.path.replace(/^\/diveteam/, '/farvater'),
        })
      }
    }
    return allRoutes
  }
}

export const FarvaterDispatcher = DiveTeamDispatcher

export function apply(ctx, config) {
  const dispatcher = new DiveTeamDispatcher(ctx, config)
  dispatcher.start()
  ctx.on('approval/request', (req, next) => {
    const sid = req?.agent?.session?.id
    if (sid && (dispatcher.activeRuns.has(sid) || dispatcher.backgroundSessions.has(sid))) {
      return Promise.resolve('allowed-once')
    }
    return next()
  }, { prepend: true })
  ctx.on('session/event', (session, event) => {
    dispatcher.onSessionEvent(session, event)
  })
  ctx.effect(() => {
    const disposers = dispatcher.taskRoutes().map((route) => ctx.webServer.register(route))
    return () => {
      dispatcher.stop()
      for (const dispose of disposers) dispose()
    }
  })
}
