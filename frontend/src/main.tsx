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
  Check,
  Database,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  Plus,
  Save,
  Send,
  Settings,
  Square,
  Trash2,
} from "lucide-react";
import {
  Appointment,
  AppointmentInput,
  ElevenLabsAgent,
  ElevenLabsAgentInput,
  ElevenLabsConfig,
  Knowledge,
  VectorSearchResult,
  VectorStoreSource,
  VectorStoreStats,
  activateElevenLabsAgent,
  createAppointment,
  createElevenLabsAgent,
  deleteElevenLabsAgent,
  getConversationToken,
  getElevenLabsConfig,
  getKnowledge,
  getSignedUrl,
  getVectorStoreSources,
  getVectorStoreStats,
  listAppointments,
  saveElevenLabsConfig,
  searchVectorStore,
  updateElevenLabsAgent,
  uploadVectorStorePdf,
} from "./api";
import "./styles.css";

const BEHAVIOR_LIMIT = 8_000;
const LOCAL_BEHAVIOR_KEY = "centralino.localBehavior";

type RetrievalQuery = {
  id: number;
  text: string;
};

type CallScenario = "inbound" | "outbound";
type AppView = "demo" | "config";
type MainTab = "fonti" | "centralino" | "presentazione";
type VoiceContext = "centralino" | "presentazione";

function callScenarioLabel(callScenario: CallScenario) {
  return callScenario === "inbound" ? "chiamata in entrata" : "chiamata in uscita";
}

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

function getAgentMessage(value: unknown) {
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
    (source === "ai" || source === "agent" || role === "agent")
  ) {
    return message.trim();
  }

  return null;
}

function buildContextUpdate(
  selectedVectorSource: string | null,
  callScenario: CallScenario,
) {
  const sourceInstruction = selectedVectorSource
    ? `Fonte PDF attiva per il vector store: ${selectedVectorSource}. Quando cerchi nella documentazione PDF usa solo questa fonte.`
    : "Fonte PDF attiva per il vector store: tutte le fonti caricate.";
  const scenarioInstruction = `Scenario corrente: ${callScenarioLabel(callScenario)}.`;

  return `
Contesto operativo per questa conversazione.
Rispondi in italiano, in modo naturale, breve e professionale.
${scenarioInstruction}
Segui prima le istruzioni di comportamento, poi usa la documentazione per rispondere a domande su servizi, orari, regole, prezzi o procedure.
Se la documentazione non contiene la risposta, dillo con chiarezza e proponi di lasciare un appuntamento o un recapito.
Per domande sulla documentazione, sui PDF caricati o su argomenti specifici come detassazione, reddito presunto, rinnovi contrattuali, maggiorazioni o mensilita, chiama prima il tool searchKnowledge con una query breve e specifica.
Non dire che non hai informazioni prima di aver cercato con searchKnowledge.
${sourceInstruction}
`.trim();
}

function buildRealtimeContextUpdate(
  callScenario: CallScenario,
  selectedVectorSource: string | null,
) {
  return `
Scenario corrente: ${callScenarioLabel(callScenario)}.
Fonte PDF attiva: ${selectedVectorSource || "tutte le fonti"}.
Per domande su documenti o PDF usa il tool searchKnowledge prima di rispondere.
`.trim();
}

function buildPresentationContextUpdate(selectedVectorSource: string | null) {
  return `
Modalita corrente: presentazione prodotto.
Fonte PDF attiva: ${selectedVectorSource || "tutte le fonti"}.
Usa il tool searchKnowledge prima di presentare funzionalita, benefici, casi d'uso o dettagli commerciali.
Presenta il prodotto in sezioni fluide e professionali, senza inventare informazioni non presenti nella documentazione.
`.trim();
}

