import 'dotenv/config'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import cors from 'cors'
import express, { type ErrorRequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import multer from 'multer'
import { z } from 'zod'
import { knowledge, services, standards } from './data/catalog.js'
import { chunkPageText, extractPdfPages } from './documents.js'
import { conversationBelongsToSession, createConversation, deleteConversation, deleteDocument, deleteIngestedKnowledge, deleteVectorEmbeddings, getApplicationEventMetrics, getConversationMessages, getDatabaseHealth, getDocument as getStoredDocument, getDocumentMetrics, getFeedbackMetrics, getIngestedKnowledgeRecord, guestSessionExists, knowledgeContentExists, knowledgeDocumentExists, knowledgeSourceExists, listConversations, listDocuments, listIngestedKnowledge, listIngestionLogs, listVectorEmbeddings, recordApplicationEvent, registerGuestSession, saveConversationMessage, saveDocument, saveFeedback, saveIngestionLog, saveKnowledgeDocumentRecords, saveKnowledgeRecord, saveVectorEmbeddings, updateKnowledgeRecord, knowledgeRecordCount, seedDemoKnowledge, vectorEmbeddingCount } from './db.js'
import { cosineSimilarity, createEmbeddings, isEmbeddingConfigured, probeEmbeddingProvider } from './embeddings.js'
import { groundedExcerptAnswer, hasOnlyRetrievedCitations, retrieve, type KnowledgeChunk } from './rag.js'

const app = express()
const port = Number(process.env.PORT || 4174)
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173'
const systemPrompt = await readFile(path.resolve(process.cwd(), 'backend/prompts/system.md'), 'utf8')
seedDemoKnowledge(knowledge)
const serviceKnowledgeCategories = new Set(['BIS certification', 'BIS licensing', 'BIS registration', 'BIS testing', 'BIS laboratories', 'Consumer services', 'BIS processes', 'Frequently asked questions'])
const serviceSourceUrls = new Set(services.map((service) => service.source).filter((url): url is string => Boolean(url)))

type DocumentChunk = KnowledgeChunk & { page: number; documentName: string }
type StandardCatalogItem = { id: string; title: string; category: string; summary: string; number?: string; tags?: string[]; source?: string; verificationStatus?: string }
type ImportedKnowledgeRecord = Omit<ReturnType<typeof listIngestedKnowledge>[number], 'sourceType' | 'verificationStatus'> & {
  sourceType: 'admin_excerpt'
  verificationStatus: 'verified' | 'pending' | 'unverified'
}

app.disable('x-powered-by')
app.use(helmet())
app.use(cors({ origin: frontendOrigin.split(',').map((origin) => origin.trim()) }))
app.use('/api', (request, response, next) => {
  response.on('finish', () => {
    if (response.statusCode < 400 || response.statusCode === 429) return
    try {
      recordApplicationEvent('error')
    } catch (error) {
      console.error('Could not persist request error event:', error instanceof Error ? error.message : 'unknown error')
    }
  })
  next()
})
app.use(express.json({ limit: '20kb' }))
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 80,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_request, response) => {
    recordApplicationEvent('error')
    return response.status(429).json({ error: 'Too many requests. Please try again shortly.' })
  },
}))

const chatSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  language: z.enum(['English', 'Hindi', 'Tamil']).default('English'),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) })).max(8).default([]),
  guestSessionId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
})

const standardsQuerySchema = z.object({ query: z.string().trim().min(1).max(300) })
const knowledgeRecordsQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  category: z.string().trim().max(100).optional(),
  verificationStatus: z.enum(['verified', 'pending', 'unverified', 'demo']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})
const knowledgeImportBatchSchema = z.object({ records: z.array(z.unknown()).min(1).max(100) })
const catalogQuerySchema = z.object({
  query: z.string().trim().max(300).optional(),
  category: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
const documentQuerySchema = z.object({ documentId: z.string().uuid().optional(), question: z.string().trim().min(1).max(2000), language: z.enum(['English', 'Hindi', 'Tamil']).default('English'), history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) })).max(8).default([]), guestSessionId: z.string().uuid(), conversationId: z.string().uuid().optional() })
const feedbackSchema = z.object({ messageId: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/), rating: z.enum(['helpful', 'not_helpful']), comment: z.string().trim().max(500).optional() })
const guestSessionSchema = z.object({ guestSessionId: z.string().uuid().optional() })
const conversationSchema = z.object({ guestSessionId: z.string().uuid(), title: z.string().trim().max(120).default('New conversation') })
const knowledgeSchema = z.object({
  id: z.string().trim().min(2).max(120).regex(/^[a-zA-Z0-9._-]+$/),
  title: z.string().trim().min(3).max(240),
  content: z.string().trim().min(40).max(12000),
  kind: z.string().trim().min(2).max(100),
  category: z.enum(['BIS overview', 'Indian Standards', 'Standards search', 'BIS certification', 'BIS licensing', 'BIS registration', 'BIS testing', 'BIS laboratories', 'Consumer services', 'BIS processes', 'Frequently asked questions']),
  reference: z.string().trim().max(200).optional(),
  url: z.string().url().refine((value) => {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && (parsed.hostname === 'bis.gov.in' || parsed.hostname.endsWith('.bis.gov.in') || parsed.hostname === 'standardsbis.bsbedge.com')
  }, 'Use an HTTPS URL from an official BIS domain.'),
  sourceName: z.string().trim().min(2).max(240),
  standardNumber: z.string().trim().max(100).optional(),
  documentType: z.string().trim().max(100).optional(),
  section: z.string().trim().max(120).optional(),
  page: z.number().int().positive().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  language: z.enum(['English', 'Hindi', 'Tamil']).default('English'),
  version: z.string().trim().max(80).optional(),
  publisher: z.string().trim().min(2).max(240).default('Bureau of Indian Standards'),
  publishedDate: z.string().date().optional(),
  verificationStatus: z.enum(['verified', 'pending', 'unverified']).default('pending'),
})
const knowledgeUpdateSchema = z.object({
  title: z.string().trim().min(3).max(240).optional(),
  content: z.string().trim().min(40).max(12000).optional(),
  kind: z.string().trim().min(2).max(100).optional(),
  category: knowledgeSchema.shape.category.optional(),
  reference: z.string().trim().max(200).optional(),
  url: knowledgeSchema.shape.url.optional(),
  sourceName: z.string().trim().min(2).max(240).optional(),
  verificationStatus: z.enum(['verified', 'pending', 'unverified']).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.')
const adminDocumentMetadataSchema = z.object({
  url: z.string().url().refine((value) => {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && (parsed.hostname === 'bis.gov.in' || parsed.hostname.endsWith('.bis.gov.in') || parsed.hostname === 'standardsbis.bsbedge.com')
  }, 'Use an HTTPS URL from an official BIS domain.'),
  sourceName: z.string().trim().min(2).max(240),
  title: z.string().trim().min(3).max(240),
  category: knowledgeSchema.shape.category,
  verificationStatus: z.enum(['verified', 'pending', 'unverified']).default('pending'),
})

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (file.mimetype !== 'application/pdf' || path.extname(file.originalname).toLocaleLowerCase() !== '.pdf') {
      callback(new Error('Upload a PDF file up to 10 MB.'))
      return
    }
    callback(null, true)
  },
})

