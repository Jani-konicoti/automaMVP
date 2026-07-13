import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  ConversationProvider,
  useConversationControls,
  useConversationMode,
  useConversationStatus,
} from "@elevenlabs/react";
import {
  CalendarClock,
  Database,
  FileText,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  Send,
  Save,
  Square,
  Upload,
} from "lucide-react";
import {
  Appointment,
  AppointmentInput,
  Knowledge,
  VectorSearchResult,
  VectorStoreSource,
  VectorStoreStats,
  createAppointment,
  getConversationToken,
  getKnowledge,
  getSignedUrl,
  getVectorStoreSources,
  getVectorStoreStats,
  listAppointments,
  saveKnowledge,
  searchVectorStore,
  uploadKnowledgePdf,
  uploadVectorStorePdf,
} from "./api";
import "./styles.css";

const BEHAVIOR_LIMIT = 8_000;
const DOCUMENTATION_LIMIT = 24_000;

type RetrievalQuery = {
  id: number;
  text: string;
};

function readableEvent(value: unknown) {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getUserMessage(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const event = value as Record<string, unknown>;
  const message = event.message;
  const source = event.source;
  const role = event.role;
  if (
    typeof message === "string" &&
    message.trim() &&
    (source === "user" || role === "user")
  ) {
    return message.trim();
  }

  return null;
}

function buildContextUpdate(knowledge: Knowledge) {
  const behavior = knowledge.behavior.slice(0, BEHAVIOR_LIMIT);
  const documentation = knowledge.documentation.slice(0, DOCUMENTATION_LIMIT);
  return `
Contesto operativo per questa conversazione.
Rispondi in italiano, in modo naturale, breve e professionale.
Segui prima le istruzioni di comportamento, poi usa la documentazione per rispondere a domande su servizi, orari, regole, prezzi o procedure.
Se la documentazione non contiene la risposta, dillo con chiarezza e proponi di lasciare un appuntamento o un recapito.
Per domande sulla documentazione, sui PDF caricati o su argomenti specifici come detassazione, reddito presunto, rinnovi contrattuali, maggiorazioni o mensilita, chiama prima il tool searchKnowledge con una query breve e specifica.
Non dire che non hai informazioni prima di aver cercato con searchKnowledge.

COMPORTAMENTO DEL BOT:
${behavior || "Nessuna istruzione di comportamento caricata."}

DOCUMENTAZIONE:
${documentation || "Nessuna documentazione caricata."}
`.trim();
}

function buildRetrievalUpdate(query: string, results: VectorSearchResult[]) {
  if (results.length === 0) {
    return "";
  }

  const passages = results
    .map(
      (result, index) =>
        `RISULTATO ${index + 1} - ${result.source} - chunk ${result.chunk_index + 1} - score ${result.score}\n${result.text}`,
    )
    .join("\n\n---\n\n");

  return `
Informazioni recuperate dal vector store locale per la domanda dell'utente: "${query}".
Usa questi passaggi solo se pertinenti alla domanda. Se non sono pertinenti, ignorali.

${passages}
`.trim();
}

function App() {
  const [knowledge, setKnowledge] = useState<Knowledge>({
    behavior: "",
    documentation: "",
  });
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingPdf, setIsUploadingPdf] = useState(false);
  const [pdfMode, setPdfMode] = useState<"append" | "replace">("append");
  const [pdfStatus, setPdfStatus] = useState<string | null>(null);
  const [vectorStats, setVectorStats] = useState<VectorStoreStats>({
    chunks: 0,
    sources: 0,
  });
  const [vectorSources, setVectorSources] = useState<VectorStoreSource[]>([]);
  const [retrievalQuery, setRetrievalQuery] = useState<RetrievalQuery | null>(null);
  const [isIndexingPdf, setIsIndexingPdf] = useState(false);
  const [vectorStatus, setVectorStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshAppointments = useCallback(async () => {
    const rows = await listAppointments();
    setAppointments(rows);
  }, []);

  useEffect(() => {
    Promise.all([
      getKnowledge(),
      listAppointments(),
      getVectorStoreStats(),
      getVectorStoreSources(),
    ])
      .then(([knowledgeResponse, appointmentRows, stats, sources]) => {
        setKnowledge(knowledgeResponse);
        setAppointments(appointmentRows);
        setVectorStats(stats);
        setVectorSources(sources);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Errore di inizializzazione");
      })
      .finally(() => setIsLoading(false));
  }, []);

  const handleSaveKnowledge = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await saveKnowledge(knowledge);
      setKnowledge(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Salvataggio fallito");
    } finally {
      setIsSaving(false);
    }
  }, [knowledge]);

  const handlePdfUpload = useCallback(
    async (file: File) => {
      setIsUploadingPdf(true);
      setPdfStatus(null);
      setError(null);
      try {
        const response = await uploadKnowledgePdf(file, pdfMode);
        setKnowledge({
          behavior: response.behavior,
          documentation: response.documentation,
        });
        setPdfStatus(
          `${file.name}: ${response.pages} pagine, ${response.extracted_chars.toLocaleString(
            "it-IT",
          )} caratteri estratti`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload PDF fallito");
      } finally {
        setIsUploadingPdf(false);
      }
    },
    [pdfMode],
  );

  const handleVectorPdfUpload = useCallback(
    async (file: File) => {
      setIsIndexingPdf(true);
      setVectorStatus(null);
      setError(null);
      try {
        const response = await uploadVectorStorePdf(file, pdfMode);
        setVectorStats({ chunks: response.chunks, sources: response.sources });
        setVectorSources(await getVectorStoreSources());
        setVectorStatus(
          `${response.source}: ${response.pages} pagine, ${response.extracted_chars.toLocaleString(
            "it-IT",
          )} caratteri indicizzati`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Indicizzazione PDF fallita");
      } finally {
        setIsIndexingPdf(false);
      }
    },
    [pdfMode],
  );

  const scheduleAppointment = useCallback(
    async (input: AppointmentInput) => {
      const created = await createAppointment(input);
      await refreshAppointments();
      return `Appuntamento inserito con ID ${created.id} per ${created.customer_name} il ${created.date} alle ${created.time}.`;
    },
    [refreshAppointments],
  );

  const searchKnowledge = useCallback(
    async (input: { query?: string; limit?: number }) => {
      const query = input.query?.trim();
      if (!query) {
        return "Query mancante. Specifica cosa cercare nella documentazione.";
      }

      const limit = Math.min(Math.max(input.limit ?? 4, 1), 6);
      const response = await searchVectorStore(query, limit);
      setMessages((current) =>
        [`tool searchKnowledge: "${query}" -> ${response.results.length} risultati`, ...current].slice(
          0,
          12,
        ),
      );

      if (response.results.length === 0) {
        return `Nessun risultato trovato nel vector store locale per: ${query}`;
      }

      return response.results
        .map(
          (result, index) =>
            `RISULTATO ${index + 1}\nFonte: ${result.source}\nChunk: ${
              result.chunk_index + 1
            }\nScore: ${result.score}\nTesto:\n${result.text}`,
        )
        .join("\n\n---\n\n");
    },
    [],
  );

  const providerConfig = useMemo(
    () => ({
      clientTools: {
        scheduleAppointment,
        searchKnowledge,
      },
      onMessage: (message: unknown) => {
        setMessages((current) => [`message: ${readableEvent(message)}`, ...current].slice(0, 12));
        const userMessage = getUserMessage(message);
        if (userMessage) {
          setRetrievalQuery({ id: Date.now(), text: userMessage });
        }
      },
      onConnect: (message: unknown) => {
        setMessages((current) => [`connect: ${readableEvent(message)}`, ...current].slice(0, 12));
      },
      onDisconnect: (message: unknown) => {
        const readable = readableEvent(message);
        setMessages((current) => [`disconnect: ${readable}`, ...current].slice(0, 12));
        if (readable && readable !== "{\"reason\":\"user\"}") {
          setError(`Sessione chiusa: ${readable}`);
        }
      },
      onStatusChange: (message: unknown) => {
        setMessages((current) => [`status: ${readableEvent(message)}`, ...current].slice(0, 12));
      },
      onDebug: (message: unknown) => {
        setMessages((current) => [`debug: ${readableEvent(message)}`, ...current].slice(0, 12));
      },
      onVadScore: (message: unknown) => {
        setMessages((current) => [`vad: ${readableEvent(message)}`, ...current].slice(0, 12));
      },
      onAsrInitiationMetadata: (message: unknown) => {
        setMessages((current) => [`asr: ${readableEvent(message)}`, ...current].slice(0, 12));
      },
      onError: (message: unknown) => {
        const readable = readableEvent(message);
        setMessages((current) => [`error: ${readable}`, ...current].slice(0, 12));
        setError(readable);
      },
    }),
    [scheduleAppointment, searchKnowledge],
  );

  return (
    <ConversationProvider {...providerConfig}>
      <Shell
        appointments={appointments}
        error={error}
        isLoading={isLoading}
        isSaving={isSaving}
        knowledge={knowledge}
        messages={messages}
        onKnowledgeChange={setKnowledge}
        onPdfModeChange={setPdfMode}
        onPdfUpload={handlePdfUpload}
        onVectorPdfUpload={handleVectorPdfUpload}
        onRefreshAppointments={refreshAppointments}
        onSaveKnowledge={handleSaveKnowledge}
        onSetError={setError}
        pdfMode={pdfMode}
        pdfStatus={pdfStatus}
        isUploadingPdf={isUploadingPdf}
        isIndexingPdf={isIndexingPdf}
        vectorStats={vectorStats}
        vectorStatus={vectorStatus}
        vectorSources={vectorSources}
        retrievalQuery={retrievalQuery}
      />
    </ConversationProvider>
  );
}

type ShellProps = {
  appointments: Appointment[];
  error: string | null;
  isLoading: boolean;
  isSaving: boolean;
  isIndexingPdf: boolean;
  isUploadingPdf: boolean;
  knowledge: Knowledge;
  messages: string[];
  pdfMode: "append" | "replace";
  pdfStatus: string | null;
  vectorStats: VectorStoreStats;
  vectorStatus: string | null;
  vectorSources: VectorStoreSource[];
  retrievalQuery: RetrievalQuery | null;
  onKnowledgeChange: (value: Knowledge) => void;
  onPdfModeChange: (value: "append" | "replace") => void;
  onPdfUpload: (file: File) => Promise<void>;
  onVectorPdfUpload: (file: File) => Promise<void>;
  onRefreshAppointments: () => Promise<void>;
  onSaveKnowledge: () => Promise<void>;
  onSetError: (value: string | null) => void;
};

function Shell({
  appointments,
  error,
  isLoading,
  isIndexingPdf,
  isSaving,
  isUploadingPdf,
  knowledge,
  messages,
  pdfMode,
  pdfStatus,
  vectorStats,
  vectorStatus,
  vectorSources,
  retrievalQuery,
  onKnowledgeChange,
  onPdfModeChange,
  onPdfUpload,
  onVectorPdfUpload,
  onSaveKnowledge,
  onSetError,
}: ShellProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const vectorFileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Demo MVP</p>
          <h1>Centralino AI</h1>
        </div>
        <StatusPill />
      </header>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button type="button" onClick={() => onSetError(null)}>
            Chiudi
          </button>
        </div>
      )}

      <section className="main-grid">
        <div className="workspace-panel knowledge-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Knowledge testuale</p>
              <h2>Contesto dell'agente</h2>
            </div>
            <button
              className="icon-button primary"
              disabled={isLoading || isSaving}
              title="Salva knowledge"
              type="button"
              onClick={onSaveKnowledge}
            >
              {isSaving ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
            </button>
          </div>
          <label className="field-label" htmlFor="behavior">
            Comportamento del bot
          </label>
          <textarea
            className="behavior-editor"
            disabled={isLoading}
            id="behavior"
            value={knowledge.behavior}
            onChange={(event) =>
              onKnowledgeChange({ ...knowledge, behavior: event.target.value })
            }
          />
          <label className="field-label" htmlFor="documentation">
            Documentazione
          </label>
          <div className="pdf-toolbar">
            <div className="transport-toggle pdf-mode-toggle">
              <button
                className={pdfMode === "append" ? "active" : ""}
                disabled={isUploadingPdf}
                type="button"
                onClick={() => onPdfModeChange("append")}
              >
                Aggiungi
              </button>
              <button
                className={pdfMode === "replace" ? "active" : ""}
                disabled={isUploadingPdf}
                type="button"
                onClick={() => onPdfModeChange("replace")}
              >
                Sostituisci
              </button>
            </div>
            <input
              accept="application/pdf"
              className="hidden-file-input"
              disabled={isUploadingPdf}
              ref={fileInputRef}
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  void onPdfUpload(file);
                }
              }}
            />
            <button
              className="pdf-upload-button"
              disabled={isUploadingPdf}
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              {isUploadingPdf ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Upload size={16} />
              )}
              PDF
            </button>
            <input
              accept="application/pdf"
              className="hidden-file-input"
              disabled={isIndexingPdf}
              ref={vectorFileInputRef}
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  void onVectorPdfUpload(file);
                }
              }}
            />
            <button
              className="pdf-upload-button secondary"
              disabled={isIndexingPdf}
              type="button"
              onClick={() => vectorFileInputRef.current?.click()}
            >
              {isIndexingPdf ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Database size={16} />
              )}
              Vector PDF
            </button>
          </div>
          {pdfStatus && (
            <div className="pdf-status">
              <FileText size={15} />
              <span>{pdfStatus}</span>
            </div>
          )}
          <div className="pdf-status vector-status">
            <Database size={15} />
            <span>
              Vector store: {vectorStats.chunks.toLocaleString("it-IT")} chunk,{" "}
              {vectorStats.sources.toLocaleString("it-IT")} fonti
              {vectorStatus ? ` - ${vectorStatus}` : ""}
            </span>
          </div>
          {vectorSources.length > 0 && (
            <div className="vector-sources">
              {vectorSources.map((source) => (
                <article className="vector-source-card" key={source.source}>
                  <div>
                    <strong>{source.source}</strong>
                    <span>
                      {source.chunks.toLocaleString("it-IT")} chunk ·{" "}
                      {source.chars.toLocaleString("it-IT")} caratteri
                    </span>
                  </div>
                  <p>{source.preview}</p>
                </article>
              ))}
            </div>
          )}
          <textarea
            className="documentation-editor"
            disabled={isLoading}
            id="documentation"
            value={knowledge.documentation}
            onChange={(event) =>
              onKnowledgeChange({ ...knowledge, documentation: event.target.value })
            }
          />
          <div className="meter-row">
            <span>
              Bot: {knowledge.behavior.length.toLocaleString("it-IT")} /{" "}
              {BEHAVIOR_LIMIT.toLocaleString("it-IT")}
            </span>
            <span>
              Docs: {knowledge.documentation.length.toLocaleString("it-IT")} /{" "}
              {DOCUMENTATION_LIMIT.toLocaleString("it-IT")}
            </span>
          </div>
        </div>

        <div className="right-column">
          <VoicePanel knowledge={knowledge} retrievalQuery={retrievalQuery} />
          <AppointmentsPanel appointments={appointments} />
          <DebugPanel messages={messages} />
        </div>
      </section>
    </main>
  );
}

