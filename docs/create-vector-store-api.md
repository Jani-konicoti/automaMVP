# API caricamento PDF

L'endpoint indicizza un PDF nel vector store esistente di CP AGENTS e lo colloca nel tenant, nell'area e nel modulo indicati.

## Endpoint

```http
POST /api/create-vector-store
Authorization: Bearer <VECTOR_STORE_API_TOKEN>
Content-Type: multipart/form-data
```

Campi multipart:

| Campo | Tipo | Descrizione |
| --- | --- | --- |
| `file` | PDF | Documento da indicizzare, massimo 24 MB |
| `tenant` | stringa | ID numerico oppure slug del tenant attivo |
| `area` | stringa | Area esistente o da creare |
| `module` | stringa | Modulo esistente o da creare dentro l'area |

Esempio:

```bash
curl -X POST "https://demo.centropaghe.it/api/create-vector-store" \
  -H "Authorization: Bearer $VECTOR_STORE_API_TOKEN" \
  -F "tenant=principale" \
  -F "area=CPeople" \
  -F "module=Documenti" \
  -F "file=@CPeople_CP_SKILLS.pdf;type=application/pdf"
```

Risposta alla creazione:

```json
{
  "status": "created",
  "tenant_id": 1,
  "tenant": "principale",
  "area": "CPeople",
  "module": "Documenti",
  "source": "CPeople_CP_SKILLS.pdf",
  "pages": 12,
  "extracted_chars": 28410,
  "indexed_chunks": 18
}
```

Se nello stesso tenant, area e modulo esiste gia un documento con lo stesso filename, i suoi chunk vengono sostituiti e `status` vale `updated`.

Se lo stesso filename e gia presente in un'altra area o modulo dello stesso tenant, l'API risponde `409` e non modifica il documento esistente.

## Configurazione

Nel file `.env.production` impostare un token lungo e casuale:

```dotenv
VECTOR_STORE_API_TOKEN=...
```

Il token consente di scegliere qualsiasi tenant attivo e deve essere condiviso solo con i sistemi autorizzati.
