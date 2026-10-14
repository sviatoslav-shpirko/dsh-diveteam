/** Sidebar glyph for the DiveTeam panel, drawn at the shell's requested size. */
import type { ReactElement } from 'react'

/**
 * The shell owns the button, label and rail geometry; this component draws only
 * the glyph, like every other `sidebar.panellist` row.
 * @param props - the shell's icon share: square edge and selection state.
 * @returns the decorative panel glyph.
 */
export function DiveTeamPanelIcon({ size }: { size: number; active: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11M2.5 8h11" />
    </svg>
  )
}

export const FarvaterPanelIcon = DiveTeamPanelIcon
