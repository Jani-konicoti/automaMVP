# Presentazione CP AGENT in iframe

URL della vista dedicata:

```text
https://demo.centropaghe.it/presentazione-cpeople?parentOrigin=https%3A%2F%2Fplugin.example.it
```

`parentOrigin` deve contenere l'origine esatta della pagina che ospita il plugin.
La vista utilizza sempre il tenant principale (`tenant_id = 1`); le credenziali devono appartenere al tenant principale oppure a un superadmin.

## Incorporamento

```html
<iframe
  src="https://demo.centropaghe.it/presentazione-cpeople?parentOrigin=https%3A%2F%2Fplugin.example.it"
  allow="microphone"
  title="Presentazione CP AGENT"
></iframe>
```

Nel server CP AGENT, `IFRAME_ANCESTORS` deve autorizzare l'origine del plugin:

```dotenv
IFRAME_ANCESTORS='self' https://plugin.example.it
COOKIE_SAMESITE=none
COOKIE_SECURE=true
```

## Eventi

L'iframe invia gli eventi con `window.parent.postMessage`:

```js
{
  source: "cp-agent",
  type: "cp-agent:presentation-state",
  state: "idle" | "logged-in" | "pdf-selected" | "active",
  knowledgeSource: "document:12",
  knowledgeSourceLabel: "Manuale CPeople.pdf"
}
```

`knowledgeSource` e `knowledgeSourceLabel` sono presenti dopo la selezione della fonte.
Quando la presentazione termina, lo stato torna a `pdf-selected`.

Esempio di ricezione nel plugin:

```js
const cpAgentOrigin = "https://demo.centropaghe.it";

window.addEventListener("message", (event) => {
  if (event.origin !== cpAgentOrigin) return;
  if (event.data?.source !== "cp-agent") return;
  if (event.data?.type !== "cp-agent:presentation-state") return;

  const { state, knowledgeSource, knowledgeSourceLabel } = event.data;
  // Aggiornare il modale del plugin in base allo stato ricevuto.
});
```
