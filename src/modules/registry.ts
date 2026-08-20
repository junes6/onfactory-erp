import type { LucideIcon } from 'lucide-react'

export type TenantRouteId =
  | 'ai'
  | 'schedule'
  | 'tasks'
  | 'journal'
  | 'products'
  | 'inventory'
  | 'factory'
  | 'sales'
  | 'people'
  | 'documents'
  | 'compliance'

export type ServiceModuleId = 'core' | 'food-manufacturing'

export type ServiceModule = {
  id: ServiceModuleId
  name: string
  version: string
  industry: 'all' | 'food-manufacturing'
  routes: readonly TenantRouteId[]
  capabilities: readonly string[]
}

/**
 * The registry is intentionally data-only. App routing remains unchanged while
 * tenant provisioning and future module loaders can enable capabilities by ID.
 */
export const serviceModules: readonly ServiceModule[] = [
  {
    id: 'core',
    name: '온팩토리 코어 플랫폼',
    version: '1.0.0',
    industry: 'all',
    routes: ['ai', 'schedule', 'tasks', 'journal', 'people', 'documents'],
    capabilities: [
      'ai-approval-queue',
      'file-auto-classification',
      'semantic-search',
      'automation-ladder',
      'messenger',
      'calendar',
      'workflow',
      'people',
      'documents',
    ],
  },
  {
    id: 'food-manufacturing',
    name: '식품제조 운영 모듈',
    version: '1.0.0',
    industry: 'food-manufacturing',
    routes: ['products', 'inventory', 'factory', 'sales', 'compliance'],
    capabilities: ['product-labeling', 'lot-inventory', 'factory-layout', 'sales-connectors', 'food-compliance'],
  },
] as const

export function routesForModules(enabled: readonly ServiceModuleId[] = ['core', 'food-manufacturing']) {
  const allowed = new Set(enabled)
  return serviceModules.filter((module) => allowed.has(module.id)).flatMap((module) => module.routes)
}

export type NavigationModuleItem = {
  id: TenantRouteId
  label: string
  icon: LucideIcon
}

