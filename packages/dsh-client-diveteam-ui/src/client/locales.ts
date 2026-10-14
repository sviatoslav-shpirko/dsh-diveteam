/** Dictionary interface for the DiveTeam control panel. */
export interface DiveTeamDict {
  'entry.label': string
  'entry.desc': string
  'panel.label': string
  'section.tasks': string
  'section.agents': string
  'section.memory': string
  'section.telegram': string
  'section.monitoring': string
  'section.workflow': string
  placeholder: string
  'agents.loading': string
  'agents.empty': string
  'agents.new': string
  'agents.createTitle': string
  'agents.id': string
  'agents.idEditable': string
  'agents.name': string
  'agents.description': string
  'agents.order': string
  'agents.provider': string
  'agents.model': string
  'agents.isolation': string
  'agents.heavyWorker': string
  'agents.prompt': string
  'agents.template': string
  'agents.save': string
  'agents.create': string
  'agents.cancel': string
  'agents.delete': string
  'agents.saving': string
  'agents.saved': string
  'tasks.new': string
  'tasks.newRole': string
  'tasks.back': string
  'tasks.title': string
  'tasks.description': string
  'tasks.prompt': string
  'tasks.role': string
  'tasks.isolationMode': string
  'tasks.parentId': string
  'tasks.dependsOn': string
  'tasks.status': string
  'tasks.repoPath': string
  'tasks.attempts': string
  'tasks.save': string
  'tasks.comments': string
  'tasks.addComment': string
  'tasks.commentPlaceholder': string
  'tasks.empty': string
  'tasks.loading': string
  'tasks.backlog': string
  'tasks.todo': string
  'tasks.running': string
  'tasks.done': string
  'tasks.failed': string
  'tasks.activity': string
  'tasks.activityEmpty': string
}

export type DiveTeamKey = keyof DiveTeamDict
export type FarvaterDict = DiveTeamDict
export type FarvaterKey = DiveTeamKey

export const en: Record<DiveTeamKey, string> = {
  'entry.label': 'DiveTeam',
  'entry.desc': 'DiveTeam multi-agent system',
  'panel.label': 'DiveTeam Control Panel',
  'section.tasks': 'Kanban',
  'section.agents': 'Agents',
  'section.memory': 'Memory',
  'section.telegram': 'Telegram',
  'section.monitoring': 'Dispatcher',
  'section.workflow': 'Workflow',
  placeholder: 'This section is a placeholder; its content lands in a later phase.',
  'agents.loading': 'Loading roles…',
  'agents.empty': 'No roles found',
  'agents.new': 'Create role',
  'agents.createTitle': 'Create new agent role',
  'agents.id': 'Role ID (read-only)',
  'agents.idEditable': 'Role ID (Latin lowercase, e.g. analyst, secops, designer)',
  'agents.name': 'Display Name',
  'agents.description': 'Description',
  'agents.order': 'Sort Order',
  'agents.provider': 'Default Provider',
  'agents.model': 'Default Model',
  'agents.isolation': 'Isolation mode',
  'agents.heavyWorker': 'Heavy worker (counts toward quota of 3)',
  'agents.prompt': 'System prompt (Markdown)',
  'agents.template': 'Fill Prompt Template',
  'agents.save': 'Save changes',
  'agents.create': 'Create role',
  'agents.cancel': 'Cancel',
  'agents.delete': 'Delete role',
  'agents.saving': 'Saving…',
  'agents.saved': 'Saved and synced to DSH presets!',
  'tasks.new': 'New task',
  'tasks.newRole': 'Create role',
  'tasks.back': 'Back to Kanban',
  'tasks.title': 'Title',
  'tasks.description': 'Description',
  'tasks.prompt': 'Prompt',
  'tasks.role': 'Agent Role',
  'tasks.isolationMode': 'Isolation Mode',
  'tasks.parentId': 'Parent Task (Subtask of)',
  'tasks.dependsOn': 'Dependencies (Wait for completion of)',
  'tasks.status': 'Column / Status',
  'tasks.repoPath': 'Repository path (Git)',
  'tasks.attempts': 'Attempts',
  'tasks.save': 'Save',
  'tasks.comments': 'Comments & Journal',
  'tasks.addComment': 'Add comment',
  'tasks.commentPlaceholder': 'Write a comment…',
  'tasks.empty': 'No tasks',
  'tasks.loading': 'Loading tasks…',
  'tasks.backlog': 'Бэклог',
  'tasks.todo': 'К выполнению',
  'tasks.running': 'В работе',
  'tasks.done': 'Готово',
  'tasks.failed': 'Ошибка',
  'tasks.activity': 'Ход работы и содержание',
  'tasks.activityEmpty': 'Агент ещё не выполнял действий',
}

