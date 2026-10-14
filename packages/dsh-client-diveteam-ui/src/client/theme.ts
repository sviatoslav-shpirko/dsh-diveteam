/**
 * DiveTeam UI Theme Utilities:
 * Detects active theme (dark vs light) in DSH and provides high-contrast,
 * theme-adaptive styles for cards, buttons, inputs, badges, and canvas nodes.
 *
 * Guarantees that in dark theme no buttons or borders blend into the background.
 */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

export function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof document === 'undefined') return true
    return (
      document.body.hasAttribute('data-ds-dark-theme') ||
      document.documentElement.getAttribute('data-ds-theme-source') === 'dark' ||
      window.matchMedia('(prefers-color-scheme: dark)').matches
    )
  })

  useEffect(() => {
    const check = (): void => {
      const dark =
        document.body.hasAttribute('data-ds-dark-theme') ||
        document.documentElement.getAttribute('data-ds-theme-source') === 'dark' ||
        window.matchMedia('(prefers-color-scheme: dark)').matches
      setIsDark(dark)
    }

    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ds-theme-source', 'style'],
    })

    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    mql.addEventListener('change', check)

    return () => {
      observer.disconnect()
      mql.removeEventListener('change', check)
    }
  }, [])

  return isDark
}

export function getThemeTokens(isDark: boolean) {
  return {
    isDark,
    canvasBg: isDark ? '#0f111a' : '#f5f7fc',
    canvasDot: isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)',
    cardBg: isDark ? 'rgba(23, 26, 40, 0.95)' : '#ffffff',
    cardBorder: isDark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.14)',
    cardShadow: isDark
      ? '0 6px 20px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1)'
      : '0 4px 16px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.06)',

    btnBg: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)',
    btnBgHover: isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.08)',
    btnBorder: isDark ? 'rgba(255, 255, 255, 0.24)' : 'rgba(0, 0, 0, 0.22)',
    btnText: isDark ? '#f1f3f9' : '#1e293b',

    btnPrimaryBg: '#2563eb',
    btnPrimaryBorder: '#3b82f6',
    btnPrimaryText: '#ffffff',

    inputBg: isDark ? 'rgba(255, 255, 255, 0.06)' : '#ffffff',
    inputBorder: isDark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.22)',
    inputText: isDark ? '#f1f3f9' : '#0f172a',

    textPrimary: isDark ? '#f1f3f9' : '#0f172a',
    textSecondary: isDark ? '#94a3b8' : '#64748b',
    textMuted: isDark ? '#64748b' : '#94a3b8',

    wireStroke: isDark ? '#73799c' : '#94a3b8',
    wireActive: '#6366f1',
    portFill: '#ffffff',
    portStroke: isDark ? '#3b82f6' : '#2563eb',
  }
}

export function createAdaptiveStyles(isDark: boolean) {
  const t = getThemeTokens(isDark)

  const card: CSSProperties = {
    padding: 14,
    borderRadius: 8,
    border: `1px solid ${t.cardBorder}`,
    background: t.cardBg,
    color: t.textPrimary,
    boxShadow: t.cardShadow,
    marginBottom: 16,
  }

  const btn: CSSProperties = {
    padding: '7px 14px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 6,
    border: `1px solid ${t.btnBorder}`,
    background: t.btnBg,
    color: t.btnText,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    boxShadow: isDark ? '0 1px 3px rgba(0,0,0,0.4)' : '0 1px 2px rgba(0,0,0,0.06)',
    transition: 'all 0.15s ease',
  }

  const btnPrimary: CSSProperties = {
    ...btn,
    background: t.btnPrimaryBg,
    borderColor: t.btnPrimaryBorder,
    color: t.btnPrimaryText,
    fontWeight: 600,
    boxShadow: '0 2px 6px rgba(37,99,235,0.35)',
  }

  const input: CSSProperties = {
    padding: '6px 10px',
    borderRadius: 6,
    border: `1px solid ${t.inputBorder}`,
    background: t.inputBg,
    color: t.inputText,
    font: 'inherit',
    fontSize: 13,
    boxSizing: 'border-box',
    outline: 'none',
  }

  const select: CSSProperties = {
    ...input,
    cursor: 'pointer',
  }

  return { t, card, btn, btnPrimary, input, select }
}

