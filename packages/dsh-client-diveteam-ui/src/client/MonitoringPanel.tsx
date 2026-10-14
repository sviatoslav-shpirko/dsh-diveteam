/**
 * Dispatcher Control Center:
 * 1. Pipeline & Quota Control Center (pause/resume queue, processQueue now, Startup Janitor, Stop-Kran, live limits)
 * 2. Worker Slots (1..maxHeavyWorkers + light workers) & Queue/Dependency Inspector (dependsOn, parentId, waitingReason, force start)
 * 3. Isolation Manager (merge.lock, host.lock, active git worktrees with manual merge & delete)
 * 4. Live Dispatcher Event Log (chronological ring buffer of dispatcher decisions)
 */
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  Sliders,
  GitFork,
  Warning,
  WarningOctagon,
  CheckCircle,
  Play,
  Pause,
  ArrowsClockwise,
  Broom,
  Stop,
  FloppyDisk,
  Cpu,
  Circle,
  Lightning,
  MagnifyingGlass,
  Link,
  ShieldCheck,
  Lock,
  LockOpen,
  GitBranch,
  GitMerge,
  Trash,
  Scroll,
} from '@phosphor-icons/react'
import { stripEmoji } from './AgentsPanel.tsx'
import { WorkflowPanel } from './WorkflowPanel.tsx'
import { useIsDarkTheme } from './theme.ts'

interface ActiveRunInfo {
  sessionId: string
  taskId: string
  taskTitle: string
  role: string
  isolationMode?: string
  isHeavy: boolean
  worktreePath: string | null
  repoPath?: string | null
  branchName: string | null
  startedAt: string
  elapsedSec: number
}

interface DependencyStateInfo {
  id: string
  title: string
  status: string
  phase: string | null
}

interface TodoDiagnosticItem {
  id: string
  title: string
  role: string
  status: string
  phase: string
  isolationMode: string
  parentId: string | null
  parentTitle: string | null
  dependsOn: string[]
  dependencyStates: DependencyStateInfo[]
  canStart: boolean
  reasonCode: string
  waitingReason: string
}

interface WorktreeItem {
  worktreePath: string
  repoSlug: string
  repoPath: string | null
  branchName: string
  baseBranch: string
  dirty: boolean
  dirtyFilesCount: number
  taskId: string
  taskTitle: string | null
  taskStatus: string | null
  taskRole: string | null
}

interface DispatcherEventItem {
  id: string
  at: string
  kind: string
  taskId: string | null
  role: string | null
  message: string
}

interface MonitoringSnapshot {
  queuePaused: boolean
  circuitBreakerTripped: boolean
  activeHeavyWorkers: number
  maxHeavyWorkers: number
  activeRuns: ActiveRunInfo[]
  queueCounts: {
    backlog: number
    todo: number
    running: number
    done: number
    failed: number
    clarify: number
  }
  todoDiagnostics: TodoDiagnosticItem[]
  worktrees: WorktreeItem[]
  mergeLock: {
    busy: boolean
    pendingCount: number
  }
  hostLock: {
    locked: boolean
    owner: { pid?: number; taskId?: string; acquiredAt?: string } | null
    lockFilePath: string
  }
  tokens: {
    dailyTokensUsed: number
    maxDailyTokens: number
    dailyKey: string
  }
  dispatcherEvents: DispatcherEventItem[]
}

const cardStyle: CSSProperties = {
  padding: 14,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3))',
  background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
}

const buttonStyle: CSSProperties = {
  padding: '6px 14px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
  fontWeight: 500,
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.35))',
  background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
  transition: 'all 0.15s ease',
}

const inputStyle: CSSProperties = {
  padding: '6px 10px',
  font: 'inherit',
  fontSize: 13,
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.35))',
  background: 'var(--dsw-alias-bg-base, rgba(127,127,127,0.08))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  outline: 'none',
}

async function api(path: string, init?: RequestInit): Promise<any> {
  let res = await fetch(path, init)
  if (res.status === 404 && path.startsWith('/diveteam/')) {
    const fallbackRes = await fetch(path.replace('/diveteam/', '/farvater/'), init)
    if (fallbackRes.ok) res = fallbackRes
  }
  if (!res.ok) {
    let errText = `HTTP ${res.status}`
    try {
      const errJson = (await res.json()) as { error?: string }
      if (errJson?.error) errText = errJson.error
    } catch { /* ignore */ }
    throw new Error(errText)
  }
  const data = (await res.json()) as { ok?: boolean; error?: string }
  if (!data.ok) throw new Error(data.error ?? 'request failed')
  return data
}

