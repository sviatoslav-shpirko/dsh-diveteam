import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DiveTeamDispatcher, FarvaterDispatcher } from '@diveteam/dsh-dispatcher'
import { loadRoles } from '../lib/roles.js'
import { formatMarkdownForTelegramHtml } from '../lib/telegram.js'
import { inspectVault, queryVaultGraph } from '../lib/vault.js'

const PROJECT_ROOT = resolve('/home/slava/Projects/DSH')

function initTempGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@farvater.local'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Farvater Test'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# Test Repo\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir })
}

function createMockCtx() {
  const sessions = []
  const interrupted = []
  const registeredTools = new Map()
  return {
    sessions,
    interrupted,
    registeredTools,
    logger: { info() {}, warn() {}, error() {} },
    get(serviceName) {
      if (serviceName === 'tools') {
        return {
          register(toolDef) {
            registeredTools.set(toolDef.name, toolDef)
          },
        }
      }
      return undefined
    },
    getTool(name) {
      return registeredTools.get(name)
    },
    sessionController: {
      async create({ cwd, agentPreset }) {
        const sessionId = `sess-${sessions.length + 1}`
        const rec = { sessionId, cwd, agentPreset, title: '', model: null, prompts: [] }
        sessions.push(rec)
        return { sessionId }
      },
      async rename({ sessionId, title }) {
        const s = sessions.find(x => x.sessionId === sessionId)
        if (s) s.title = title
      },
      async selectModel({ sessionId, provider, model }) {
        const s = sessions.find(x => x.sessionId === sessionId)
        if (s) s.model = `${provider}/${model}`
      },
      async prompt({ sessionId, content }) {
        const s = sessions.find(x => x.sessionId === sessionId)
        if (s) s.prompts.push(content[0]?.text || '')
      },
      async cancel() {},
    },
    agents: {
      list() {
        return [{
          interrupt() {
            interrupted.push(true)
          },
        }]
      },
    },
  }
}

