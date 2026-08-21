export type QuickLinkColor = 'green' | 'blue' | 'amber' | 'violet'
export type QuickLink = { id: string; name: string; url: string; color: QuickLinkColor }

export const defaultQuickLinks: QuickLink[] = [
  { id: 'naver', name: '네이버', url: 'https://www.naver.com', color: 'green' },
  { id: 'g2b', name: '나라장터', url: 'https://www.g2b.go.kr', color: 'blue' },
]

type QuickLinkStorage = Pick<Storage, 'getItem' | 'setItem'>
const colors = new Set<QuickLinkColor>(['green', 'blue', 'amber', 'violet'])

export function quickLinksStorageKey(scope: string) {
  return `onfactory-dashboard-links:${scope}`
}

export function readQuickLinks(storage: Pick<QuickLinkStorage, 'getItem'>, storageKey: string): QuickLink[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? 'null')
    if (!Array.isArray(parsed)) return defaultQuickLinks.map((link) => ({ ...link }))
    return parsed.filter((item): item is QuickLink => Boolean(item
      && typeof item.id === 'string'
      && typeof item.name === 'string'
      && typeof item.url === 'string'
      && colors.has(item.color)))
  } catch {
    return defaultQuickLinks.map((link) => ({ ...link }))
  }
}

export function writeQuickLinks(storage: Pick<QuickLinkStorage, 'setItem'>, storageKey: string, links: QuickLink[]) {
  storage.setItem(storageKey, JSON.stringify(links))
}
