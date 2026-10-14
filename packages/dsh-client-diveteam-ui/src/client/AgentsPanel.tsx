/**
 * Agents editor: the list of roles on the left (+ "Create Role" button) and one
 * role's full form on the right. Saving or creating writes `roles/<id>.md` on
 * the host and re-runs `sync-roles.mjs`. Custom roles can also be deleted.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  Plus,
  Trash,
  FloppyDisk,
  Sparkle,
  Gear,
  CheckCircle,
  WarningCircle,
  CircleNotch,
  Compass,
  TreeStructure,
  Code,
  CheckSquare,
  Wrench,
  Archive,
  Robot,
} from '@phosphor-icons/react'
import { t } from './locales.ts'
import { useIsDarkTheme } from './theme.ts'

export function stripEmoji(str: string): string {
  if (!str) return ''
  return str.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim()
}

export function getRoleIcon(roleId: string, size = 16): ReactElement {
  switch (roleId.toLowerCase()) {
    case 'shturman':
      return <Compass size={size} weight="bold" />
    case 'arch':
      return <TreeStructure size={size} weight="bold" />
    case 'dev':
      return <Code size={size} weight="bold" />
    case 'qa':
      return <CheckSquare size={size} weight="bold" />
    case 'sre':
      return <Wrench size={size} weight="bold" />
    case 'reg':
      return <Archive size={size} weight="bold" />
    default:
      return <Robot size={size} weight="bold" />
  }
}

export interface Role {
  id: string
  name: string
  description: string
  order: number
  defaultProvider: string
  defaultModel: string
  isolationMode: string
  heavyWorker: boolean
  body: string
  isCore?: boolean
}

const CORE_ROLE_IDS = new Set(['shturman', 'arch', 'dev', 'qa', 'sre', 'reg'])

const ISOLATION_MODES: readonly { value: string; label: string }[] = [
  { value: 'none', label: 'none — Без изоляции (координация, планирование, аналитика)' },
  { value: 'git_worktree', label: 'git_worktree — Изолированная Git-ветка в worktrees/' },
  { value: 'host_exclusive', label: 'host_exclusive — Эксклюзивный доступ к хосту (host.lock)' },
  { value: 'notes_vault', label: 'notes_vault — Работа с базой знаний vault/' },
]

const MODEL_SUGGESTIONS = [
  'deepseek-v4.1-flash',
  'kimi-k2.5',
  'glm-5.1',
  'minimax-m2.7',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
]

const PROVIDER_SUGGESTIONS = ['opencode-go', 'google']

async function fetchWithFallback(url: string, init?: RequestInit): Promise<Response> {
  let res = await fetch(url, init)
  if (res.status === 404 && url.startsWith('/diveteam/')) {
    const fallbackRes = await fetch(url.replace('/diveteam/', '/farvater/'), init)
    if (fallbackRes.ok) res = fallbackRes
  }
  return res
}

export async function fetchRoles(): Promise<Role[]> {
  const res = await fetchWithFallback('/diveteam/roles')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { ok?: boolean; error?: string; roles?: Role[] }
  if (!data.ok) throw new Error(data.error ?? 'request failed')
  return data.roles ?? []
}

async function saveRole(role: Role, isNew: boolean): Promise<void> {
  const res = await fetchWithFallback('/diveteam/roles', {
    method: isNew ? 'POST' : 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(role),
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
}

async function deleteRole(id: string): Promise<void> {
  const res = await fetchWithFallback(`/diveteam/roles?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
}

function buildRolePromptTemplate(role: Role): string {
  const displayName = role.name || role.id
  const isoNote =
    role.isolationMode === 'git_worktree'
      ? 'Ты работаешь в изолированном Git worktree (`worktrees/<repo>/task-<id>`). Всегда коммить изменения в ветку задачи.'
      : role.isolationMode === 'host_exclusive'
        ? 'Ты работаешь с эксклюзивной блокировкой хоста (`host.lock`). Перед критическими операциями запрашивай аппрув через `diveteam_request_approval`.'
        : role.isolationMode === 'notes_vault'
          ? 'Твоя рабочая директория — хранилище знаний `/home/slava/Projects/DSH/vault`. После изменений синхронизируй граф через `vault-sync`.'
          : 'Ты работаешь в режиме координации и анализа без блокировки воркеров.'

  return [
    `Ты — **${displayName}** (\`${role.id}\`), специализированный агент системы «DiveTeam».`,
    role.description ? `\n**Назначение роли:** ${role.description}` : '',
    '',
    '### 1. Зона ответственности и режим работы',
    `- ${isoNote}`,
    '- Изучай входной контекст задачи и при необходимости сверяйся с базой знаний (`vault-sync query "<запрос>"`).',
    '- Выполняй порученную задачу автономно, структурированно и до конца.',
    '',
    '### 2. Правила взаимодействия в Канбане',
    '- **Важно:** В фоновом режиме Канбана НИКОГДА не вызывай интерактивный инструмент `ask_user_question`.',
    '- Если для продолжения критически необходимо решение пользователя (`@slava`), вызови `diveteam_request_approval(taskId, summary)` и заверши ход.',
    '- По завершении работы оставь чёткий итоговый отчёт: что сделано, какие файлы изменены и какие проверки выполнены.',
  ]
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
    .join('\n')
}

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
const btnStyle: CSSProperties = {
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

/** The role editor: roster on the left, editable or creation form on the right. */
export function AgentsPanel({
  initialCreateMode = false,
  onConsumedCreateMode,
}: {
  initialCreateMode?: boolean
  onConsumedCreateMode?: () => void
} = {}): ReactElement {
  const isDark = useIsDarkTheme()
  const [roles, setRoles] = useState<Role[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState<boolean>(false)
  const [draft, setDraft] = useState<Role | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const makeBlankRole = useCallback((existingRoles: Role[] | null): Role => {
    const nextOrder = ((existingRoles?.length ?? 6) + 1) * 10
    return {
      id: '',
      name: `${(existingRoles?.length ?? 6) + 1}. Новая роль`,
      description: '',
      order: nextOrder,
      defaultProvider: 'opencode-go',
      defaultModel: 'deepseek-v4.1-flash',
      isolationMode: 'none',
      heavyWorker: false,
      body: '',
      isCore: false,
    }
  }, [])

  const startCreating = useCallback(() => {
    const blank = makeBlankRole(roles)
    blank.body = buildRolePromptTemplate({ ...blank, id: 'custom-role' })
    setIsCreating(true)
    setDraft(blank)
    setError(null)
    setSaved(false)
  }, [makeBlankRole, roles])

  const load = useCallback(async (selectId?: string) => {
    try {
      const list = await fetchRoles()
      setRoles(list)
      setError(null)
      if (selectId && list.some((r) => r.id === selectId)) {
        setSelected(selectId)
      } else {
        setSelected((prev) => (prev !== null && list.some((r) => r.id === prev) ? prev : (list[0]?.id ?? null)))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (initialCreateMode && roles !== null) {
      startCreating()
      onConsumedCreateMode?.()
    }
  }, [initialCreateMode, roles, startCreating, onConsumedCreateMode])

  useEffect(() => {
    if (isCreating || roles === null) return
    setDraft(roles.find((r) => r.id === selected) ?? null)
  }, [roles, selected, isCreating])

  const update = (patch: Partial<Role>): void => {
    setSaved(false)
    setDraft((prev) => (prev === null ? null : { ...prev, ...patch }))
  }

  const save = async (): Promise<void> => {
    if (draft === null) return
    const cleanId = draft.id.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(cleanId)) {
      setError('Укажите корректный ID роли латиницей (например: analyst, secops, designer)')
      return
    }
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const payload: Role = { ...draft, id: cleanId, name: draft.name.trim() || cleanId }
      await saveRole(payload, isCreating)
      setIsCreating(false)
      setSaved(true)
      await load(cleanId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!draft || isCreating || CORE_ROLE_IDS.has(draft.id)) return
    if (!window.confirm(`Удалить пользовательскую роль «${draft.name}» (${draft.id})?`)) return
    setSaving(true)
    setError(null)
    try {
      await deleteRole(draft.id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (roles === null) return <p style={{ opacity: 0.7 }}>{error ?? t('agents.loading')}</p>

  const isCoreRole = draft ? CORE_ROLE_IDS.has(draft.id) : false

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', overflow: 'hidden' }}>
      <div style={{ width: 230, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
        <button
          type="button"
          onClick={startCreating}
          style={{
            ...btnStyle,
            width: '100%',
            fontWeight: 600,
            background: isCreating ? '#2563eb' : (isDark ? 'rgba(59,130,246,0.2)' : 'rgba(59,130,246,0.1)'),
            borderColor: isCreating ? '#3b82f6' : (isDark ? 'rgba(59,130,246,0.5)' : '#93c5fd'),
            color: isCreating ? '#ffffff' : (isDark ? '#93c5fd' : '#1d4ed8'),
            boxShadow: isCreating ? '0 2px 6px rgba(37,99,235,0.35)' : 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <Plus size={15} weight="bold" /> {t('agents.new')}
        </button>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {roles.map((role) => {
            const activeItem = !isCreating && selected === role.id
            return (
              <li key={role.id}>
                <button
                  type="button"
                  onClick={() => {
                    setIsCreating(false)
                    setSaved(false)
                    setError(null)
                    setSelected(role.id)
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: activeItem
                      ? '1px solid #3b82f6'
                      : `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'}`,
                    background: activeItem
                      ? (isDark ? 'rgba(59,130,246,0.22)' : 'rgba(59,130,246,0.1)')
                      : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)'),
                    color: activeItem
                      ? (isDark ? '#ffffff' : '#1d4ed8')
                      : (isDark ? '#cbd5e1' : '#334155'),
                    fontWeight: activeItem ? 600 : 400,
                    cursor: 'pointer',
                    font: 'inherit',
                    boxShadow: activeItem ? '0 1px 4px rgba(0,0,0,0.2)' : 'none',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ display: 'inline-flex', flexShrink: 0, color: activeItem ? (isDark ? '#93c5fd' : '#2563eb') : 'inherit' }}>
                      {getRoleIcon(role.id, 15)}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {stripEmoji(role.name)}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.7, marginLeft: 22 }}>@{role.id} · {role.isolationMode}</div>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      {draft === null ? (
        <p style={{ opacity: 0.7 }}>{t('agents.empty')}</p>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', paddingRight: 8, paddingBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>
              {isCreating ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Sparkle size={16} /> {t('agents.createTitle')}
                </span>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {getRoleIcon(draft.id, 17)} Редактирование роли: {stripEmoji(draft.name)}
                </span>
              )}
            </h3>
            {!isCreating && !isCoreRole ? (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={saving}
                style={{ ...btnStyle, color: '#b71c1c', borderColor: 'rgba(183,28,28,0.35)', padding: '6px 12px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}
              >
                <Trash size={14} /> {t('agents.delete')}
              </button>
            ) : null}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>{isCreating ? t('agents.idEditable') : t('agents.id')}</label>
              <input
                style={isCreating ? inputStyle : { ...inputStyle, opacity: 0.6 }}
                value={draft.id}
                readOnly={!isCreating}
                placeholder="например: analyst, secops, designer"
                onChange={(e) => update({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
              />
            </div>
            <div>
              <label style={labelStyle}>{t('agents.order')}</label>
              <input
                style={inputStyle}
                type="number"
                value={draft.order}
                onChange={(e) => update({ order: Number(e.target.value) })}
              />
            </div>
          </div>

          <label style={labelStyle}>{t('agents.name')}</label>
          <input
            style={inputStyle}
            value={draft.name}
            placeholder="7. Analyst (Аналитик)"
            onChange={(e) => update({ name: stripEmoji(e.target.value) })}
          />

          <label style={labelStyle}>{t('agents.description')}</label>
          <input
            style={inputStyle}
            value={draft.description}
            placeholder="Краткое описание обязанностей и специализации агента…"
            onChange={(e) => update({ description: e.target.value })}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>{t('agents.provider')}</label>
              <input
                style={inputStyle}
                list="diveteam-provider-list"
                value={draft.defaultProvider}
                onChange={(e) => update({ defaultProvider: e.target.value })}
              />
              <datalist id="diveteam-provider-list">
                {PROVIDER_SUGGESTIONS.map((p) => <option key={p} value={p} />)}
              </datalist>
            </div>
            <div>
              <label style={labelStyle}>{t('agents.model')}</label>
              <input
                style={inputStyle}
                list="diveteam-model-list"
                value={draft.defaultModel}
                onChange={(e) => update({ defaultModel: e.target.value })}
              />
              <datalist id="diveteam-model-list">
                {MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
              </datalist>
            </div>
          </div>

          <label style={labelStyle}>{t('agents.isolation')}</label>
          <select style={inputStyle} value={draft.isolationMode} onChange={(e) => update({ isolationMode: e.target.value })}>
            {ISOLATION_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>{mode.label}</option>
            ))}
          </select>

          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.heavyWorker} onChange={(e) => update({ heavyWorker: e.target.checked })} />
            {t('agents.heavyWorker')}
          </label>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>{t('agents.prompt')}</label>
            <button
              type="button"
              onClick={() => update({ body: buildRolePromptTemplate(draft) })}
              style={{ ...btnStyle, padding: '4px 10px', fontSize: 12 }}
            >
              {t('agents.template')}
            </button>
          </div>
          <textarea
            style={{ ...inputStyle, minHeight: 300, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.45 }}
            value={draft.body}
            placeholder="Введите системный промпт роли в формате Markdown…"
            onChange={(e) => update({ body: e.target.value })}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              style={{
                ...btnStyle,
                fontWeight: 600,
                background: '#2563eb',
                borderColor: '#3b82f6',
                color: '#ffffff',
                boxShadow: '0 2px 6px rgba(37,99,235,0.35)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {saving ? (
                <>
                  <CircleNotch size={14} className="diveteam-spin farvater-spin" /> {t('agents.saving')}
                </>
              ) : isCreating ? (
                <>
                  <Plus size={14} weight="bold" /> {t('agents.create')}
                </>
              ) : (
                <>
                  <FloppyDisk size={14} /> {t('agents.save')}
                </>
              )}
            </button>
            {isCreating ? (
              <button
                type="button"
                onClick={() => {
                  setIsCreating(false)
                  setError(null)
                }}
                disabled={saving}
                style={btnStyle}
              >
                {t('agents.cancel')}
              </button>
            ) : null}
            {saved ? (
              <span style={{ color: '#2e7d32', fontWeight: 500, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <CheckCircle size={14} weight="bold" /> {t('agents.saved')}
              </span>
            ) : null}
            {error ? (
              <span role="alert" style={{ color: '#b71c1c', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <WarningCircle size={14} weight="bold" /> {error}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
