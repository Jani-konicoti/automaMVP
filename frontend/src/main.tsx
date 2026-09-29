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
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOutgoing,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import {
  Appointment,
  AppointmentInput,
  ElevenLabsAgent,
  ElevenLabsAgentInput,
  ElevenLabsConfig,
  ElevenLabsDefaults,
  ElevenLabsPhoneNumber,
  OutboundCall,
  OutboundContact,
  OutboundContactInput,
  VectorSearchResult,
  VectorStoreSource,
  VectorStoreStats,
  createAppointment,
  createElevenLabsAgent,
  createOutboundContact,
  deleteAllAppointments,
  deleteElevenLabsAgent,
  deleteOutboundContact,
  getConversationToken,
  getElevenLabsConfig,
  getSignedUrl,
  getVectorStoreSources,
  getVectorStoreStats,
  listAppointments,
  listElevenLabsPhoneNumbers,
  listOutboundCalls,
  listOutboundContacts,
  saveElevenLabsConfig,
  saveElevenLabsDefaults,
  saveElevenLabsIntegration,
  saveFlowSource,
  searchVectorStore,
  startOutboundCall,
  updateElevenLabsAgent,
  updateOutboundContact,
  uploadVectorStorePdf,
} from "./api";
import "./styles.css";

type RetrievalQuery = {
  id: number;
  text: string;
};

type AppView = "demo" | "config";
type MainTab = "centralino-entrata" | "centralino-uscita" | "presentazione";
type VoiceContext = MainTab;

