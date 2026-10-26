export type EmbeddingProviderStatus = 'not configured' | 'configured' | 'connected' | 'unavailable'

type EmbeddingResponse = {
  data?: { index?: number; embedding?: number[] }[]
}

let providerStatus: EmbeddingProviderStatus = 'not configured'
let providerError: string | null = null
let lastProbeAt = 0

export function isEmbeddingConfigured() {
  return Boolean(process.env.EMBEDDING_API_KEY && process.env.EMBEDDING_BASE_URL && process.env.EMBEDDING_MODEL)
}

export function getEmbeddingProviderState() {
  if (!isEmbeddingConfigured()) return { status: 'not configured' as const, model: null, error: null }
  return {
    status: providerStatus === 'not configured' ? 'configured' : providerStatus,
    model: process.env.EMBEDDING_MODEL ?? null,
    error: providerError,
  }
}

export async function createEmbeddings(texts: string[]): Promise<number[][]> {
  if (!isEmbeddingConfigured()) throw new Error('Semantic embeddings are not configured. Set EMBEDDING_BASE_URL, EMBEDDING_API_KEY, and EMBEDDING_MODEL.')
  if (!texts.length || texts.some((text) => !text.trim() || text.length > 12000)) {
    throw new Error('Embedding input must contain non-empty text of at most 12,000 characters per item.')
  }
  const baseUrl = process.env.EMBEDDING_BASE_URL?.replace(/\/+$/, '')
  const apiKey = process.env.EMBEDDING_API_KEY
  const model = process.env.EMBEDDING_MODEL
  if (!baseUrl || !apiKey || !model) throw new Error('The embedding provider configuration is incomplete.')
  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` ,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}.`)
    const payload = await response.json() as EmbeddingResponse
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      throw new Error('Embedding provider returned an unexpected number of vectors.')
    }
    const vectors = payload.data.map((item) => item.embedding)
    if (vectors.some((vector) => !Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value)))) {
      throw new Error('Embedding provider returned an invalid vector.')
    }
    const dimensions = vectors[0]?.length
    if (vectors.some((vector) => vector?.length !== dimensions)) throw new Error('Embedding provider returned inconsistent vector dimensions.')
    providerStatus = 'connected'
    providerError = null
    return vectors as number[][]
  } catch (error) {
    providerStatus = 'unavailable'
    providerError = error instanceof Error ? error.message : 'Embedding request failed.'
    throw error
  }
}

export async function probeEmbeddingProvider() {
  if (!isEmbeddingConfigured()) {
    providerStatus = 'not configured'
    providerError = null
    return getEmbeddingProviderState()
  }
  if (Date.now() - lastProbeAt < 60_000 && providerStatus !== 'configured') return getEmbeddingProviderState()
  lastProbeAt = Date.now()
  try {
    await createEmbeddings(['Manak Mitra embedding service health check.'])
  } catch {
    // The detailed, credential-free provider error is exposed through provider state.
  }
  return getEmbeddingProviderState()
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return 0
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue ** 2
    rightMagnitude += rightValue ** 2
  }
  if (!leftMagnitude || !rightMagnitude) return 0
  return dot / Math.sqrt(leftMagnitude * rightMagnitude)
}
