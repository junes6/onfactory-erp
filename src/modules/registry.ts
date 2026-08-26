import {
  Award, Boxes, CalendarDays, ClipboardCheck, Factory, FileSignature, FileStack, FileText,
  FolderKanban, Landmark, ListChecks, NotebookPen, Package, ShieldCheck, Sparkles, Store, Users,
  type LucideIcon,
} from 'lucide-react'

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

export type NavigationModuleItem = {
  id: TenantRouteId
  label: string
  icon: LucideIcon
}

export type AssistantExperience = {
  welcome: string
  suggestions: readonly string[]
}

const routeNavigation: Readonly<Record<TenantRouteId, NavigationModuleItem>> = {
  ai: { id: 'ai', label: 'AI 업무허브', icon: Sparkles },
  schedule: { id: 'schedule', label: '일정관리', icon: CalendarDays },
  tasks: { id: 'tasks', label: '업무지시 · 결재', icon: ListChecks },
  approvals: { id: 'approvals', label: 'AI 제안 검토', icon: ClipboardCheck },
  journal: { id: 'journal', label: '일일업무일지', icon: NotebookPen },
  projects: { id: 'projects', label: '프로젝트', icon: FolderKanban },
  people: { id: 'people', label: '인사 · 조직', icon: Users },
  finance: { id: 'finance', label: '세무 · 자산', icon: Landmark },
  ip: { id: 'ip', label: '지식재산 · 인증', icon: Award },
  documents: { id: 'documents', label: '기업 자료실', icon: FileText },
  products: { id: 'products', label: '제품관리', icon: Package },
  inventory: { id: 'inventory', label: '재고 · LOT', icon: Boxes },
  factory: { id: 'factory', label: '공장관리', icon: Factory },
  sales: { id: 'sales', label: '판매채널', icon: Store },
  compliance: { id: 'compliance', label: '식품안전 · 인증', icon: ShieldCheck },
  'it-projects': { id: 'it-projects', label: '프로젝트', icon: FolderKanban },
  'it-deliverables': { id: 'it-deliverables', label: '산출물', icon: FileStack },
  'it-contracts': { id: 'it-contracts', label: '계약 · 거래처', icon: FileSignature },
}

const foodAssistant = {
  operatingAdmin: [
    '오늘 제가 먼저 처리할 일을 정리해줘',
    '연결된 판매채널과 부족 재고를 분석해줘',
    '검토가 필요한 제품 표시사항을 알려줘',
    '야간 포장업무 담당자를 추천해줘',
  ],
  operatingMember: [
    '오늘 제가 먼저 처리할 일을 정리해줘',
    '내 업무 마감과 공유 일정을 정리해줘',
    '검토가 필요한 제품 표시사항을 알려줘',
    '안전재고가 부족한 제품을 알려줘',
  ],
  onboarding: [
    '첫 제품 등록에 필요한 정보를 정리해줘',
    '판매채널 연동 순서를 안내해줘',
    '창고와 재고 위치 등록 체크리스트를 만들어줘',
    '신규 직원에게 배정할 초기 업무를 제안해줘',
  ],
} as const

const itAssistant = {
  operating: [
    '이번 주 마감 임박 프로젝트 정리해줘',
    '진행 중인 프로젝트별 담당자와 상태를 요약해줘',
    '갱신 준비가 필요한 계약을 알려줘',
    '오늘 제가 먼저 처리할 일을 정리해줘',
  ],
  onboarding: [
    '첫 프로젝트 등록에 필요한 정보를 정리해줘',
    '산출물 버전 관리 규칙을 제안해줘',
    '거래처 계약 등록 체크리스트를 만들어줘',
    '신규 직원에게 배정할 초기 업무를 제안해줘',
  ],
} as const

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
    capabilities: ['ai-hub', 'calendar', 'workflow', 'approval-queue', 'journal', 'project-spaces', 'people', 'performance', 'documents', 'messenger'],
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
    routes: ['it-projects', 'it-deliverables', 'it-contracts'],
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

/**
 * 사이드바 항목의 단일 출처. IT 테넌트에서는 공통 프로젝트 별칭 대신 업종 모듈 경로를
 * 대표 메뉴로 노출해 같은 화면이 두 번 보이지 않게 한다.
 */
export function navigationForIndustry(industryType: TenantIndustryType | string | null | undefined): NavigationModuleItem[] {
  const isItServices = industryType === 'it_services'
  return routesForIndustry(industryType)
    .filter((route) => !(isItServices && route === 'projects'))
    .map((route) => routeNavigation[route])
}

export function routeLabel(route: TenantRouteId): string {
  return routeNavigation[route].label
}

export function brandLabelForIndustry(industryType: TenantIndustryType | string | null | undefined): string {
  return modulesForIndustry(industryType).find((module) => module.brandLabel)?.brandLabel ?? '운영 워크스페이스'
}

export function assistantExperienceForIndustry(industryType: TenantIndustryType | string | null | undefined, options: {
  companyName: string
  operatingDataAvailable: boolean
  canViewCommercial: boolean
}): AssistantExperience {
  if (industryType === 'it_services') {
    return {
      welcome: options.operatingDataAvailable
        ? `${options.companyName}의 프로젝트, 산출물, 계약과 업무 현황을 연결했습니다. 무엇을 확인할까요?`
        : `${options.companyName}의 초기 설정을 도와드릴게요. 프로젝트·거래처 계약 중 무엇부터 등록할까요?`,
      suggestions: options.operatingDataAvailable ? itAssistant.operating : itAssistant.onboarding,
    }
  }
  return {
    welcome: options.operatingDataAvailable
      ? `${options.companyName}${options.canViewCommercial ? '의 제품, 주문, 재고와 업무 현황을 연결했습니다.' : '의 제품, 재고, 일정과 내 업무를 연결했습니다.'} 무엇을 확인할까요?`
      : `${options.companyName}의 초기 설정을 도와드릴게요. 제품·창고·판매채널 중 무엇부터 연결할까요?`,
    suggestions: options.operatingDataAvailable
      ? (options.canViewCommercial ? foodAssistant.operatingAdmin : foodAssistant.operatingMember)
      : foodAssistant.onboarding,
  }
}

export function librarySearchPlaceholderForIndustry(industryType: TenantIndustryType | string | null | undefined): string {
  return industryType === 'it_services'
    ? '예: 최근 프로젝트 계약서 최종본 찾아줘'
    : '예: 최근 자가품질검사 성적서 찾아줘'
}

export function routesForModules(enabled: readonly ServiceModuleId[] = ['core', 'food-manufacturing']) {
  const allowed = new Set(enabled)
  return serviceModules.filter((module) => allowed.has(module.id)).flatMap((module) => module.routes)
}