function preferredAgentId(agents: ElevenLabsAgent[], pattern: RegExp) {
  return agents.find((agent) => pattern.test(agent.name))?.agent_id ?? agents[0]?.agent_id ?? null;
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

function buildContextUpdate(selectedVectorSource: string | null) {
  const sourceInstruction = selectedVectorSource
    ? `Fonte PDF attiva per il vector store: ${selectedVectorSource}. Quando cerchi nella documentazione PDF usa solo questa fonte.`
    : "Fonte PDF attiva per il vector store: tutte le fonti caricate.";

  return `
Contesto operativo per questa conversazione.
Rispondi in italiano, in modo naturale, breve e professionale.
Usa la documentazione per rispondere a domande su servizi, orari, regole, prezzi o procedure.
Se la documentazione non contiene la risposta, dillo con chiarezza e proponi di lasciare un appuntamento o un recapito.
Per domande sulla documentazione, sui PDF caricati o su argomenti specifici come detassazione, reddito presunto, rinnovi contrattuali, maggiorazioni o mensilita, chiama prima il tool searchKnowledge con una query breve e specifica.
Non dire che non hai informazioni prima di aver cercato con searchKnowledge.
${sourceInstruction}
`.trim();
}

function buildRealtimeContextUpdate(selectedVectorSource: string | null) {
  return `
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
  const [elevenLabsConfig, setElevenLabsConfig] = useState<ElevenLabsConfig>({
    api_key: "",
    agents: [],
    active_agent_id: null,
    inbound_agent_id: null,
    outbound_agent_id: null,
    presentation_agent_id: null,
    inbound_source: null,
    outbound_source: null,
    presentation_source: null,
    public_base_url: "",
    tool_webhook_secret: "",
    post_call_webhook_secret: "",
    configured: false,
  });
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [outboundContacts, setOutboundContacts] = useState<OutboundContact[]>([]);
  const [outboundCalls, setOutboundCalls] = useState<OutboundCall[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<ElevenLabsPhoneNumber[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [presentationTranscript, setPresentationTranscript] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pdfMode, setPdfMode] = useState<"append" | "replace">("append");
  const [vectorStats, setVectorStats] = useState<VectorStoreStats>({
    chunks: 0,
    sources: 0,
  });
  const [vectorSources, setVectorSources] = useState<VectorStoreSource[]>([]);
  const [inboundVectorSource, setInboundVectorSource] = useState<string | null>(null);
  const [outboundVectorSource, setOutboundVectorSource] = useState<string | null>(null);
  const [presentationVectorSource, setPresentationVectorSource] = useState<string | null>(null);
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

  const handleDeleteAllAppointments = useCallback(async () => {
    setError(null);
    await deleteAllAppointments();
    setAppointments([]);
  }, []);

  const refreshOutboundContacts = useCallback(async () => {
    const contacts = await listOutboundContacts();
    setOutboundContacts(contacts);
  }, []);

  const refreshOutboundCalls = useCallback(async () => {
    const calls = await listOutboundCalls();
    setOutboundCalls(calls);
  }, []);

  const refreshPhoneNumbers = useCallback(async () => {
    const numbers = await listElevenLabsPhoneNumbers();
    setPhoneNumbers(numbers);
  }, []);

  const handleCreateOutboundContact = useCallback(
    async (input: OutboundContactInput) => {
      setError(null);
      await createOutboundContact(input);
      await refreshOutboundContacts();
    },
    [refreshOutboundContacts],
  );

  const handleUpdateOutboundContact = useCallback(
    async (id: number, input: OutboundContactInput) => {
      setError(null);
      await updateOutboundContact(id, input);
      await refreshOutboundContacts();
    },
    [refreshOutboundContacts],
  );

  const handleDeleteOutboundContact = useCallback(
    async (id: number) => {
      setError(null);
      await deleteOutboundContact(id);
      await refreshOutboundContacts();
    },
    [refreshOutboundContacts],
  );

  useEffect(() => {
    Promise.all([
      getElevenLabsConfig(),
      listAppointments(),
      getVectorStoreStats(),
      getVectorStoreSources(),
      listOutboundContacts(),
      listOutboundCalls(),
    ])
      .then(([configResponse, appointmentRows, stats, sources, contacts, calls]) => {
        setElevenLabsConfig(configResponse);
        setAppointments(appointmentRows);
        setVectorStats(stats);
        setVectorSources(sources);
        setOutboundContacts(contacts);
        setOutboundCalls(calls);
        const sourceExists = (source?: string | null) =>
          Boolean(source && sources.some((item) => item.source === source));
        setInboundVectorSource(
          sourceExists(configResponse.inbound_source) ? configResponse.inbound_source! : null,
        );
        setOutboundVectorSource(
          sourceExists(configResponse.outbound_source) ? configResponse.outbound_source! : null,
        );
        setPresentationVectorSource(
          sourceExists(configResponse.presentation_source)
            ? configResponse.presentation_source!
            : null,
        );
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Errore di inizializzazione");
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    if (!elevenLabsConfig.api_key) {
      setPhoneNumbers([]);
      return;
    }
    refreshPhoneNumbers().catch((err: unknown) => {
      setMessages((current) => [
        `numeri Twilio: ${err instanceof Error ? err.message : "caricamento fallito"}`,
        ...current,
      ].slice(0, 12));
    });
  }, [elevenLabsConfig.api_key, refreshPhoneNumbers]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      Promise.all([refreshAppointments(), refreshOutboundCalls()]).catch(() => {
        // A transient polling failure is surfaced by the next explicit action.
      });
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [refreshAppointments, refreshOutboundCalls]);

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

  const handleSaveElevenLabsDefaults = useCallback(async (defaults: ElevenLabsDefaults) => {
    setError(null);
    const config = await saveElevenLabsDefaults(defaults);
    setElevenLabsConfig(config);
  }, []);

  const handleSaveElevenLabsIntegration = useCallback(
    async (publicBaseUrl: string, postCallWebhookSecret: string) => {
      setError(null);
      const config = await saveElevenLabsIntegration({
        public_base_url: publicBaseUrl,
        post_call_webhook_secret: postCallWebhookSecret,
      });
      setElevenLabsConfig(config);
    },
    [],
  );

  const persistFlowSource = useCallback(
    async (
      flow: MainTab,
      source: string | null,
      setter: (value: string | null) => void,
    ) => {
      setter(source);
      try {
        const config = await saveFlowSource(flow, source);
        setElevenLabsConfig(config);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Salvataggio fonte fallito");
      }
    },
    [],
  );

  const handleStartOutboundCall = useCallback(
    async (
      contactId: number,
      agentId: string,
      phoneNumberId: string,
      source: string | null,
    ) => {
      setError(null);
      const call = await startOutboundCall({
        contact_id: contactId,
        agent_id: agentId,
        agent_phone_number_id: phoneNumberId,
        source,
      });
      setOutboundCalls((current) => [call, ...current.filter((item) => item.id !== call.id)]);
    },
    [],
  );

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

  const handleDeleteElevenLabsAgent = useCallback(async (id: number) => {
    setError(null);
    const config = await deleteElevenLabsAgent(id);
    setElevenLabsConfig(config);
  }, []);

  useEffect(() => {
    if (
      inboundVectorSource &&
      !vectorSources.some((source) => source.source === inboundVectorSource)
    ) {
      setInboundVectorSource(null);
    }
    if (
      outboundVectorSource &&
      !vectorSources.some((source) => source.source === outboundVectorSource)
    ) {
      setOutboundVectorSource(null);
    }
    if (
      presentationVectorSource &&
      !vectorSources.some((source) => source.source === presentationVectorSource)
    ) {
      setPresentationVectorSource(null);
    }
  }, [inboundVectorSource, outboundVectorSource, presentationVectorSource, vectorSources]);

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
        setInboundVectorSource(lastResponse.source);
        setOutboundVectorSource(lastResponse.source);
        setPresentationVectorSource(lastResponse.source);
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
      const selectedSource =
        activeVoiceContextRef.current === "presentazione"
          ? presentationVectorSource
          : activeVoiceContextRef.current === "centralino-uscita"
            ? outboundVectorSource
            : inboundVectorSource;
      const response = await searchVectorStore(query, limit, selectedSource);
      setMessages((current) =>
        [
          `tool searchKnowledge: "${query}"${
            selectedSource ? ` [${selectedSource}]` : ""
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
    [inboundVectorSource, outboundVectorSource, presentationVectorSource],
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
        outboundCalls={outboundCalls}
        outboundContacts={outboundContacts}
        phoneNumbers={phoneNumbers}
        error={error}
        isLoading={isLoading}
        elevenLabsConfig={elevenLabsConfig}
        messages={messages}
        presentationTranscript={presentationTranscript}
        onAppViewChange={setAppView}
        onClearPresentationTranscript={handleClearPresentationTranscript}
        onCreateElevenLabsAgent={handleCreateElevenLabsAgent}
        onCreateOutboundContact={handleCreateOutboundContact}
        onDeleteAllAppointments={handleDeleteAllAppointments}
        onDeleteElevenLabsAgent={handleDeleteElevenLabsAgent}
        onDeleteOutboundContact={handleDeleteOutboundContact}
        onSaveElevenLabsApiKey={handleSaveElevenLabsApiKey}
        onSaveElevenLabsDefaults={handleSaveElevenLabsDefaults}
        onSaveElevenLabsIntegration={handleSaveElevenLabsIntegration}
        onStartOutboundCall={handleStartOutboundCall}
        onRefreshOutboundCalls={refreshOutboundCalls}
        onRefreshPhoneNumbers={refreshPhoneNumbers}
        onUpdateElevenLabsAgent={handleUpdateElevenLabsAgent}
        onUpdateOutboundContact={handleUpdateOutboundContact}
        onPdfModeChange={setPdfMode}
        onVectorPdfUpload={handleVectorPdfUpload}
        onInboundVectorSourceChange={(source) =>
          void persistFlowSource("centralino-entrata", source, setInboundVectorSource)
        }
        onOutboundVectorSourceChange={(source) =>
          void persistFlowSource("centralino-uscita", source, setOutboundVectorSource)
        }
        onPresentationVectorSourceChange={(source) =>
          void persistFlowSource("presentazione", source, setPresentationVectorSource)
        }
        onSetError={setError}
        onVoiceContextChange={handleVoiceContextChange}
        pdfMode={pdfMode}
        isIndexingPdf={isIndexingPdf}
        vectorStats={vectorStats}
        vectorStatus={vectorStatus}
        vectorSources={vectorSources}
        inboundVectorSource={inboundVectorSource}
        outboundVectorSource={outboundVectorSource}
        presentationVectorSource={presentationVectorSource}
        retrievalQuery={retrievalQuery}
      />
    </ConversationProvider>
  );
}

type ShellProps = {
  appView: AppView;
  appointments: Appointment[];
  outboundCalls: OutboundCall[];
  outboundContacts: OutboundContact[];
  phoneNumbers: ElevenLabsPhoneNumber[];
  elevenLabsConfig: ElevenLabsConfig;
  error: string | null;
  isLoading: boolean;
  isIndexingPdf: boolean;
  messages: string[];
  presentationTranscript: string[];
  pdfMode: "append" | "replace";
  vectorStats: VectorStoreStats;
  vectorStatus: string | null;
  vectorSources: VectorStoreSource[];
  inboundVectorSource: string | null;
  outboundVectorSource: string | null;
  presentationVectorSource: string | null;
  retrievalQuery: RetrievalQuery | null;
  onAppViewChange: (value: AppView) => void;
  onClearPresentationTranscript: () => void;
  onCreateElevenLabsAgent: (input: ElevenLabsAgentInput) => Promise<void>;
  onCreateOutboundContact: (input: OutboundContactInput) => Promise<void>;
  onDeleteAllAppointments: () => Promise<void>;
  onDeleteElevenLabsAgent: (id: number) => Promise<void>;
  onDeleteOutboundContact: (id: number) => Promise<void>;
  onPdfModeChange: (value: "append" | "replace") => void;
  onSaveElevenLabsApiKey: (apiKey: string) => Promise<void>;
  onSaveElevenLabsDefaults: (defaults: ElevenLabsDefaults) => Promise<void>;
  onSaveElevenLabsIntegration: (
    publicBaseUrl: string,
    postCallWebhookSecret: string,
  ) => Promise<void>;
  onStartOutboundCall: (
    contactId: number,
    agentId: string,
    phoneNumberId: string,
    source: string | null,
  ) => Promise<void>;
  onRefreshOutboundCalls: () => Promise<void>;
  onRefreshPhoneNumbers: () => Promise<void>;
  onUpdateElevenLabsAgent: (id: number, input: ElevenLabsAgentInput) => Promise<void>;
  onUpdateOutboundContact: (id: number, input: OutboundContactInput) => Promise<void>;
  onVectorPdfUpload: (files: File[]) => Promise<void>;
  onInboundVectorSourceChange: (source: string | null) => void;
  onOutboundVectorSourceChange: (source: string | null) => void;
  onPresentationVectorSourceChange: (source: string | null) => void;
  onVoiceContextChange: (value: VoiceContext | null) => void;
  onSetError: (value: string | null) => void;
};

function Shell({
  appView,
  appointments,
  outboundCalls,
  outboundContacts,
  phoneNumbers,
  elevenLabsConfig,
  error,
  isLoading,
  isIndexingPdf,
  messages,
  presentationTranscript,
  pdfMode,
  vectorStats,
  vectorStatus,
  vectorSources,
  inboundVectorSource,
  outboundVectorSource,
  presentationVectorSource,
  retrievalQuery,
  onAppViewChange,
  onClearPresentationTranscript,
  onCreateElevenLabsAgent,
  onCreateOutboundContact,
  onDeleteAllAppointments,
  onDeleteElevenLabsAgent,
  onDeleteOutboundContact,
  onPdfModeChange,
  onSaveElevenLabsApiKey,
  onSaveElevenLabsDefaults,
  onSaveElevenLabsIntegration,
  onStartOutboundCall,
  onRefreshOutboundCalls,
  onRefreshPhoneNumbers,
  onUpdateElevenLabsAgent,
  onUpdateOutboundContact,
  onVectorPdfUpload,
  onInboundVectorSourceChange,
  onOutboundVectorSourceChange,
  onPresentationVectorSourceChange,
  onVoiceContextChange,
  onSetError,
}: ShellProps) {
  const [mainTab, setMainTab] = useState<MainTab>("centralino-entrata");
  const [inboundAgentId, setInboundAgentId] = useState<string | null>(null);
  const [outboundAgentId, setOutboundAgentId] = useState<string | null>(null);
  const [presentationAgentId, setPresentationAgentId] = useState<string | null>(null);

  useEffect(() => {
    const hasAgent = (agentId: string | null) =>
      Boolean(agentId && elevenLabsConfig.agents.some((agent) => agent.agent_id === agentId));

    setInboundAgentId((current) =>
      hasAgent(elevenLabsConfig.inbound_agent_id ?? null)
        ? elevenLabsConfig.inbound_agent_id ?? null
        : hasAgent(current)
          ? current
          : preferredAgentId(elevenLabsConfig.agents, /entrata|inbound|ricev/i),
    );
    setOutboundAgentId((current) =>
      hasAgent(elevenLabsConfig.outbound_agent_id ?? null)
        ? elevenLabsConfig.outbound_agent_id ?? null
        : hasAgent(current)
          ? current
          : preferredAgentId(elevenLabsConfig.agents, /uscita|outbound|chiam/i),
    );
    setPresentationAgentId((current) =>
      hasAgent(elevenLabsConfig.presentation_agent_id ?? null)
        ? elevenLabsConfig.presentation_agent_id ?? null
        : hasAgent(current)
          ? current
          : preferredAgentId(elevenLabsConfig.agents, /present/i),
    );
  }, [
    elevenLabsConfig.agents,
    elevenLabsConfig.inbound_agent_id,
    elevenLabsConfig.outbound_agent_id,
    elevenLabsConfig.presentation_agent_id,
  ]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Automazione vocale</p>
          <h1>JK Automa</h1>
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
          onCreateAgent={onCreateElevenLabsAgent}
          onDeleteAgent={onDeleteElevenLabsAgent}
          onSaveApiKey={onSaveElevenLabsApiKey}
          onSaveDefaults={onSaveElevenLabsDefaults}
          onSaveIntegration={onSaveElevenLabsIntegration}
          onSetError={onSetError}
          onUpdateAgent={onUpdateElevenLabsAgent}
        />
      ) : (
        <section className="main-workspace">
          <div className="section-tabs">
            <button
              className={mainTab === "centralino-entrata" ? "active" : ""}
              type="button"
              onClick={() => setMainTab("centralino-entrata")}
            >
              Centralino Entrata
            </button>
            <button
              className={mainTab === "centralino-uscita" ? "active" : ""}
              type="button"
              onClick={() => setMainTab("centralino-uscita")}
            >
              Centralino Uscita
            </button>
            <button
              className={mainTab === "presentazione" ? "active" : ""}
              type="button"
              onClick={() => setMainTab("presentazione")}
            >
              Presentazione
            </button>
          </div>

          {mainTab === "centralino-entrata" ? (
            <CentralinoPage
              agentId={inboundAgentId}
              appointments={appointments}
              elevenLabsConfig={elevenLabsConfig}
              flow="centralino-entrata"
              isIndexingPdf={isIndexingPdf}
              messages={messages}
              onAgentChange={setInboundAgentId}
              onPdfModeChange={onPdfModeChange}
              onDeleteAllAppointments={onDeleteAllAppointments}
              onSetError={onSetError}
              onVectorPdfUpload={onVectorPdfUpload}
              onVectorSourceChange={onInboundVectorSourceChange}
              onVoiceContextChange={onVoiceContextChange}
              pdfMode={pdfMode}
              retrievalQuery={retrievalQuery}
              selectedVectorSource={inboundVectorSource}
              title="Centralino Entrata"
              vectorSources={vectorSources}
              vectorStats={vectorStats}
              vectorStatus={vectorStatus}
            />
          ) : mainTab === "centralino-uscita" ? (
            <CentralinoPage
              agentId={outboundAgentId}
              appointments={appointments}
              contacts={outboundContacts}
              outboundCalls={outboundCalls}
              phoneNumbers={phoneNumbers}
              elevenLabsConfig={elevenLabsConfig}
              flow="centralino-uscita"
              isIndexingPdf={isIndexingPdf}
              messages={messages}
              onAgentChange={setOutboundAgentId}
              onCreateContact={onCreateOutboundContact}
              onDeleteAllAppointments={onDeleteAllAppointments}
              onDeleteContact={onDeleteOutboundContact}
              onPdfModeChange={onPdfModeChange}
              onSetError={onSetError}
              onStartOutboundCall={onStartOutboundCall}
              onRefreshOutboundCalls={onRefreshOutboundCalls}
              onRefreshPhoneNumbers={onRefreshPhoneNumbers}
              onVectorPdfUpload={onVectorPdfUpload}
              onVectorSourceChange={onOutboundVectorSourceChange}
              onVoiceContextChange={onVoiceContextChange}
              onUpdateContact={onUpdateOutboundContact}
              pdfMode={pdfMode}
              retrievalQuery={retrievalQuery}
              selectedVectorSource={outboundVectorSource}
              title="Centralino Uscita"
              vectorSources={vectorSources}
              vectorStats={vectorStats}
              vectorStatus={vectorStatus}
            />
          ) : (
            <PresentationPage
              agentId={presentationAgentId}
              elevenLabsConfig={elevenLabsConfig}
              onAgentChange={setPresentationAgentId}
              onSetError={onSetError}
              onVectorSourceChange={onPresentationVectorSourceChange}
              onVoiceContextChange={onVoiceContextChange}
              onClearTranscript={onClearPresentationTranscript}
              retrievalQuery={retrievalQuery}
              selectedVectorSource={presentationVectorSource}
              transcript={presentationTranscript}
              vectorSources={vectorSources}
            />
          )}
        </section>
      )}
    </main>
  );
}