describe('DiveTeam Dispatcher, Vault & Multi-Agent Architecture', () => {
  let tempDir
  let repoDir
  let lockPath

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'farvater-test-'))
    repoDir = join(tempDir, 'repo')
    lockPath = join(tempDir, 'host.lock')
    mkdirSync(repoDir, { recursive: true })
    // Copy roles and vault into tempDir so test doesn't pollute real vault
    mkdirSync(join(tempDir, 'roles'), { recursive: true })
    for (const r of ['shturman', 'arch', 'dev', 'qa', 'sre', 'reg']) {
      const content = readFileSync(join(PROJECT_ROOT, 'roles', `${r}.md`), 'utf8')
      writeFileSync(join(tempDir, 'roles', `${r}.md`), content, 'utf8')
    }
    mkdirSync(join(tempDir, 'vault', 'memory'), { recursive: true })
    writeFileSync(
      join(tempDir, 'vault', 'memory', 'CORE.md'),
      readFileSync(join(PROJECT_ROOT, 'vault', 'memory', 'CORE.md'), 'utf8'),
      'utf8'
    )
    initTempGitRepo(repoDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('loads all 6 roles with models, isolation modes, and CORE.md', () => {
    const roles = loadRoles(
      join(tempDir, 'roles'),
      join(tempDir, 'vault', 'memory', 'CORE.md')
    )
    assert.equal(roles.size, 6)
    assert.equal(roles.get('shturman').defaultModel, 'deepseek-v4.1-flash')
    assert.equal(roles.get('shturman').heavyWorker, false)
    assert.equal(roles.get('dev').defaultModel, 'deepseek-v4.1-flash')
    assert.equal(roles.get('dev').heavyWorker, true)
    assert.equal(roles.get('qa').defaultModel, 'deepseek-v4.1-flash')
    assert.equal(roles.get('qa').heavyWorker, true)
    assert.equal(roles.get('sre').defaultModel, 'deepseek-v4.1-flash')
    assert.equal(roles.get('sre').heavyWorker, true)
    assert.equal(roles.get('reg').defaultProvider, 'opencode-go')
    assert.equal(roles.get('reg').defaultModel, 'deepseek-v4.1-flash')
    assert.ok(roles.get('dev').systemPrompt.includes('CORE MEMORY — Система «DiveTeam»'))
    assert.ok(roles.get('dev').systemPrompt.includes('sviatoslav-shpirko/memvault'))
  })

  it('inspects and queries the real vault and graphify knowledge graph', () => {
    const realVaultDir = join(PROJECT_ROOT, 'vault')
    const info = inspectVault(realVaultDir)
    assert.equal(info.graphSummary.exists, true)
    assert.ok(info.graphSummary.nodesCount > 20)
    assert.ok(info.graphSummary.edgesCount > 20)

    const qRes = queryVaultGraph(realVaultDir, 'CORE')
    assert.ok(qRes.nodes.length > 0)
    assert.ok(qRes.fileMatches.some(f => f.path === 'memory/CORE.md'))
  })

  it('executes full dev -> qa -> merge.lock -> Done -> reg pipeline on isolated git worktree', async () => {
    const ctx = createMockCtx()
    const dispatcher = new DiveTeamDispatcher(ctx, {
      projectRoot: tempDir,
      maxHeavyWorkers: 3,
      maxQaRetries: 2,
      hostLockPath: lockPath,
    })
    dispatcher.start()
    clearInterval(dispatcher.queueTimer)

    // Verify backward compatibility alias exists
    assert.equal(FarvaterDispatcher, DiveTeamDispatcher)
    assert.ok(ctx.getTool('farvater_dispatch_task'))
    assert.ok(ctx.getTool('diveteam_dispatch_task'))

    // 1. Dispatch a dev task via diveteam_dispatch_task tool
    const dispatchTool = ctx.getTool('diveteam_dispatch_task')
    const res = await dispatchTool.execute({
      title: 'Add hello.txt feature',
      description: 'Create hello.txt with greeting',
      prompt: 'Write hello.txt and commit',
      role: 'dev',
      repoPath: repoDir,
    })
    assert.equal(res.ok, true)
    await new Promise(r => setTimeout(r, 30))

    // Verify dev session started in an isolated git worktree
    assert.equal(ctx.sessions.length, 1)
    const devSession = ctx.sessions[0]
    assert.equal(devSession.agentPreset, 'dev')
    assert.ok(devSession.cwd.includes('worktrees/repo/task-'))
    assert.equal(dispatcher.getTask(res.taskId).status, 'running')

    // Simulate dev agent creating a file & committing in the worktree
    writeFileSync(join(devSession.cwd, 'hello.txt'), 'Hello Farvater!\n', 'utf8')
    execFileSync('git', ['add', 'hello.txt'], { cwd: devSession.cwd })
    execFileSync('git', ['commit', '-m', 'feat: add hello.txt'], { cwd: devSession.cwd })

    // Complete dev turn -> should transition to QA in the SAME worktree
    dispatcher.onSessionEvent({ id: devSession.sessionId }, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await new Promise(r => setTimeout(r, 50))

    assert.equal(ctx.sessions.length, 2)
    const qaSession = ctx.sessions[1]
    assert.equal(qaSession.agentPreset, 'qa')
    assert.equal(qaSession.cwd, devSession.cwd)

    // QA calls diveteam_qa_verdict with pass
    assert.ok(ctx.getTool('farvater_qa_verdict'))
    const qaTool = ctx.getTool('diveteam_qa_verdict')
    await qaTool.execute({
      taskId: res.taskId,
      verdict: 'pass',
      notes: 'All tests passed, hello.txt verified.',
    })

    // Complete QA turn -> should merge into main via merge.lock, remove worktree, mark Done, export to vault, and spawn reg
    dispatcher.onSessionEvent({ id: qaSession.sessionId }, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await new Promise(r => setTimeout(r, 80))

    const finalTask = dispatcher.getTask(res.taskId)
    assert.equal(finalTask.status, 'done')

    // Verify hello.txt was merged into main repoDir and worktree was cleaned up
    assert.equal(readFileSync(join(repoDir, 'hello.txt'), 'utf8'), 'Hello Farvater!\n')
    assert.equal(existsSync(devSession.cwd), false)

    // Verify export to vault/tasks/done/TASK-<shortId>.md and background reg session
    const shortId = res.taskId.slice(0, 8)
    const vaultExportPath = join(tempDir, 'vault', 'tasks', 'done', `TASK-${shortId}.md`)
    assert.equal(existsSync(vaultExportPath), true)
    assert.equal(ctx.sessions.length, 3)
    assert.equal(ctx.sessions[2].agentPreset, 'reg')

    dispatcher.stop()
  })

  it('enforces maxHeavyWorkers=3 for dev/qa/sre while keeping arch/shturman unthrottled, and enforces host.lock for sre', async () => {
    const ctx = createMockCtx()
    const dispatcher = new DiveTeamDispatcher(ctx, {
      projectRoot: tempDir,
      maxHeavyWorkers: 3,
      hostLockPath: lockPath,
    })
    dispatcher.start()
    clearInterval(dispatcher.queueTimer)

    for (let i = 1; i <= 2; i++) {
      dispatcher.ledger.create({
        title: `SRE Task ${i}`,
        description: '',
        prompt: 'Check host',
        status: 'todo',
        role: 'sre',
        phase: 'ready',
        repoPath: repoDir,
      })
    }
    for (let i = 1; i <= 3; i++) {
      dispatcher.ledger.create({
        title: `DEV Task ${i}`,
        description: '',
        prompt: 'Code feature',
        status: 'todo',
        role: 'dev',
        phase: 'ready',
        repoPath: repoDir,
      })
    }
    dispatcher.ledger.create({
      title: 'ARCH Task',
      description: '',
      prompt: 'Decompose plan',
      status: 'todo',
      role: 'arch',
      phase: 'ready',
      repoPath: repoDir,
    })

    await dispatcher.processQueue()

    assert.equal(dispatcher.countActiveHeavyWorkers(), 3)
    assert.equal(ctx.sessions.length, 4)
    const activeRoles = ctx.sessions.map(s => s.agentPreset)
    assert.deepEqual(activeRoles, ['sre', 'dev', 'dev', 'arch'])

    dispatcher.stop()
  })

  it('supports SRE approval gate (Clarify), CORE.md diff proposals, and Global Token Circuit Breaker', async () => {
    const ctx = createMockCtx()
    const dispatcher = new DiveTeamDispatcher(ctx, {
      projectRoot: tempDir,
      maxHeavyWorkers: 3,
      maxDailyTokens: 1000,
      hostLockPath: lockPath,
    })
    dispatcher.start()
    clearInterval(dispatcher.queueTimer)

    // 1. Test SRE approval gate
    const sreTask = dispatcher.ledger.create({
      title: 'Deploy n8n container',
      description: '',
      prompt: 'Deploy to prod',
      status: 'todo',
      role: 'sre',
      phase: 'ready',
      repoPath: repoDir,
    })
    await dispatcher.processQueue()
    assert.equal(dispatcher.hostLock.isLocked(), true)

    assert.ok(ctx.getTool('farvater_request_approval'))
    const approvalTool = ctx.getTool('diveteam_request_approval')
    await approvalTool.execute({
      taskId: sreTask.id,
      summary: 'Ready to run docker compose up -d on diveteam. Approve?',
    })
    dispatcher.onSessionEvent({ id: ctx.sessions[0].sessionId }, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await new Promise(r => setTimeout(r, 30))

    assert.equal(dispatcher.getTask(sreTask.id).status, 'backlog')
    assert.equal(dispatcher.getTask(sreTask.id).phase, 'clarify')
    assert.equal(dispatcher.hostLock.isLocked(), false)

    // 2. Test CORE.md diff proposal without modifying CORE.md
    const coreBefore = readFileSync(join(tempDir, 'vault', 'memory', 'CORE.md'), 'utf8')
    assert.ok(ctx.getTool('farvater_propose_core_diff'))
    const diffTool = ctx.getTool('diveteam_propose_core_diff')
    const diffRes = await diffTool.execute({
      taskId: sreTask.id,
      reason: 'Document n8n webhook timeout rule',
      diffContent: '+ - Always set N8N_WEBHOOK_TIMEOUT=120s',
    })
    assert.equal(diffRes.ok, true)
    assert.equal(existsSync(diffRes.filePath), true)
    const coreAfter = readFileSync(join(tempDir, 'vault', 'memory', 'CORE.md'), 'utf8')
    assert.equal(coreAfter, coreBefore)

    // 3. Test Global Token Circuit Breaker
    dispatcher.onSessionEvent({ id: 'any' }, {
      type: 'llm/usage',
      data: { usage: { inputTokens: 600, outputTokens: 500 } },
    })
    assert.equal(dispatcher.circuitBreakerTripped, true)
    assert.equal(ctx.interrupted.length, 1)

    dispatcher.stop()
  })

  it('dynamically creates a new custom role via diveteam_create_role and executes a Kanban task on it', async () => {
    const ctx = createMockCtx()
    const dispatcher = new DiveTeamDispatcher(ctx, {
      projectRoot: tempDir,
      maxHeavyWorkers: 3,
      hostLockPath: lockPath,
    })
    dispatcher.start()
    clearInterval(dispatcher.queueTimer)

    // 1. Create a new custom role 'analyst'
    assert.ok(ctx.getTool('farvater_create_role'))
    const createRoleTool = ctx.getTool('diveteam_create_role')
    assert.ok(createRoleTool)
    const createRes = await createRoleTool.execute({
      id: 'analyst',
      name: '📊 7. Analyst (Аналитик)',
      description: 'Анализ метрик и подготовка отчётов',
      order: 70,
      defaultProvider: 'opencode-go',
      defaultModel: 'deepseek-v4.1-flash',
      isolationMode: 'none',
      heavyWorker: false,
      prompt: 'Ты — Аналитик системы DiveTeam.',
    })
    assert.equal(createRes.ok, true)
    assert.equal(existsSync(join(tempDir, 'roles', 'analyst.md')), true)
    assert.equal(dispatcher.roles.has('analyst'), true)

    // 2. Dispatch a task assigned to the custom role 'analyst'
    assert.ok(ctx.getTool('farvater_dispatch_task'))
    const dispatchTool = ctx.getTool('diveteam_dispatch_task')
    const taskRes = await dispatchTool.execute({
      title: 'Подготовить недельный отчёт по токенам',
      description: 'Собрать сводку по расходу токенов',
      prompt: 'Проанализируй статистику и сформируй отчёт',
      role: 'analyst',
      repoPath: repoDir,
    })
    assert.equal(taskRes.ok, true)
    assert.equal(taskRes.role, 'analyst')
    await new Promise(r => setTimeout(r, 30))

    assert.equal(ctx.sessions.length, 1)
    const analystSession = ctx.sessions[0]
    assert.equal(analystSession.agentPreset, 'analyst')
    assert.ok(analystSession.title.includes('[ANALYST]'))

    // 3. Complete custom role turn -> should transition to 'done'
    dispatcher.onSessionEvent({ id: analystSession.sessionId }, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await new Promise(r => setTimeout(r, 50))

    assert.equal(dispatcher.getTask(taskRes.taskId).status, 'done')
    assert.equal(dispatcher.getTask(taskRes.taskId).role, 'analyst')

    dispatcher.stop()
  })

  it('enforces dependsOn execution order, prevents dependency cycles, and auto-completes parentId when all subtasks finish', async () => {
    const ctx = createMockCtx()
    const dispatcher = new DiveTeamDispatcher(ctx, {
      projectRoot: tempDir,
      maxHeavyWorkers: 3,
      hostLockPath: lockPath,
    })
    dispatcher.start()
    clearInterval(dispatcher.queueTimer)

    // 1. Create parent container task in backlog
    const parentTask = dispatcher.ledger.create({
      title: 'Epic: Release Auth v2',
      description: 'Parent plan container',
      prompt: 'Coordinate subtasks',
      role: 'arch',
      status: 'backlog',
      phase: 'draft',
      repoPath: repoDir,
    })

    // 2. Create Subtask 1 (arch role for single-turn completion)
    const sub1 = dispatcher.ledger.create({
      title: 'Subtask 1: Prepare schema',
      description: '',
      prompt: 'Prepare schema',
      role: 'arch',
      parentId: parentTask.id,
      status: 'todo',
      phase: 'ready',
      repoPath: repoDir,
    })

    // 3. Create Subtask 2 depending on Subtask 1
    const sub2 = dispatcher.ledger.create({
      title: 'Subtask 2: Verify migration',
      description: '',
      prompt: 'Verify migration after Subtask 1',
      role: 'arch',
      parentId: parentTask.id,
      dependsOn: [sub1.id],
      status: 'todo',
      phase: 'ready',
      repoPath: repoDir,
    })

    // 4. Verify cycle prevention: trying to make sub1 depend on sub2 or itself is filtered out
    const patchedSub1 = dispatcher.ledger.update(sub1.id, {
      dependsOn: [sub1.id, sub2.id],
    })
    assert.deepEqual(patchedSub1.dependsOn, [])

    // 5. Evaluate readiness before running queue: sub1 is ready, sub2 is blocked by sub1
    assert.equal(dispatcher.evaluateTaskReadiness(sub1).canStart, true)
    const sub2ReadinessBefore = dispatcher.evaluateTaskReadiness(sub2)
    assert.equal(sub2ReadinessBefore.canStart, false)
    assert.equal(sub2ReadinessBefore.reasonCode, 'waiting_deps')
    assert.ok(sub2ReadinessBefore.waitingReason.includes('Ждёт зависимости (0/1)'))

    // 6. Run queue -> only sub1 should launch!
    await dispatcher.processQueue()
    assert.equal(ctx.sessions.length, 1)
    assert.ok(ctx.sessions[0].title.includes('Subtask 1'))
    assert.equal(dispatcher.getTask(sub1.id).status, 'running')
    assert.equal(dispatcher.getTask(sub2.id).status, 'todo')

    // 7. Complete sub1 -> should mark sub1 Done (and spawn reg), then automatically start sub2!
    dispatcher.onSessionEvent({ id: ctx.sessions[0].sessionId }, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await new Promise(r => setTimeout(r, 60))

    assert.equal(dispatcher.getTask(sub1.id).status, 'done')
    // Parent should still be in backlog because sub2 is not done yet
    assert.equal(dispatcher.getTask(parentTask.id).status, 'backlog')

    const sub2Session = ctx.sessions.find(s => s.title.includes('Subtask 2'))
    assert.ok(sub2Session, 'Subtask 2 session should have started after Subtask 1 completed')
    assert.equal(dispatcher.getTask(sub2.id).status, 'running')

    // 8. Complete sub2 -> both subtasks are now Done -> parentTask should auto-complete to 'done'!
    dispatcher.onSessionEvent({ id: sub2Session.sessionId }, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await new Promise(r => setTimeout(r, 60))

    assert.equal(dispatcher.getTask(sub2.id).status, 'done')
    const updatedParent = dispatcher.getTask(parentTask.id)
    assert.equal(updatedParent.status, 'done')
    assert.ok(
      updatedParent.comments.some(c => c.text.includes('Все подзадачи (2/2) успешно выполнены')),
      'Parent task should have auto-completion comment'
    )
    assert.ok(
      dispatcher.dispatcherEvents.some(ev => ev.kind === 'parent_done'),
      'Dispatcher event log should record parent_done'
    )

    dispatcher.stop()
  })

  it('Telegram bridge: masks token, enforces 81815557 whitelist, handles /status, /tasks, /approve, /reject and forwards text to shturman', async () => {
    const ctx = createMockCtx()
    const dispatcher = new DiveTeamDispatcher(ctx, {
      projectRoot: tempDir,
      maxHeavyWorkers: 3,
      hostLockPath: lockPath,
    })
    dispatcher.start()
    clearInterval(dispatcher.queueTimer)

    // Mock sendMessage so no real HTTP requests are made during unit tests
    const sentMessages = []
    dispatcher.telegram.token = '123456:TEST_FAKE_TOKEN_FOR_UNIT_TEST_ONLY_999'
    dispatcher.telegram.allowedChatId = '81815557'
    dispatcher.telegram.allowedUserId = '81815557'
    dispatcher.telegram.tokenSource = 'kdewallet'
    dispatcher.telegram.sendMessage = async (text, extra = {}) => {
      sentMessages.push({ text, extra })
      return { ok: true }
    }

    const tgStatus = dispatcher.telegram.status()
    assert.equal(tgStatus.enabled, true)
    assert.equal(tgStatus.allowedChatId, '81815557')
    assert.equal(tgStatus.allowedUserId, '81815557')
    assert.equal(tgStatus.tokenSource, 'kdewallet')
    assert.ok(tgStatus.maskedToken.startsWith('12345****'), 'Token must be masked in status()')
    assert.ok(!tgStatus.maskedToken.includes('TEST_FAKE_TOKEN'), 'Raw token must never leak in status()')

    // Create a clarify task to test /approve and /reject
    const task1 = dispatcher.ledger.create({
      title: 'Deploy production config',
      description: '',
      prompt: 'Deploy',
      role: 'sre',
      status: 'backlog',
      phase: 'clarify',
      approvalRequested: 'Подтвердите выкатку на diveteam?',
      repoPath: repoDir,
    })

    // 1. Test /status and /tasks
    await dispatcher.handleTelegramCommand('/status')
    assert.ok(sentMessages.some(m => m.text.includes('Сводка системы «Фарватер»') || m.text.includes('DiveTeam')), '/status should reply with system summary')

    await dispatcher.handleTelegramCommand('/tasks')
    assert.ok(sentMessages.some(m => m.text.includes(task1.id.slice(0, 8))), '/tasks should list task1 short ID')

    // 2. Test /approve <id> <comment>
    await dispatcher.handleTelegramCommand(`/approve ${task1.id.slice(0, 8)} Разрешаю деплой`)
    const afterApprove = dispatcher.getTask(task1.id)
    assert.ok(
      afterApprove.comments.some(c => c.text.includes('Разрешаю деплой')),
      'Approval comment from Telegram should be recorded'
    )

    // 3. Put another task in clarify and test /reject <id> <reason>
    const task2 = dispatcher.ledger.create({
      title: 'Drop legacy table',
      description: '',
      prompt: 'Drop table',
      role: 'sre',
      status: 'backlog',
      phase: 'clarify',
      repoPath: repoDir,
    })
    await dispatcher.handleTelegramCommand(`/reject ${task2.id.slice(0, 8)} Слишком опасно без бэкапа`)
    const afterReject = dispatcher.getTask(task2.id)
    assert.equal(afterReject.status, 'failed')
    assert.equal(afterReject.phase, 'failed')
    assert.ok(afterReject.comments.some(c => c.text.includes('Слишком опасно без бэкапа')))

    // 4. Test persistent Shturman session across multiple messages + typing indicator + /new
    let typingCalls = 0
    dispatcher.telegram.sendTypingAction = async () => {
      typingCalls += 1
      return true
    }

    const countBefore = sentMessages.length
    await dispatcher.handleTelegramCommand('Приём. Работаешь?')
    assert.equal(sentMessages.length, countBefore, 'Should NOT send robotic inbox confirmation before Shturman replies')
    assert.ok(typingCalls >= 1, 'Should trigger sendTypingAction immediately while Shturman is thinking')

    const shturmanSession = ctx.sessions.find(s => s.title === 'Telegram · Штурман (@slava)')
    assert.ok(shturmanSession, 'Should create persistent session titled "Telegram · Штурман (@slava)"')
    assert.equal(dispatcher.telegramSessionId, shturmanSession.sessionId)
    assert.ok(existsSync(join(tempDir, '.dsh-telegram-session.json')), 'Should persist .dsh-telegram-session.json')

    // Simulate Shturman assistant output and turn/end for Turn 1
    dispatcher.onSessionEvent({ id: shturmanSession.sessionId }, {
      type: 'assistant/message',
      data: {
        message: {
          content: [{ type: 'text', text: 'На связи, Слава! Все контуры в норме.' }],
        },
      },
    })
    dispatcher.onSessionEvent({ id: shturmanSession.sessionId }, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await new Promise(r => setTimeout(r, 30))

    assert.equal(sentMessages.at(-1).text, 'На связи, Слава! Все контуры в норме.', 'Reply should be clean first-person text')
    assert.equal(dispatcher.telegram.typingTimer, null, 'Typing loop must stop on turn/end')

    // Send a second message -> must reuse the EXACT same sessionId!
    await dispatcher.handleTelegramCommand('Отлично, продолжаем диалог')
    assert.equal(dispatcher.telegramSessionId, shturmanSession.sessionId, 'Second message must reuse the same persistent session')
    assert.equal(shturmanSession.prompts.length, 2, 'Both messages must be sent to the same session')
    assert.equal(shturmanSession.prompts[1], 'Отлично, продолжаем диалог', 'Subsequent messages are sent cleanly without wrapper')

    dispatcher.onSessionEvent({ id: shturmanSession.sessionId }, {
      type: 'assistant/message',
      data: {
        message: {
          content: [{ type: 'text', text: 'Принято, продолжаем в этой же сессии.' }],
        },
      },
    })
    dispatcher.onSessionEvent({ id: shturmanSession.sessionId }, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(sentMessages.at(-1).text, 'Принято, продолжаем в этой же сессии.')

    // Test /new command -> creates a new session
    await dispatcher.handleTelegramCommand('/new')
    assert.notEqual(dispatcher.telegramSessionId, shturmanSession.sessionId, '/new should create a fresh Shturman session')
    assert.ok(sentMessages.at(-1).text.includes('Создана новая сессия диалога со Штурманом'))

    dispatcher.stop()
  })

  it('formatMarkdownForTelegramHtml: converts Markdown headers, bold, inline code, code blocks, and 4-column tables into clean Telegram HTML', () => {
    const sample = [
      'Проверено на практике. **Ты прав**, и вот точная механика — обе картины верны, но в разных контекстах.',
      '## Что показали пробы',
      '',
      '| Проба | Мой `bash` (чат Штурмана) | `agy` из моей оболочки | `agy` вне песочницы (`systemd-run`) |',
      '|---|---|---|---|',
      '| Запись в `/home/slava/*` | ❌ ФС только для чтения | ❌ падение тула | ✅ exit=0 |',
      '| Запись в `~/.gemini/antigravity-cli/` | ❌ ro | ❌ `failed to write agentapi: read-only file system` | ✅ exit=0 |',
      '| `NoNewPrivs` | 1 | — | 0 |',
      '| `Seccomp` | 0 | — | 0 |',
      '| mnt-namespace | `4026534390` (свой) | унаследован от меня | `4026531832` (хостовый) |',
      '| uid / группы | 1000 | 1000 | 1000 + `wheel`, `incus-admin`, `video`, `audio`… |',
      '| `sudo -n true` | — | — | ❌ требует пароль (нет NOPASSWD) |',
    ].join('\n')

    const html = formatMarkdownForTelegramHtml(sample)

    // Ensure no raw Markdown syntax remains
    assert.ok(!html.includes('**'), 'Should not contain raw ** bold markers')
    assert.ok(!html.includes('##'), 'Should not contain raw ## heading markers')
    assert.ok(!html.includes('|---|'), 'Should not contain raw table separator |---|')
    assert.ok(!html.includes('`'), 'Should not contain raw backticks')

    // Ensure expected HTML tags and card structure are present
    assert.ok(html.includes('<b>Ты прав</b>'), 'Should convert **Ты прав** to <b>Ты прав</b>')
    assert.ok(html.includes('<b>Что показали пробы</b>'), 'Should convert ## heading to <b>')
    assert.ok(html.includes('▸ <b>Запись в <code>/home/slava/*</code></b>'), 'Should render table row title with ▸ <b> and <code>')
    assert.ok(
      html.includes('• <i>Мой <code>bash</code> (чат Штурмана):</i> ❌ ФС только для чтения'),
      'Should render table columns as bulleted key-value items'
    )
    assert.ok(
      html.includes('<code>failed to write agentapi: read-only file system</code>'),
      'Should preserve inline code inside table cells'
    )
  })

  it('manages workflow rules: loads defaults, updates via API, and respects custom pipeline conditions', async () => {
    const ctx = createMockCtx()
    const dispatcher = new DiveTeamDispatcher(ctx, {
      projectRoot: tempDir,
      maxHeavyWorkers: 3,
      hostLockPath: lockPath,
    })
    dispatcher.start()

    const routes = dispatcher.taskRoutes()
    const workflowRoute = routes.find(r => r.path === '/diveteam/workflow')
    const resetRoute = routes.find(r => r.path === '/diveteam/workflow/reset')
    const legacyWorkflowRoute = routes.find(r => r.path === '/farvater/workflow')
    const legacyResetRoute = routes.find(r => r.path === '/farvater/workflow/reset')
    assert.ok(workflowRoute, 'workflowRoute (/diveteam/workflow) should be registered')
    assert.ok(resetRoute, 'resetRoute (/diveteam/workflow/reset) should be registered')
    assert.ok(legacyWorkflowRoute, 'legacyWorkflowRoute (/farvater/workflow) should be registered')
    assert.ok(legacyResetRoute, 'legacyResetRoute (/farvater/workflow/reset) should be registered')

    // GET /diveteam/workflow
    let responseBody = null
    const mockRes = {
      writeHead: () => {},
      end: (data) => { responseBody = JSON.parse(data) },
    }
    const mockGetReq = {
      method: 'GET',
      headers: { 'sec-fetch-site': 'same-origin' },
    }
    await workflowRoute.handler(mockGetReq, mockRes)
    assert.equal(responseBody.ok, true)
    assert.equal(responseBody.rules.pipeline.autoHandoffDevToQa, true)
    assert.equal(responseBody.rules.pipeline.maxQaRetries, 2)

    // GET /farvater/workflow (backward-compatible alias)
    let legacyResponseBody = null
    const legacyMockRes = {
      writeHead: () => {},
      end: (data) => { legacyResponseBody = JSON.parse(data) },
    }
    await legacyWorkflowRoute.handler(mockGetReq, legacyMockRes)
    assert.equal(legacyResponseBody.ok, true)
    assert.equal(legacyResponseBody.rules.pipeline.autoHandoffDevToQa, true)

    // POST /diveteam/workflow with updated conditions
    async function* makeAsyncIterable(obj) {
      yield Buffer.from(JSON.stringify(obj))
    }
    const mockPostReq = Object.assign(makeAsyncIterable({
      pipeline: {
        autoHandoffDevToQa: false,
        maxQaRetries: 4,
        qaEscalationTarget: 'slava',
      },
    }), {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    })

    await workflowRoute.handler(mockPostReq, mockRes)
    assert.equal(responseBody.ok, true)
    assert.equal(responseBody.rules.pipeline.autoHandoffDevToQa, false)
    assert.equal(responseBody.rules.pipeline.maxQaRetries, 4)
    assert.equal(responseBody.rules.pipeline.qaEscalationTarget, 'slava')
    assert.equal(dispatcher.workflowRules.pipeline.maxQaRetries, 4)

    // POST /farvater/workflow/reset (backward-compatible alias)
    const mockResetReq = {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    }
    await legacyResetRoute.handler(mockResetReq, mockRes)
    assert.equal(responseBody.ok, true)
    assert.equal(responseBody.rules.pipeline.autoHandoffDevToQa, true)
    assert.equal(responseBody.rules.pipeline.maxQaRetries, 2)

    dispatcher.stop()
  })
})


