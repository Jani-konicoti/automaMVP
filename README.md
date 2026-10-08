# CP DEMO

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

## Deploy Docker in produzione

Il deployment usa quattro servizi:

- `frontend`: Nginx serve React e costituisce l'unico ingresso pubblico;
- `backend`: FastAPI applicativo, non esposto direttamente;
- `gateway`: espone internamente soltanto tool e webhook ElevenLabs;
- `cloudflared`: opzionale, attivo solo con il profilo `tunnel`.

SQLite, PDF, configurazione e utenti sono persistiti nella cartella host
`server-data/`, esclusa da Git. Il backend usa un solo worker per evitare accessi
concorrenti non necessari al database SQLite.

### Primo deploy

Sul server Linux con Git, Docker Engine e Docker Compose plugin installati:

```bash
git clone https://github.com/Jani-konicoti/automaMVP.git
cd automaMVP
cp .env.production.example .env.production
nano .env.production
docker compose --env-file .env.production up -d --build
```

Imposta almeno:

```env
APP_URL=https://demo.example.it
APP_BIND_ADDRESS=127.0.0.1
APP_PORT=8080
COOKIE_SECURE=true
INITIAL_ADMIN_PASSWORD=una-password-iniziale-lunga
```

`INITIAL_ADMIN_PASSWORD` viene usata solo se il database non contiene ancora
utenti. Accedi come `admin` e cambiala comunque dall'applicazione.

Per trasferire sul server configurazione, utenti, PDF indicizzati, appuntamenti e
cronologia già presenti in locale, copia il contenuto di `backend/data/` nella
cartella `server-data/` del server prima del primo `docker compose up`. Se vuoi
partire da un'installazione pulita, lascia `server-data/` vuota.

Se il dominio viene terminato da Nginx, Caddy, Traefik o un load balancer esterno,
inoltra il traffico verso `http://127.0.0.1:8080`. Se vuoi raggiungere direttamente
la porta dall'esterno, imposta `APP_BIND_ADDRESS=0.0.0.0` e proteggila con il
firewall. Non pubblicare direttamente le porte 8001 e 8002.

### Cloudflare Tunnel gestito

Per sostituire il quick tunnel provvisorio:

1. In Cloudflare Zero Trust crea un tunnel permanente.
2. Aggiungi un Public Hostname per `demo.example.it`.
3. Come servizio del tunnel usa `http://frontend:80`.
4. Copia il token del tunnel in `.env.production`:

```env
CLOUDFLARE_TUNNEL_TOKEN=token-generato-da-cloudflare
```

Avvia anche il profilo tunnel:

```bash
docker compose --env-file .env.production --profile tunnel up -d --build
```

Nginx instrada automaticamente i percorsi dei tool e del post-call webhook al
gateway ristretto. Nell'app, `Configurazione > Integrazione`, l'URL pubblico deve
coincidere con `APP_URL`. Su un database nuovo viene inizializzato automaticamente.
Se `APP_URL` cambia, il backend aggiorna il valore persistito al riavvio.

Il tunnel è facoltativo: lasciando vuoto `CLOUDFLARE_TUNNEL_TOKEN`, Compose avvia
solo applicazione e gateway per l'uso dietro un reverse proxy tradizionale.

### Aggiornamenti

Dopo il primo deploy puoi aggiornare con:

```bash
sh ./scripts/deploy.sh
```

Lo script esegue `git pull --ff-only`, ricostruisce le immagini e abilita
automaticamente il profilo Cloudflare se trova il token. In alternativa:

```bash
git pull --ff-only
docker compose --env-file .env.production up -d --build --remove-orphans
```

Comandi utili:

```bash
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs -f --tail=200
docker compose --env-file .env.production restart
```

### Backup

Prima di aggiornamenti importanti, salva l'intera cartella persistente:

```bash
tar -czf cp-demo-data-$(date +%F-%H%M).tar.gz server-data/
```

Non eseguire più repliche del backend sullo stesso file SQLite. Per scalare su più
istanze sarà necessario migrare il database a PostgreSQL e coordinare le campagne
di chiamata con una coda condivisa.