export interface JiraStatusCategoryStyle {
  label: string
  bg: string
  border: string
  titleColor: string
  subtext?: string
  lozengeBg: string
  lozengeText: string
  lozengeBorder: string
  accentColor: string
  countBadgeBg: string
  countBadgeText: string
}

export function getFlowchartTokens(isDark: boolean) {
  return {
    canvasBg: isDark ? 'var(--dsw-alias-bg-layer-1, #1a1d24)' : 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
    canvasBorder: isDark ? 'var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12))' : 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
    lineStroke: isDark ? '#64748b' : '#94a3b8',
    lineStrokeMuted: isDark ? '#475569' : '#cbd5e1',
    arrowColor: isDark ? '#94a3b8' : '#64748b',
    pillBg: isDark ? 'var(--dsw-alias-bg-layer-2, #21252e)' : '#ffffff',
    pillBorder: isDark ? 'var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.22))' : 'rgba(0, 0, 0, 0.18)',
    pillText: isDark ? '#f1f5f9' : '#0f172a',
  }
}

export function getJiraWorkflowTokens(isDark: boolean) {
  const cardBg = isDark ? 'var(--dsw-alias-bg-layer-2, #21252e)' : '#ffffff'
  const cardBorder = isDark ? 'var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14))' : 'rgba(0, 0, 0, 0.12)'
  const titleColor = isDark ? '#f0f2f5' : '#0f172a'
  const subtextColor = isDark ? '#94a3b8' : '#64748b'
  const badgeBg = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)'
  const badgeText = isDark ? '#e2e8f0' : '#334155'

  return {
    canvasBg: isDark ? 'var(--dsw-alias-bg-layer-1, #1a1d24)' : 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
    canvasDot: 'transparent',
    canvasBorder: isDark ? 'var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12))' : 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
    headerBg: isDark ? 'rgba(22, 27, 34, 0.95)' : '#ffffff',
    lineStroke: isDark ? '#64748b' : '#94a3b8',
    lineStrokeMuted: isDark ? '#475569' : '#cbd5e1',
    lineStrokePass: isDark ? '#22c55e' : '#16a34a',
    lineStrokeRetry: isDark ? '#f59e0b' : '#d97706',
    lineStrokeFail: isDark ? '#ef4444' : '#dc2626',
    lineStrokeBlue: isDark ? '#3b82f6' : '#2563eb',
    lineStrokeVault: isDark ? '#a855f7' : '#7c3aed',
    pillBg: isDark ? 'var(--dsw-alias-bg-layer-2, #21252e)' : '#ffffff',
    pillBorder: isDark ? 'var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.22))' : 'rgba(0, 0, 0, 0.18)',
    pillText: isDark ? '#f1f5f9' : '#0f172a',

    // 1. WHEN / TRIGGER: Blue
    todo: {
      label: 'WHEN: TRIGGER',
      bg: cardBg,
      border: cardBorder,
      titleColor,
      subtext: subtextColor,
      lozengeBg: isDark ? 'rgba(59, 130, 246, 0.18)' : 'rgba(37, 99, 235, 0.1)',
      lozengeText: isDark ? '#93c5fd' : '#1d4ed8',
      lozengeBorder: isDark ? 'rgba(59, 130, 246, 0.35)' : 'rgba(37, 99, 235, 0.25)',
      accentColor: '#3b82f6',
      countBadgeBg: badgeBg,
      countBadgeText: badgeText,
    },

    // 2. THEN / ACTION: Indigo
    inProgress: {
      label: 'THEN: ACTION',
      bg: cardBg,
      border: cardBorder,
      titleColor,
      subtext: subtextColor,
      lozengeBg: isDark ? 'rgba(99, 102, 241, 0.18)' : 'rgba(99, 102, 241, 0.1)',
      lozengeText: isDark ? '#a5b4fc' : '#4338ca',
      lozengeBorder: isDark ? 'rgba(99, 102, 241, 0.35)' : 'rgba(99, 102, 241, 0.25)',
      accentColor: '#6366f1',
      countBadgeBg: badgeBg,
      countBadgeText: badgeText,
    },

    // 3. IF / CONDITION: Amber
    inReview: {
      label: 'IF: CONDITION',
      bg: cardBg,
      border: cardBorder,
      titleColor,
      subtext: subtextColor,
      lozengeBg: isDark ? 'rgba(245, 158, 11, 0.18)' : 'rgba(245, 158, 11, 0.1)',
      lozengeText: isDark ? '#fde047' : '#b45309',
      lozengeBorder: isDark ? 'rgba(245, 158, 11, 0.35)' : 'rgba(245, 158, 11, 0.25)',
      accentColor: '#f59e0b',
      countBadgeBg: badgeBg,
      countBadgeText: badgeText,
    },

    // 4. BRANCH: PASS: Green
    done: {
      label: 'BRANCH: PASS',
      bg: cardBg,
      border: cardBorder,
      titleColor,
      subtext: subtextColor,
      lozengeBg: isDark ? 'rgba(34, 197, 94, 0.18)' : 'rgba(34, 197, 94, 0.1)',
      lozengeText: isDark ? '#86efac' : '#15803d',
      lozengeBorder: isDark ? 'rgba(34, 197, 94, 0.35)' : 'rgba(34, 197, 94, 0.25)',
      accentColor: '#22c55e',
      countBadgeBg: badgeBg,
      countBadgeText: badgeText,
    },

    // 5. BRANCH: RETRY: Amber
    retry: {
      label: 'BRANCH: RETRY',
      bg: cardBg,
      border: cardBorder,
      titleColor,
      subtext: subtextColor,
      lozengeBg: isDark ? 'rgba(245, 158, 11, 0.18)' : 'rgba(245, 158, 11, 0.1)',
      lozengeText: isDark ? '#fde047' : '#b45309',
      lozengeBorder: isDark ? 'rgba(245, 158, 11, 0.35)' : 'rgba(245, 158, 11, 0.25)',
      accentColor: '#f59e0b',
      countBadgeBg: badgeBg,
      countBadgeText: badgeText,
    },

    // 6. BRANCH: ESCALATE: Coral Red
    escalated: {
      label: 'BRANCH: ESCALATE',
      bg: cardBg,
      border: cardBorder,
      titleColor,
      subtext: subtextColor,
      lozengeBg: isDark ? 'rgba(239, 68, 68, 0.18)' : 'rgba(239, 68, 68, 0.1)',
      lozengeText: isDark ? '#fca5a5' : '#b91c1c',
      lozengeBorder: isDark ? 'rgba(239, 68, 68, 0.35)' : 'rgba(239, 68, 68, 0.25)',
      accentColor: '#ef4444',
      countBadgeBg: badgeBg,
      countBadgeText: badgeText,
    },

    // 7. FINISH: VAULT: Violet
    archived: {
      label: 'FINISH: VAULT',
      bg: cardBg,
      border: cardBorder,
      titleColor,
      subtext: subtextColor,
      lozengeBg: isDark ? 'rgba(168, 85, 247, 0.18)' : 'rgba(168, 85, 247, 0.1)',
      lozengeText: isDark ? '#d8b4fe' : '#6d28d9',
      lozengeBorder: isDark ? 'rgba(168, 85, 247, 0.35)' : 'rgba(168, 85, 247, 0.25)',
      accentColor: '#a855f7',
      countBadgeBg: badgeBg,
      countBadgeText: badgeText,
    },
  }
}