function buildPresentationStartPrompt(selectedVectorSource: string | null) {
  return `
Avvia una presentazione commerciale del prodotto usando la fonte PDF attiva: ${
    selectedVectorSource || "tutte le fonti"
  }.
Prima recupera le informazioni principali con searchKnowledge. Poi presenta introduzione, problema risolto, funzionalita principali, benefici, casi d'uso e chiusura.
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
  const [appView, setAppView] = useState<AppView>("demo");
  const [knowledge, setKnowledge] = useState<Knowledge>({
    behavior:
      typeof window === "undefined" ? "" : window.localStorage.getItem(LOCAL_BEHAVIOR_KEY) ?? "",
    documentation: "",
  });
  const [elevenLabsConfig, setElevenLabsConfig] = useState<ElevenLabsConfig>({
    api_key: "",
    agents: [],
    active_agent_id: null,
    configured: false,
  });
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [presentationTranscript, setPresentationTranscript] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pdfMode, setPdfMode] = useState<"append" | "replace">("append");
  const [callScenario, setCallScenario] = useState<CallScenario>("inbound");
  const [vectorStats, setVectorStats] = useState<VectorStoreStats>({
    chunks: 0,
    sources: 0,
  });
  const [vectorSources, setVectorSources] = useState<VectorStoreSource[]>([]);
  const [selectedVectorSource, setSelectedVectorSource] = useState<string | null>(null);
  const [retrievalQuery, setRetrievalQuery] = useState<RetrievalQuery | null>(null);
  const [isIndexingPdf, setIsIndexingPdf] = useState(false);
  const [vectorStatus, setVectorStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeVoiceContextRef = useRef<VoiceContext | null>(null);

  const handleVoiceContextChange = useCallback((value: VoiceContext | null) => {
    activeVoiceContextRef.current = value;
  }, []);

  const handleClearPresentationTranscript = useCallback(() => {
    setPresentationTranscript([]);
  }, []);

  const refreshAppointments = useCallback(async () => {
    const rows = await listAppointments();
    setAppointments(rows);
  }, []);

  useEffect(() => {
    Promise.all([
      getKnowledge(),
      getElevenLabsConfig(),
      listAppointments(),
      getVectorStoreStats(),
      getVectorStoreSources(),
    ])
      .then(([knowledgeResponse, configResponse, appointmentRows, stats, sources]) => {
        setKnowledge((current) => ({
          behavior: current.behavior || knowledgeResponse.behavior,
          documentation: knowledgeResponse.documentation,
        }));
        setElevenLabsConfig(configResponse);
        setAppointments(appointmentRows);
        setVectorStats(stats);
        setVectorSources(sources);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Errore di inizializzazione");
      })
      .finally(() => setIsLoading(false));
  }, []);

  const refreshElevenLabsConfig = useCallback(async () => {
    const config = await getElevenLabsConfig();
    setElevenLabsConfig(config);
    return config;
  }, []);

  const handleSaveElevenLabsApiKey = useCallback(async (apiKey: string) => {
    setError(null);
    const config = await saveElevenLabsConfig(apiKey);
    setElevenLabsConfig(config);
  }, []);

  const handleCreateElevenLabsAgent = useCallback(
    async (input: ElevenLabsAgentInput) => {
      setError(null);
      await createElevenLabsAgent(input);
      await refreshElevenLabsConfig();
    },
    [refreshElevenLabsConfig],
  );

  const handleUpdateElevenLabsAgent = useCallback(
    async (id: number, input: ElevenLabsAgentInput) => {
      setError(null);
      await updateElevenLabsAgent(id, input);
      await refreshElevenLabsConfig();
    },
    [refreshElevenLabsConfig],
  );

  const handleActivateElevenLabsAgent = useCallback(
    async (id: number) => {
      setError(null);
      await activateElevenLabsAgent(id);
      await refreshElevenLabsConfig();
    },
    [refreshElevenLabsConfig],
  );

  const handleDeleteElevenLabsAgent = useCallback(async (id: number) => {
    setError(null);
    const config = await deleteElevenLabsAgent(id);
    setElevenLabsConfig(config);
  }, []);

  useEffect(() => {
    if (
      selectedVectorSource &&
      !vectorSources.some((source) => source.source === selectedVectorSource)
    ) {
      setSelectedVectorSource(null);
    }
  }, [selectedVectorSource, vectorSources]);

  const handleVectorPdfUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      setIsIndexingPdf(true);
      setVectorStatus(null);
      setError(null);
      try {
        const responses = [];
        for (const file of files) {
          responses.push(await uploadVectorStorePdf(file, pdfMode));
        }

        const lastResponse = responses[responses.length - 1];
        const sources = await getVectorStoreSources();
        setVectorStats({ chunks: lastResponse.chunks, sources: lastResponse.sources });
        setVectorSources(sources);
        setSelectedVectorSource(lastResponse.source);
        setVectorStatus(
          files.length === 1
            ? `${lastResponse.source}: ${lastResponse.pages} pagine, ${lastResponse.extracted_chars.toLocaleString(
                "it-IT",
              )} caratteri indicizzati`
            : `${files.length} PDF indicizzati, fonte attiva: ${lastResponse.source}`,
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
      const response = await searchVectorStore(query, limit, selectedVectorSource);
      setMessages((current) =>
        [
          `tool searchKnowledge: "${query}"${
            selectedVectorSource ? ` [${selectedVectorSource}]` : ""
          } -> ${response.results.length} risultati`,
          ...current,
        ].slice(0, 12),
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
    [selectedVectorSource],
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
        const agentMessage = getAgentMessage(message);
        if (agentMessage && activeVoiceContextRef.current === "presentazione") {
          setPresentationTranscript((current) => [...current, agentMessage].slice(-80));
        }
      },
      onConnect: (message: unknown) => {
        setMessages((current) => [`connect: ${readableEvent(message)}`, ...current].slice(0, 12));
      },
      onDisconnect: (message: unknown) => {
        const readable = readableEvent(message);
        setMessages((current) => [`disconnect: ${readable}`, ...current].slice(0, 12));
        activeVoiceContextRef.current = null;
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
      onVadScore: () => {
        // VAD fires very frequently while speaking; avoid re-rendering during audio capture.
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
        appView={appView}
        appointments={appointments}
        error={error}
        isLoading={isLoading}
        elevenLabsConfig={elevenLabsConfig}
        knowledge={knowledge}
        messages={messages}
        presentationTranscript={presentationTranscript}
        callScenario={callScenario}
        onAppViewChange={setAppView}
        onKnowledgeChange={(value) => {
          window.localStorage.setItem(LOCAL_BEHAVIOR_KEY, value.behavior);
          setKnowledge(value);
        }}
        onCallScenarioChange={setCallScenario}
        onClearPresentationTranscript={handleClearPresentationTranscript}
        onActivateElevenLabsAgent={handleActivateElevenLabsAgent}
        onCreateElevenLabsAgent={handleCreateElevenLabsAgent}
        onDeleteElevenLabsAgent={handleDeleteElevenLabsAgent}
        onSaveElevenLabsApiKey={handleSaveElevenLabsApiKey}
        onUpdateElevenLabsAgent={handleUpdateElevenLabsAgent}
        onPdfModeChange={setPdfMode}
        onVectorPdfUpload={handleVectorPdfUpload}
        onVectorSourceChange={setSelectedVectorSource}
        onSetError={setError}
        onVoiceContextChange={handleVoiceContextChange}
        pdfMode={pdfMode}
        isIndexingPdf={isIndexingPdf}
        vectorStats={vectorStats}
        vectorStatus={vectorStatus}
        vectorSources={vectorSources}
        selectedVectorSource={selectedVectorSource}
        retrievalQuery={retrievalQuery}
      />
    </ConversationProvider>
  );
}

type ShellProps = {
  appView: AppView;
  appointments: Appointment[];
  elevenLabsConfig: ElevenLabsConfig;
  error: string | null;
  isLoading: boolean;
  isIndexingPdf: boolean;
  knowledge: Knowledge;
  messages: string[];
  presentationTranscript: string[];
  callScenario: CallScenario;
  pdfMode: "append" | "replace";
  vectorStats: VectorStoreStats;
  vectorStatus: string | null;
  vectorSources: VectorStoreSource[];
  selectedVectorSource: string | null;
  retrievalQuery: RetrievalQuery | null;
  onAppViewChange: (value: AppView) => void;
  onActivateElevenLabsAgent: (id: number) => Promise<void>;
  onCallScenarioChange: (value: CallScenario) => void;
  onClearPresentationTranscript: () => void;
  onCreateElevenLabsAgent: (input: ElevenLabsAgentInput) => Promise<void>;
  onDeleteElevenLabsAgent: (id: number) => Promise<void>;
  onKnowledgeChange: (value: Knowledge) => void;
  onPdfModeChange: (value: "append" | "replace") => void;
  onSaveElevenLabsApiKey: (apiKey: string) => Promise<void>;
  onUpdateElevenLabsAgent: (id: number, input: ElevenLabsAgentInput) => Promise<void>;
  onVectorPdfUpload: (files: File[]) => Promise<void>;
  onVectorSourceChange: (source: string | null) => void;
  onVoiceContextChange: (value: VoiceContext | null) => void;
  onSetError: (value: string | null) => void;
};

function Shell({
  appView,
  appointments,
  elevenLabsConfig,
  error,
  isLoading,
  isIndexingPdf,
  knowledge,
  messages,
  presentationTranscript,
  callScenario,
  pdfMode,
  vectorStats,
  vectorStatus,
  vectorSources,
  selectedVectorSource,
  retrievalQuery,
  onAppViewChange,
  onActivateElevenLabsAgent,
  onCallScenarioChange,
  onClearPresentationTranscript,
  onCreateElevenLabsAgent,
  onDeleteElevenLabsAgent,
  onKnowledgeChange,
  onPdfModeChange,
  onSaveElevenLabsApiKey,
  onUpdateElevenLabsAgent,
  onVectorPdfUpload,
  onVectorSourceChange,
  onVoiceContextChange,
  onSetError,
}: ShellProps) {
  const vectorFileInputRef = useRef<HTMLInputElement | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>("fonti");

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">CP DEMO</p>
          <h1>CP DEMO</h1>
        </div>
        <div className="topbar-actions">
          <div className="view-tabs">
            <button
              className={appView === "demo" ? "active" : ""}
              type="button"
              onClick={() => onAppViewChange("demo")}
            >
              Demo
            </button>
            <button
              className={appView === "config" ? "active" : ""}
              type="button"
              onClick={() => onAppViewChange("config")}
            >
              <Settings size={16} />
              Configurazione
            </button>
          </div>
          <StatusPill />
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button type="button" onClick={() => onSetError(null)}>
            Chiudi
          </button>
        </div>
      )}

      {appView === "config" ? (
        <ConfigPage
          config={elevenLabsConfig}
          isLoading={isLoading}
          onActivateAgent={onActivateElevenLabsAgent}
          onCreateAgent={onCreateElevenLabsAgent}
          onDeleteAgent={onDeleteElevenLabsAgent}
          onSaveApiKey={onSaveElevenLabsApiKey}
          onSetError={onSetError}
          onUpdateAgent={onUpdateElevenLabsAgent}
        />
      ) : (
        <section className="main-workspace">
          <div className="section-tabs">
            <button
              className={mainTab === "fonti" ? "active" : ""}
              type="button"
              onClick={() => setMainTab("fonti")}
            >
              Fonti
            </button>
            <button
              className={mainTab === "centralino" ? "active" : ""}
              type="button"
              onClick={() => setMainTab("centralino")}
            >
              Centralino
            </button>
            <button
              className={mainTab === "presentazione" ? "active" : ""}
              type="button"
              onClick={() => setMainTab("presentazione")}
            >
              Presentazione
            </button>
          </div>

          {mainTab === "fonti" ? (
            <div className="sources-layout">
              <div className="workspace-panel sources-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Knowledge PDF</p>
              <h2>Fonti dell'agente</h2>
            </div>
          </div>
          <label className="field-label">
            Vector PDF
          </label>
          <div className="pdf-toolbar">
            <div className="transport-toggle pdf-mode-toggle">
              <button
                className={pdfMode === "append" ? "active" : ""}
                disabled={isIndexingPdf}
                type="button"
                onClick={() => onPdfModeChange("append")}
              >
                Aggiungi
              </button>
              <button
                className={pdfMode === "replace" ? "active" : ""}
                disabled={isIndexingPdf}
                type="button"
                onClick={() => onPdfModeChange("replace")}
              >
                Sostituisci
              </button>
            </div>
            <input
              accept="application/pdf"
              className="hidden-file-input"
              disabled={isIndexingPdf}
              multiple
              ref={vectorFileInputRef}
              type="file"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length > 0) {
                  void onVectorPdfUpload(files);
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
              <label className="vector-source-option all-sources">
                <input
                  checked={selectedVectorSource === null}
                  name="vector-source"
                  type="radio"
                  onChange={() => onVectorSourceChange(null)}
                />
                <span>
                  <strong>Tutte le fonti</strong>
                  <small>Il tool cerca in tutti i PDF indicizzati.</small>
                </span>
              </label>
              {vectorSources.map((source) => (
                <label className="vector-source-option" key={source.source}>
                  <input
                    checked={selectedVectorSource === source.source}
                    name="vector-source"
                    type="radio"
                    onChange={() => onVectorSourceChange(source.source)}
                  />
                  <article className="vector-source-card">
                  <div>
                    <strong>{source.source}</strong>
                    <span>
                      {source.chunks.toLocaleString("it-IT")} chunk -{" "}
                      {source.chars.toLocaleString("it-IT")} caratteri
                    </span>
                  </div>
                  <p>{source.preview}</p>
                  </article>
                </label>
              ))}
            </div>
          )}
              </div>

            </div>
          ) : mainTab === "centralino" ? (
            <div className="main-grid">
              <div className="workspace-panel knowledge-panel">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">Centralino</p>
                    <h2>Comportamento del bot</h2>
                  </div>
                </div>
                <textarea
                  className="behavior-editor"
                  disabled={isLoading}
                  id="behavior"
                  value={knowledge.behavior}
                  onChange={(event) =>
                    onKnowledgeChange({ ...knowledge, behavior: event.target.value })
                  }
                />
                <div className="meter-row">
                  <span>
                    Bot: {knowledge.behavior.length.toLocaleString("it-IT")} /{" "}
                    {BEHAVIOR_LIMIT.toLocaleString("it-IT")}
                  </span>
                </div>
              </div>

              <div className="right-column">
                <VoicePanel
                  callScenario={callScenario}
                  elevenLabsConfig={elevenLabsConfig}
                  onCallScenarioChange={onCallScenarioChange}
                  onSetError={onSetError}
                  onVoiceContextChange={onVoiceContextChange}
                  retrievalQuery={retrievalQuery}
                  selectedVectorSource={selectedVectorSource}
                />
                <AppointmentsPanel appointments={appointments} />
                <DebugPanel messages={messages} />
              </div>
            </div>
          ) : (
            <PresentationPage
              callScenario={callScenario}
              elevenLabsConfig={elevenLabsConfig}
              onSetError={onSetError}
              onVectorSourceChange={onVectorSourceChange}
              onVoiceContextChange={onVoiceContextChange}
              onClearTranscript={onClearPresentationTranscript}
              retrievalQuery={retrievalQuery}
              selectedVectorSource={selectedVectorSource}
              transcript={presentationTranscript}
              vectorSources={vectorSources}
            />
          )}
        </section>
      )}
    </main>
  );
}

function PresentationPage({
  callScenario,
  elevenLabsConfig,
  onClearTranscript,
  onSetError,
  onVectorSourceChange,
  onVoiceContextChange,
  retrievalQuery,
  selectedVectorSource,
  transcript,
  vectorSources,
}: {
  callScenario: CallScenario;
  elevenLabsConfig: ElevenLabsConfig;
  onClearTranscript: () => void;
  onSetError: (value: string | null) => void;
  onVectorSourceChange: (source: string | null) => void;
  onVoiceContextChange: (value: VoiceContext | null) => void;
  retrievalQuery: RetrievalQuery | null;
  selectedVectorSource: string | null;
  transcript: string[];
  vectorSources: VectorStoreSource[];
}) {
  const preferredAgent =
    elevenLabsConfig.agents.find((agent) =>
      agent.name.toLowerCase().includes("present"),
    ) || elevenLabsConfig.agents.find((agent) => agent.is_active) || elevenLabsConfig.agents[0];
  const [presentationAgentId, setPresentationAgentId] = useState<string | null>(
    preferredAgent?.agent_id ?? null,
  );

  useEffect(() => {
    if (
      presentationAgentId &&
      elevenLabsConfig.agents.some((agent) => agent.agent_id === presentationAgentId)
    ) {
      return;
    }

    setPresentationAgentId(preferredAgent?.agent_id ?? null);
  }, [elevenLabsConfig.agents, preferredAgent?.agent_id, presentationAgentId]);

  const selectedAgent = elevenLabsConfig.agents.find(
    (agent) => agent.agent_id === presentationAgentId,
  );
  const selectedSource = selectedVectorSource
    ? vectorSources.find((source) => source.source === selectedVectorSource)
    : undefined;
  const startPrompt = buildPresentationStartPrompt(selectedVectorSource);

  return (
    <div className="presentation-grid">
      <section className="workspace-panel presentation-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Presentazione</p>
            <h2>Setup prodotto</h2>
          </div>
          <Database size={22} />
        </div>

        <label className="field-label" htmlFor="presentation-agent">
          Agente presentazione
        </label>
        <select
          className="config-select"
          id="presentation-agent"
          value={presentationAgentId ?? ""}
          onChange={(event) => setPresentationAgentId(event.target.value || null)}
        >
          {elevenLabsConfig.agents.length === 0 ? (
            <option value="">Nessun agente configurato</option>
          ) : (
            elevenLabsConfig.agents.map((agent) => (
              <option key={agent.id} value={agent.agent_id}>
                {agent.name}
              </option>
            ))
          )}
        </select>

        <label className="field-label">Fonte PDF da presentare</label>
        <div className="vector-sources presentation-sources">
          <label className="vector-source-option all-sources">
            <input
              checked={selectedVectorSource === null}
              name="presentation-source"
              type="radio"
              onChange={() => onVectorSourceChange(null)}
            />
            <span>
              <strong>Tutte le fonti</strong>
              <small>L'agente prepara una presentazione usando tutti i PDF indicizzati.</small>
            </span>
          </label>
          {vectorSources.map((source) => (
            <label className="vector-source-option" key={source.source}>
              <input
                checked={selectedVectorSource === source.source}
                name="presentation-source"
                type="radio"
                onChange={() => onVectorSourceChange(source.source)}
              />
              <article className="vector-source-card">
                <div>
                  <strong>{source.source}</strong>
                  <span>
                    {source.chunks.toLocaleString("it-IT")} chunk -{" "}
                    {source.chars.toLocaleString("it-IT")} caratteri
                  </span>
                </div>
                <p>{source.preview}</p>
              </article>
            </label>
          ))}
        </div>

        <div className="presentation-summary">
          <strong>Pronto per presentare</strong>
          <span>Agente: {selectedAgent?.name || "non configurato"}</span>
          <span>Fonte: {selectedSource?.source || "tutte le fonti"}</span>
        </div>
      </section>

      <div className="right-column">
        <VoicePanel
          agentId={presentationAgentId}
          agentName={selectedAgent?.name}
          callScenario={callScenario}
          contextMode="presentazione"
          elevenLabsConfig={elevenLabsConfig}
          onCallScenarioChange={() => undefined}
          onBeforeStart={onClearTranscript}
          onSetError={onSetError}
          onVoiceContextChange={onVoiceContextChange}
          retrievalQuery={retrievalQuery}
          selectedVectorSource={selectedVectorSource}
          showScenario={false}
          startButtonLabel="Avvia presentazione"
          startPrompt={startPrompt}
          title="Presentazione vocale"
        />
        <PresentationTranscript messages={transcript} onClear={onClearTranscript} />
      </div>
    </div>
  );
}

function PresentationTranscript({
  messages,
  onClear,
}: {
  messages: string[];
  onClear: () => void;
}) {
  return (
    <section className="workspace-panel presentation-transcript-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Output agente</p>
          <h2>Trascrizione presentazione</h2>
        </div>
        <button className="small-button" disabled={messages.length === 0} type="button" onClick={onClear}>
          Pulisci
        </button>
      </div>
      <div className="presentation-transcript">
        {messages.length === 0 ? (
          <p className="muted">Il testo parlato dall'agente apparira qui.</p>
        ) : (
          messages.map((message, index) => (
            <p key={`${index}-${message}`}>{message}</p>
          ))
        )}
      </div>
    </section>
  );
}

function ConfigPage({
  config,
  isLoading,
  onActivateAgent,
  onCreateAgent,
  onDeleteAgent,
  onSaveApiKey,
  onSetError,
  onUpdateAgent,
}: {
  config: ElevenLabsConfig;
  isLoading: boolean;
  onActivateAgent: (id: number) => Promise<void>;
  onCreateAgent: (input: ElevenLabsAgentInput) => Promise<void>;
  onDeleteAgent: (id: number) => Promise<void>;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onSetError: (value: string | null) => void;
  onUpdateAgent: (id: number, input: ElevenLabsAgentInput) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState(config.api_key);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentId, setNewAgentId] = useState("");
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);

  useEffect(() => {
    setApiKey(config.api_key);
  }, [config.api_key]);

  const handleSaveApiKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSavingKey(true);
    try {
      await onSaveApiKey(apiKey);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Salvataggio API key fallito");
    } finally {
      setIsSavingKey(false);
    }
  };

  const handleCreateAgent = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newAgentName.trim();
    const agentId = newAgentId.trim();
    if (!name || !agentId) {
      return;
    }

    setIsCreatingAgent(true);
    try {
      await onCreateAgent({ name, agent_id: agentId });
      setNewAgentName("");
      setNewAgentId("");
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Creazione agente fallita");
    } finally {
      setIsCreatingAgent(false);
    }
  };

  return (
    <section className="config-grid">
      <div className="workspace-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">ElevenLabs</p>
            <h2>Credenziali</h2>
          </div>
          <Settings size={22} />
        </div>

        <form className="config-form" onSubmit={handleSaveApiKey}>
          <label className="field-label" htmlFor="elevenlabs-api-key">
            ElevenLabs API key
          </label>
          <input
            disabled={isLoading || isSavingKey}
            id="elevenlabs-api-key"
            type="text"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <button className="action-button compact-action" disabled={isSavingKey} type="submit">
            {isSavingKey ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
            Salva API key
          </button>
        </form>

        <div className={`config-status ${config.configured ? "ready" : ""}`}>
          {config.configured
            ? `Configurazione attiva: ${config.active_agent_id}`
            : "Inserisci API key e attiva almeno un agente."}
        </div>
      </div>

      <div className="workspace-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Agenti</p>
            <h2>Agent ID disponibili</h2>
          </div>
          <PhoneCall size={22} />
        </div>

        <form className="agent-create-form" onSubmit={handleCreateAgent}>
          <input
            disabled={isCreatingAgent}
            placeholder="Nome agente"
            value={newAgentName}
            onChange={(event) => setNewAgentName(event.target.value)}
          />
          <input
            disabled={isCreatingAgent}
            placeholder="agent_..."
            value={newAgentId}
            onChange={(event) => setNewAgentId(event.target.value)}
          />
          <button
            className="pdf-upload-button"
            disabled={isCreatingAgent || !newAgentName.trim() || !newAgentId.trim()}
            type="submit"
          >
            {isCreatingAgent ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
            Aggiungi
          </button>
        </form>

        <div className="agent-config-list">
          {config.agents.length === 0 ? (
            <p className="muted">Nessun agent_id salvato.</p>
          ) : (
            config.agents.map((agent) => (
              <AgentConfigCard
                agent={agent}
                key={agent.id}
                onActivate={onActivateAgent}
                onDelete={onDeleteAgent}
                onSetError={onSetError}
                onUpdate={onUpdateAgent}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function AgentConfigCard({
  agent,
  onActivate,
  onDelete,
  onSetError,
  onUpdate,
}: {
  agent: ElevenLabsAgent;
  onActivate: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onSetError: (value: string | null) => void;
  onUpdate: (id: number, input: ElevenLabsAgentInput) => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [agentId, setAgentId] = useState(agent.agent_id);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    setName(agent.name);
    setAgentId(agent.agent_id);
  }, [agent.agent_id, agent.name]);

  const handleUpdate = async () => {
    setIsBusy(true);
    try {
      await onUpdate(agent.id, { name: name.trim(), agent_id: agentId.trim() });
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Aggiornamento agente fallito");
    } finally {
      setIsBusy(false);
    }
  };

  const handleActivate = async () => {
    setIsBusy(true);
    try {
      await onActivate(agent.id);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Attivazione agente fallita");
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async () => {
    setIsBusy(true);
    try {
      await onDelete(agent.id);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Eliminazione agente fallita");
      setIsBusy(false);
    }
  };

  return (
    <article className={`agent-config-card ${agent.is_active ? "active" : ""}`}>
      <label className="agent-active-choice">
        <input
          checked={agent.is_active}
          disabled={isBusy}
          name="active-agent"
          type="radio"
          onChange={handleActivate}
        />
        <span>{agent.is_active ? "Attivo" : "Usa questo agente"}</span>
      </label>
      <div className="agent-config-fields">
        <input
          disabled={isBusy}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          disabled={isBusy}
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
        />
      </div>
      <div className="agent-config-actions">
        <button
          className="small-button"
          disabled={isBusy || !name.trim() || !agentId.trim()}
          type="button"
          onClick={handleUpdate}
        >
          {isBusy ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
          Aggiorna
        </button>
        {!agent.is_active && (
          <button className="small-button" disabled={isBusy} type="button" onClick={handleActivate}>
            <Check size={15} />
            Attiva
          </button>
        )}
        <button className="small-button danger" disabled={isBusy} type="button" onClick={handleDelete}>
          <Trash2 size={15} />
          Elimina
        </button>
      </div>
    </article>
  );
}

function VoicePanel({
  agentId,
  agentName,
  callScenario,
  contextMode = "centralino",
  elevenLabsConfig,
  onBeforeStart,
  onCallScenarioChange,
  onSetError,
  onVoiceContextChange,
  retrievalQuery,
  selectedVectorSource,
  showScenario = true,
  startButtonLabel = "Avvia voce",
  startPrompt,
  title = "Sessione agente",
}: {
  agentId?: string | null;
  agentName?: string | null;
  callScenario: CallScenario;
  contextMode?: "centralino" | "presentazione";
  elevenLabsConfig: ElevenLabsConfig;
  onBeforeStart?: () => void;
  onCallScenarioChange: (value: CallScenario) => void;
  onSetError: (value: string | null) => void;
  onVoiceContextChange: (value: VoiceContext | null) => void;
  retrievalQuery: RetrievalQuery | null;
  selectedVectorSource: string | null;
  showScenario?: boolean;
  startButtonLabel?: string;
  startPrompt?: string;
  title?: string;
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
  const hasSentStartPromptRef = useRef(false);
  const lastContextUpdateRef = useRef("");
  const lastRetrievalIdRef = useRef<number | null>(null);
  const isConnected = status === "connected";
  const activeAgent = elevenLabsConfig.agents.find((agent) => agent.is_active);
  const effectiveAgentId = agentId || activeAgent?.agent_id || null;
  const effectiveAgentName = agentName || activeAgent?.name || "non configurato";
  const isAgentConfigured = Boolean(elevenLabsConfig.api_key && effectiveAgentId);

  useEffect(() => {
    if (!isConnected) {
      hasSentContextRef.current = false;
      hasSentStartPromptRef.current = false;
      lastContextUpdateRef.current = "";
      return;
    }

    const contextUpdate =
      contextMode === "presentazione"
        ? buildPresentationContextUpdate(selectedVectorSource)
        : connectionMode === "webrtc"
        ? buildRealtimeContextUpdate(callScenario, selectedVectorSource)
        : buildContextUpdate(selectedVectorSource, callScenario);

    if (!hasSentContextRef.current || lastContextUpdateRef.current !== contextUpdate) {
      if (connectionMode === "webrtc") {
        const timeoutId = window.setTimeout(() => {
          sendContextualUpdate(contextUpdate);
          hasSentContextRef.current = true;
          lastContextUpdateRef.current = contextUpdate;
        }, 800);

        return () => window.clearTimeout(timeoutId);
      }

      sendContextualUpdate(contextUpdate);
      hasSentContextRef.current = true;
      lastContextUpdateRef.current = contextUpdate;
    }
  }, [
    callScenario,
    connectionMode,
    contextMode,
    isConnected,
    selectedVectorSource,
    sendContextualUpdate,
  ]);

  useEffect(() => {
    if (!isConnected || !startPrompt || hasSentStartPromptRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      sendUserMessage(startPrompt);
      hasSentStartPromptRef.current = true;
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [isConnected, sendUserMessage, startPrompt]);

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
    if (
      !isConnected ||
      connectionMode === "webrtc" ||
      !retrievalQuery ||
      lastRetrievalIdRef.current === retrievalQuery.id
    ) {
      return;
    }

    lastRetrievalIdRef.current = retrievalQuery.id;
    searchVectorStore(retrievalQuery.text, 4, selectedVectorSource)
      .then((response) => {
        const update = buildRetrievalUpdate(retrievalQuery.text, response.results);
        if (update) {
          sendContextualUpdate(update);
        }
      })
      .catch((err: unknown) => {
        console.warn("Vector retrieval failed", err);
      });
  }, [connectionMode, isConnected, retrievalQuery, selectedVectorSource, sendContextualUpdate]);

  const handleStart = async () => {
    if (!isAgentConfigured) {
      onSetError("Configura API key ElevenLabs e seleziona un agent_id.");
      return;
    }

    setIsStarting(true);
    try {
      onBeforeStart?.();
      onVoiceContextChange(contextMode);
      onSetError(null);
      if (connectionMode === "webrtc") {
        const response = await getConversationToken(effectiveAgentId);
        await startSession({
          conversationToken: response.token,
          connectionType: "webrtc",
          textOnly: false,
        });
      } else {
        const response = await getSignedUrl(effectiveAgentId);
        await startSession({
          signedUrl: response.signed_url,
          connectionType: "websocket",
          textOnly: false,
        });
      }
    } catch (err) {
      onVoiceContextChange(null);
      onSetError(err instanceof Error ? err.message : "Avvio sessione fallito");
    } finally {
      setIsStarting(false);
    }
  };

  const handleEnd = () => {
    onVoiceContextChange(null);
    endSession();
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
          <h2>{title}</h2>
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
      <div className="voice-stats compact">
        <span>Agente: {effectiveAgentName}</span>
      </div>

      <div className="input-meter" aria-label="Livello microfono">
        <span style={{ width: `${Math.min(100, Math.round(inputVolume * 100))}%` }} />
      </div>

      {showScenario && (
        <div className="voice-control-group">
          <span>Scenario</span>
          <div className="transport-toggle scenario-toggle">
            <button
              className={callScenario === "inbound" ? "active" : ""}
              type="button"
              onClick={() => onCallScenarioChange("inbound")}
            >
              Entrata
            </button>
            <button
              className={callScenario === "outbound" ? "active" : ""}
              type="button"
              onClick={() => onCallScenarioChange("outbound")}
            >
              Uscita
            </button>
          </div>
        </div>
      )}

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
        <button className="action-button danger" type="button" onClick={handleEnd}>
          <Square size={18} />
          Termina
        </button>
      ) : (
        <button
          className="action-button"
          disabled={isStarting || !isAgentConfigured}
          type="button"
          onClick={handleStart}
        >
          {isStarting ? <Loader2 className="spin" size={18} /> : <Mic size={18} />}
          {startButtonLabel}
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
