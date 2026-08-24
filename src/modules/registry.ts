import type { LucideIcon } from 'lucide-react'

export type TenantRouteId =
  | 'ai'
  | 'schedule'
  | 'tasks'
  | 'approvals'
  | 'journal'
  | 'projects'
  | 'people'
  | 'finance'
  | 'ip'
  | 'documents'
  // food_manufacturing 모듈
  | 'products'
  | 'inventory'
  | 'factory'
  | 'sales'
  | 'compliance'
  // it_services 모듈
  | 'it-projects'
  | 'it-deliverables'
  | 'it-contracts'

export type TenantIndustryType = 'food_manufacturing' | 'it_services'
export type ServiceModuleId = 'core' | 'food-manufacturing' | 'it-services'

export type ServiceModule = {
  id: ServiceModuleId
  name: string
  version: string
  industry: 'all' | TenantIndustryType
  /** 사이드바 브랜드 라벨 ('FOOD ERP' 하드코딩 대체) */
  brandLabel?: string
  routes: readonly TenantRouteId[]
  capabilities: readonly string[]
}

/**
 * 메뉴 레지스트리: 공통 코어 + 업종 모듈. 화면 라우팅과 사이드바는 이 데이터로만 결정된다.
 * 새 업종을 붙일 때는 모듈 한 항목과 화면 컴포넌트만 추가하면 된다.
 */
export const serviceModules: readonly ServiceModule[] = [
  {
    id: 'core',
    name: '온팩토리 코어 플랫폼',
    version: '1.1.0',
    industry: 'all',
    routes: ['ai', 'schedule', 'tasks', 'approvals', 'journal', 'projects', 'people', 'finance', 'ip', 'documents'],
    capabilities: ['ai-hub', 'calendar', 'workflow', 'approval-queue', 'journal', 'project-spaces', 'people', 'performance', 'documents', 'messenger', 'points'],
  },
  {
    id: 'food-manufacturing',
    name: '식품제조 운영 모듈',
    version: '1.0.0',
    industry: 'food_manufacturing',
    brandLabel: '식품제조 ERP',
    routes: ['products', 'inventory', 'factory', 'sales', 'compliance'],
    capabilities: ['product-labeling', 'lot-inventory', 'factory-layout', 'sales-connectors', 'food-compliance'],
  },
  {
    id: 'it-services',
    name: 'IT 서비스 모듈',
    version: '0.1.0',
    industry: 'it_services',
    brandLabel: 'IT 서비스 워크스페이스',
    routes: ['it-deliverables', 'it-contracts'],
    capabilities: ['projects', 'deliverables', 'contracts'],
  },
] as const

export function modulesForIndustry(industryType: TenantIndustryType | string | null | undefined): readonly ServiceModule[] {
  const resolved: TenantIndustryType = industryType === 'it_services' ? 'it_services' : 'food_manufacturing'
  return serviceModules.filter((module) => module.industry === 'all' || module.industry === resolved)
}

export function routesForIndustry(industryType: TenantIndustryType | string | null | undefined): TenantRouteId[] {
  return modulesForIndustry(industryType).flatMap((module) => module.routes)
}

export function brandLabelForIndustry(industryType: TenantIndustryType | string | null | undefined): string {
  return modulesForIndustry(industryType).find((module) => module.brandLabel)?.brandLabel ?? '식품제조 ERP'
}

export function routesForModules(enabled: readonly ServiceModuleId[] = ['core', 'food-manufacturing']) {
  const allowed = new Set(enabled)
  return serviceModules.filter((module) => allowed.has(module.id)).flatMap((module) => module.routes)
}

export type NavigationModuleItem = {
  id: TenantRouteId
  label: string
  icon: LucideIcon
}