function contentHash(content: string | Buffer) {
  return createHash('sha256').update(content).digest('hex')
}

function asSources(chunks: KnowledgeChunk[]) {
  return chunks.map((chunk, index) => ({
    id: chunk.id,
    title: chunk.title,
    kind: chunk.kind,
    reference: chunk.reference ?? ([chunk.standardNumber, chunk.section, chunk.page ? `Page ${chunk.page}` : undefined].filter(Boolean).join(' · ') || undefined),
    sourceName: chunk.sourceName,
    section: chunk.section,
    page: chunk.page,
    url: chunk.url,
    label: `S${index + 1}`,
  }))
}

async function generateWithProvider(question: string, language: string, history: { role: 'user' | 'assistant'; text: string }[], chunks: KnowledgeChunk[]) {
  const { AI_API_KEY, AI_BASE_URL, AI_MODEL } = process.env
  if (!AI_API_KEY || !AI_BASE_URL || !AI_MODEL) return null

  const sourceContext = chunks.map((chunk, index) => `[S${index + 1}] ${chunk.title}\n${chunk.content}\nOfficial source: ${chunk.url ?? 'No URL supplied'}`).join('\n\n')
  const recentHistory = history.slice(-6).map(({ role, text }) => ({ role, content: text.slice(0, 2000) }))
  const response = await fetch(`${AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AI_API_KEY}` ,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.1,
      max_tokens: 600,
      messages: [
        { role: 'system', content: systemPrompt },
        ...recentHistory,
        { role: 'user', content: `Answer in ${language}. Use only these retrieved excerpts, cite them as [S1], [S2], and abstain if they do not contain the answer.\n\nRetrieved excerpts:\n${sourceContext}\n\nQuestion: ${question}` },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    aiProviderStatus = 'unavailable'
    throw new Error(`AI provider returned ${response.status}`)
  }
  const body = await response.json() as { choices?: { message?: { content?: string } }[] }
  const answer = body.choices?.[0]?.message?.content?.trim()
  aiProviderStatus = answer ? 'connected' : 'unavailable'
  return answer || null
}

async function answerQuestion(question: string, language: string, history: { role: 'user' | 'assistant'; text: string }[], chunks: KnowledgeChunk[]) {
  if (!chunks.length) return { answer: groundedExcerptAnswer([], language), sources: [], mode: 'demo' as const }

  try {
    const generated = await generateWithProvider(question, language, history, chunks)
    if (generated && hasOnlyRetrievedCitations(generated, chunks.length)) return { answer: generated, sources: asSources(chunks), mode: 'llm' as const }
    if (generated) console.warn('AI provider response omitted or used citations outside the retrieved source set; returning retrieved excerpts.')
  } catch (error) {
    aiProviderStatus = aiConfiguration() ? 'unavailable' : 'not configured'
    console.warn('AI provider request failed; returning retrieved source excerpts:', error instanceof Error ? error.message : 'unknown error')
    // Fall through to the source excerpts when the optional provider is unavailable.
  }

  return { answer: groundedExcerptAnswer(chunks.map((chunk) => ({ ...chunk, score: 1 })), language), sources: asSources(chunks), mode: 'demo' as const }
}

const aiConfiguration = () => Boolean(process.env.AI_API_KEY && process.env.AI_BASE_URL && process.env.AI_MODEL)
let aiProviderStatus: 'configured' | 'connected' | 'unavailable' | 'not configured' = aiConfiguration() ? 'configured' : 'not configured'

function isAiConfigured() {
  return aiConfiguration()
}

type RetrievalSourceType = 'knowledge' | 'document'

async function indexEmbeddings(sourceType: RetrievalSourceType, chunks: KnowledgeChunk[]) {
  if (!isEmbeddingConfigured() || !chunks.length) return false
  const model = process.env.EMBEDDING_MODEL
  if (!model) return false
  const records = []
  for (let start = 0; start < chunks.length; start += 32) {
    const batch = chunks.slice(start, start + 32)
    const vectors = await createEmbeddings(batch.map((chunk) => `${chunk.title}\n${chunk.reference ?? ''}\n${chunk.content}`))
    records.push(...batch.map((chunk, index) => ({
      sourceType,
      sourceId: chunk.id,
      model,
      vector: vectors[index]!,
    })))
  }
  saveVectorEmbeddings(records)
  return true
}

async function retrieveHybrid(query: string, chunks: KnowledgeChunk[], sourceType: RetrievalSourceType, limit: number, minimumScore = 2) {
  const lexicalMatches = retrieve(query, chunks, chunks.length, minimumScore)
  if (!isEmbeddingConfigured() || !chunks.length) return { matches: lexicalMatches.slice(0, limit), method: 'lexical' as const }
  try {
    const model = process.env.EMBEDDING_MODEL
    if (!model) return { matches: lexicalMatches.slice(0, limit), method: 'lexical' as const }
    const [queryVector] = await createEmbeddings([query])
    if (!queryVector) return { matches: lexicalMatches.slice(0, limit), method: 'lexical' as const }
    const vectors = listVectorEmbeddings(sourceType, chunks.map((chunk) => chunk.id), model)
    if (!vectors.length) return { matches: lexicalMatches.slice(0, limit), method: 'lexical' as const }
    const lexicalById = new Map(lexicalMatches.map((match) => [match.id, match]))
    const maximumLexicalScore = Math.max(1, ...lexicalMatches.map((match) => match.score))
    const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
    const ranked = vectors.flatMap(({ sourceId, vector }) => {
      const chunk = chunkById.get(sourceId)
      if (!chunk) return []
      const similarity = cosineSimilarity(queryVector, vector)
      const lexical = lexicalById.get(sourceId)
      if (similarity < 0.25 && !lexical) return []
      return [{ ...chunk, score: 0.55 * Math.max(0, similarity) + 0.45 * (lexical?.score ?? 0) / maximumLexicalScore }]
    }).sort((left, right) => right.score - left.score).slice(0, limit)
    return { matches: ranked.length ? ranked : lexicalMatches.slice(0, limit), method: ranked.length ? 'hybrid' as const : 'lexical' as const }
  } catch (error) {
    console.warn('Semantic retrieval failed; using lexical retrieval:', error instanceof Error ? error.message : 'unknown error')
    return { matches: lexicalMatches.slice(0, limit), method: 'lexical' as const }
  }
}

function requireAdmin(request: express.Request, response: express.Response, next: express.NextFunction) {
  const expected = process.env.ADMIN_API_KEY
  if (!expected) return response.status(503).json({ error: 'Knowledge management is disabled until an administrator configures ADMIN_API_KEY.' })
  const provided = request.get('x-admin-api-key') ?? ''
  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) return response.status(401).json({ error: 'Administrator authorization is required.' })
  return next()
}

