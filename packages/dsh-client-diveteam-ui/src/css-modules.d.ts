declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '@deepseek-ai/dsh-host-webserver' {
  export interface WebRoute {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: any, res: any) => Promise<void> | void
  }
}

declare module '../../dsh-dispatcher/lib/roles.js' {
  export function loadRoles(rolesDir: string, coreMdPath: string): Map<string, any>
  export function serializeRoleMarkdown(role: any): string
}