function CentralinoPage({
  agentId,
  appointments,
  contacts = [],
  outboundCalls = [],
  phoneNumbers = [],
  elevenLabsConfig,
  flow,
  isIndexingPdf,
  messages,
  onAgentChange,
  onCreateContact,
  onPdfModeChange,
  onDeleteAllAppointments,
  onDeleteContact,
  onSetError,
  onStartOutboundCall,
  onRefreshOutboundCalls,
  onRefreshPhoneNumbers,
  onVectorPdfUpload,
  onVectorSourceChange,
  onVoiceContextChange,
  onUpdateContact,
  pdfMode,
  retrievalQuery,
  selectedVectorSource,
  title,
  vectorSources,
  vectorStats,
  vectorStatus,
}: {
  agentId: string | null;
  appointments: Appointment[];
  contacts?: OutboundContact[];
  outboundCalls?: OutboundCall[];
  phoneNumbers?: ElevenLabsPhoneNumber[];
  elevenLabsConfig: ElevenLabsConfig;
  flow: "centralino-entrata" | "centralino-uscita";
  isIndexingPdf: boolean;
  messages: string[];
  onAgentChange: (agentId: string | null) => void;
  onCreateContact?: (input: OutboundContactInput) => Promise<void>;
  onPdfModeChange: (value: "append" | "replace") => void;
  onDeleteAllAppointments: () => Promise<void>;
  onDeleteContact?: (id: number) => Promise<void>;
  onSetError: (value: string | null) => void;
  onStartOutboundCall?: (
    contactId: number,
    agentId: string,
    phoneNumberId: string,
    source: string | null,
  ) => Promise<void>;
  onRefreshOutboundCalls?: () => Promise<void>;
  onRefreshPhoneNumbers?: () => Promise<void>;
  onVectorPdfUpload: (files: File[]) => Promise<void>;
  onVectorSourceChange: (source: string | null) => void;
  onVoiceContextChange: (value: VoiceContext | null) => void;
  onUpdateContact?: (id: number, input: OutboundContactInput) => Promise<void>;
  pdfMode: "append" | "replace";
  retrievalQuery: RetrievalQuery | null;
  selectedVectorSource: string | null;
  title: string;
  vectorSources: VectorStoreSource[];
  vectorStats: VectorStoreStats;
  vectorStatus: string | null;
}) {
  const selectedAgent = elevenLabsConfig.agents.find(
    (agent) => agent.agent_id === agentId,
  );

  return (
    <div className="main-grid">
      <section className="workspace-panel setup-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Centralino</p>
            <h2>{title}</h2>
          </div>
          <PhoneCall size={22} />
        </div>

        <AgentSelector
          agents={elevenLabsConfig.agents}
          id={`${flow}-agent`}
          label="Agente centralino"
          selectedAgentId={agentId}
          onChange={onAgentChange}
        />

        <VectorPdfManager
          isIndexingPdf={isIndexingPdf}
          onPdfModeChange={onPdfModeChange}
          onVectorPdfUpload={onVectorPdfUpload}
          pdfMode={pdfMode}
          vectorStats={vectorStats}
          vectorStatus={vectorStatus}
        />
        <VectorSourceSelector
          allSourcesDescription="Il centralino cerca in tutti i PDF indicizzati."
          name={`${flow}-source`}
          onChange={onVectorSourceChange}
          selectedSource={selectedVectorSource}
          sources={vectorSources}
        />
      </section>

      <div className="right-column">
        <VoicePanel
          agentId={agentId}
          agentName={selectedAgent?.name}
          contextMode={flow}
          elevenLabsConfig={elevenLabsConfig}
          onSetError={onSetError}
          onVoiceContextChange={onVoiceContextChange}
          retrievalQuery={retrievalQuery}
          selectedVectorSource={selectedVectorSource}
          title={title}
        />
        {flow === "centralino-uscita" &&
          onCreateContact &&
          onDeleteContact &&
          onUpdateContact &&
          onStartOutboundCall &&
          onRefreshOutboundCalls &&
          onRefreshPhoneNumbers && (
            <OutboundContactsPanel
              agentId={agentId}
              contacts={contacts}
              calls={outboundCalls}
              onCreate={onCreateContact}
              onDelete={onDeleteContact}
              onRefreshCalls={onRefreshOutboundCalls}
              onRefreshPhoneNumbers={onRefreshPhoneNumbers}
              onSetError={onSetError}
              onStartCall={onStartOutboundCall}
              onUpdate={onUpdateContact}
              phoneNumbers={phoneNumbers}
              selectedSource={selectedVectorSource}
            />
          )}
        <AppointmentsPanel
          appointments={appointments}
          onDeleteAll={onDeleteAllAppointments}
          onSetError={onSetError}
        />
        <DebugPanel messages={messages} />
      </div>
    </div>
  );
}

