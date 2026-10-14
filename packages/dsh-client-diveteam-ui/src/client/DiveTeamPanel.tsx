/**
 * DiveTeam control panel: one page with six internal section tabs.
 *
 * (Tasks, Monitoring, Workflow, Agents, Memory, Telegram).
 */
import { useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  Kanban,
  Gauge,
  GitFork,
  Robot,
  Brain,
  PaperPlaneTilt,
} from '@phosphor-icons/react'
import { AgentsPanel } from './AgentsPanel.tsx'
import { TasksPanel } from './TasksPanel.tsx'
import { MemoryPanel } from './MemoryPanel.tsx'
import { TelegramPanel } from './TelegramPanel.tsx'
import { MonitoringPanel } from './MonitoringPanel.tsx'
import { WorkflowPanel } from './WorkflowPanel.tsx'
import { t, type DiveTeamKey } from './locales.ts'

import { useIsDarkTheme } from './theme.ts'

export type DiveTeamSection = 'tasks' | 'monitoring' | 'workflow' | 'agents' | 'memory' | 'telegram'
export type FarvaterSection = DiveTeamSection

const SECTION_ICONS: Record<DiveTeamSection, typeof Kanban> = {
  tasks: Kanban,
  monitoring: Gauge,
  workflow: GitFork,
  agents: Robot,
  memory: Brain,
  telegram: PaperPlaneTilt,
}

/** Section ids in display order (Kanban first, Dispatcher & Workflow next), with their localized label keys. */
const SECTIONS: readonly { id: DiveTeamSection; label: DiveTeamKey }[] = [
  { id: 'tasks', label: 'section.tasks' },
  { id: 'monitoring', label: 'section.monitoring' },
  { id: 'workflow', label: 'section.workflow' },
  { id: 'agents', label: 'section.agents' },
  { id: 'memory', label: 'section.memory' },
  { id: 'telegram', label: 'section.telegram' },
]

/** The panel with tabs; Kanban ('tasks') is the first and default tab. */
export function DiveTeamPanel(): ReactElement {
  const isDark = useIsDarkTheme()
  const [active, setActive] = useState<DiveTeamSection>('tasks')
  const [createRoleOnOpen, setCreateRoleOnOpen] = useState(false)

  const handleOpenRoleCreator = (): void => {
    setCreateRoleOnOpen(true)
    setActive('agents')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '12px 16px 16px' }}>
      <style>{`
        @keyframes diveteam-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .diveteam-spin, .farvater-spin {
          animation: diveteam-spin 1s linear infinite;
        }
      `}</style>
      <nav role="tablist" aria-label={t('panel.label')} style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {SECTIONS.map((section) => {
          const isSelected = active === section.id
          const Icon = SECTION_ICONS[section.id]
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              style={{
                padding: '8px 14px',
                borderRadius: 6,
                border: isSelected
                  ? '1px solid #3b82f6'
                  : `1px solid ${isDark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.12)'}`,
                background: isSelected
                  ? (isDark ? 'rgba(59, 130, 246, 0.22)' : 'rgba(59, 130, 246, 0.1)')
                  : (isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)'),
                color: isSelected
                  ? (isDark ? '#ffffff' : '#1d4ed8')
                  : (isDark ? '#cbd5e1' : '#475569'),
                cursor: 'pointer',
                font: 'inherit',
                fontSize: 13,
                fontWeight: isSelected ? 700 : 500,
                boxShadow: isSelected ? '0 2px 6px rgba(0, 0, 0, 0.2)' : 'none',
                transition: 'all 0.15s ease',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
              }}
              onClick={() => {
                if (section.id !== 'agents') setCreateRoleOnOpen(false)
                setActive(section.id)
              }}
            >
              <Icon size={16} weight={isSelected ? 'bold' : 'regular'} />
              <span>{t(section.label)}</span>
            </button>
          )
        })}
      </nav>
      <section role="tabpanel" aria-label={t(SECTIONS.find((s) => s.id === active)!.label)} style={{ flex: 1, minHeight: 0 }}>
        {active === 'tasks' ? (
          <TasksPanel />
        ) : active === 'monitoring' ? (
          <MonitoringPanel />
        ) : active === 'workflow' ? (
          <WorkflowPanel />
        ) : active === 'agents' ? (
          <AgentsPanel
            initialCreateMode={createRoleOnOpen}
            onConsumedCreateMode={() => setCreateRoleOnOpen(false)}
          />
        ) : active === 'memory' ? (
          <MemoryPanel />
        ) : (
          <TelegramPanel />
        )}
      </section>
    </div>
  )
}

export const FarvaterPanel = DiveTeamPanel

