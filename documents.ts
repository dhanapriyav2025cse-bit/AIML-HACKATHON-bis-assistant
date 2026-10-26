import { getDocument as getPdfDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

export class DocumentProcessingError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = 'DocumentProcessingError'
  }
}

export async function extractPdfPages(bytes: Uint8Array) {
  if (Buffer.from(bytes).subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new DocumentProcessingError('The uploaded file is not a valid PDF.', 415)
  }
  const loadingTask = getPdfDocument({ data: Uint8Array.from(bytes), useSystemFonts: true })
  try {
    let pdf
    try {
      pdf = await loadingTask.promise
    } catch (error) {
      if (error instanceof Error && error.name === 'PasswordException') {
        throw new DocumentProcessingError('Password-protected PDFs are not supported. Remove the password and upload the PDF again.', 422)
      }
      throw error
    }
    if (pdf.numPages > 500) throw new DocumentProcessingError('PDFs are limited to 500 pages.', 413)
    const pageTexts: string[] = []
    let characterCount = 0
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim()
      characterCount += text.length
      if (characterCount > 2_000_000) throw new DocumentProcessingError('Extracted PDF text exceeds the 2 MB processing limit.', 413)
      pageTexts.push(text)
    }
    return { pageTexts, pageCount: pdf.numPages }
  } finally {
    await loadingTask.destroy()
  }
}

export function chunkPageText(text: string) {
  const chunks: string[] = []
  const cleanText = text.replace(/\s+/g, ' ').trim()
  for (let start = 0; start < cleanText.length; start += 800) {
    const chunk = cleanText.slice(start, start + 900).trim()
    if (chunk) chunks.push(chunk)
  }
  return chunks
}
