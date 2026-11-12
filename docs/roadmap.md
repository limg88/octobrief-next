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
| 3 | completato (12/11/2026), demo `demo/04-fonti` |
| 4 | completato (12/11/2026), demo `demo/05-chiedi` |
| 5 | completato (12/11/2026), demo `demo/06-deliverable` |
| 6 | completato (12/11/2026), demo `demo/07-verbale`, `demo/08-stima-costi`, `demo/09-analisi-bug`, `demo/10-rischi-opportunita` |
| 7 | completato (12/11/2026), demo `demo/11-deploy`, runbook `docs/runbook.md` |

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

### Scelte prese durante l'incremento 3
- **Due modi di alimentare un progetto**, con la stessa pipeline dei caricamenti (estrazione, classificazione, lettura):
  - **fonti alimentate** (Microsoft 365, DWSI, cartella o file): un alimentatore gira sul PC del PM e consegna a `POST /api/ingest/{fonte}` con il token della fonte;
  - **fonti lette dal worker** (Jira, Azure DevOps): ogni 15 minuti (`SYNC_INTERVAL_MINUTES`) o su richiesta, con i connettori in sola lettura di NX.
- **Token dell'alimentatore**: mostrato una sola volta, nel database resta solo il suo SHA-256. Si rigenera dalla pagina Fonti e il vecchio smette subito di valere.
- **Le consegne entrano come la persona che ha collegato la fonte**: valgono le stesse regole RLS dei caricamenti. Se quella persona non vede più il progetto, la consegna viene rifiutata.
- **Credenziali di Jira e ADO cifrate** con AES-256-GCM e la chiave `SECRETS_KEY` (32 byte in base64, generata da `pnpm db:setup`). Il cifrato è legato all'identificativo della fonte: copiato su un'altra fonte non si apre.
- **Versioni**: un elemento viene salvato di nuovo solo se cambia versione; in quel caso sostituisce il documento precedente (e i fatti che solo quello dichiarava).
- **Persone nominate dalle fonti** (mittenti, partecipanti, assegnatari): salvate per progetto e nascoste a ogni modello, come i membri.
- **Dati strutturati**: le attività dei tracker (`tracker_items`) e le righe del warehouse (`system_rows`) sono salvate come dati, non come documenti. Le useranno Chiedi e i deliverable.
- **Pacchetto `packages/connectors`** (portato da NX): connettori Jira, ADO e DWSI, client HTTP sicuro (percorsi ammessi, nessun redirect, nessun indirizzo privato). I connettori Graph e cartella-Mac di NX non sono stati portati.
- **Alimentatore** (`apps/feeder`), quattro modi di leggere:
  - `folder`: una cartella del PC, anche una libreria SharePoint sincronizzata;
  - `file`: una consegna già scritta in JSON;
  - `m365`: lancia Claude con il connettore Microsoft 365 del PM e una richiesta di sola lettura, e consegna il JSON che Claude stampa;
  - `dwsi`: legge il warehouse con il connettore NX; la connessione (anche non cifrata) resta sul PC del PM.
- **Non provato dal vivo**: `m365` (serve un seat Claude con il connettore), `dwsi` (serve il warehouse), Jira e ADO reali. Sono coperti da test con sistemi finti.
- **Data di un file letto da una cartella**: la data di modifica del file è solo un indizio debole; vince la data scritta nel nome o nel contenuto.

### Scelte prese durante l'incremento 4
- **Il modello legge, il codice decide** (portato da NX):
  - il modello ha strumenti di sola lettura (cerca, leggi un documento, elenca i documenti, leggi un fatto, interroga i tracker), per al più 7 turni;
  - poi risponde in un formato fisso: frasi con natura (fatto, deduzione, suggerimento) e fonti, contraddizioni, assenze;
  - il codice confronta ogni citazione con ciò che gli strumenti hanno davvero restituito e sospende le frasi non sostenute.
