import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  ConversationProvider,
  useConversationControls,
  useConversationMode,
  useConversationStatus,
} from "@elevenlabs/react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  BookOpen,
  Building2,
  CalendarClock,
  Check,
  Circle,
  ChevronLeft,
  ChevronRight,
  Database,
  FileUp,
  Eye,
  Folder,
  FolderPlus,
  GripVertical,
  KeyRound,
  Loader2,
  LogOut,
  Menu,
  Mic,
  MicOff,
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  Square,
  Trash2,
  UserPlus,
  UserCog,
  Users,
  X,
} from "lucide-react";
import {
  Appointment,
  AppointmentInput,
  AuthUser,
  Tenant,
  ElevenLabsAgent,
  ElevenLabsAgentInput,
  ElevenLabsConfig,
  ElevenLabsDefaults,
  ElevenLabsPhoneNumber,
  OutboundCall,
  OutboundCampaign,
  OutboundContact,
  OutboundContactInput,
  KnowledgeTree,
  VectorSearchResult,
  VectorStoreSource,
  VectorStoreStats,
  UsageEvent,
  UsageReport,
  UserCreateInput,
  UserUpdateInput,
  changePassword,
  cancelOutboundCampaign,
  createAppointment,
  createElevenLabsAgent,
  createOutboundContact,
  createOutboundCampaign,
  createUser,
  createTenant,
  deleteAllAppointments,
  deleteAllOutboundCalls,
  deleteOutboundCampaign,
  deleteElevenLabsAgent,
  deleteOutboundContact,
  deleteUser,
  getCurrentUser,
  getLatestOutboundCampaign,
  getOutboundCampaignCalls,
  getOutboundCampaignHistory,
  getConversationToken,
  getElevenLabsConfig,
  getSignedUrl,
  getVectorStoreSources,
  getKnowledgeTree,
  getVectorStoreStats,
  listAppointments,
  listElevenLabsPhoneNumbers,
  listOutboundCalls,
  listOutboundContacts,
  listUsers,
  listTenants,
  login,
  logout,
  resetUserPassword,
  saveElevenLabsConfig,
  saveElevenLabsDefaults,
  saveElevenLabsIntegration,
  saveFlowSource,
  searchVectorStore,
  updateElevenLabsAgent,
  updateOutboundContact,
  updateUser,
  uploadVectorStorePdf,
  importOutboundContacts,
  createKnowledgeArea,
  createKnowledgeModule,
  deleteKnowledgeArea,
  deleteKnowledgeModule,
  moveKnowledgeItem,
  updateKnowledgeArea,
  updateKnowledgeModule,
  getUsageReport,
  startUsageSession,
  finishUsageSession,
} from "./api";
import "./styles.css";

type RetrievalQuery = {
  id: number;
  text: string;
};

type AppView = "demo" | "config" | "users" | "tenants" | "usage";
type MainTab = "centralino-entrata" | "centralino-uscita" | "presentazione";
type VoiceContext = MainTab;
type NavigationPage = MainTab | "config" | "users" | "tenants" | "usage";
type OutboundSection = "operations" | "test" | "sources" | "appointments" | "events";
type EmbeddedPresentationState = "idle" | "logged-in" | "pdf-selected" | "active";

const isEmbeddedPresentation = window.location.pathname.replace(/\/$/, "") === "/presentazione-cpeople";
let lastEmbeddedPresentationMessage = "";

function embeddedParentOrigin() {
  const configured = new URLSearchParams(window.location.search).get("parentOrigin");
  if (configured) {
    try { return new URL(configured).origin; } catch { /* Fall back to the referrer. */ }
  }
  if (document.referrer) {
    try { return new URL(document.referrer).origin; } catch { /* Use wildcard only for local testing. */ }
  }
  return "*";
}

function postEmbeddedPresentationState(state: EmbeddedPresentationState, details: Record<string, unknown> = {}) {
  if (window.parent === window) return;
  const message = {
    source: "cp-agent",
    type: "cp-agent:presentation-state",
    state,
    ...details,
  };
  const signature = JSON.stringify(message);
  if (signature === lastEmbeddedPresentationMessage) return;
  lastEmbeddedPresentationMessage = signature;
  window.parent.postMessage(message, embeddedParentOrigin());
}

function navigationPageFromHash(): NavigationPage {
  const page = window.location.hash.replace(/^#/, "");
  return page === "centralino-uscita" || page === "presentazione" || page === "config" || page === "users" || page === "tenants" || page === "usage"
    ? page
    : "centralino-entrata";
}

function firstAllowedPage(user: AuthUser): NavigationPage {
  if (user.can_inbound) return "centralino-entrata";
  if (user.can_outbound) return "centralino-uscita";
  if (user.can_presentation) return "presentazione";
  return user.role === "admin" || user.role === "superadmin" ? "config" : "centralino-entrata";
}

function canAccessPage(user: AuthUser, page: NavigationPage) {
  if (page === "centralino-entrata") return user.can_inbound;
  if (page === "centralino-uscita") return user.can_outbound;
  if (page === "presentazione") return user.can_presentation;
  if (page === "tenants") return user.role === "superadmin";
  if (page === "usage") return user.role === "admin" || user.role === "superadmin";
  return user.role === "admin" || user.role === "superadmin";
}

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

function knowledgeScopeLabel(scope: string | null, tree: KnowledgeTree) {
  if (!scope) return "Tutte le fonti";
  if (scope.startsWith("area:")) {
    return tree.areas.find((area) => `area:${area.id}` === scope)?.name ?? scope;
  }
  for (const area of tree.areas) {
    const module = area.modules.find((item) => `module:${item.id}` === scope);
    if (module) return `${area.name} / ${module.name}`;
    const document = area.modules.flatMap((item) => item.documents).find((item) => `document:${item.id}` === scope);
    if (document) return document.source;
  }
  return tree.unassigned_documents.find((document) => `document:${document.id}` === scope)?.source ?? scope;
}

function knowledgeScopeExists(scope: string | null, tree: KnowledgeTree, sources: VectorStoreSource[]) {
  if (!scope) return true;
  if (sources.some((source) => source.source === scope)) return true;
  if (scope.startsWith("area:")) return tree.areas.some((area) => `area:${area.id}` === scope);
  if (scope.startsWith("module:")) return tree.areas.some((area) => area.modules.some((module) => `module:${module.id}` === scope));
  return [...tree.unassigned_documents, ...tree.areas.flatMap((area) => area.modules.flatMap((module) => module.documents))]
    .some((document) => `document:${document.id}` === scope);
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

function App({ currentUser, onLogout }: { currentUser: AuthUser; onLogout: () => Promise<void> }) {
  const initialPage = canAccessPage(currentUser, navigationPageFromHash())
    ? navigationPageFromHash()
    : firstAllowedPage(currentUser);
  const [appView, setAppView] = useState<AppView>(() =>
    initialPage === "config" ? "config" : initialPage === "users" ? "users" : initialPage === "tenants" ? "tenants" : initialPage === "usage" ? "usage" : "demo",
  );
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
  const [knowledgeTree, setKnowledgeTree] = useState<KnowledgeTree>({ areas: [], unassigned_documents: [] });
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

  const handleDeleteAllOutboundCalls = useCallback(async () => {
    setError(null);
    await deleteAllOutboundCalls();
    setOutboundCalls([]);
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
    const loadWorkspace = async () => {
      try {
        const [configResponse, stats, sources, tree] = await Promise.all([
          getElevenLabsConfig(),
          getVectorStoreStats(),
          getVectorStoreSources(),
          getKnowledgeTree(),
        ]);
        const appointmentRows = currentUser.can_inbound || currentUser.can_outbound
          ? await listAppointments()
          : [];
        const [contacts, calls] = currentUser.can_outbound
          ? await Promise.all([listOutboundContacts(), listOutboundCalls()])
          : [[], []];
        setElevenLabsConfig(configResponse);
        setAppointments(appointmentRows);
        setVectorStats(stats);
        setVectorSources(sources);
        setKnowledgeTree(tree);
        setOutboundContacts(contacts);
        setOutboundCalls(calls);
        const sourceExists = (source?: string | null) => Boolean(source && knowledgeScopeExists(source, tree, sources));
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
      } catch (err) {
        setError(err instanceof Error ? err.message : "Errore di inizializzazione");
      } finally {
        setIsLoading(false);
      }
    };
    void loadWorkspace();
  }, [currentUser.can_inbound, currentUser.can_outbound]);

  useEffect(() => {
    if (!elevenLabsConfig.configured || !currentUser.can_outbound) {
      setPhoneNumbers([]);
      return;
    }
    refreshPhoneNumbers().catch((err: unknown) => {
      setMessages((current) => [
        `numeri Twilio: ${err instanceof Error ? err.message : "caricamento fallito"}`,
        ...current,
      ].slice(0, 12));
    });
  }, [currentUser.can_outbound, elevenLabsConfig.configured, refreshPhoneNumbers]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const refreshes: Promise<unknown>[] = [];
      if (currentUser.can_inbound || currentUser.can_outbound) refreshes.push(refreshAppointments());
      if (currentUser.can_outbound) refreshes.push(refreshOutboundCalls());
      Promise.all(refreshes).catch(() => {
        // A transient polling failure is surfaced by the next explicit action.
      });
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [currentUser.can_inbound, currentUser.can_outbound, refreshAppointments, refreshOutboundCalls]);

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
      !knowledgeScopeExists(inboundVectorSource, knowledgeTree, vectorSources)
    ) {
      setInboundVectorSource(null);
    }
    if (
      outboundVectorSource &&
      !knowledgeScopeExists(outboundVectorSource, knowledgeTree, vectorSources)
    ) {
      setOutboundVectorSource(null);
    }
    if (
      presentationVectorSource &&
      !knowledgeScopeExists(presentationVectorSource, knowledgeTree, vectorSources)
    ) {
      setPresentationVectorSource(null);
    }
  }, [inboundVectorSource, outboundVectorSource, presentationVectorSource, vectorSources, knowledgeTree]);

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
        const [sources, tree] = await Promise.all([getVectorStoreSources(), getKnowledgeTree()]);
        setVectorStats({ chunks: lastResponse.chunks, sources: lastResponse.sources });
        setVectorSources(sources);
        setKnowledgeTree(tree);
        const uploadedDocument = [
          ...tree.unassigned_documents,
          ...tree.areas.flatMap((area) => area.modules.flatMap((module) => module.documents)),
        ].find((document) => document.source === lastResponse.source);
        const uploadedScope = uploadedDocument ? `document:${uploadedDocument.id}` : lastResponse.source;
        setInboundVectorSource(uploadedScope);
        setOutboundVectorSource(uploadedScope);
        setPresentationVectorSource(uploadedScope);
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

  const handleKnowledgeTreeChange = useCallback((tree: KnowledgeTree) => {
    setKnowledgeTree(tree);
  }, []);

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
        currentUser={currentUser}
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
        onLogout={onLogout}
        onClearPresentationTranscript={handleClearPresentationTranscript}
        onCreateElevenLabsAgent={handleCreateElevenLabsAgent}
        onCreateOutboundContact={handleCreateOutboundContact}
        onDeleteAllAppointments={handleDeleteAllAppointments}
        onDeleteAllOutboundCalls={handleDeleteAllOutboundCalls}
        onDeleteElevenLabsAgent={handleDeleteElevenLabsAgent}
        onDeleteOutboundContact={handleDeleteOutboundContact}
        onSaveElevenLabsApiKey={handleSaveElevenLabsApiKey}
        onSaveElevenLabsDefaults={handleSaveElevenLabsDefaults}
        onSaveElevenLabsIntegration={handleSaveElevenLabsIntegration}
        onRefreshOutboundCalls={refreshOutboundCalls}
        onRefreshOutboundContacts={refreshOutboundContacts}
        onRefreshPhoneNumbers={refreshPhoneNumbers}
        onUpdateElevenLabsAgent={handleUpdateElevenLabsAgent}
        onUpdateOutboundContact={handleUpdateOutboundContact}
        onPdfModeChange={setPdfMode}
        onVectorPdfUpload={handleVectorPdfUpload}
        onKnowledgeTreeChange={handleKnowledgeTreeChange}
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
        knowledgeTree={knowledgeTree}
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
  currentUser: AuthUser;
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
  knowledgeTree: KnowledgeTree;
  inboundVectorSource: string | null;
  outboundVectorSource: string | null;
  presentationVectorSource: string | null;
  retrievalQuery: RetrievalQuery | null;
  onAppViewChange: (value: AppView) => void;
  onLogout: () => Promise<void>;
  onClearPresentationTranscript: () => void;
  onCreateElevenLabsAgent: (input: ElevenLabsAgentInput) => Promise<void>;
  onCreateOutboundContact: (input: OutboundContactInput) => Promise<void>;
  onDeleteAllAppointments: () => Promise<void>;
  onDeleteAllOutboundCalls: () => Promise<void>;
  onDeleteElevenLabsAgent: (id: number) => Promise<void>;
  onDeleteOutboundContact: (id: number) => Promise<void>;
  onPdfModeChange: (value: "append" | "replace") => void;
  onSaveElevenLabsApiKey: (apiKey: string) => Promise<void>;
  onSaveElevenLabsDefaults: (defaults: ElevenLabsDefaults) => Promise<void>;
  onSaveElevenLabsIntegration: (
    publicBaseUrl: string,
    postCallWebhookSecret: string,
  ) => Promise<void>;
  onRefreshOutboundCalls: () => Promise<void>;
  onRefreshOutboundContacts: () => Promise<void>;
  onRefreshPhoneNumbers: () => Promise<void>;
  onUpdateElevenLabsAgent: (id: number, input: ElevenLabsAgentInput) => Promise<void>;
  onUpdateOutboundContact: (id: number, input: OutboundContactInput) => Promise<void>;
  onVectorPdfUpload: (files: File[]) => Promise<void>;
  onKnowledgeTreeChange: (tree: KnowledgeTree) => void;
  onInboundVectorSourceChange: (source: string | null) => void;
  onOutboundVectorSourceChange: (source: string | null) => void;
  onPresentationVectorSourceChange: (source: string | null) => void;
  onVoiceContextChange: (value: VoiceContext | null) => void;
  onSetError: (value: string | null) => void;
};