function VoicePanel({
  knowledge,
  retrievalQuery,
}: {
  knowledge: Knowledge;
  retrievalQuery: RetrievalQuery | null;
}) {
  const {
    startSession,
    endSession,
    sendContextualUpdate,
    sendUserMessage,
    getInputVolume,
  } = useConversationControls();
  const { status } = useConversationStatus();
  const { mode } = useConversationMode();
  const [isStarting, setIsStarting] = useState(false);
  const [inputVolume, setInputVolume] = useState(0);
  const [textMessage, setTextMessage] = useState("");
  const [connectionMode, setConnectionMode] = useState<"webrtc" | "websocket">("webrtc");
  const hasSentContextRef = useRef(false);
  const lastRetrievalIdRef = useRef<number | null>(null);
  const isConnected = status === "connected";

  useEffect(() => {
    if (!isConnected) {
      hasSentContextRef.current = false;
      return;
    }

    if (!hasSentContextRef.current) {
      sendContextualUpdate(buildContextUpdate(knowledge));
      hasSentContextRef.current = true;
    }
  }, [isConnected, knowledge, sendContextualUpdate]);

  useEffect(() => {
    if (!isConnected) {
      setInputVolume(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      setInputVolume(getInputVolume());
    }, 120);

    return () => window.clearInterval(intervalId);
  }, [getInputVolume, isConnected]);

  useEffect(() => {
    if (!isConnected || !retrievalQuery || lastRetrievalIdRef.current === retrievalQuery.id) {
      return;
    }

    lastRetrievalIdRef.current = retrievalQuery.id;
    searchVectorStore(retrievalQuery.text, 4)
      .then((response) => {
        const update = buildRetrievalUpdate(retrievalQuery.text, response.results);
        if (update) {
          sendContextualUpdate(update);
        }
      })
      .catch((err: unknown) => {
        console.warn("Vector retrieval failed", err);
      });
  }, [isConnected, retrievalQuery, sendContextualUpdate]);

  const handleStart = async () => {
    setIsStarting(true);
    try {
      if (connectionMode === "webrtc") {
        const response = await getConversationToken();
        await startSession({
          conversationToken: response.token,
          connectionType: "webrtc",
          textOnly: false,
        });
      } else {
        const response = await getSignedUrl();
        await startSession({
          signedUrl: response.signed_url,
          connectionType: "websocket",
          textOnly: false,
        });
      }
    } finally {
      setIsStarting(false);
    }
  };

  const handleSendText = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = textMessage.trim();
    if (!message || !isConnected) {
      return;
    }
    sendUserMessage(message);
    setTextMessage("");
  };

  return (
    <section className="workspace-panel voice-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Voce realtime</p>
          <h2>Sessione agente</h2>
        </div>
        <PhoneCall size={22} />
      </div>

      <div className={`orb ${isConnected ? "live" : ""}`}>
        {isConnected ? <Mic size={36} /> : <MicOff size={36} />}
      </div>

      <div className="voice-stats">
        <span>Stato: {status}</span>
        <span>{connectionMode === "webrtc" ? "WebRTC" : "WebSocket"}</span>
      </div>
      <div className="voice-stats compact">
        <span>Modalita: {mode ?? "idle"}</span>
      </div>

      <div className="input-meter" aria-label="Livello microfono">
        <span style={{ width: `${Math.min(100, Math.round(inputVolume * 100))}%` }} />
      </div>

      <div className="transport-toggle">
        <button
          className={connectionMode === "webrtc" ? "active" : ""}
          disabled={isConnected || isStarting}
          type="button"
          onClick={() => setConnectionMode("webrtc")}
        >
          Bassa latenza
        </button>
        <button
          className={connectionMode === "websocket" ? "active" : ""}
          disabled={isConnected || isStarting}
          type="button"
          onClick={() => setConnectionMode("websocket")}
        >
          Stabile
        </button>
      </div>

      {isConnected ? (
        <button className="action-button danger" type="button" onClick={endSession}>
          <Square size={18} />
          Termina
        </button>
      ) : (
        <button
          className="action-button"
          disabled={isStarting}
          type="button"
          onClick={handleStart}
        >
          {isStarting ? <Loader2 className="spin" size={18} /> : <Mic size={18} />}
          Avvia voce
        </button>
      )}

      <form className="text-test" onSubmit={handleSendText}>
        <input
          disabled={!isConnected}
          placeholder="Test messaggio"
          value={textMessage}
          onChange={(event) => setTextMessage(event.target.value)}
        />
        <button disabled={!isConnected || !textMessage.trim()} title="Invia testo" type="submit">
          <Send size={16} />
        </button>
      </form>
    </section>
  );
}

