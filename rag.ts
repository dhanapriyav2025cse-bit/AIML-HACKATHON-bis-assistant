export type KnowledgeChunk = {
  id: string
  title: string
  kind: string
  reference?: string
  url?: string
  content: string
  tags?: string[]
  category?: string
  sourceName?: string
  standardNumber?: string
  documentType?: string
  section?: string
  page?: number
  language?: string
}

export type RetrievedChunk = KnowledgeChunk & { score: number }

const stopWords = new Set(['a', 'an', 'and', 'are', 'do', 'does', 'for', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'what', 'with', 'please', 'tell', 'me', 'about', 'can', 'my', 'available', 'current', 'new', 'simple', 'simply', 'information', 'which', 'section', 'mentions', 'language', 'info', 'similarly', 'explain'])
const standardDiscoveryIntents = new Set(['find', 'search', 'related', 'relevant', 'discover', 'locate', 'identify', 'list', 'recommend', 'cover'])

function normalizeToken(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

export function tokenize(text: string): string[] {
  return [...new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 1 && !stopWords.has(word)).map(normalizeToken))]
}

export function retrieve(query: string, chunks: KnowledgeChunk[], limit = 4, minimumScore = 2): RetrievedChunk[] {
  const queryTerms = tokenize(query)
  if (!queryTerms.length) return []

  const scored = chunks.map((chunk) => {
    const searchable = `${chunk.title} ${chunk.reference ?? ''} ${chunk.kind} ${(chunk.tags ?? []).join(' ')} ${chunk.content}`.toLocaleLowerCase()
    const documentTerms = new Set(tokenize(searchable))
    const titleTerms = new Set(tokenize(chunk.title))
    const tagTerms = new Set((chunk.tags ?? []).flatMap(tokenize))
    const matchedTerms = queryTerms.filter((term) => documentTerms.has(term))
    const requiredMatches = queryTerms.length
    let score = matchedTerms.reduce((sum, term) => sum + (tagTerms.has(term) ? 2 : 1) + (titleTerms.has(term) ? 1 : 0), 0)
   if (matchedTerms.length === 0) score = 0
    const phrase = query.trim().toLocaleLowerCase()
    if (phrase.length > 4 && searchable.includes(phrase)) score += 3
    return { ...chunk, score }
  })

  const matches = scored.filter((chunk) => chunk.score >= minimumScore).sort((left, right) => right.score - left.score)
  if (matches.length) return matches.slice(0, limit)

  const asksToDiscoverStandards = queryTerms.includes('standard') && queryTerms.some((term) => standardDiscoveryIntents.has(term))
  const standardsDiscovery = asksToDiscoverStandards ? chunks.find((chunk) => chunk.id === 'standard-discovery') : undefined
  if (standardsDiscovery) return [{ ...standardsDiscovery, score: minimumScore }]

  return []
}

export function groundedExcerptAnswer(results: RetrievedChunk[], language = 'English'): string {
  if (!results.length) {
    return `I couldn't verify an answer from the information available in this demo knowledge base. Please check the relevant official BIS source. ${language === 'English' ? '' : 'This local demo does not have a configured Hindi/Tamil generation provider; the response remains in English.'}`.trim()
  }

  const languageNote = language === 'English' ? '' : '\n\nThis local answer is in English. Hindi/Tamil answer generation is not configured in this demo.'
  const excerpts = results.slice(0, 3).map((result, index) => `[S${index + 1}] ${result.content}`).join('\n\n')
  return `From the available source material:\n\n${excerpts}\n\nThis is a demo retrieval result, not an official determination. Verify current details at the cited BIS source.${languageNote}`
}

export function hasOnlyRetrievedCitations(answer: string, sourceCount: number): boolean {
  const citations = [...answer.matchAll(/\[S(\d+)\]/g)]
  return citations.length > 0 && citations.every(([, number]) => {
    const index = Number(number)
    return Number.isInteger(index) && index >= 1 && index <= sourceCount && number === String(index)
  })
}