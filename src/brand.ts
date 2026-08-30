import brand from '../shared/brand.json'

/**
 * 서비스 브랜드 문구의 단일 출처.
 * 화면 어디에서도 서비스명을 문자열로 직접 쓰지 않는다 (검증: scripts/verify-brand.mjs).
 * 서버는 server/brand.mjs가 같은 JSON을 읽는다.
 */
export const BRAND = brand as {
  name: string
  englishName: string
  tagline: string
  title: string
  manifestName: string
  description: string
  platformOpsLabel: string
  platformConsoleLabel: string
  platformWorkspaceLabel: string
  platformOperatorLabel: string
  platformAdminLabel: string
  assistantLabel: string
  operatorTeam: string
  supportTeam: string
  storageLabel: string
  nasBasePath: string
  offlineTitle: string
}

export const BRAND_NAME = BRAND.name
