import { lazy } from 'react'

/**
 * 화면별로 나눠 싣는다. 전에는 모든 화면이 한 파일(1.6MB, gzip 420KB)에 들어 있어, 휴대폰에서 첫 화면(오늘·업무)을
 * 보려고 공장 배치도·세무·플랫폼 콘솔까지 받아야 했다. 여기 적은 화면은 처음 열 때 받는다.
 * 화면 모듈의 이름 붙은 내보내기를 그대로 쓰므로, 화면 코드는 바꾸지 않는다(타입은 원래 모듈에서 `import type`으로).
 */
const loaders = {
  projects: () => import('./components/ProjectSpaces'),
  tax: () => import('./components/TaxAssets'),
  ip: () => import('./components/IpRights'),
  business: () => import('./components/BusinessPages'),
  billing: () => import('./components/BillingDashboard'),
  library: () => import('./components/CompanyLibrary'),
  wiki: () => import('./components/wiki/WikiPage'),
  meetings: () => import('./components/MeetingNotes'),
  documents: () => import('./components/DocumentsHub'),
  materials: () => import('./components/materials/MaterialsPage'),
  compliance: () => import('./components/ComplianceCenter'),
  factory: () => import('./components/FactoryManagement'),
  people: () => import('./components/PeopleOperations'),
  it: () => import('./components/ItServices'),
  platform: () => import('./components/PlatformConsole'),
  guest: () => import('./components/GuestWorkspace'),
  lens: () => import('./components/LensPanel'),
  core: () => import('./components/PersonalCorePage'),
  approvals: () => import('./components/ApprovalQueue'),
}

export const ProjectSpacesPage = lazy(() => loaders.projects().then((module) => ({ default: module.ProjectSpacesPage })))
export const TaxAssetsPage = lazy(() => loaders.tax().then((module) => ({ default: module.TaxAssetsPage })))
export const IpRightsPage = lazy(() => loaders.ip().then((module) => ({ default: module.IpRightsPage })))
export const ProductManagement = lazy(() => loaders.business().then((module) => ({ default: module.ProductManagement })))
export const SalesChannels = lazy(() => loaders.business().then((module) => ({ default: module.SalesChannels })))
export const BillingDashboard = lazy(() => loaders.billing().then((module) => ({ default: module.BillingDashboard })))
export const CompanyLibrary = lazy(() => loaders.library().then((module) => ({ default: module.CompanyLibrary })))
export const WikiPage = lazy(() => loaders.wiki().then((module) => ({ default: module.WikiPage })))
export const MeetingNotesPage = lazy(() => loaders.meetings().then((module) => ({ default: module.MeetingNotesPage })))
export const DocumentsHub = lazy(() => loaders.documents().then((module) => ({ default: module.DocumentsHub })))
export const MaterialsPage = lazy(() => loaders.materials().then((module) => ({ default: module.MaterialsPage })))
export const ComplianceCenter = lazy(() => loaders.compliance().then((module) => ({ default: module.ComplianceCenter })))
export const FactoryManagement = lazy(() => loaders.factory().then((module) => ({ default: module.FactoryManagement })))
export const PeopleOperationsPage = lazy(() => loaders.people().then((module) => ({ default: module.PeopleOperationsPage })))
export const ItServicesPage = lazy(() => loaders.it().then((module) => ({ default: module.ItServicesPage })))
export const PlatformConsole = lazy(() => loaders.platform().then((module) => ({ default: module.default })))
export const GuestWorkspace = lazy(() => loaders.guest().then((module) => ({ default: module.GuestWorkspace })))
export const LensPanel = lazy(() => loaders.lens().then((module) => ({ default: module.LensPanel })))
export const PersonalCorePage = lazy(() => loaders.core().then((module) => ({ default: module.PersonalCorePage })))
export const ApprovalQueue = lazy(() => loaders.approvals().then((module) => ({ default: module.ApprovalQueue })))

/**
 * 한가할 때 미리 받아 둔다(데스크톱만). 처음 여는 화면에서 기다리지 않게 — 휴대폰은 데이터를 아끼려고 누를 때 받는다.
 */
export function prefetchPages() {
  if (typeof window === 'undefined' || !window.matchMedia?.('(min-width: 761px)').matches) return
  const run = () => { for (const load of Object.values(loaders)) void load().catch(() => undefined) }
  const idle = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback
  if (idle) idle(run, { timeout: 8_000 })
  else window.setTimeout(run, 4_000)
}
