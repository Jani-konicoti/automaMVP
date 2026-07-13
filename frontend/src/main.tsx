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
  Send,
  Save,
  Square,
} from "lucide-react";
import {
  Appointment,
  AppointmentInput,
  createAppointment,
  getConversationToken,
  getKnowledge,
  getSignedUrl,
  listAppointments,
  saveKnowledge,
} from "./api";
import "./styles.css";

const KNOWLEDGE_LIMIT = 12_000;

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

function buildContextUpdate(knowledge: string) {
  const clipped = knowledge.slice(0, KNOWLEDGE_LIMIT);
  return `
Contesto operativo per questa conversazione.
Rispondi in italiano, in modo naturale, breve e professionale.
Usa la knowledge testuale qui sotto per rispondere a domande su servizi, orari, regole, prezzi o procedure.
Se la knowledge non contiene la risposta, dillo con chiarezza e proponi di lasciare un appuntamento o un recapito.

Quando l'utente vuole fissare, spostare o richiedere un appuntamento:
1. raccogli nome del cliente, data, ora, telefono se disponibile, e motivo;
2. se manca un dato essenziale, chiedilo;
3. quando hai nome, data e ora, chiama il tool client scheduleAppointment;
4. dopo il tool, conferma l'esito usando la risposta del tool.

KNOWLEDGE:
${clipped || "Nessuna knowledge caricata."}
`.trim();
}

function App() {
  const [knowledge, setKnowledge] = useState("");
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAppointments = useCallback(async () => {
    const rows = await listAppointments();
    setAppointments(rows);
  }, []);

  useEffect(() => {
    Promise.all([getKnowledge(), listAppointments()])
      .then(([knowledgeResponse, appointmentRows]) => {
        setKnowledge(knowledgeResponse.text);
        setAppointments(appointmentRows);
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
      setKnowledge(response.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Salvataggio fallito");
    } finally {
      setIsSaving(false);
    }
  }, [knowledge]);

  const scheduleAppointment = useCallback(
    async (input: AppointmentInput) => {
      const created = await createAppointment(input);
      await refreshAppointments();
      return `Appuntamento inserito con ID ${created.id} per ${created.customer_name} il ${created.date} alle ${created.time}.`;
    },
    [refreshAppointments],
  );

  const providerConfig = useMemo(
    () => ({
      clientTools: {
        scheduleAppointment,
      },
      onMessage: (message: unknown) => {
        setMessages((current) => [`message: ${readableEvent(message)}`, ...current].slice(0, 12));
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
    [scheduleAppointment],
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
        onRefreshAppointments={refreshAppointments}
        onSaveKnowledge={handleSaveKnowledge}
        onSetError={setError}
      />
    </ConversationProvider>
  );
}

type ShellProps = {
  appointments: Appointment[];
  error: string | null;
  isLoading: boolean;
  isSaving: boolean;
  knowledge: string;
  messages: string[];
  onKnowledgeChange: (value: string) => void;
  onRefreshAppointments: () => Promise<void>;
  onSaveKnowledge: () => Promise<void>;
  onSetError: (value: string | null) => void;
};

function Shell({
  appointments,
  error,
  isLoading,
  isSaving,
  knowledge,
  messages,
  onKnowledgeChange,
  onSaveKnowledge,
  onSetError,
}: ShellProps) {
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
          <textarea
            disabled={isLoading}
            value={knowledge}
            onChange={(event) => onKnowledgeChange(event.target.value)}
          />
          <div className="meter-row">
            <span>{knowledge.length.toLocaleString("it-IT")} caratteri</span>
            <span>Prompt demo: max {KNOWLEDGE_LIMIT.toLocaleString("it-IT")}</span>
          </div>
        </div>

        <div className="right-column">
          <VoicePanel knowledge={knowledge} />
          <AppointmentsPanel appointments={appointments} />
          <DebugPanel messages={messages} />
        </div>
      </section>
    </main>
  );
}

function VoicePanel({ knowledge }: { knowledge: string }) {
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
