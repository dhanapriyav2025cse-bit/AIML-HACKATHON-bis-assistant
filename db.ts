import { mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const databasePath = path.resolve(process.cwd(), process.env.DATABASE_PATH || 'backend/data/manak-mitra.sqlite')
mkdirSync(path.dirname(databasePath), { recursive: true })

export const database = new DatabaseSync(databasePath)
database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')

const currentVersion = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
  if (currentVersion >= version) continue
  const migrationPath = path.resolve(process.cwd(), `backend/migrations/${String(version).padStart(3, '0')}-initial.sql`)
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(readFileSync(migrationPath, 'utf8'))
    database.exec(`PRAGMA user_version = ${version}; COMMIT`)
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export type StoredDocument = {
  id: string
  name: string
  uploadedAt: string
  pages: number
  chunks: number
  status: 'READY'
}

export type StoredDocumentChunk = {
  id: string
  title: string
  kind: string
  reference: string
  content: string
  page: number
}

export type StoredVectorEmbedding = {
  sourceType: 'knowledge' | 'document'
  sourceId: string
  model: string
  vector: number[]
}

export function saveVectorEmbeddings(records: StoredVectorEmbedding[]) {
  const insert = database.prepare('INSERT INTO vector_embeddings (source_type, source_id, model, dimensions, vector_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_type, source_id, model) DO UPDATE SET dimensions = excluded.dimensions, vector_json = excluded.vector_json, updated_at = excluded.updated_at')
  const updatedAt = new Date().toISOString()
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const record of records) insert.run(record.sourceType, record.sourceId, record.model, record.vector.length, JSON.stringify(record.vector), updatedAt)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function listVectorEmbeddings(sourceType: StoredVectorEmbedding['sourceType'], ids: string[], model: string): StoredVectorEmbedding[] {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = database.prepare(`SELECT source_type AS sourceType, source_id AS sourceId, model, dimensions, vector_json AS vectorJson FROM vector_embeddings WHERE source_type = ? AND model = ? AND source_id IN (${placeholders})`)
    .all(sourceType, model, ...ids) as { sourceType: StoredVectorEmbedding['sourceType']; sourceId: string; model: string; dimensions: number; vectorJson: string }[]
  return rows.map(({ vectorJson, dimensions, ...row }) => {
    const vector = JSON.parse(vectorJson) as number[]
    if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) throw new Error(`Stored embedding ${row.sourceId} is invalid.`)
    return { ...row, vector }
  })
}

export function deleteVectorEmbeddings(sourceType: StoredVectorEmbedding['sourceType'], ids: string[]) {
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(', ')
  database.prepare(`DELETE FROM vector_embeddings WHERE source_type = ? AND source_id IN (${placeholders})`).run(sourceType, ...ids)
}

export function vectorEmbeddingCount(model: string, sourceType?: StoredVectorEmbedding['sourceType']) {
  const row = sourceType
    ? database.prepare('SELECT COUNT(*) AS count FROM vector_embeddings WHERE model = ? AND source_type = ?').get(model, sourceType)
    : database.prepare('SELECT COUNT(*) AS count FROM vector_embeddings WHERE model = ?').get(model)
  return (row as { count: number }).count
}