function getKnowledgeCorpus(): KnowledgeChunk[] {
  return listIngestedKnowledge().filter((record) => record.verificationStatus === 'verified' || record.verificationStatus === 'demo')
}

function asStandardRecord(record: KnowledgeChunk): StandardCatalogItem {
  const existing = standards.find((item) => item.id === record.id)
  if (existing) return existing
  return {
    id: record.id,
    title: record.title,
    category: record.category ?? 'Indian Standards',
    number: record.standardNumber ?? record.reference,
    summary: record.content,
    tags: record.tags,
    source: record.url,
    verificationStatus: record.id.startsWith('standard-') ? 'demo' : 'verified',
  }
}

function getStandardCatalog(): StandardCatalogItem[] {
  const imported = listIngestedKnowledge().filter((record) => (record.verificationStatus === 'verified' || record.verificationStatus === 'demo') && (record.category === 'Indian Standards' || record.standardNumber))
  const dbRecords = new Map(imported.map((record) => [record.id, asStandardRecord(record)]))
  return [...standards.map((item) => {
    const record = dbRecords.get(item.id)
    return record ? { ...item, summary: record.summary, source: record.source, verificationStatus: record.verificationStatus } : { ...item, verificationStatus: 'demo' }
  }), ...imported.filter((record) => !standards.some((item) => item.id === record.id)).map(asStandardRecord)]
}

function getServiceCatalog() {
  const records = listIngestedKnowledge().filter((record) => record.verificationStatus === 'verified' || record.verificationStatus === 'demo')
  return services.map((service) => {
    const sourceRecord = records.find((record) => record.url === service.source)
    return {
      ...service,
      summary: sourceRecord?.content ?? service.summary,
      source: sourceRecord?.url ?? service.source,
      verificationStatus: sourceRecord?.verificationStatus ?? 'demo',
    }
  })
}

app.get('/api/health', (_request, response) => {
  const database = getDatabaseHealth()
  const status = database.status === 'connected' ? 'ok' : 'degraded'
  response.status(status === 'ok' ? 200 : 503).json({
    status,
    mode: 'local-rag',
    aiConfigured: isAiConfigured(),
    aiProviderStatus: isAiConfigured() ? aiProviderStatus : 'not configured',
    database,
  })
})

app.post('/api/sessions/guest', (request, response) => {
  const parsed = guestSessionSchema.safeParse(request.body ?? {})
  if (!parsed.success) return response.status(400).json({ error: 'Invalid guest session.' })
  const guestSessionId = parsed.data.guestSessionId ?? randomUUID()
  registerGuestSession(guestSessionId)
  return response.json({ guestSessionId, authenticated: false, status: 'guest' })
})

app.get('/api/conversations', (request, response) => {
  const sessionId = z.string().uuid().safeParse(request.query.guestSessionId)
  if (!sessionId.success) return response.status(400).json({ error: 'Provide a valid guest session ID.' })
  return response.json({ conversations: listConversations(sessionId.data) })
})

app.post('/api/conversations', (request, response) => {
  const parsed = conversationSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Provide a valid guest session and conversation title.' })
  registerGuestSession(parsed.data.guestSessionId)
  return response.status(201).json({ conversation: createConversation(parsed.data.guestSessionId, parsed.data.title) })
})

app.get('/api/conversations/:id', (request, response) => {
  const parsedSession = z.string().uuid().safeParse(request.query.guestSessionId)
  const conversationId = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id
  if (!parsedSession.success || !conversationId || !conversationBelongsToSession(conversationId, parsedSession.data)) return response.status(404).json({ error: 'That conversation could not be found.' })
  return response.json({ messages: getConversationMessages(conversationId) })
})

app.delete('/api/conversations/:id', (request, response) => {
  const parsedSession = z.string().uuid().safeParse(request.query.guestSessionId)
  const conversationId = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id
  if (!parsedSession.success || !conversationId || !deleteConversation(conversationId, parsedSession.data)) return response.status(404).json({ error: 'That conversation could not be found.' })
  return response.json({ ok: true })
})

app.get('/api/knowledge/status', async (_request, response) => {
  const embeddingProvider = await probeEmbeddingProvider()
  const database = getDatabaseHealth()
  const documents = getDocumentMetrics()
  const corpus = getKnowledgeCorpus()
  const storedRecords = listIngestedKnowledge()
  const kinds = Object.entries(storedRecords.reduce<Record<string, number>>((counts, item) => {
    const category = item.category ?? item.kind
    counts[category] = (counts[category] ?? 0) + 1
    return counts
  }, {})).map(([name, count]) => ({ name, count }))
  const indexedVectors = embeddingProvider.model ? vectorEmbeddingCount(embeddingProvider.model, 'knowledge') : 0
  const vectorStatus = embeddingProvider.status === 'connected'
    ? indexedVectors > 0 ? 'connected' : 'indexing required'
    : embeddingProvider.status
  const standardRecordCount = storedRecords.filter((record) => record.category === 'Indian Standards' || Boolean(record.standardNumber)).length
  const serviceRecordCount = storedRecords.filter((record) => serviceKnowledgeCategories.has(record.category) || serviceSourceUrls.has(record.url)).length
  response.json({
    knowledge: { status: database.status === 'connected' ? 'available' : 'unavailable', source: 'SQLite: illustrative seed records + administrator imports', records: knowledgeRecordCount(), categories: kinds, complete: false, ingestionEnabled: Boolean(process.env.ADMIN_API_KEY) },
    standards: { records: standardRecordCount, complete: false },
    services: { records: serviceRecordCount, complete: false },
    documents: { records: documents.documentCount, chunks: documents.chunkCount },
    database,
    vectorSearch: {
      status: vectorStatus,
      method: vectorStatus === 'connected' ? 'hybrid lexical + SQLite cosine similarity' : 'lexical token overlap fallback',
      indexedVectors,
      model: embeddingProvider.model,
      error: embeddingProvider.error,
    },
    aiProvider: { status: isAiConfigured() ? aiProviderStatus : 'not configured', required: false },
    liveBis: {
      status: 'unavailable',
      configured: false,
      message: 'No supported public BIS API or data feed is configured. Use the official links below to review records, then import permitted reviewed excerpts or PDFs.',
      officialUrls: ['https://www.bis.gov.in/', 'https://standards.bis.gov.in/website/know-your-standards', 'https://standardsbis.bsbedge.com/'],
    },
    sourceUrls: [...new Set(corpus.map((item) => item.url).filter((url): url is string => Boolean(url)))],
  })
})