function Shell({
  appView,
  currentUser,
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
  knowledgeTree,
  inboundVectorSource,
  outboundVectorSource,
  presentationVectorSource,
  retrievalQuery,
  onAppViewChange,
  onLogout,
  onClearPresentationTranscript,
  onCreateElevenLabsAgent,
  onCreateOutboundContact,
  onDeleteAllAppointments,
  onDeleteAllOutboundCalls,
  onDeleteElevenLabsAgent,
  onDeleteOutboundContact,
  onPdfModeChange,
  onSaveElevenLabsApiKey,
  onSaveElevenLabsDefaults,
  onSaveElevenLabsIntegration,
  onRefreshOutboundCalls,
  onRefreshOutboundContacts,
  onRefreshPhoneNumbers,
  onUpdateElevenLabsAgent,
  onUpdateOutboundContact,
  onVectorPdfUpload,
  onKnowledgeTreeChange,
  onInboundVectorSourceChange,
  onOutboundVectorSourceChange,
  onPresentationVectorSourceChange,
  onVoiceContextChange,
  onSetError,
}: ShellProps) {
  const [mainTab, setMainTab] = useState<MainTab>(() => {
    const page = navigationPageFromHash();
    return page === "config" || page === "users" || page === "tenants" || page === "usage" ? firstAllowedPage(currentUser) as MainTab : page;
  });
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [inboundAgentId, setInboundAgentId] = useState<string | null>(null);
  const [outboundAgentId, setOutboundAgentId] = useState<string | null>(null);
  const [presentationAgentId, setPresentationAgentId] = useState<string | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);

  useEffect(() => {
    if (currentUser.role !== "superadmin") return;
    void listTenants().then((rows) => {
      setTenants(rows);
      if (!localStorage.getItem("cp-agent-tenant-id")) {
        localStorage.setItem("cp-agent-tenant-id", String(currentUser.tenant_id));
      }
    }).catch((err) => onSetError(err instanceof Error ? err.message : "Caricamento tenant fallito"));
  }, [currentUser, onSetError]);

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

  const activePage: NavigationPage = appView === "config" ? "config" : appView === "users" ? "users" : appView === "tenants" ? "tenants" : appView === "usage" ? "usage" : mainTab;
  const pageDetails =
    activePage === "centralino-entrata"
      ? { eyebrow: "Centralino", title: "Chiamate in entrata", description: "Gestione agente, fonti e appuntamenti" }
      : activePage === "centralino-uscita"
        ? { eyebrow: "Centralino", title: "Chiamate in uscita", description: "Contatti, telefonate e trascrizioni" }
        : activePage === "presentazione"
          ? { eyebrow: "Presentazione", title: "Presentazione commerciale", description: "Sessioni guidate sulle fonti selezionate" }
          : activePage === "users"
            ? { eyebrow: "Amministrazione", title: "Utenti e accessi", description: "Ruoli, moduli e credenziali" }
            : activePage === "usage"
              ? { eyebrow: "Amministrazione", title: "Utilizzo", description: "Attivita e volumi del tenant" }
            : activePage === "tenants"
              ? { eyebrow: "Superadmin", title: "Tenant", description: "Aziende, ambienti e configurazioni isolate" }
            : { eyebrow: "Sistema", title: "Configurazione", description: "Agenti, credenziali e integrazioni" };

  const navigateTo = (page: NavigationPage) => {
    if (!canAccessPage(currentUser, page)) return;
    if (page === "config") {
      onAppViewChange("config");
    } else if (page === "users") {
      onAppViewChange("users");
    } else if (page === "tenants") {
      onAppViewChange("tenants");
    } else if (page === "usage") {
      onAppViewChange("usage");
    } else {
      setMainTab(page);
      onAppViewChange("demo");
    }
    window.history.replaceState(null, "", `#${page}`);
    setIsNavigationOpen(false);
  };

  useEffect(() => {
    const handleHashChange = () => {
      const page = navigationPageFromHash();
      if (!canAccessPage(currentUser, page)) {
        navigateTo(firstAllowedPage(currentUser));
        return;
      }
      if (page === "config") {
        onAppViewChange("config");
      } else if (page === "users") {
        onAppViewChange("users");
      } else if (page === "tenants") {
        onAppViewChange("tenants");
      } else if (page === "usage") {
        onAppViewChange("usage");
      } else {
        setMainTab(page);
        onAppViewChange("demo");
      }
      setIsNavigationOpen(false);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [currentUser, onAppViewChange]);

  return (
    <main className="app-shell">
      <aside className={`app-sidebar ${isNavigationOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <img className="sidebar-brand-logo" src="/centro-paghe-logo.png" alt="Gruppo Centro Paghe" />
          <div>
            <strong>CP AGENT</strong>
            <span>Centro Paghe</span>
          </div>
          <button
            className="sidebar-close"
            title="Chiudi menu"
            type="button"
            onClick={() => setIsNavigationOpen(false)}
          >
            <X size={19} />
          </button>
        </div>

        <nav className="sidebar-navigation" aria-label="Navigazione principale">
          <p>Operatività</p>
          {currentUser.can_inbound && <button className={activePage === "centralino-entrata" ? "active" : ""} type="button" onClick={() => navigateTo("centralino-entrata")}>
            <PhoneIncoming size={18} /><span>Centralino Entrata</span>
          </button>}
          {currentUser.can_outbound && <button className={activePage === "centralino-uscita" ? "active" : ""} type="button" onClick={() => navigateTo("centralino-uscita")}>
            <PhoneOutgoing size={18} /><span>Centralino Uscita</span>
          </button>}
          {currentUser.can_presentation && <button className={activePage === "presentazione" ? "active" : ""} type="button" onClick={() => navigateTo("presentazione")}>
            <Presentation size={18} /><span>Presentazione</span>
          </button>}

          {(currentUser.role === "admin" || currentUser.role === "superadmin") && <><p>Amministrazione</p>
            <button className={activePage === "usage" ? "active" : ""} type="button" onClick={() => navigateTo("usage")}>
              <BarChart3 size={18} /><span>Utilizzo</span>
            </button>
            {currentUser.role === "superadmin" && <button className={activePage === "tenants" ? "active" : ""} type="button" onClick={() => navigateTo("tenants")}>
              <Building2 size={18} /><span>Tenant</span>
            </button>}
            <button className={activePage === "users" ? "active" : ""} type="button" onClick={() => navigateTo("users")}>
              <UserCog size={18} /><span>Utenti</span>
            </button>
            <button className={activePage === "config" ? "active" : ""} type="button" onClick={() => navigateTo("config")}>
              <Settings size={18} /><span>Configurazione</span>
            </button></>}
        </nav>

        <div className="sidebar-footer">
          {currentUser.role === "superadmin" && <label className="tenant-switcher"><span>Tenant attivo</span><select value={localStorage.getItem("cp-agent-tenant-id") ?? String(currentUser.tenant_id)} onChange={(event) => { localStorage.setItem("cp-agent-tenant-id", event.target.value); window.location.reload(); }}>{tenants.filter((tenant) => tenant.is_active).map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></label>}
          <div className="sidebar-user"><strong>{currentUser.username}</strong><span>{currentUser.role === "superadmin" ? "Superadmin" : currentUser.role === "admin" ? "Amministratore" : "Utente"}</span></div>
          <div className="sidebar-account-actions">
            <button title="Cambia password" type="button" onClick={() => setIsPasswordModalOpen(true)}><KeyRound size={17} /></button>
            <button title="Esci" type="button" onClick={() => void onLogout()}><LogOut size={17} /></button>
          </div>
        </div>
      </aside>

      {isNavigationOpen && (
        <button
          aria-label="Chiudi navigazione"
          className="navigation-backdrop"
          type="button"
          onClick={() => setIsNavigationOpen(false)}
        />
      )}

      <div className="app-content">
        <header className="page-header">
          <button
            className="mobile-menu-button"
            title="Apri menu"
            type="button"
            onClick={() => setIsNavigationOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div>
            <p className="eyebrow">{pageDetails.eyebrow}</p>
            <h1>{pageDetails.title}</h1>
            <span>{pageDetails.description}</span>
          </div>
          <div className="page-header-status">
            <StatusPill />
          </div>
        </header>

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => onSetError(null)}
            >
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
        ) : appView === "users" ? (
          <UsersPage currentUser={currentUser} onSetError={onSetError} />
        ) : appView === "tenants" ? (
          <TenantsPage currentUser={currentUser} onSetError={onSetError} />
        ) : appView === "usage" ? (
          <UsagePage currentUser={currentUser} onSetError={onSetError} />
        ) : (
          <section className="main-workspace">
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
                knowledgeTree={knowledgeTree}
                canManageKnowledge={currentUser.role === "admin" || currentUser.role === "superadmin"}
                onKnowledgeTreeChange={onKnowledgeTreeChange}
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
                onDeleteAllOutboundCalls={onDeleteAllOutboundCalls}
                onDeleteContact={onDeleteOutboundContact}
                onPdfModeChange={onPdfModeChange}
                onSetError={onSetError}
                onRefreshOutboundCalls={onRefreshOutboundCalls}
                onRefreshOutboundContacts={onRefreshOutboundContacts}
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
                knowledgeTree={knowledgeTree}
                canManageKnowledge={currentUser.role === "admin" || currentUser.role === "superadmin"}
                onKnowledgeTreeChange={onKnowledgeTreeChange}
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
                knowledgeTree={knowledgeTree}
                canManageKnowledge={currentUser.role === "admin" || currentUser.role === "superadmin"}
                onKnowledgeTreeChange={onKnowledgeTreeChange}
              />
            )}
          </section>
        )}
      </div>
      <PasswordModal isOpen={isPasswordModalOpen} onClose={() => setIsPasswordModalOpen(false)} onSetError={onSetError} />
    </main>
  );
}

function PasswordModal({
  isOpen,
  onClose,
  onSetError,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSetError: (value: string | null) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      onSetError("Le nuove password non coincidono");
      return;
    }
    setIsSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onClose();
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Cambio password fallito");
    } finally {
      setIsSaving(false);
    }
  };

  return <Modal eyebrow="Account" icon={<KeyRound size={20} />} isOpen={isOpen} onClose={isSaving ? () => undefined : onClose} title="Cambia password">
    <form onSubmit={submit}>
      <div className="modal-body modal-form">
        <label><span>Password attuale</span><input autoFocus type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
        <label><span>Nuova password</span><input minLength={8} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label><span>Conferma nuova password</span><input minLength={8} type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
      </div>
      <footer className="modal-actions">
        <button className="secondary-button" disabled={isSaving} type="button" onClick={onClose}>Annulla</button>
        <button className="primary-button" disabled={isSaving || !currentPassword || newPassword.length < 8 || !confirmPassword} type="submit">{isSaving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}Aggiorna</button>
      </footer>
    </form>
  </Modal>;
}

const emptyUserInput: UserCreateInput = {
  username: "",
  password: "",
  role: "user",
  can_inbound: true,
  can_outbound: false,
  can_presentation: false,
};

const usageLabels: Record<UsageEvent["channel"], string> = {
  inbound: "Centralino entrata",
  outbound: "Centralino uscita",
  presentation: "Presentazione",
};

function formatUsageDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes} min`;
}

function UsagePage({ currentUser, onSetError }: { currentUser: AuthUser; onSetError: (value: string | null) => void }) {
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(1);
  const [channel, setChannel] = useState<UsageEvent["channel"] | "">("");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      setReport(await getUsageReport(days, page, channel));
      onSetError(null);
    } catch (error) {
      onSetError(error instanceof Error ? error.message : "Caricamento utilizzo fallito");
    } finally {
      setIsLoading(false);
    }
  }, [channel, days, onSetError, page]);

  useEffect(() => { void refresh(); }, [refresh]);

  const chartDays = report?.daily.slice(-Math.min(days, 31)) ?? [];
  const chartMax = Math.max(1, ...chartDays.map((item) => item.inbound + item.outbound + item.presentation));

  return <section className="usage-page">
    <div className="usage-toolbar">
      <div><strong>{report?.tenant_name ?? currentUser.tenant_name}</strong><span>{currentUser.role === "superadmin" ? "Tenant selezionato" : "Il tuo tenant"}</span></div>
      <div className="usage-filters">
        <label><span>Periodo</span><select value={days} onChange={(event) => { setDays(Number(event.target.value)); setPage(1); }}><option value={7}>7 giorni</option><option value={30}>30 giorni</option><option value={90}>90 giorni</option><option value={365}>12 mesi</option></select></label>
        <button className="icon-button" title="Aggiorna" type="button" onClick={() => void refresh()}>{isLoading ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}</button>
      </div>
    </div>

    <div className="usage-summary-grid">
      {(report?.channels ?? []).map((stats) => <article className={`usage-summary-card ${stats.channel}`} key={stats.channel}>
        <div><span className="usage-channel-icon">{stats.channel === "inbound" ? <PhoneIncoming size={19} /> : stats.channel === "outbound" ? <PhoneOutgoing size={19} /> : <Presentation size={19} />}</span><strong>{usageLabels[stats.channel]}</strong></div>
        <b>{stats.sessions}</b><span>sessioni nel periodo</span>
        <dl><div><dt>Durata</dt><dd>{formatUsageDuration(stats.duration_seconds)}</dd></div><div><dt>Media</dt><dd>{formatUsageDuration(stats.average_duration_seconds)}</dd></div><div><dt>Fallite</dt><dd>{stats.failed}</dd></div></dl>
      </article>)}
      {!report && <div className="usage-loading"><Loader2 className="spin" size={22} />Caricamento statistiche</div>}
    </div>

    <section className="workspace-panel usage-chart-panel">
      <div className="panel-heading"><div><p className="eyebrow">Andamento</p><h2>Sessioni giornaliere</h2></div><div className="usage-legend"><span><i className="inbound" />Entrata</span><span><i className="outbound" />Uscita</span><span><i className="presentation" />Presentazione</span></div></div>
      <div className="usage-chart" role="img" aria-label="Sessioni giornaliere per canale">
        {chartDays.map((item) => { const total = item.inbound + item.outbound + item.presentation; return <div className="usage-chart-day" key={item.date} title={`${new Date(`${item.date}T00:00:00`).toLocaleDateString("it-IT")}: ${total}`}><div className="usage-chart-stack" style={{ height: `${Math.max(total ? 8 : 2, (total / chartMax) * 100)}%` }}>{item.presentation > 0 && <i className="presentation" style={{ flex: item.presentation }} />}{item.outbound > 0 && <i className="outbound" style={{ flex: item.outbound }} />}{item.inbound > 0 && <i className="inbound" style={{ flex: item.inbound }} />}</div><span>{new Date(`${item.date}T00:00:00`).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })}</span></div>; })}
      </div>
    </section>

    <section className="workspace-panel usage-log-panel">
      <div className="panel-heading"><div><p className="eyebrow">Log</p><h2>Attivita recenti</h2></div><label className="usage-channel-filter"><span>Canale</span><select value={channel} onChange={(event) => { setChannel(event.target.value as UsageEvent["channel"] | ""); setPage(1); }}><option value="">Tutti</option><option value="inbound">Centralino entrata</option><option value="outbound">Centralino uscita</option><option value="presentation">Presentazione</option></select></label></div>
      <div className="usage-log-table">
        <div className="usage-log-row header"><span>Data e ora</span><span>Canale</span><span>Origine</span><span>Esito</span><span>Durata</span><span>Conversazione</span></div>
        {report?.events.map((event) => <div className="usage-log-row" key={event.id}><span>{new Date(event.started_at).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" })}</span><strong>{usageLabels[event.channel]}</strong><span>{event.origin === "phone" ? "Telefono" : "Web"}</span><span className={`usage-status ${event.status}`}>{event.status === "completed" ? "Completata" : event.status === "started" ? "In corso" : event.status === "cancelled" ? "Interrotta" : "Fallita"}</span><span>{formatUsageDuration(event.duration_seconds)}</span><code title={event.conversation_id ?? ""}>{event.conversation_id ?? "-"}</code></div>)}
        {!isLoading && report?.events.length === 0 && <p className="empty-state">Nessuna attivita nel periodo selezionato.</p>}
      </div>
      <div className="campaign-history-pagination"><span>{report ? `${report.total} eventi` : ""}</span><div><button className="icon-button" disabled={!report || report.page <= 1} title="Pagina precedente" type="button" onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={16} /></button><span>{report ? `${report.page} / ${report.pages}` : "-"}</span><button className="icon-button" disabled={!report || report.page >= report.pages} title="Pagina successiva" type="button" onClick={() => setPage((value) => value + 1)}><ChevronRight size={16} /></button></div></div>
    </section>
  </section>;
}

function TenantsPage({ currentUser, onSetError }: { currentUser: AuthUser; onSetError: (value: string | null) => void }) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const refresh = useCallback(async () => setTenants(await listTenants()), []);
  useEffect(() => { void refresh().catch((err) => onSetError(err instanceof Error ? err.message : "Caricamento tenant fallito")); }, [onSetError, refresh]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    try {
      await createTenant({ name: name.trim(), slug: slug.trim() });
      await refresh();
      setName("");
      setSlug("");
      setIsOpen(false);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Creazione tenant fallita");
    } finally { setIsBusy(false); }
  };
  return <section className="users-workspace">
    <div className="workspace-panel users-panel">
      <div className="panel-heading"><div><p className="eyebrow">Organizzazioni</p><h2>Tenant</h2></div><button className="small-button primary" type="button" onClick={() => setIsOpen(true)}><Plus size={16} />Nuovo tenant</button></div>
      <div className="tenant-grid">
        {tenants.map((tenant) => <article className={`tenant-card ${tenant.is_active ? "" : "inactive"}`} key={tenant.id}>
          <span className="tenant-icon"><Building2 size={20} /></span>
          <div><strong>{tenant.name}</strong><small>{tenant.slug}</small></div>
          <span className="tenant-status">{tenant.is_active ? "Attivo" : "Disattivato"}</span>
          <button className="small-button" disabled={!tenant.is_active} type="button" onClick={() => { localStorage.setItem("cp-agent-tenant-id", String(tenant.id)); window.location.hash = "#config"; window.location.reload(); }}>Apri ambiente</button>
        </article>)}
      </div>
      <p className="tenant-note">Ogni tenant dispone di utenti, agenti, chiavi, documenti, anagrafiche, campagne e trascrizioni separati.</p>
    </div>
    <Modal eyebrow="Superadmin" icon={<Building2 size={20} />} isOpen={isOpen} onClose={isBusy ? () => undefined : () => setIsOpen(false)} title="Nuovo tenant">
      <form onSubmit={submit}><div className="modal-body modal-form"><label><span>Nome azienda</span><input autoFocus value={name} onChange={(event) => { setName(event.target.value); if (!slug) setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} /></label><label><span>Slug</span><input value={slug} onChange={(event) => setSlug(event.target.value)} /></label></div><footer className="modal-actions"><button className="secondary-button" disabled={isBusy} type="button" onClick={() => setIsOpen(false)}>Annulla</button><button className="primary-button" disabled={isBusy || name.trim().length < 2 || slug.trim().length < 2} type="submit">{isBusy ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}Crea tenant</button></footer></form>
    </Modal>
  </section>;
}

function UsersPage({ currentUser, onSetError }: { currentUser: AuthUser; onSetError: (value: string | null) => void }) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [editingUser, setEditingUser] = useState<AuthUser | null>(null);
  const [form, setForm] = useState<UserCreateInput>(emptyUserInput);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [passwordUser, setPasswordUser] = useState<AuthUser | null>(null);
  const [replacementPassword, setReplacementPassword] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AuthUser | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const refresh = useCallback(async () => setUsers(await listUsers()), []);
  useEffect(() => { void refresh().catch((err) => onSetError(err instanceof Error ? err.message : "Caricamento utenti fallito")); }, [onSetError, refresh]);

  const openCreate = () => {
    setEditingUser(null);
    setForm(emptyUserInput);
    setIsEditorOpen(true);
  };
  const openEdit = (user: AuthUser) => {
    setEditingUser(user);
    setForm({
      username: user.username,
      password: "",
      role: user.role === "user" ? "user" : "admin",
      can_inbound: user.can_inbound,
      can_outbound: user.can_outbound,
      can_presentation: user.can_presentation,
    });
    setIsEditorOpen(true);
  };
  const submitUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    try {
      if (editingUser) {
        const input: UserUpdateInput = {
          username: form.username,
          role: form.role,
          can_inbound: form.can_inbound,
          can_outbound: form.can_outbound,
          can_presentation: form.can_presentation,
          is_active: editingUser.is_active,
        };
        await updateUser(editingUser.id, input);
      } else {
        await createUser(form);
      }
      await refresh();
      setIsEditorOpen(false);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Salvataggio utente fallito");
    } finally {
      setIsBusy(false);
    }
  };
  const toggleActive = async (user: AuthUser) => {
    setIsBusy(true);
    try {
      await updateUser(user.id, { username: user.username, role: user.role === "user" ? "user" : "admin", can_inbound: user.can_inbound, can_outbound: user.can_outbound, can_presentation: user.can_presentation, is_active: !user.is_active });
      await refresh();
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Aggiornamento utente fallito");
    } finally { setIsBusy(false); }
  };
  const submitReset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!passwordUser) return;
    setIsBusy(true);
    try {
      await resetUserPassword(passwordUser.id, replacementPassword);
      setPasswordUser(null);
      setReplacementPassword("");
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Reset password fallito");
    } finally { setIsBusy(false); }
  };
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setIsBusy(true);
    try {
      await deleteUser(deleteTarget.id);
      await refresh();
      setDeleteTarget(null);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Eliminazione utente fallita");
    } finally { setIsBusy(false); }
  };

  return <section className="users-workspace">
    <div className="workspace-panel users-panel">
      <div className="panel-heading"><div><p className="eyebrow">Accessi</p><h2>Utenti</h2></div><button className="small-button primary" type="button" onClick={openCreate}><UserPlus size={16} />Nuovo utente</button></div>
      <div className="users-list">
        {users.map((user) => <article className={`user-row ${user.is_active ? "" : "inactive"}`} key={user.id}>
          <div className="user-identity"><span className="user-avatar">{user.username.slice(0, 2).toUpperCase()}</span><div><strong>{user.username}</strong><span>{user.role === "admin" ? "Amministratore" : "Utente"}</span></div></div>
          <div className="permission-tags">
            {user.can_inbound && <span>Entrata</span>}{user.can_outbound && <span>Uscita</span>}{user.can_presentation && <span>Presentazione</span>}
            {!user.is_active && <span className="disabled-tag">Disattivato</span>}
          </div>
          <div className="user-actions">
            <button className="icon-button" title="Modifica" type="button" onClick={() => openEdit(user)}><Settings size={16} /></button>
            <button className="icon-button" disabled={user.id === currentUser.id} title="Reset password" type="button" onClick={() => { setPasswordUser(user); setReplacementPassword(""); }}><KeyRound size={16} /></button>
            <button className="small-button" disabled={user.id === currentUser.id || isBusy} type="button" onClick={() => void toggleActive(user)}>{user.is_active ? "Disattiva" : "Attiva"}</button>
            <button className="icon-button danger" disabled={user.id === currentUser.id} title="Elimina" type="button" onClick={() => setDeleteTarget(user)}><Trash2 size={16} /></button>
          </div>
        </article>)}
      </div>
    </div>

    <Modal eyebrow="Amministrazione" icon={<UserCog size={20} />} isOpen={isEditorOpen} onClose={isBusy ? () => undefined : () => setIsEditorOpen(false)} title={editingUser ? "Modifica utente" : "Nuovo utente"}>
      <form onSubmit={submitUser}>
        <div className="modal-body modal-form">
          <label><span>Username</span><input autoFocus value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
          {!editingUser && <label><span>Password iniziale</span><input minLength={8} type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>}
          <label><span>Ruolo</span><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as "admin" | "user" })}><option value="user">Utente</option><option value="admin">Amministratore</option></select></label>
          <fieldset className="permission-fieldset" disabled={form.role === "admin"}><legend>Moduli visibili</legend>
            <label className="permission-check"><input type="checkbox" checked={form.can_inbound || form.role === "admin"} onChange={(event) => setForm({ ...form, can_inbound: event.target.checked })} /><span>Centralino Entrata</span></label>
            <label className="permission-check"><input type="checkbox" checked={form.can_outbound || form.role === "admin"} onChange={(event) => setForm({ ...form, can_outbound: event.target.checked })} /><span>Centralino Uscita</span></label>
            <label className="permission-check"><input type="checkbox" checked={form.can_presentation || form.role === "admin"} onChange={(event) => setForm({ ...form, can_presentation: event.target.checked })} /><span>Presentazione</span></label>
          </fieldset>
        </div>
        <footer className="modal-actions"><button className="secondary-button" disabled={isBusy} type="button" onClick={() => setIsEditorOpen(false)}>Annulla</button><button className="primary-button" disabled={isBusy || form.username.trim().length < 3 || (!editingUser && form.password.length < 8) || (form.role === "user" && !form.can_inbound && !form.can_outbound && !form.can_presentation)} type="submit">{isBusy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}Salva</button></footer>
      </form>
    </Modal>

    <Modal eyebrow="Credenziali" icon={<KeyRound size={20} />} isOpen={Boolean(passwordUser)} onClose={isBusy ? () => undefined : () => setPasswordUser(null)} title={`Reset password${passwordUser ? ` · ${passwordUser.username}` : ""}`}>
      <form onSubmit={submitReset}><div className="modal-body modal-form"><label><span>Nuova password</span><input autoFocus minLength={8} type="password" value={replacementPassword} onChange={(event) => setReplacementPassword(event.target.value)} /></label></div><footer className="modal-actions"><button className="secondary-button" type="button" onClick={() => setPasswordUser(null)}>Annulla</button><button className="primary-button" disabled={isBusy || replacementPassword.length < 8} type="submit">Imposta password</button></footer></form>
    </Modal>
    <ConfirmDialog confirmLabel="Elimina utente" description={`L'account ${deleteTarget?.username ?? ""} e tutte le sue sessioni verranno eliminati.`} isBusy={isBusy} isOpen={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()} title="Eliminare questo utente?" />
  </section>;
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
  onDeleteAllOutboundCalls,
  onDeleteContact,
  onSetError,
  onRefreshOutboundCalls,
  onRefreshOutboundContacts,
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
  knowledgeTree,
  canManageKnowledge,
  onKnowledgeTreeChange,
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
  onDeleteAllOutboundCalls?: () => Promise<void>;
  onDeleteContact?: (id: number) => Promise<void>;
  onSetError: (value: string | null) => void;
  onRefreshOutboundCalls?: () => Promise<void>;
  onRefreshOutboundContacts?: () => Promise<void>;
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
  knowledgeTree: KnowledgeTree;
  canManageKnowledge: boolean;
  onKnowledgeTreeChange: (tree: KnowledgeTree) => void;
}) {
  const [outboundSection, setOutboundSection] = useState<OutboundSection>("operations");
  const selectedAgent = elevenLabsConfig.agents.find(
    (agent) => agent.agent_id === agentId,
  );

  if (
    flow === "centralino-uscita" &&
    onCreateContact &&
    onDeleteContact &&
    onUpdateContact &&
    onDeleteAllOutboundCalls &&
    onRefreshOutboundCalls &&
    onRefreshOutboundContacts &&
    onRefreshPhoneNumbers
  ) {
    return (
      <div className="outbound-workspace">
        <nav className="workspace-subnav" aria-label="Sezioni chiamate in uscita">
          <button
            className={outboundSection === "operations" ? "active" : ""}
            type="button"
            onClick={() => setOutboundSection("operations")}
          >
            <PhoneOutgoing size={17} />
            Operatività
          </button>
          <button
            className={outboundSection === "sources" ? "active" : ""}
            type="button"
            onClick={() => setOutboundSection("sources")}
          >
            <BookOpen size={17} />
            Fonti
          </button>
          <button
            className={outboundSection === "appointments" ? "active" : ""}
            type="button"
            onClick={() => setOutboundSection("appointments")}
          >
            <CalendarClock size={17} />
            Appuntamenti
            {appointments.length > 0 && <span>{appointments.length}</span>}
          </button>
          <button
            className={outboundSection === "events" ? "active" : ""}
            type="button"
            onClick={() => setOutboundSection("events")}
          >
            <Activity size={17} />
            Eventi
          </button>
          <button
            className={outboundSection === "test" ? "active" : ""}
            type="button"
            onClick={() => setOutboundSection("test")}
          >
            <Mic size={17} />
            Test
          </button>
        </nav>

        {outboundSection === "operations" && (
          <>
            <section className="outbound-context-bar">
              <div className="outbound-agent-control">
                <AgentSelector
                  agents={elevenLabsConfig.agents}
                  id={`${flow}-agent`}
                  label="Agente per le chiamate"
                  selectedAgentId={agentId}
                  onChange={onAgentChange}
                />
              </div>
              <div className="outbound-context-summary">
                <span>Fonte attiva</span>
                <strong>{knowledgeScopeLabel(selectedVectorSource, knowledgeTree)}</strong>
                <small>{vectorSources.length} PDF indicizzati</small>
              </div>
            </section>
            <OutboundContactsPanel
              agentId={agentId}
              contacts={contacts}
              calls={outboundCalls}
              onCreate={onCreateContact}
              onDeleteAllCalls={onDeleteAllOutboundCalls}
              onDelete={onDeleteContact}
              onRefreshCalls={onRefreshOutboundCalls}
              onRefreshContacts={onRefreshOutboundContacts}
              onRefreshPhoneNumbers={onRefreshPhoneNumbers}
              onSetError={onSetError}
              onUpdate={onUpdateContact}
              phoneNumbers={phoneNumbers}
              selectedSource={selectedVectorSource}
            />
          </>
        )}

        {outboundSection === "test" && (
          <div className="outbound-test-panel">
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
          </div>
        )}

        {outboundSection === "sources" && (
          <section className="workspace-panel outbound-sources-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Knowledge PDF</p>
                <h2>Fonti del centralino in uscita</h2>
              </div>
              <BookOpen size={22} />
            </div>
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
              tree={knowledgeTree}
              canManage={canManageKnowledge}
              onTreeChange={onKnowledgeTreeChange}
              onSetError={onSetError}
            />
          </section>
        )}

        {outboundSection === "appointments" && (
          <AppointmentsPanel
            appointments={appointments}
            onDeleteAll={onDeleteAllAppointments}
            onSetError={onSetError}
          />
        )}

        {outboundSection === "events" && <DebugPanel messages={messages} />}
      </div>
    );
  }

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
          tree={knowledgeTree}
          canManage={canManageKnowledge}
          onTreeChange={onKnowledgeTreeChange}
          onSetError={onSetError}
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

function Modal({
  children,
  eyebrow,
  icon,
  isOpen,
  onClose,
  title,
  wide = false,
}: {
  children: React.ReactNode;
  eyebrow?: string;
  icon?: React.ReactNode;
  isOpen: boolean;
  onClose: () => void;
  title: string;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-modal="true"
        className={`modal-dialog${wide ? " wide" : ""}`}
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div className="modal-title">
            {icon && <span>{icon}</span>}
            <div>
              {eyebrow && <p className="eyebrow">{eyebrow}</p>}
              <h2>{title}</h2>
            </div>
          </div>
          <button className="modal-close" title="Chiudi" type="button" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ConfirmDialog({
  confirmLabel,
  description,
  isBusy,
  isOpen,
  onClose,
  onConfirm,
  title,
}: {
  confirmLabel: string;
  description: string;
  isBusy: boolean;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
}) {
  return (
    <Modal
      eyebrow="Conferma operazione"
      icon={<Trash2 size={20} />}
      isOpen={isOpen}
      onClose={isBusy ? () => undefined : onClose}
      title={title}
    >
      <div className="modal-body">
        <p className="modal-description">{description}</p>
      </div>
      <footer className="modal-actions">
        <button className="secondary-button" disabled={isBusy} type="button" onClick={onClose}>
          Annulla
        </button>
        <button className="danger-button" disabled={isBusy} type="button" onClick={onConfirm}>
          {isBusy ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
          {confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}

function OutboundContactsPanel({
  agentId,
  calls,
  contacts,
  onCreate,
  onDeleteAllCalls,
  onDelete,
  onRefreshCalls,
  onRefreshPhoneNumbers,
  onRefreshContacts,
  onSetError,
  onUpdate,
  phoneNumbers,
  selectedSource,
}: {
  agentId: string | null;
  calls: OutboundCall[];
  contacts: OutboundContact[];
  onCreate: (input: OutboundContactInput) => Promise<void>;
  onDeleteAllCalls: () => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onRefreshCalls: () => Promise<void>;
  onRefreshPhoneNumbers: () => Promise<void>;
  onRefreshContacts: () => Promise<void>;
  onSetError: (value: string | null) => void;
  onUpdate: (id: number, input: OutboundContactInput) => Promise<void>;
  phoneNumbers: ElevenLabsPhoneNumber[];
  selectedSource: string | null;
}) {
  const [reference, setReference] = useState("");
  const [phone, setPhone] = useState("");
  const [isContactModalOpen, setIsContactModalOpen] = useState(false);
  const [isDeleteCallsModalOpen, setIsDeleteCallsModalOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isDeletingCalls, setIsDeletingCalls] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedPhoneNumberId, setSelectedPhoneNumberId] = useState("");
  const [contactFilter, setContactFilter] = useState(() =>
    localStorage.getItem("cp-agent-outbound-contact-filter") ?? "",
  );
  const [selectionMode, setSelectionMode] = useState<"all" | "selected" | "unselected">("all");
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());
  const [campaign, setCampaign] = useState<OutboundCampaign | null>(null);
  const [isCampaignModalOpen, setIsCampaignModalOpen] = useState(false);
  const [isStartingCampaign, setIsStartingCampaign] = useState(false);
  const [isCancellingCampaign, setIsCancellingCampaign] = useState(false);
  const [isDeleteCampaignModalOpen, setIsDeleteCampaignModalOpen] = useState(false);
  const [isDeletingCampaign, setIsDeletingCampaign] = useState(false);
  const [sortField, setSortField] = useState<"reference" | "phone" | "updated_at">("reference");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [editingContact, setEditingContact] = useState<OutboundContact | null>(null);
  const [deletingContact, setDeletingContact] = useState<OutboundContact | null>(null);
  const [editReference, setEditReference] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [isEditingContact, setIsEditingContact] = useState(false);
  const [isDeletingContact, setIsDeletingContact] = useState(false);
  const [activeView, setActiveView] = useState<"contacts" | "campaigns" | "transcripts">("contacts");
  const [campaignHistory, setCampaignHistory] = useState<OutboundCampaign[]>([]);
  const [campaignHistoryPage, setCampaignHistoryPage] = useState(1);
  const [campaignHistoryPages, setCampaignHistoryPages] = useState(1);
  const [campaignHistoryTotal, setCampaignHistoryTotal] = useState(0);
  const [isCampaignHistoryLoading, setIsCampaignHistoryLoading] = useState(false);
  const [detailCampaign, setDetailCampaign] = useState<OutboundCampaign | null>(null);
  const [detailCalls, setDetailCalls] = useState<OutboundCall[]>([]);
  const [isCampaignDetailLoading, setIsCampaignDetailLoading] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importSummary, setImportSummary] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [transcriptFilter, setTranscriptFilter] = useState("");

  useEffect(() => {
    if (
      selectedPhoneNumberId &&
      phoneNumbers.some((number) => number.phone_number_id === selectedPhoneNumberId)
    ) {
      return;
    }
    setSelectedPhoneNumberId(phoneNumbers[0]?.phone_number_id ?? "");
  }, [phoneNumbers, selectedPhoneNumberId]);

  useEffect(() => {
    localStorage.setItem("cp-agent-outbound-contact-filter", contactFilter);
  }, [contactFilter]);

  useEffect(() => {
    setSelectedContactIds((current) => {
      const validIds = new Set(contacts.map((contact) => contact.id));
      return new Set([...current].filter((id) => validIds.has(id)));
    });
  }, [contacts]);

  const refreshCampaignHistory = useCallback(async (page: number) => {
    setIsCampaignHistoryLoading(true);
    try {
      const history = await getOutboundCampaignHistory(page);
      setCampaignHistory(history.items);
      setCampaignHistoryPage(history.page);
      setCampaignHistoryPages(history.pages);
      setCampaignHistoryTotal(history.total);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Caricamento storico campagne fallito");
    } finally {
      setIsCampaignHistoryLoading(false);
    }
  }, [onSetError]);

  const refreshCampaign = useCallback(async () => {
    try {
      const latest = await getLatestOutboundCampaign();
      setCampaign(latest);
      if (latest) {
        setCampaignHistory((current) => current.map((item) => item.id === latest.id ? latest : item));
      }
      if (latest?.status === "completed" || latest?.status === "cancelled") {
        await onRefreshCalls();
      }
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Aggiornamento campagna fallito");
    }
  }, [onRefreshCalls, onSetError]);

  const handleImport = async () => {
    if (!importFile) return;
    setIsImporting(true);
    try {
      const result = await importOutboundContacts(importFile);
      setImportSummary(result);
      await onRefreshContacts();
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Importazione CSV fallita");
    } finally { setIsImporting(false); }
  };

  useEffect(() => {
    void refreshCampaign();
    void refreshCampaignHistory(1);
  }, [refreshCampaign, refreshCampaignHistory]);

  useEffect(() => {
    if (!campaign || !["queued", "running"].includes(campaign.status)) {
      return;
    }
    const timer = window.setInterval(() => void refreshCampaign(), 2000);
    return () => window.clearInterval(timer);
  }, [campaign, refreshCampaign]);

  const filteredContacts = useMemo(() => {
    const query = contactFilter.trim().toLocaleLowerCase("it-IT");
    return contacts.filter((contact) => {
      const matchesQuery =
        !query ||
        contact.reference.toLocaleLowerCase("it-IT").includes(query) ||
        contact.phone.toLocaleLowerCase("it-IT").includes(query);
      const matchesSelection =
        selectionMode === "all" ||
        (selectionMode === "selected" && selectedContactIds.has(contact.id)) ||
        (selectionMode === "unselected" && !selectedContactIds.has(contact.id));
      return matchesQuery && matchesSelection;
    }).sort((left, right) => {
      const comparison = left[sortField].localeCompare(right[sortField], "it-IT", {
        numeric: true,
        sensitivity: "base",
      });
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [contactFilter, contacts, selectedContactIds, selectionMode, sortDirection, sortField]);

  const activeCampaign = campaign && ["queued", "running"].includes(campaign.status);
  const selectedContacts = contacts.filter((contact) => selectedContactIds.has(contact.id));
  const filteredCalls = useMemo(() => {
    const query = transcriptFilter.trim().toLocaleLowerCase("it-IT");
    if (!query) return calls;
    return calls.filter((call) => `${call.reference} ${call.phone} ${call.transcript} ${call.status}`.toLocaleLowerCase("it-IT").includes(query));
  }, [calls, transcriptFilter]);

  const openCampaignDetail = async (selectedCampaign: OutboundCampaign) => {
    setDetailCampaign(selectedCampaign);
    setDetailCalls([]);
    setIsCampaignDetailLoading(true);
    try {
      setDetailCalls(await getOutboundCampaignCalls(selectedCampaign.id));
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Caricamento dettagli campagna fallito");
    } finally {
      setIsCampaignDetailLoading(false);
    }
  };

  const handleStartCampaign = async () => {
    if (!agentId || !selectedPhoneNumberId || selectedContacts.length === 0) {
      return;
    }
    setIsStartingCampaign(true);
    try {
      const created = await createOutboundCampaign({
        contact_ids: selectedContacts.map((contact) => contact.id),
        agent_id: agentId,
        agent_phone_number_id: selectedPhoneNumberId,
        source: selectedSource,
      });
      setCampaign(created);
      setSelectedContactIds(new Set());
      setIsCampaignModalOpen(false);
      await Promise.all([onRefreshCalls(), refreshCampaignHistory(1)]);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Avvio campagna fallito");
    } finally {
      setIsStartingCampaign(false);
    }
  };

  const handleCancelCampaign = async () => {
    if (!campaign) return;
    setIsCancellingCampaign(true);
    try {
      setCampaign(await cancelOutboundCampaign(campaign.id));
      await refreshCampaignHistory(campaignHistoryPage);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Interruzione campagna fallita");
    } finally {
      setIsCancellingCampaign(false);
    }
  };

  const handleDeleteCampaign = async () => {
    if (!campaign) return;
    setIsDeletingCampaign(true);
    try {
      await deleteOutboundCampaign(campaign.id);
      setCampaign(null);
      setIsDeleteCampaignModalOpen(false);
      await Promise.all([onRefreshCalls(), refreshCampaignHistory(campaignHistoryPage)]);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Eliminazione campagna fallita");
    } finally {
      setIsDeletingCampaign(false);
    }
  };

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
      setIsContactModalOpen(false);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Creazione contatto fallita");
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteAllCalls = async () => {
    setIsDeletingCalls(true);
    try {
      await onDeleteAllCalls();
      setIsDeleteCallsModalOpen(false);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Cancellazione chiamate fallita");
    } finally {
      setIsDeletingCalls(false);
    }
  };

  const handleSort = (field: "reference" | "phone" | "updated_at") => {
    if (sortField === field) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortField(field);
    setSortDirection("asc");
  };

  const openEditContact = (contact: OutboundContact) => {
    setEditingContact(contact);
    setEditReference(contact.reference);
    setEditPhone(contact.phone);
  };

  const handleUpdateContact = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingContact || !editReference.trim() || !editPhone.trim()) return;
    setIsEditingContact(true);
    try {
      await onUpdate(editingContact.id, {
        reference: editReference.trim(),
        phone: editPhone.trim(),
      });
      setEditingContact(null);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Aggiornamento contatto fallito");
    } finally {
      setIsEditingContact(false);
    }
  };

  const handleDeleteContact = async () => {
    if (!deletingContact) return;
    setIsDeletingContact(true);
    try {
      await onDelete(deletingContact.id);
      setDeletingContact(null);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Eliminazione contatto fallita");
    } finally {
      setIsDeletingContact(false);
    }
  };

  const SortIcon = ({ field }: { field: "reference" | "phone" | "updated_at" }) => {
    if (sortField !== field) return <ArrowUpDown size={14} />;
    return sortDirection === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />;
  };

  return (
    <section className="workspace-panel contacts-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Chiamate in uscita</p>
          <h2>Anagrafica</h2>
        </div>
        <div className="panel-heading-actions">
          {activeView === "contacts" && <><button className="small-button" type="button" onClick={() => { setImportFile(null); setImportSummary(null); setIsImportOpen(true); }}>
            <FileUp size={16} />Importa CSV
          </button><button className="small-button primary" type="button" onClick={() => setIsContactModalOpen(true)}>
            <UserPlus size={16} />
            Nuovo contatto
          </button></>}
          <Users size={22} />
        </div>
      </div>

      <nav className="data-view-tabs" aria-label="Dati chiamate in uscita">
        <button className={activeView === "contacts" ? "active" : ""} type="button" onClick={() => setActiveView("contacts")}><Users size={16} />Anagrafiche <span>{contacts.length}</span></button>
        <button className={activeView === "campaigns" ? "active" : ""} type="button" onClick={() => setActiveView("campaigns")}><PhoneOutgoing size={16} />Campagne <span>{campaignHistoryTotal}</span></button>
        <button className={activeView === "transcripts" ? "active" : ""} type="button" onClick={() => setActiveView("transcripts")}><BookOpen size={16} />Trascrizioni <span>{calls.length}</span></button>
      </nav>

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

      {activeView === "campaigns" && activeCampaign && campaign && (
        <CampaignProgress
          campaign={campaign}
          isCancelling={isCancellingCampaign}
          onCancel={() => void handleCancelCampaign()}
          onDelete={() => setIsDeleteCampaignModalOpen(true)}
        />
      )}

      {activeView === "campaigns" && (
        <section className="campaign-history-panel">
          <header>
            <div><h3>Storico campagne</h3><span>{campaignHistoryTotal} campagne totali</span></div>
            <button className="icon-button" disabled={isCampaignHistoryLoading} title="Aggiorna storico" type="button" onClick={() => void refreshCampaignHistory(campaignHistoryPage)}>
              <RefreshCw className={isCampaignHistoryLoading ? "spin" : ""} size={16} />
            </button>
          </header>
          {isCampaignHistoryLoading && campaignHistory.length === 0 ? (
            <div className="data-empty-state compact"><Loader2 className="spin" size={22} /><span>Caricamento campagne...</span></div>
          ) : campaignHistory.length === 0 ? (
            <div className="data-empty-state compact"><PhoneOutgoing size={24} /><strong>Nessuna campagna</strong><span>Seleziona le anagrafiche e avvia una serie di chiamate.</span></div>
          ) : (
            <>
              <div className="campaign-history-table-shell">
                <table className="campaign-history-table">
                  <thead><tr><th>Campagna</th><th>Avviata</th><th>Stato</th><th>Contatti</th><th>Esiti</th><th aria-label="Azioni" /></tr></thead>
                  <tbody>{campaignHistory.map((item) => {
                    const processed = item.completed_count + item.failed_count;
                    const label = item.status === "completed" ? "Completata" : item.status === "cancelled" ? "Interrotta" : item.status === "running" ? "In corso" : "In preparazione";
                    return <tr key={item.id}>
                      <td><strong>#{item.id}</strong>{item.id === campaign?.id && <small>Più recente</small>}</td>
                      <td><time>{new Date(item.created_at).toLocaleString("it-IT")}</time></td>
                      <td><span className={`campaign-status-badge ${item.status}`}>{label}</span></td>
                      <td><strong>{processed}</strong><span> / {item.total_count}</span></td>
                      <td><span className="campaign-outcomes success">{item.completed_count} completate</span><span className="campaign-outcomes failed">{item.failed_count} fallite</span></td>
                      <td><button className="small-button" type="button" onClick={() => void openCampaignDetail(item)}><Eye size={15} />Dettagli</button></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
              <footer className="campaign-history-pagination">
                <span>Pagina {campaignHistoryPage} di {campaignHistoryPages}</span>
                <div>
                  <button className="icon-button" disabled={campaignHistoryPage <= 1 || isCampaignHistoryLoading} title="Pagina precedente" type="button" onClick={() => void refreshCampaignHistory(campaignHistoryPage - 1)}><ChevronLeft size={17} /></button>
                  <button className="icon-button" disabled={campaignHistoryPage >= campaignHistoryPages || isCampaignHistoryLoading} title="Pagina successiva" type="button" onClick={() => void refreshCampaignHistory(campaignHistoryPage + 1)}><ChevronRight size={17} /></button>
                </div>
              </footer>
            </>
          )}
        </section>
      )}

      {activeView === "contacts" && <>

      <div className="contact-filter-bar">
        <label className="contact-search">
          <Search size={16} />
          <input
            aria-label="Cerca contatti"
            placeholder="Cerca per riferimento o numero"
            value={contactFilter}
            onChange={(event) => setContactFilter(event.target.value)}
          />
        </label>
        <div className="contact-filter-modes" aria-label="Filtra contatti">
          {(["all", "selected", "unselected"] as const).map((mode) => (
            <button
              className={selectionMode === mode ? "active" : ""}
              key={mode}
              type="button"
              onClick={() => setSelectionMode(mode)}
            >
              {mode === "all" ? "Tutti" : mode === "selected" ? "Selezionati" : "Da selezionare"}
            </button>
          ))}
        </div>
      </div>

      <div className="contact-selection-bar">
        <label className="selection-toggle">
          <input
            checked={filteredContacts.length > 0 && filteredContacts.every((contact) => selectedContactIds.has(contact.id))}
            type="checkbox"
            onChange={(event) => {
              setSelectedContactIds((current) => {
                const next = new Set(current);
                filteredContacts.forEach((contact) => event.target.checked ? next.add(contact.id) : next.delete(contact.id));
                return next;
              });
            }}
          />
          Seleziona visibili
        </label>
        <span>{selectedContactIds.size} selezionati</span>
        <button
          className="small-button primary"
          disabled={Boolean(activeCampaign) || selectedContactIds.size === 0 || !agentId || !selectedPhoneNumberId}
          type="button"
          onClick={() => setIsCampaignModalOpen(true)}
        >
          <PhoneOutgoing size={16} />
          Avvia serie
        </button>
      </div>

      <div className="contacts-table-shell">
        <table className="contacts-table">
          <thead>
            <tr>
              <th className="contact-check-column">
                <input
                  aria-label="Seleziona tutti i contatti visibili"
                  checked={filteredContacts.length > 0 && filteredContacts.every((contact) => selectedContactIds.has(contact.id))}
                  type="checkbox"
                  onChange={(event) => {
                    setSelectedContactIds((current) => {
                      const next = new Set(current);
                      filteredContacts.forEach((contact) => event.target.checked ? next.add(contact.id) : next.delete(contact.id));
                      return next;
                    });
                  }}
                />
              </th>
              <th><button type="button" onClick={() => handleSort("reference")}>Riferimento <SortIcon field="reference" /></button></th>
              <th><button type="button" onClick={() => handleSort("phone")}>Telefono <SortIcon field="phone" /></button></th>
              <th><button type="button" onClick={() => handleSort("updated_at")}>Ultima modifica <SortIcon field="updated_at" /></button></th>
              <th className="contact-actions-column">Azioni</th>
            </tr>
          </thead>
          <tbody>
            {filteredContacts.length === 0 ? (
              <tr><td className="contacts-empty" colSpan={5}>Nessun contatto corrisponde ai filtri.</td></tr>
            ) : (
              filteredContacts.map((contact) => (
                <OutboundContactTableRow
                  contact={contact}
                  key={contact.id}
                  onDelete={() => setDeletingContact(contact)}
                  onEdit={() => openEditContact(contact)}
                  selected={selectedContactIds.has(contact.id)}
                  onSelectedChange={(selected) => setSelectedContactIds((current) => {
                    const next = new Set(current);
                    selected ? next.add(contact.id) : next.delete(contact.id);
                    return next;
                  })}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="contacts-table-footer">
        <span>{filteredContacts.length} di {contacts.length} contatti</span>
        <span>Ordinati per {sortField === "reference" ? "riferimento" : sortField === "phone" ? "telefono" : "ultima modifica"}</span>
      </div>

      </>}


      {activeView === "transcripts" && <><div className="transcript-toolbar"><label className="contact-search"><Search size={16} /><input aria-label="Cerca nelle trascrizioni" placeholder="Cerca nome, numero o testo trascritto" value={transcriptFilter} onChange={(event) => setTranscriptFilter(event.target.value)} /></label></div><div className="call-history-heading">
        <h3>Chiamate recenti</h3>
        <div className="call-history-actions">
          <span>{filteredCalls.length}</span>
          <button
            className="small-button danger"
            disabled={calls.length === 0 || isDeletingCalls}
            type="button"
            onClick={() => setIsDeleteCallsModalOpen(true)}
          >
            {isDeletingCalls ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
            Pulisci
          </button>
        </div>
      </div>
      <div className="call-history-list">
        {filteredCalls.length === 0 ? (
          <p className="muted">Nessuna chiamata corrisponde alla ricerca.</p>
        ) : (
          filteredCalls.map((call) => <OutboundCallRow call={call} key={call.id} />)
        )}
      </div>
      </>}

      <Modal
        eyebrow="Storico campagne"
        icon={<PhoneOutgoing size={20} />}
        isOpen={Boolean(detailCampaign)}
        onClose={() => setDetailCampaign(null)}
        title={`Campagna #${detailCampaign?.id ?? ""}`}
        wide
      >
        {detailCampaign && <div className="modal-body campaign-detail">
          <div className="campaign-detail-summary">
            <div><span>Stato</span><strong>{detailCampaign.status === "completed" ? "Completata" : detailCampaign.status === "cancelled" ? "Interrotta" : detailCampaign.status === "running" ? "In corso" : "In preparazione"}</strong></div>
            <div><span>Contatti</span><strong>{detailCampaign.total_count}</strong></div>
            <div><span>Completate</span><strong>{detailCampaign.completed_count}</strong></div>
            <div><span>Fallite</span><strong>{detailCampaign.failed_count}</strong></div>
            <div><span>Avviata</span><strong>{new Date(detailCampaign.created_at).toLocaleString("it-IT")}</strong></div>
          </div>
          {isCampaignDetailLoading ? (
            <div className="data-empty-state compact"><Loader2 className="spin" size={22} /><span>Caricamento chiamate e trascrizioni...</span></div>
          ) : (
            <div className="campaign-detail-items">
              {detailCampaign.items.map((item) => {
                const call = detailCalls.find((entry) => entry.id === item.outbound_call_id);
                const statusLabel = item.status === "completed" ? "Completata" : item.status === "failed" ? "Fallita" : item.status === "cancelled" ? "Annullata" : item.status === "calling" ? "In chiamata" : "In attesa";
                return <article className="campaign-detail-item" key={item.id}>
                  <header>
                    <span className="campaign-detail-position">{item.position}</span>
                    <div><strong>{item.reference}</strong><small>{item.phone}</small></div>
                    <span className={`campaign-status-badge ${item.status}`}>{statusLabel}</span>
                  </header>
                  {(item.error || call?.error) && <p className="campaign-detail-error">{item.error || call?.error}</p>}
                  {call?.transcript ? <details className="campaign-detail-transcript"><summary><BookOpen size={15} />Trascrizione</summary><pre>{call.transcript}</pre></details> : <p className="campaign-detail-no-transcript">Trascrizione non disponibile</p>}
                </article>;
              })}
            </div>
          )}
        </div>}
        <footer className="modal-actions"><button className="secondary-button" type="button" onClick={() => setDetailCampaign(null)}>Chiudi</button></footer>
      </Modal>

      <Modal eyebrow="Anagrafiche" icon={<FileUp size={20} />} isOpen={isImportOpen} onClose={isImporting ? () => undefined : () => setIsImportOpen(false)} title="Importa da CSV">
        <div className="modal-body modal-form">
          <label className="csv-dropzone"><FileUp size={24} /><strong>{importFile?.name ?? "Seleziona un file CSV"}</strong><span>Colonne richieste: riferimento (o nome) e telefono</span><input accept=".csv,text/csv" type="file" onChange={(event) => { setImportFile(event.target.files?.[0] ?? null); setImportSummary(null); }} /></label>
          {importSummary && <div className="import-result"><strong>{importSummary.imported} importati</strong><span>{importSummary.skipped} ignorati</span>{importSummary.errors.length > 0 && <details><summary>Dettagli righe non importate</summary>{importSummary.errors.map((error) => <p key={error}>{error}</p>)}</details>}</div>}
        </div>
        <footer className="modal-actions"><button className="secondary-button" disabled={isImporting} type="button" onClick={() => setIsImportOpen(false)}>Chiudi</button><button className="primary-button" disabled={!importFile || isImporting || Boolean(importSummary)} type="button" onClick={() => void handleImport()}>{isImporting ? <Loader2 className="spin" size={16} /> : <FileUp size={16} />}Importa</button></footer>
      </Modal>

      <Modal
        eyebrow="Anagrafica"
        icon={<UserPlus size={20} />}
        isOpen={isContactModalOpen}
        onClose={isCreating ? () => undefined : () => setIsContactModalOpen(false)}
        title="Nuovo contatto"
      >
        <form onSubmit={handleCreate}>
          <div className="modal-body modal-form">
            <label>
              <span>Riferimento</span>
              <input
                autoFocus
                disabled={isCreating}
                placeholder="Nome o azienda"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            </label>
            <label>
              <span>Numero di telefono</span>
              <input
                disabled={isCreating}
                placeholder="+39 345 123 4567"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>
          </div>
          <footer className="modal-actions">
            <button
              className="secondary-button"
              disabled={isCreating}
              type="button"
              onClick={() => setIsContactModalOpen(false)}
            >
              Annulla
            </button>
            <button
              className="primary-button"
              disabled={isCreating || !reference.trim() || !phone.trim()}
              type="submit"
            >
              {isCreating ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
              Aggiungi contatto
            </button>
          </footer>
        </form>
      </Modal>

      <ConfirmDialog
        confirmLabel="Elimina campagna"
        description="La campagna e il relativo avanzamento verranno rimossi. I contatti, gli appuntamenti e la cronologia delle chiamate già effettuate resteranno disponibili."
        isBusy={isDeletingCampaign}
        isOpen={isDeleteCampaignModalOpen}
        onClose={() => setIsDeleteCampaignModalOpen(false)}
        onConfirm={() => void handleDeleteCampaign()}
        title="Eliminare questa campagna?"
      />

      <ConfirmDialog
        confirmLabel="Cancella cronologia"
        description="Verranno eliminate tutte le chiamate recenti e le relative trascrizioni salvate. Contatti e appuntamenti non saranno modificati."
        isBusy={isDeletingCalls}
        isOpen={isDeleteCallsModalOpen}
        onClose={() => setIsDeleteCallsModalOpen(false)}
        onConfirm={() => void handleDeleteAllCalls()}
        title="Pulire le chiamate recenti?"
      />

      <Modal
        eyebrow="Anagrafica"
        icon={<Pencil size={20} />}
        isOpen={Boolean(editingContact)}
        onClose={isEditingContact ? () => undefined : () => setEditingContact(null)}
        title="Modifica contatto"
      >
        <form onSubmit={handleUpdateContact}>
          <div className="modal-body modal-form">
            <label>
              <span>Riferimento</span>
              <input autoFocus disabled={isEditingContact} value={editReference} onChange={(event) => setEditReference(event.target.value)} />
            </label>
            <label>
              <span>Numero di telefono</span>
              <input disabled={isEditingContact} type="tel" value={editPhone} onChange={(event) => setEditPhone(event.target.value)} />
            </label>
          </div>
          <footer className="modal-actions">
            <button className="secondary-button" disabled={isEditingContact} type="button" onClick={() => setEditingContact(null)}>Annulla</button>
            <button className="primary-button" disabled={isEditingContact || !editReference.trim() || !editPhone.trim()} type="submit">
              {isEditingContact ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
              Salva modifiche
            </button>
          </footer>
        </form>
      </Modal>

      <ConfirmDialog
        confirmLabel="Elimina contatto"
        description={`Il contatto ${deletingContact?.reference ?? ""} verrà rimosso dall'anagrafica. La cronologia delle chiamate resterà disponibile.`}
        isBusy={isDeletingContact}
        isOpen={Boolean(deletingContact)}
        onClose={() => setDeletingContact(null)}
        onConfirm={() => void handleDeleteContact()}
        title="Eliminare questo contatto?"
      />

      <Modal
        eyebrow="Chiamate in serie"
        icon={<PhoneOutgoing size={20} />}
        isOpen={isCampaignModalOpen}
        onClose={isStartingCampaign ? () => undefined : () => setIsCampaignModalOpen(false)}
        title={`Avviare ${selectedContacts.length} chiamate?`}
      >
        <div className="modal-body">
          <p className="modal-description">
            I contatti verranno chiamati uno alla volta. La chiamata successiva partirà solo dopo il salvataggio della trascrizione precedente.
          </p>
          <div className="campaign-preview-list">
            {selectedContacts.map((contact, index) => (
              <div key={contact.id}><span>{index + 1}</span><strong>{contact.reference}</strong><small>{contact.phone}</small></div>
            ))}
          </div>
        </div>
        <footer className="modal-actions">
          <button className="secondary-button" disabled={isStartingCampaign} type="button" onClick={() => setIsCampaignModalOpen(false)}>Annulla</button>
          <button className="primary-button" disabled={isStartingCampaign} type="button" onClick={() => void handleStartCampaign()}>
            {isStartingCampaign ? <Loader2 className="spin" size={16} /> : <PhoneOutgoing size={16} />}
            Avvia chiamate
          </button>
        </footer>
      </Modal>
    </section>
  );
}

function CampaignProgress({
  campaign,
  isCancelling,
  onCancel,
  onDelete,
}: {
  campaign: OutboundCampaign;
  isCancelling: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const processed = campaign.completed_count + campaign.failed_count;
  const percent = campaign.total_count ? Math.round((processed / campaign.total_count) * 100) : 0;
  const isActive = ["queued", "running"].includes(campaign.status);
  const statusLabel = {
    queued: "In preparazione",
    running: "In corso",
    completed: "Completata",
    cancelled: "Interrotta",
  }[campaign.status];

  return (
    <section className={`campaign-progress ${campaign.status}`}>
      <header>
        <div>
          <p className="eyebrow">Campagna #{campaign.id}</p>
          <h3>{statusLabel}</h3>
        </div>
        <div className="campaign-progress-summary">
          <strong>{processed} / {campaign.total_count}</strong>
          <span>{percent}%</span>
        </div>
      </header>
      <div className="campaign-progress-track" aria-label={`Avanzamento ${percent}%`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="campaign-stepper">
        {campaign.items.map((item) => (
          <div className={`campaign-step ${item.status}`} key={item.id}>
            <span className="campaign-step-icon">
              {item.status === "completed" ? <Check size={15} /> : item.status === "calling" ? <Loader2 className="spin" size={15} /> : item.status === "failed" ? <X size={15} /> : <Circle size={12} />}
            </span>
            <div><strong>{item.reference}</strong><small>{item.phone}</small></div>
            <span className="campaign-step-status">
              {item.status === "pending" ? "In attesa" : item.status === "calling" ? "In chiamata" : item.status === "completed" ? "Trascritta" : item.status === "failed" ? "Fallita" : "Annullata"}
            </span>
            {item.error && <p>{item.error}</p>}
          </div>
        ))}
      </div>
      <footer>
        <span>{campaign.failed_count > 0 ? `${campaign.failed_count} fallite` : "Nessun errore"}</span>
        <div className="campaign-actions">
          {isActive && (
            <button className="small-button danger" disabled={isCancelling} type="button" onClick={onCancel}>
              {isCancelling ? <Loader2 className="spin" size={15} /> : <Square size={14} />}
              Blocca campagna
            </button>
          )}
          <button className="small-button danger subtle" type="button" onClick={onDelete}>
            <Trash2 size={15} />
            Elimina
          </button>
        </div>
      </footer>
    </section>
  );
}

function OutboundContactRow({
  canCall,
  contact,
  onCall,
  onDelete,
  onSelectedChange,
  onSetError,
  onUpdate,
  selected,
}: {
  canCall: boolean;
  contact: OutboundContact;
  onCall: () => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onSelectedChange: (selected: boolean) => void;
  onSetError: (value: string | null) => void;
  onUpdate: (id: number, input: OutboundContactInput) => Promise<void>;
  selected: boolean;
}) {
  const [reference, setReference] = useState(contact.reference);
  const [phone, setPhone] = useState(contact.phone);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
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
    setIsBusy(true);
    try {
      await onDelete(contact.id);
    } catch (err) {
      onSetError(err instanceof Error ? err.message : "Eliminazione contatto fallita");
      setIsBusy(false);
    }
  };

  const isUnchanged = reference === contact.reference && phone === contact.phone;

  return (
    <>
      <article className="contact-row">
        <label className="contact-select" title="Seleziona per la serie">
          <input
            aria-label={`Seleziona ${contact.reference}`}
            checked={selected}
            disabled={isBusy}
            type="checkbox"
            onChange={(event) => onSelectedChange(event.target.checked)}
          />
        </label>
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
            onClick={() => setIsDeleteModalOpen(true)}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </article>
      <ConfirmDialog
        confirmLabel="Elimina contatto"
        description={`Il contatto ${contact.reference} verrà rimosso dall'anagrafica. La cronologia delle chiamate resterà disponibile.`}
        isBusy={isBusy}
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={() => void handleDelete()}
        title="Eliminare questo contatto?"
      />
    </>
  );
}


function OutboundContactTableRow({
  contact,
  onDelete,
  onEdit,
  onSelectedChange,
  selected,
}: {
  contact: OutboundContact;
  onDelete: () => void;
  onEdit: () => void;
  onSelectedChange: (selected: boolean) => void;
  selected: boolean;
}) {
  return (
    <tr className={selected ? "selected" : ""}>
      <td className="contact-check-column">
        <label className="contact-select" title="Seleziona per la serie">
          <input
            aria-label={`Seleziona ${contact.reference}`}
            checked={selected}
            type="checkbox"
            onChange={(event) => onSelectedChange(event.target.checked)}
          />
        </label>
      </td>
      <td>
        <div className="contact-reference-cell">
          <span>{contact.reference.slice(0, 1).toLocaleUpperCase("it-IT")}</span>
          <strong>{contact.reference}</strong>
        </div>
      </td>
      <td><a className="contact-phone" href={`tel:${contact.phone}`}>{contact.phone}</a></td>
      <td>
        <span className="contact-date">
          {new Date(contact.updated_at).toLocaleDateString("it-IT", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })}
        </span>
      </td>
      <td className="contact-actions-column">
        <div className="contact-actions">
          <button className="icon-button contact-icon-button" title="Modifica contatto" type="button" onClick={onEdit}>
            <Pencil size={16} />
          </button>
          <button className="icon-button contact-icon-button danger" title="Elimina contatto" type="button" onClick={onDelete}>
            <Trash2 size={16} />
          </button>
        </div>
      </td>
    </tr>
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
  canManage,
  name,
  onChange,
  onSetError,
  onTreeChange,
  selectedSource,
  sources,
  tree,
}: {
  allSourcesDescription: string;
  canManage: boolean;
  name: string;
  onChange: (source: string | null) => void;
  onSetError: (value: string | null) => void;
  onTreeChange: (tree: KnowledgeTree) => void;
  selectedSource: string | null;
  sources: VectorStoreSource[];
  tree: KnowledgeTree;
}) {
  const [isManaging, setIsManaging] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [editor, setEditor] = useState<{ kind: "area" | "module"; id?: number; parentId?: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: "area" | "module"; id: number; name: string } | null>(null);
  const draggedItem = useRef<{ kind: "areas" | "modules" | "documents"; id: number } | null>(null);

  const documentCount = (areaId: number) => tree.areas.find((area) => area.id === areaId)?.modules.reduce((sum, module) => sum + module.documents.length, 0) ?? 0;
  const runTreeAction = async (action: () => Promise<KnowledgeTree>) => {
    setIsBusy(true);
    onSetError(null);
    try { onTreeChange(await action()); return true; }
    catch (error) { onSetError(error instanceof Error ? error.message : "Aggiornamento fonti fallito"); return false; }
    finally { setIsBusy(false); }
  };
  const saveEditor = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editor?.name.trim()) return;
    const saved = await runTreeAction(() => editor.kind === "area"
      ? editor.id ? updateKnowledgeArea(editor.id, editor.name.trim()) : createKnowledgeArea(editor.name.trim())
      : editor.id ? updateKnowledgeModule(editor.id, editor.parentId!, editor.name.trim()) : createKnowledgeModule(editor.parentId!, editor.name.trim()));
    if (saved) setEditor(null);
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    const removed = await runTreeAction(() => deleting.kind === "area" ? deleteKnowledgeArea(deleting.id) : deleteKnowledgeModule(deleting.id));
    if (removed) setDeleting(null);
  };
  const moveDragged = async (kind: "areas" | "modules" | "documents", parentId: number | null, position: number) => {
    const dragged = draggedItem.current;
    if (!dragged || dragged.kind !== kind) return;
    draggedItem.current = null;
    await runTreeAction(() => moveKnowledgeItem(kind, dragged.id, parentId, position));
  };

  return (
    <div className={`knowledge-selector${isManaging ? " managing" : ""}`}>
      <div className="knowledge-selector-toolbar">
        <div><strong>Ambito della conoscenza</strong><span>{knowledgeScopeLabel(selectedSource, tree)}</span></div>
        {canManage && <button className={`small-button${isManaging ? " primary" : ""}`} type="button" onClick={() => setIsManaging((value) => !value)}><GripVertical size={15} />{isManaging ? "Fine" : "Organizza"}</button>}
      </div>
      <div className="vector-sources knowledge-tree">
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
      {tree.areas.map((area, areaIndex) => <section
        className="knowledge-area"
        draggable={isManaging}
        key={area.id}
        onDragStart={() => { draggedItem.current = { kind: "areas", id: area.id }; }}
        onDragOver={(event) => { if (isManaging) event.preventDefault(); }}
        onDrop={() => { const dragged = draggedItem.current; if (dragged?.kind === "modules") void moveDragged("modules", area.id, area.modules.length); else void moveDragged("areas", null, areaIndex); }}
      >
        <header>
          {isManaging && <GripVertical className="drag-handle" size={16} />}
          <label><input checked={selectedSource === `area:${area.id}`} disabled={documentCount(area.id) === 0} name={name} type="radio" onChange={() => onChange(`area:${area.id}`)} /><Folder size={17} /><strong>{area.name}</strong><span>{documentCount(area.id)} documenti</span></label>
          {isManaging && <div className="knowledge-actions"><button title="Nuovo modulo" type="button" onClick={() => setEditor({ kind: "module", parentId: area.id, name: "" })}><FolderPlus size={15} /></button><button title="Rinomina area" type="button" onClick={() => setEditor({ kind: "area", id: area.id, name: area.name })}><Pencil size={14} /></button><button title="Elimina area" type="button" onClick={() => setDeleting({ kind: "area", id: area.id, name: area.name })}><Trash2 size={14} /></button></div>}
        </header>
        <div className="knowledge-modules">
          {area.modules.map((module, moduleIndex) => <section
            className="knowledge-module"
            draggable={isManaging}
            key={module.id}
            onDragStart={(event) => { event.stopPropagation(); draggedItem.current = { kind: "modules", id: module.id }; }}
            onDragOver={(event) => { if (isManaging) event.preventDefault(); }}
            onDrop={(event) => { event.stopPropagation(); const dragged = draggedItem.current; if (dragged?.kind === "documents") void moveDragged("documents", module.id, module.documents.length); else void moveDragged("modules", area.id, moduleIndex); }}
          >
            <header>{isManaging && <GripVertical className="drag-handle" size={15} />}<label><input checked={selectedSource === `module:${module.id}`} disabled={module.documents.length === 0} name={name} type="radio" onChange={() => onChange(`module:${module.id}`)} /><strong>{module.name}</strong><span>{module.documents.length}</span></label>{isManaging && <div className="knowledge-actions"><button title="Rinomina modulo" type="button" onClick={() => setEditor({ kind: "module", id: module.id, parentId: area.id, name: module.name })}><Pencil size={14} /></button><button title="Elimina modulo" type="button" onClick={() => setDeleting({ kind: "module", id: module.id, name: module.name })}><Trash2 size={14} /></button></div>}</header>
            <div className="knowledge-documents">{module.documents.map((document, documentIndex) => <label className="knowledge-document" draggable={isManaging} key={document.id} onDragStart={(event) => { event.stopPropagation(); draggedItem.current = { kind: "documents", id: document.id }; }} onDragOver={(event) => { if (isManaging) event.preventDefault(); }} onDrop={(event) => { event.stopPropagation(); void moveDragged("documents", module.id, documentIndex); }}>{isManaging && <GripVertical className="drag-handle" size={14} />}<input checked={selectedSource === `document:${document.id}`} name={name} type="radio" onChange={() => onChange(`document:${document.id}`)} /><BookOpen size={15} /><span><strong>{document.source}</strong><small>{document.chunks} chunk</small></span></label>)}</div>
          </section>)}
          {area.modules.length === 0 && <p className="knowledge-empty">Nessun modulo in quest'area.</p>}
        </div>
      </section>)}
      {tree.unassigned_documents.length > 0 && <section className="knowledge-unassigned" onDragOver={(event) => { if (isManaging) event.preventDefault(); }} onDrop={() => void moveDragged("documents", null, tree.unassigned_documents.length)}><header><strong>Non organizzati</strong><span>{tree.unassigned_documents.length}</span></header>{tree.unassigned_documents.map((document, index) => <label className="knowledge-document" draggable={isManaging} key={document.id} onDragStart={() => { draggedItem.current = { kind: "documents", id: document.id }; }} onDragOver={(event) => { if (isManaging) event.preventDefault(); }} onDrop={(event) => { event.stopPropagation(); void moveDragged("documents", null, index); }}>{isManaging && <GripVertical className="drag-handle" size={14} />}<input checked={selectedSource === `document:${document.id}`} name={name} type="radio" onChange={() => onChange(`document:${document.id}`)} /><BookOpen size={15} /><span><strong>{document.source}</strong><small>{document.chunks} chunk</small></span></label>)}</section>}
      {tree.areas.length === 0 && tree.unassigned_documents.length === 0 && sources.length === 0 && <p className="knowledge-empty standalone">Nessun documento indicizzato.</p>}
      </div>
      {isManaging && <button className="knowledge-add-area" disabled={isBusy} type="button" onClick={() => setEditor({ kind: "area", name: "" })}><Plus size={15} />Nuova area</button>}
      <Modal eyebrow="Organizzazione fonti" icon={editor?.kind === "area" ? <Folder size={19} /> : <FolderPlus size={19} />} isOpen={Boolean(editor)} onClose={isBusy ? () => undefined : () => setEditor(null)} title={`${editor?.id ? "Modifica" : "Nuova"} ${editor?.kind === "area" ? "area" : "modulo"}`}><form onSubmit={(event) => void saveEditor(event)}><div className="modal-body modal-form"><label><span>Nome</span><input autoFocus disabled={isBusy} value={editor?.name ?? ""} onChange={(event) => setEditor((current) => current ? { ...current, name: event.target.value } : current)} /></label></div><footer className="modal-actions"><button className="secondary-button" disabled={isBusy} type="button" onClick={() => setEditor(null)}>Annulla</button><button className="primary-button" disabled={isBusy || !editor?.name.trim()} type="submit">{isBusy ? <Loader2 className="spin" size={15} /> : <Save size={15} />}Salva</button></footer></form></Modal>
      <ConfirmDialog confirmLabel="Elimina" description={`I documenti contenuti in ${deleting?.name ?? "questo elemento"} verranno spostati tra quelli non organizzati e non saranno cancellati.`} isBusy={isBusy} isOpen={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={() => void confirmDelete()} title={`Eliminare ${deleting?.kind === "area" ? "l'area" : "il modulo"}?`} />
    </div>
  );
}

function EmbeddedPresentationApp({ currentUser, onLogout }: { currentUser: AuthUser; onLogout: () => Promise<void> }) {
  const [config, setConfig] = useState<ElevenLabsConfig | null>(null);
  const [tree, setTree] = useState<KnowledgeTree>({ areas: [], unassigned_documents: [] });
  const [sources, setSources] = useState<VectorStoreSource[]>([]);
  const [selectedSource, setSelectedSource] = useState<string | null | undefined>(undefined);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canUsePrincipalTenant = currentUser.tenant_id === 1 || currentUser.role === "superadmin";

  useEffect(() => {
    if (!canUsePrincipalTenant) return;
    Promise.all([getElevenLabsConfig(), getKnowledgeTree(), getVectorStoreSources()])
      .then(([nextConfig, nextTree, nextSources]) => {
        setConfig(nextConfig);
        setTree(nextTree);
        setSources(nextSources);
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Caricamento presentazione fallito"));
  }, [canUsePrincipalTenant]);

  const selectedLabel = selectedSource === undefined ? null : knowledgeScopeLabel(selectedSource, tree);
  useEffect(() => {
    const state: EmbeddedPresentationState = isActive
      ? "active"
      : !canUsePrincipalTenant || selectedSource === undefined
        ? "logged-in"
        : "pdf-selected";
    postEmbeddedPresentationState(state, selectedLabel ? { knowledgeSource: selectedSource, knowledgeSourceLabel: selectedLabel } : {});
  }, [canUsePrincipalTenant, isActive, selectedLabel, selectedSource]);

  const searchKnowledge = useCallback(async (input: { query?: string; limit?: number }) => {
    const query = input.query?.trim();
    if (!query) return "Query mancante. Specifica cosa cercare nella documentazione.";
    const response = await searchVectorStore(query, Math.min(Math.max(input.limit ?? 4, 1), 6), selectedSource ?? null);
    if (response.results.length === 0) return `Nessun risultato trovato per: ${query}`;
    return response.results.map((result, index) => `RISULTATO ${index + 1}\nFonte: ${result.source}\nTesto:\n${result.text}`).join("\n\n---\n\n");
  }, [selectedSource]);

  const providerConfig = useMemo(() => ({
    clientTools: { searchKnowledge },
    onError: (message: unknown) => setError(readableEvent(message)),
  }), [searchKnowledge]);

  if (!canUsePrincipalTenant) {
    return <main className="embedded-presentation"><section className="embedded-message"><Presentation size={24} /><h1>Tenant non autorizzato</h1><p>Questa presentazione utilizza esclusivamente il tenant principale.</p><button className="secondary-button" type="button" onClick={() => void onLogout()}>Esci</button></section></main>;
  }

  if (!currentUser.can_presentation) {
    return <main className="embedded-presentation"><section className="embedded-message"><Presentation size={24} /><h1>Presentazione non disponibile</h1><p>Questo utente non dispone del permesso Presentazione.</p><button className="secondary-button" type="button" onClick={() => void onLogout()}>Esci</button></section></main>;
  }

  const presentationAgentId = config?.presentation_agent_id
    ?? config?.agents.find((agent) => /present/i.test(agent.name))?.agent_id
    ?? config?.agents[0]?.agent_id
    ?? null;
  const presentationAgent = config?.agents.find((agent) => agent.agent_id === presentationAgentId);
  const optionGroups = tree.areas.map((area) => ({
    area,
    documents: area.modules.flatMap((module) => module.documents),
  }));

  return <ConversationProvider {...providerConfig}>
    <main className="embedded-presentation">
      <header className="embedded-header"><div><span className="embedded-brand-mark">CP</span><div><strong>CP AGENT</strong><small>Presentazione assistita</small></div></div><button className="icon-button" title="Esci" type="button" onClick={() => void onLogout()}><LogOut size={17} /></button></header>
      {error && <div className="error-banner"><span>{error}</span><button type="button" onClick={() => setError(null)}>Chiudi</button></div>}
      <section className="embedded-source-step">
        <div className="embedded-step-heading"><span>1</span><div><strong>Scegli la fonte</strong><small>Seleziona il contenuto da presentare.</small></div></div>
        <select aria-label="Fonte della presentazione" disabled={isActive} value={selectedSource === undefined ? "" : selectedSource ?? "__all__"} onChange={(event) => setSelectedSource(event.target.value === "" ? undefined : event.target.value === "__all__" ? null : event.target.value)}>
          <option value="">Seleziona una fonte...</option>
          <option value="__all__">Tutte le fonti</option>
          {optionGroups.map(({ area }) => <optgroup key={area.id} label={`Area: ${area.name}`}>
            {area.modules.length > 0 && <option disabled={area.modules.every((module) => module.documents.length === 0)} value={`area:${area.id}`}>Intera area - {area.name}</option>}
            {area.modules.flatMap((module) => [
              <option disabled={module.documents.length === 0} key={`module:${module.id}`} value={`module:${module.id}`}>Modulo - {module.name}</option>,
              ...module.documents.map((document) => <option key={`document:${document.id}`} value={`document:${document.id}`}>Documento - {document.source}</option>),
            ])}
          </optgroup>)}
          {tree.unassigned_documents.length > 0 && <optgroup label="Documenti non organizzati">{tree.unassigned_documents.map((document) => <option key={`document:${document.id}`} value={`document:${document.id}`}>{document.source}</option>)}</optgroup>}
          {tree.areas.length === 0 && tree.unassigned_documents.length === 0 && sources.map((source) => <option key={source.source} value={source.source}>{source.source}</option>)}
        </select>
      </section>
      {selectedSource !== undefined && config ? <section className="embedded-active-step">
        <div className="embedded-step-heading"><span>2</span><div><strong>{isActive ? "Presentazione in corso" : "Avvia la presentazione"}</strong><small>{selectedLabel}</small></div></div>
        <VoicePanel
          agentId={presentationAgentId}
          agentName={presentationAgent?.name}
          contextMode="presentazione"
          elevenLabsConfig={config}
          embedded
          onActiveChange={setIsActive}
          onSetError={setError}
          onVoiceContextChange={() => undefined}
          retrievalQuery={null}
          selectedVectorSource={selectedSource}
          startButtonLabel="Avvia presentazione"
          startPrompt={buildPresentationStartPrompt(selectedSource)}
          title="Presentazione vocale"
        />
      </section> : !config ? <div className="embedded-loading"><Loader2 className="spin" size={22} />Caricamento</div> : null}
    </main>
  </ConversationProvider>;
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
  knowledgeTree,
  canManageKnowledge,
  onKnowledgeTreeChange,
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
  knowledgeTree: KnowledgeTree;
  canManageKnowledge: boolean;
  onKnowledgeTreeChange: (tree: KnowledgeTree) => void;
}) {
  const selectedAgent = elevenLabsConfig.agents.find(
    (agent) => agent.agent_id === agentId,
  );
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
          tree={knowledgeTree}
          canManage={canManageKnowledge}
          onTreeChange={onKnowledgeTreeChange}
          onSetError={onSetError}
        />

        <div className="presentation-summary">
          <strong>Pronto per presentare</strong>
          <span>Agente: {selectedAgent?.name || "non configurato"}</span>
          <span>Fonte: {knowledgeScopeLabel(selectedVectorSource, knowledgeTree)}</span>
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
  embedded = false,
  onBeforeStart,
  onActiveChange,
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
  embedded?: boolean;
  onBeforeStart?: () => void;
  onActiveChange?: (active: boolean) => void;
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
  const usageEventIdRef = useRef<number | null>(null);
  const usageSessionActiveRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const isConnected = status === "connected";
  const effectiveAgentId = agentId || null;
  const effectiveAgentName = agentName || "non configurato";
  const isAgentConfigured = Boolean(elevenLabsConfig.configured && effectiveAgentId);

  useEffect(() => {
    onActiveChange?.(isConnected);
  }, [isConnected, onActiveChange]);

  const finishTrackedSession = useCallback((sessionStatus: "completed" | "failed" | "cancelled" = "completed") => {
    const eventId = usageEventIdRef.current;
    usageSessionActiveRef.current = false;
    if (!eventId) return;
    usageEventIdRef.current = null;
    void finishUsageSession(eventId, sessionStatus).catch((error) => console.warn("Usage session finish failed", error));
  }, []);

  useEffect(() => {
    if (isConnected) {
      wasConnectedRef.current = true;
    } else if (wasConnectedRef.current) {
      wasConnectedRef.current = false;
      finishTrackedSession("completed");
    }
  }, [finishTrackedSession, isConnected]);

  useEffect(() => () => finishTrackedSession("cancelled"), [finishTrackedSession]);

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
      let conversationId: string | null = null;
      if (connectionMode === "webrtc") {
        const response = await getConversationToken(effectiveAgentId, contextMode);
        const started = await startSession({
          conversationToken: response.token,
          connectionType: "webrtc",
          textOnly: false,
        });
        conversationId = typeof started === "string" ? started : null;
      } else {
        const response = await getSignedUrl(effectiveAgentId, contextMode);
        const started = await startSession({
          signedUrl: response.signed_url,
          connectionType: "websocket",
          textOnly: false,
        });
        conversationId = typeof started === "string" ? started : null;
      }
      const channel = contextMode === "centralino-entrata" ? "inbound" : contextMode === "centralino-uscita" ? "outbound" : "presentation";
      usageSessionActiveRef.current = true;
      startUsageSession({ channel, origin: "web", conversation_id: conversationId, agent_id: effectiveAgentId, source: selectedVectorSource })
        .then((event) => {
          if (usageSessionActiveRef.current) usageEventIdRef.current = event.id;
          else void finishUsageSession(event.id, "completed");
        })
        .catch((error) => console.warn("Usage session start failed", error));
    } catch (err) {
      onVoiceContextChange(null);
      onSetError(err instanceof Error ? err.message : "Avvio sessione fallito");
    } finally {
      setIsStarting(false);
    }
  };

  const handleEnd = () => {
    onVoiceContextChange(null);
    finishTrackedSession("completed");
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
    <section className={`workspace-panel voice-panel${embedded ? " embedded-voice-panel" : ""}`}>
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

      {contextMode === "presentazione" && !isConnected && <MicrophonePermissionControl onSetError={onSetError} />}

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

type MicrophonePermissionState = "checking" | "prompt" | "granted" | "denied" | "unsupported";

function MicrophonePermissionControl({ onSetError }: { onSetError: (value: string | null) => void }) {
  const [permission, setPermission] = useState<MicrophonePermissionState>("checking");

  useEffect(() => {
    let active = true;
    let status: PermissionStatus | null = null;
    const updatePermission = () => {
      if (active && status) setPermission(status.state as "prompt" | "granted" | "denied");
    };

    if (!navigator.permissions?.query) {
      setPermission("unsupported");
      return () => { active = false; };
    }

    navigator.permissions.query({ name: "microphone" as PermissionName })
      .then((nextStatus) => {
        if (!active) return;
        status = nextStatus;
        updatePermission();
        status.addEventListener("change", updatePermission);
      })
      .catch(() => active && setPermission("unsupported"));

    return () => {
      active = false;
      status?.removeEventListener("change", updatePermission);
    };
  }, []);

  const requestMicrophone = async () => {
    setPermission("checking");
    onSetError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setPermission("granted");
    } catch (requestError) {
      const errorName = requestError instanceof DOMException ? requestError.name : "";
      const denied = errorName === "NotAllowedError" || errorName === "SecurityError";
      setPermission(denied ? "denied" : "unsupported");
      onSetError(
        denied
          ? "Microfono non autorizzato. Premi l'icona del lucchetto nella barra degli indirizzi, imposta Microfono su Consenti e riprova."
          : "Impossibile usare il microfono. Verifica che sia collegato e non sia occupato da un'altra applicazione.",
      );
    }
  };

  const labels: Record<MicrophonePermissionState, string> = {
    checking: "Verifica microfono...",
    prompt: "Abilita microfono",
    granted: "Microfono abilitato",
    denied: "Riprova microfono",
    unsupported: "Verifica microfono",
  };

  return <div className={`microphone-permission microphone-permission-${permission}`}>
    <div>
      {permission === "granted" ? <Mic size={18} /> : <MicOff size={18} />}
      <span>{permission === "granted" ? "Microfono pronto" : permission === "denied" ? "Il browser sta bloccando il microfono" : "Autorizza il microfono prima di iniziare"}</span>
    </div>
    <button className="secondary-button" disabled={permission === "checking"} type="button" onClick={() => void requestMicrophone()}>
      {permission === "checking" ? <Loader2 className="spin" size={16} /> : permission === "granted" ? <Check size={16} /> : <Mic size={16} />}
      {labels[permission]}
    </button>
  </div>;
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
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteAll = async () => {
    setIsDeleting(true);
    try {
      await onDeleteAll();
      setIsDeleteModalOpen(false);
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
            onClick={() => setIsDeleteModalOpen(true)}
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
      <ConfirmDialog
        confirmLabel="Cancella appuntamenti"
        description="Verranno eliminati tutti gli appuntamenti salvati. Questa operazione non modifica contatti e cronologia chiamate."
        isBusy={isDeleting}
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={() => void handleDeleteAll()}
        title="Cancellare tutti gli appuntamenti?"
      />
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

function LoginScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      onAuthenticated(await login(username, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Accesso non riuscito");
    } finally {
      setIsSubmitting(false);
    }
  };

  return <main className="login-page">
    <section className="login-visual">
      <img className="login-logo" src="/centro-paghe-logo.png" alt="Gruppo Centro Paghe" />
      <h1><span>CP</span> AGENT</h1>
      <p>La piattaforma vocale per gestire centralino, chiamate commerciali e presentazioni assistite.</p>
    </section>
    <section className="login-panel">
      <div className="login-heading"><p className="eyebrow">Area riservata</p><h2>Accesso</h2><p>Inserisci le credenziali assegnate dall’amministratore.</p></div>
      {error && <div className="login-error">{error}</div>}
      <form className="login-form" onSubmit={submit}>
        <label><span>Username</span><input autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label><span>Password</span><input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button className="primary-button" disabled={isSubmitting || !username.trim() || !password} type="submit">{isSubmitting ? <Loader2 className="spin" size={17} /> : <LogOut size={17} />}Accedi</button>
      </form>
    </section>
  </main>;
}

function RootApp() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);

  useEffect(() => {
    getCurrentUser().then(setCurrentUser).catch(() => setCurrentUser(null)).finally(() => setIsCheckingSession(false));
    const clearSession = () => setCurrentUser(null);
    window.addEventListener("jk-auth-expired", clearSession);
    return () => window.removeEventListener("jk-auth-expired", clearSession);
  }, []);

  useEffect(() => {
    if (isEmbeddedPresentation && !isCheckingSession && !currentUser) {
      postEmbeddedPresentationState("idle");
    }
  }, [currentUser, isCheckingSession]);

  if (isCheckingSession) {
    return <main className="login-page"><Loader2 className="spin" size={28} /></main>;
  }
  if (!currentUser) {
    return <div className={isEmbeddedPresentation ? "embedded-login-shell" : undefined}><LoginScreen onAuthenticated={setCurrentUser} /></div>;
  }
  if (isEmbeddedPresentation) {
    return <EmbeddedPresentationApp currentUser={currentUser} onLogout={async () => { await logout(); setCurrentUser(null); }} />;
  }
  return <App currentUser={currentUser} onLogout={async () => { await logout(); setCurrentUser(null); }} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
);
