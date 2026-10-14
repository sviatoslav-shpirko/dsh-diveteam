/**
 * Phase D — Memory panel: Vault file browser & editor (`CORE.md`, `proposals/`,
 * `lessons/`, `notes/`, `inbox/`, `tasks/done/`), `CORE.md` proposal review
 * (apply/reject), and `graphify` knowledge graph search.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  BookBookmark,
  Lightbulb,
  BookOpen,
  NotePencil,
  Tray,
  Archive,
  TreeStructure,
  MagnifyingGlass,
  FileText,
  CheckCircle,
  Trash,
  FloppyDisk,
  Plus,
  CircleNotch,
} from '@phosphor-icons/react'

interface VaultFileEntry {
  path: string
  name: string
  category: 'core' | 'proposals' | 'lessons' | 'notes' | 'inbox' | 'tasks' | 'graph' | string
  size: number
  updatedAt: string
}

interface GraphSummary {
  exists: boolean
  nodesCount: number
  edgesCount: number
  communities: string[]
  builtAtCommit: string | null
  updatedAt: string | null
}

interface GraphNodeMatch {
  id: string
  label: string
  kind: string
  community: string | null
  sourceFile: string | null
  sourceLocation: string | null
}

interface GraphEdgeMatch {
  source: string
  target: string
  relation: string
  sourceFile: string | null
}

interface FileSnippetMatch {
  path: string
  category: string
  snippets: string[]
}

interface GraphQueryResult {
  query: string
  nodes: GraphNodeMatch[]
  edges: GraphEdgeMatch[]
  fileMatches: FileSnippetMatch[]
}

const CATEGORY_LABELS: Record<string, string> = {
  core: 'Конституция (CORE.md)',
  proposals: 'Предложения к CORE.md',
  lessons: 'Технические уроки (lessons)',
  notes: 'Заметки (notes)',
  inbox: 'Входящие (inbox)',
  tasks: 'Архив задач (tasks/done)',
  graph: 'Отчёт графа (graphify)',
}

const CATEGORY_ICONS: Record<string, typeof BookBookmark> = {
  core: BookBookmark,
  proposals: Lightbulb,
  lessons: BookOpen,
  notes: NotePencil,
  inbox: Tray,
  tasks: Archive,
  graph: TreeStructure,
}

const CATEGORY_ORDER = ['core', 'proposals', 'notes', 'lessons', 'inbox', 'tasks', 'graph'] as const

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

function AutoGrowEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}): ReactElement {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, 180)}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: '100%',
        padding: '6px 0',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: 13,
        lineHeight: 1.55,
        border: 'none',
        outline: 'none',
        boxShadow: 'none',
        background: 'transparent',
        resize: 'none',
        overflow: 'hidden',
        color: 'inherit',
      }}
    />
  )
}

export function MemoryPanel(): ReactElement {
  const [files, setFiles] = useState<VaultFileEntry[]>([])
  const [graphSummary, setGraphSummary] = useState<GraphSummary | null>(null)
  const [selectedPath, setSelectedPath] = useState<string>('memory/CORE.md')
  const [fileContent, setFileContent] = useState<string>('')
  const [loadingFile, setLoadingFile] = useState<boolean>(false)
  const [saving, setSaving] = useState<boolean>(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [creatingNote, setCreatingNote] = useState<boolean>(false)
  const [newNoteSlug, setNewNoteSlug] = useState<string>('')

  const [graphQuery, setGraphQuery] = useState<string>('')
  const [graphResults, setGraphResults] = useState<GraphQueryResult | null>(null)
  const [searchingGraph, setSearchingGraph] = useState<boolean>(false)

  const loadList = useCallback(async () => {
    try {
      const data = await api('/diveteam/memory')
      setFiles(data.files as VaultFileEntry[])
      setGraphSummary(data.graphSummary as GraphSummary)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const openFile = useCallback(async (relPath: string) => {
    setSelectedPath(relPath)
    setGraphResults(null)
    setLoadingFile(true)
    setStatusMsg(null)
    try {
      const data = await api('/diveteam/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'read', path: relPath }),
      })
      setFileContent(String(data.content ?? ''))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingFile(false)
    }
  }, [])

  useEffect(() => {
    void loadList()
    void openFile('memory/CORE.md')
  }, [loadList, openFile])

  const saveCurrentFile = async (): Promise<void> => {
    if (!selectedPath) return
    setSaving(true)
    setStatusMsg(null)
    try {
      await api('/diveteam/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'write', path: selectedPath, content: fileContent }),
      })
      setStatusMsg('Сохранено')
      await loadList()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const createNewNote = async (): Promise<void> => {
    const clean = newNoteSlug.trim().replace(/\.md$/i, '').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, '-')
    if (!clean) return
    const relPath = `notes/${clean}.md`
    const initial = `---\ntitle: ${clean}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${clean}\n\n`
    try {
      await api('/diveteam/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'write', path: relPath, content: initial }),
      })
      setCreatingNote(false)
      setNewNoteSlug('')
      await loadList()
      await openFile(relPath)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleProposalAction = async (mode: 'apply' | 'reject'): Promise<void> => {
    if (!selectedPath.startsWith('memory/proposals/')) return
    setSaving(true)
    setStatusMsg(null)
    try {
      if (mode === 'apply') {
        await api('/diveteam/memory', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'apply_proposal', path: selectedPath }),
        })
        setStatusMsg('Предложение влито в CORE.md и синхронизировано с ролями')
      } else {
        await api('/diveteam/memory', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete', path: selectedPath }),
        })
        setStatusMsg('Предложение отклонено и удалено')
      }
      await loadList()
      await openFile('memory/CORE.md')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const runGraphSearch = async (): Promise<void> => {
    setSearchingGraph(true)
    setError(null)
    try {
      const data = await api('/diveteam/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'query_graph', query: graphQuery }),
      })
      setGraphResults(data as GraphQueryResult)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearchingGraph(false)
    }
  }

  const isProposal = selectedPath.startsWith('memory/proposals/')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12, overflow: 'hidden' }}>
      {/* Top search & graphify bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 12px',
          borderRadius: 6,
          background: 'rgba(0,0,0,0.03)',
          border: '1px solid rgba(0,0,0,0.08)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 260 }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            value={graphQuery}
            placeholder="Поиск по графу знаний graphify и заметкам vault/…"
            onChange={(e) => setGraphQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void runGraphSearch() }}
          />
          <button
            type="button"
            style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => void runGraphSearch()}
            disabled={searchingGraph}
          >
            {searchingGraph ? (
              <>
                <CircleNotch size={14} className="diveteam-spin farvater-spin" /> Поиск…
              </>
            ) : (
              <>
                <MagnifyingGlass size={14} /> Найти в графе
              </>
            )}
          </button>
          {graphResults ? (
            <button type="button" style={buttonStyle} onClick={() => setGraphResults(null)}>
              К редактору
            </button>
          ) : null}
        </div>
        {graphSummary ? (
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Граф <code>graphify</code>: <strong>{graphSummary.nodesCount}</strong> узлов · <strong>{graphSummary.edgesCount}</strong> связей
          </div>
        ) : null}
      </div>

      {error ? <div role="alert" style={{ color: 'red', fontSize: 13 }}>{error}</div> : null}

      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Left file tree */}
        <aside
          style={{
            width: 260,
            flexShrink: 0,
            overflowY: 'auto',
            borderRight: '1px solid rgba(0,0,0,0.1)',
            paddingRight: 12,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>Хранилище vault/</strong>
            <button
              type="button"
              style={{ ...buttonStyle, padding: '3px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              onClick={() => setCreatingNote((v) => !v)}
            >
              <Plus size={12} weight="bold" /> Заметка
            </button>
          </div>

          {creatingNote ? (
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <input
                style={{ ...inputStyle, flex: 1, padding: '4px 6px', fontSize: 12 }}
                value={newNoteSlug}
                placeholder="имя-заметки"
                onChange={(e) => setNewNoteSlug(e.target.value)}
              />
              <button type="button" style={{ ...buttonStyle, padding: '4px 8px', fontSize: 12 }} onClick={() => void createNewNote()}>
                Создать
              </button>
            </div>
          ) : null}

          {CATEGORY_ORDER.map((cat) => {
            const catFiles = files.filter((f) => f.category === cat)
            if (catFiles.length === 0) return null
            const CatIcon = CATEGORY_ICONS[cat]
            return (
              <div key={cat} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.65, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                  {CatIcon ? <CatIcon size={13} /> : null}
                  <span>{CATEGORY_LABELS[cat] ?? cat} ({catFiles.length})</span>
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {catFiles.map((f) => {
                    const active = !graphResults && selectedPath === f.path
                    return (
                      <li key={f.path}>
                        <button
                          type="button"
                          onClick={() => void openFile(f.path)}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            padding: '5px 8px',
                            borderRadius: 4,
                            border: 'none',
                            cursor: 'pointer',
                            font: 'inherit',
                            fontSize: 12,
                            background: active ? 'rgba(0,120,255,0.12)' : 'transparent',
                            fontWeight: active ? 600 : 400,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={f.path}
                        >
                          {f.name}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </aside>

        {/* Main content: Graph search results OR File viewer/editor */}
        <div style={{ flex: 1, overflowY: 'auto', paddingRight: 8, paddingBottom: 24 }}>
          {graphResults ? (
            <div>
              <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>
                Результаты поиска по графу: «{graphResults.query || 'все узлы'}»
              </h3>

              <h4 style={{ margin: '12px 0 8px', fontSize: 13, opacity: 0.8 }}>
                Совпадения в файлах ({graphResults.fileMatches.length})
              </h4>
              {graphResults.fileMatches.length === 0 ? (
                <p style={{ fontSize: 13, opacity: 0.6 }}>Текстовых совпадений не найдено.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {graphResults.fileMatches.map((m) => (
                    <div
                      key={m.path}
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        border: '1px solid rgba(0,0,0,0.1)',
                        background: 'rgba(0,0,0,0.02)',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => void openFile(m.path)}
                        style={{ ...buttonStyle, padding: '2px 8px', fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                      >
                        <FileText size={13} /> Открыть {m.path}
                      </button>
                      {m.snippets.map((s, idx) => (
                        <div key={idx} style={{ fontSize: 12, fontFamily: 'monospace', opacity: 0.85, marginTop: 2 }}>
                          {s}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              <h4 style={{ margin: '18px 0 8px', fontSize: 13, opacity: 0.8 }}>
                Узлы графа graphify ({graphResults.nodes.length})
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {graphResults.nodes.map((n) => (
                  <div
                    key={n.id}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      border: '1px solid rgba(0,0,0,0.08)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 13,
                    }}
                  >
                    <div>
                      <strong>{n.label}</strong>{' '}
                      <span style={{ fontSize: 11, opacity: 0.65 }}>({n.kind}{n.community ? ` · ${n.community}` : ''})</span>
                    </div>
                    {n.sourceFile ? (
                      <button
                        type="button"
                        style={{ ...buttonStyle, padding: '2px 8px', fontSize: 11 }}
                        onClick={() => void openFile(n.sourceFile!)}
                      >
                        {n.sourceFile}{n.sourceLocation ? `:${n.sourceLocation}` : ''}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>

              {graphResults.edges.length > 0 ? (
                <>
                  <h4 style={{ margin: '18px 0 8px', fontSize: 13, opacity: 0.8 }}>
                    Связи в графе ({graphResults.edges.length})
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
                    {graphResults.edges.map((e, idx) => (
                      <li key={idx}>
                        <strong>{e.source}</strong> —[<em>{e.relation}</em>]→ <strong>{e.target}</strong>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : (
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginBottom: 12,
                  paddingBottom: 8,
                  borderBottom: '1px solid rgba(0,0,0,0.1)',
                  flexWrap: 'wrap',
                }}
              >
                <code style={{ fontSize: 13, fontWeight: 600 }}>vault/{selectedPath}</code>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {isProposal ? (
                    <>
                      <button
                        type="button"
                        style={{ ...buttonStyle, borderColor: 'rgba(0,140,60,0.4)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                        onClick={() => void handleProposalAction('apply')}
                        disabled={saving}
                      >
                        <CheckCircle size={14} weight="bold" /> Принять в CORE.md
                      </button>
                      <button
                        type="button"
                        style={{ ...buttonStyle, borderColor: 'rgba(200,0,0,0.35)', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                        onClick={() => void handleProposalAction('reject')}
                        disabled={saving}
                      >
                        <Trash size={14} /> Отклонить
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                    onClick={() => void saveCurrentFile()}
                    disabled={saving || loadingFile}
                  >
                    {saving ? (
                      <>
                        <CircleNotch size={14} className="diveteam-spin farvater-spin" /> Сохранение…
                      </>
                    ) : (
                      <>
                        <FloppyDisk size={14} /> Сохранить
                      </>
                    )}
                  </button>
                  {statusMsg ? <span style={{ fontSize: 12, opacity: 0.8 }}>{statusMsg}</span> : null}
                </div>
              </div>

              {loadingFile ? (
                <p style={{ opacity: 0.6, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <CircleNotch size={14} className="diveteam-spin farvater-spin" /> Загрузка файла…
                </p>
              ) : (
                <AutoGrowEditor value={fileContent} onChange={setFileContent} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
