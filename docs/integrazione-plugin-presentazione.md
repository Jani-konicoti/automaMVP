# Integrazione CP AGENT nel plugin

Questa guida descrive come integrare la modalità Presentazione di CP AGENT in un iframe visualizzato all'interno di un modale.

## 1. URL dell'iframe

La vista dedicata è disponibile all'indirizzo:

```text
https://demo.centropaghe.it/presentazione-cpeople
```

Il portale che ospita il plugin è multitenant e il sottodominio cambia per ogni cliente. Il parametro `parentOrigin` deve quindi essere generato dinamicamente utilizzando l'origine della pagina corrente:

```js
const cpAgentBaseUrl = "https://demo.centropaghe.it";

const cpAgentUrl =
  `${cpAgentBaseUrl}/presentazione-cpeople` +
  `?parentOrigin=${encodeURIComponent(window.location.origin)}`;
```

Non deve essere passato alcun tenant di CP AGENT nell'URL: questa modalità utilizza sempre il tenant principale.

## 2. Creazione dell'iframe

```html
<iframe
  id="cp-agent-presentation"
  title="Presentazione CP AGENT"
  allow="microphone"
></iframe>
```

```js
const iframe = document.getElementById("cp-agent-presentation");
iframe.src = cpAgentUrl;
```

L'attributo `allow="microphone"` è obbligatorio. Senza questo attributo il browser può bloccare il microfono anche quando l'utente ha concesso l'autorizzazione.

Se viene utilizzato l'attributo `sandbox`, devono essere presenti almeno i seguenti permessi:

```html
sandbox="allow-scripts allow-forms allow-same-origin"
```

Se il `sandbox` non è necessario, è preferibile non impostarlo.

## 3. Dimensioni consigliate

```css
.cp-agent-modal {
  width: min(720px, calc(100vw - 32px));
  height: min(760px, calc(100vh - 32px));
}

.cp-agent-modal iframe {
  border: 0;
  display: block;
  height: 100%;
  width: 100%;
}
```

Su dispositivi piccoli il modale dovrebbe occupare quasi tutto lo schermo.

## 4. Eventi inviati dall'iframe

CP AGENT comunica con la pagina contenitore tramite `window.postMessage`.

```js
const cpAgentOrigin = "https://demo.centropaghe.it";
let cpAgentState = "idle";

window.addEventListener("message", (event) => {
  if (event.origin !== cpAgentOrigin) return;

  const message = event.data;

  if (message?.source !== "cp-agent") return;
  if (message?.type !== "cp-agent:presentation-state") return;

  cpAgentState = message.state;

  switch (message.state) {
    case "idle":
      // L'utente deve ancora effettuare il login.
      break;

    case "logged-in":
      // Login completato: l'utente sta scegliendo la fonte.
      break;

    case "pdf-selected":
      // Fonte selezionata: la presentazione può essere avviata.
      break;

    case "active":
      // Presentazione vocale in corso.
      break;
  }
});
```

È necessario verificare sempre `event.origin`. Non bisogna accettare indiscriminatamente messaggi provenienti da altri siti.

## 5. Formato del messaggio

```js
{
  source: "cp-agent",
  type: "cp-agent:presentation-state",
  state: "pdf-selected",
  knowledgeSource: "document:12",
  knowledgeSourceLabel: "Manuale CPeople.pdf"
}
```

`knowledgeSource` può rappresentare:

| Valore | Significato |
| --- | --- |
| `null` | Tutte le fonti |
| `area:3` | Un'intera area |
| `module:8` | Un modulo |
| `document:12` | Un singolo documento |

I campi `knowledgeSource` e `knowledgeSourceLabel` sono presenti dopo la selezione della fonte.

## 6. Flusso degli stati

Il flusso normale è:

```text
idle -> logged-in -> pdf-selected -> active -> pdf-selected
```

| Stato | Significato |
| --- | --- |
| `idle` | Utente non autenticato |
| `logged-in` | Login completato e selezione della fonte in corso |
| `pdf-selected` | Fonte selezionata e sistema pronto per l'avvio |
| `active` | Presentazione vocale in corso |

Quando la conversazione termina, CP AGENT torna automaticamente a `pdf-selected` mantenendo la fonte selezionata. L'utente può quindi avviare una nuova presentazione senza ripetere la selezione.

## 7. Apertura e chiusura del modale

È consigliato creare l'iframe una sola volta e nascondere il modale senza distruggerlo. In questo modo una presentazione attiva non viene interrotta accidentalmente.

Durante lo stato `active`, la chiusura del modale dovrebbe essere disabilitata oppure richiedere una conferma:

```js
function closeCpAgentModal() {
  if (cpAgentState === "active") {
    const confirmed = window.confirm(
      "La presentazione è ancora in corso. Vuoi chiudere il pannello?"
    );

    if (!confirmed) return;
  }

  hideModal();
}
```

Nascondere l'iframe non interrompe necessariamente la conversazione. Distruggerlo o ricaricarlo interrompe invece la sessione.

## 8. Autorizzazione del microfono

La schermata CP AGENT contiene il pulsante **Abilita microfono**, che richiede l'autorizzazione e verifica che l'audio sia disponibile.

Il programmatore del plugin deve assicurarsi che:

- l'iframe abbia l'attributo `allow="microphone"`;
- la pagina del plugin sia servita in HTTPS;
- nessuna intestazione `Permissions-Policy` del portale blocchi il microfono.

Se il portale invia una propria intestazione `Permissions-Policy`, deve autorizzare CP AGENT:

```http
Permissions-Policy: microphone=(self "https://demo.centropaghe.it")
```

## 9. Autenticazione e tenant

Il login avviene direttamente dentro l'iframe. Le credenziali devono appartenere al tenant principale di CP AGENT oppure a un superadmin.

Il plugin non deve trasmettere token, password o identificativi del tenant. La sessione viene gestita direttamente da CP AGENT tramite cookie sicuro.

## 10. Configurazione richiesta sul server CP AGENT

Il server CP AGENT deve autorizzare il dominio principale e tutti i sottodomini `centropaghe.it`:

```dotenv
IFRAME_ANCESTORS='self' https://centropaghe.it https://*.centropaghe.it
COOKIE_SAMESITE=none
COOKIE_SECURE=true
```

Questa configurazione viene gestita sul server CP AGENT e non nel plugin.

## Checklist finale

- Generare `parentOrigin` con `window.location.origin`.
- Usare l'URL `/presentazione-cpeople`.
- Inserire `allow="microphone"` nell'iframe.
- Verificare `event.origin` prima di elaborare un messaggio.
- Gestire gli stati `idle`, `logged-in`, `pdf-selected` e `active`.
- Non distruggere l'iframe durante una presentazione attiva.
- Verificare che la `Permissions-Policy` del portale consenta il microfono.
- Non trasmettere credenziali o identificativi del tenant dal plugin.