export function MonitoringPanel(): ReactElement {
  const isDark = useIsDarkTheme()
  const [subTab, setSubTab] = useState<'control' | 'workflow'>('control')
  const [snap, setSnap] = useState<MonitoringSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<boolean>(false)
  const [workersInput, setWorkersInput] = useState<string>('')
  const [tokensInput, setTokensInput] = useState<string>('')
  const [limitsDirty, setLimitsDirty] = useState<boolean>(false)

  const load = useCallback(async () => {
    try {
      const data = (await api('/diveteam/monitoring')) as MonitoringSnapshot
      setSnap(data)
      if (!limitsDirty) {
        setWorkersInput(String(data.maxHeavyWorkers))
        setTokensInput(String(data.tokens.maxDailyTokens))
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [limitsDirty])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 3000)
    return () => clearInterval(timer)
  }, [load])

  const doAction = async (payload: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      const data = (await api('/diveteam/monitoring', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })) as MonitoringSnapshot
      setSnap(data)
      if (payload.action === 'update_limits') {
        setWorkersInput(String(data.maxHeavyWorkers))
        setTokensInput(String(data.tokens.maxDailyTokens))
        setLimitsDirty(false)
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!snap) {
    return <p style={{ opacity: 0.7 }}>{error ?? 'Загрузка состояния Диспетчера…'}</p>
  }

  const tokenPct = Math.min(100, Math.round((snap.tokens.dailyTokensUsed / Math.max(1, snap.tokens.maxDailyTokens)) * 100))
  const heavyRuns = snap.activeRuns.filter((r) => r.isHeavy)
  const lightRuns = snap.activeRuns.filter((r) => !r.isHeavy)
  const slotCount = Math.max(1, snap.maxHeavyWorkers, heavyRuns.length)
  const slots = Array.from({ length: slotCount }, (_, idx) => heavyRuns[idx] ?? null)
  const todoDiag = snap.todoDiagnostics ?? []
  const worktrees = snap.worktrees ?? []
  const events = snap.dispatcherEvents ?? []

  return (
    <div style={{ height: '100%', overflowY: 'auto', paddingRight: 8, paddingBottom: 28 }}>
      {/* Переключатель разделов Диспетчера */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}`, paddingBottom: 10 }}>
        <button
          type="button"
          onClick={() => setSubTab('control')}
          style={{
            ...buttonStyle,
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: subTab === 'control' ? 700 : 500,
            background: subTab === 'control' ? (isDark ? 'rgba(59,130,246,0.22)' : 'rgba(59,130,246,0.1)') : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
            borderColor: subTab === 'control' ? '#3b82f6' : 'var(--dsw-alias-border-l3, rgba(127,127,127,0.3))',
            color: subTab === 'control' ? (isDark ? '#ffffff' : '#1d4ed8') : 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Sliders size={15} /> Пульт управления & Слоты
        </button>
        <button
          type="button"
          onClick={() => setSubTab('workflow')}
          style={{
            ...buttonStyle,
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: subTab === 'workflow' ? 700 : 500,
            background: subTab === 'workflow' ? (isDark ? 'rgba(59,130,246,0.22)' : 'rgba(59,130,246,0.1)') : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
            borderColor: subTab === 'workflow' ? '#3b82f6' : 'var(--dsw-alias-border-l3, rgba(127,127,127,0.3))',
            color: subTab === 'workflow' ? (isDark ? '#ffffff' : '#1d4ed8') : 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <GitFork size={15} /> Схема воркфлоу & Условия
        </button>
      </div>

      {subTab === 'workflow' ? (
        <WorkflowPanel embedded={true} />
      ) : (
        <>
          {error ? (
            <div
              role="alert"
              style={{
                color: '#b71c1c',
                padding: '8px 12px',
                borderRadius: 6,
                background: 'rgba(183,28,28,0.08)',
                border: '1px solid rgba(183,28,28,0.3)',
                marginBottom: 12,
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Warning size={15} /> {error}
            </div>
          ) : null}

          {/* БЛОК 1: Пульт управления конвейером и квотами */}
          <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sliders size={16} /> 1. Пульт управления конвейером и квотами
            </h3>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
              Состояние планировщика:{' '}
              {snap.circuitBreakerTripped ? (
                <strong style={{ color: '#c62828', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <WarningOctagon size={14} weight="fill" /> Аварийный Стоп-кран (все сессии остановлены)
                </strong>
              ) : snap.queuePaused ? (
                <strong style={{ color: '#ef6c00', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Pause size={14} weight="fill" /> Очередь на паузе (новые задачи не берутся)
                </strong>
              ) : (
                <strong style={{ color: '#2e7d32', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Circle size={10} weight="fill" color="#22c55e" /> Активен (авто-диспетчеризация каждые 3 сек)
                </strong>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {snap.queuePaused ? (
              <button
                type="button"
                style={{ ...buttonStyle, borderColor: 'rgba(46,125,50,0.5)', background: 'rgba(46,125,50,0.08)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => void doAction({ action: 'resume_queue' })}
                disabled={busy}
              >
                <Play size={14} weight="fill" /> Запустить очередь
              </button>
            ) : (
              <button
                type="button"
                style={{ ...buttonStyle, borderColor: 'rgba(239,108,0,0.45)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => void doAction({ action: 'pause_queue' })}
                disabled={busy}
              >
                <Pause size={14} weight="fill" /> Пауза очереди
              </button>
            )}
            <button
              type="button"
              style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => void doAction({ action: 'process_queue_now' })}
              disabled={busy}
            >
              <ArrowsClockwise size={14} /> Проверить очередь сейчас
            </button>
            <button
              type="button"
              style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => void doAction({ action: 'run_janitor' })}
              disabled={busy}
              title="Вернуть зависшие задачи из Running в To Do и проверить блокировки"
            >
              <Broom size={14} /> Startup Janitor
            </button>
            {snap.circuitBreakerTripped ? (
              <button
                type="button"
                style={{ ...buttonStyle, borderColor: 'rgba(46,125,50,0.5)', color: '#2e7d32', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => void doAction({ action: 'reset_breaker' })}
                disabled={busy}
              >
                <Play size={14} weight="fill" /> Сбросить Стоп-кран
              </button>
            ) : (
              <button
                type="button"
                style={{ ...buttonStyle, borderColor: 'rgba(198,40,40,0.45)', color: '#c62828', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => void doAction({ action: 'trip_breaker' })}
                disabled={busy}
              >
                <Stop size={14} weight="fill" /> Аварийный Стоп-кран
              </button>
            )}
          </div>
        </div>

        {/* Сводка по колонкам и редактирование квот */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 12,
            paddingTop: 10,
            borderTop: '1px solid rgba(0,0,0,0.08)',
          }}
        >
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Распределение задач по колонкам</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12 }}>
              <span>Бэклог: <strong>{snap.queueCounts.backlog}</strong></span>
              <span>Уточнение: <strong>{snap.queueCounts.clarify}</strong></span>
              <span>К выполнению: <strong>{snap.queueCounts.todo}</strong></span>
              <span>В работе: <strong>{snap.queueCounts.running}</strong></span>
              <span>Готово: <strong>{snap.queueCounts.done}</strong></span>
              <span>Ошибка: <strong>{snap.queueCounts.failed}</strong></span>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
              Квота тяжёлых воркеров (<code>maxHeavyWorkers</code>) и лимит токенов ({snap.tokens.dailyKey})
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12 }}>
                Слоты:{' '}
                <input
                  type="number"
                  min={1}
                  max={16}
                  style={{ ...inputStyle, width: 58 }}
                  value={workersInput}
                  onChange={(e) => {
                    setWorkersInput(e.target.value)
                    setLimitsDirty(true)
                  }}
                />
              </label>
              <label style={{ fontSize: 12 }}>
                Токены/день:{' '}
                <input
                  type="number"
                  min={1000}
                  step={100000}
                  style={{ ...inputStyle, width: 110 }}
                  value={tokensInput}
                  onChange={(e) => {
                    setTokensInput(e.target.value)
                    setLimitsDirty(true)
                  }}
                />
              </label>
              <button
                type="button"
                style={{ ...buttonStyle, padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                onClick={() =>
                  void doAction({
                    action: 'update_limits',
                    maxHeavyWorkers: Number(workersInput),
                    maxDailyTokens: Number(tokensInput),
                  })
                }
                disabled={busy}
              >
                <FloppyDisk size={14} weight="bold" /> Применить
              </button>
            </div>
            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 6 }}>
              Израсходовано сегодня: <strong>{snap.tokens.dailyTokensUsed.toLocaleString()}</strong> /{' '}
              {snap.tokens.maxDailyTokens.toLocaleString()} ({tokenPct}%)
            </div>
            <div style={{ height: 5, borderRadius: 3, background: 'rgba(0,0,0,0.1)', overflow: 'hidden', marginTop: 4 }}>
              <div
                style={{
                  width: `${tokenPct}%`,
                  height: '100%',
                  background: tokenPct > 85 ? '#d93025' : '#1a73e8',
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* БЛОК 2: Слоты воркеров и Инспектор очереди / зависимостей */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Cpu size={16} /> 2. Слоты воркеров ({snap.activeHeavyWorkers}/{snap.maxHeavyWorkers}) и Инспектор очереди / зависимостей
        </h3>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 10,
            marginBottom: lightRuns.length > 0 ? 10 : 14,
          }}
        >
          {slots.map((run, idx) => (
            <div
              key={run ? run.sessionId : `empty-slot-${idx}`}
              style={{
                padding: 10,
                borderRadius: 8,
                border: run ? '1px solid #3b82f6' : `1px dashed ${isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)'}`,
                background: run ? (isDark ? 'rgba(59,130,246,0.15)' : 'rgba(26,115,232,0.05)') : (isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.01)'),
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 6,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, opacity: 0.75 }}>
                <strong>Слот #{idx + 1} (Тяжёлый воркер)</strong>
                <span>{run ? `${run.elapsedSec} сек` : 'Свободен'}</span>
              </div>
              {run ? (
                <>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    [{run.role.toUpperCase()}] {run.taskTitle}{' '}
                    <code style={{ fontSize: 11, opacity: 0.7 }}>#{run.taskId.slice(0, 8)}</code>
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.75 }}>
                    Изоляция: <code>{run.isolationMode || 'git_worktree'}</code>
                    {run.branchName ? ` · ветка ${run.branchName}` : ''}
                  </div>
                  <div>
                    <button
                      type="button"
                      style={{ ...buttonStyle, padding: '3px 8px', fontSize: 11, borderColor: 'rgba(198,40,40,0.4)', color: '#c62828', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      onClick={() => void doAction({ action: 'cancel_run', sessionId: run.sessionId })}
                      disabled={busy}
                    >
                      <Stop size={12} weight="fill" /> Прервать сессию
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, opacity: 0.6, padding: '6px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Circle size={8} weight="fill" color="#22c55e" /> Ожидает задачу (<code>dev</code> / <code>qa</code> / <code>sre</code>)
                </div>
              )}
            </div>
          ))}
        </div>

        {lightRuns.length > 0 ? (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Lightning size={14} weight="fill" color="#eab308" /> Активные лёгкие воркеры вне квоты ({lightRuns.length}):
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {lightRuns.map((run) => (
                <div
                  key={run.sessionId}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid rgba(0,0,0,0.12)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 12,
                  }}
                >
                  <span>
                    <strong>[{run.role.toUpperCase()}]</strong> {run.taskTitle}{' '}
                    <code style={{ fontSize: 11, opacity: 0.7 }}>#{run.taskId.slice(0, 8)}</code> · {run.elapsedSec} сек
                  </span>
                  <button
                    type="button"
                    style={{ ...buttonStyle, padding: '2px 8px', fontSize: 11, borderColor: 'rgba(198,40,40,0.4)', color: '#c62828', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    onClick={() => void doAction({ action: 'cancel_run', sessionId: run.sessionId })}
                    disabled={busy}
                  >
                    <Stop size={11} weight="fill" /> Прервать
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Инспектор очереди и зависимостей */}
        <div style={{ paddingTop: 10, borderTop: '1px solid rgba(0,0,0,0.08)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <MagnifyingGlass size={15} /> Инспектор очереди и графа зависимостей ({todoDiag.length})
          </div>
          {todoDiag.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12, opacity: 0.6 }}>
              В очереди «К выполнению» и среди ожидающих зависимостей сейчас нет задач.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {todoDiag.map((item) => (
                <div
                  key={item.id}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    border: `1px solid ${isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.1)'}`,
                    background: item.canStart
                      ? (isDark ? 'rgba(46,125,50,0.15)' : 'rgba(46,125,50,0.04)')
                      : (isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.015)'),
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <code style={{ fontSize: 11, opacity: 0.7 }}>#{item.id.slice(0, 8)}</code>
                      <strong style={{ fontSize: 13 }}>{item.title}</strong>
                      <code style={{ fontSize: 11, padding: '1px 5px', borderRadius: 4, background: 'rgba(0,0,0,0.06)' }}>
                        @{item.role}
                      </code>
                      <span style={{ fontSize: 11, opacity: 0.7 }}>
                        изоляция: <code>{item.isolationMode}</code>
                      </span>
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4, color: item.canStart ? '#2e7d32' : '#e65100' }}>
                      {item.waitingReason}
                    </div>
                    {item.parentId || item.dependencyStates.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4, fontSize: 11 }}>
                        {item.parentId ? (
                          <span style={{ padding: '1px 6px', borderRadius: 4, background: 'rgba(100,60,200,0.08)' }}>
                            ↳ Родитель: #{item.parentId.slice(0, 8)} {item.parentTitle ? `(${item.parentTitle})` : ''}
                          </span>
                        ) : null}
                        {item.dependencyStates.map((dep) => (
                          <span
                            key={dep.id}
                            style={{
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: dep.status === 'done' ? 'rgba(46,125,50,0.12)' : 'rgba(255,152,0,0.15)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <Link size={12} /> #{dep.id.slice(0, 8)} {dep.title}: <strong>{dep.status}</strong>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    style={{ ...buttonStyle, borderColor: 'rgba(26,115,232,0.45)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                    onClick={() => void doAction({ action: 'force_start_task', taskId: item.id })}
                    disabled={busy}
                    title="Запустить задачу немедленно в обход ожидания очереди и квот"
                  >
                    <Play size={12} weight="fill" /> Запустить сейчас
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* БЛОК 3: Менеджер изоляции (git worktree, merge.lock, host.lock) */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
          <ShieldCheck size={16} /> 3. Менеджер изоляции (<code>git worktree</code>, <code>merge.lock</code>, <code>host.lock</code>)
        </h3>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ padding: 10, borderRadius: 8, border: `1px solid ${isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.1)'}`, background: isDark ? 'rgba(255,255,255,0.03)' : 'transparent' }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Очередь слияния веток (<code>merge.lock</code>)</div>
            <div style={{ fontWeight: 700, fontSize: 14, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              {snap.mergeLock?.busy ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Lock size={14} /> Выполняется git merge --no-ff
                </span>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <LockOpen size={14} /> Свободен
                </span>
              )}
              {snap.mergeLock?.pendingCount ? ` (в очереди: ${snap.mergeLock.pendingCount})` : ''}
            </div>
            <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>
              Гарантирует последовательное слияние веток после QA PASS без гонок.
            </div>
          </div>

          <div style={{ padding: 10, borderRadius: 8, border: `1px solid ${isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.1)'}`, background: isDark ? 'rgba(255,255,255,0.03)' : 'transparent' }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Мьютекс хоста (<code>host.lock</code> для SRE)</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                {snap.hostLock.locked ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Lock size={14} /> Занят ({snap.hostLock.owner?.taskId?.slice(0, 8) || `PID ${snap.hostLock.owner?.pid ?? ''}`})
                  </span>
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <LockOpen size={14} /> Свободен
                  </span>
                )}
              </div>
              {snap.hostLock.locked ? (
                <button
                  type="button"
                  style={{ ...buttonStyle, padding: '3px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  onClick={() => void doAction({ action: 'release_host_lock' })}
                  disabled={busy}
                >
                  <LockOpen size={12} /> Снять блокировку
                </button>
              ) : null}
            </div>
            <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>{snap.hostLock.lockFilePath}</div>
          </div>
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <GitBranch size={16} /> Активные изолированные Git Worktrees ({worktrees.length})
        </div>
        {worktrees.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, opacity: 0.6 }}>
            Сейчас нет активных изолированных директорий в <code>worktrees/</code> (все слиты и очищены).
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {worktrees.map((wt) => (
              <div
                key={wt.worktreePath}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  border: `1px solid ${isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.1)'}`,
                  background: isDark ? 'rgba(255,255,255,0.03)' : 'transparent',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
                    <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <GitBranch size={14} /> {wt.branchName}
                    </strong>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: wt.dirty ? 'rgba(255,152,0,0.15)' : 'rgba(46,125,50,0.12)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                      }}
                    >
                      {wt.dirty ? (
                        <>
                          <Warning size={12} /> Изменён ({wt.dirtyFilesCount} ф.)
                        </>
                      ) : (
                        <>
                          <CheckCircle size={12} /> Чистый
                        </>
                      )}
                    </span>
                    {wt.taskTitle ? (
                      <span style={{ fontSize: 12 }}>
                        · Задача: <strong>{wt.taskTitle}</strong> (<code>#{wt.taskId.slice(0, 8)}</code>, {wt.taskStatus})
                      </span>
                    ) : (
                      <code style={{ fontSize: 11, opacity: 0.7 }}>#{wt.taskId}</code>
                    )}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.65, marginTop: 3, fontFamily: 'monospace' }}>
                    {wt.worktreePath}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    style={{ ...buttonStyle, padding: '4px 8px', fontSize: 11, borderColor: 'rgba(46,125,50,0.45)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    onClick={() =>
                      void doAction({
                        action: 'merge_worktree',
                        taskId: wt.taskId,
                        worktreePath: wt.worktreePath,
                        repoPath: wt.repoPath,
                        branchName: wt.branchName,
                        baseBranch: wt.baseBranch,
                      })
                    }
                    disabled={busy}
                    title="Влить ветку в базовую ветку через merge.lock и очистить worktree"
                  >
                    <GitMerge size={13} /> Слить в {wt.baseBranch || 'main'}
                  </button>
                  <button
                    type="button"
                    style={{ ...buttonStyle, padding: '4px 8px', fontSize: 11, borderColor: 'rgba(198,40,40,0.4)', color: '#c62828', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    onClick={() =>
                      void doAction({
                        action: 'remove_worktree',
                        taskId: wt.taskId,
                        worktreePath: wt.worktreePath,
                        repoPath: wt.repoPath,
                        branchName: wt.branchName,
                      })
                    }
                    disabled={busy}
                    title="Принудительно удалить директорию worktree и ветку задачи"
                  >
                    <Trash size={13} /> Удалить worktree
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* БЛОК 4: Живой журнал событий Диспетчера */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Scroll size={16} /> 4. Живой журнал событий Диспетчера ({events.length})
          </h3>
          {events.length > 0 ? (
            <button
              type="button"
              style={{ ...buttonStyle, padding: '3px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              onClick={() => void doAction({ action: 'clear_events' })}
              disabled={busy}
            >
              <Trash size={13} /> Очистить журнал
            </button>
          ) : null}
        </div>
        {events.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, opacity: 0.6 }}>Событий диспетчера пока нет.</p>
        ) : (
          <div
            style={{
              maxHeight: 240,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 12,
            }}
          >
            {events.map((ev) => (
              <div
                key={ev.id}
                style={{
                  padding: '6px 8px',
                  borderRadius: 4,
                  background: 'rgba(0,0,0,0.02)',
                  borderLeft: '3px solid rgba(26,115,232,0.45)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 10,
                }}
              >
                <div>
                  <span style={{ fontWeight: 500 }}>{stripEmoji(ev.message)}</span>
                  {ev.role ? (
                    <code style={{ marginLeft: 6, fontSize: 11, opacity: 0.75 }}>@{ev.role}</code>
                  ) : null}
                  {ev.taskId ? (
                    <code style={{ marginLeft: 6, fontSize: 11, opacity: 0.65 }}>#{ev.taskId.slice(0, 8)}</code>
                  ) : null}
                </div>
                <span style={{ fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap' }}>
                  {new Date(ev.at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
        </>
      )}
    </div>
  )
}
