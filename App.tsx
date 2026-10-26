import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  BadgeCheck,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Clipboard,
  Database,
  FileText,
  Globe2,
  GraduationCap,
  Home,
  Languages,
  LifeBuoy,
  Menu,
  MessageCircle,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  askAssistant,
  createConversation,
  deleteConversation,
  deleteDocument,
  getConversation,
  getConversations,
  getCatalog,
  getServices,
  getDocuments,
  addKnowledgeRecord,
  deleteKnowledgeRecord,
  getKnowledgeRecords,
  getManagedKnowledge,
  uploadKnowledgeDocument,
  importKnowledgeRecords,
  searchStandards,
  getHealth,
  getKnowledgeStatus,
  getInsights,
  startGuestSession,
  sendFeedback,
  uploadDocument,
  queryDocument,
  reindexManagedKnowledge,
  updateManagedKnowledge,
  type ManagedKnowledgeRecord,
  type KnowledgeRecordSummary,
} from "./lib/api";
import type { ChatMessage, CatalogItem, Conversation, SourceReference, StoredDocument } from "./types";
import "./App.css";
import "./Details.css";
import "./BisTheme.css";
import "./Typography.css";

type Page =
  | "Home"
  | "Assistant"
  | "Standards"
  | "BIS services"
  | "My documents"
  | "Insights"
  | "Knowledge base"
  | "Help";

const navItems: { label: Page; icon: LucideIcon }[] = [
  { label: "Home", icon: Home },
  { label: "Assistant", icon: MessageCircle },
  { label: "Standards", icon: BookOpen },
  { label: "BIS services", icon: LifeBuoy },
  { label: "My documents", icon: FileText },
  { label: "Insights", icon: Activity },
  { label: "Knowledge base", icon: Database },
  { label: "Help", icon: CircleHelp },
];

const prompts = [
  {
    icon: Search,
    title: "Find a standard",
    detail: "Search by product, topic or IS number",
    query: "Find standards related to electrical safety",
  },
  {
    icon: BadgeCheck,
    title: "Explore a BIS service",
    detail: "Understand available service information",
    query: "What BIS services can help a manufacturer?",
  },
  {
    icon: GraduationCap,
    title: "Explain it simply",
    detail: "Make technical information easier to read",
    query: "Explain what an Indian Standard is in simple language",
  },
];