export const ru: Record<DiveTeamKey, string> = {
  'entry.label': 'DiveTeam',
  'entry.desc': 'Мультиагентная система DiveTeam',
  'panel.label': 'Панель управления DiveTeam',
  'section.tasks': 'Канбан',
  'section.agents': 'Агенты',
  'section.memory': 'Память',
  'section.telegram': 'Telegram',
  'section.monitoring': 'Диспетчер',
  'section.workflow': 'Воркфлоу',
  placeholder: 'Раздел пока заглушка; наполнение появится в следующих фазах.',
  'agents.loading': 'Загрузка ролей…',
  'agents.empty': 'Роли не найдены',
  'agents.new': 'Создать роль',
  'agents.createTitle': 'Создание новой роли агента',
  'agents.id': 'ID роли (только чтение)',
  'agents.idEditable': 'ID роли (латиницей, например: analyst, secops, designer)',
  'agents.name': 'Название роли (например: 7. Analyst (Аналитик))',
  'agents.description': 'Краткое описание роли',
  'agents.order': 'Порядок сортировки (order)',
  'agents.provider': 'Провайдер по умолчанию',
  'agents.model': 'Модель по умолчанию',
  'agents.isolation': 'Режим изоляции',
  'agents.heavyWorker': 'Тяжёлый воркер (учитывать в квоте 3 слотов)',
  'agents.prompt': 'Системный промпт роли (Markdown, без CORE.md)',
  'agents.template': 'Заполнить шаблон промпта',
  'agents.save': 'Сохранить роль',
  'agents.create': 'Создать роль',
  'agents.cancel': 'Отмена',
  'agents.delete': 'Удалить роль',
  'agents.saving': 'Сохранение…',
  'agents.saved': 'Сохранено и синхронизировано с пресетами DSH!',
  'tasks.new': 'Новая задача',
  'tasks.newRole': 'Создать роль',
  'tasks.back': 'Назад к Канбану',
  'tasks.title': 'Заголовок',
  'tasks.description': 'Описание',
  'tasks.prompt': 'Инструкция для агента',
  'tasks.role': 'Роль агента',
  'tasks.isolationMode': 'Режим изоляции',
  'tasks.parentId': 'Родительская задача (если это подзадача)',
  'tasks.dependsOn': 'Зависимости (стартует после завершения выбранных задач)',
  'tasks.status': 'Колонка (Статус)',
  'tasks.repoPath': 'Путь к Git-репозиторию',
  'tasks.attempts': 'Попытки',
  'tasks.save': 'Сохранить',
  'tasks.comments': 'Комментарии и журнал',
  'tasks.addComment': 'Добавить комментарий',
  'tasks.commentPlaceholder': 'Напишите комментарий…',
  'tasks.empty': 'В этой колонке задач нет',
  'tasks.loading': 'Загрузка задач…',
  'tasks.backlog': 'Бэклог',
  'tasks.todo': 'К выполнению',
  'tasks.running': 'В работе',
  'tasks.done': 'Готово',
  'tasks.failed': 'Ошибка',
  'tasks.activity': 'Ход работы и содержание',
  'tasks.activityEmpty': 'Агент ещё не выполнял действий',
}

let translate: ((key: DiveTeamKey) => string) | undefined

/** Bind the active locale seat at runtime (called once from apply). */
export function setRuntimeTranslate(t: (key: DiveTeamKey) => string): void {
  translate = t
}

/** Module-level translate with Russian fallback, for the main-slot panel. */
export function t(key: DiveTeamKey): string {
  const val = translate?.(key)
  if (val && val !== key) return val
  return ru[key] ?? en[key]
}
