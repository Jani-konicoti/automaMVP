# Connettore WikiWeb Centro Paghe

Il connettore importa la documentazione testuale di WikiWeb nel RAG esistente di CP AGENTS. Non crea un secondo vector store e non scarica PDF, immagini o altri allegati.

## Organizzazione

- Tenant: `principale` per impostazione predefinita.
- Area: `Paghe Web`.
- Modulo: ramo e prima sezione della Wiki, per esempio `Manuale / Dipendenti`.
- Documento: singola pagina MediaWiki.
- Percorsi alternativi: conservati in `mediawiki_page_paths` senza duplicare il documento.

## Configurazione

Inserire in `.env.production`:

```dotenv
MEDIAWIKI_BASE_URL=https://wikiweb.centropaghe.it
MEDIAWIKI_ROOT_PAGE=Help_On_Line
MEDIAWIKI_USERNAME=utente-api
MEDIAWIKI_PASSWORD=password-o-bot-password
MEDIAWIKI_TENANT=principale
MEDIAWIKI_AREA=Paghe Web
MEDIAWIKI_SYNC_INTERVAL_MINUTES=15
MEDIAWIKI_FULL_SYNC_HOURS=24
MEDIAWIKI_VERIFY_SSL=true
```

È preferibile utilizzare una Bot Password MediaWiki. Se il nome bot è associato a un utente, lo username può avere il formato `NomeUtente@NomeBot`.

Non salvare le credenziali nel repository.

La verifica SSL deve restare attiva in produzione. `MEDIAWIKI_VERIFY_SSL=false` è previsto esclusivamente per ambienti locali con proxy aziendali che intercettano HTTPS.

## Dry-run

Il dry-run accede alla Wiki, attraversa un numero limitato di pagine e mostra titolo, percorso, modulo, testo estratto ed elementi scartati. Non scrive nel database.

Con Docker:

```bash
docker compose --env-file .env.production run --rm mediawiki-sync \
  python -m app.mediawiki_sync --dry-run --limit 10
```

In locale dalla cartella `backend`:

```bash
python -m app.mediawiki_sync --dry-run --limit 10
```

## Prima importazione

```bash
docker compose --env-file .env.production run --rm mediawiki-sync \
  python -m app.mediawiki_sync --full
```

Il comando crea l'Area `Paghe Web`, i moduli individuati e i documenti. Una pagina viene indicizzata una sola volta tramite il suo `page_id`.

## Sincronizzazione automatica

Il servizio `mediawiki-sync` viene avviato con il normale compose:

```bash
docker compose --env-file .env.production up -d --build
```

Controllo log:

```bash
docker compose --env-file .env.production logs -f mediawiki-sync
```

Ogni 15 minuti il worker consulta `recentchanges`. Se rileva modifiche, ricostruisce la navigazione e aggiorna soltanto le pagine il cui hash testuale è cambiato. Ogni 24 ore forza una riconciliazione completa.

Una sincronizzazione parziale o fallita non elimina documenti esistenti.

## Sincronizzazione manuale

Incrementale:

```bash
docker compose --env-file .env.production run --rm mediawiki-sync \
  python -m app.mediawiki_sync --incremental
```

Completa:

```bash
docker compose --env-file .env.production run --rm mediawiki-sync \
  python -m app.mediawiki_sync --full
```

## Test

Dalla cartella `backend`:

```bash
python -m unittest discover -s tests -v
```