function StatusPill() {
  const { status } = useConversationStatus();
  return (
    <div className="status-pill">
      <span className={`status-dot ${status === "connected" ? "on" : ""}`} />
      {status}
    </div>
  );
}

function AppointmentsPanel({ appointments }: { appointments: Appointment[] }) {
  return (
    <section className="workspace-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SQLite</p>
          <h2>Appuntamenti</h2>
        </div>
        <CalendarClock size={22} />
      </div>

      <div className="appointments-list">
        {appointments.length === 0 ? (
          <p className="muted">Nessun appuntamento inserito.</p>
        ) : (
          appointments.map((appointment) => (
            <article className="appointment-card" key={appointment.id}>
              <div>
                <strong>{appointment.customer_name}</strong>
                <span>
                  {appointment.date} alle {appointment.time}
                </span>
              </div>
              {appointment.phone && <span>{appointment.phone}</span>}
              {appointment.notes && <p>{appointment.notes}</p>}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function DebugPanel({ messages }: { messages: string[] }) {
  return (
    <section className="workspace-panel debug-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Eventi</p>
          <h2>Transcript/debug</h2>
        </div>
        <Database size={22} />
      </div>
      <div className="debug-log">
        {messages.length === 0 ? (
          <p className="muted">Gli eventi della conversazione appariranno qui.</p>
        ) : (
          messages.map((message, index) => <code key={`${index}-${message}`}>{message}</code>)
        )}
      </div>
    </section>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