app.get('/api/knowledge/records', (request, response) => {
  const parsed = knowledgeRecordsQuerySchema.safeParse(request.query)
  if (!parsed.success) return response.status(400).json({ error: 'Provide valid knowledge record filters and pagination.' })
  const { query, category, verificationStatus, page, pageSize } = parsed.data
  let records = listIngestedKnowledge()
  if (category) records = records.filter((record) => record.category === category)
  if (verificationStatus) records = records.filter((record) => record.verificationStatus === verificationStatus)
  if (query) {
    const normalizedQuery = query.toLocaleLowerCase()
    records = records.filter((record) => [
      record.title, record.kind, record.category, record.sourceName, record.url,
      record.standardNumber ?? '', record.reference ?? '', ...record.tags,
    ].join(' ').toLocaleLowerCase().includes(normalizedQuery))
    recordApplicationEvent('search')
  }
  records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const total = records.length
  return response.json({
    records: records.slice((page - 1) * pageSize, page * pageSize).map((record) => ({
      id: record.id,
      title: record.title,
      category: record.category,
      kind: record.kind,
      sourceName: record.sourceName,
      url: record.url,
      sourceType: record.sourceType,
      verificationStatus: record.verificationStatus,
      standardNumber: record.standardNumber,
      updatedAt: record.updatedAt,
      lastVerifiedAt: record.lastVerifiedAt,
    })),
    pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    categories: [...new Set(listIngestedKnowledge().map((record) => record.category))].sort(),
  })
})

app.get('/api/admin/knowledge', requireAdmin, (_request, response) => response.json({
  records: listIngestedKnowledge().filter((record) => record.sourceType !== 'demo'),
  ingestionLogs: listIngestionLogs(),
}))