export function saveDocument(document: StoredDocument, chunks: StoredDocumentChunk[], guestSessionId: string) {
  const insertDocument = database.prepare('INSERT INTO documents (id, name, uploaded_at, pages, chunk_count, status, guest_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insertChunk = database.prepare('INSERT INTO document_chunks (id, document_id, title, kind, reference, content, page) VALUES (?, ?, ?, ?, ?, ?, ?)')
  database.exec('BEGIN IMMEDIATE')
  try {
    insertDocument.run(document.id, document.name, document.uploadedAt, document.pages, chunks.length, document.status, guestSessionId)
    for (const chunk of chunks) {
      insertChunk.run(chunk.id, document.id, chunk.title, chunk.kind, chunk.reference, chunk.content, chunk.page)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function listDocuments(guestSessionId: string): StoredDocument[] {
  return database.prepare('SELECT id, name, uploaded_at AS uploadedAt, pages, chunk_count AS chunks, status FROM documents WHERE guest_session_id = ? ORDER BY uploaded_at DESC').all(guestSessionId) as unknown as StoredDocument[]
}

export function getDocument(id: string, guestSessionId: string): { document: StoredDocument; chunks: StoredDocumentChunk[] } | undefined {
  const document = database.prepare('SELECT id, name, uploaded_at AS uploadedAt, pages, chunk_count AS chunks, status FROM documents WHERE id = ? AND guest_session_id = ?').get(id, guestSessionId) as StoredDocument | undefined
  if (!document) return undefined
  const chunks = database.prepare('SELECT id, title, kind, reference, content, page FROM document_chunks WHERE document_id = ? ORDER BY page, id').all(id) as unknown as StoredDocumentChunk[]
  return { document, chunks }
}

export function deleteDocument(id: string, guestSessionId: string) {
  return database.prepare('DELETE FROM documents WHERE id = ? AND guest_session_id = ?').run(id, guestSessionId).changes > 0
}

export function saveFeedback(messageId: string, rating: 'helpful' | 'not_helpful', comment?: string) {
  database.prepare('INSERT INTO feedback (message_id, rating, comment, created_at) VALUES (?, ?, ?, ?)').run(messageId, rating, comment?.trim() || null, new Date().toISOString())
}

function timestampConditions(from?: string, toExclusive?: string) {
  const conditions: string[] = []
  const parameters: string[] = []
  if (from) {
    conditions.push('created_at >= ?')
    parameters.push(`${from}T00:00:00.000Z`)
  }
  if (toExclusive) {
    conditions.push('created_at < ?')
    parameters.push(`${toExclusive}T00:00:00.000Z`)
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', parameters }
}

export function getFeedbackMetrics(from?: string, toExclusive?: string) {
  const { where, parameters } = timestampConditions(from, toExclusive)
  return database.prepare(`SELECT COUNT(*) AS feedbackCount, SUM(CASE WHEN rating = 'helpful' THEN 1 ELSE 0 END) AS helpfulCount, SUM(CASE WHEN rating = 'not_helpful' THEN 1 ELSE 0 END) AS notHelpfulCount FROM feedback ${where}`).get(...parameters) as { feedbackCount: number; helpfulCount: number | null; notHelpfulCount: number | null }
}

export function getDocumentMetrics(from?: string, toExclusive?: string) {
  const conditions: string[] = []
  const parameters: string[] = []
  if (from) {
    conditions.push('uploaded_at >= ?')
    parameters.push(`${from}T00:00:00.000Z`)
  }
  if (toExclusive) {
    conditions.push('uploaded_at < ?')
    parameters.push(`${toExclusive}T00:00:00.000Z`)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return database.prepare(`SELECT COUNT(*) AS documentCount, COALESCE(SUM(chunk_count), 0) AS chunkCount FROM documents ${where}`).get(...parameters) as { documentCount: number; chunkCount: number }
}

export function getDatabaseHealth() {
  const result = database.prepare('PRAGMA quick_check').get() as { quick_check: string }
  const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  return { status: result.quick_check === 'ok' ? 'connected' : 'unhealthy', engine: 'SQLite', persistent: true, migrationVersion: version }
}

export type ApplicationEventType = 'search' | 'question' | 'document_upload' | 'feedback' | 'error'

export function recordApplicationEvent(type: ApplicationEventType, options: { responseMs?: number; sourceCount?: number } = {}) {
  database.prepare('INSERT INTO application_events (event_type, created_at, response_ms, source_count) VALUES (?, ?, ?, ?)')
    .run(type, new Date().toISOString(), options.responseMs ?? null, options.sourceCount ?? 0)
}

export function getApplicationEventMetrics(from?: string, toExclusive?: string) {
  const { where, parameters } = timestampConditions(from, toExclusive)
  const grouped = database.prepare(`SELECT event_type AS type, COUNT(*) AS count FROM application_events ${where} GROUP BY event_type`).all(...parameters) as { type: ApplicationEventType; count: number }[]
  const totals = database.prepare(`SELECT COUNT(*) AS eventCount, COALESCE(AVG(response_ms), 0) AS averageResponseMs, COALESCE(SUM(source_count), 0) AS citedSources FROM application_events ${where}`).get(...parameters) as { eventCount: number; averageResponseMs: number; citedSources: number }
  const daily = database.prepare(`SELECT substr(created_at, 1, 10) AS date, event_type AS type, COUNT(*) AS count FROM application_events ${where} GROUP BY date, event_type ORDER BY date`).all(...parameters) as { date: string; type: ApplicationEventType; count: number }[]
  return {
    ...totals,
    eventCounts: Object.fromEntries(grouped.map(({ type, count }) => [type, count])) as Partial<Record<ApplicationEventType, number>>,
    daily,
  }
}

export type StoredMessage = {
  id: number
  role: 'user' | 'assistant'
  content: string
  sources: unknown[]
  mode: string | null
  createdAt: string
}

export type StoredConversation = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export function registerGuestSession(id: string) {
  const now = new Date().toISOString()
  database.prepare('INSERT INTO guest_sessions (id, created_at, last_active_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_active_at = excluded.last_active_at').run(id, now, now)
}

export function guestSessionExists(id: string) {
  return Boolean(database.prepare('SELECT 1 FROM guest_sessions WHERE id = ?').get(id))
}

export function createConversation(guestSessionId: string, title: string): StoredConversation {
  const conversation = { id: crypto.randomUUID(), title: title.slice(0, 120), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  database.prepare('INSERT INTO conversations (id, guest_session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(conversation.id, guestSessionId, conversation.title, conversation.createdAt, conversation.updatedAt)
  return conversation
}

export function listConversations(guestSessionId: string): StoredConversation[] {
  return database.prepare('SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE guest_session_id = ? ORDER BY updated_at DESC').all(guestSessionId) as unknown as StoredConversation[]
}

export function conversationBelongsToSession(conversationId: string, guestSessionId: string) {
  return Boolean(database.prepare('SELECT 1 FROM conversations WHERE id = ? AND guest_session_id = ?').get(conversationId, guestSessionId))
}

export function deleteConversation(conversationId: string, guestSessionId: string) {
  return database.prepare('DELETE FROM conversations WHERE id = ? AND guest_session_id = ?').run(conversationId, guestSessionId).changes > 0
}

export function getConversationMessages(conversationId: string): StoredMessage[] {
  const rows = database.prepare('SELECT id, role, content, sources_json AS sourcesJson, mode, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId) as { id: number; role: 'user' | 'assistant'; content: string; sourcesJson: string; mode: string | null; createdAt: string }[]
  return rows.map(({ sourcesJson, ...row }) => ({ ...row, sources: JSON.parse(sourcesJson) as unknown[] }))
}

export function saveConversationMessage(conversationId: string, role: 'user' | 'assistant', content: string, sources: unknown[] = [], mode: string | null = null) {
  database.prepare('INSERT INTO messages (conversation_id, role, content, sources_json, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(conversationId, role, content, JSON.stringify(sources), mode, new Date().toISOString())
  database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), conversationId)
  if (role === 'user') database.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title = 'New conversation'").run(content.slice(0, 120), conversationId)
}

export type IngestedKnowledgeRecord = {
  id: string
  title: string
  content: string
  kind: string
  category: string
  reference?: string
  url: string
  sourceName: string
  standardNumber?: string
  documentType?: string
  section?: string
  page?: number
  tags: string[]
  language: string
  version?: string
  createdAt: string
  updatedAt: string
  sourceType: 'demo' | 'admin_excerpt' | 'admin_pdf'
  publisher: string
  publishedDate?: string
  lastVerifiedAt?: string
  contentHash: string
  verificationStatus: 'verified' | 'pending' | 'unverified' | 'demo'
}

export type AdminKnowledgeRecord = Omit<IngestedKnowledgeRecord, 'sourceType' | 'verificationStatus'> & {
  sourceType: 'admin_excerpt' | 'admin_pdf'
  verificationStatus: 'verified' | 'pending' | 'unverified'
}

export function saveKnowledgeRecord(record: IngestedKnowledgeRecord) {
  database.prepare('INSERT INTO knowledge_records (id, title, content, kind, category, reference, url, source_name, standard_number, document_type, section, page, tags_json, language, version, created_at, updated_at, source_type, publisher, published_date, last_verified_at, content_hash, verification_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    record.id, record.title, record.content, record.kind, record.category, record.reference ?? null, record.url, record.sourceName,
    record.standardNumber ?? null, record.documentType ?? null, record.section ?? null, record.page ?? null, JSON.stringify(record.tags), record.language, record.version ?? null, record.createdAt,
    record.updatedAt, record.sourceType, record.publisher, record.publishedDate ?? null, record.lastVerifiedAt ?? null, record.contentHash, record.verificationStatus,
  )
}

export function updateKnowledgeRecord(id: string, updates: Partial<Pick<AdminKnowledgeRecord, 'title' | 'content' | 'kind' | 'category' | 'reference' | 'url' | 'sourceName' | 'verificationStatus'>>) {
  const existing = getIngestedKnowledgeRecord(id)
  if (!existing) return undefined
  const record = { ...existing, ...updates, updatedAt: new Date().toISOString() }
  if (updates.content !== undefined) record.contentHash = createHash('sha256').update(record.content).digest('hex')
  if (updates.verificationStatus === 'verified') record.lastVerifiedAt = record.updatedAt
  database.prepare('UPDATE knowledge_records SET title = ?, content = ?, kind = ?, category = ?, reference = ?, url = ?, source_name = ?, updated_at = ?, verification_status = ?, content_hash = ?, last_verified_at = ? WHERE id = ? AND source_type != ?').run(
    record.title, record.content, record.kind, record.category, record.reference ?? null, record.url, record.sourceName,
    record.updatedAt, record.verificationStatus, record.contentHash, record.lastVerifiedAt ?? null, id, 'demo',
  )
  return record
}

export function getIngestedKnowledgeRecord(id: string): AdminKnowledgeRecord | undefined {
  return listIngestedKnowledge().find((record): record is AdminKnowledgeRecord =>
    record.id === id && record.sourceType !== 'demo' && record.verificationStatus !== 'demo')
}

export function seedDemoKnowledge(records: {
  id: string
  title: string
  content: string
  kind: string
  reference?: string
  url?: string
  tags?: string[]
}[]) {
  const now = new Date().toISOString()
  const insert = database.prepare("INSERT OR IGNORE INTO knowledge_records (id, title, content, kind, category, reference, url, source_name, tags_json, language, created_at, updated_at, source_type, publisher, content_hash, verification_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?, ?, 'demo')")
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const record of records) {
      const category = record.id.startsWith('standard-') && record.id !== 'standard-discovery' ? 'Indian Standards'
        : record.id === 'standards-store' || record.id === 'standard-discovery' ? 'Standards search'
          : record.id === 'consumer-complaint' ? 'Consumer services'
            : record.id.includes('certification') || record.id.includes('license') ? 'BIS certification'
              : 'BIS overview'
      insert.run(record.id, record.title, record.content, record.kind, category, record.reference ?? null, record.url ?? '', 'Manak Mitra illustrative corpus', JSON.stringify(record.tags ?? []), 'English', now, now, 'Manak Mitra demo dataset', createHash('sha256').update(record.content).digest('hex'))
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function saveKnowledgeDocumentRecords(records: IngestedKnowledgeRecord[], sourceUrl: string) {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare("DELETE FROM knowledge_records WHERE url = ? AND source_type = 'admin_pdf'").run(sourceUrl)
    for (const record of records) saveKnowledgeRecord(record)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function listIngestedKnowledge(): IngestedKnowledgeRecord[] {
  const rows = database.prepare('SELECT id, title, content, kind, category, reference, url, source_name AS sourceName, standard_number AS standardNumber, document_type AS documentType, section, page, tags_json AS tagsJson, language, version, created_at AS createdAt, updated_at AS updatedAt, source_type AS sourceType, publisher, published_date AS publishedDate, last_verified_at AS lastVerifiedAt, content_hash AS contentHash, verification_status AS verificationStatus FROM knowledge_records ORDER BY created_at DESC').all() as (Omit<IngestedKnowledgeRecord, 'tags'> & { tagsJson: string })[]
  return rows.map(({ tagsJson, ...record }) => ({ ...record, tags: JSON.parse(tagsJson) as string[] }))
}

export function deleteIngestedKnowledge(id: string) {
  return database.prepare("DELETE FROM knowledge_records WHERE id = ? AND source_type != 'demo'").run(id).changes > 0
}

export function knowledgeContentExists(contentHash: string) {
  return Boolean(database.prepare('SELECT 1 FROM knowledge_records WHERE content_hash = ? LIMIT 1').get(contentHash))
}

export function knowledgeSourceExists(sourceUrl: string, contentHash: string) {
  return Boolean(database.prepare("SELECT 1 FROM ingestion_logs WHERE source_url = ? AND content_hash = ? AND status = 'indexed' LIMIT 1").get(sourceUrl, contentHash))
}

export function knowledgeDocumentExists(sourceUrl: string) {
  return Boolean(database.prepare("SELECT 1 FROM knowledge_records WHERE url = ? AND source_type = 'admin_pdf' LIMIT 1").get(sourceUrl))
}

export function knowledgeRecordCount() {
  return (database.prepare('SELECT COUNT(*) AS count FROM knowledge_records').get() as { count: number }).count
}

export function saveIngestionLog(log: {
  sourceUrl: string
  sourceName: string
  contentHash?: string
  status: 'indexed' | 'duplicate' | 'failed'
  verificationStatus: 'verified' | 'pending' | 'unverified'
  error?: string
}) {
  database.prepare('INSERT INTO ingestion_logs (source_url, source_name, content_hash, status, verification_status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    log.sourceUrl, log.sourceName, log.contentHash ?? null, log.status, log.verificationStatus, log.error ?? null, new Date().toISOString(),
  )
}

export function listIngestionLogs(limit = 50) {
  return database.prepare('SELECT id, source_url AS sourceUrl, source_name AS sourceName, content_hash AS contentHash, status, verification_status AS verificationStatus, error, created_at AS createdAt FROM ingestion_logs ORDER BY id DESC LIMIT ?').all(limit) as {
    id: number
    sourceUrl: string
    sourceName: string
    contentHash: string | null
    status: 'indexed' | 'duplicate' | 'failed'
    verificationStatus: 'verified' | 'pending' | 'unverified'
    error: string | null
    createdAt: string
  }[]
}