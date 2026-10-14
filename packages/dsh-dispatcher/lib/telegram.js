import { execFileSync } from 'node:child_process'

/**
 * Zero-dependency Telegram Bot Bridge for DiveTeam.
 * Communicates exclusively with official https://api.telegram.org.
 * Strictly whitelisted to owner chat_id and from.id (default: 81815557).
 * Never logs or exposes plaintext tokens.
 */

export function escapeTelegramHtml(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function splitMarkdownTableRow(line) {
  let trimmed = String(line || '').trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  const cells = []
  let current = ''
  let inCode = false
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]
    if (ch === '`') {
      inCode = !inCode
      current += ch
      continue
    }
    if (ch === '|' && !inCode && trimmed[i - 1] !== '\\') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

function isMarkdownTableSeparator(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return false
  const cells = splitMarkdownTableRow(trimmed)
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim()))
}

export function formatInlineMarkdownToHtml(rawText) {
  let text = String(rawText ?? '')
  if (!text) return ''

  // 1. Extract inline code `...` into placeholders
  const inlineCodes = []
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeTelegramHtml(code)}</code>`)
    return `\x00TGICODE_${idx}\x00`
  })

  // 2. Extract Markdown links [label](https://...) into placeholders
  const inlineLinks = []
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    const idx = inlineLinks.length
    const safeUrl = escapeTelegramHtml(url).replace(/"/g, '&quot;')
    const formattedLabel = escapeTelegramHtml(label)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/__(.+?)__/g, '<b>$1</b>')
    inlineLinks.push(`<a href="${safeUrl}">${formattedLabel}</a>`)
    return `\x00TGILINK_${idx}\x00`
  })

  // 3. Escape HTML special chars in remaining text
  text = escapeTelegramHtml(text)

  // 4. Bold + italic, bold, italic, strikethrough
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>')
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  text = text.replace(/__(.+?)__/g, '<b>$1</b>')
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>')
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // 5. Restore links and inline codes
  text = text.replace(/\x00TGILINK_(\d+)\x00/g, (_m, idx) => inlineLinks[Number(idx)] ?? '')
  text = text.replace(/\x00TGICODE_(\d+)\x00/g, (_m, idx) => inlineCodes[Number(idx)] ?? '')
  return text
}

/**
 * Converts LLM Markdown (including fenced code blocks, pipe tables, headings,
 * blockquotes, bold/italic/code, and lists) into clean Telegram Bot API HTML.
 */
export function formatMarkdownForTelegramHtml(markdown) {
  let src = String(markdown ?? '').replace(/\r\n/g, '\n').trim()
  if (!src) return ''

  // 1. Protect fenced code blocks ```lang ... ```
  const codeBlocks = []
  src = src.replace(/```(?:[a-zA-Z0-9_+-]*)?\n?([\s\S]*?)```/g, (_m, code) => {
    const idx = codeBlocks.length
    const cleanCode = String(code ?? '').replace(/^\n+|\n+$/g, '')
    codeBlocks.push(`<pre><code>${escapeTelegramHtml(cleanCode)}</code></pre>`)
    return `\n@@TG_CODEBLOCK_${idx}@@\n`
  })

  // 2. Detect and convert Markdown pipe tables into clean Telegram card lists
  const lines = src.split('\n')
  const tables = []
  const outLinesAfterTables = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const nextLine = lines[i + 1]
    if (
      line &&
      nextLine &&
      /^\s*\|.+\|\s*$/.test(line) &&
      isMarkdownTableSeparator(nextLine)
    ) {
      const headers = splitMarkdownTableRow(line).map((h) => formatInlineMarkdownToHtml(h))
      i += 2
      const dataRows = []
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        if (!isMarkdownTableSeparator(lines[i])) {
          const cells = splitMarkdownTableRow(lines[i]).map((c) => formatInlineMarkdownToHtml(c))
          dataRows.push(cells)
        }
        i += 1
      }
      const renderedRows = []
      if (headers.length <= 2) {
        for (const row of dataRows) {
          const k = row[0] || '—'
          const v = row[1] || '—'
          renderedRows.push(`• <b>${k}</b> — ${v}`)
        }
      } else {
        for (const row of dataRows) {
          const title = row[0] || '—'
          const subItems = []
          for (let colIdx = 1; colIdx < Math.max(headers.length, row.length); colIdx += 1) {
            const colHeader = headers[colIdx] || `Колонка ${colIdx + 1}`
            const colVal = row[colIdx] ?? '—'
            subItems.push(`  • <i>${colHeader}:</i> ${colVal}`)
          }
          renderedRows.push([`▸ <b>${title}</b>`, ...subItems].join('\n'))
        }
      }
      const tIdx = tables.length
      tables.push(renderedRows.join('\n\n'))
      outLinesAfterTables.push(`@@TG_TABLE_${tIdx}@@`)
      continue
    }
    outLinesAfterTables.push(line)
    i += 1
  }

  // 3. Format headings, blockquotes, horizontal rules, lists, and regular lines
  const processedLines = []
  let quoteBuffer = []
  const flushQuotes = () => {
    if (quoteBuffer.length > 0) {
      processedLines.push(`<blockquote>${quoteBuffer.join('\n')}</blockquote>`)
      quoteBuffer = []
    }
  }

  for (const rawLine of outLinesAfterTables) {
    const trimmed = rawLine.trim()
    if (/^@@TG_(?:CODEBLOCK|TABLE)_\d+@@$/.test(trimmed)) {
      flushQuotes()
      processedLines.push(trimmed)
      continue
    }

    const quoteMatch = rawLine.match(/^\s*>\s?(.*)$/)
    if (quoteMatch) {
      quoteBuffer.push(formatInlineMarkdownToHtml(quoteMatch[1]))
      continue
    }
    flushQuotes()

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(rawLine)) {
      processedLines.push('───────────────')
      continue
    }

    const headingMatch = rawLine.match(/^\s*#{1,6}\s+(.+?)\s*$/)
    if (headingMatch) {
      const headingHtml = formatInlineMarkdownToHtml(headingMatch[1].replace(/^⚡\s*/, '⚡ '))
      processedLines.push(`\n<b>${headingHtml}</b>`)
      continue
    }

    const ulMatch = rawLine.match(/^(\s*)[-*]\s+(.+)$/)
    if (ulMatch) {
      const prefix = ulMatch[1].length >= 2 ? '  • ' : '• '
      processedLines.push(`${prefix}${formatInlineMarkdownToHtml(ulMatch[2])}`)
      continue
    }

    const olMatch = rawLine.match(/^(\s*)(\d+\.)\s+(.+)$/)
    if (olMatch) {
      const prefix = olMatch[1].length >= 2 ? '  ' : ''
      processedLines.push(`${prefix}<b>${escapeTelegramHtml(olMatch[2])}</b> ${formatInlineMarkdownToHtml(olMatch[3])}`)
      continue
    }

    processedLines.push(formatInlineMarkdownToHtml(rawLine))
  }
  flushQuotes()

  let result = processedLines.join('\n')
  result = result.replace(/@@TG_TABLE_(\d+)@@/g, (_m, idx) => tables[Number(idx)] ?? '')
  result = result.replace(/@@TG_CODEBLOCK_(\d+)@@/g, (_m, idx) => codeBlocks[Number(idx)] ?? '')
  result = result.replace(/\n{3,}/g, '\n\n').trim()
  return result
}

export function stripTelegramHtml(html) {
  return String(html ?? '')
    .replace(/<\/?(?:b|i|s|u|code|pre|blockquote|a)(?:\s+[^>]*)?>/gi, '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

export class TelegramBridge {
  constructor(options = {}) {
    let token = String(
      options.token
      ?? process.env.DIVETEAM_TG_BOT_TOKEN
      ?? process.env.FARVATER_TG_BOT_TOKEN
      ?? process.env.TELEGRAM_BOT_TOKEN
      ?? ''
    ).trim()

    let tokenSource = options.tokenSource || (
      options.token ? 'options:token' :
      process.env.DIVETEAM_TG_BOT_TOKEN ? 'env:DIVETEAM_TG_BOT_TOKEN' :
      process.env.FARVATER_TG_BOT_TOKEN ? 'env:FARVATER_TG_BOT_TOKEN' :
      process.env.TELEGRAM_BOT_TOKEN ? 'env:TELEGRAM_BOT_TOKEN' :
      'none'
    )
    let kwalletEntry = 'kdewallet:Telegram_bot_tokens/diveteam_shturman_bot'

    if (!token && options.token !== '') {
      for (const entry of ['diveteam_shturman_bot', 'farvater_shturman_bot']) {
        try {
          const kwOut = execFileSync(
            'kwallet-query',
            ['-f', 'Telegram_bot_tokens', '-r', entry, 'kdewallet'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
          ).trim()
          if (kwOut && !kwOut.toLowerCase().startsWith('failed')) {
            token = kwOut
            tokenSource = `kdewallet:Telegram_bot_tokens/${entry}`
            kwalletEntry = `kdewallet:Telegram_bot_tokens/${entry}`
            break
          }
        } catch { /* ignore */ }
      }
    }

    this.token = token
    this.allowedChatId = String(
      options.chatId
      ?? process.env.DIVETEAM_TG_CHAT_ID
      ?? process.env.FARVATER_TG_CHAT_ID
      ?? process.env.TELEGRAM_CHAT_ID
      ?? '81815557'
    ).trim()
    this.allowedUserId = String(
      options.userId
      ?? process.env.DIVETEAM_TG_USER_ID
      ?? process.env.FARVATER_TG_USER_ID
      ?? this.allowedChatId
      ?? '81815557'
    ).trim()
    this.tokenSource = tokenSource
    this.kwalletEntry = kwalletEntry
    this.defaultBotUsername = '@diveteam_shturman_bot'
    this.botProfile = null
    this.onCommand = options.onCommand || (async () => {})
    this.logger = options.logger || console
    this.offset = 0
    this.polling = false
    this.pollTimer = null
    this.typingTimer = null
    this.typingSafetyTimer = null
    this.history = []
  }

  get enabled() {
    return Boolean(this.token && this.allowedChatId)
  }

  maskToken() {
    const clean = (this.token || '').trim()
    if (!clean) return ''
    if (clean.length <= 8) return '*'.repeat(clean.length)
    return `${clean.slice(0, 5)}${'*'.repeat(clean.length - 5)}`
  }

  recordEvent(direction, text, meta = {}) {
    this.history.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      direction,
      text: String(text || ''),
      at: new Date().toISOString(),
      ...meta,
    })
    if (this.history.length > 100) {
      this.history.length = 100
    }
  }

  status() {
    return {
      enabled: this.enabled,
      hasToken: Boolean(this.token),
      maskedToken: this.maskToken(),
      tokenLength: this.token ? this.token.length : 0,
      tokenSource: this.tokenSource,
      kwalletEntry: this.kwalletEntry,
      allowedChatId: this.allowedChatId,
      allowedUserId: this.allowedUserId,
      botProfile: this.botProfile,
      defaultBotUsername: this.defaultBotUsername,
      botUsername: this.botProfile?.username ? `@${this.botProfile.username}` : this.defaultBotUsername,
      polling: this.polling,
      typing: Boolean(this.typingTimer),
      history: this.history,
    }
  }

  configure({ token, allowedChatId, allowedUserId, tokenSource, kwalletEntry }) {
    if (typeof token === 'string' && token.trim()) {
      this.token = token.trim()
      this.tokenSource = tokenSource || 'runtime:configured'
    } else if (tokenSource && this.token) {
      this.tokenSource = tokenSource
    }
    if (kwalletEntry) {
      this.kwalletEntry = kwalletEntry
    }
    if (typeof allowedChatId === 'string' && allowedChatId.trim()) {
      this.allowedChatId = allowedChatId.trim()
    }
    if (typeof allowedUserId === 'string' && allowedUserId.trim()) {
      this.allowedUserId = allowedUserId.trim()
    }
    if (this.enabled) {
      void this.refreshBotProfile()
      if (!this.polling) {
        this.startPolling()
      }
    }
  }

  async refreshBotProfile() {
    if (!this.token) return null
    try {
      const url = `https://api.telegram.org/bot${this.token}/getMe`
      const res = await fetch(url)
      if (!res.ok) return null
      const data = await res.json()
      if (data?.ok && data.result) {
        this.botProfile = {
          id: data.result.id,
          username: data.result.username || '',
          firstName: data.result.first_name || '',
        }
        try {
          await fetch(`https://api.telegram.org/bot${this.token}/setMyCommands`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              commands: [
                { command: 'new', description: 'Начать новую сессию диалога со Штурманом' },
                { command: 'status', description: 'Сводка состояния системы Фарватер и воркеров' },
                { command: 'tasks', description: 'Список активных и ожидающих задач на доске' },
                { command: 'approve', description: 'Одобрить задачу: /approve <ID> [комментарий]' },
                { command: 'reject', description: 'Отклонить задачу: /reject <ID> [причина]' },
                { command: 'note', description: 'Сохранить заметку в vault/inbox: /note <текст>' },
                { command: 'help', description: 'Справка по командам Штурмана' },
              ],
            }),
          })
        } catch {
          // Ignore setMyCommands failure
        }
        return this.botProfile
      }
    } catch {
      // Ignore network errors during getMe
    }
    return null
  }

  async sendTypingAction() {
    if (!this.enabled) return false
    try {
      const url = `https://api.telegram.org/bot${this.token}/sendChatAction`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.allowedChatId,
          action: 'typing',
        }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  startTypingLoop(intervalMs = 4000, maxDurationMs = 120_000) {
    this.stopTypingLoop()
    if (!this.enabled) return
    void this.sendTypingAction()
    this.typingTimer = setInterval(() => {
      void this.sendTypingAction()
    }, intervalMs)
    this.typingSafetyTimer = setTimeout(() => {
      this.stopTypingLoop()
    }, maxDurationMs)
  }

  stopTypingLoop() {
    if (this.typingTimer) {
      clearInterval(this.typingTimer)
      this.typingTimer = null
    }
    if (this.typingSafetyTimer) {
      clearTimeout(this.typingSafetyTimer)
      this.typingSafetyTimer = null
    }
  }

  splitMessageChunks(rawText, maxLen = 3200) {
    const str = String(rawText || '').trim()
    if (!str) return []
    if (str.length <= maxLen) return [str]
    const chunks = []
    let remaining = str
    while (remaining.length > maxLen) {
      let splitAt = remaining.lastIndexOf('\n\n', maxLen)
      if (splitAt < Math.floor(maxLen * 0.4)) {
        splitAt = remaining.lastIndexOf('\n', maxLen)
      }
      if (splitAt < Math.floor(maxLen * 0.4)) {
        splitAt = remaining.lastIndexOf(' ', maxLen)
      }
      if (splitAt < Math.floor(maxLen * 0.4)) {
        splitAt = maxLen
      }
      chunks.push(remaining.slice(0, splitAt).trim())
      remaining = remaining.slice(splitAt).trim()
    }
    if (remaining) chunks.push(remaining)
    return chunks
  }

  async sendMessage(text) {
    if (!this.enabled) {
      this.recordEvent('out', text, { delivered: false, note: 'Telegram не настроен (локальный журнал)' })
      return false
    }
    const chunks = this.splitMessageChunks(text, 3200)
    if (chunks.length === 0) return false
    let allOk = true
    for (const chunk of chunks) {
      const htmlText = formatMarkdownForTelegramHtml(chunk)
      const plainPreview = stripTelegramHtml(htmlText)
      try {
        const url = `https://api.telegram.org/bot${this.token}/sendMessage`
        let res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.allowedChatId,
            text: htmlText,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        })
        let note
        if (!res.ok) {
          // Fallback to plain stripped text if Telegram HTML parser rejects anything
          res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: this.allowedChatId,
              text: plainPreview || chunk,
              disable_web_page_preview: true,
            }),
          })
          if (!res.ok) {
            allOk = false
            try {
              const errJson = await res.json()
              note = errJson?.description || `HTTP ${res.status}`
            } catch {
              note = `HTTP ${res.status}`
            }
          } else {
            note = 'plain-fallback'
          }
        }
        this.recordEvent('out', plainPreview || chunk, {
          delivered: res.ok,
          chatId: this.allowedChatId,
          ...(note ? { note } : {}),
        })
      } catch (err) {
        allOk = false
        const rawMsg = err instanceof Error ? err.message : String(err)
        const safeMsg = this.token ? rawMsg.split(this.token).join('***') : rawMsg
        this.recordEvent('out', plainPreview || chunk, { delivered: false, note: safeMsg })
        this.logger.warn('[diveteam-telegram] sendMessage failed:', safeMsg)
      }
    }
    return allOk
  }

  startPolling(intervalMs = 3500) {
    if (!this.enabled || this.polling) return
    this.polling = true
    void this.refreshBotProfile()
    const tick = async () => {
      if (!this.polling) return
      await this.pollOnce()
      if (this.polling) {
        this.pollTimer = setTimeout(tick, intervalMs)
      }
    }
    this.pollTimer = setTimeout(tick, 800)
  }

  stopPolling() {
    this.polling = false
    this.stopTypingLoop()
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  async pollOnce() {
    if (!this.enabled) return
    try {
      const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=0`
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json()
      if (!data.ok || !Array.isArray(data.result)) return
      for (const update of data.result) {
        this.offset = Math.max(this.offset, update.update_id + 1)
        const msg = update.message
        if (!msg || typeof msg.text !== 'string') continue
        const chatId = String(msg.chat?.id ?? '')
        const fromId = String(msg.from?.id ?? '')
        const chatAuthorized = chatId === this.allowedChatId
        const userAuthorized = !this.allowedUserId || fromId === this.allowedUserId
        if (!chatAuthorized || !userAuthorized) {
          this.recordEvent('blocked', msg.text.trim(), {
            chatId,
            fromId,
            note: `Отклонено (chat_id=${chatId}, from.id=${fromId})`,
          })
          this.logger.warn(
            `[diveteam-telegram] Ignored message from unauthorized chat_id=${chatId} from_id=${fromId}`
          )
          continue
        }
        const trimmed = msg.text.trim()
        if (!trimmed) continue
        this.recordEvent('in', trimmed, { chatId, fromId, delivered: true })
        await this.onCommand(trimmed, msg)
      }
    } catch {
      // Ignore transient network errors
    }
  }
}
