/**
 * Client half of @diveteam/dsh-client-diveteam-ui.
 *
 * Registers one sidebar row ("DiveTeam") and one center-column page with six
 * sections — Tasks, Monitoring, Workflow, Agents, Memory, Telegram. The page is a single
 * panel; the sections are internal tabs of that panel, not separate slots.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { DiveTeamPanel } from './DiveTeamPanel.tsx'
import { DiveTeamPanelIcon } from './DiveTeamPanelIcon.tsx'
import { en, ru, setRuntimeTranslate, type DiveTeamKey } from './locales.ts'

/** Locale namespace owned by this plugin. */
const NS = 'diveteam'

/** Sidebar row order: placed first (-100) ahead of Plugins (0) and Schedule (10). */
const PANEL_ORDER = -100

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** DiveTeam control-panel copy. */
    diveteam: DiveTeamKey
    farvater?: DiveTeamKey
  }
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the DiveTeam button and panel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    ctx.locale.register(NS, { en, ru })
    ctx.locale.register('farvater', { en, ru })
  }, 'diveteam: dictionaries')

  ctx.effect(() => {
    const reg = ctx.locale.register as any
    const disposers: Array<() => void> = []
    const applyUngroupedLabel = () => {
      try {
        const d1 = reg('workspace', {
          en: { 'group.ungrouped': 'Задачи агента' },
          ru: { 'group.ungrouped': 'Задачи агента' },
        })
        if (typeof d1 === 'function') disposers.push(d1)
      } catch { /* ignore */ }
      try {
        const d2 = reg('workspace', 'ru', { 'group.ungrouped': 'Задачи агента' })
        if (typeof d2 === 'function') disposers.push(d2)
      } catch { /* ignore */ }
      try {
        const d3 = reg('dsh-context', 'ru', { 'ov.group.ungrouped': 'Задачи агента' })
        if (typeof d3 === 'function') disposers.push(d3)
      } catch { /* ignore */ }
    }
    applyUngroupedLabel()
    const timer = setTimeout(applyUngroupedLabel, 1200)
    return () => {
      clearTimeout(timer)
      for (const dispose of disposers) {
        try { dispose() } catch { /* ignore */ }
      }
    }
  }, 'diveteam: workspace ungrouped override')

  try {
    setRuntimeTranslate(ctx.locale.bind(NS))
  } catch {
    /* locale missing: the module-level t keeps its Russian fallback */
  }

  // Sidebar row: the shell owns the button, label and rail geometry; this
  // component draws only the glyph (see ui-sidebar's `sidebar.panellist`).
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'diveteam',
    order: PANEL_ORDER,
    label: () => ctx.locale.bind(NS)('entry.label'),
  }, DiveTeamPanelIcon))

  // Center-column page: mounted only while the panel is selected.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'diveteam',
    inject: () => ({}),
  }, DiveTeamPanel))

  // Legacy route key fallback
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'farvater',
    inject: () => ({}),
  }, DiveTeamPanel))
}