- **Ricerca ibrida**: testo (PostgreSQL full-text in italiano, basta una parola della domanda) più vettori (pgvector), fusi per posizione (reciprocal rank fusion). Senza codificatore la ricerca è solo testuale.
- **La risposta si prepara nel worker**, non nella richiesta web: la domanda viene salvata, messa in coda e seguita con eventi dal server (`/questions/{id}/events`). Un errore resta sulla domanda con un codice; la persona la ripropone.
- **Storico privato**: ognuno vede solo le proprie domande, anche fra membri dello stesso progetto (policy RLS).
- **Freschezza**: soglie predefinite uguali per tutti i progetti. Un documento con una versione più recente dello stesso tipo viene segnalato come superato.
- **Tracker**: lo strumento `query_tracker` di NX è collegato alle attività salvate da Jira e ADO, senza storico nel tempo (solo l'ultima versione di ogni attività).
- **Non portati da NX**: limiti di sessione per backend e soglie di freschezza per progetto.
- **E2E**: `pnpm e2e` (Playwright + axe) copre login, creazione progetto, caricamento, «Cosa ho capito» e Chiedi; in CI gira in un job dedicato.
- **Modello finto**: cerca una volta con la domanda e risponde citando i brani e i fatti che ne condividono le parole. Con `#inventa` aggiunge un numero mai letto, per mostrare il controllo.

### Scelte prese durante l'incremento 5
- **Motore portato per intero da NX**: formato delle ricette, raccolta dei dati, scheletro, scrittura dei testi, controlli comuni e della ricetta, red-team, versione per il cliente, approvazione. Sono circa 17.000 righe con i loro test.
- **Ricette**: file JSON in `recipes/` (cartella `RECIPES_DIR`), validati all'avvio; una ricetta non valida blocca l'avvio.
  - Ci sono tutte le otto ricette di NX: SAL economico, Mail al cliente, Verbale da trascritto, Stima dei costi, Dashboard bug e CR, Closing Status, Deliverable Sprint, Deliverable di fase assessment.
  - Non c'è ancora la modifica delle ricette dall'interfaccia, né la configurazione per progetto (template, etichette, valori predefiniti).
- **Ciclo di vita di un documento**: in coda → in preparazione (raccolta, scrittura, controllo) → da rivedere → approvato.
  - **Chiedi modifica**: riscrive solo i testi indicati; la revisione è tenuta solo se non cambia altro e non aggiunge anomalie.
  - **Accetta**: solo le anomalie che il motore dichiara accettabili, con una motivazione di almeno una frase.
  - **Approva**: rifiutata finché resta un'anomalia aperta. Possono decidere chi ha chiesto il documento, il responsabile del progetto e gli admin.
- **File**:
  - Markdown scritto dal sistema;
  - Word, PowerPoint ed Excel prodotti dal **renderer Python isolato** (`apps/renderer`, portato da NX con i suoi 465 test) a partire dai template in `templates/` (`TEMPLATES_DIR`);
  - senza `RENDERER_URL` si producono solo i Markdown;
  - una ricetta per il cliente produce solo la versione per il cliente, calcolata dai controlli di destinazione.
- **Renderer in Docker Compose** sotto il profilo `renderer`: rete interna senza uscita, utente non root, file system in sola lettura. Si avvia solo quando serve: `docker compose --profile renderer up -d --wait`.
- **Non portati da NX**:
  - ciclo automatico di revisione dopo la prima bozza;
  - tetti di spesa e prezzi dei modelli (qui solo i limiti predefiniti di chiamate e durata);
  - valori dichiarati dal PM in documenti precedenti;
  - decisioni del PM sulle contraddizioni;
  - conferme degli story point.
- **Eccezioni alle regole di architettura**, limitate al nucleo portato (`packages/domain/src/recipe` e `gate`): può avere cicli di import interni; i due moduli di hashing usano `node:crypto`. Per questo il nucleo è esportato a parte (`@octobrief/domain/recipe`) e non entra nel bundle del browser.
- **Modello finto**: scrive ogni testo citando valori già presenti nel documento con le loro note. Con `LLM_FAKE_INVENT_IN_DRAFTS=true` mette una cifra senza fonte nel primo testo della prima bozza (solo per le demo).
- **Dati del warehouse nelle ricette**: le righe DWSI sono lette, ma il collegamento fra righe e documento di origine è semplificato (il documento più recente della fonte). Da rivedere quando ci sarà un warehouse reale.

### Scelte prese durante l'incremento 6
- **Slot «agente»**: è il modo normale in cui il motore scrive un testo. Il modello ha solo strumenti di lettura (cerca, leggi un documento, leggi un fatto, interroga il tracker), per al più 4 turni, poi risponde nel formato fisso. Non serve un meccanismo a parte.
- **Ricette**:
  - **Verbale da trascritto**, **Stima dei costi** e **Dashboard bug e CR** (l'«Analisi bug» della roadmap) erano già fra le ricette portate da NX: qui hanno la loro demo;
  - **Rischi e opportunità** è nuova (`recipes/risks-and-opportunities.json`): elenchi di rischi, azioni e decisioni dai fatti della memoria, più tre testi (valutazione, opportunità, prossimi passi). Nel catalogo OB non esisteva un contratto dedicato: i rischi erano una sezione di altri deliverable.
- **Oratori e partecipanti**: all'elaborazione di un documento si riconoscono chi parla («Nome Cognome:» a inizio riga) e chi è in elenco («Partecipanti: …»). Vengono ricordati con il progetto e nascosti a ogni modello.
  - **Limite noto**: un nome citato solo dentro una frase, di una persona che non è membro e che nessuna fonte ha nominato, non viene riconosciuto e arriva al modello in chiaro. Per i dati reali conviene collegare le fonti (che portano i nomi) o aggiungere le persone al progetto.
- **Coda**: una sola lettura per fonte alla volta. Una seconda richiesta entro un minuto non aggiunge lavoro; una lettura rimasta in attesa più di mezz'ora viene scartata.
- **Titolo delle attività del tracker**: reso disponibile come campo a ricette e Chiedi.
- **Modello finto come agente**: per un testo che riguarda un documento nominato nelle note, cerca, legge quel documento e cita le righe pertinenti (data, partecipanti, decisioni, azioni, rischi). Per gli altri testi cita valori e righe già presenti nel documento.

### Scelte prese durante l'incremento 7
- **Una sola immagine** per web e worker (`deploy/Dockerfile`): Node 24 esegue i sorgenti TypeScript del workspace, si compila solo il web. È grande (circa 1,8 GB) perché contiene anche gli strumenti di sviluppo; ridurla è un lavoro successivo.
- **Compose di produzione** in `deploy/compose.yml`, separato da quello di sviluppo:
  - solo Caddy pubblica una porta (HTTPS);
  - Postgres e renderer stanno su reti interne senza uscita;
  - ruoli del database e migrazioni sono servizi a esecuzione singola che web e worker aspettano;
  - ogni processo riceve solo le sue variabili: il web non ha le credenziali del worker né del proprietario del database.
- **Certificati**: `CADDY_TLS=internal` (autorità di Caddy) oppure i file dell'azienda in `deploy/certs/`. Niente ACME: il server non è esposto a internet.
- **Segreti** generati sul server da `deploy/init-env.sh` in `deploy/.env` (permessi 600, escluso da git).
- **Una chiave d'ambiente vuota vale come non impostata**: compose passa vuote le chiavi opzionali.
- **Backup e ripristino** con `deploy/octobrief.sh`: `pg_dump` in formato custom, archivio dei file caricati e impronte SHA-256. Il ripristino ricrea il database dal dump.
- **Issuer finto solo in demo**, aggiunto da `deploy/compose.demo.yml` nello spazio di rete del web: così browser e web lo raggiungono entrambi come `127.0.0.1` e la regola «HTTP solo verso loopback» resta valida.
- **CI**: il job `deploy` esegue la demo 11 a ogni push.
