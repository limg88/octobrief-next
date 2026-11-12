# Demo 03 — Conoscenza (incremento 2b)

**Durata**: circa 5 minuti. **Cosa dimostra**:
- la lettura dei documenti da parte del modello, che propone fatti; il codice li accetta solo se la citazione è scritta così nel testo;
- la pseudonimizzazione obbligatoria: nomi ed email non arrivano mai al modello, e tornano al loro posto nei fatti salvati;
- le contraddizioni fra documenti, tenute visibili e mai risolte in silenzio;
- i vettori (embeddings) di ogni brano, pronti per la ricerca dell'incremento 4;
- i permessi (RLS) e l'effetto dell'eliminazione di un documento sui fatti.

**Prerequisiti**:
- Node 24, pnpm 12 e Docker avviato;
- porte 3310, 4320 e 5450 libere: se hai lasciato accesa una demo precedente, fermala con il `kill` stampato alla sua fine.

Il modello è **finto e deterministico** (nessuna rete, nessun costo) e i documenti sono **sintetici**. Per usare il gateway reale vedi l'ultima sezione.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/03-conoscenza/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | Prerequisiti e database | `Schema up to date` (o `Migrations applied: 0003_knowledge.sql` la prima volta) | La migrazione 0003 crea `facts`, `fact_sources` e la colonna `vector(1024)` sui brani |
| 2 | Documenti sintetici | 4 file: due SAL, una nota del fornitore, una nota con «Paola Prova» | Nessun dato reale nel repo |
| 3 | Avvio e progetto | `Web pronto…`, `progetto borea-…` | Il worker parte con il modello finto (`LLM_BACKEND=fake`, il default) |
| 4 | Lettura di 3 documenti | `tutti i documenti letti` e l'elenco dei fatti, ciascuno con brano, file e posizione | Dopo estrazione e classificazione parte da solo il job `document.compile` |
| 5 | Citazioni verificate | `N citazioni su N trovate parola per parola`; la frase «Ignora le istruzioni…» non è un fatto | Un fatto esiste solo con la sua fonte esatta; il testo dei documenti è un dato, non un'istruzione |
| 6 | Pseudonimizzazione | nessun «Paola», nessuna email; `Il modello ha letto: [PERSONA_1] deve inviare…`; nel fatto c'è «Paola Prova» | La catena `guardia → pseudonimizzatore → modello` nasconde i nomi all'andata e li ripristina al ritorno |
| 7 | Vettori | `nessun brano senza vettore`, `codificatore fake-embedding@v1, dimensioni 1024` | Ogni brano ha il suo embedding, con il codificatore che l'ha prodotto |
| 8 | Contraddizione | due righe `[economics] Budget complessivo…  ⚠ in contraddizione`; l'avanzamento è un solo fatto con due fonti | Due documenti in disaccordo restano entrambi visibili; due in accordo si sommano |
| 9 | Permessi ed eliminazione | Marco: `404`; dopo l'eliminazione della revisione resta un solo budget, non più in contraddizione | RLS sui fatti; un fatto vive finché un documento lo dichiara |

Ciò che il modello ha ricevuto resta in `.tmp/demo-03-modello.jsonl` (una riga JSON per chiamata).

## Parte nel browser (circa 3 minuti)

10. Apri l'indirizzo stampato alla fine (`…/projects/borea-…/memory`) e accedi come **Paola Prova**.
    Sotto la tabella dei documenti c'è **«Cosa ho capito»**: i fatti raggruppati per tipo (Stato, Milestone, Rischi, Azioni, Economia), ognuno con il brano citato, il file e la posizione.
11. Carica di nuovo `.tmp/demo-03-docs/SAL-Borea-rev2-2026-11-05.md` dal riquadro di caricamento.
    Compare «1 documento ancora in lettura…» e, dopo qualche secondo, i due budget con l'etichetta **in contraddizione**.
12. Elimina la revisione dalla tabella: il budget torna uno solo e l'etichetta sparisce.

Per fermare tutto: il comando `kill` stampato alla fine della parte automatica.

## Con il gateway reale (facoltativo)

In `.env.local`:

```bash
LLM_BACKEND=llm-api
LLM_API_URL=https://<gateway>
LLM_API_TOKEN=<token>
LLM_MODEL=<alias del modello>
# vettori da un Ollama locale invece che finti (modello a 1024 dimensioni):
EMBEDDING_BACKEND=ollama
EMBEDDING_MODEL=bge-m3
```

`LLM_ALLOWED_BACKENDS` (facoltativo) elenca i backend ammessi a ricevere dati di progetto; se manca valgono quelli configurati. Questi adattatori sono coperti da test di contratto, ma **non sono stati provati contro i servizi reali**.

## Test

```bash
node scripts/with-env.ts pnpm test:coverage
```
