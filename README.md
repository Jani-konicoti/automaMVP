# JK Automa

Applicazione React + Python/FastAPI + ElevenLabs Conversational AI.

## Accesso iniziale

Al primo avvio viene creato l'amministratore locale:

```text
username: admin
password: Cambiami24!
```

Cambia subito la password dal menu account nella barra laterale. Gli amministratori
possono creare altri admin e utenti, assegnando separatamente i moduli Centralino
Entrata, Centralino Uscita e Presentazione. Le password sono salvate come hash
PBKDF2 e le sessioni browser usano cookie HttpOnly.

## Cosa fa

- Carichi e indicizzi uno o piu PDF nel vector store locale.
- Selezioni separatamente agente e fonte per Centralino e Presentazione.
- Avvii una conversazione vocale realtime con un agente ElevenLabs.
- L'agente risponde usando la knowledge inserita nel prompt di sessione.
- Le sessioni browser usano client tool; le chiamate telefoniche usano webhook tool server-side.
- L'agente cerca nei PDF e salva gli appuntamenti in SQLite anche durante le chiamate Twilio.
- Il Centralino Uscita avvia chiamate reali e conserva stato e trascrizione.

## Setup backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Compila `backend/.env` solo per impostazioni tecniche locali:

```env
FRONTEND_ORIGIN=http://localhost:5173
ELEVENLABS_VERIFY_SSL=true
COOKIE_SECURE=false
```

In produzione, con frontend e API pubblicati in HTTPS, imposta `COOKIE_SECURE=true`.

Le credenziali ElevenLabs si configurano dall'app nella pagina `Configurazione`:

- `ElevenLabs API key`
- uno o piu `agent_id`

L'agente da usare viene scelto direttamente nel flusso `Centralino` o `Presentazione`.

Avvio:

```powershell
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Il gateway pubblico espone esclusivamente i webhook e deve restare separato dal
backend applicativo:

```powershell
uvicorn app.public_gateway:public_app --host 127.0.0.1 --port 8002
```

Collega il tunnel HTTPS alla porta `8002`, mai direttamente alla porta del backend.

## Setup frontend

```powershell
cd frontend
pnpm install
Copy-Item .env.example .env
pnpm dev
```

Apri `http://localhost:5173`.

## Configurazione ElevenLabs

Quando il backend ha un URL HTTPS pubblico, sostituisci i due Client tool con due
Webhook tool mantenendo gli stessi nomi. I Webhook tool funzionano sia nelle
sessioni browser sia nelle chiamate telefoniche. Usa gli URL mostrati nella pagina
`Configurazione` e l'header `X-JK-Automa-Key`.

Webhook `scheduleAppointment`:

- Name: `scheduleAppointment`
- Method: `POST`
- URL: `/api/tools/schedule-appointment`
- Header: `X-JK-Automa-Key`, valore mostrato nella configurazione
- Description: `Create an appointment after collecting customer name, date, time, phone if available, and appointment notes.`
- Wait for response: enabled
- Parameters:
  - `customer_name`, string, required
  - `date`, string, required, description: `Appointment date in YYYY-MM-DD format`
  - `time`, string, required, description: `Appointment time in HH:MM format`
  - `phone`, string, optional
  - `notes`, string, optional

Nel prompt base dell'agente puoi mettere una frase minima, ad esempio:

```text
You are an Italian receptionist. Follow the session prompt and use the available tools when needed.
```

Webhook `searchKnowledge`:

- Method: `POST`
- URL: `/api/tools/search-knowledge`
- Header: `X-JK-Automa-Key`, valore mostrato nella configurazione
- `query`, string, required
- `limit`, integer, optional
- `conversation_id`, dynamic variable `system__conversation_id`
- `agent_id`, dynamic variable `system__agent_id`
- `knowledge_source`, dynamic variable `knowledge_source`, optional

In `Developers > Webhooks` configura anche il post-call webhook mostrato nell'app,
abilita l'evento di trascrizione e salva nell'app il signing secret generato da ElevenLabs.