function OutboundContactsPanel({
  agentId,
  calls,
  contacts,
  onCreate,
  onDelete,
  onRefreshCalls,
  onRefreshPhoneNumbers,
  onSetError,
  onStartCall,
  onUpdate,
  phoneNumbers,
  selectedSource,
}: {
  agentId: string | null;
  calls: OutboundCall[];
  contacts: OutboundContact[];
  onCreate: (input: OutboundContactInput) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onRefreshCalls: () => Promise<void>;
  onRefreshPhoneNumbers: () => Promise<void>;
  onSetError: (value: string | null) => void;
  onStartCall: (
    contactId: number,
    agentId: string,
    phoneNumberId: string,
    source: string | null,
  ) => Promise<void>;
  onUpdate: (id: number, input: OutboundContactInput) => Promise<void>;
  phoneNumbers: ElevenLabsPhoneNumber[];
  selectedSource: string | null;
}) {
  const [reference, setReference] = useState("");
  const [phone, setPhone] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedPhoneNumberId, setSelectedPhoneNumberId] = useState("");

  useEffect(() => {
    if (
      selectedPhoneNumberId &&
      phoneNumbers.some((number) => number.phone_number_id === selectedPhoneNumberId)
    ) {
      return;
    }
    setSelectedPhoneNumberId(phoneNumbers[0]?.phone_number_id ?? "");
  }, [phoneNumbers, selectedPhoneNumberId]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([onRefreshPhoneNumbers(), onRefreshCalls()]);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Aggiornamento chiamate fallito");
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = { reference: reference.trim(), phone: phone.trim() };
    if (!input.reference || !input.phone) {
      return;
    }

    setIsCreating(true);
    try {
      await onCreate(input);
      setReference("");
      setPhone("");
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Creazione contatto fallita");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <section className="workspace-panel contacts-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Chiamate in uscita</p>
          <h2>Anagrafica</h2>
        </div>
        <Users size={22} />
      </div>

      <form className="contact-create-form" onSubmit={handleCreate}>
        <input
          disabled={isCreating}
          placeholder="Riferimento"
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        <input
          disabled={isCreating}
          placeholder="Numero di telefono"
          type="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
        <button
          className="icon-button primary"
          disabled={isCreating || !reference.trim() || !phone.trim()}
          title="Aggiungi contatto"
          type="submit"
        >
          {isCreating ? <Loader2 className="spin" size={17} /> : <Plus size={17} />}
        </button>
      </form>

      <div className="outbound-toolbar">
        <label>
          <span>Numero chiamante</span>
          <select
            className="config-select"
            value={selectedPhoneNumberId}
            onChange={(event) => setSelectedPhoneNumberId(event.target.value)}
          >
            {phoneNumbers.length === 0 ? (
              <option value="">Nessun numero Twilio disponibile</option>
            ) : (
              phoneNumbers.map((number) => (
                <option key={number.phone_number_id} value={number.phone_number_id}>
                  {number.label} ({number.phone_number})
                </option>
              ))
            )}
          </select>
        </label>
        <button
          className="icon-button contact-icon-button"
          disabled={isRefreshing}
          title="Aggiorna numeri e chiamate"
          type="button"
          onClick={handleRefresh}
        >
          <RefreshCw className={isRefreshing ? "spin" : ""} size={16} />
        </button>
      </div>

      <div className="contacts-list">
        {contacts.length === 0 ? (
          <p className="muted">Nessun contatto inserito.</p>
        ) : (
          contacts.map((contact) => (
            <OutboundContactRow
              contact={contact}
              key={contact.id}
              canCall={Boolean(agentId && selectedPhoneNumberId)}
              onDelete={onDelete}
              onCall={() => {
                if (!agentId || !selectedPhoneNumberId) {
                  return Promise.resolve();
                }
                return onStartCall(
                  contact.id,
                  agentId,
                  selectedPhoneNumberId,
                  selectedSource,
                );
              }}
              onSetError={onSetError}
              onUpdate={onUpdate}
            />
          ))
        )}
      </div>


      <div className="call-history-heading">
        <h3>Chiamate recenti</h3>
        <span>{calls.length}</span>
      </div>
      <div className="call-history-list">
        {calls.length === 0 ? (
          <p className="muted">Nessuna chiamata avviata.</p>
        ) : (
          calls.map((call) => <OutboundCallRow call={call} key={call.id} />)
        )}
      </div>
    </section>
  );
}

