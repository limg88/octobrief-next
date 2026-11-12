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
| 1 | completato (11/11/2026), demo `demo/01-accesso-e-shell` |
| 2a | completato (11/11/2026), demo `demo/02-documenti` |
| 2b | completato (12/11/2026), demo `demo/03-conoscenza` |
| 3 | da fare |

### Scelte prese durante l'incremento 1
- **Schema in SQL versionato** (`packages/infrastructure/migrations/NNNN_*.sql`), senza Drizzle. Il file SQL è l'unica fonte dello schema, quindi lo schema dichiarato non può divergere da quello reale. Le query stanno nei repository, scritte con `pg`.
- **RLS rimandata**. Per ora i permessi li controllano i casi d'uso: un progetto non visibile risponde 404, i membri li gestiscono solo responsabile e admin. Le policy RLS arrivano con i dati condivisi (documenti, incremento 2).
- **Login**:
  - Il flusso è OpenID Connect con authorization code + PKCE + state + nonce.
  - La richiesta di login in corso viene salvata sul DB (monouso, 10 minuti).
  - Le sessioni sono salvate sul DB come hash del token: sono revocabili e durano 8 ore.
  - Ogni sessione ha un token CSRF, con controllo dell'origine sulle richieste che modificano dati.
- **Primi admin**: le email elencate in `ADMIN_EMAILS` diventano admin al login, solo se Entra le dichiara verificate. Un admin non viene mai retrocesso in automatico.
- **Entra ID**: si registra un'app con redirect URI `<PUBLIC_URL>/api/auth/callback`, senza permessi Graph. Poi in `.env.local` si impostano:
  - `OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0`;
  - `OIDC_CLIENT_ID` e `OIDC_CLIENT_SECRET`;
  - `OIDC_ALLOW_INSECURE_ISSUER=false`.
- **Test dei componenti React** con jsdom e Testing Library. Dalla coverage sono esclusi solo:
  - i primitivi shadcn copiati da Studio (`components/ui`);
  - il wiring di Next (route, proxy, configurazione i18n, font).

### Scelte prese durante l'incremento 2a
- **Incremento 2 diviso in due parti**, ciascuna con la sua demo:
  - **2a**: documenti (caricamento, estrazione, classificazione, RLS, conservazione);
  - **2b**: conoscenza (pseudonimizzazione, LLM, fatti con citazioni, embeddings).

  Nelle demo e nei test il modello è finto e deterministico; con una variabile si passa al gateway `llm-api` reale.
- **Estrazione** portata da NX in `packages/infrastructure/src/extract` (subpath `@octobrief/infrastructure/extract`, usato solo dal worker, così le librerie PDF e zip restano fuori dal bundle web):
  - gira in un processo figlio con 512 MB di memoria, 60 s di tempo massimo, nessuna variabile d'ambiente e un watchdog;
  - i formati di template (incremento 5) non sono stati portati.
- **Classificazione a regole** (portata da NX in `domain`), senza LLM. Calcola:
  - il tipo, dal tipo di file, dal nome o dall'inizio del testo;
  - i destinatari, interni di default;
  - la data, dal nome del file, dai metadati o dalla data di caricamento.

  I campi incerti vanno confermati dal PM. I dati economici restano interni per regola.
- **RLS attiva** su `documents` e `document_chunks`:
  - il web esegue ogni query in una transazione con `app.user_id`, quindi vede solo i progetti dove la persona è membro (o tutti, se è admin);
  - il worker ha una policy propria;
  - il web può modificare solo i campi della classificazione.
- **File** in `BLOB_DIR`, un percorso assoluto. Sono indirizzati per contenuto (`<progetto>/<sha256>`), con permessi 0600 e scrittura atomica. Lo stesso contenuto caricato due volte nello stesso progetto dà 409.
- **Conservazione**: invece di un job pianificato in coda, il worker esegue la pulizia all'avvio e poi ogni ora. Elimina prima i file e poi le righe, così non restano file orfani.

### Scelte prese durante l'incremento 2b
- **Un documento è la fonte dei fatti**: non esiste una tabella separata delle «prove». Con l'incremento 3 mail e trascritti entreranno come documenti.
- **Il modello propone, il codice decide** (portato da NX). Un fatto viene salvato solo se:
  - la citazione si trova parola per parola nel brano indicato;
  - ogni numero dichiarato compare nella citazione;
  - il testo non ha la forma di un'istruzione.

  I fatti scartati vengono contati nei log, mai corretti.
- **Contraddizioni**: due documenti che dicono cose diverse sullo stesso argomento restano entrambi, marcati «in contraddizione». Due documenti in accordo diventano un solo fatto con più fonti.
- **Un fatto vive finché un documento lo dichiara**: eliminato l'ultimo documento che lo cita, un trigger del database elimina il fatto e toglie la contraddizione rimasta senza controparte.
- **Catena del modello**: `guardia → pseudonimizzatore → adattatore`, unica via per chiamare un modello.
  - Persone note di un progetto: i membri (nome ed email) e il cliente (come organizzazione). Email, telefoni e simili vengono riconosciuti comunque.
  - Tutti i progetti contano come dati reali: i backend ammessi sono quelli configurati, oppure quelli di `LLM_ALLOWED_BACKENDS`. Groq è sempre escluso.
- **Adattatori**:
  - chat: modello finto (default, deterministico, nessuna rete) oppure gateway `llm-api`;
  - vettori: finti (default), Ollama locale (`bge-m3`, 1024 dimensioni), gateway, oppure nessuno.

  `llm-api` e Ollama hanno test di contratto ma non sono stati provati contro i servizi reali.
- **Limiti per backend impostabili dall'Admin** (NX `backend-limits`) non portati: valgono i default della compilazione.
- **«Cosa ho capito» è in sola lettura**: la correzione dei fatti da parte del PM non è ancora prevista in nessun incremento.