function App() {
  const [page, setPage] = useState<Page>("Home");
  const [standards, setStandards] = useState<CatalogItem[]>([]);
  const [services, setServices] = useState<CatalogItem[]>([]);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [apiAvailable, setApiAvailable] = useState(false);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [knowledgeStatus, setKnowledgeStatus] = useState<Awaited<ReturnType<typeof getKnowledgeStatus>> | null>(null);
  const [insights, setInsights] = useState<Awaited<ReturnType<typeof getInsights>> | null>(null);
  const [guestSessionId, setGuestSessionId] = useState(() => sessionStorage.getItem("manak-mitra-guest-session") ?? "");
  const initialGuestSessionId = useRef(guestSessionId);
  const [conversationId, setConversationId] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sessionReady, setSessionReady] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [search, setSearch] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [feedbackStates, setFeedbackStates] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [language, setLanguage] = useState("English");
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [uploaded, setUploaded] = useState<StoredDocument | null>(null);
  const [notice, setNotice] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const [catalog, health, status, currentInsights] = await Promise.all([
          getCatalog(),
          getHealth(),
          getKnowledgeStatus(),
          getInsights(),
        ]);
        if (!active) return;
        setStandards(catalog.standards);
        setServices(catalog.services);
        setAiConfigured(health.aiConfigured);
        setApiAvailable(true);
        setKnowledgeStatus(status);
        setInsights(currentInsights);
      } catch {
        if (!active) return;
        setApiAvailable(false);
        setCatalogError("The local service is unavailable. Start the application with npm run dev.");
      }

      try {
        const session = await startGuestSession(initialGuestSessionId.current || undefined);
        if (!active) return;
        sessionStorage.setItem("manak-mitra-guest-session", session.guestSessionId);
        setGuestSessionId(session.guestSessionId);
        const currentDocuments = await getDocuments(session.guestSessionId);
        if (!active) return;
        setDocuments(currentDocuments.documents);
        const existing = await getConversations(session.guestSessionId);
        if (!active) return;
        setConversations(existing.conversations);
        if (existing.conversations[0]) {
          setConversationId(existing.conversations[0].id);
          const saved = await getConversation(existing.conversations[0].id, session.guestSessionId);
          if (!active) return;
          setMessages(saved.messages.map((message) => ({
            id: String(message.id),
            role: message.role,
            text: message.content,
            sources: message.sources,
            mode: message.mode === "llm" ? "llm" : message.mode === "demo" ? "demo" : undefined,
          })));
        } else {
          const created = await createConversation(session.guestSessionId);
          if (!active) return;
          setConversationId(created.conversation.id);
          setConversations([created.conversation]);
        }
        setSessionReady(true);
      } catch {
        if (active) setNotice("A guest conversation could not be restored. Start a new conversation when the API is available.");
      }
    }
    void initialize();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    if (page !== "Insights" && page !== "Knowledge base") return;
    let active = true;
    const refresh = page === "Insights" ? getInsights() : getKnowledgeStatus();
    void refresh.then((result) => {
      if (!active) return;
      if (page === "Insights") setInsights(result as Awaited<ReturnType<typeof getInsights>>);
      else setKnowledgeStatus(result as Awaited<ReturnType<typeof getKnowledgeStatus>>);
    }).catch(() => {
      if (active) setNotice("Live system metrics could not be refreshed.");
    });
    return () => { active = false; };
  }, [page]);

  const showAssistant = (text = "") => {
    setPage("Assistant");
    setDraft(text);
  };
  const filteredStandards = standards.filter((item) =>
    `${item.title} ${item.number} ${item.category} ${item.summary}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const filteredServices = services.filter((item) =>
    `${item.title} ${item.category} ${item.summary}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  async function submitQuestion(event?: FormEvent) {
    event?.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: question,
    };
    const history = [...messages, userMessage];
    setMessages(history);
    setDraft("");
    setBusy(true);
    try {
      const result = uploaded
        ? await queryDocument({
            documentId: uploaded.id,
            question,
            language,
            guestSessionId,
            conversationId,
            history: history.slice(-8).map(({ role, text }) => ({ role, text })),
          })
        : await askAssistant({
            question,
            language,
            history: history
              .slice(-8)
              .map(({ role, text }) => ({ role, text })),
              guestSessionId,
              conversationId,
          });
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: result.answer,
          sources: result.sources,
          mode: result.mode,
        },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: error instanceof Error && !error.message.startsWith("Request failed")
            ? error.message
            : "I could not complete that request. Check the connection and try again.",
          sources: [],
          mode: "unavailable",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(file?: File) {
    if (!file) return;
    setFileBusy(true);
    setNotice("");
    try {
      if (!guestSessionId) throw new Error("Start a guest session before uploading a private document.");
      const result = await uploadDocument(file, guestSessionId);
      const stored = { id: result.documentId, name: result.name, pages: result.pages, chunks: result.chunks, uploadedAt: result.uploadedAt, status: result.status } as StoredDocument;
      setDocuments((current) => [stored, ...current.filter((document) => document.id !== stored.id)]);
      setUploaded(stored);
      setNotice(
        `${result.name} is ready to query. Its extracted text is stored in the local SQLite database.`,
      );
      setPage("My documents");
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The PDF could not be processed.",
      );
    } finally {
      setFileBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function feedback(
    messageId: string,
    rating: "helpful" | "not_helpful",
  ) {
    setFeedbackStates((current) => ({ ...current, [messageId]: "Saving feedback…" }));
    try {
      await sendFeedback({ messageId, rating });
      setFeedbackStates((current) => ({ ...current, [messageId]: "Feedback saved." }));
    } catch {
      setFeedbackStates((current) => ({ ...current, [messageId]: "Feedback could not be saved." }));
    }
  }

  async function clearSession() {
    try {
      if (conversationId && guestSessionId) await deleteConversation(conversationId, guestSessionId);
      setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));
      setMessages([]);
      setConversationId("");
      setNotice("");
      await startNewConversation();
    } catch {
      setNotice("This conversation could not be cleared. Please retry.");
    }
  }

  async function startNewConversation() {
    try {
      const session = guestSessionId ? { guestSessionId } : await startGuestSession();
      sessionStorage.setItem("manak-mitra-guest-session", session.guestSessionId);
      setGuestSessionId(session.guestSessionId);
      const created = await createConversation(session.guestSessionId);
      setConversationId(created.conversation.id);
      setConversations((current) => [created.conversation, ...current]);
      setMessages([]);
      setNotice("New guest conversation started.");
    } catch {
      setNotice("A new conversation could not be started. Check that the API is running.");
    }
  }

  async function switchConversation(id: string) {
    if (!guestSessionId || !id) return;
    try {
      const saved = await getConversation(id, guestSessionId);
      setConversationId(id);
      setMessages(saved.messages.map((message) => ({
        id: String(message.id), role: message.role, text: message.content, sources: message.sources,
        mode: message.mode === "llm" ? "llm" : message.mode === "demo" ? "demo" : undefined,
      })));
      setNotice("");
    } catch {
      setNotice("That conversation could not be loaded.");
    }
  }

  async function removeDocument(documentId: string) {
    try {
      if (!guestSessionId) throw new Error("Start a guest session before deleting a private document.");
      await deleteDocument(documentId, guestSessionId);
      const remaining = documents.filter((document) => document.id !== documentId);
      setDocuments(remaining);
      setUploaded((current) => current?.id === documentId ? remaining[0] ?? null : current);
      setNotice("The document and its indexed text were deleted.");
    } catch {
      setNotice("The document could not be deleted. Please retry.");
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}>
        <a
          className="brand"
          href="#home"
          onClick={(event) => {
            event.preventDefault();
            setPage("Home");
          }}
        >
          <span className="brand-mark">
            <span>म</span>
          </span>
          <span className="brand-copy">
            <strong>Manak Mitra</strong>
            <small>STANDARDS, MADE CLEAR</small>
          </span>
          <button
            className="icon-button mobile-close"
            aria-label="Close navigation"
            onClick={(event) => {
              event.preventDefault();
              setMobileNavOpen(false);
            }}
          >
            <X size={18} />
          </button>
        </a>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {navItems.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={`nav-link ${page === label ? "active" : ""}`}
              onClick={() => {
                setPage(label);
                setMobileNavOpen(false);
              }}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {label === "My documents" && uploaded && (
                <span className="nav-count">1</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
            <button className="source-status sidebar-clickable" onClick={() => setPage("Knowledge base")}>
            <span className="status-dot" />
            <div>
                <strong>Local knowledge base</strong>
                <small>{knowledgeStatus ? `${knowledgeStatus.knowledge.records} records · ${knowledgeStatus.knowledge.complete ? "complete" : "curated"}` : "Checking status"}</small>
            </div>
            <ChevronDown size={14} />
            </button>
            <button className="sidebar-help" onClick={() => setPage("Help")}>
            <CircleHelp size={17} />
            <span>Information assistant</span>
            </button>
            <button className="user-mini" onClick={() => void startNewConversation()}>
            <span className="avatar">MM</span>
            <span>
                <strong>{guestSessionId ? "Guest session" : "Starting session"}</strong>
                <small>{conversations.length} saved conversations · no sign-in</small>
            </span>
            <Menu size={16} />
            </button>
        </div>
      </aside>

      {mobileNavOpen && (
        <button
          className="mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <main className="main-area">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>Manak Mitra</span>
            <span className="crumb-slash">/</span>
            <strong>{page}</strong>
          </div>
          <div className="topbar-actions">
            <span className="demo-pill" title={apiAvailable ? "Local API connected" : "Local API unavailable"}>
              <span className="status-dot" /> {apiAvailable ? "LOCAL RAG" : "API OFFLINE"}
            </span>
            <button className="language-button">
              <Globe2 size={16} />
              <span>{language}</span>
              <ChevronDown size={14} />
              <select
                aria-label="Answer language"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              >
                <option>English</option>
                <option disabled={!aiConfigured}>Hindi{!aiConfigured ? " (provider required)" : ""}</option>
                <option disabled={!aiConfigured}>Tamil{!aiConfigured ? " (provider required)" : ""}</option>
              </select>
            </button>
          </div>
        </header>

        <div className="content-area">
          {page === "Home" && (
            <HomePage onAsk={showAssistant} onNavigate={setPage} />
          )}
          {page === "Assistant" && (
            <AssistantPage
              messages={messages}
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              language={language}
              uploaded={uploaded}
              fileInput={fileInput}
              chatEnd={chatEnd}
              onSubmit={submitQuestion}
              onUpload={handleUpload}
              fileBusy={fileBusy}
              onFeedback={feedback}
              feedbackStates={feedbackStates}
              onClear={clearSession}
              onNewConversation={startNewConversation}
              conversations={conversations}
              conversationId={conversationId}
              onSwitchConversation={switchConversation}
              sessionReady={sessionReady}
            />
          )}
          {page === "Standards" && (
            <CatalogPage
              kind="standards"
              items={filteredStandards}
              search={search}
              setSearch={setSearch}
              onAsk={showAssistant}
            />
          )}
          {page === "BIS services" && (
            <CatalogPage
              kind="services"
              items={filteredServices}
              search={search}
              setSearch={setSearch}
              onAsk={showAssistant}
            />
          )}
          {page === "My documents" && (
            <DocumentsPage
              documents={documents}
              uploaded={uploaded}
              busy={fileBusy}
              notice={notice}
              fileInput={fileInput}
              onUpload={handleUpload}
              onAsk={showAssistant}
              onDelete={removeDocument}
              onOpenDocument={(document) => {
                setUploaded(document);
                showAssistant();
              }}
            />
          )}
          {page === "Insights" && <InsightsPage insights={insights} />}
          {page === "Knowledge base" && knowledgeStatus && <KnowledgeBasePage status={knowledgeStatus} onStatusChange={setKnowledgeStatus} />}
          {page === "Help" && <HelpPage aiConfigured={aiConfigured} />}
          {catalogError && (
            <div className="inline-error" role="status">
              {catalogError}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function HomePage({
  onAsk,
  onNavigate,
}: {
  onAsk: (text?: string) => void;
  onNavigate: (page: Page) => void;
}) {
  const [homeQuery, setHomeQuery] = useState("");
  return (
    <>
      <section className="welcome-row">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-line" /> YOUR BIS INFORMATION COMPANION
          </div>
          <h1>{"A clearer path through\nIndian Standards."}</h1>
          <p className="welcome-copy">
            Explore standards, make sense of services, and find answers backed
            by the information available here.
          </p>
          <div className="hero-actions">
            <button
              className="button-primary"
              onClick={() => onNavigate("Assistant")}
            >
              Ask the assistant <MessageCircle size={15} />
            </button>
            <button
              className="button-primary"
              onClick={() => onNavigate("Standards")}
            >
              Search standards <ArrowRight size={15} />
            </button>
            <button
              className="button-secondary"
              onClick={() => onNavigate("BIS services")}
            >
              Explore BIS services
            </button>
          </div>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-sun" />
          <div className="art-page">
            <span />
            <span />
            <span />
            <b>IS</b>
          </div>
          <div className="art-leaf art-leaf-one" />
          <div className="art-leaf art-leaf-two" />
          <div className="art-stamp">
            <ShieldCheck size={20} />
            <span>
              GROUNDED
              <br />
              ANSWERS
            </span>
          </div>
        </div>
      </section>
      <section className="search-panel">
        <div className="search-label">
          <span className="search-icon-wrap">
            <Sparkles size={17} />
          </span>
          <div>
            <strong>What are you looking for?</strong>
            <small>
              Ask about the curated local records; this is not a live BIS catalog
            </small>
          </div>
        </div>
        <form
          className="home-search"
          onSubmit={(event) => {
            event.preventDefault();
            onAsk(homeQuery);
            setHomeQuery("");
          }}
        >
          <Search size={19} />
          <input
            value={homeQuery}
            onChange={(event) => setHomeQuery(event.target.value)}
            placeholder="Try “standards for electrical safety”"
            aria-label="Ask or search"
          />
          <button className="button-primary" type="submit">
            Ask Mitra <ArrowRight size={16} />
          </button>
        </form>
        <div className="search-chips">
          <span>Try asking</span>
          {[
            "What is an Indian Standard?",
            "Help me find a service",
            "Explain a document",
          ].map((text) => (
            <button key={text} onClick={() => onAsk(text)}>
              {text}
              <ArrowRight size={13} />
            </button>
          ))}
        </div>
      </section>
      <div className="section-heading">
        <div>
          <div className="eyebrow">START WITH A TASK</div>
          <h2>How can we help?</h2>
        </div>
        <button className="text-link" onClick={() => onNavigate("Assistant")}>
          Open assistant <ArrowRight size={15} />
        </button>
      </div>
      <section className="task-grid">
        {prompts.map(
          ({ icon: Icon, title: cardTitle, detail, query: prompt }) => (
            <button
              className="task-card"
              key={cardTitle}
              onClick={() => onAsk(prompt)}
            >
              <span className="task-icon">
                <Icon size={19} />
              </span>
              <strong>{cardTitle}</strong>
              <span className="task-detail">{detail}</span>
              <span className="task-arrow">
                <ArrowRight size={16} />
              </span>
            </button>
          ),
        )}
      </section>
      <section className="home-information overview-panel">
        <h2>How Manak Mitra works</h2>
        <p>Each question is matched against curated BIS-linked records or the text extracted from a document you uploaded. The assistant returns retrieved passages with their source links; when configured, an external language model can phrase an answer using that retrieved context.</p>
        <div className="home-information-grid">
          <div><strong>Built for</strong><p>Consumers, students, small manufacturers, and teams looking for a starting point in BIS information.</p></div>
          <div><strong>Useful for</strong><p>Finding linked services, locating sample standard references, and asking questions about your own text-based PDFs.</p></div>
          <div><strong>Know the limits</strong><p>The local catalog is incomplete and not live. Confirm current scope, status, and applicable requirements on official BIS sources.</p></div>
        </div>
      </section>
      <section className="trust-note">
        <span className="trust-icon">
          <ShieldCheck size={19} />
        </span>
        <span>
          <strong>Built to be transparent.</strong> This demo uses a small
          sample knowledge base, not a live BIS database. Check current
          requirements with official BIS sources.
        </span>
        <a href="https://www.bis.gov.in/" target="_blank" rel="noreferrer">
          Visit BIS <ArrowRight size={13} />
        </a>
      </section>
      <footer className="page-footer">
        <span>
          Manak Mitra <span className="footer-dot">·</span> SIH concept demo
        </span>
        <span>Accessible information, responsibly delivered</span>
      </footer>
    </>
  );
}

function AssistantPage({
  messages,
  draft,
  setDraft,
  busy,
  language,
  uploaded,
  fileInput,
  chatEnd,
  onSubmit,
  onUpload,
  fileBusy,
  onFeedback,
  feedbackStates,
  onClear,
  onNewConversation,
  conversations,
  conversationId,
  onSwitchConversation,
  sessionReady,
}: {
  messages: ChatMessage[];
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  language: string;
  uploaded: StoredDocument | null;
  fileInput: React.RefObject<HTMLInputElement | null>;
  chatEnd: React.RefObject<HTMLDivElement | null>;
  onSubmit: (event?: FormEvent) => void;
  onUpload: (file?: File) => void;
  fileBusy: boolean;
  onFeedback: (id: string, rating: "helpful" | "not_helpful") => void;
  feedbackStates: Record<string, string>;
  onClear: () => void;
  onNewConversation: () => Promise<void>;
  conversations: Conversation[];
  conversationId: string;
  onSwitchConversation: (id: string) => void;
  sessionReady: boolean;
}) {
  return (
    <>
      <div className="page-title-row">
        <div>
          <div className="eyebrow">GROUNDED ASSISTANCE</div>
          <h1 className="page-title">Ask the BIS assistant</h1>
          <p className="page-subtitle">
            Answers are drawn from the demo sources shown below each response.
          </p>
        </div>
        <div className="assistant-session-actions">
          {conversations.length > 1 && <select className="conversation-picker" aria-label="Saved conversations" value={conversationId} onChange={(event) => onSwitchConversation(event.target.value)}>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}</select>}
          <button className="button-quiet" onClick={() => void onNewConversation()} disabled={!sessionReady}>
            <MessageCircle size={15} /> New conversation
          </button>
          <button className="button-quiet" onClick={onClear}>
            <X size={15} /> Clear conversation
          </button>
        </div>
      </div>
      <section className="chat-layout">
        <div className="chat-main">
          <div className="chat-transcript" aria-live="polite">
            {messages.length === 0 ? (
              <div className="chat-empty">
                <span className="assistant-orb">
                  <Sparkles size={22} />
                </span>
                <h2>What would you like to understand?</h2>
                <p>
                  Ask about a standard, a BIS service, or a document you have
                  uploaded.
                </p>
                <div className="suggestion-list">
                  {[
                    "What is an Indian Standard?",
                    "How do I find a standard for my product?",
                    "Which BIS services are in this demo?",
                  ].map((item) => (
                    <button key={item} onClick={() => setDraft(item)}>
                      {item}
                      <ArrowRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onFeedback={onFeedback}
                  feedbackStatus={feedbackStates[message.id]}
                />
              ))
            )}
            {busy && (
              <div className="typing-row">
                <span className="assistant-avatar">
                  <Sparkles size={15} />
                </span>
                <div className="typing-bubble">
                  <span />
                  <span />
                  <span /> Searching available sources
                </div>
              </div>
            )}
            <div ref={chatEnd} />
          </div>
          <form className="chat-composer" onSubmit={onSubmit}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              placeholder="Ask about Indian Standards or BIS services..."
              rows={2}
              aria-label="Your question"
            />
            <div className="composer-bottom">
              <div className="composer-tools">
                <button
                  type="button"
                  className="tool-button"
                  onClick={() => fileInput.current?.click()}
                  title="Upload a PDF"
                  disabled={fileBusy}
                >
                  <Upload size={16} />
                  <span>
                    {fileBusy
                      ? "Processing PDF…"
                      : uploaded
                        ? uploaded.name
                        : "Attach PDF"}
                  </span>
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="application/pdf,.pdf"
                  hidden
                  onChange={(event) => onUpload(event.target.files?.[0])}
                />
                <span className="language-hint">
                  <Languages size={14} /> Replies in {language}
                </span>
              </div>
              <button
                type="submit"
                className="send-button"
                disabled={busy || !sessionReady || !draft.trim()}
                aria-label="Send question"
              >
                <Send size={16} />
              </button>
            </div>
          </form>
          <div className="composer-footnote">
            <ShieldCheck size={13} /> Responses use demo records and are not
            official guidance.
          </div>
        </div>
        <aside className="chat-aside">
          <div className="aside-card">
            <div className="aside-card-title">
              <Sparkles size={16} />
              <strong>Good questions to start</strong>
            </div>
            {prompts.map(({ title, query: prompt }) => (
              <button
                className="aside-prompt"
                key={title}
                onClick={() => setDraft(prompt)}
              >
                {title}
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
          <div className="aside-card source-card">
            <div className="aside-card-title">
              <BookOpen size={16} />
              <strong>Knowledge source</strong>
            </div>
            <p>
              Small, curated demo records. No live BIS catalog is connected.
            </p>
            <a href="https://www.bis.gov.in/" target="_blank" rel="noreferrer">
              Official BIS website <ArrowRight size={13} />
            </a>
          </div>
        </aside>
      </section>
    </>
  );
}

function MessageBubble({
  message,
  onFeedback,
  feedbackStatus,
}: {
  message: ChatMessage;
  onFeedback: (id: string, rating: "helpful" | "not_helpful") => void;
  feedbackStatus?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  async function copyText() {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyFailed(true);
      window.setTimeout(() => setCopyFailed(false), 2500);
    }
  }
  return (
    <article className={`message-row ${message.role}`}>
      <span
        className={
          message.role === "assistant" ? "assistant-avatar" : "user-avatar"
        }
      >
        {message.role === "assistant" ? <Sparkles size={15} /> : "Y"}
      </span>
      <div className="message-body">
        <div className="message-label">
          {message.role === "assistant" ? "MANAK MITRA" : "YOU"}
          {message.mode && (
            <span className="mode-tag">
              {message.mode === "demo"
                ? "LOCAL RETRIEVAL"
                : message.mode.toUpperCase()}
            </span>
          )}
        </div>
        <div className="message-text">{message.text}</div>
        {message.sources?.map((source) => (
          <SourceCard key={source.id} source={source} />
        ))}
        {message.role === "assistant" && (
          <div className="message-actions">
            <button aria-label="Copy response" onClick={copyText}>
              <Clipboard size={14} />
              {copied ? "Copied" : copyFailed ? "Copy unavailable" : "Copy"}
            </button>
            <button
              aria-label="Helpful"
              onClick={() => onFeedback(message.id, "helpful")}
            >
              <ThumbsUp size={14} />
              Helpful
            </button>
            <button
              aria-label="Not helpful"
              onClick={() => onFeedback(message.id, "not_helpful")}
            >
              <ThumbsDown size={14} />
              Not helpful
            </button>
            {feedbackStatus && <span className="feedback-status" role="status">{feedbackStatus}</span>}
          </div>
        )}
      </div>
    </article>
  );
}

function SourceCard({ source }: { source: SourceReference }) {
  return (
    <div className="citation-card">
      <span className="citation-icon">
        <FileText size={15} />
      </span>
      <span className="citation-copy">
        <strong>{source.title}</strong>
        <small>
          {source.sourceName || source.reference || source.kind}{source.section ? ` · ${source.section}` : ""}{source.page ? ` · Page ${source.page}` : ""} <span>·</span>{" "}
          {source.label || "Demo record"}
        </small>
      </span>
      {source.url && (
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open source ${source.title}`}
        >
          <ArrowDownToLine size={14} />
        </a>
      )}
    </div>
  );
}

function CatalogPage({
  kind,
  items,
  search,
  setSearch,
  onAsk,
}: {
  kind: "standards" | "services";
  items: CatalogItem[];
  search: string;
  setSearch: (value: string) => void;
  onAsk: (text?: string) => void;
}) {
  const isStandards = kind === "standards";
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);
  const [category, setCategory] = useState("All categories");
  const [sortOrder, setSortOrder] = useState("Relevance");
  const [retrievedItems, setRetrievedItems] = useState<CatalogItem[] | null>(null);
  const [retrievedQuery, setRetrievedQuery] = useState("");
  const [serviceItems, setServiceItems] = useState<CatalogItem[] | null>(null);
  const [retrievedServiceQuery, setRetrievedServiceQuery] = useState("");
  const [retrievedServiceCategory, setRetrievedServiceCategory] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const isRemoteServiceSearch = !isStandards;
  const isRemoteSearch = isStandards && Boolean(search.trim());
  useEffect(() => {
    if (!isRemoteSearch) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setSearchBusy(true);
      setSearchError("");
      void searchStandards(search).then(({ results }) => {
        if (active) {
          setRetrievedItems(results);
          setRetrievedQuery(search);
        }
      }).catch((error: unknown) => {
        if (active) setSearchError(error instanceof Error ? error.message : "Standards search is unavailable.");
      }).finally(() => {
        if (active) setSearchBusy(false);
      });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [isRemoteSearch, search]);
  useEffect(() => {
    if (!isRemoteServiceSearch) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setSearchBusy(true);
      setSearchError("");
      void getServices({
        query: search.trim() || undefined,
        category: category === "All categories" ? undefined : category,
        pageSize: 100,
      }).then(({ services }) => {
        if (active) {
          setServiceItems(services);
          setRetrievedServiceQuery(search);
          setRetrievedServiceCategory(category);
        }
      }).catch((error: unknown) => {
        if (active) setSearchError(error instanceof Error ? error.message : "BIS services are unavailable.");
      }).finally(() => {
        if (active) setSearchBusy(false);
      });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [isRemoteServiceSearch, search, category]);
  const serviceResultIsCurrent = retrievedServiceQuery === search && retrievedServiceCategory === category;
  const sourceItems = isRemoteSearch
    ? retrievedQuery === search ? retrievedItems ?? [] : []
    : isRemoteServiceSearch ? serviceResultIsCurrent ? serviceItems ?? [] : [] : items;
  const isSearching = isRemoteSearch && (searchBusy || retrievedQuery !== search);
  const isLoadingServices = isRemoteServiceSearch && (searchBusy || !serviceResultIsCurrent);
  const categories = [...new Set([...items, ...sourceItems].map((item) => item.category))].sort();
  const visibleItems = sourceItems
    .filter((item) => isRemoteServiceSearch || category === "All categories" || item.category === category)
    .sort((left, right) => sortOrder === "Title" ? left.title.localeCompare(right.title) : 0);
  return (
    <>
      <div className="page-title-row">
        <div>
          <div className="eyebrow">
            {isStandards ? "DISCOVER THE CATALOG" : "FIND YOUR NEXT STEP"}
          </div>
          <h1 className="page-title">
            {isStandards ? "Standards search" : "BIS services"}
          </h1>
          <p className="page-subtitle">
            {isStandards
              ? "Explore illustrative records by number, product, category or topic."
              : "Browse service topics and the sample information available in this demo."}
          </p>
        </div>
        <span className="sample-label">
          <span className="status-dot" /> Sample data
        </span>
      </div>
      <div className="catalog-toolbar">
        <div className="catalog-search">
          <Search size={17} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              isStandards
                ? "Search by number, title or topic"
                : "Search service topics"
            }
            aria-label="Search catalog"
          />
          <select aria-label="Filter by category" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option>All categories</option>
            {categories.map((itemCategory) => <option key={itemCategory}>{itemCategory}</option>)}
          </select>
          <select aria-label="Sort results" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)}>
            <option>Relevance</option><option>Title</option>
          </select>
        </div>
        <span className="result-count">
          {isSearching || isLoadingServices ? "Searching…" : `${visibleItems.length} ${isStandards ? "records" : "topics"}`}
        </span>
      </div>
      {searchError && <div className="inline-error" role="status">{searchError}</div>}
      {isSearching || isLoadingServices ? <div className="empty-state" role="status">Searching the local catalog...</div> : visibleItems.length ? (
        <div className="catalog-grid">
          {visibleItems.map((item) => (
            <article className="catalog-card" key={item.id}>
              <div className="catalog-card-top">
                <span className="category-tag">{item.category}</span>
                {item.number && (
                  <span className="standard-number">{item.number}</span>
                )}
              </div>
              <h2>{item.title}</h2>
              <p>{item.summary}</p>
              <div className="tag-list">
                {item.tags?.slice(0, 3).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              <div className="catalog-card-bottom">
                <span>
                  <span className="status-dot" /> Sample record
                </span>
                <div className="catalog-card-actions">
                  <button onClick={() => setSelectedItem(item)}>Details</button>
                  <button
                    onClick={() =>
                      onAsk(
                        `Tell me about ${item.title}${item.number ? ` (${item.number})` : ""}`,
                      )
                    }
                  >
                    Ask <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Search size={23} />
          <strong>No matching {isStandards ? "standard records" : "service topics"}</strong>
          <span>Try another topic or clear your search.</span>
        </div>
      )}
      <div className="catalog-disclaimer">
        <ShieldCheck size={15} /> This catalog is illustrative sample data, not
        a complete or current BIS listing.{" "}
        <a href="https://www.bis.gov.in/" target="_blank" rel="noreferrer">
          Check official BIS resources
        </a>
        .
      </div>
      {selectedItem && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelectedItem(null);
          }}
        >
          <section
            className="detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
          >
            <div className="modal-top">
              <span className="category-tag">{selectedItem.category}</span>
              <button
                className="icon-button"
                aria-label="Close details"
                onClick={() => setSelectedItem(null)}
              >
                <X size={18} />
              </button>
            </div>
            {selectedItem.number && (
              <span className="modal-number">{selectedItem.number}</span>
            )}
            <h2 id="detail-title">{selectedItem.title}</h2>
            <p className="modal-summary">{selectedItem.summary}</p>
            <div className="detail-field">
              <strong>{isStandards ? "Scope" : "Process and eligibility"}</strong>
              <span>
                {isStandards
                  ? "Not included in this demo record. Verify scope, edition and status in the official BIS catalog."
                  : "Verified steps and eligibility are not reproduced in this demo. Check the linked BIS service page for current instructions."}
              </span>
            </div>
            <div className="detail-field">
              <strong>Source</strong>
              <span>
                {selectedItem.source
                  ? "Official BIS source linked for verification."
                  : "No direct source URL is included in this sample record."}
              </span>
            </div>
            {selectedItem.source && (
              <a
                className="button-primary modal-source"
                href={selectedItem.source}
                target="_blank"
                rel="noreferrer"
              >
                Open official source <ArrowRight size={14} />
              </a>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function DocumentsPage({
  documents,
  uploaded,
  busy,
  notice,
  fileInput,
  onUpload,
  onAsk,
  onDelete,
  onOpenDocument,
}: {
  documents: StoredDocument[];
  uploaded: StoredDocument | null;
  busy: boolean;
  notice: string;
  fileInput: React.RefObject<HTMLInputElement | null>;
  onUpload: (file?: File) => void;
  onAsk: (text?: string) => void;
  onDelete: (id: string) => void;
  onOpenDocument: (document: StoredDocument) => void;
}) {
  return (
    <>
      <div className="page-title-row">
        <div>
          <div className="eyebrow">PRIVATE TO THIS DEMO SESSION</div>
          <h1 className="page-title">Your documents</h1>
          <p className="page-subtitle">
            Upload a PDF to ask questions about its extracted text.
          </p>
        </div>
      </div>
      {notice && (
        <div className="inline-notice" role="status">
          {notice}
        </div>
      )}
      <section className="upload-panel">
        <div className="upload-icon">
          <Upload size={20} />
        </div>
        <h2>
          {documents.length
            ? "Add another PDF"
            : "Bring a document into the conversation"}
        </h2>
        <p>PDF only · up to 10 MB · text-based PDFs work best</p>
        <button
          className="button-primary"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? "Processing PDF…" : "Choose a PDF"} <Upload size={15} />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event) => onUpload(event.target.files?.[0])}
        />
      </section>
      {documents.map((document) => (
        <article className="uploaded-document" key={document.id}>
          <span className="uploaded-file-icon">
            <FileText size={20} />
          </span>
          <div className="uploaded-file-info">
            <strong>{document.name}</strong>
            <small>
              {document.pages} pages · {document.chunks} indexed chunks · {new Date(document.uploadedAt).toLocaleString()}
            </small>
          </div>
          <button
            className="delete-document"
            onClick={() => onDelete(document.id)}
            aria-label="Remove uploaded document"
            title="Remove uploaded document"
          >
            <Trash2 size={15} />
          </button>
          <span className="ready-pill"><Check size={13} /> {document.status}</span>
          <div className="document-questions">
            <button onClick={() => onOpenDocument(document)}>
              {uploaded?.id === document.id ? "Continue document chat" : "Ask about this document"}
              <ArrowRight size={14} />
            </button>
            {["Summarize this document", "Which sections mention testing?"].map((q) => (
              <button key={q} onClick={() => { onOpenDocument(document); onAsk(q); }}>
                {q}<ArrowRight size={14} />
              </button>
            ))}
          </div>
        </article>
      ))}
      {!documents.length && !busy && <div className="empty-state"><FileText size={23} /><strong>No documents yet</strong><span>Uploaded PDFs are kept in the local SQLite database until deleted.</span></div>}
      <div className="privacy-note">
        <ShieldCheck size={17} />
        <span>
          <strong>Local storage:</strong> extracted PDF text and chunks are stored in SQLite and scoped to this guest-session ID. The ID is a capability token, not an authenticated account; do not upload confidential documents.
        </span>
      </div>
    </>
  );
}

function InsightsPage({ insights }: {
  insights: Awaited<ReturnType<typeof getInsights>> | null;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filteredInsights, setFilteredInsights] = useState(insights);
  const [insightsError, setInsightsError] = useState("");
  const [insightsLoading, setInsightsLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void getInsights({ from: from || undefined, to: to || undefined }).then((result) => {
      if (!active) return;
      setFilteredInsights(result);
      setInsightsError("");
    }).catch((error: unknown) => {
      if (active) setInsightsError(error instanceof Error ? error.message : "Event analytics could not be loaded.");
    }).finally(() => {
      if (active) setInsightsLoading(false);
    });
    return () => { active = false; };
  }, [from, to]);

  const eventMetrics = filteredInsights?.events && typeof filteredInsights.events === "object" ? filteredInsights.events : null;
  const eventCounts = eventMetrics?.eventCounts ?? {};
  const eventRows = Object.entries(eventCounts).filter(([, count]) => count > 0);
  const maxEventCount = Math.max(1, ...eventRows.map(([, count]) => count));
  const aiProvider = filteredInsights?.aiProvider;
  const embeddingProvider = filteredInsights?.embeddingProvider;
  const retrievalEngine = filteredInsights?.retrievalEngine;
  const database = filteredInsights?.databaseHealth;
  const liveBis = filteredInsights?.liveBis;
  return (
    <>
      <div className="page-title-row">
        <div>
          <div className="eyebrow">DEMO CONFIGURATION</div>
          <h1 className="page-title">System overview</h1>
          <p className="page-subtitle">
            A transparent snapshot of what this prototype has actually
            connected.
          </p>
        </div>
      </div>
      <section className="metric-grid">
        <Metric icon={Search} label="Searches in range" value={String(eventCounts.search ?? 0)} />
        <Metric icon={MessageCircle} label="Assistant questions" value={String(eventCounts.question ?? 0)} />
        <Metric icon={ShieldCheck} label="Knowledge records" value={String(filteredInsights?.knowledgeRecords ?? "—")} />
        <Metric icon={FileText} label="Documents / chunks" value={`${filteredInsights?.documentCount ?? "—"} / ${filteredInsights?.indexedChunks ?? "—"}`} />
        <Metric icon={ThumbsUp} label="Feedback in range" value={String(filteredInsights?.feedbackCount ?? "—")} />
        <Metric icon={Activity} label="API errors in range" value={String(eventCounts.error ?? 0)} />
        <Metric icon={Database} label="Database health" value={database?.status ?? "Loading"} />
        <Metric icon={AudioLines} label="AI provider" value={aiProvider?.status ?? "Loading"} />
      </section>
      <section className="overview-panel">
        <div className="section-heading">
          <div><div className="eyebrow">PERSISTED ACTIVITY</div><h2>Usage insights</h2></div>
          <div className="insight-date-filters">
            <label>From<input type="date" value={from} onChange={(event) => { setInsightsLoading(true); setFrom(event.target.value); }} /></label>
            <label>To<input type="date" value={to} onChange={(event) => { setInsightsLoading(true); setTo(event.target.value); }} /></label>
          </div>
        </div>
        {insightsError && <div className="inline-error" role="alert">{insightsError}</div>}
        {insightsLoading && !eventMetrics ? <div className="empty-state" role="status">Loading persisted activity…</div> : eventMetrics?.eventCount ? <>
          <div className="insight-summary">
            <span><strong>{eventMetrics.eventCount}</strong> events</span>
            <span><strong>{Math.round(eventMetrics.averageResponseMs)} ms</strong> average answer time</span>
            <span><strong>{eventMetrics.citedSources}</strong> cited source uses</span>
          </div>
          <div className="insight-bars" aria-label="Persisted activity by event type">
            {eventRows.map(([eventName, count]) => <div className="insight-bar-row" key={eventName}>
              <span>{eventName.replaceAll("_", " ")}</span>
              <span className="insight-bar-track"><span style={{ width: `${Math.max(4, count / maxEventCount * 100)}%` }} /></span>
              <strong>{count}</strong>
            </div>)}
          </div>
        </> : <div className="empty-state"><Activity size={22} /><strong>No recorded activity in this date range</strong><span>Activity will appear here after searches, questions, uploads, feedback or API errors.</span></div>}
      </section>
      <section className="overview-panel">
        <h2>What powers this demo</h2>
        <div className="overview-row">
          <span className={`overview-check ${database?.status === "connected" ? "" : "muted"}`}>{database?.status === "connected" ? <Check size={15} /> : <X size={15} />}</span>
          <div>
            <strong>Curated local knowledge</strong>
            <p>
              {filteredInsights?.knowledgeRecords ?? 0} persisted source records are available. The corpus is intentionally incomplete and is not a live BIS catalog.
            </p>
          </div>
          <span className={`overview-state ${database?.status === "connected" ? "" : "muted-text"}`}>{database?.status.toUpperCase() ?? "UNKNOWN"}</span>
        </div>
        <div className="overview-row">
          <span className="overview-check muted">
            <X size={15} />
          </span>
          <div>
            <strong>Live BIS integration</strong>
            <p>{liveBis?.message ?? "No live BIS integration is configured. Use the official BIS links in Knowledge Base."}</p>
          </div>
          <span className="overview-state muted-text">{liveBis?.status.toUpperCase() ?? "UNKNOWN"}</span>
        </div>
        <div className="overview-row">
          <span className={`overview-check ${database?.status === "connected" ? "" : "muted"}`}>{database?.status === "connected" ? <Check size={15} /> : <X size={15} />}</span>
          <div>
            <strong>Persistent database</strong>
            <p>{database ? `${database.engine} migration ${database.migrationVersion} passed its health check; uploaded documents, extracted chunks, conversations, messages, feedback, and knowledge records are persisted.` : "Database health has not been checked."}</p>
          </div>
          <span className={`overview-state ${database?.status === "connected" ? "" : "muted-text"}`}>{database?.status.toUpperCase() ?? "UNKNOWN"}</span>
        </div>
        <div className="overview-row">
          <span className={`overview-check ${aiProvider?.status === "connected" ? "" : "muted"}`}>{aiProvider?.status === "connected" ? <Check size={15} /> : <X size={15} />}</span>
          <div><strong>Grounded language model</strong><p>{aiProvider?.status === "connected" ? `A real provider request succeeded${aiProvider.model ? ` using ${aiProvider.model}` : ""}.` : aiProvider?.status === "configured" ? `Server configuration exists${aiProvider.model ? ` for ${aiProvider.model}` : ""}, but a successful request has not been confirmed yet.` : aiProvider?.status === "unavailable" ? "The configured provider request failed; English local retrieval remains active. Check the backend provider URL, key, model, and server logs." : "Set AI_BASE_URL, AI_API_KEY, and AI_MODEL in the backend environment. English local retrieval remains active."}</p></div>
          <span className={`overview-state ${aiProvider?.status === "connected" ? "" : "muted-text"}`}>{aiProvider?.status.toUpperCase() ?? "UNKNOWN"}</span>
        </div>
        <div className="overview-row">
          <span className={`overview-check ${retrievalEngine?.status === "connected" ? "" : "muted"}`}>{retrievalEngine?.status === "connected" ? <Check size={15} /> : <X size={15} />}</span>
          <div><strong>Retrieval engine</strong><p>{retrievalEngine?.method ?? "Retrieval status is unavailable."} {retrievalEngine ? `${retrievalEngine.indexedVectors} public vectors are stored in SQLite.` : ""} {embeddingProvider?.status !== "connected" ? "For embeddings, configure EMBEDDING_BASE_URL, EMBEDDING_API_KEY, and EMBEDDING_MODEL on the backend." : ""}{embeddingProvider?.error ? ` Last provider error: ${embeddingProvider.error}` : ""}</p></div>
          <span className={`overview-state ${retrievalEngine?.status === "connected" ? "" : "muted-text"}`}>{retrievalEngine?.status.toUpperCase() ?? "UNKNOWN"}</span>
        </div>
      </section>
    </>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <article className="metric-card">
      <span className="metric-icon">
        <Icon size={18} />
      </span>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function KnowledgeBasePage({ status, onStatusChange }: {
  status: NonNullable<Awaited<ReturnType<typeof getKnowledgeStatus>>>;
  onStatusChange: (status: NonNullable<Awaited<ReturnType<typeof getKnowledgeStatus>>>) => void;
}) {
  const [adminKey, setAdminKey] = useState("");
  const [managedRecords, setManagedRecords] = useState<ManagedKnowledgeRecord[]>([]);
  const [ingestionLogs, setIngestionLogs] = useState<{ id: number; sourceUrl: string; sourceName: string; status: string; verificationStatus: string; error: string | null; createdAt: string }[]>([]);
  const [adminNotice, setAdminNotice] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [knowledgeFile, setKnowledgeFile] = useState<File | null>(null);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [bulkImportText, setBulkImportText] = useState("");
  const [recordQuery, setRecordQuery] = useState("");
  const [recordCategory, setRecordCategory] = useState("");
  const [recordVerification, setRecordVerification] = useState("");
  const [visibleRecords, setVisibleRecords] = useState<KnowledgeRecordSummary[]>([]);
  const [recordListLoading, setRecordListLoading] = useState(true);
  const [recordListError, setRecordListError] = useState("");
  const [recordRevision, setRecordRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setRecordListLoading(true);
      void getKnowledgeRecords({
        query: recordQuery.trim() || undefined,
        category: recordCategory || undefined,
        verificationStatus: recordVerification || undefined,
        pageSize: 100,
      }).then((result) => {
        if (!active) return;
        setVisibleRecords(result.records);
        setRecordListError("");
      }).catch((error: unknown) => {
        if (active) setRecordListError(error instanceof Error ? error.message : "Knowledge records could not be loaded.");
      }).finally(() => {
        if (active) setRecordListLoading(false);
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [recordQuery, recordCategory, recordVerification, recordRevision]);

  async function loadManagedRecords(showLoadedNotice = true) {
    if (!adminKey) return;
    setAdminBusy(true);
    try {
      const [result, latestStatus] = await Promise.all([getManagedKnowledge(adminKey), getKnowledgeStatus()]);
      setManagedRecords(result.records);
      setIngestionLogs(result.ingestionLogs);
      onStatusChange(latestStatus);
      setRecordRevision((revision) => revision + 1);
      if (showLoadedNotice) setAdminNotice(`${result.records.length} imported records loaded.`);
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "Knowledge records could not be loaded.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function submitKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adminKey) return;
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const rawPage = String(form.get("page") ?? "").trim();
    setAdminBusy(true);
    setAdminNotice("");
    try {
      await addKnowledgeRecord({
        id: String(form.get("id")), title: String(form.get("title")), content: String(form.get("content")),
        kind: String(form.get("kind")), category: String(form.get("category")), url: String(form.get("url")),
        sourceName: String(form.get("sourceName")), reference: String(form.get("reference") || "") || undefined,
        standardNumber: String(form.get("standardNumber") || "") || undefined, section: String(form.get("section") || "") || undefined,
        page: rawPage ? Number(rawPage) : undefined, tags: String(form.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean),
        language: "English", documentType: String(form.get("documentType") || "") || undefined,
        version: String(form.get("version") || "") || undefined,
        publisher: String(form.get("publisher") || "Bureau of Indian Standards"),
        publishedDate: String(form.get("publishedDate") || "") || undefined,
        verificationStatus: String(form.get("verificationStatus") || "pending") as "verified" | "pending" | "unverified",
      }, adminKey);
      formElement.reset();
      await loadManagedRecords(false);
      setAdminNotice("Source excerpt saved. Only records explicitly marked verified are searchable.");
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "The record could not be saved.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function submitKnowledgeDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adminKey || !knowledgeFile) return;
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget);
    setAdminBusy(true);
    setAdminNotice("");
    try {
      const result = await uploadKnowledgeDocument(knowledgeFile, {
        url: String(form.get("documentUrl")),
        sourceName: String(form.get("documentSourceName")),
        title: String(form.get("documentTitle")),
        category: String(form.get("documentCategory")),
        verificationStatus: String(form.get("documentVerificationStatus") || "pending") as "verified" | "pending" | "unverified",
      }, adminKey);
      setKnowledgeFile(null);
      formElement.reset();
      await loadManagedRecords(false);
      setAdminNotice(`${result.records} text chunks indexed${result.reindexed ? " (previous version replaced)" : ""} with ${result.verificationStatus} status.`);
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "The knowledge document could not be processed.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function submitBulkKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adminKey) return;
    setAdminBusy(true);
    setAdminNotice("");
    try {
      const parsed: unknown = JSON.parse(bulkImportText);
      if (!Array.isArray(parsed)) throw new Error("Provide a JSON array of source records.");
      const result = await importKnowledgeRecords(parsed, adminKey);
      setRecordRevision((revision) => revision + 1);
      await loadManagedRecords(false);
      const rejectionDetails = result.rejected.map((item) => `Row ${item.row}${item.id ? ` (${item.id})` : ""}: ${item.errors.join("; ")}`).join(" ");
      setAdminNotice(`${result.imported} records imported using ${result.retrieval} retrieval; ${result.rejected.length} rows rejected.${result.warning ? ` ${result.warning}` : ""}${rejectionDetails ? ` ${rejectionDetails}` : ""}`);
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "The records could not be imported.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function removeManagedRecord(id: string) {
    try {
      await deleteKnowledgeRecord(id, adminKey);
      setManagedRecords((current) => current.filter((record) => record.id !== id));
      setRecordRevision((revision) => revision + 1);
      setAdminNotice("Imported record removed from retrieval.");
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "The record could not be deleted.");
    }
  }

  async function updateManagedRecord(event: FormEvent<HTMLFormElement>, id: string) {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setAdminBusy(true);
      try {
        const result = await updateManagedKnowledge(id, {
          title: String(form.get("title")),
          category: String(form.get("category")),
          sourceName: String(form.get("sourceName")),
          url: String(form.get("url")),
          content: String(form.get("content")),
        }, adminKey);
        setManagedRecords((current) => current.map((record) => record.id === id ? result.record : record));
        setEditingRecordId(null);
        setRecordRevision((revision) => revision + 1);
        setAdminNotice("Record updated and saved to lexical retrieval.");
        await loadManagedRecords(false);
      } catch (error) {
        setAdminNotice(error instanceof Error ? error.message : "The record could not be updated.");
      } finally {
        setAdminBusy(false);
      }
  }

  async function changeVerification(record: ManagedKnowledgeRecord, verificationStatus: "verified" | "pending" | "unverified") {
      setAdminBusy(true);
      try {
        const result = await updateManagedKnowledge(record.id, { verificationStatus }, adminKey);
        setManagedRecords((current) => current.map((item) => item.id === record.id ? result.record : item));
        setRecordRevision((revision) => revision + 1);
        setAdminNotice(verificationStatus === "verified" ? "Record approved and made searchable." : "Record status updated; pending and unverified records are excluded from retrieval.");
        await loadManagedRecords(false);
      } catch (error) {
        setAdminNotice(error instanceof Error ? error.message : "The verification status could not be updated.");
      } finally {
        setAdminBusy(false);
      }
  }

  async function reindexManagedRecord(id: string) {
      setAdminBusy(true);
      try {
        const result = await reindexManagedKnowledge(id, adminKey);
        setAdminNotice(`Record re-indexed using ${result.retrieval} retrieval.`);
        await loadManagedRecords(false);
      } catch (error) {
        setAdminNotice(error instanceof Error ? error.message : "The record could not be re-indexed.");
      } finally {
        setAdminBusy(false);
    }
  }

  return (
    <>
      <div className="page-title-row">
        <div><div className="eyebrow">SOURCE TRANSPARENCY</div><h1 className="page-title">Knowledge base</h1><p className="page-subtitle">A live inventory of the local records and integrations the assistant can actually use.</p></div>
      </div>
      <section className="metric-grid">
        <Metric icon={BookOpen} label="Knowledge records" value={String(status.knowledge.records)} />
        <Metric icon={BookOpen} label="Standard records in SQLite" value={String(status.standards.records)} />
        <Metric icon={LifeBuoy} label="Service source records in SQLite" value={String(status.services.records)} />
        <Metric icon={FileText} label="Uploaded documents" value={String(status.documents.records)} />
        <Metric icon={FileText} label="Document chunks" value={String(status.documents.chunks)} />
      </section>
      <section className="overview-panel">
        <h2>Source and indexing status</h2>
        <div className="overview-row"><span className="overview-check"><Check size={15} /></span><div><strong>{status.knowledge.source}</strong><p>{status.knowledge.records} records are available. This corpus is curated and incomplete; no live BIS feed is connected.</p></div><span className="overview-state">{status.knowledge.status.toUpperCase()}</span></div>
        <div className="overview-row"><span className="overview-check"><Check size={15} /></span><div><strong>{status.database.engine} database</strong><p>Persistent application records are stored locally. Uploaded chunks: {status.documents.chunks}.</p></div><span className="overview-state">{status.database.status.toUpperCase()}</span></div>
        <div className="overview-row"><span className={`overview-check ${status.vectorSearch.status === "connected" ? "" : "muted"}`}>{status.vectorSearch.status === "connected" ? <Check size={15} /> : <X size={15} />}</span><div><strong>Retrieval engine</strong><p>{status.vectorSearch.method}. {status.vectorSearch.indexedVectors} persistent vectors indexed.{status.vectorSearch.model ? ` Model: ${status.vectorSearch.model}.` : " Configure EMBEDDING_BASE_URL, EMBEDDING_API_KEY, and EMBEDDING_MODEL on the server to enable semantic retrieval."}{status.vectorSearch.error ? ` Last provider error: ${status.vectorSearch.error}` : ""}</p></div><span className={`overview-state ${status.vectorSearch.status === "connected" ? "" : "muted-text"}`}>{status.vectorSearch.status.toUpperCase()}</span></div>
        <div className="overview-row"><span className={`overview-check ${status.aiProvider.status === "connected" ? "" : "muted"}`}>{status.aiProvider.status === "connected" ? <Check size={15} /> : <X size={15} />}</span><div><strong>Grounded language model</strong><p>{status.aiProvider.status === "connected" ? "A provider request has succeeded in this server process." : status.aiProvider.status === "configured" ? "Credentials are present, but no successful model request has been confirmed yet." : "Not connected. Configure AI_BASE_URL, AI_API_KEY, and AI_MODEL on the server; local retrieval remains available."}</p></div><span className={`overview-state ${status.aiProvider.status === "connected" ? "" : "muted-text"}`}>{status.aiProvider.status.toUpperCase()}</span></div>
        <h2>Categories</h2>
        <div className="knowledge-category-list">{status.knowledge.categories.map((category) => <div className="knowledge-category" key={category.name}><span>{category.name}</span><strong>{category.count}</strong></div>)}</div>
        <h2>Search and filter persisted records</h2>
        <div className="catalog-toolbar">
          <div className="catalog-search">
            <Search size={17} />
            <input value={recordQuery} onChange={(event) => setRecordQuery(event.target.value)} placeholder="Search title, source, category or URL" aria-label="Search knowledge records" />
            <select value={recordCategory} onChange={(event) => setRecordCategory(event.target.value)} aria-label="Filter knowledge records by category">
              <option value="">All categories</option>
              {status.knowledge.categories.map((category) => <option key={category.name} value={category.name}>{category.name}</option>)}
            </select>
            <select value={recordVerification} onChange={(event) => setRecordVerification(event.target.value)} aria-label="Filter knowledge records by verification status">
              <option value="">All verification states</option>
              <option value="verified">Verified</option><option value="pending">Pending</option><option value="unverified">Unverified</option><option value="demo">Illustrative / demo</option>
            </select>
          </div>
          <span className="result-count">{recordListLoading ? "Loading…" : `${visibleRecords.length} records`}</span>
        </div>
        {recordListError && <div className="inline-error" role="alert">{recordListError}</div>}
        {recordListLoading ? <div className="empty-state" role="status">Loading persisted knowledge records…</div> : visibleRecords.length ? <div className="knowledge-record-list">
          {visibleRecords.map((record) => <article className="knowledge-managed-record" key={record.id}>
            <div className="knowledge-managed-heading">
              <span><strong>{record.title}</strong><small>{record.category} · {record.kind} · {record.sourceName}</small></span>
              <span className={`overview-state ${record.verificationStatus === "verified" ? "" : "muted-text"}`}>{record.verificationStatus === "demo" ? "ILLUSTRATIVE / DEMO" : record.verificationStatus.toUpperCase()}</span>
            </div>
            <p>Record type: {record.sourceType === "demo" ? "Illustrative demo record" : record.sourceType === "admin_pdf" ? "Administrator-imported PDF" : "Administrator-reviewed excerpt"}{record.standardNumber ? ` · ${record.standardNumber}` : ""}</p>
            <p>Last updated: {new Date(record.updatedAt).toLocaleString()}{record.lastVerifiedAt ? ` · Last verified: ${new Date(record.lastVerifiedAt).toLocaleString()}` : ""}</p>
            <a href={record.url} target="_blank" rel="noreferrer">Open source: {record.url}</a>
          </article>)}
        </div> : <div className="empty-state"><Search size={22} /><strong>No records match these filters</strong><span>Clear a filter or use an official BIS source link to review available material.</span></div>}
        <h2>Official BIS update sources</h2>
        <p>No live BIS API/feed is configured. Review current material at these official sites, then import only permitted, source-linked excerpts or PDFs after administrator review. The local catalog is incomplete and is not a complete standards database.</p>
        <ul className="knowledge-source-list">{status.liveBis.officialUrls.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{new URL(url).hostname}{url.replace(/^https?:\/\/[^/]+/, "")}</a></li>)}</ul>
        <h2>Persisted demo and retrieval source links</h2>
        <ul className="knowledge-source-list">{status.sourceUrls.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{new URL(url).hostname}{url.replace(/^https?:\/\/[^/]+/, "")}</a></li>)}</ul>
      </section>
      <section className="overview-panel knowledge-admin">
        <h2>Administrator source ingestion</h2>
        <p>Import reviewed excerpts or text-based PDFs with traceable metadata. BIS source links are required; the app does not crawl BIS or independently verify submissions. When an embedding provider is configured, uploaded document text is sent to that provider to create vectors.</p>
        {!status.knowledge.ingestionEnabled && <div className="inline-notice">Ingestion API is disabled until an administrator sets the server-only ADMIN_API_KEY. Configure it in the backend environment; never place it in frontend source.</div>}
        <label className="admin-key-field">Admin API key<input type="password" autoComplete="off" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} placeholder="Enter configured key for this session" /></label>
        <button className="button-secondary" type="button" onClick={() => void loadManagedRecords()} disabled={!adminKey || !status.knowledge.ingestionEnabled || adminBusy}>Load imported records</button>
        {status.knowledge.ingestionEnabled && <form className="knowledge-ingest-form" onSubmit={submitKnowledge}>
          <label>Record ID<input name="id" required pattern="[A-Za-z0-9._-]+" /></label>
          <label>Title<input name="title" required minLength={3} maxLength={240} /></label>
          <label>Category<select name="category" required>{["BIS overview", "Indian Standards", "Standards search", "BIS certification", "BIS licensing", "BIS registration", "BIS testing", "BIS laboratories", "Consumer services", "BIS processes", "Frequently asked questions"].map((category) => <option key={category}>{category}</option>)}</select></label>
          <label>Record type<input name="kind" required defaultValue="Verified source excerpt" /></label>
          <label>Source name<input name="sourceName" required /></label>
          <label>Official HTTPS URL<input name="url" type="url" required placeholder="https://www.bis.gov.in/..." /></label>
          <label>Publisher<input name="publisher" defaultValue="Bureau of Indian Standards" /></label>
          <label>Published date<input name="publishedDate" type="date" /></label>
          <label>Verification status<select name="verificationStatus"><option value="pending">Awaiting verification</option><option value="verified">Admin marked verified</option><option value="unverified">Unverified</option></select></label>
          <label>Standard number<input name="standardNumber" /></label>
          <label>Document type<input name="documentType" /></label>
          <label>Section<input name="section" /></label>
          <label>Page<input name="page" type="number" min="1" /></label>
          <label>Reference<input name="reference" /></label>
          <label>Version<input name="version" /></label>
          <label className="ingest-wide">Verified excerpt<textarea name="content" minLength={40} maxLength={12000} required rows={5} /></label>
          <label className="ingest-wide">Keywords, comma-separated<input name="tags" /></label>
          <button className="button-primary" type="submit" disabled={adminBusy || !adminKey}>{adminBusy ? "Saving…" : "Save source excerpt"} <ArrowRight size={14} /></button>
        </form>}
        {status.knowledge.ingestionEnabled && <form className="knowledge-ingest-form" onSubmit={(event) => void submitBulkKnowledge(event)}>
          <h3 className="ingest-wide">Bulk import reviewed records (JSON array)</h3>
          <p className="ingest-wide">Each row is validated independently. Invalid rows are reported and valid records are saved in SQLite. Records default to pending unless explicitly reviewed and marked verified.</p>
          <label className="ingest-wide">Records JSON<textarea value={bulkImportText} onChange={(event) => setBulkImportText(event.target.value)} required rows={8} placeholder='[{"id":"reviewed-record-1","title":"Source excerpt title","content":"At least 40 characters of reviewed source text...","kind":"Official source excerpt","category":"BIS overview","url":"https://www.bis.gov.in/","sourceName":"BIS","tags":[],"verificationStatus":"pending"}]' /></label>
          <button className="button-primary" type="submit" disabled={adminBusy || !adminKey}>{adminBusy ? "Validating and importing…" : "Validate and import rows"} <ArrowRight size={14} /></button>
        </form>}
        {status.knowledge.ingestionEnabled && <form className="knowledge-ingest-form" onSubmit={(event) => void submitKnowledgeDocument(event)}>
          <h3 className="ingest-wide">Import an administrator-reviewed PDF</h3>
          <label>Document title<input name="documentTitle" required minLength={3} maxLength={240} /></label>
          <label>Category<select name="documentCategory" required>{["BIS overview", "Indian Standards", "Standards search", "BIS certification", "BIS licensing", "BIS registration", "BIS testing", "BIS laboratories", "Consumer services", "BIS processes", "Frequently asked questions"].map((category) => <option key={category}>{category}</option>)}</select></label>
          <label>Source name<input name="documentSourceName" required /></label>
          <label>Official HTTPS URL<input name="documentUrl" type="url" required placeholder="https://www.bis.gov.in/..." /></label>
          <label>Verification status<select name="documentVerificationStatus"><option value="pending">Awaiting verification</option><option value="verified">Admin marked verified</option><option value="unverified">Unverified</option></select></label>
          <label>PDF file<input type="file" accept="application/pdf,.pdf" required onChange={(event) => setKnowledgeFile(event.target.files?.[0] ?? null)} /></label>
          <button className="button-primary" type="submit" disabled={adminBusy || !adminKey || !knowledgeFile}>{adminBusy ? "Extracting and indexing…" : "Import PDF"} <ArrowRight size={14} /></button>
        </form>}
        {adminNotice && <div className="inline-notice" role="status">{adminNotice}</div>}
        {managedRecords.map((record) => <article className="knowledge-managed-record" key={record.id}>
          <div className="knowledge-managed-heading">
            <span><strong>{record.title}</strong><small>{record.category} · {record.sourceName} · {record.verificationStatus} · updated {record.updatedAt.slice(0, 10)}</small><a href={record.url} target="_blank" rel="noreferrer">Open source</a></span>
            <div className="knowledge-managed-actions">
              {record.verificationStatus !== "verified" && <button className="button-quiet" type="button" disabled={adminBusy} onClick={() => void changeVerification(record, "verified")}>Approve</button>}
              {record.verificationStatus !== "unverified" && <button className="button-quiet" type="button" disabled={adminBusy} onClick={() => void changeVerification(record, "unverified")}>Reject / unverify</button>}
              <button className="button-quiet" type="button" disabled={adminBusy} onClick={() => setEditingRecordId(editingRecordId === record.id ? null : record.id)}>Edit</button>
              <button className="button-quiet" type="button" disabled={adminBusy} onClick={() => void reindexManagedRecord(record.id)}>Re-index</button>
              <button className="button-quiet" type="button" disabled={adminBusy} onClick={() => void removeManagedRecord(record.id)}>Delete</button>
            </div>
          </div>
          {editingRecordId === record.id && <form className="knowledge-ingest-form" onSubmit={(event) => void updateManagedRecord(event, record.id)}>
            <label>Title<input name="title" required minLength={3} maxLength={240} defaultValue={record.title} /></label>
            <label>Category<select name="category" defaultValue={record.category}>{["BIS overview", "Indian Standards", "Standards search", "BIS certification", "BIS licensing", "BIS registration", "BIS testing", "BIS laboratories", "Consumer services", "BIS processes", "Frequently asked questions"].map((category) => <option key={category}>{category}</option>)}</select></label>
            <label>Source name<input name="sourceName" required defaultValue={record.sourceName} /></label>
            <label>HTTPS source URL<input name="url" type="url" required defaultValue={record.url} /></label>
            <label className="ingest-wide">Record content<textarea name="content" required minLength={40} maxLength={12000} rows={6} defaultValue={record.content} /></label>
            <button className="button-primary" type="submit" disabled={adminBusy}>{adminBusy ? "Updating…" : "Save changes"}</button>
          </form>}
        </article>)}
        {ingestionLogs.length > 0 && <><h3>Recent ingestion activity</h3>{ingestionLogs.map((log) => <article className="knowledge-category" key={log.id}><span><strong>{log.status.toUpperCase()} · {log.sourceName}</strong><small>{new Date(log.createdAt).toLocaleString()} · {log.verificationStatus}{log.error ? ` · ${log.error}` : ""}</small></span></article>)}</>}
      </section>
    </>
  );
}

function HelpPage({ aiConfigured }: { aiConfigured: boolean }) {
  return (
    <>
      <div className="page-title-row"><div><div className="eyebrow">USING MANAK MITRA</div><h1 className="page-title">Information assistant</h1><p className="page-subtitle">How answers are retrieved, where they come from, and what this system cannot verify.</p></div></div>
      <section className="overview-panel help-content">
        <h2>What it does</h2><p>Manak Mitra searches its curated BIS-linked knowledge records and any PDF you choose to upload. It returns retrieved passages and source links rather than treating itself as an official BIS decision service.</p>
        <h2>How to get a useful answer</h2><p>Ask one focused question. Include a product or standard number when you have one. Follow-ups use the current conversation; start a new conversation to clear the context.</p>
        <h2>Retrieval and sources</h2><p>The current retrieval method is lexical token overlap, not embeddings. Citations point to the source records actually retrieved. A citation link is not a claim that the full source was imported or independently re-verified.</p>
        <h2>Document questions</h2><p>Text-based PDFs are extracted page by page and stored in local SQLite for later questions. Scanned PDFs need OCR and are not supported. Delete a document to remove its extracted content.</p>
        <h2>Language availability</h2><p>English is supported through local retrieval. Hindi and Tamil require the configured external language model ({aiConfigured ? "currently configured" : "currently unavailable"}); they remain unavailable otherwise.</p>
        <h2>Limits and disclaimer</h2><p>The local record set is small and incomplete, and the app has no live BIS catalog integration, legal applicability engine, user accounts, or production-grade multi-user controls. Always confirm current standards and requirements with official BIS sources.</p>
        <a className="button-primary modal-source" href="https://www.bis.gov.in/" target="_blank" rel="noreferrer">Official BIS website <ArrowRight size={14} /></a>
      </section>
    </>
  );
}

export default App;
