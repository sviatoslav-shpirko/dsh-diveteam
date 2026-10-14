/**
 * Workflow Schema & Conditions Editor:
 * Modern Jira-style status nodes, transitions, lozenges, and live condition editing.
 *
 * Fully adaptive to both Dark and Light themes with high-contrast buttons and borders.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  GitFork,
  FloppyDisk,
  ArrowCounterClockwise,
  TreeStructure,
  Sliders,
  Users,
  Tag,
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
  CornersOut,
  Play,
  Tray,
  Code,
  CheckCircle,
  GitMerge,
  Warning,
  Archive,
  Cpu,
  Brain,
  Wrench,
  Plus,
  ArrowUUpLeft,
  PaperPlaneTilt,
  ShieldCheck,
  CheckSquare,
  ArrowsClockwise,
  Target,
  ArrowRight,
  CircleNotch,
} from '@phosphor-icons/react'
import { getRoleIcon, stripEmoji } from './AgentsPanel.tsx'
import { useIsDarkTheme, createAdaptiveStyles, getFlowchartTokens, getJiraWorkflowTokens } from './theme.ts'

export interface WorkflowPipelineRules {
  autoHandoffDevToQa: boolean
  requireDiffForQa: boolean
  autoMergeOnQaPass: boolean
  maxQaRetries: number
  qaEscalationTarget: 'arch' | 'slava' | 'failed'
  escalationNotifyTelegram: boolean
  conflictFallback: 'dev' | 'arch'
  requireSreApproval: boolean
  autoReleaseHostLock: boolean
  parentAutoRollup: boolean
  exportReportToVault: boolean
  autoRunRegArchivist: boolean
  maxHeavyWorkers: number
  maxDailyTokens: number
}

export interface RoleTransitionRule {
  label?: string
  isolationMode: string
  onSuccess: string
  onFailure: string
  requireApproval: boolean
  description?: string
}

export interface WorkflowRules {
  pipeline: WorkflowPipelineRules
  roleTransitions: Record<string, RoleTransitionRule>
}

interface WorkflowPanelProps {
  embedded?: boolean
}

type CanvasNodeId =
  | 'backlog'
  | 'trigger'
  | 'dev'
  | 'agent'
  | 'qa'
  | 'router'
  | 'merge'
  | 'retry'
  | 'escalate'
  | 'reg'
  | 'model'
  | 'memory'
  | 'tools'

export function WorkflowPanel({ embedded = false }: WorkflowPanelProps): ReactElement {
  const isDark = useIsDarkTheme()
  const { t, card, btn, btnPrimary, input, select } = createAdaptiveStyles(isDark)
  const fc = getFlowchartTokens(isDark)
  const jira = getJiraWorkflowTokens(isDark)

  const [rules, setRules] = useState<WorkflowRules | null>(null)
  const [initialRules, setInitialRules] = useState<string>('')
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({
    backlog: 0,
    todo: 0,
    running: 0,
    done: 0,
    failed: 0,
    clarify: 0,
  })
  const [activeTab, setActiveTab] = useState<'canvas' | 'pipeline' | 'roles'>('canvas')
  const [selectedNode, setSelectedNode] = useState<CanvasNodeId>('qa')
  const [zoom, setZoom] = useState<number>(1.0)
  const [showTransitionLabels, setShowTransitionLabels] = useState<boolean>(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)
  const [rolesList, setRolesList] = useState<Array<{ id: string; name: string }>>([])

  async function fetchWf(url: string, init?: RequestInit): Promise<Response> {
    let res = await fetch(url, init)
    if (res.status === 404 && url.startsWith('/diveteam/')) {
      const fallbackRes = await fetch(url.replace('/diveteam/', '/farvater/'), init)
      if (fallbackRes.ok) res = fallbackRes
    }
    return res
  }

  const fetchWorkflowData = useCallback(async (): Promise<void> => {
    try {
      const [wfRes, monRes, rolesRes] = await Promise.all([
        fetchWf('/diveteam/workflow', { credentials: 'same-origin', headers: { 'sec-fetch-site': 'same-origin' } }),
        fetchWf('/diveteam/monitoring', { credentials: 'same-origin', headers: { 'sec-fetch-site': 'same-origin' } }).catch(() => null),
        fetchWf('/diveteam/roles', { credentials: 'same-origin', headers: { 'sec-fetch-site': 'same-origin' } }).catch(() => null),
      ])

      if (wfRes.ok) {
        const wfData = (await wfRes.json()) as { ok: boolean; rules: WorkflowRules }
        if (wfData.ok && wfData.rules) {
          setRules(wfData.rules)
          setInitialRules(JSON.stringify(wfData.rules))
        }
      }

      if (monRes && monRes.ok) {
        const monData = (await monRes.json()) as { queueCounts?: Record<string, number> }
        if (monData.queueCounts) setTaskCounts(monData.queueCounts)
      }

      if (rolesRes && rolesRes.ok) {
        const rData = (await rolesRes.json()) as { roles?: Array<{ id: string; name: string }> }
        if (Array.isArray(rData.roles)) setRolesList(rData.roles)
      }
    } catch (err) {
      setMessage({ text: `Ошибка загрузки правил: ${err instanceof Error ? err.message : String(err)}`, type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchWorkflowData()
  }, [fetchWorkflowData])

  const isDirty = rules ? JSON.stringify(rules) !== initialRules : false

  const handleSave = async (): Promise<void> => {
    if (!rules) return
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetchWf('/diveteam/workflow', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        credentials: 'same-origin',
        body: JSON.stringify({ rules }),
      })
      const data = (await res.json()) as { ok: boolean; rules?: WorkflowRules; error?: string }
      if (data.ok && data.rules) {
        setRules(data.rules)
        setInitialRules(JSON.stringify(data.rules))
        setMessage({ text: 'Правила воркфлоу успешно сохранены и применены в Диспетчере!', type: 'success' })
      } else {
        setMessage({ text: `Ошибка: ${data.error ?? 'не удалось сохранить'}`, type: 'error' })
      }
    } catch (err) {
      setMessage({ text: `Ошибка сохранения: ${err instanceof Error ? err.message : String(err)}`, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async (): Promise<void> => {
    if (!window.confirm('Сбросить все правила воркфлоу к стандартным значениям архитектуры «DiveTeam»?')) return
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetchWf('/diveteam/workflow/reset', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
        credentials: 'same-origin',
      })
      const data = (await res.json()) as { ok: boolean; rules?: WorkflowRules; error?: string }
      if (data.ok && data.rules) {
        setRules(data.rules)
        setInitialRules(JSON.stringify(data.rules))
        setMessage({ text: 'Правила воркфлоу сброшены к стандартным!', type: 'success' })
      }
    } catch (err) {
      setMessage({ text: `Ошибка сброса: ${err instanceof Error ? err.message : String(err)}`, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const updatePipeline = <K extends keyof WorkflowPipelineRules>(key: K, value: WorkflowPipelineRules[K]): void => {
    if (!rules) return
    setRules({
      ...rules,
      pipeline: {
        ...rules.pipeline,
        [key]: value,
      },
    })
  }

  const updateRoleTransition = (roleId: string, patch: Partial<RoleTransitionRule>): void => {
    if (!rules) return
    const current = rules.roleTransitions[roleId] ?? {
      isolationMode: 'none',
      onSuccess: 'done',
      onFailure: 'failed',
      requireApproval: false,
    }
    setRules({
      ...rules,
      roleTransitions: {
        ...rules.roleTransitions,
        [roleId]: {
          ...current,
          ...patch,
        },
      },
    })
  }

  if (loading && !rules) {
    return (
      <div style={{ ...card, padding: 24, textAlign: 'center' }}>
        <p style={{ margin: 0, opacity: 0.8, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <CircleNotch size={16} className="diveteam-spin farvater-spin" /> Загрузка воркфлоу схемы и условий диспетчера…
        </p>
      </div>
    )
  }

  if (!rules) {
    return (
      <div style={{ ...card, padding: 24, color: '#ef4444' }}>
        <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Warning size={16} /> Не удалось загрузить конфигурацию воркфлоу.
        </p>
        <button type="button" style={{ ...btn, marginTop: 12 }} onClick={() => void fetchWorkflowData()}>
          Повторить попытку
        </button>
      </div>
    )
  }

  const p = rules.pipeline

  // Jira Automation Workflow Tree Configuration
  const jiraStatuses = [
    {
      id: 'backlog' as CanvasNodeId,
      altId: 'trigger' as CanvasNodeId,
      categoryLozenge: 'WHEN: TRIGGER',
      name: 'Входящая задача',
      role: 'shturman · arch',
      tasksCount: taskCounts.backlog + taskCounts.todo,
      badgeText: `${taskCounts.backlog + taskCounts.todo} в очереди`,
      x: 35,
      y: 155,
      w: 230,
      h: 104,
      icon: <Tray size={16} weight="bold" />,
      style: jira.todo,
      description: 'Входящие задачи, ожидающие проверки требований и постановки в разработку',
    },
    {
      id: 'dev' as CanvasNodeId,
      altId: 'agent' as CanvasNodeId,
      categoryLozenge: 'THEN: ACTION',
      name: 'Разработка (Dev)',
      role: 'dev · sre · worktree',
      tasksCount: taskCounts.running,
      badgeText: `${taskCounts.running} / ${p.maxHeavyWorkers} слотов`,
      x: 325,
      y: 135,
      w: 250,
      h: 144,
      icon: <Code size={16} weight="bold" />,
      style: jira.inProgress,
      description: 'Исполнение задачи автономным агентом в изолированном git_worktree',
    },
    {
      id: 'qa' as CanvasNodeId,
      altId: 'router' as CanvasNodeId,
      categoryLozenge: 'IF: CONDITION',
      name: 'Автоконтроль QA',
      role: 'qa (Автотесты & Diff)',
      tasksCount: 0,
      badgeText: `макс ${p.maxQaRetries}x`,
      x: 635,
      y: 155,
      w: 230,
      h: 104,
      icon: <CheckSquare size={16} weight="bold" />,
      style: jira.inReview,
      description: 'Верификация кода: прогон тестов, анализ git diff, линтеры и проверка критериев приемки',
    },
    {
      id: 'merge' as CanvasNodeId,
      altId: 'merge' as CanvasNodeId,
      categoryLozenge: 'BRANCH: PASS',
      name: 'Слияние в main',
      role: 'merge.lock → main',
      tasksCount: taskCounts.done,
      badgeText: `${taskCounts.done} задач`,
      x: 935,
      y: 35,
      w: 230,
      h: 90,
      icon: <GitMerge size={16} weight="bold" />,
      style: jira.done,
      description: 'Успешная финализация задачи: захват блокировки merge.lock и авто-вливание в main',
    },
    {
      id: 'reg' as CanvasNodeId,
      altId: 'reg' as CanvasNodeId,
      categoryLozenge: 'FINISH: VAULT',
      name: 'База знаний & Vault',
      role: 'reg (Регистратор)',
      tasksCount: 0,
      badgeText: 'memvault',
      x: 935,
      y: 155,
      w: 230,
      h: 90,
      icon: <Archive size={16} weight="bold" />,
      style: jira.archived,
      description: 'Пост-процессинг: извлечение уроков, обновление графа знаний и пуш в GitHub memvault',
    },
    {
      id: 'retry' as CanvasNodeId,
      altId: 'retry' as CanvasNodeId,
      categoryLozenge: 'BRANCH: RETRY',
      name: 'Повтор при ошибке',
      role: `Ретрай в Dev (попытки < ${p.maxQaRetries})`,
      tasksCount: 0,
      badgeText: `${p.maxQaRetries}x ретрай`,
      x: 935,
      y: 275,
      w: 230,
      h: 90,
      icon: <ArrowsClockwise size={16} weight="bold" />,
      style: jira.retry,
      description: 'Возврат задачи разработчику с логами упавших тестов и комментариями для авто-исправления',
    },
    {
      id: 'escalate' as CanvasNodeId,
      altId: 'escalate' as CanvasNodeId,
      categoryLozenge: 'BRANCH: ESCALATE',
      name: 'Ручной разбор (Clarify)',
      role: `@${p.qaEscalationTarget}`,
      tasksCount: taskCounts.clarify + taskCounts.failed,
      badgeText: `${taskCounts.clarify + taskCounts.failed} задач`,
      x: 935,
      y: 395,
      w: 230,
      h: 90,
      icon: <Warning size={16} weight="bold" />,
      style: jira.escalated,
      description: 'Тупик правок или ошибка тестов: передача на ручной разбор Архитектору или Славе',
    },
  ]

  return (
    <div style={{ height: '100%', overflowY: 'auto', paddingRight: 6, paddingBottom: 28 }}>
      {/* ШАПКА РАЗДЕЛА */}
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, color: t.textPrimary }}>
              <GitFork size={20} weight="bold" color="#3b82f6" /> Воркфлоу схема и условия переходов
            </h2>
            <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
              Интерактивная карта конвейера DiveTeam AI: маршруты задач, условия переходов, авто-слияние, ретраи и эскалация.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {isDirty ? (
              <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                ● Есть несохранённые изменения
              </span>
            ) : (
              <span style={{ fontSize: 12, color: '#22c55e', display: 'flex', alignItems: 'center', gap: 4 }}>
                ● Конфигурация синхронизирована
              </span>
            )}

            <button
              type="button"
              style={{
                ...(isDirty ? btnPrimary : { ...btn, opacity: 0.6 }),
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
              onClick={() => void handleSave()}
              disabled={saving || !isDirty}
            >
              <FloppyDisk size={14} weight="bold" /> {saving ? 'Сохранение…' : 'Сохранить изменения'}
            </button>

            <button
              type="button"
              style={{
                ...btn,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
              onClick={() => void handleReset()}
              disabled={saving}
              title="Сбросить все правила к заводским настройкам"
            >
              <ArrowCounterClockwise size={14} /> Сброс к эталону
            </button>
          </div>
        </div>

        {message ? (
          <div
            style={{
              marginTop: 12,
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 12,
              background: message.type === 'success' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
              color: message.type === 'success' ? (isDark ? '#4ade80' : '#15803d') : (isDark ? '#f87171' : '#b91c1c'),
              border: `1px solid ${message.type === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            }}
          >
            {message.text}
          </div>
        ) : null}

        {/* НАВИГАЦИЯ ПО ВЬЮХАМ */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            type="button"
            style={{
              ...btn,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: activeTab === 'canvas' ? (isDark ? 'rgba(37,99,235,0.25)' : 'rgba(37,99,235,0.12)') : t.btnBg,
              borderColor: activeTab === 'canvas' ? '#3b82f6' : t.btnBorder,
              color: activeTab === 'canvas' ? (isDark ? '#93c5fd' : '#1d4ed8') : t.btnText,
              fontWeight: activeTab === 'canvas' ? 700 : 500,
            }}
            onClick={() => setActiveTab('canvas')}
          >
            <TreeStructure size={15} /> Схема воркфлоу (Jira Canvas)
          </button>
          <button
            type="button"
            style={{
              ...btn,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: activeTab === 'pipeline' ? (isDark ? 'rgba(37,99,235,0.25)' : 'rgba(37,99,235,0.12)') : t.btnBg,
              borderColor: activeTab === 'pipeline' ? '#3b82f6' : t.btnBorder,
              color: activeTab === 'pipeline' ? (isDark ? '#93c5fd' : '#1d4ed8') : t.btnText,
              fontWeight: activeTab === 'pipeline' ? 700 : 500,
            }}
            onClick={() => setActiveTab('pipeline')}
          >
            <Sliders size={15} /> Детальные параметры конвейера
          </button>
          <button
            type="button"
            style={{
              ...btn,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: activeTab === 'roles' ? (isDark ? 'rgba(37,99,235,0.25)' : 'rgba(37,99,235,0.12)') : t.btnBg,
              borderColor: activeTab === 'roles' ? '#3b82f6' : t.btnBorder,
              color: activeTab === 'roles' ? (isDark ? '#93c5fd' : '#1d4ed8') : t.btnText,
              fontWeight: activeTab === 'roles' ? 700 : 500,
            }}
            onClick={() => setActiveTab('roles')}
          >
            <Users size={15} /> Матрица переходов ролей
          </button>
        </div>
      </div>

      {/* 1. ИНТЕРАКТИВНЫЙ JIRA WORKFLOW CANVAS & INSPECTOR */}
      {activeTab === 'canvas' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* ТУЛБАР РЕДАКТОРА СХЕМЫ JIRA */}
          <div
            style={{
              ...card,
              padding: '10px 14px',
              marginBottom: 0,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
                <GitFork size={15} weight="bold" color="#3b82f6" /> Схема: <code>DiveTeam-Core-Pipeline</code>
              </span>
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  background: jira.done.lozengeBg,
                  color: jira.done.lozengeText,
                  border: `1px solid ${jira.done.lozengeBorder}`,
                  letterSpacing: '0.5px',
                }}
              >
                ● ACTIVE / PUBLISHED
              </span>

              {/* Легенда категорий Jira Workflow */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, marginLeft: 8, flexWrap: 'wrap' }}>
                <span style={{ color: jira.todo.accentColor, fontWeight: 600 }}>● WHEN: Trigger</span>
                <span style={{ color: jira.inProgress.accentColor, fontWeight: 600 }}>● THEN: Action</span>
                <span style={{ color: jira.inReview.accentColor, fontWeight: 600 }}>● IF: Condition</span>
                <span style={{ color: jira.done.accentColor, fontWeight: 600 }}>● BRANCH: Pass</span>
                <span style={{ color: jira.retry.accentColor, fontWeight: 600 }}>● BRANCH: Retry</span>
                <span style={{ color: jira.escalated.accentColor, fontWeight: 600 }}>● BRANCH: Escalate</span>
                <span style={{ color: jira.archived.accentColor, fontWeight: 600 }}>● FINISH: Vault</span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                style={{
                  ...btn,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '4px 8px',
                  fontSize: 11,
                  background: showTransitionLabels ? (isDark ? 'rgba(59,130,246,0.2)' : 'rgba(37,99,235,0.1)') : t.btnBg,
                  borderColor: showTransitionLabels ? '#3b82f6' : t.btnBorder,
                  color: showTransitionLabels ? (isDark ? '#93c5fd' : '#1d4ed8') : t.btnText,
                }}
                onClick={() => setShowTransitionLabels((v) => !v)}
                title="Показать / скрыть названия переходов"
              >
                <Tag size={13} /> Подписи {showTransitionLabels ? 'Вкл' : 'Выкл'}
              </button>

              {/* Масштаб схемы */}
              <div style={{ display: 'inline-flex', alignItems: 'center', background: t.btnBg, borderRadius: 6, border: `1px solid ${t.btnBorder}`, padding: 2 }}>
                <button
                  type="button"
                  style={{ ...btn, padding: '4px 6px', border: 'none', background: 'transparent', boxShadow: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => setZoom((z) => Math.max(0.7, Math.round((z - 0.1) * 10) / 10))}
                  title="Уменьшить масштаб"
                >
                  <MagnifyingGlassMinus size={14} />
                </button>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '0 6px', minWidth: 42, textAlign: 'center', color: t.textPrimary }}>
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type="button"
                  style={{ ...btn, padding: '4px 6px', border: 'none', background: 'transparent', boxShadow: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => setZoom((z) => Math.min(1.3, Math.round((z + 0.1) * 10) / 10))}
                  title="Увеличить масштаб"
                >
                  <MagnifyingGlassPlus size={14} />
                </button>
              </div>

              <button
                type="button"
                style={{ ...btn, padding: '4px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                onClick={() => setZoom(1.0)}
                title="Сбросить масштаб к 100%"
              >
                <CornersOut size={13} /> 100%
              </button>
            </div>
          </div>

          {/* КОНТЕЙНЕР ХОЛСТА JIRA AUTOMATION ВОРКФЛОУ */}
          <div
            style={{
              position: 'relative',
              borderRadius: 12,
              background: 'var(--dsw-alias-bg-layer-1, ' + (isDark ? '#1a1d24' : '#f7f8fa') + ')',
              border: `1.5px solid var(--dsw-alias-border-l2, ${isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)'})`,
              boxShadow: t.cardShadow,
              overflowX: 'auto',
              minHeight: Math.max(560, Math.round(540 * zoom) + 30),
              padding: '20px 24px',
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                position: 'relative',
                width: 1200,
                height: 540,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
              }}
            >
              {/* SVG СЛОЙ ОРТОГОНАЛЬНЫХ СВЯЗЕЙ JIRA AUTOMATION */}
              <svg
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: 1200,
                  height: 540,
                  pointerEvents: 'none',
                  zIndex: 1,
                }}
              >
                <defs>
                  {/* Default connector arrow (slate) */}
                  <marker id="arrow-flow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill={jira.lineStroke} />
                  </marker>
                  {/* Green connector arrow for PASS */}
                  <marker id="arrow-flow-green" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill={jira.lineStrokePass} />
                  </marker>
                  {/* Red connector arrow for FAIL / Escalation */}
                  <marker id="arrow-flow-red" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill={jira.lineStrokeFail} />
                  </marker>
                  {/* Amber connector arrow for QA Retry */}
                  <marker id="arrow-flow-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill={jira.lineStrokeRetry} />
                  </marker>
                  {/* Blue connector arrow for Re-dispatch */}
                  <marker id="arrow-flow-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill={jira.lineStrokeBlue} />
                  </marker>
                  {/* Violet connector arrow for Vault */}
                  <marker id="arrow-flow-violet" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill={jira.lineStrokeVault} />
                  </marker>
                </defs>

                {/* 1. Trigger: Входящая задача (265, 207) -> Dev (325, 207) */}
                <path
                  d="M 265 207 L 325 207"
                  fill="none"
                  stroke={jira.lineStroke}
                  strokeWidth="2.2"
                  markerEnd="url(#arrow-flow)"
                />

                {/* 2. Dev (575, 207) -> QA (635, 207) */}
                <path
                  d="M 575 207 L 635 207"
                  fill="none"
                  stroke={jira.lineStroke}
                  strokeWidth="2.2"
                  markerEnd="url(#arrow-flow)"
                />

                {/* 3. QA (865, 207) -> Horizontal trunk to split at (895, 207) */}
                <path
                  d="M 865 207 L 895 207"
                  fill="none"
                  stroke={jira.lineStroke}
                  strokeWidth="2.2"
                />

                {/* 4. Branch PASS: (895, 207) -> Up to y=80 -> Right into Merge (935, 80) */}
                <path
                  d="M 895 207 L 895 80 L 935 80"
                  fill="none"
                  stroke={jira.lineStrokePass}
                  strokeWidth="2.2"
                  markerEnd="url(#arrow-flow-green)"
                />

                {/* 5. Finish Vault: Merge bottom (1050, 125) -> Down to Vault top (1050, 155) */}
                <path
                  d="M 1050 125 L 1050 155"
                  fill="none"
                  stroke={jira.lineStrokeVault}
                  strokeWidth="2"
                  strokeDasharray="4 4"
                  markerEnd="url(#arrow-flow-violet)"
                />

                {/* 6. Branch RETRY: (895, 207) -> Down to y=320 -> Right into Retry (935, 320) */}
                <path
                  d="M 895 207 L 895 320 L 935 320"
                  fill="none"
                  stroke={jira.lineStrokeRetry}
                  strokeWidth="2.2"
                  markerEnd="url(#arrow-flow-amber)"
                />

                {/* 7. Branch ESCALATE: (895, 320) -> Down to y=440 -> Right into Escalate (935, 440) */}
                <path
                  d="M 895 320 L 895 440 L 935 440"
                  fill="none"
                  stroke={jira.lineStrokeFail}
                  strokeWidth="2.2"
                  markerEnd="url(#arrow-flow-red)"
                />

                {/* 8. Loopback RETRY -> Dev: (1050, 365) -> Down to y=495 -> Left to x=450 -> Up to Dev bottom (450, 279) */}
                <path
                  d="M 1050 365 L 1050 495 L 450 495 L 450 279"
                  fill="none"
                  stroke={jira.lineStrokeRetry}
                  strokeWidth="2"
                  strokeDasharray="4 4"
                  markerEnd="url(#arrow-flow-amber)"
                />

                {/* 9. Re-dispatch ESCALATE -> Dev: (980, 485) -> Down to y=520 -> Left to x=280 -> Up to y=207 -> Right to Dev (325, 207) */}
                <path
                  d="M 980 485 L 980 520 L 280 520 L 280 207 L 325 207"
                  fill="none"
                  stroke={jira.lineStrokeBlue}
                  strokeWidth="2"
                  strokeDasharray="6 4"
                  markerEnd="url(#arrow-flow-blue)"
                />

                {/* Junction dots */}
                <circle cx="895" cy="207" r="3.5" fill={jira.lineStroke} />
                <circle cx="895" cy="320" r="3" fill={jira.lineStrokeRetry} />
              </svg>

              {/* КАРТОЧКИ УЗЛОВ JIRA AUTOMATION */}
              {jiraStatuses.map((s) => {
                const isSelected = selectedNode === s.id || (s.altId && selectedNode === s.altId)
                const styleObj = s.style

                return (
                  <div
                    key={`${s.id}-${s.categoryLozenge}`}
                    style={{
                      position: 'absolute',
                      left: s.x,
                      top: s.y,
                      width: s.w,
                      height: s.h,
                      borderRadius: 8,
                      background: styleObj.bg,
                      border: isSelected
                        ? '2px solid #3b82f6'
                        : `1.5px solid ${styleObj.border}`,
                      borderLeft: `4px solid ${styleObj.accentColor}`,
                      boxShadow: isSelected
                        ? (isDark
                            ? '0 0 0 3px rgba(59,130,246,0.35), 0 8px 24px rgba(0,0,0,0.5)'
                            : '0 0 0 3px rgba(37,99,235,0.25), 0 8px 20px rgba(0,0,0,0.12)')
                        : (isDark
                            ? '0 3px 10px rgba(0,0,0,0.35)'
                            : '0 2px 6px rgba(0,0,0,0.06)'),
                      padding: '10px 12px',
                      cursor: 'pointer',
                      zIndex: isSelected ? 4 : 2,
                      boxSizing: 'border-box',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      transition: 'all 0.15s ease',
                    }}
                    onClick={() => setSelectedNode(s.id)}
                  >
                    {/* Top Row: Category Lozenge + Metric Badge */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          padding: '2px 6px',
                          borderRadius: 4,
                          fontSize: 9.5,
                          fontWeight: 700,
                          letterSpacing: '0.5px',
                          textTransform: 'uppercase',
                          background: styleObj.lozengeBg,
                          color: styleObj.lozengeText,
                          border: `1px solid ${styleObj.lozengeBorder}`,
                        }}
                      >
                        {s.categoryLozenge}
                      </span>
                      {s.badgeText ? (
                        <span
                          style={{
                            padding: '1px 6px',
                            borderRadius: 10,
                            fontSize: 9,
                            fontWeight: 600,
                            background: styleObj.countBadgeBg,
                            color: styleObj.countBadgeText,
                            flexShrink: 0,
                          }}
                        >
                          {s.badgeText}
                        </span>
                      ) : null}
                    </div>

                    {/* Title Row with Phosphor Icon */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4 }}>
                      <span style={{ display: 'inline-flex', flexShrink: 0, color: styleObj.accentColor }}>
                        {s.icon}
                      </span>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: styleObj.titleColor,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {s.name}
                      </span>
                    </div>

                    {/* Subtitle / Role */}
                    <div
                      style={{
                        fontSize: 10.5,
                        color: styleObj.subtext,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {s.role}
                    </div>

                    {/* Dev Card Sub-Actions: Model, Memory, Tools */}
                    {s.id === 'dev' && (
                      <div
                        style={{
                          display: 'flex',
                          gap: 4,
                          marginTop: 4,
                          paddingTop: 6,
                          borderTop: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          style={{
                            flex: 1,
                            padding: '3px 4px',
                            borderRadius: 4,
                            fontSize: 9.5,
                            fontWeight: selectedNode === 'model' ? 700 : 500,
                            background:
                              selectedNode === 'model'
                                ? (isDark ? 'rgba(99,102,241,0.35)' : 'rgba(99,102,241,0.18)')
                                : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                            border: `1px solid ${
                              selectedNode === 'model'
                                ? '#6366f1'
                                : (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)')
                            }`,
                            color: isDark ? '#e2e8f0' : '#1e293b',
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 3,
                          }}
                          onClick={() => setSelectedNode('model')}
                          title="Настройка нейросетевой модели"
                        >
                          <Cpu size={12} weight="bold" /> Model
                        </button>
                        <button
                          type="button"
                          style={{
                            flex: 1,
                            padding: '3px 4px',
                            borderRadius: 4,
                            fontSize: 9.5,
                            fontWeight: selectedNode === 'memory' ? 700 : 500,
                            background:
                              selectedNode === 'memory'
                                ? (isDark ? 'rgba(14,165,233,0.35)' : 'rgba(14,165,233,0.18)')
                                : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                            border: `1px solid ${
                              selectedNode === 'memory'
                                ? '#0ea5e9'
                                : (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)')
                            }`,
                            color: isDark ? '#e2e8f0' : '#1e293b',
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 3,
                          }}
                          onClick={() => setSelectedNode('memory')}
                          title="Память и Graphify"
                        >
                          <Brain size={12} weight="bold" /> Memory
                        </button>
                        <button
                          type="button"
                          style={{
                            flex: 1,
                            padding: '3px 4px',
                            borderRadius: 4,
                            fontSize: 9.5,
                            fontWeight: selectedNode === 'tools' ? 700 : 500,
                            background:
                              selectedNode === 'tools'
                                ? (isDark ? 'rgba(16,185,129,0.35)' : 'rgba(16,185,129,0.18)')
                                : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                            border: `1px solid ${
                              selectedNode === 'tools'
                                ? '#10b981'
                                : (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)')
                            }`,
                            color: isDark ? '#e2e8f0' : '#1e293b',
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 3,
                          }}
                          onClick={() => setSelectedNode('tools')}
                          title="Изоляция и dsh-agy"
                        >
                          <Wrench size={12} weight="bold" /> Tools
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}

              {/* ПОДПИСИ ПЕРЕХОДОВ И УСЛОВИЙ (TRANSITION PILLS) */}
              {showTransitionLabels ? (
                <>
                  {/* 1. Start */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 295,
                      top: 195,
                      transform: 'translate(-50%, -50%)',
                      padding: '2px 7px',
                      borderRadius: 12,
                      fontSize: 10,
                      fontWeight: 700,
                      background: jira.pillBg,
                      border: `1.5px solid ${jira.pillBorder}`,
                      color: jira.pillText,
                      boxShadow: isDark ? '0 2px 6px rgba(0,0,0,0.45)' : '0 1px 3px rgba(0,0,0,0.1)',
                      zIndex: 3,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    onClick={() => setSelectedNode('backlog')}
                  >
                    <Play size={10} weight="fill" /> Start
                  </div>

                  {/* 2. Diff ready */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 605,
                      top: 195,
                      transform: 'translate(-50%, -50%)',
                      padding: '2px 8px',
                      borderRadius: 12,
                      fontSize: 10,
                      fontWeight: 700,
                      background: jira.pillBg,
                      border: `1.5px solid ${isDark ? 'rgba(99,102,241,0.5)' : 'rgba(99,102,241,0.4)'}`,
                      color: isDark ? '#a5b4fc' : '#4338ca',
                      boxShadow: isDark ? '0 2px 6px rgba(0,0,0,0.45)' : '0 1px 3px rgba(0,0,0,0.1)',
                      zIndex: 3,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    onClick={() => setSelectedNode('qa')}
                  >
                    <CheckCircle size={10} weight="bold" /> Diff ready
                  </div>

                  {/* 3. PASS: Auto-Merge */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 900,
                      top: 100,
                      transform: 'translate(-50%, -50%)',
                      padding: '2px 8px',
                      borderRadius: 12,
                      fontSize: 10,
                      fontWeight: 700,
                      background: jira.pillBg,
                      border: `1.5px solid ${isDark ? 'rgba(34,197,94,0.5)' : 'rgba(34,197,94,0.4)'}`,
                      color: isDark ? '#86efac' : '#15803d',
                      boxShadow: isDark ? '0 2px 6px rgba(0,0,0,0.45)' : '0 1px 3px rgba(0,0,0,0.1)',
                      zIndex: 3,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    onClick={() => setSelectedNode('merge')}
                  >
                    <GitMerge size={10} weight="bold" /> PASS: Auto-Merge
                  </div>

                  {/* 4. Archive to Vault */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 1050,
                      top: 140,
                      transform: 'translate(-50%, -50%)',
                      padding: '2px 7px',
                      borderRadius: 12,
                      fontSize: 9.5,
                      fontWeight: 700,
                      background: jira.pillBg,
                      border: `1.5px solid ${isDark ? 'rgba(168,85,247,0.5)' : 'rgba(168,85,247,0.4)'}`,
                      color: isDark ? '#d8b4fe' : '#6d28d9',
                      boxShadow: isDark ? '0 2px 6px rgba(0,0,0,0.45)' : '0 1px 3px rgba(0,0,0,0.1)',
                      zIndex: 3,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    onClick={() => setSelectedNode('reg')}
                  >
                    <Archive size={10} weight="bold" /> Archive
                  </div>

                  {/* 5. FAIL: Retry (+1) */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 900,
                      top: 260,
                      transform: 'translate(-50%, -50%)',
                      padding: '2px 8px',
                      borderRadius: 12,
                      fontSize: 10,
                      fontWeight: 700,
                      background: jira.pillBg,
                      border: `1.5px solid ${isDark ? 'rgba(245,158,11,0.5)' : 'rgba(245,158,11,0.4)'}`,
                      color: isDark ? '#fde047' : '#b45309',
                      boxShadow: isDark ? '0 2px 6px rgba(0,0,0,0.45)' : '0 1px 3px rgba(0,0,0,0.1)',
                      zIndex: 3,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    onClick={() => setSelectedNode('retry')}
                  >
                    <ArrowsClockwise size={10} weight="bold" /> FAIL: Retry (+1)
                  </div>

                  {/* 6. FAIL: Escalate */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 900,
                      top: 380,
                      transform: 'translate(-50%, -50%)',
                      padding: '2px 8px',
                      borderRadius: 12,
                      fontSize: 10,
                      fontWeight: 700,
                      background: jira.pillBg,
                      border: `1.5px solid ${isDark ? 'rgba(239,68,68,0.5)' : 'rgba(239,68,68,0.4)'}`,
                      color: isDark ? '#fca5a5' : '#b91c1c',
                      boxShadow: isDark ? '0 2px 6px rgba(0,0,0,0.45)' : '0 1px 3px rgba(0,0,0,0.1)',
                      zIndex: 3,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    onClick={() => setSelectedNode('escalate')}
                  >
                    <Warning size={10} weight="bold" /> FAIL: Лимит исчерпан
                  </div>

                  {/* 7. Retry loopback to Dev */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 700,
                      top: 495,
                      transform: 'translate(-50%, -50%)',
                      padding: '2px 8px',
                      borderRadius: 12,
                      fontSize: 9.5,
                      fontWeight: 600,
                      background: jira.pillBg,
                      border: `1.5px solid ${isDark ? 'rgba(245,158,11,0.5)' : 'rgba(245,158,11,0.4)'}`,
                      color: isDark ? '#fde047' : '#b45309',
                      boxShadow: isDark ? '0 2px 6px rgba(0,0,0,0.45)' : '0 1px 3px rgba(0,0,0,0.1)',
                      zIndex: 3,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    onClick={() => setSelectedNode('dev')}
                  >
                    <ArrowCounterClockwise size={10} weight="bold" /> ↺ Loopback в Dev
                  </div>

                  {/* 8. Re-dispatch to Dev (/approve) */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 480,
                      top: 520,
                      transform: 'translate(-50%, -50%)',
                      padding: '2px 9px',
                      borderRadius: 12,
                      fontSize: 9.5,
                      fontWeight: 700,
                      background: jira.pillBg,
                      border: `1.5px solid ${isDark ? 'rgba(59,130,246,0.5)' : 'rgba(37,99,235,0.4)'}`,
                      color: isDark ? '#93c5fd' : '#1d4ed8',
                      boxShadow: isDark ? '0 2px 6px rgba(0,0,0,0.45)' : '0 1px 3px rgba(0,0,0,0.1)',
                      zIndex: 3,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    onClick={() => setSelectedNode('escalate')}
                  >
                    <ArrowCounterClockwise size={10} weight="bold" /> Одобрено (/approve) → Re-dispatch
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {/* JIRA WORKFLOW INSPECTOR / ПАНЕЛЬ СВОЙСТВ СТАТУСА И ПЕРЕХОДОВ */}
          {(() => {
            const activeStatus =
              jiraStatuses.find((s) => s.id === selectedNode || s.altId === selectedNode) ||
              (selectedNode === 'model'
                ? {
                    id: 'model' as CanvasNodeId,
                    name: 'Chat Model (DeepSeek / Kimi)',
                    category: 'inProgress' as const,
                    style: jira.inProgress,
                    role: 'dev · LLM',
                    tasksCount: 0,
                    badgeText: 'DeepSeek V3',
                    x: 0,
                    y: 0,
                    w: 0,
                    h: 0,
                    icon: <Cpu size={14} weight="bold" />,
                    description: 'Нейросетевая модель для генерации кода и архитектурных планов роли dev',
                  }
                : selectedNode === 'memory'
                ? {
                    id: 'memory' as CanvasNodeId,
                    name: 'Memory (memvault & graphify)',
                    category: 'archived' as const,
                    style: jira.archived,
                    role: 'reg · vault',
                    tasksCount: 0,
                    badgeText: 'Vault',
                    x: 0,
                    y: 0,
                    w: 0,
                    h: 0,
                    icon: <Brain size={14} weight="bold" />,
                    description: 'Хранилище долговременной памяти и граф взаимосвязей проекта',
                  }
                : selectedNode === 'tools'
                ? {
                    id: 'tools' as CanvasNodeId,
                    name: 'Tools (Worktree & agy)',
                    category: 'inReview' as const,
                    style: jira.inReview,
                    role: 'sre / dev',
                    tasksCount: 0,
                    badgeText: 'CLI / Git',
                    x: 0,
                    y: 0,
                    w: 0,
                    h: 0,
                    icon: <Wrench size={14} weight="bold" />,
                    description: 'Изолированные рабочие ветки worktree и системные утилиты dsh-agy',
                  }
                : jiraStatuses[2])
            const cat = activeStatus.style

            return (
              <div style={{ ...card, marginTop: 4 }}>
                {/* Шапка инспектора Jira */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        padding: '3px 8px',
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '0.5px',
                        textTransform: 'uppercase',
                        background: cat.lozengeBg,
                        color: cat.lozengeText,
                        border: `1px solid ${cat.lozengeBorder}`,
                      }}
                    >
                      {cat.label}
                    </span>
                    <div>
                      <strong style={{ fontSize: 15, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ display: 'inline-flex', flexShrink: 0, color: cat.accentColor || '#3b82f6' }}>
                          {activeStatus.icon}
                        </span>
                        <span>Статус: {activeStatus.name}</span>
                      </strong>
                      <span style={{ fontSize: 12, color: t.textSecondary }}>
                        {activeStatus.description}
                      </span>
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: t.textSecondary }}>
                    Роль: <strong style={{ color: t.textPrimary }}>{activeStatus.role}</strong>
                  </div>
                </div>

                {/* РАЗДЕЛ 1: ТАБЛИЦА ПЕРЕХОДОВ ИЗ ДАННОГО СТАТУСА (JIRA TRANSITIONS) */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textSecondary, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <GitFork size={14} /> Исходящие переходы из статуса «{activeStatus.name}»:
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {activeStatus.id === 'qa' || activeStatus.altId === 'router' ? (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <GitMerge size={14} weight="bold" /> PASS: Auto-Merge
                            </span>
                            <span style={{ fontSize: 12, color: t.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <ArrowRight size={12} /> Целевой статус:
                            </span>
                            <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: jira.done.lozengeBg, color: jira.done.lozengeText }}>DONE</span>
                          </div>
                          <span style={{ fontSize: 11, color: t.textSecondary }}>Условие: тесты пройдены & autoMergeOnQaPass</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: '#f59e0b', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <ArrowsClockwise size={14} weight="bold" /> FAIL: Retry QA
                            </span>
                            <span style={{ fontSize: 12, color: t.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <ArrowRight size={12} /> Целевой статус:
                            </span>
                            <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: jira.inProgress.lozengeBg, color: jira.inProgress.lozengeText }}>IN PROGRESS</span>
                          </div>
                          <span style={{ fontSize: 11, color: t.textSecondary }}>Условие: попытка &lt; maxQaRetries ({p.maxQaRetries}x)</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: '#ef4444', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <Warning size={14} weight="bold" /> FAIL: Escalate
                            </span>
                            <span style={{ fontSize: 12, color: t.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <ArrowRight size={12} /> Целевой статус:
                            </span>
                            <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: jira.escalated.lozengeBg, color: jira.escalated.lozengeText }}>ESCALATED</span>
                          </div>
                          <span style={{ fontSize: 11, color: t.textSecondary }}>Условие: попытки исчерпаны → @{p.qaEscalationTarget}</span>
                        </div>
                      </>
                    ) : activeStatus.id === 'dev' || activeStatus.altId === 'agent' ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: '#f59e0b', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <CheckCircle size={14} weight="bold" /> Submit QA
                          </span>
                          <span style={{ fontSize: 12, color: t.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <ArrowRight size={12} /> Целевой статус:
                          </span>
                          <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: jira.inReview.lozengeBg, color: jira.inReview.lozengeText }}>IN REVIEW</span>
                        </div>
                        <span style={{ fontSize: 11, color: t.textSecondary }}>Условие: наличие коммитов в worktree (requireDiffForQa) & autoHandoffDevToQa</span>
                      </div>
                    ) : activeStatus.id === 'backlog' || activeStatus.altId === 'trigger' ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: '#3b82f6', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Play size={14} weight="fill" /> Start Dev
                          </span>
                          <span style={{ fontSize: 12, color: t.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <ArrowRight size={12} /> Целевой статус:
                          </span>
                          <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: jira.inProgress.lozengeBg, color: jira.inProgress.lozengeText }}>IN PROGRESS</span>
                        </div>
                        <span style={{ fontSize: 11, color: t.textSecondary }}>Условие: наличие свободных слотов ({taskCounts.running}/{p.maxHeavyWorkers})</span>
                      </div>
                    ) : activeStatus.id === 'merge' ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: '#a855f7', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Archive size={14} weight="bold" /> Archive to Vault
                          </span>
                          <span style={{ fontSize: 12, color: t.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <ArrowRight size={12} /> Целевой статус:
                          </span>
                          <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: jira.archived.lozengeBg, color: jira.archived.lozengeText }}>ARCHIVED</span>
                        </div>
                        <span style={{ fontSize: 11, color: t.textSecondary }}>Пост-функция: сохранение отчёта & запуск Регистратора (reg)</span>
                      </div>
                    ) : activeStatus.id === 'retry' ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: '#f59e0b', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <ArrowCounterClockwise size={14} weight="bold" /> ↺ Loopback to Dev
                          </span>
                          <span style={{ fontSize: 12, color: t.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <ArrowRight size={12} /> Целевой статус:
                          </span>
                          <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: jira.inProgress.lozengeBg, color: jira.inProgress.lozengeText }}>IN PROGRESS</span>
                        </div>
                        <span style={{ fontSize: 11, color: t.textSecondary }}>Условие: попытка &lt; maxQaRetries ({p.maxQaRetries}x) — передача логов ошибок</span>
                      </div>
                    ) : activeStatus.id === 'escalate' ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: '#3b82f6', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <ArrowCounterClockwise size={14} weight="bold" /> Re-dispatch to Dev
                          </span>
                          <span style={{ fontSize: 12, color: t.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <ArrowRight size={12} /> Целевой статус:
                          </span>
                          <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: jira.inProgress.lozengeBg, color: jira.inProgress.lozengeText }}>IN PROGRESS</span>
                        </div>
                        <span style={{ fontSize: 11, color: t.textSecondary }}>По решению @{p.qaEscalationTarget} (ручной аппрув / перепланирование)</span>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: '#a855f7', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Target size={14} weight="bold" /> Complete Cycle
                          </span>
                          <span style={{ fontSize: 12, color: t.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <ArrowRight size={12} /> База знаний:
                          </span>
                          <span style={{ padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: jira.done.lozengeBg, color: jira.done.lozengeText }}>MEMVAULT</span>
                        </div>
                        <span style={{ fontSize: 11, color: t.textSecondary }}>Пост-функция: извлечение уроков и пуш в GitHub memvault</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* РАЗДЕЛ 2: БЫСТРОЕ УПРАВЛЕНИЕ УСЛОВИЯМИ СТАТУСА (JIRA CONDITIONS & POST-FUNCTIONS) */}
                <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textSecondary, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Sliders size={14} /> Условия переходов и правила конвейера для «{activeStatus.name}»:
                </div>

                {/* 0. Контролы для Retry Branch */}
                {activeStatus.id === 'retry' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'block', fontWeight: 600, fontSize: 13, color: t.textPrimary, marginBottom: 6 }}>
                        Лимит попыток ретрая QA (maxQaRetries): {p.maxQaRetries}
                      </label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {[1, 2, 3, 5].map((num) => (
                          <button
                            key={num}
                            type="button"
                            style={{
                              ...btn,
                              padding: '4px 12px',
                              background: p.maxQaRetries === num ? (isDark ? '#3b82f6' : '#2563eb') : t.btnBg,
                              color: p.maxQaRetries === num ? '#ffffff' : t.btnText,
                              fontWeight: p.maxQaRetries === num ? 700 : 500,
                            }}
                            onClick={() => updatePipeline('maxQaRetries', num)}
                          >
                            {num} {num === 1 ? 'раз' : num < 5 ? 'раза' : 'раз'}
                          </button>
                        ))}
                      </div>
                      <p style={{ margin: '8px 0 0', fontSize: 11, color: t.textSecondary }}>
                        При провале тестов задача возвращается агенту Dev с логами ошибок до исчерпания лимита.
                      </p>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'block', fontWeight: 600, fontSize: 13, color: t.textPrimary, marginBottom: 6 }}>
                        Куда эскалировать при исчерпании лимита:
                      </label>
                      <select
                        style={{ ...select, width: '100%' }}
                        value={p.qaEscalationTarget}
                        onChange={(e) => updatePipeline('qaEscalationTarget', e.target.value as any)}
                      >
                        <option value="arch">arch — Архитектор (декомпозиция / корректировка)</option>
                        <option value="slava">slava — Славе в Clarify (ручной выбор решения)</option>
                        <option value="failed">failed — Сразу перевести в статус Ошибка</option>
                      </select>
                    </div>
                  </div>
                )}

                {/* 1. Контролы для QA Verification */}
                {(activeStatus.id === 'qa' || activeStatus.altId === 'router') && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.autoMergeOnQaPass}
                          onChange={(e) => updatePipeline('autoMergeOnQaPass', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        Авто-слияние при QA PASS (autoMergeOnQaPass)
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        При успехе тестов автоматически захватывает merge.lock и вливает worktree в main. Если выключено — требует ручной аппрув Славы.
                      </p>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'block', fontWeight: 600, fontSize: 13, color: t.textPrimary, marginBottom: 6 }}>
                        Лимит попыток ретрая QA (maxQaRetries): {p.maxQaRetries}
                      </label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {[1, 2, 3, 5].map((num) => (
                          <button
                            key={num}
                            type="button"
                            style={{
                              ...btn,
                              padding: '4px 12px',
                              background: p.maxQaRetries === num ? (isDark ? '#3b82f6' : '#2563eb') : t.btnBg,
                              color: p.maxQaRetries === num ? '#ffffff' : t.btnText,
                              fontWeight: p.maxQaRetries === num ? 700 : 500,
                            }}
                            onClick={() => updatePipeline('maxQaRetries', num)}
                          >
                            {num} {num === 1 ? 'раз' : num < 5 ? 'раза' : 'раз'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'block', fontWeight: 600, fontSize: 13, color: t.textPrimary, marginBottom: 6 }}>
                        Куда эскалировать при исчерпании попыток QA (qaEscalationTarget):
                      </label>
                      <select
                        style={{ ...select, width: '100%' }}
                        value={p.qaEscalationTarget}
                        onChange={(e) => updatePipeline('qaEscalationTarget', e.target.value as any)}
                      >
                        <option value="arch">arch — Архитектор (декомпозиция / корректировка)</option>
                        <option value="slava">slava — Славе в Clarify (ручной выбор решения)</option>
                        <option value="failed">failed — Сразу перевести в статус Ошибка</option>
                      </select>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.escalationNotifyTelegram}
                          onChange={(e) => updatePipeline('escalationNotifyTelegram', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        <PaperPlaneTilt size={14} /> Оповещать в Telegram при эскалации
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        Штурман пришлёт сообщение в Telegram с карточкой задачи и причиной эскалации.
                      </p>
                    </div>
                  </div>
                )}

                {/* 2. Контролы для In Development */}
                {(activeStatus.id === 'dev' || activeStatus.altId === 'agent') && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.autoHandoffDevToQa}
                          onChange={(e) => updatePipeline('autoHandoffDevToQa', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        Авто-передача Dev → QA (autoHandoffDevToQa)
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        Сразу после выхода Dev задача автоматически переходит в QA без ручного перекладывания на Канбане.
                      </p>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.requireDiffForQa}
                          onChange={(e) => updatePipeline('requireDiffForQa', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        Требовать Git Diff для QA (requireDiffForQa)
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        QA не начнёт проверку, если в worktree нет изменённых файлов.
                      </p>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'block', fontWeight: 600, fontSize: 13, color: t.textPrimary, marginBottom: 6 }}>
                        Квота тяжёлых воркеров (maxHeavyWorkers): {p.maxHeavyWorkers}
                      </label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {[1, 2, 3, 4, 6].map((num) => (
                          <button
                            key={num}
                            type="button"
                            style={{
                              ...btn,
                              padding: '4px 12px',
                              background: p.maxHeavyWorkers === num ? (isDark ? '#3b82f6' : '#2563eb') : t.btnBg,
                              color: p.maxHeavyWorkers === num ? '#ffffff' : t.btnText,
                              fontWeight: p.maxHeavyWorkers === num ? 700 : 500,
                            }}
                            onClick={() => updatePipeline('maxHeavyWorkers', num)}
                          >
                            {num} {num === 1 ? 'слот' : num < 5 ? 'слота' : 'слотов'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.requireSreApproval}
                          onChange={(e) => updatePipeline('requireSreApproval', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        <ShieldCheck size={14} /> Ручной аппрув для SRE (requireSreApproval)
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        Операции SRE под host.lock с ansible или системными командами требуют одобрения Славы.
                      </p>
                    </div>
                  </div>
                )}

                {/* 3. Контролы для Backlog & To Do */}
                {(activeStatus.id === 'backlog' || activeStatus.altId === 'trigger') && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'block', fontWeight: 600, fontSize: 13, color: t.textPrimary, marginBottom: 6 }}>
                        Лимит параллельных воркеров (maxHeavyWorkers): {p.maxHeavyWorkers}
                      </label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {[1, 2, 3, 4, 6].map((num) => (
                          <button
                            key={num}
                            type="button"
                            style={{
                              ...btn,
                              padding: '4px 12px',
                              background: p.maxHeavyWorkers === num ? (isDark ? '#3b82f6' : '#2563eb') : t.btnBg,
                              color: p.maxHeavyWorkers === num ? '#ffffff' : t.btnText,
                              fontWeight: p.maxHeavyWorkers === num ? 700 : 500,
                            }}
                            onClick={() => updatePipeline('maxHeavyWorkers', num)}
                          >
                            {num} {num === 1 ? 'слот' : num < 5 ? 'слота' : 'слотов'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.parentAutoRollup}
                          onChange={(e) => updatePipeline('parentAutoRollup', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        <Target size={14} /> Авто-закрытие родительского эпика (parentAutoRollup)
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        Когда все подзадачи с dependsOn закрываются, родительская задача автоматически переходит в Done.
                      </p>
                    </div>
                  </div>
                )}

                {/* 4. Контролы для Merged & Done */}
                {activeStatus.id === 'merge' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.exportReportToVault}
                          onChange={(e) => updatePipeline('exportReportToVault', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        <Archive size={14} /> Экспорт отчёта в vault/tasks/done/
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        При закрытии задачи сохраняет TASK-&lt;id&gt;.md с итогом, диффом и уроками.
                      </p>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.autoRunRegArchivist}
                          onChange={(e) => updatePipeline('autoRunRegArchivist', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        <ArrowsClockwise size={14} /> Авто-запуск Регистратора (reg)
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        Роль reg извлекает уроки, обновляет граф graphify и пушит в memvault.
                      </p>
                    </div>
                  </div>
                )}

                {/* 5. Контролы для Escalated (Clarify) */}
                {activeStatus.id === 'escalate' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'block', fontWeight: 600, fontSize: 13, color: t.textPrimary, marginBottom: 6 }}>
                        Куда направлять эскалированные задачи (qaEscalationTarget):
                      </label>
                      <select
                        style={{ ...select, width: '100%' }}
                        value={p.qaEscalationTarget}
                        onChange={(e) => updatePipeline('qaEscalationTarget', e.target.value as any)}
                      >
                        <option value="arch">arch — Архитектор (перепланирование)</option>
                        <option value="slava">slava — Славе в Clarify</option>
                        <option value="failed">failed — Прекратить выполнение</option>
                      </select>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.escalationNotifyTelegram}
                          onChange={(e) => updatePipeline('escalationNotifyTelegram', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        <PaperPlaneTilt size={14} /> Telegram-уведомление Штурману
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        Оповещение в личный чат Telegram при превышении порога ретраев.
                      </p>
                    </div>
                  </div>
                )}

                {/* 6. Контролы для Vault Archivist */}
                {activeStatus.id === 'reg' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.exportReportToVault}
                          onChange={(e) => updatePipeline('exportReportToVault', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        <Archive size={14} /> Экспорт отчёта в постоянную память
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        TASK-&lt;id&gt;.md сохраняется в директорию vault/tasks/done/.
                      </p>
                    </div>

                    <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: t.textPrimary }}>
                        <input
                          type="checkbox"
                          checked={p.autoRunRegArchivist}
                          onChange={(e) => updatePipeline('autoRunRegArchivist', e.target.checked)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                        <TreeStructure size={14} /> Автоматическая фиксация графа знаний (graphify)
                      </label>
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: t.textSecondary }}>
                        Извлечение архитектурных уроков и коммит в репозиторий memvault.
                      </p>
                    </div>
                  </div>
                )}

                {/* 7. Контролы для компонентов (Model / Memory / Tools) */}
                {(selectedNode === 'model' || selectedNode === 'memory' || selectedNode === 'tools') && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                    <div style={{ padding: 12, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                      <strong style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: t.textPrimary, marginBottom: 6 }}>
                        {selectedNode === 'model' ? (
                          <><Cpu size={14} weight="bold" /> Нейросетевая модель (Chat Model)</>
                        ) : selectedNode === 'memory' ? (
                          <><Brain size={14} weight="bold" /> Долговременная память (memvault & graphify)</>
                        ) : (
                          <><Wrench size={14} weight="bold" /> Рабочие инструменты (dsh-agy & worktree)</>
                        )}
                      </strong>
                      <p style={{ margin: '0 0 10px', fontSize: 12, color: t.textSecondary, lineHeight: 1.4 }}>
                        {selectedNode === 'model'
                          ? 'Инференс DeepSeek V3 / Kimi для автономного написания кода, архитектурного анализа и рефакторинга.'
                          : selectedNode === 'memory'
                          ? 'Архив задач, база знаний в Markdown и граф зависимостей graphify с уроками.'
                          : 'Изолированное рабочее окружение git worktree с запуском тестов, линтеров и интеграцией agy.'}
                      </p>
                      <button
                        type="button"
                        style={{ ...btn, padding: '4px 10px', fontSize: 11 }}
                        onClick={() => setSelectedNode('dev')}
                      >
                        ← Вернуться к статусу In Development
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      ) : activeTab === 'pipeline' ? (
        /* 2. ПОЛНАЯ ТАБЛИЦА ВСЕХ ПАРАМЕТРОВ КОНВЕЙЕРА */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={card}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Code size={16} /> 1. Разработка и передача в тестирование (Dev & QA Handoff)
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, color: t.textPrimary }}>
                  <input
                    type="checkbox"
                    checked={p.autoHandoffDevToQa}
                    onChange={(e) => updatePipeline('autoHandoffDevToQa', e.target.checked)}
                  />
                  autoHandoffDevToQa (Авто-передача Dev → QA)
                </label>
                <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
                  После успешного коммита роли dev карточка сразу переводится на роль qa в том же git_worktree.
                </div>
              </div>

              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, color: t.textPrimary }}>
                  <input
                    type="checkbox"
                    checked={p.requireDiffForQa}
                    onChange={(e) => updatePipeline('requireDiffForQa', e.target.checked)}
                  />
                  requireDiffForQa (Требовать дифф)
                </label>
                <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
                  Не запускать QA, если в worktree не было фактических правок кода.
                </div>
              </div>
            </div>
          </div>

          <div style={card}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle size={16} /> 2. Контроль качества, слияние и эскалация (QA, Merge & Retries)
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, color: t.textPrimary }}>
                  <input
                    type="checkbox"
                    checked={p.autoMergeOnQaPass}
                    onChange={(e) => updatePipeline('autoMergeOnQaPass', e.target.checked)}
                  />
                  autoMergeOnQaPass (Авто-слияние при PASS)
                </label>
                <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
                  При вердикте pass захватывает merge.lock и делает rebase/merge в основную ветку.
                </div>
              </div>

              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'block', fontWeight: 600, color: t.textPrimary, marginBottom: 4 }}>
                  maxQaRetries (Максимум циклов правок): {p.maxQaRetries}
                </label>
                <select
                  style={{ ...select, width: '100%' }}
                  value={p.maxQaRetries}
                  onChange={(e) => updatePipeline('maxQaRetries', Number(e.target.value))}
                >
                  <option value={1}>1 попытка (сразу эскалировать при первой ошибке)</option>
                  <option value={2}>2 попытки (стандарт: 1 ретрай для исправления dev)</option>
                  <option value={3}>3 попытки (до 2 ретраев)</option>
                  <option value={5}>5 попыток (максимальная автономность)</option>
                </select>
              </div>

              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'block', fontWeight: 600, color: t.textPrimary, marginBottom: 4 }}>
                  qaEscalationTarget (Точка эскалации):
                </label>
                <select
                  style={{ ...select, width: '100%' }}
                  value={p.qaEscalationTarget}
                  onChange={(e) => updatePipeline('qaEscalationTarget', e.target.value as any)}
                >
                  <option value="arch">arch — Архитектор (перепланирование)</option>
                  <option value="slava">slava — Славе в Clarify</option>
                  <option value="failed">failed — Прекратить выполнение</option>
                </select>
              </div>

              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, color: t.textPrimary }}>
                  <input
                    type="checkbox"
                    checked={p.escalationNotifyTelegram}
                    onChange={(e) => updatePipeline('escalationNotifyTelegram', e.target.checked)}
                  />
                  escalationNotifyTelegram (Алерт в Telegram)
                </label>
                <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
                  Мгновенное уведомление в Telegram-бот Штурману при тупике dev &lt;-&gt; qa.
                </div>
              </div>

              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'block', fontWeight: 600, color: t.textPrimary, marginBottom: 4 }}>
                  conflictFallback (При конфликте Git Merge):
                </label>
                <select
                  style={{ ...select, width: '100%' }}
                  value={p.conflictFallback}
                  onChange={(e) => updatePipeline('conflictFallback', e.target.value as any)}
                >
                  <option value="dev">dev — Вернуть разработчику для rebase</option>
                  <option value="arch">arch — Эскалировать архитектору</option>
                </select>
              </div>
            </div>
          </div>

          <div style={card}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Wrench size={16} /> 3. Инфраструктура и эксклюзивные блокировки хоста (SRE & host.lock)
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, color: t.textPrimary }}>
                  <input
                    type="checkbox"
                    checked={p.requireSreApproval}
                    onChange={(e) => updatePipeline('requireSreApproval', e.target.checked)}
                  />
                  requireSreApproval (Аппрув на действия SRE)
                </label>
                <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
                  Опасные операции с флагом sudo и ansible требуют подтверждения в веб-интерфейсе или Telegram.
                </div>
              </div>

              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, color: t.textPrimary }}>
                  <input
                    type="checkbox"
                    checked={p.autoReleaseHostLock}
                    onChange={(e) => updatePipeline('autoReleaseHostLock', e.target.checked)}
                  />
                  autoReleaseHostLock (Авто-снятие host.lock)
                </label>
                <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
                  Снимать блокировку хоста сразу по выходу сессии SRE (даже при падении процесса).
                </div>
              </div>
            </div>
          </div>

          <div style={card}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Archive size={16} /> 4. Завершение, База знаний и Граф (Vault & Archivist)
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, color: t.textPrimary }}>
                  <input
                    type="checkbox"
                    checked={p.parentAutoRollup}
                    onChange={(e) => updatePipeline('parentAutoRollup', e.target.checked)}
                  />
                  parentAutoRollup (Авто-закрытие эпиков)
                </label>
                <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
                  Автоматически завершать родительскую задачу, когда все подзадачи с dependsOn перешли в Done.
                </div>
              </div>

              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, color: t.textPrimary }}>
                  <input
                    type="checkbox"
                    checked={p.exportReportToVault}
                    onChange={(e) => updatePipeline('exportReportToVault', e.target.checked)}
                  />
                  exportReportToVault (Отчёт в vault/tasks/done/)
                </label>
                <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
                  Сохранение Markdown отчёта выполненной задачи в постоянную память.
                </div>
              </div>

              <div style={{ padding: 10, borderRadius: 8, background: t.btnBg, border: `1px solid ${t.cardBorder}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, color: t.textPrimary }}>
                  <input
                    type="checkbox"
                    checked={p.autoRunRegArchivist}
                    onChange={(e) => updatePipeline('autoRunRegArchivist', e.target.checked)}
                  />
                  autoRunRegArchivist (Фоновый запуск Регистратора)
                </label>
                <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
                  Запуск роли reg для извлечения уроков, сборки graphify и отправки в GitHub по токену из KDE Wallet.
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* 3. МАТРИЦА ПЕРЕХОДОВ ДЛЯ ВСЕХ РОЛЕЙ */
        <div style={card}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Users size={16} /> Матрица маршрутизации и условий по ролям
          </h3>
          <p style={{ margin: '0 0 16px', fontSize: 12, color: t.textSecondary }}>
            Определяет, куда направляется задача после завершения сессии соответствующего агента.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Object.entries(rules.roleTransitions).map(([rId, rule]) => {
              const roleMeta = rolesList.find((r) => r.id === rId)
              const rawTitle = rule.label || roleMeta?.name || rId
              const title = stripEmoji(rawTitle)

              return (
                <div
                  key={rId}
                  style={{
                    padding: 14,
                    borderRadius: 8,
                    background: t.btnBg,
                    border: `1px solid ${t.cardBorder}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ display: 'inline-flex', color: '#3b82f6', flexShrink: 0 }}>
                        {getRoleIcon(rId, 16)}
                      </span>
                      <strong style={{ fontSize: 14, color: t.textPrimary }}>{title}</strong>
                      <code style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: t.cardBg, border: `1px solid ${t.cardBorder}` }}>
                        {rId}
                      </code>
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: t.textSecondary }}>Изоляция:</span>
                      <select
                        style={{ ...select, padding: '4px 8px', fontSize: 12 }}
                        value={rule.isolationMode}
                        onChange={(e) => updateRoleTransition(rId, { isolationMode: e.target.value })}
                      >
                        <option value="none">none (Без изоляции)</option>
                        <option value="git_worktree">git_worktree (Ветка задачи)</option>
                        <option value="host_exclusive">host_exclusive (host.lock)</option>
                        <option value="notes_vault">notes_vault (vault/)</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, fontSize: 12 }}>
                    <div>
                      <span style={{ display: 'block', color: t.textSecondary, marginBottom: 4 }}>При успехе (onSuccess):</span>
                      <select
                        style={{ ...select, width: '100%', fontSize: 12 }}
                        value={rule.onSuccess}
                        onChange={(e) => updateRoleTransition(rId, { onSuccess: e.target.value })}
                      >
                        <option value="qa">Передать в QA</option>
                        <option value="merge_and_done">Merge и закрыть (Done)</option>
                        <option value="done">Сразу закрыть (Done)</option>
                        <option value="arch">Направить Архитектору</option>
                        <option value="clarify">Отправить на аппрув Славы</option>
                      </select>
                    </div>

                    <div>
                      <span style={{ display: 'block', color: t.textSecondary, marginBottom: 4 }}>При ошибке (onFailure):</span>
                      <select
                        style={{ ...select, width: '100%', fontSize: 12 }}
                        value={rule.onFailure}
                        onChange={(e) => updateRoleTransition(rId, { onFailure: e.target.value })}
                      >
                        <option value="failed">Статус Ошибка (Failed)</option>
                        <option value="dev_or_escalate">Вернуть в Dev или эскалировать</option>
                        <option value="clarify">Отправить в Clarify (@slava)</option>
                        <option value="arch">Эскалировать Архитектору</option>
                      </select>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: t.textPrimary, fontWeight: 500 }}>
                        <input
                          type="checkbox"
                          checked={rule.requireApproval}
                          onChange={(e) => updateRoleTransition(rId, { requireApproval: e.target.checked })}
                        />
                        Требовать обязательный аппрув Славы
                      </label>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