function OutboundContactRow({
  canCall,
  contact,
  onCall,
  onDelete,
  onSetError,
  onUpdate,
}: {
  canCall: boolean;
  contact: OutboundContact;
  onCall: () => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onSetError: (value: string | null) => void;
  onUpdate: (id: number, input: OutboundContactInput) => Promise<void>;
}) {
  const [reference, setReference] = useState(contact.reference);
  const [phone, setPhone] = useState(contact.phone);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    setReference(contact.reference);
    setPhone(contact.phone);
  }, [contact.phone, contact.reference]);

  const handleUpdate = async () => {
    setIsBusy(true);
    try {
      await onUpdate(contact.id, { reference: reference.trim(), phone: phone.trim() });
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Aggiornamento contatto fallito");
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Eliminare il contatto ${contact.reference}?`)) {
      return;
    }

    setIsBusy(true);
    try {
      await onDelete(contact.id);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Eliminazione contatto fallita");
      setIsBusy(false);
    }
  };

  const handleCall = async () => {
    setIsBusy(true);
    try {
      await onCall();
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Avvio chiamata fallito");
    } finally {
      setIsBusy(false);
    }
  };

  const isUnchanged = reference === contact.reference && phone === contact.phone;

  return (
    <article className="contact-row">
      <input
        aria-label="Riferimento"
        disabled={isBusy}
        value={reference}
        onChange={(event) => setReference(event.target.value)}
      />
      <input
        aria-label="Numero di telefono"
        disabled={isBusy}
        type="tel"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
      />
      <div className="contact-actions">
        <button
          className="icon-button contact-icon-button call"
          disabled={isBusy || !canCall}
          title="Chiama contatto"
          type="button"
          onClick={handleCall}
        >
          {isBusy ? <Loader2 className="spin" size={16} /> : <PhoneOutgoing size={16} />}
        </button>
        <button
          className="icon-button contact-icon-button"
          disabled={isBusy || isUnchanged || !reference.trim() || !phone.trim()}
          title="Salva modifiche"
          type="button"
          onClick={handleUpdate}
        >
          {isBusy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
        </button>
        <button
          className="icon-button contact-icon-button danger"
          disabled={isBusy}
          title="Elimina contatto"
          type="button"
          onClick={handleDelete}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}


function OutboundCallRow({ call }: { call: OutboundCall }) {
  const createdAt = new Date(call.created_at).toLocaleString("it-IT");
  return (
    <article className="call-history-row">
      <div className="call-history-meta">
        <strong>{call.reference}</strong>
        <span className={`call-status ${call.status}`}>{call.status}</span>
      </div>
      <div className="call-history-details">
        <span>{call.phone}</span>
        <span>{createdAt}</span>
      </div>
      {call.source && <small>Fonte: {call.source}</small>}
      {call.error && <p className="call-error">{call.error}</p>}
      {call.transcript && (
        <details>
          <summary>Trascrizione</summary>
          <pre>{call.transcript}</pre>
        </details>
      )}
    </article>
  );
}

function AgentSelector({
  agents,
  id,
  label,
  onChange,
  selectedAgentId,
}: {
  agents: ElevenLabsAgent[];
  id: string;
  label: string;
  onChange: (agentId: string | null) => void;
  selectedAgentId: string | null;
}) {
  return (
    <>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select
        className="config-select"
        id={id}
        value={selectedAgentId ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        {agents.length === 0 ? (
          <option value="">Nessun agente configurato</option>
        ) : (
          agents.map((agent) => (
            <option key={agent.id} value={agent.agent_id}>
              {agent.name}
            </option>
          ))
        )}
      </select>
    </>
  );
}

function VectorPdfManager({
  isIndexingPdf,
  onPdfModeChange,
  onVectorPdfUpload,
  pdfMode,
  vectorStats,
  vectorStatus,
}: {
  isIndexingPdf: boolean;
  onPdfModeChange: (value: "append" | "replace") => void;
  onVectorPdfUpload: (files: File[]) => Promise<void>;
  pdfMode: "append" | "replace";
  vectorStats: VectorStoreStats;
  vectorStatus: string | null;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <label className="field-label">Vector PDF</label>
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
          ref={fileInputRef}
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
          onClick={() => fileInputRef.current?.click()}
        >
          {isIndexingPdf ? <Loader2 className="spin" size={16} /> : <Database size={16} />}
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
    </>
  );
}

function VectorSourceSelector({
  allSourcesDescription,
  name,
  onChange,
  selectedSource,
  sources,
}: {
  allSourcesDescription: string;
  name: string;
  onChange: (source: string | null) => void;
  selectedSource: string | null;
  sources: VectorStoreSource[];
}) {
  return (
    <div className="vector-sources">
      <label className="vector-source-option all-sources">
        <input
          checked={selectedSource === null}
          name={name}
          type="radio"
          onChange={() => onChange(null)}
        />
        <span>
          <strong>Tutte le fonti</strong>
          <small>{allSourcesDescription}</small>
        </span>
      </label>
      {sources.map((source) => (
        <label className="vector-source-option" key={source.source}>
          <input
            checked={selectedSource === source.source}
            name={name}
            type="radio"
            onChange={() => onChange(source.source)}
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
  );
}

function PresentationPage({
  agentId,
  elevenLabsConfig,
  onAgentChange,
  onClearTranscript,
  onSetError,
  onVectorSourceChange,
  onVoiceContextChange,
  retrievalQuery,
  selectedVectorSource,
  transcript,
  vectorSources,
}: {
  agentId: string | null;
  elevenLabsConfig: ElevenLabsConfig;
  onAgentChange: (agentId: string | null) => void;
  onClearTranscript: () => void;
  onSetError: (value: string | null) => void;
  onVectorSourceChange: (source: string | null) => void;
  onVoiceContextChange: (value: VoiceContext | null) => void;
  retrievalQuery: RetrievalQuery | null;
  selectedVectorSource: string | null;
  transcript: string[];
  vectorSources: VectorStoreSource[];
}) {
  const selectedAgent = elevenLabsConfig.agents.find(
    (agent) => agent.agent_id === agentId,
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

        <AgentSelector
          agents={elevenLabsConfig.agents}
          id="presentation-agent"
          label="Agente presentazione"
          onChange={onAgentChange}
          selectedAgentId={agentId}
        />

        <label className="field-label">Fonte PDF da presentare</label>
        <VectorSourceSelector
          allSourcesDescription="L'agente prepara una presentazione usando tutti i PDF indicizzati."
          name="presentation-source"
          onChange={onVectorSourceChange}
          selectedSource={selectedVectorSource}
          sources={vectorSources}
        />

        <div className="presentation-summary">
          <strong>Pronto per presentare</strong>
          <span>Agente: {selectedAgent?.name || "non configurato"}</span>
          <span>Fonte: {selectedSource?.source || "tutte le fonti"}</span>
        </div>
      </section>

      <div className="right-column">
        <VoicePanel
          agentId={agentId}
          agentName={selectedAgent?.name}
          contextMode="presentazione"
          elevenLabsConfig={elevenLabsConfig}
          onBeforeStart={onClearTranscript}
          onSetError={onSetError}
          onVoiceContextChange={onVoiceContextChange}
          retrievalQuery={retrievalQuery}
          selectedVectorSource={selectedVectorSource}
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
  onCreateAgent,
  onDeleteAgent,
  onSaveApiKey,
  onSaveDefaults,
  onSaveIntegration,
  onSetError,
  onUpdateAgent,
}: {
  config: ElevenLabsConfig;
  isLoading: boolean;
  onCreateAgent: (input: ElevenLabsAgentInput) => Promise<void>;
  onDeleteAgent: (id: number) => Promise<void>;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onSaveDefaults: (defaults: ElevenLabsDefaults) => Promise<void>;
  onSaveIntegration: (
    publicBaseUrl: string,
    postCallWebhookSecret: string,
  ) => Promise<void>;
  onSetError: (value: string | null) => void;
  onUpdateAgent: (id: number, input: ElevenLabsAgentInput) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState(config.api_key);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentId, setNewAgentId] = useState("");
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isSavingDefaults, setIsSavingDefaults] = useState(false);
  const [isSavingIntegration, setIsSavingIntegration] = useState(false);
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [publicBaseUrl, setPublicBaseUrl] = useState(config.public_base_url);
  const [postCallWebhookSecret, setPostCallWebhookSecret] = useState(
    config.post_call_webhook_secret,
  );
  const [defaults, setDefaults] = useState<ElevenLabsDefaults>({
    inbound_agent_id: config.inbound_agent_id ?? null,
    outbound_agent_id: config.outbound_agent_id ?? null,
    presentation_agent_id: config.presentation_agent_id ?? null,
  });

  useEffect(() => {
    setApiKey(config.api_key);
  }, [config.api_key]);

  useEffect(() => {
    setPublicBaseUrl(config.public_base_url);
    setPostCallWebhookSecret(config.post_call_webhook_secret);
  }, [config.post_call_webhook_secret, config.public_base_url]);

  useEffect(() => {
    setDefaults({
      inbound_agent_id: config.inbound_agent_id ?? null,
      outbound_agent_id: config.outbound_agent_id ?? null,
      presentation_agent_id: config.presentation_agent_id ?? null,
    });
  }, [
    config.inbound_agent_id,
    config.outbound_agent_id,
    config.presentation_agent_id,
  ]);

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

  const handleSaveDefaults = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSavingDefaults(true);
    try {
      await onSaveDefaults(defaults);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Salvataggio agenti predefiniti fallito");
    } finally {
      setIsSavingDefaults(false);
    }
  };

  const handleSaveIntegration = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSavingIntegration(true);
    try {
      await onSaveIntegration(publicBaseUrl.trim(), postCallWebhookSecret.trim());
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Salvataggio webhook fallito");
    } finally {
      setIsSavingIntegration(false);
    }
  };

  const webhookBase = publicBaseUrl.trim().replace(/\/$/, "");

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

        <div
          className={`config-status ${
            config.api_key && config.agents.length > 0 ? "ready" : ""
          }`}
        >
          {config.api_key && config.agents.length > 0
            ? `${config.agents.length} agenti disponibili per i flussi.`
            : "Inserisci l'API key e aggiungi almeno un agente."}
        </div>
      </div>

      <div className="workspace-panel integration-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Telefonia</p>
            <h2>Webhook ElevenLabs</h2>
          </div>
          <Database size={22} />
        </div>

        <form className="config-form" onSubmit={handleSaveIntegration}>
          <label className="field-label" htmlFor="public-base-url">
            URL HTTPS pubblico del backend
          </label>
          <input
            disabled={isSavingIntegration}
            id="public-base-url"
            placeholder="https://..."
            type="url"
            value={publicBaseUrl}
            onChange={(event) => setPublicBaseUrl(event.target.value)}
          />

          <label className="field-label" htmlFor="tool-webhook-secret">
            Chiave dei tool webhook
          </label>
          <input
            id="tool-webhook-secret"
            readOnly
            type="text"
            value={config.tool_webhook_secret}
          />

          <label className="field-label" htmlFor="post-call-webhook-secret">
            Signing secret del post-call webhook
          </label>
          <input
            disabled={isSavingIntegration}
            id="post-call-webhook-secret"
            type="text"
            value={postCallWebhookSecret}
            onChange={(event) => setPostCallWebhookSecret(event.target.value)}
          />

          <button
            className="action-button compact-action"
            disabled={isSavingIntegration}
            type="submit"
          >
            {isSavingIntegration ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
            Salva webhook
          </button>
        </form>

        <div className="webhook-endpoints">
          <code>{webhookBase ? `${webhookBase}/api/tools/search-knowledge` : "Configura l'URL pubblico"}</code>
          <code>{webhookBase ? `${webhookBase}/api/tools/schedule-appointment` : "Configura l'URL pubblico"}</code>
          <code>{webhookBase ? `${webhookBase}/api/webhooks/elevenlabs/post-call` : "Configura l'URL pubblico"}</code>
        </div>
      </div>

      <div className="workspace-panel agent-management-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Agenti</p>
            <h2>Agent ID disponibili</h2>
          </div>
          <PhoneCall size={22} />
        </div>

        <form className="agent-defaults-form" onSubmit={handleSaveDefaults}>
          <div className="agent-defaults-grid">
            {(
              [
                ["inbound_agent_id", "Centralino Entrata"],
                ["outbound_agent_id", "Centralino Uscita"],
                ["presentation_agent_id", "Presentazione"],
              ] as const
            ).map(([field, label]) => (
              <label key={field}>
                <span>{label}</span>
                <select
                  className="config-select"
                  disabled={isSavingDefaults || config.agents.length === 0}
                  value={defaults[field] ?? ""}
                  onChange={(event) =>
                    setDefaults((current) => ({
                      ...current,
                      [field]: event.target.value || null,
                    }))
                  }
                >
                  <option value="">Nessun predefinito</option>
                  {config.agents.map((agent) => (
                    <option key={agent.id} value={agent.agent_id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button
            className="small-button"
            disabled={isSavingDefaults || config.agents.length === 0}
            type="submit"
          >
            {isSavingDefaults ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
            Salva predefiniti
          </button>
        </form>

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
  onDelete,
  onSetError,
  onUpdate,
}: {
  agent: ElevenLabsAgent;
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
    <article className="agent-config-card">
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
  contextMode = "centralino-entrata",
  elevenLabsConfig,
  onBeforeStart,
  onSetError,
  onVoiceContextChange,
  retrievalQuery,
  selectedVectorSource,
  startButtonLabel = "Avvia voce",
  startPrompt,
  title = "Sessione agente",
}: {
  agentId?: string | null;
  agentName?: string | null;
  contextMode?: VoiceContext;
  elevenLabsConfig: ElevenLabsConfig;
  onBeforeStart?: () => void;
  onSetError: (value: string | null) => void;
  onVoiceContextChange: (value: VoiceContext | null) => void;
  retrievalQuery: RetrievalQuery | null;
  selectedVectorSource: string | null;
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
  const effectiveAgentId = agentId || null;
  const effectiveAgentName = agentName || "non configurato";
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
        ? buildRealtimeContextUpdate(selectedVectorSource)
        : buildContextUpdate(selectedVectorSource);

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

function AppointmentsPanel({
  appointments,
  onDeleteAll,
  onSetError,
}: {
  appointments: Appointment[];
  onDeleteAll: () => Promise<void>;
  onSetError: (value: string | null) => void;
}) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteAll = async () => {
    if (!window.confirm("Cancellare tutti gli appuntamenti?")) {
      return;
    }

    setIsDeleting(true);
    try {
      await onDeleteAll();
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Cancellazione appuntamenti fallita");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <section className="workspace-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SQLite</p>
          <h2>Appuntamenti</h2>
        </div>
        <div className="panel-heading-actions">
          <button
            className="small-button danger"
            disabled={appointments.length === 0 || isDeleting}
            type="button"
            onClick={handleDeleteAll}
          >
            {isDeleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
            Cancella tutti
          </button>
          <CalendarClock size={22} />
        </div>
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
