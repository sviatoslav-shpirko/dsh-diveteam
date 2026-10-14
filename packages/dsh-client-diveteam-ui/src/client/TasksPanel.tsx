/**
 * Tasks board: five columns (Backlog, To Do, Running, Done, Failed) over the
 * DiveTeam task ledger, plus a per-task editor with role/status and a comment
 * journal. Saving talks to the /diveteam/tasks routes on the host.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  Trash,
  Pause,
  CheckCircle,
  XCircle,
  GitBranch,
  Lock,
  Archive,
  TreeStructure,
  Link,
  Clock,
  Plus,
  X,
  FloppyDisk,
  PaperPlaneTilt,
} from '@phosphor-icons/react'
import { fetchRoles, getRoleIcon, stripEmoji, type Role } from './AgentsPanel.tsx'
import { t } from './locales.ts'
import { useIsDarkTheme, createAdaptiveStyles } from './theme.ts'

interface TaskComment {
  author: string
  text: string
  at: string
}

interface TaskActivity {
  role: string
  kind: string
  title: string
  text?: string
  content?: string
  at: string
}

interface Task {
  id: string
  title: string
  description: string
  prompt: string
  role: string
  isolationMode?: string | null
  parentId?: string | null
  dependsOn?: string[]
  status: string
  phase?: string
  approvalRequested?: string | null
  repoPath?: string
  worktreePath?: string | null
  branchName?: string | null
  baseBranch?: string | null
  comments: TaskComment[]
  activity?: TaskActivity[]
  attemptCount: number
  createdAt: string
  updatedAt: string
}

const COLUMNS = ['backlog', 'todo', 'running', 'done', 'failed'] as const
const DEFAULT_ROLES: readonly { id: string; name: string }[] = [
  { id: 'shturman', name: '1. Shturman (Штурман)' },
  { id: 'arch', name: '2. Arch (Архитектор)' },
  { id: 'dev', name: '3. Dev (Разработчик)' },
  { id: 'qa', name: '4. QA (Инженер тестирования)' },
  { id: 'sre', name: '5. SRE (Системный инженер)' },
  { id: 'reg', name: '6. Reg (Регистратор)' },
]
const DEFAULT_REPO_PATH = '/home/slava/Projects/DeepSeek-Harness/testmygit/testrepo'

const STATUS_KEYS: Record<string, 'tasks.backlog' | 'tasks.todo' | 'tasks.running' | 'tasks.done' | 'tasks.failed'> = {
  backlog: 'tasks.backlog',
  todo: 'tasks.todo',
  running: 'tasks.running',
  done: 'tasks.done',
  failed: 'tasks.failed',
}

const PHASE_LABELS: Record<string, string> = {
  draft: 'Черновик',
  inbox: 'Входящее',
  clarify: 'Уточнение (@slava)',
  ready: 'Готово к запуску',
  dev_running: 'В разработке (dev)',
  qa_ready: 'Ожидает QA',
  qa_running: 'Проверка QA',
  sre_running: 'Инфра (sre)',
  arch_running: 'Архитектура (arch)',
  reg_running: 'База знаний (reg)',
  shturman_running: 'Координация (shturman)',
  merge_pending: 'Слияние (merge.lock)',
  done: 'Завершено',
  failed: 'Ошибка',
}

function formatPhaseBadge(phase?: string, status?: string): string {
  const norm = (phase ?? '').trim().toLowerCase()
  if (PHASE_LABELS[norm]) return PHASE_LABELS[norm]
  if (norm.endsWith('_running')) {
    const r = norm.slice(0, -'_running'.length)
    return `В работе (${r})`
  }
  if (status === 'done') return PHASE_LABELS.done
  if (status === 'failed') return PHASE_LABELS.failed
  return norm ? phase! : PHASE_LABELS.draft
}

interface IsolationBadgeInfo {
  mode: string
  label: string
}

function getEffectiveIsolationBadge(isolationMode?: string | null, role?: string): IsolationBadgeInfo | null {
  const eff = isolationMode
    || (role === 'dev' || role === 'qa'
      ? 'git_worktree'
      : role === 'sre'
        ? 'host_exclusive'
        : role === 'reg'
          ? 'notes_vault'
          : 'none')
  if (eff === 'git_worktree') return { mode: 'git_worktree', label: 'worktree' }
  if (eff === 'host_exclusive') return { mode: 'host_exclusive', label: 'host.lock' }
  if (eff === 'notes_vault') return { mode: 'notes_vault', label: 'vault' }
  return null
}

async function api(path: string, init?: RequestInit): Promise<any> {
  let res = await fetch(path, init)
  if (res.status === 404 && path.startsWith('/diveteam/')) {
    const fallbackRes = await fetch(path.replace('/diveteam/', '/farvater/'), init)
    if (fallbackRes.ok) res = fallbackRes
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { ok?: boolean; error?: string }
  if (!data.ok) throw new Error(data.error ?? 'request failed')
  return data
}

const fetchTasks = (): Promise<Task[]> => api('/diveteam/tasks').then((d) => d.tasks as Task[])

type EditableTaskFields = Pick<
  Task,
  'title' | 'description' | 'prompt' | 'role' | 'isolationMode' | 'parentId' | 'dependsOn' | 'status' | 'repoPath'
>

const createTask = (task: EditableTaskFields): Promise<unknown> =>
  api('/diveteam/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(task) })

const updateTask = (id: string, patch: EditableTaskFields): Promise<unknown> =>
  api('/diveteam/tasks/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...patch }) })

const addComment = (id: string, author: string, text: string): Promise<unknown> =>
  api('/diveteam/tasks/comment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, author, text }) })

const removeTask = (id: string): Promise<unknown> =>
  api('/diveteam/tasks/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })

const decideTask = (id: string, decision: 'approve' | 'reject', comment?: string): Promise<unknown> =>
  api('/diveteam/tasks/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, decision, comment }) })

const labelStyle: CSSProperties = { display: 'block', marginBottom: 4, opacity: 0.75, fontSize: 12, fontWeight: 500 }
const inputStyle: CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  boxSizing: 'border-box',
  marginBottom: 12,
  font: 'inherit',
  fontSize: 13,
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.35))',
  background: 'var(--dsw-alias-bg-base, rgba(127,127,127,0.08))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  outline: 'none',
}
const borderlessAutoStyle: CSSProperties = {
  width: '100%',
  padding: '4px 0',
  boxSizing: 'border-box',
  marginBottom: 16,
  font: 'inherit',
  border: 'none',
  outline: 'none',
  boxShadow: 'none',
  background: 'transparent',
  resize: 'none',
  overflow: 'hidden',
  lineHeight: 1.5,
  color: 'inherit',
}
const buttonStyle: CSSProperties = {
  padding: '7px 14px',
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
const cardStyle: CSSProperties = {
  padding: '12px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25))',
  marginBottom: 10,
  cursor: 'pointer',
  background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  transition: 'all 0.15s ease',
}
const columnStyle: CSSProperties = {
  flex: 1,
  minWidth: 180,
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
  background: 'var(--dsw-alias-bg-base, rgba(127,127,127,0.05))',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
  borderRadius: 8,
  padding: 12,
}

function AutoGrowField({
  value,
  onChange,
  placeholder,
  style,
  isDark = true,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  style?: CSSProperties
  isDark?: boolean
}): ReactElement {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, 38)}px`
  }, [value])

  const bg = isDark ? '#141721' : '#ffffff'
  const border = focused
    ? '#3b82f6'
    : (isDark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.22)')
  const color = isDark ? '#f8fafc' : '#0f172a'

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: '100%',
        padding: '10px 14px',
        boxSizing: 'border-box',
        marginBottom: 14,
        font: 'inherit',
        fontSize: 13,
        lineHeight: 1.5,
        borderRadius: 8,
        border: `1.5px solid ${border}`,
        background: bg,
        color: color,
        outline: 'none',
        resize: 'none',
        boxShadow: focused ? '0 0 0 3px rgba(59, 130, 246, 0.25)' : 'none',
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        ...style,
      }}
    />
  )
}

/** The five-column board plus a popup modal task editor. */
export function TasksPanel({
  onCreateRole,
}: {
  onCreateRole?: () => void
} = {}): ReactElement {
  const isDark = useIsDarkTheme()
  const { btn, btnPrimary } = createAdaptiveStyles(isDark)

  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [roles, setRoles] = useState<readonly { id: string; name: string }[]>(DEFAULT_ROLES)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Task | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [comment, setComment] = useState('')

  const loadRolesList = useCallback(async () => {
    try {
      const loaded: Role[] = await fetchRoles()
      if (loaded.length > 0) {
        setRoles(loaded.map((r) => ({ id: r.id, name: r.name })))
      }
    } catch { /* fallback to DEFAULT_ROLES */ }
  }, [])

  const load = useCallback(async () => {
    try {
      const fresh = await fetchTasks()
      setTasks(fresh)
      setEditing((prev) => {
        if (!prev || !prev.id) return prev
        const updated = fresh.find((x) => x.id === prev.id)
        return updated
          ? {
              ...prev,
              status: updated.status,
              phase: updated.phase,
              role: updated.role,
              worktreePath: updated.worktreePath,
              branchName: updated.branchName,
              baseBranch: updated.baseBranch,
              comments: updated.comments,
              activity: updated.activity ?? [],
              attemptCount: updated.attemptCount,
              approvalRequested: updated.approvalRequested,
            }
          : prev
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
    void loadRolesList()
    const timer = setInterval(() => { void load() }, 3000)
    return () => clearInterval(timer)
  }, [load, loadRolesList])

  // Закрытие модального окна по нажатию Esc
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && editing !== null) {
        setEditing(null)
        setIsNew(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editing])

  const blankTask = (): Task => ({
    id: '',
    title: '',
    description: '',
    prompt: '',
    role: 'dev',
    isolationMode: null,
    parentId: null,
    dependsOn: [],
    status: 'todo',
    repoPath: DEFAULT_REPO_PATH,
    comments: [],
    activity: [],
    attemptCount: 0,
    createdAt: '',
    updatedAt: '',
  })

  const openEditor = (task: Task | null): void => {
    setEditing(task ? { ...task, dependsOn: task.dependsOn ?? [] } : blankTask())
    setIsNew(task === null)
  }

  const save = async (): Promise<void> => {
    if (editing === null) return
    setSaving(true)
    setError(null)
    const fields: EditableTaskFields = {
      title: editing.title,
      description: editing.description,
      prompt: editing.prompt,
      role: editing.role,
      isolationMode: editing.isolationMode || null,
      parentId: editing.parentId || null,
      dependsOn: editing.dependsOn ?? [],
      status: editing.status,
      repoPath: editing.repoPath,
    }
    try {
      if (isNew) await createTask(fields)
      else await updateTask(editing.id, fields)
      setEditing(null)
      setIsNew(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (editing === null || isNew) return
    if (!window.confirm(`Удалить задачу «${editing.title || editing.id}»?`)) return
    setSaving(true)
    try {
      await removeTask(editing.id)
      setEditing(null)
      setIsNew(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDecision = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (editing === null || isNew) return
    setSaving(true)
    try {
      await decideTask(editing.id, decision, comment)
      setComment('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const submitComment = async (): Promise<void> => {
    if (editing === null || isNew || comment.trim() === '') return
    try {
      await addComment(editing.id, '@slava', comment)
      setComment('')
      const fresh = await fetchTasks()
      setTasks(fresh)
      setEditing(fresh.find((x) => x.id === editing.id) ?? editing)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const patch = (p: Partial<Task>): void => {
    setEditing((prev) => (prev === null ? null : { ...prev, ...p }))
  }

  const toggleDependency = (depId: string): void => {
    setEditing((prev) => {
      if (!prev) return null
      const curr = prev.dependsOn ?? []
      const exists = curr.includes(depId)
      return {
        ...prev,
        dependsOn: exists ? curr.filter((x) => x !== depId) : [...curr, depId],
      }
    })
  }

  // Контрастные стили полей ввода для модального окна (исправляет невидимость в темной теме)
  const fieldBg = isDark ? '#141721' : '#ffffff'
  const fieldBorder = isDark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.22)'
  const fieldText = isDark ? '#f8fafc' : '#0f172a'
  const fieldLabelColor = isDark ? '#e2e8f0' : '#1e293b'

  const modalInputStyle: CSSProperties = {
    width: '100%',
    padding: '9px 12px',
    boxSizing: 'border-box',
    marginBottom: 14,
    font: 'inherit',
    fontSize: 13,
    borderRadius: 8,
    border: `1.5px solid ${fieldBorder}`,
    background: fieldBg,
    color: fieldText,
    outline: 'none',
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  }

  const modalLabelStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    fontSize: 12,
    fontWeight: 700,
    color: fieldLabelColor,
    letterSpacing: '0.3px',
  }

  const dynamicColumnStyle: CSSProperties = {
    flex: 1,
    minWidth: 200,
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    background: isDark ? 'var(--dsw-alias-bg-base, #13151b)' : 'var(--dsw-alias-bg-layer-1, #f1f3f7)',
    border: isDark
      ? '1.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12))'
      : '1.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
    borderRadius: 10,
    padding: 12,
  }

  const dynamicCardStyle: CSSProperties = {
    padding: '12px',
    borderRadius: 8,
    border: isDark
      ? '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.18))'
      : '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.15))',
    marginBottom: 10,
    cursor: 'pointer',
    background: isDark ? 'var(--dsw-alias-bg-layer-1, #1e222d)' : '#ffffff',
    color: isDark ? '#f1f5f9' : '#0f172a',
    boxShadow: isDark ? '0 2px 6px rgba(0,0,0,0.45)' : '0 1px 4px rgba(0,0,0,0.06)',
    transition: 'all 0.15s ease',
  }

  if (tasks === null) {
    return (
      <div style={{ padding: 24, textAlign: 'center', opacity: 0.8 }}>
        <p>{error ?? t('tasks.loading')}</p>
      </div>
    )
  }

  const activityList = editing?.activity ?? []
  const isClarify = editing?.phase?.toLowerCase() === 'clarify' || Boolean(editing?.approvalRequested)
  const roleOptions = editing
    ? roles.some((r) => r.id === editing.role)
      ? roles
      : [...roles, { id: editing.role, name: editing.role }]
    : roles
  const otherTasks = editing ? (tasks ?? []).filter((x) => x.id !== editing.id) : []
  const selectedDeps = editing?.dependsOn ?? []

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {/* Шапка Канбана: Кнопка создания задачи и сводка */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            style={{
              ...btnPrimary,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              borderRadius: 7,
              cursor: 'pointer',
              background: '#2563eb',
              borderColor: '#3b82f6',
              color: '#ffffff',
              boxShadow: '0 2px 8px rgba(37, 99, 235, 0.45)',
              transition: 'all 0.15s ease',
            }}
            onClick={() => openEditor(null)}
            title="Создать новую задачу для агента (откроется всплывающее окно)"
          >
            <Plus size={16} weight="bold" /> {t('tasks.new')}
          </button>

          <span style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#64748b' }}>
            Всего задач на доске: <strong style={{ color: isDark ? '#f1f5f9' : '#0f172a' }}>{tasks.length}</strong>
          </span>
        </div>

        {error && !editing ? (
          <span role="alert" style={{ color: '#ef4444', fontSize: 12, fontWeight: 600 }}>
            {error}
          </span>
        ) : null}
      </div>

      {/* Колонки Канбана */}
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0, overflowX: 'auto', paddingBottom: 6 }}>
        {COLUMNS.map((status) => {
          const columnTasks = tasks.filter((x) => x.status === status)
          return (
            <div key={status} style={dynamicColumnStyle}>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: isDark ? '#f1f5f9' : '#0f172a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t(STATUS_KEYS[status])}</span>
                <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10, background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)', fontWeight: 600 }}>
                  {columnTasks.length}
                </span>
              </h3>
              {columnTasks.map((task) => {
                const isClarifyCard = task.phase?.toLowerCase() === 'clarify' || Boolean(task.approvalRequested)
                const isoBadge = getEffectiveIsolationBadge(task.isolationMode, task.role)
                const parentTask = task.parentId
                  ? tasks.find((x) => x.id === task.parentId || x.id.startsWith(task.parentId!))
                  : null
                const subtasks = tasks.filter(
                  (st) => st.id !== task.id && (st.parentId === task.id || st.parentId === task.id.slice(0, 8))
                )
                const deps = task.dependsOn ?? []
                const resolvedDeps = deps.map((depId) => tasks.find((x) => x.id === depId || x.id.startsWith(depId)))
                const doneDepsCount = resolvedDeps.filter((d) => d?.status === 'done').length
                const pendingDeps = deps.filter((_, idx) => resolvedDeps[idx]?.status !== 'done')

                return (
                  <div key={task.id} style={dynamicCardStyle} onClick={() => openEditor(task)}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: isDark ? '#f8fafc' : '#0f172a' }}>
                      {task.title}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                      <code style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', display: 'inline-flex', alignItems: 'center', gap: 4, color: isDark ? '#e2e8f0' : '#1e293b' }}>
                        {getRoleIcon(task.role, 11)} @{task.role}
                      </code>
                      <span
                        style={{
                          fontSize: 11,
                          color: isClarifyCard ? '#f59e0b' : (isDark ? '#94a3b8' : '#64748b'),
                          fontWeight: isClarifyCard ? 700 : 400,
                        }}
                      >
                        {formatPhaseBadge(task.phase, task.status)}
                      </span>
                      {isoBadge ? (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: isDark ? 'rgba(59,130,246,0.18)' : 'rgba(0,120,255,0.08)',
                            color: isDark ? '#93c5fd' : '#1d4ed8',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                          }}
                        >
                          {isoBadge.mode === 'git_worktree' ? <GitBranch size={11} /> : null}
                          {isoBadge.mode === 'host_exclusive' ? <Lock size={11} /> : null}
                          {isoBadge.mode === 'notes_vault' ? <Archive size={11} /> : null}
                          {isoBadge.label}
                        </span>
                      ) : null}
                      {task.attemptCount > 0 ? (
                        <span style={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b' }}>· Попытка #{task.attemptCount + 1}</span>
                      ) : null}
                    </div>
                    {task.parentId || subtasks.length > 0 || deps.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, fontSize: 11 }}>
                        {task.parentId ? (
                          <span
                            style={{
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: isDark ? 'rgba(168,85,247,0.18)' : 'rgba(100,60,200,0.08)',
                              color: isDark ? '#d8b4fe' : '#6b21a8',
                            }}
                            title={parentTask?.title || task.parentId}
                          >
                            ↳ Подзадача #{(parentTask?.id ?? task.parentId).slice(0, 8)}
                          </span>
                        ) : null}
                        {subtasks.length > 0 ? (
                          <span
                            style={{
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: isDark ? 'rgba(20,184,166,0.18)' : 'rgba(0,150,136,0.1)',
                              color: isDark ? '#5eead4' : '#0f766e',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <TreeStructure size={11} />
                            Подзадачи: {subtasks.filter((s) => s.status === 'done').length}/{subtasks.length}
                          </span>
                        ) : null}
                        {deps.length > 0 ? (
                          <span
                            style={{
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: pendingDeps.length === 0
                                ? (isDark ? 'rgba(34,197,94,0.18)' : 'rgba(0,160,80,0.12)')
                                : (isDark ? 'rgba(245,158,11,0.18)' : 'rgba(255,152,0,0.14)'),
                              color: pendingDeps.length === 0
                                ? (isDark ? '#4ade80' : '#15803d')
                                : (isDark ? '#fbbf24' : '#b45309'),
                              fontWeight: 600,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <Link size={11} />
                            {pendingDeps.length === 0 ? (
                              <>
                                Зависимости: {doneDepsCount}/{deps.length}
                                <CheckCircle size={11} weight="bold" />
                              </>
                            ) : (
                              <>
                                Ждёт: {pendingDeps.map((d) => `#${d.slice(0, 6)}`).join(', ')}
                                <Clock size={11} />
                              </>
                            )}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* ВСПЛЫВАЮЩЕЕ ОКНО (POPUP MODAL): СОЗДАНИЕ / РЕДАКТИРОВАНИЕ ЗАДАЧИ */}
      {editing !== null ? (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.72)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
            boxSizing: 'border-box',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setEditing(null)
              setIsNew(false)
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              width: '100%',
              maxWidth: 780,
              maxHeight: '90vh',
              borderRadius: 12,
              background: isDark ? 'var(--dsw-alias-bg-layer-1, #1a1d24)' : '#ffffff',
              border: `1.5px solid ${isDark ? 'var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.22))' : 'rgba(0, 0, 0, 0.18)'}`,
              boxShadow: isDark
                ? '0 24px 60px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.1)'
                : '0 20px 50px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(0, 0, 0, 0.05)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              color: isDark ? '#f1f5f9' : '#0f172a',
            }}
          >
            {/* ШАПКА МОДАЛЬНОГО ОКНА */}
            <div
              style={{
                padding: '14px 20px',
                borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: isDark ? 'var(--dsw-alias-bg-layer-2, #21252e)' : '#f8fafc',
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: isNew ? '#2563eb' : (isDark ? 'rgba(59,130,246,0.2)' : 'rgba(37,99,235,0.12)'),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: isNew ? '#ffffff' : '#3b82f6',
                  }}
                >
                  {isNew ? <Plus size={18} weight="bold" /> : <TreeStructure size={18} weight="bold" />}
                </div>
                <div>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: isDark ? '#f8fafc' : '#0f172a' }}>
                    {isNew ? 'Новая задача' : `Задача #${editing.id.slice(0, 8)}`}
                  </h2>
                  <div style={{ fontSize: 11.5, color: isDark ? '#94a3b8' : '#64748b', marginTop: 2 }}>
                    {isNew
                      ? 'Постановка задачи для автономного агента DiveTeam'
                      : `Статус: ${t(STATUS_KEYS[editing.status] ?? 'tasks.backlog')} · Роль: @${editing.role}`}
                  </div>
                </div>
              </div>

              <button
                type="button"
                style={{
                  ...btn,
                  padding: 6,
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: isDark ? '#94a3b8' : '#64748b',
                }}
                onClick={() => {
                  setEditing(null)
                  setIsNew(false)
                }}
                title="Закрыть окно (Esc)"
              >
                <X size={18} weight="bold" />
              </button>
            </div>

            {/* ТЕЛО МОДАЛЬНОГО ОКНА (С ВЫСОКОКОНТРАСТНЫМИ ПОЛЯМИ) */}
            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column' }}>
              {/* Баннер эскалации Clarify */}
              {!isNew && isClarify ? (
                <div
                  style={{
                    padding: 12,
                    marginBottom: 16,
                    borderRadius: 8,
                    border: '1.5px solid rgba(245,158,11,0.5)',
                    background: isDark ? 'rgba(245,158,11,0.12)' : 'rgba(255,152,0,0.08)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <div style={{ fontSize: 13 }}>
                    <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: isDark ? '#fbbf24' : '#b45309' }}>
                      <Pause size={15} weight="bold" /> Задача ожидает решения @slava (Уточнение)
                    </strong>
                    <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
                      Вы можете одобрить возврат в работу (или слияние) либо отклонить задачу.
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      style={{
                        ...btn,
                        borderColor: 'rgba(34,197,94,0.6)',
                        background: 'rgba(34,197,94,0.15)',
                        color: isDark ? '#4ade80' : '#15803d',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontWeight: 700,
                      }}
                      onClick={() => void handleDecision('approve')}
                      disabled={saving}
                    >
                      <CheckCircle size={14} weight="bold" /> Одобрить
                    </button>
                    <button
                      type="button"
                      style={{
                        ...btn,
                        borderColor: 'rgba(239,68,68,0.6)',
                        background: 'rgba(239,68,68,0.15)',
                        color: isDark ? '#f87171' : '#b91c1c',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontWeight: 700,
                      }}
                      onClick={() => void handleDecision('reject')}
                      disabled={saving}
                    >
                      <XCircle size={14} weight="bold" /> Отклонить
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Баннер активного worktree */}
              {!isNew && (editing.worktreePath || editing.branchName) ? (
                <div
                  style={{
                    padding: '9px 14px',
                    marginBottom: 16,
                    borderRadius: 8,
                    border: '1.5px solid rgba(59,130,246,0.4)',
                    background: isDark ? 'rgba(59,130,246,0.1)' : 'rgba(37,99,235,0.06)',
                    fontSize: 12.5,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: isDark ? '#93c5fd' : '#1d4ed8',
                  }}
                >
                  <GitBranch size={16} style={{ flexShrink: 0 }} />
                  <div>
                    <strong>Изолированное окружение:</strong>{' '}
                    {editing.branchName ? <span>Ветка <code>{editing.branchName}</code></span> : null}
                    {editing.worktreePath ? <span> · Путь <code>{editing.worktreePath}</code></span> : null}
                  </div>
                </div>
              ) : null}

              {/* Поле 1: Заголовок */}
              <label style={modalLabelStyle}>
                <span>{t('tasks.title')} *</span>
                <span style={{ fontSize: 11, fontWeight: 500, color: isDark ? '#94a3b8' : '#64748b' }}>Обязательно</span>
              </label>
              <AutoGrowField
                value={editing.title}
                placeholder="Краткое и понятное название задачи…"
                style={{ fontWeight: 600, fontSize: 15 }}
                onChange={(val) => patch({ title: val })}
                isDark={isDark}
              />

              {/* Поле 2: Описание */}
              <label style={modalLabelStyle}>
                <span>{t('tasks.description')}</span>
              </label>
              <AutoGrowField
                value={editing.description}
                placeholder="Контекст, цели, ссылки и критерии приемки…"
                style={{ minHeight: 65 }}
                onChange={(val) => patch({ description: val })}
                isDark={isDark}
              />

              {/* Поле 3: Инструкция агента (Prompt) */}
              <label style={modalLabelStyle}>
                <span>{t('tasks.prompt')}</span>
                <span style={{ fontSize: 11, fontWeight: 500, color: isDark ? '#94a3b8' : '#64748b' }}>Промпт для модели</span>
              </label>
              <AutoGrowField
                value={editing.prompt}
                placeholder="Инструкция для автономного агента (шаги, файлы, команды)…"
                style={{ minHeight: 85, fontFamily: 'monospace', fontSize: 12.5 }}
                onChange={(val) => patch({ prompt: val })}
                isDark={isDark}
              />

              {/* Ряд: Роль агента и Статус */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={modalLabelStyle}>{t('tasks.role')}</label>
                  <select
                    style={modalInputStyle}
                    value={editing.role}
                    onChange={(e) => patch({ role: e.target.value })}
                  >
                    {roleOptions.map((role) => (
                      <option key={role.id} value={role.id}>{stripEmoji(role.name)} (@{role.id})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={modalLabelStyle}>{t('tasks.status')}</label>
                  <select
                    style={modalInputStyle}
                    value={editing.status}
                    onChange={(e) => patch({ status: e.target.value })}
                  >
                    {COLUMNS.map((status) => <option key={status} value={status}>{t(STATUS_KEYS[status])}</option>)}
                  </select>
                </div>
              </div>

              {/* Ряд: Режим изоляции и Репозиторий */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={modalLabelStyle}>{t('tasks.isolationMode')}</label>
                  <select
                    style={modalInputStyle}
                    value={editing.isolationMode ?? ''}
                    onChange={(e) => patch({ isolationMode: e.target.value || null })}
                  >
                    <option value="">Авто (по умолчанию для роли @{editing.role})</option>
                    <option value="git_worktree">Изолированный Git Worktree (git_worktree)</option>
                    <option value="host_exclusive">Монопольный мьютекс хоста (host_exclusive / host.lock)</option>
                    <option value="notes_vault">База знаний (notes_vault)</option>
                    <option value="none">Без изоляции (none)</option>
                  </select>
                </div>
                <div>
                  <label style={modalLabelStyle}>{t('tasks.repoPath')}</label>
                  <input
                    style={modalInputStyle}
                    value={editing.repoPath ?? ''}
                    onChange={(e) => patch({ repoPath: e.target.value })}
                    placeholder="/home/slava/Projects/DSH"
                  />
                </div>
              </div>

              {/* Поле: Родительская задача */}
              <label style={modalLabelStyle}>{t('tasks.parentId')}</label>
              <select
                style={modalInputStyle}
                value={editing.parentId ?? ''}
                onChange={(e) => patch({ parentId: e.target.value || null })}
              >
                <option value="">— Нет (самостоятельная задача верхнего уровня) —</option>
                {otherTasks.map((ot) => (
                  <option key={ot.id} value={ot.id}>
                    [#{ot.id.slice(0, 8)}] {ot.title} (@{ot.role} · {t(STATUS_KEYS[ot.status] ?? 'tasks.backlog')})
                  </option>
                ))}
              </select>

              {/* Поле: Зависимости */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label style={{ ...modalLabelStyle, marginBottom: 0 }}>
                  <span>{t('tasks.dependsOn')} {selectedDeps.length > 0 ? `(${selectedDeps.length})` : ''}</span>
                </label>
                {selectedDeps.length > 0 ? (
                  <button
                    type="button"
                    style={{ ...btn, padding: '2px 8px', fontSize: 11 }}
                    onClick={() => patch({ dependsOn: [] })}
                  >
                    Очистить
                  </button>
                ) : null}
              </div>
              {otherTasks.length === 0 ? (
                <div style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#64748b', marginBottom: 14 }}>
                  Других задач на доске пока нет.
                </div>
              ) : (
                <div
                  style={{
                    maxHeight: 140,
                    overflowY: 'auto',
                    border: `1.5px solid ${fieldBorder}`,
                    borderRadius: 8,
                    padding: '6px 8px',
                    marginBottom: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    background: fieldBg,
                  }}
                >
                  {otherTasks.map((ot) => {
                    const checked = selectedDeps.includes(ot.id) || selectedDeps.includes(ot.id.slice(0, 8))
                    const depIdToUse = selectedDeps.includes(ot.id.slice(0, 8)) && !selectedDeps.includes(ot.id)
                      ? ot.id.slice(0, 8)
                      : ot.id
                    return (
                      <label
                        key={ot.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12,
                          cursor: 'pointer',
                          padding: '5px 8px',
                          borderRadius: 6,
                          background: checked
                            ? (isDark ? 'rgba(59, 130, 246, 0.2)' : 'rgba(37, 99, 235, 0.1)')
                            : 'transparent',
                          border: `1px solid ${checked ? '#3b82f6' : 'transparent'}`,
                          color: fieldText,
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleDependency(depIdToUse)}
                        />
                        <code style={{ fontSize: 11, opacity: 0.8 }}>#{ot.id.slice(0, 8)}</code>
                        <span style={{ fontWeight: checked ? 700 : 400, flex: 1 }}>{ot.title}</span>
                        <span style={{ fontSize: 11, opacity: 0.75, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          @{ot.role} · {ot.status === 'done' ? <><CheckCircle size={12} weight="bold" color="#22c55e" /> Готово</> : t(STATUS_KEYS[ot.status] ?? 'tasks.backlog')}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}

              {/* Комментарии и активность (только для существующих задач) */}
              {!isNew ? (
                <>
                  <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}` }}>
                    <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700, color: fieldLabelColor }}>
                      {t('tasks.comments')} ({editing.comments.length})
                    </h3>
                    {editing.comments.length === 0 ? (
                      <p style={{ opacity: 0.7, fontSize: 13, color: isDark ? '#94a3b8' : '#64748b' }}>
                        {t('tasks.empty')}
                      </p>
                    ) : (
                      <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {editing.comments.map((c, i) => (
                          <li
                            key={i}
                            style={{
                              padding: '8px 12px',
                              borderRadius: 6,
                              background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
                              border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
                              fontSize: 13,
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.75, marginBottom: 4 }}>
                              <strong>{c.author}</strong>
                              <span>{new Date(c.at).toLocaleString()}</span>
                            </div>
                            <div style={{ whiteSpace: 'pre-wrap', color: fieldText }}>{c.text}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        style={{ ...modalInputStyle, flex: 1, marginBottom: 0 }}
                        value={comment}
                        placeholder={t('tasks.commentPlaceholder')}
                        onChange={(e) => setComment(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            void submitComment()
                          }
                        }}
                      />
                      <button
                        type="button"
                        style={{ ...btn, whiteSpace: 'nowrap' }}
                        onClick={() => void submitComment()}
                      >
                        <PaperPlaneTilt size={14} /> {t('tasks.addComment')}
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}` }}>
                    <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700, color: fieldLabelColor }}>
                      {t('tasks.activity')} ({activityList.length})
                    </h3>
                    {activityList.length === 0 ? (
                      <p style={{ opacity: 0.7, fontSize: 13, color: isDark ? '#94a3b8' : '#64748b' }}>
                        {t('tasks.activityEmpty')}
                      </p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 220, overflowY: 'auto' }}>
                        {activityList.map((item, i) => {
                          const body = item.text ?? item.content ?? ''
                          return (
                            <div
                              key={i}
                              style={{
                                padding: '10px 12px',
                                borderRadius: 6,
                                border: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
                                background: item.kind === 'file'
                                  ? (isDark ? 'rgba(0,120,255,0.08)' : 'rgba(0,120,255,0.04)')
                                  : (isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'),
                              }}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: body ? 6 : 0, fontSize: 11, opacity: 0.75 }}>
                                <strong>@{item.role} · {item.title}</strong>
                                <span>{new Date(item.at).toLocaleTimeString()}</span>
                              </div>
                              {body ? (
                                <div
                                  style={{
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    fontSize: 12,
                                    lineHeight: 1.5,
                                    fontFamily: item.kind === 'tool' || item.kind === 'output' ? 'monospace' : 'inherit',
                                    color: fieldText,
                                  }}
                                >
                                  {body}
                                </div>
                              ) : null}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>

            {/* ПОДВАЛ МОДАЛЬНОГО ОКНА С КНОПКАМИ ДЕЙСТВИЙ */}
            <div
              style={{
                padding: '12px 24px',
                background: isDark ? 'var(--dsw-alias-bg-layer-2, #21252e)' : '#f8fafc',
                borderTop: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                flexShrink: 0,
              }}
            >
              <div>
                {!isNew ? (
                  <button
                    type="button"
                    style={{
                      ...btn,
                      color: isDark ? '#f87171' : '#dc2626',
                      borderColor: isDark ? 'rgba(239, 68, 68, 0.4)' : 'rgba(220, 38, 38, 0.35)',
                      background: isDark ? 'rgba(239, 68, 68, 0.1)' : 'rgba(220, 38, 38, 0.05)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    onClick={() => void handleDelete()}
                    disabled={saving}
                    title="Удалить задачу с доски"
                  >
                    <Trash size={14} /> Удалить
                  </button>
                ) : null}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {error ? (
                  <span role="alert" style={{ color: '#ef4444', fontSize: 12, fontWeight: 600 }}>
                    {error}
                  </span>
                ) : null}

                <button
                  type="button"
                  style={btn}
                  onClick={() => {
                    setEditing(null)
                    setIsNew(false)
                  }}
                  disabled={saving}
                >
                  Отмена
                </button>

                <button
                  type="button"
                  style={{
                    ...btnPrimary,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 18px',
                  }}
                  onClick={() => void save()}
                  disabled={saving || !editing.title.trim()}
                >
                  {saving ? (
                    'Сохранение…'
                  ) : isNew ? (
                    <>
                      <Plus size={15} weight="bold" /> Создать задачу
                    </>
                  ) : (
                    <>
                      <FloppyDisk size={15} weight="bold" /> Сохранить изменения
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
