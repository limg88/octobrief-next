# Roadmap e decisioni

> Sigle: **OB** = octobrief (versione originale, UX di Studio), **NX** = octobrief-next (riscrittura con architettura a porte e motore deterministico).

## Decisioni (11/11/2026)

| Tema | Decisione |
|---|---|
| Criteri | **Velocità di sviluppo**, poi manutenibilità, poi sicurezza, poi performance |
| Scala | team interno piccolo (10–20 PM), una sola organizzazione |
| Primo rilascio | Chiedi, Deliverable, Memoria e documenti (i cruscotti dopo) |
| Lingua UI | italiano + inglese |
| Fonti | M365 (mail, Teams, SharePoint), Jira, ADO, NetSuite DWSI, upload / cartella |
| M365 | **niente Graph diretto** (gli scope richiedono l'approvazione IT, troppo lunga). Si usa l'MCP M365 di Claude come **servizio esterno di alimentazione**, sostituibile in futuro con Entra e i suoi scope |
| DWSI | credenziali in sola lettura, connessione **non sicura e non modificabile**: stesso schema di M365 (alimentatore esterno) |
| Jira / ADO | Jira: accesso ok; ADO: PAT |
| Login | Entra ID OIDC (registrazione app in autonomia, nessuno scope Graph) |
| LLM | **principale: gateway `llm-api`** (tuo, quindi modificabile: si risolve il timeout di 90 s). Disponibili anche seat, Ollama e API key (quest'ultima **non** come via principale) |
| Pseudonimizzazione | **obbligatoria** |
| Budget | nessun tetto rigido; solo monitoraggio |
| Migrazione | nessuna: si parte da zero, si riusano codice, ricette e template |
| Hosting | prima PC locale, poi VM aziendale on-prem (Docker Compose) |
| Repo | GitHub + Actions, **repo pubblico** `https://github.com/limg88/octobrief-next` (oggi vuoto) come remote `origin` della cartella locale `octobrief-new`; nessun dato cliente nel repo. Il primo push avviene solo su tua richiesta |
| GDPR | basta una policy di retention |
| Motore | deterministico + slot "agente" dove serve |
| API / fetch | Hono + OpenAPI + TanStack Query |
| Default dichiarati | renderer Python mantenuto; UI solo desktop come Studio |

---

## Fase 3 — Roadmap

### Principi trasversali
- **Velocità prima**: si **porta** codice dai due repo (adattandolo e ripulendolo) invece di riscriverlo. Ogni incremento finisce con `demo/NN-*/run.sh` + `COPIONE.md` (≤ 5 minuti) e i test scritti; la coverage si verifica solo alla chiusura dell'incremento.
- **Repo pubblico**:
  - `.env*` ignorati, gitleaks in CI;
  - template e ricette solo anonimizzati;
  - dati demo **sintetici** (generatore da `tools/synthetic` di NX);
  - una directory `private/` esterna al repo per gli asset reali.
- **Alimentatori esterni** (decisione chiave per M365 e DWSI):
  - Porta `SourceFeed` e un endpoint di **ingest** autenticato con un token per fonte. Accetta elementi normalizzati: mail, trascritto, documento, righe DWSI.
  - Il processo `feeder` gira sul PC del PM:
    - **M365**: usa Claude con il connettore MCP M365 (seat) per estrarre mail, Teams e SharePoint in modalità di sola lettura;
    - **DWSI**: legge con le credenziali in sola lettura sulla connessione disponibile e spinge snapshot al server.
  - Il server non apre mai connessioni insicure: il rischio resta confinato sul PC del PM.
  - Domani un connettore Graph o DWSI diretto implementa la stessa porta, senza cambiare il resto.
- **LLM**:
  - porta `ModelRunner` con catena `guarded(pseudonymizing(llmApi))` (NX);
  - adattatori: `llm-api` (principale), Ollama (sviluppo e test a costo zero), Anthropic API (fallback disattivato di default);
  - sul gateway (tuo repo, fuori perimetro): streaming e timeout configurabile.

### Incrementi

| # | Incremento | Contenuto | Ispirazione | Dipende da |
|---|---|---|---|---|
| **0** | Fondamenta | monorepo pnpm, TS strict, Biome, dependency-cruiser (`domain`←`application`←`infrastructure`/`interface`), Vitest con soglia 80%, CI GitHub Actions (+ gitleaks, audit), compose con Postgres 17 + pgvector, config zod, 3 ruoli DB, pg-boss, scheletro di web (Next + Hono) e worker. **Demo**: `pnpm dev` → health check di API e worker, rotta OpenAPI. | NX (tooling, CI, ruoli, coda), OB (nomi dei layer) | — |
| **1** | Accesso e shell | Entra OIDC + fake OIDC in dev, sessione su DB, CSRF, ruoli PM/Admin letti dal DB; shell di Studio (sidebar, ⌘K, scorciatoie, tema), next-intl it/en; progetti (lista, creazione, membri). **Demo**: login finto → crea progetto → ⌘K → cambio lingua. | OB Studio (UX), NX fake-oidc e RLS | 0 |
| **2** | Memoria e documenti | upload su `BlobStore` (FS), estrazione (NX `extract`), classificazione, **pseudonimizzatore** (porting NX con test property-based), compilazione dei fatti con citazioni verificate, embeddings; UI Memoria (UploadPanel, ClassificationTable, "Cosa ho capito") + retention. **Demo**: carico 3 documenti sintetici → classificazione → fatti con citazione. | NX (motore della conoscenza), OB Studio (UI) | 1 |
| **3** | Fonti e alimentatori | endpoint di ingest + `feeder` CLI (M365 via MCP Claude, DWSI locale); connettori diretti Jira (REST, token) e ADO (PAT) con `safe-http`; pagina Fonti. **Demo**: feeder in modalità finta + fake Jira → elementi in Memoria con data di freschezza. | NX (connettori, `safe-http`), nuovo (feeder) | 2 |
| **4** | Chiedi | ricerca ibrida FTS + vettori, risposta con verifica frase per frase, avanzamento via SSE, componenti trust (SourceChip, KindBadge, Freshness, Contradictions), storico conversazioni. **Demo**: domanda su un progetto sintetico → risposta citata con contraddizione evidenziata. | NX (`ask.ts`, `answer-check`), OB Studio (UX trust) | 2 (3 per avere più dati) |
| **5** | Motore deliverable + 2 ricette | schema delle ricette NX, gather → scheletro → slot → verifica → red-team → approvazione → renderer Python isolato; UI catalogo, modulo e revisione di Studio; ricette **SAL** e **Mail cliente**. **Demo**: SAL su dati sintetici → anomalie → chiedi modifica → approva → scarica docx. | NX (motore, ricette, renderer), OB Studio (flusso UX), OB catalogo (contenuti) | 3, 4 |
| **6** | Altri deliverable | slot "agente" con tool limitati; **Verbale da trascrizione**, **Stima costi / SOW**, **Analisi bug**, **Rischi e opportunità**, convertendo contratti e istruzioni OB in ricette. Un sotto-incremento e una demo per ricetta. | OB catalogo + NX ricette | 5 |
| **7** | Deploy on-prem | immagini di produzione per web e worker, compose per la VM, backup e restore, job di retention, runbook in italiano. **Demo**: `compose up` su un ambiente pulito → login → Chiedi. | OB staging (Caddy, digest), NX pilot script | 5 (in parallelo al 6) |

Dopo l'MVP: cruscotti economici (DWSI e tracker), onboarding guidato, amministrazione avanzata, connettori diretti Graph e DWSI quando ci saranno le approvazioni IT e la connessione sicura.

### File critici da portare (rappresentativi)
- **Da OB**:
  - `apps/studio/src/components/{studio,trust}/*`, `studio/statuses.ts`;
  - `packages/http-api/src/routes.ts` (ordine delle guardie);
  - `persistence/src/secret-store*.ts` (cifratura a busta);
  - `catalog/contratti`, `catalog/istruzioni`, `catalog/modelli` (anonimizzati).
- **Da NX**:
  - `packages/core/src/{recipe,gate,pseudonymizer.ts,answer-check.ts}`;
  - `packages/engine/src/{recipe/*,ask.ts,compile.ts,create-model-runner.ts}`;
  - `packages/connectors/src/{safe-http.ts,jira,ado}`;
  - `packages/queue`, `packages/storage`, `apps/renderer`, `tools/fake-oidc`, `tools/synthetic`, `.github/workflows/ci.yml`.

### Verifica
- Per ogni incremento: `demo/NN-*/run.sh` + `COPIONE.md`. Test e coverage con `pnpm test:coverage` (soglia 80%) **solo** alla chiusura dell'incremento o su tua richiesta. CI su ogni push.
- E2E Playwright con axe sui flussi chiave (login, upload, Chiedi, deliverable) dall'incremento 4 in poi.

### Stato
| # | Stato |
|---|---|
| 0 | completato (11/11/2026), demo `demo/00-fondamenta` |