app.post('/api/admin/knowledge/import', requireAdmin, async (request, response) => {
  const parsedBatch = knowledgeImportBatchSchema.safeParse(request.body)
  if (!parsedBatch.success) {
    return response.status(400).json({ error: 'Provide a records array containing between 1 and 100 source records.' })
  }

  const accepted: { row: number; id: string; record: ImportedKnowledgeRecord }[] = []
  const rejected: { row: number; id?: string; errors: string[] }[] = []
  const seenIds = new Set<string>()
  const seenHashes = new Set<string>()

  parsedBatch.data.records.forEach((value, index) => {
    const row = index + 1
    const parsed = knowledgeSchema.safeParse(value)
    if (!parsed.success) {
      rejected.push({
        row,
        id: typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' ? value.id : undefined,
        errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'record'}: ${issue.message}`),
      })
      return
    }
    const record = parsed.data
    const hash = contentHash(record.content)
    if (seenIds.has(record.id) || knowledge.some((item) => item.id === record.id) || listIngestedKnowledge().some((item) => item.id === record.id)) {
      rejected.push({ row, id: record.id, errors: ['A record with this ID already exists in the database or this import.'] })
      saveIngestionLog({ sourceUrl: record.url, sourceName: record.sourceName, contentHash: hash, status: 'duplicate', verificationStatus: record.verificationStatus, error: 'Duplicate record ID in import.' })
      return
    }
    if (seenHashes.has(hash) || knowledgeContentExists(hash)) {
      rejected.push({ row, id: record.id, errors: ['Identical content already exists in the database or this import.'] })
      saveIngestionLog({ sourceUrl: record.url, sourceName: record.sourceName, contentHash: hash, status: 'duplicate', verificationStatus: record.verificationStatus, error: 'Duplicate content in import.' })
      return
    }
    seenIds.add(record.id)
    seenHashes.add(hash)
    const now = new Date().toISOString()
    accepted.push({
      row,
      id: record.id,
      record: {
        ...record,
        sourceType: 'admin_excerpt',
        contentHash: hash,
        createdAt: now,
        updatedAt: now,
        lastVerifiedAt: record.verificationStatus === 'verified' ? now : undefined,
      },
    })
  })

  for (const item of accepted) saveKnowledgeRecord(item.record)
  const verifiedRecords = accepted.filter(({ record }) => record.verificationStatus === 'verified').map(({ record }) => record)
  let retrieval = 'lexical'
  let embeddingWarning: string | undefined
  if (verifiedRecords.length && isEmbeddingConfigured()) {
    try {
      if (await indexEmbeddings('knowledge', verifiedRecords)) retrieval = 'hybrid'
    } catch (error) {
      embeddingWarning = 'Semantic indexing failed; verified records remain available through lexical retrieval.'
      console.warn('Could not create imported-record embeddings; lexical retrieval remains available:', error instanceof Error ? error.message : 'unknown error')
    }
  }
  for (const { record } of accepted) {
    saveIngestionLog({ sourceUrl: record.url, sourceName: record.sourceName, contentHash: record.contentHash, status: 'indexed', verificationStatus: record.verificationStatus })
  }

  return response.status(rejected.length ? 207 : 201).json({
    imported: accepted.length,
    retrieval,
    ...(embeddingWarning ? { warning: embeddingWarning } : {}),
    accepted: accepted.map(({ row, id }) => ({ row, id })),
    rejected,
  })
})

app.post('/api/admin/knowledge', requireAdmin, async (request, response) => {
  const parsed = knowledgeSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({
    error: 'Check required source metadata, content, category, and official HTTPS URL.',
    details: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  })
  const hash = contentHash(parsed.data.content)
  if (knowledge.some((record) => record.id === parsed.data.id) || listIngestedKnowledge().some((record) => record.id === parsed.data.id)) {
    saveIngestionLog({ sourceUrl: parsed.data.url, sourceName: parsed.data.sourceName, contentHash: hash, status: 'duplicate', verificationStatus: parsed.data.verificationStatus, error: 'A record with this ID already exists.' })
    return response.status(409).json({ error: 'A knowledge record with that ID already exists.' })
  }
  if (knowledgeContentExists(hash)) {
    saveIngestionLog({ sourceUrl: parsed.data.url, sourceName: parsed.data.sourceName, contentHash: hash, status: 'duplicate', verificationStatus: parsed.data.verificationStatus, error: 'Identical content is already indexed.' })
    return response.status(409).json({ error: 'Identical content is already indexed.' })
  }
  const now = new Date().toISOString()
  const record = {
    ...parsed.data,
    sourceName: parsed.data.sourceName,
    sourceType: 'admin_excerpt' as const,
    contentHash: hash,
    lastVerifiedAt: parsed.data.verificationStatus === 'verified' ? now : undefined,
    createdAt: now,
    updatedAt: now,
  }
  saveKnowledgeRecord(record)
  let retrieval = 'lexical'
  if (record.verificationStatus === 'verified' && isEmbeddingConfigured()) {
    try {
      if (await indexEmbeddings('knowledge', [record])) retrieval = 'hybrid'
    } catch (error) {
      console.warn('Could not create imported-record embeddings; lexical retrieval remains available:', error instanceof Error ? error.message : 'unknown error')
    }
  }
  saveIngestionLog({ sourceUrl: record.url, sourceName: record.sourceName, contentHash: hash, status: 'indexed', verificationStatus: record.verificationStatus })
  return response.status(201).json({ record: { ...record, content: undefined }, indexed: true, retrieval })
})

app.patch('/api/admin/knowledge/:id', requireAdmin, async (request, response) => {
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id
  const parsed = knowledgeUpdateSchema.safeParse(request.body)
  if (!id || !parsed.success) return response.status(400).json({ error: 'Provide a valid record ID and at least one valid field to update.' })
  const existing = getIngestedKnowledgeRecord(id)
  if (!existing) return response.status(404).json({ error: 'That imported record could not be found.' })
  const nextContent = parsed.data.content ?? existing.content
  const nextHash = contentHash(nextContent)
  if (nextHash !== existing.contentHash && knowledgeContentExists(nextHash)) {
    return response.status(409).json({ error: 'Identical content is already indexed in another record.' })
  }
  const updated = updateKnowledgeRecord(id, parsed.data)
  if (!updated) return response.status(404).json({ error: 'That imported record could not be found.' })
  deleteVectorEmbeddings('knowledge', [id])
  let retrieval = 'lexical'
  if (updated.verificationStatus === 'verified' && isEmbeddingConfigured()) {
    try {
      if (await indexEmbeddings('knowledge', [updated])) retrieval = 'hybrid'
    } catch (error) {
      console.warn('Could not refresh imported-record embeddings; lexical retrieval remains available:', error instanceof Error ? error.message : 'unknown error')
    }
  }
  saveIngestionLog({ sourceUrl: updated.url, sourceName: updated.sourceName, contentHash: updated.contentHash, status: 'indexed', verificationStatus: updated.verificationStatus })
  return response.json({ record: { ...updated, content: undefined }, updatedAt: updated.updatedAt, retrieval })
})

app.post('/api/admin/knowledge/:id/reindex', requireAdmin, async (request, response) => {
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id
  const existing = id ? getIngestedKnowledgeRecord(id) : undefined
  if (!existing) return response.status(404).json({ error: 'That imported record could not be found.' })
  const reindexed = updateKnowledgeRecord(id, { content: existing.content })
  if (!reindexed) return response.status(404).json({ error: 'That imported record could not be found.' })
  deleteVectorEmbeddings('knowledge', [id])
  let retrieval = 'lexical'
  if (reindexed.verificationStatus === 'verified' && isEmbeddingConfigured()) {
    try {
      if (await indexEmbeddings('knowledge', [reindexed])) retrieval = 'hybrid'
    } catch (error) {
      console.warn('Could not re-index imported-record embeddings; lexical retrieval remains available:', error instanceof Error ? error.message : 'unknown error')
    }
  }
  saveIngestionLog({ sourceUrl: reindexed.url, sourceName: reindexed.sourceName, contentHash: reindexed.contentHash, status: 'indexed', verificationStatus: reindexed.verificationStatus })
  return response.json({ ok: true, retrieval, updatedAt: reindexed.updatedAt })
})

app.post('/api/admin/knowledge/documents', requireAdmin, upload.single('document'), async (request, response, next) => {
  const rawSourceUrl = typeof request.body?.url === 'string' ? request.body.url : ''
  const rawSourceName = typeof request.body?.sourceName === 'string' ? request.body.sourceName : 'Administrator document'
  let verificationStatus: 'verified' | 'pending' | 'unverified' = 'pending'
  try {
    const metadata = adminDocumentMetadataSchema.safeParse(request.body)
    if (!metadata.success) {
      saveIngestionLog({ sourceUrl: rawSourceUrl, sourceName: rawSourceName, status: 'failed', verificationStatus, error: 'Invalid source metadata; use an HTTPS BIS source URL and complete all required fields.' })
      return response.status(400).json({ error: 'Provide a title, category, source name, and HTTPS BIS source URL.' })
    }
    verificationStatus = metadata.data.verificationStatus
    const file = request.file
    if (!file) {
      saveIngestionLog({ sourceUrl: metadata.data.url, sourceName: metadata.data.sourceName, status: 'failed', verificationStatus, error: 'No PDF file was uploaded.' })
      return response.status(400).json({ error: 'Choose a PDF document to import.' })
    }
    const hash = contentHash(file.buffer)
    if (knowledgeSourceExists(metadata.data.url, hash)) {
      saveIngestionLog({ sourceUrl: metadata.data.url, sourceName: metadata.data.sourceName, contentHash: hash, status: 'duplicate', verificationStatus, error: 'This source URL and PDF content are already indexed.' })
      return response.status(409).json({ error: 'This source and PDF are already indexed. Upload changed content to re-index this source.' })
    }
    const reindexed = knowledgeDocumentExists(metadata.data.url)
    const { pageTexts } = await extractPdfPages(file.buffer)
    const sourceKey = createHash('sha256').update(metadata.data.url).digest('hex').slice(0, 24)
    const now = new Date().toISOString()
    const records = pageTexts.flatMap((text, pageIndex) => chunkPageText(text).map((content, chunkIndex) => {
      const page = pageIndex + 1
      const chunkHash = contentHash(content)
      return {
        id: `pdf-${sourceKey}-p${page}-c${chunkIndex + 1}`,
        title: metadata.data.title,
        content,
        kind: 'Administrator PDF excerpt',
        category: metadata.data.category,
        reference: `Page ${page}`,
        url: metadata.data.url,
        sourceName: metadata.data.sourceName,
        documentType: 'PDF',
        section: undefined,
        page,
        tags: [],
        language: 'English',
        version: undefined,
        createdAt: now,
        updatedAt: now,
        sourceType: 'admin_pdf' as const,
        publisher: 'Bureau of Indian Standards',
        publishedDate: undefined,
        lastVerifiedAt: verificationStatus === 'verified' ? now : undefined,
        contentHash: chunkHash,
        verificationStatus,
      }
    }))
    if (!records.length) {
      saveIngestionLog({ sourceUrl: metadata.data.url, sourceName: metadata.data.sourceName, contentHash: hash, status: 'failed', verificationStatus, error: 'No extractable text was found in the PDF.' })
      return response.status(422).json({ error: 'No extractable text was found. Scanned PDFs need OCR, which is not included.' })
    }
    const priorIds = reindexed ? listIngestedKnowledge().filter((record) => record.url === metadata.data.url && record.sourceType === 'admin_pdf').map((record) => record.id) : []
    deleteVectorEmbeddings('knowledge', [...priorIds, ...records.map((record) => record.id)])
    saveKnowledgeDocumentRecords(records, metadata.data.url)
    let retrieval = 'lexical'
    if (verificationStatus === 'verified' && isEmbeddingConfigured()) {
      try {
        if (await indexEmbeddings('knowledge', records)) retrieval = 'hybrid'
      } catch (error) {
        console.warn('Could not create administrator PDF embeddings; lexical retrieval remains available:', error instanceof Error ? error.message : 'unknown error')
      }
    }
    saveIngestionLog({ sourceUrl: metadata.data.url, sourceName: metadata.data.sourceName, contentHash: hash, status: 'indexed', verificationStatus })
    return response.status(201).json({ indexed: true, records: records.length, verificationStatus, reindexed, retrieval })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PDF ingestion failed.'
    saveIngestionLog({ sourceUrl: rawSourceUrl, sourceName: rawSourceName, status: 'failed', verificationStatus, error: message.slice(0, 500) })
    return next(error)
  }
})

app.delete('/api/admin/knowledge/:id', requireAdmin, (request, response) => {
  const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id
  if (!id || !deleteIngestedKnowledge(id)) return response.status(404).json({ error: 'That imported record could not be found.' })
  deleteVectorEmbeddings('knowledge', [id])
  return response.json({ ok: true })
})

app.get('/api/catalog', (_request, response) => response.json({ standards: getStandardCatalog(), services: getServiceCatalog(), dataLabel: 'Illustrative records; not a complete or current BIS catalog.' }))

app.get('/api/standards', (request, response) => {
  const parsed = catalogQuerySchema.safeParse(request.query)
  if (!parsed.success) return response.status(400).json({ error: 'Provide valid catalog filters and pagination.' })
  const { query, category, page, pageSize } = parsed.data
  let records = getStandardCatalog()
  if (category) records = records.filter((record) => record.category.toLocaleLowerCase() === category.toLocaleLowerCase())
  if (query) {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    records = records.filter((record) => terms.every((term) => `${record.title} ${record.number ?? ''} ${record.category} ${record.summary} ${(record.tags ?? []).join(' ')}`.toLocaleLowerCase().includes(term)))
    recordApplicationEvent('search')
  }
  const total = records.length
  return response.json({ standards: records.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) }, dataLabel: 'Illustrative and administrator-maintained records; verify current status with BIS.' })
})

app.get('/api/services', (request, response) => {
  const parsed = catalogQuerySchema.safeParse(request.query)
  if (!parsed.success) return response.status(400).json({ error: 'Provide valid catalog filters and pagination.' })
  const { query, category, page, pageSize } = parsed.data
  let items = getServiceCatalog()
  if (category) items = items.filter((item) => item.category.toLocaleLowerCase() === category.toLocaleLowerCase())
  if (query) {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    items = items.filter((item) => terms.every((term) => `${item.title} ${item.category} ${item.summary} ${(item.tags ?? []).join(' ')}`.toLocaleLowerCase().includes(term)))
    recordApplicationEvent('search')
  }
  const total = items.length
  return response.json({ services: items.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) }, dataLabel: 'Verify current service details on the linked official BIS pages.' })
})

app.get('/api/services/:id', (request, response) => {
  const item = getServiceCatalog().find((service) => service.id === request.params.id)
  if (!item) return response.status(404).json({ error: 'That service topic is not in the local knowledge set.' })
  const source = listIngestedKnowledge().find((record) => record.url === item.source) ?? null
  return response.json({ ...item, sourceRecord: source ?? null, dataLabel: 'Verify current process details on the linked official BIS page.' })
})

app.post(['/api/search/standards', '/api/standards/search'], async (request, response) => {
  const parsed = standardsQuerySchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Enter a search query of 1 to 300 characters.' })
  const corpus = getKnowledgeCorpus().filter((item) => item.id.startsWith('standard-') || item.category === 'Indian Standards')
  const { matches, method } = await retrieveHybrid(parsed.data.query, corpus, 'knowledge', 20, 1)
  const catalog = new Map(getStandardCatalog().map((item) => [item.id, item]))
  recordApplicationEvent('search')
  return response.json({ results: matches.map((match) => ({ ...(catalog.get(match.id) ?? asStandardRecord(match)), score: match.score, source: match.url })), retrieval: method, dataLabel: 'Illustrative records, not a complete or current BIS catalog.' })
})

app.get('/api/standards/:id', (request, response) => {
  const record = getKnowledgeCorpus().find((chunk) => chunk.id === request.params.id)
  const item = getStandardCatalog().find((standard) => standard.id === request.params.id)
  if (!item) return response.status(404).json({ error: 'That standard record could not be found.' })
  return response.json({ ...item, sourceRecord: record ?? null, dataLabel: 'Illustrative record; verify scope and status through BIS.' })
})

app.post('/api/chat', async (request, response) => {
  const parsed = chatSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Enter a question of 1 to 2,000 characters.' })
  const { question, language, history } = parsed.data
  if (language !== 'English' && !isAiConfigured()) return response.status(400).json({ error: 'Hindi and Tamil answers require a configured language model. English remains available with local retrieval.' })
  const { guestSessionId, conversationId } = parsed.data
  if (conversationId && (!guestSessionId || !conversationBelongsToSession(conversationId, guestSessionId))) return response.status(404).json({ error: 'That conversation could not be found.' })
  const priorHistory = history.at(-1)?.role === 'user' && history.at(-1)?.text === question ? history.slice(0, -1) : history
  const previousUserQuestion = [...priorHistory].reverse().find((message) => message.role === 'user')?.text
  const contextualQuery = previousUserQuestion ? `${previousUserQuestion} ${question}` : question
  const { matches: chunks, method } = await retrieveHybrid(contextualQuery, getKnowledgeCorpus(), 'knowledge', 4)
  const startedAt = Date.now()
  const result = await answerQuestion(question, language, priorHistory, chunks)
  recordApplicationEvent('question', { responseMs: Date.now() - startedAt, sourceCount: result.sources.length })
  if (guestSessionId && conversationId) {
    saveConversationMessage(conversationId, 'user', question)
    saveConversationMessage(conversationId, 'assistant', result.answer, result.sources, result.mode)
  }
  return response.json({ ...result, retrieval: method })
})

app.post('/api/documents/upload', upload.single('document'), async (request, response, next) => {
  try {
    const file = request.file
    if (!file) return response.status(400).json({ error: 'Choose a PDF file to upload.' })
    const parsedSession = z.string().uuid().safeParse(request.body?.guestSessionId)
    if (!parsedSession.success || !guestSessionExists(parsedSession.data)) return response.status(401).json({ error: 'Start a valid guest session before uploading a private document.' })
    const { pageTexts, pageCount } = await extractPdfPages(file.buffer)
    const documentId = randomUUID()
    const safeName = path.basename(file.originalname).replace(/[\r\n\0]/g, '').slice(0, 120)
    const chunks: DocumentChunk[] = pageTexts.flatMap((text, pageIndex) => {
      const pageNumber = pageIndex + 1
      return chunkPageText(text).map((content, index) => ({
        id: `${documentId}-p${pageNumber}-c${index + 1}`,
        title: safeName,
        kind: 'Uploaded PDF',
        reference: `Page ${pageNumber}`,
        content,
        tags: [],
        page: pageNumber,
        documentName: safeName,
      }))
    })
    if (!chunks.length) return response.status(422).json({ error: 'No extractable text was found. Scanned PDFs need OCR, which is not included in this demo.' })
    const uploadedAt = new Date().toISOString()
    saveDocument({ id: documentId, name: safeName, uploadedAt, pages: pageCount, chunks: chunks.length, status: 'READY' }, chunks.map((chunk) => ({
      id: chunk.id,
      title: chunk.title,
      kind: chunk.kind,
      reference: chunk.reference ?? '',
      content: chunk.content,
      page: chunk.page,
    })), parsedSession.data)
    let retrieval = 'lexical'
    if (isEmbeddingConfigured()) {
      try {
        if (await indexEmbeddings('document', chunks)) retrieval = 'hybrid'
      } catch (error) {
        console.warn('Could not create private document embeddings; lexical retrieval remains available:', error instanceof Error ? error.message : 'unknown error')
      }
    }
    recordApplicationEvent('document_upload')
    return response.status(201).json({ documentId, id: documentId, name: safeName, pages: pageCount, chunks: chunks.length, uploadedAt, status: 'READY', retrieval })
  } catch (error) {
    return next(error)
  }
})

app.post(['/api/documents/query', '/api/documents/:id/query'], async (request, response) => {
  const parsed = documentQuerySchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Provide a document and a question of 1 to 2,000 characters.' })
  const documentId = (Array.isArray(request.params.id) ? request.params.id[0] : request.params.id) ?? parsed.data.documentId
  if (!documentId) return response.status(400).json({ error: 'Provide a document ID and a question.' })
  if (parsed.data.language !== 'English' && !isAiConfigured()) return response.status(400).json({ error: 'Hindi and Tamil answers require a configured language model. English remains available with local retrieval.' })
  const { guestSessionId, conversationId } = parsed.data
  if (!guestSessionExists(guestSessionId)) return response.status(401).json({ error: 'Start a valid guest session before querying a private document.' })
  if (conversationId && (!guestSessionId || !conversationBelongsToSession(conversationId, guestSessionId))) return response.status(404).json({ error: 'That conversation could not be found.' })
  const stored = getStoredDocument(documentId, guestSessionId)
  if (!stored) return response.status(404).json({ error: 'That document could not be found.' })
  const documentChunks: DocumentChunk[] = stored.chunks.map((chunk) => ({ ...chunk, tags: [], documentName: stored.document.name }))
  const priorHistory = parsed.data.history.at(-1)?.role === 'user' && parsed.data.history.at(-1)?.text === parsed.data.question ? parsed.data.history.slice(0, -1) : parsed.data.history
  const previousUserQuestion = [...priorHistory].reverse().find((message) => message.role === 'user')?.text
  const contextualQuery = previousUserQuestion ? `${previousUserQuestion} ${parsed.data.question}` : parsed.data.question
  const { matches, method } = await retrieveHybrid(contextualQuery, documentChunks, 'document', 4, 1)
  const startedAt = Date.now()
  const result = await answerQuestion(parsed.data.question, parsed.data.language, priorHistory, matches)
  recordApplicationEvent('question', { responseMs: Date.now() - startedAt, sourceCount: result.sources.length })
  const responseResult = { ...result, retrieval: method, sources: result.sources.map((source) => ({ ...source, label: `Page ${documentChunks.find((chunk) => chunk.id === source.id)?.page ?? ''}` })) }
  if (guestSessionId && conversationId) {
    saveConversationMessage(conversationId, 'user', parsed.data.question)
    saveConversationMessage(conversationId, 'assistant', result.answer, responseResult.sources, result.mode)
  }
  return response.json(responseResult)
})

app.get('/api/documents', (request, response) => {
  const guestSessionId = z.string().uuid().safeParse(request.query.guestSessionId)
  if (!guestSessionId.success || !guestSessionExists(guestSessionId.data)) return response.status(401).json({ error: 'Provide a valid guest session ID.' })
  return response.json({ documents: listDocuments(guestSessionId.data) })
})

app.get('/api/documents/:id', (request, response) => {
  const guestSessionId = z.string().uuid().safeParse(request.query.guestSessionId)
  if (!guestSessionId.success || !guestSessionExists(guestSessionId.data)) return response.status(401).json({ error: 'Provide a valid guest session ID.' })
  const stored = getStoredDocument(request.params.id, guestSessionId.data)
  if (!stored) return response.status(404).json({ error: 'That document could not be found.' })
  return response.json({ document: stored.document })
})

app.delete('/api/documents/:id', (request, response) => {
  if (!z.string().uuid().safeParse(request.params.id).success) return response.status(400).json({ error: 'Invalid document ID.' })
  const guestSessionId = z.string().uuid().safeParse(request.query.guestSessionId)
  if (!guestSessionId.success || !guestSessionExists(guestSessionId.data)) return response.status(401).json({ error: 'Provide a valid guest session ID.' })
  const stored = getStoredDocument(request.params.id, guestSessionId.data)
  if (!stored) return response.status(404).json({ error: 'That document could not be found.' })
  deleteVectorEmbeddings('document', stored.chunks.map((chunk) => chunk.id))
  if (!deleteDocument(request.params.id, guestSessionId.data)) return response.status(404).json({ error: 'That document could not be found.' })
  return response.json({ ok: true })
})

app.post('/api/feedback', (request, response) => {
  const parsed = feedbackSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: 'Feedback must include a message ID and rating.' })
  saveFeedback(parsed.data.messageId, parsed.data.rating, parsed.data.comment)
  recordApplicationEvent('feedback')
  return response.status(201).json({ ok: true })
})

app.get(['/api/metrics', '/api/insights'], async (request, response) => {
  const from = typeof request.query.from === 'string' ? request.query.from : undefined
  const to = typeof request.query.to === 'string' ? request.query.to : undefined
  const datePattern = /^\d{4}-\d{2}-\d{2}$/
  const isDate = (value: string) => {
    if (!datePattern.test(value)) return false
    const date = new Date(`${value}T00:00:00.000Z`)
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  }
  if ((from && !isDate(from)) || (to && !isDate(to))) return response.status(400).json({ error: 'Dates must be valid calendar dates in YYYY-MM-DD format.' })
  if (from && to && from > to) return response.status(400).json({ error: 'The start date must not be later than the end date.' })
  const toExclusive = to ? new Date(`${to}T00:00:00.000Z`) : undefined
  if (toExclusive) toExclusive.setUTCDate(toExclusive.getUTCDate() + 1)
  const endDateExclusive = toExclusive?.toISOString().slice(0, 10)
  const documentMetrics = getDocumentMetrics(from, endDateExclusive)
  const feedbackMetrics = getFeedbackMetrics(from, endDateExclusive)
  const events = getApplicationEventMetrics(from, endDateExclusive)
  const embeddingProvider = await probeEmbeddingProvider()
  const database = getDatabaseHealth()
  const records = listIngestedKnowledge()
  const standardRecordCount = records.filter((record) => record.category === 'Indian Standards' || Boolean(record.standardNumber)).length
  const serviceRecordCount = records.filter((record) => serviceKnowledgeCategories.has(record.category) || serviceSourceUrls.has(record.url)).length
  const indexedVectors = embeddingProvider.model ? vectorEmbeddingCount(embeddingProvider.model, 'knowledge') : 0
  const retrievalStatus = embeddingProvider.status === 'connected'
    ? indexedVectors > 0 ? 'connected' : 'indexing required'
    : embeddingProvider.status
  response.json({
    standardsRecords: standardRecordCount,
    serviceTopics: serviceRecordCount,
    knowledgeRecords: knowledgeRecordCount(),
    documentCount: documentMetrics.documentCount,
    indexedChunks: documentMetrics.chunkCount,
    feedbackCount: feedbackMetrics.feedbackCount,
    helpfulCount: feedbackMetrics.helpfulCount ?? 0,
    notHelpfulCount: feedbackMetrics.notHelpfulCount ?? 0,
    aiConfigured: isAiConfigured(),
    aiProvider: {
      status: isAiConfigured() ? aiProviderStatus : 'not configured',
      configured: isAiConfigured(),
      model: isAiConfigured() ? process.env.AI_MODEL : null,
    },
    embeddingProvider,
    retrievalEngine: {
      status: retrievalStatus,
      method: retrievalStatus === 'connected' ? 'hybrid lexical + SQLite cosine similarity' : 'lexical token overlap fallback',
      indexedVectors,
    },
    database: database.status === 'connected' ? 'SQLite connected' : 'SQLite unhealthy',
    databaseHealth: database,
    liveBis: {
      status: 'unavailable',
      configured: false,
      message: 'No supported public BIS API or data feed is configured; official BIS links and reviewed manual imports are available.',
    },
    events,
  })
})

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return response.status(413).json({ error: 'PDFs must be 10 MB or smaller.' })
  if (error instanceof multer.MulterError || error.message === 'Upload a PDF file up to 10 MB.') return response.status(415).json({ error: 'Upload a PDF file up to 10 MB.' })
  if (error?.name === 'InvalidPDFException' || error?.name === 'FormatError') return response.status(422).json({ error: 'The PDF could not be read. Try a different text-based PDF.' })
  if (typeof error?.statusCode === 'number') return response.status(error.statusCode).json({ error: error.message })
  console.error('Request failed:', error instanceof Error ? error.message : 'unknown error')
  return response.status(500).json({ error: 'The request could not be completed. Please try again.' })
}

app.use(errorHandler)
app.listen(port, () => {
  console.info(`Manak Mitra API listening on port ${port}`)
  if (!isEmbeddingConfigured()) return
  const model = process.env.EMBEDDING_MODEL
  if (!model) return
  const corpus = getKnowledgeCorpus()
  const existing = new Set(listVectorEmbeddings('knowledge', corpus.map((record) => record.id), model).map((record) => record.sourceId))
  const missing = corpus.filter((record) => !existing.has(record.id))
  if (missing.length) {
    void indexEmbeddings('knowledge', missing).catch((error: unknown) => {
      console.warn('Could not build the initial semantic index; lexical retrieval remains available:', error instanceof Error ? error.message : 'unknown error')
    })
  }
})