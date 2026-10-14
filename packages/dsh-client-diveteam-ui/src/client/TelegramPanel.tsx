/**
 * Phase E — Telegram panel («Telegram»):
 * Shows live bot profile (@farvater_shturman_bot via getMe), KDE Wallet source
 * (`Telegram_bot_tokens / farvater_shturman_bot`), whitelisted owner ID (`81815557`),
 * Clarify (@slava) pending approvals with 1-click Approve/Reject, command / Shturman
 * dialogue input, and incoming/outgoing message journal.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  PaperPlaneTilt,
  Circle,
  PencilSimple,
  Compass,
  Key,
  ShieldCheck,
  ArrowsClockwise,
  Gear,
  Pause,
  CheckCircle,
  XCircle,
  ChartBar,
  ListChecks,
  PaperPlaneRight,
  ArrowDownLeft,
  ArrowUpRight,
  Prohibit,
  Warning,
  Play,
  Lock,
  LockOpen,
  WarningOctagon,
} from '@phosphor-icons/react'

function renderCleanMessageText(text: string): ReactElement {
  if (!text) return <></>

  let leadingIcon: ReactElement | null = null
  const trimmed = text.trim()

  if (trimmed.startsWith('\u2708\uFE0F') || trimmed.startsWith('\u2708')) {
    leadingIcon = <PaperPlaneTilt size={14} color="#3b82f6" weight="bold" />
  } else if (trimmed.startsWith('\u2705')) {
    leadingIcon = <CheckCircle size={14} color="#16a34a" weight="bold" />
  } else if (trimmed.startsWith('\u274C')) {
    leadingIcon = <XCircle size={14} color="#dc2626" weight="bold" />
  } else if (trimmed.startsWith('\u26A0\uFE0F') || trimmed.startsWith('\u26A0')) {
    leadingIcon = <Warning size={14} color="#f59e0b" weight="bold" />
  } else if (trimmed.startsWith('\u{1F504}')) {
    leadingIcon = <ArrowsClockwise size={14} color="#3b82f6" weight="bold" />
  } else if (trimmed.startsWith('\u{1F6D1}')) {
    leadingIcon = <Prohibit size={14} color="#ef4444" weight="bold" />
  } else if (trimmed.startsWith('\u23F8\uFE0F') || trimmed.startsWith('\u23F8')) {
    leadingIcon = <Pause size={14} color="#f59e0b" weight="bold" />
  } else if (trimmed.startsWith('\u25B6\uFE0F') || trimmed.startsWith('\u25B6')) {
    leadingIcon = <Play size={14} color="#16a34a" weight="bold" />
  } else if (trimmed.startsWith('\u{1F4CB}')) {
    leadingIcon = <ListChecks size={14} color="#3b82f6" weight="bold" />
  } else if (trimmed.startsWith('\u{1F4DD}')) {
    leadingIcon = <PencilSimple size={14} color="#6366f1" weight="bold" />
  } else if (trimmed.startsWith('\u{1F9ED}')) {
    leadingIcon = <Compass size={14} color="#3b82f6" weight="bold" />
  } else if (trimmed.startsWith('\u{1F512}')) {
    leadingIcon = <Lock size={14} color="#64748b" weight="bold" />
  } else if (trimmed.startsWith('\u{1F513}')) {
    leadingIcon = <LockOpen size={14} color="#22c55e" weight="bold" />
  } else if (trimmed.startsWith('\u{1F6A8}')) {
    leadingIcon = <WarningOctagon size={14} color="#ef4444" weight="bold" />
  } else if (trimmed.startsWith('\u{1F7E2}')) {
    leadingIcon = <Circle size={10} weight="fill" color="#16a34a" />
  }

  // Strip all emojis from text so none remain in the text content
  const cleanBody = text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .trim()

  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      {leadingIcon ? <span style={{ display: 'inline-flex', marginTop: 3, flexShrink: 0 }}>{leadingIcon}</span> : null}
      <span>{cleanBody}</span>
    </div>
  )
}

interface TelegramHistoryItem {
  id: string
  direction: 'in' | 'out' | 'blocked'
  text: string
  at: string
  delivered?: boolean
  chatId?: string
  fromId?: string
  note?: string
}

interface ClarifyTask {
  id: string
  title: string
  role: string
  status: string
  phase: string
  approvalRequested?: string | null
  updatedAt: string
}

interface BotProfile {
  id: number
  username: string
  firstName: string
}

interface TelegramSessionInfo {
  sessionId: string | null
  title: string
  messageCount: number
  updatedAt?: string | null
}

interface TelegramStatus {
  enabled: boolean
  hasToken: boolean
  maskedToken: string
  tokenLength?: number
  tokenSource?: string
  kwalletEntry?: string
  allowedChatId: string
  allowedUserId?: string
  botProfile?: BotProfile | null
  polling: boolean
  typing?: boolean
  telegramSession?: TelegramSessionInfo
  history: TelegramHistoryItem[]
  clarifyTasks: ClarifyTask[]
}

const cardStyle: CSSProperties = {
  padding: 14,
  borderRadius: 6,
  border: '1px solid rgba(0,0,0,0.1)',
  background: 'rgba(0,0,0,0.02)',
  marginBottom: 14,
}

const buttonStyle: CSSProperties = {
  padding: '6px 12px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 13,
  borderRadius: 4,
  border: '1px solid rgba(0,0,0,0.2)',
  background: 'transparent',
}

const inputStyle: CSSProperties = {
  padding: '6px 10px',
  boxSizing: 'border-box',
  font: 'inherit',
  fontSize: 13,
  borderRadius: 4,
  border: '1px solid rgba(0,0,0,0.18)',
  background: 'transparent',
  color: 'inherit',
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

export function TelegramPanel(): ReactElement {
  const [state, setState] = useState<TelegramStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cmdInput, setCmdInput] = useState<string>('')
  const [showConfig, setShowConfig] = useState<boolean>(false)
  const [tokenInput, setTokenInput] = useState<string>('')
  const [chatIdInput, setChatIdInput] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)

  const load = useCallback(async () => {
    try {
      const data = await api('/diveteam/telegram')
      setState(data as TelegramStatus)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 4000)
    return () => clearInterval(timer)
  }, [load])

  const sendTest = async (): Promise<void> => {
    setBusy(true)
    try {
      const botTag = state?.botProfile?.username ? `@${state.botProfile.username}` : '@farvater_shturman_bot'
      const data = await api('/diveteam/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'send_test',
          text: `Проверка связи из панели «DiveTeam» (${botTag}, KDE Wallet: Telegram_bot_tokens / farvater_shturman_bot)`,
        }),
      })
      setState(data as TelegramStatus)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const reloadKwallet = async (): Promise<void> => {
    setBusy(true)
    try {
      const data = await api('/diveteam/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reload_kwallet' }),
      })
      setState(data as TelegramStatus)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const resetTelegramSession = async (): Promise<void> => {
    setBusy(true)
    try {
      const data = await api('/diveteam/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'new_session' }),
      })
      setState(data as TelegramStatus)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const runCommand = async (textOverride?: string): Promise<void> => {
    const text = (textOverride ?? cmdInput).trim()
    if (!text) return
    setBusy(true)
    try {
      const data = await api('/diveteam/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'command', text }),
      })
      setState(data as TelegramStatus)
      if (!textOverride) setCmdInput('')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveConfig = async (): Promise<void> => {
    setBusy(true)
    try {
      const data = await api('/diveteam/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'configure',
          token: tokenInput,
          allowedChatId: chatIdInput || state?.allowedChatId || '81815557',
        }),
      })
      setState(data as TelegramStatus)
      setShowConfig(false)
      setTokenInput('')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!state) {
    return <p style={{ opacity: 0.7 }}>{error ?? 'Загрузка статуса Telegram…'}</p>
  }

  const botUsername = state.botProfile?.username ? `@${state.botProfile.username}` : '@farvater_shturman_bot'
  const botFirstName = state.botProfile?.firstName || 'Shturman'

  return (
    <div style={{ height: '100%', overflowY: 'auto', paddingRight: 8, paddingBottom: 24 }}>
      {error ? <div role="alert" style={{ color: 'red', marginBottom: 12, fontSize: 13 }}>{error}</div> : null}

      {/* Bot Connection Status Card */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><PaperPlaneTilt size={16} /> Статус моста Telegram:</span>{' '}
              <span style={{ color: state.enabled ? '#0a8f46' : '#b36b00' }}>
                {state.enabled ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Circle size={10} weight="fill" color="#16a34a" />
                    <span>Подключён: {botUsername} ({botFirstName}) · Поллинг: {state.polling ? 'Активен' : 'Ожидание'}</span>
                    {state.typing ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        · <PencilSimple size={12} /> Штурман печатает…
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Circle size={10} weight="fill" color="#eab308" />
                    Локальный режим (токен не загружен)
                  </span>
                )}
              </span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.55 }}>
              <div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Compass size={14} /> Привязанная сессия Штурмана:</span>{' '}
                {state.telegramSession?.sessionId ? (
                  <span>
                    <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <PaperPlaneTilt size={13} weight="bold" />
                      {(state.telegramSession.title || 'Telegram · Штурман (@slava)').replace(/[\u2708\uFE0F\u2708]\s*/g, '').trim()}
                    </strong>{' '}
                    · ID: <code>{state.telegramSession.sessionId}</code> · сообщ.: {state.telegramSession.messageCount}
                  </span>
                ) : (
                  <span>будет создана автоматически при первом сообщении («Telegram · Штурман (@slava)»)</span>
                )}
              </div>
              <div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Key size={14} /> Источник токена:</span>{' '}
                <code>{state.kwalletEntry || 'KDE Wallet: Telegram_bot_tokens / farvater_shturman_bot'}</code>
                {state.tokenSource ? <span> ({state.tokenSource})</span> : null} · Токен:{' '}
                <code>{state.maskedToken || 'не задан'}</code>
              </div>
              <div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ShieldCheck size={14} /> Авторизованный владелец (<code>chat.id</code> и <code>from.id</code>):</span>{' '}
                <code>{state.allowedChatId || '81815557'}</code>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              style={{ ...buttonStyle, borderColor: 'rgba(0,110,210,0.45)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => void resetTelegramSession()}
              disabled={busy}
              title="Создать новую чистую сессию «Telegram · Штурман (@slava)» (аналог /new в Telegram)"
            >
              <ArrowsClockwise size={14} /> Новая сессия Штурмана (/new)
            </button>
            <button
              type="button"
              style={{ ...buttonStyle, borderColor: 'rgba(10,143,70,0.45)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => void sendTest()}
              disabled={busy}
            >
              <PaperPlaneTilt size={14} /> Отправить тестовое сообщение
            </button>
            <button
              type="button"
              style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => void reloadKwallet()}
              disabled={busy}
              title="Автоматически подхватить токен из KDE Wallet (Telegram_bot_tokens / farvater_shturman_bot)"
            >
              <Key size={14} /> Обновить из KDE Wallet
            </button>
            <button
              type="button"
              style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => {
                setChatIdInput(state.allowedChatId || '81815557')
                setShowConfig((v) => !v)
              }}
            >
              <Gear size={14} /> Настроить
            </button>
          </div>
        </div>

        {showConfig ? (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.08)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              style={{ ...inputStyle, flex: 2, minWidth: 220 }}
              type="password"
              value={tokenInput}
              placeholder="Токен в памяти (оставьте пустым для KDE Wallet)"
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <input
              style={{ ...inputStyle, flex: 1, minWidth: 140 }}
              value={chatIdInput}
              placeholder="Разрешённый ID (81815557)"
              onChange={(e) => setChatIdInput(e.target.value)}
            />
            <button type="button" style={buttonStyle} onClick={() => void saveConfig()} disabled={busy}>
              Применить
            </button>
          </div>
        ) : null}
      </div>

      {/* Pending Approvals (Clarify @slava) */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 10px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Pause size={16} /> Задачи, ожидающие решения @slava ({state.clarifyTasks.length})
        </h3>
        {state.clarifyTasks.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, opacity: 0.6 }}>Нет задач, ожидающих подтверждения.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {state.clarifyTasks.map((t) => (
              <div
                key={t.id}
                style={{
                  padding: 10,
                  borderRadius: 6,
                  border: '1px solid rgba(200,140,0,0.35)',
                  background: 'rgba(255,190,0,0.06)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div>
                    <strong>{t.title}</strong>{' '}
                    <code style={{ fontSize: 11, opacity: 0.75 }}>({t.id.slice(0, 8)} · @{t.role})</code>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      style={{ ...buttonStyle, padding: '4px 10px', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                      onClick={() => void runCommand(`/approve ${t.id.slice(0, 8)}`)}
                      disabled={busy}
                    >
                      <CheckCircle size={14} weight="bold" /> Одобрить (/approve)
                    </button>
                    <button
                      type="button"
                      style={{ ...buttonStyle, padding: '4px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                      onClick={() => void runCommand(`/reject ${t.id.slice(0, 8)} Отклонено из панели`)}
                      disabled={busy}
                    >
                      <XCircle size={14} weight="bold" /> Отклонить (/reject)
                    </button>
                  </div>
                </div>
                {t.approvalRequested ? (
                  <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', opacity: 0.85 }}>{t.approvalRequested}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Command bar (`/status`, `/tasks`, `/approve`, `/reject`, or live Shturman message) */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button
          type="button"
          style={{ ...buttonStyle, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}
          onClick={() => void runCommand('/status')}
          disabled={busy}
        >
          <ChartBar size={14} /> /status
        </button>
        <button
          type="button"
          style={{ ...buttonStyle, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}
          onClick={() => void runCommand('/tasks')}
          disabled={busy}
        >
          <ListChecks size={14} /> /tasks
        </button>
        <input
          style={{ ...inputStyle, flex: 1, minWidth: 240 }}
          value={cmdInput}
          placeholder="Команда (/status, /tasks, /approve <id>, /reject <id>) или сообщение Штурману (@shturman)…"
          onChange={(e) => setCmdInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runCommand() }}
        />
        <button
          type="button"
          style={{ ...buttonStyle, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => void runCommand()}
          disabled={busy}
        >
          <PaperPlaneRight size={14} weight="fill" /> Отправить
        </button>
      </div>

      {/* Journal of commands and notifications */}
      <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>
        Журнал входящих и исходящих сообщений Telegram ({state.history.length})
      </h3>
      {state.history.length === 0 ? (
        <p style={{ opacity: 0.6, fontSize: 13 }}>Журнал пока пуст.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {state.history.map((item) => (
            <div
              key={item.id}
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                border: '1px solid rgba(0,0,0,0.08)',
                background: item.direction === 'in' ? 'rgba(0,120,255,0.04)' : 'rgba(0,0,0,0.02)',
                fontSize: 13,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.65, marginBottom: 4 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {item.direction === 'in' ? (
                    <>
                      <ArrowDownLeft size={13} /> Входящее ({item.chatId || '81815557'})
                    </>
                  ) : item.direction === 'blocked' ? (
                    <>
                      <Prohibit size={13} /> Заблокировано
                    </>
                  ) : (
                    <>
                      <ArrowUpRight size={13} /> Исходящее в Telegram ({item.delivered ? 'доставлено' : 'локально'})
                    </>
                  )}
                  {item.note ? ` · ${item.note}` : ''}
                </span>
                <span>{new Date(item.at).toLocaleTimeString()}</span>
              </div>
              {renderCleanMessageText(item.text)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
