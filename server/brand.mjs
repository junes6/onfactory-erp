import brand from '../shared/brand.json' with { type: 'json' }

/**
 * 서비스 브랜드 문구의 단일 출처 (서버 쪽 진입점).
 * 화면(src/brand.ts)과 같은 JSON을 읽으므로 문구가 갈라지지 않는다.
 */
export const BRAND = brand
export const BRAND_NAME = brand.name
