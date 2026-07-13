# Centralino AI MVP

MVP per demo: React + Python/FastAPI + ElevenLabs Conversational AI.

## Cosa fa

- Carichi knowledge testuale, senza PDF e senza vector store.
- Avvii una conversazione vocale realtime con un agente ElevenLabs.
- L'agente risponde usando la knowledge inserita nel prompt di sessione.
- Quando l'utente chiede un appuntamento, l'agente chiama il client tool `scheduleAppointment`.
- Il tool chiama FastAPI e salva l'appuntamento in SQLite.

## Setup backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Compila `backend/.env`:

```env
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=agent_...
```

Avvio:

```powershell
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## Setup frontend

```powershell
cd frontend
pnpm install
Copy-Item .env.example .env
pnpm dev
```

Apri `http://localhost:5173`.

## Configurazione ElevenLabs

Nel tuo agente ElevenLabs crea un Client tool:

- Name: `scheduleAppointment`
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

Per questa demo la knowledge viene passata come prompt override da React. Se il tuo workspace ElevenLabs richiede l'abilitazione esplicita degli override, abilita gli override del prompt sull'agente.
