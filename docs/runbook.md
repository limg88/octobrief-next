# Runbook — Octobrief on-prem

Come si installa, si aggiorna, si salva e si ripristina Octobrief su un server dell'azienda. La prova completa in locale è `demo/11-deploy`.

## Cosa gira

| Servizio | Cosa fa | Rete |
|---|---|---|
| `caddy` | HTTPS davanti al web; è l'unica porta pubblicata | esterna |
| `web` | interfaccia e API (Next.js), utente non root | esterna (per Entra ID) + dati |
| `worker` | lavori in coda: lettura documenti, fonti, domande, deliverable, conservazione | esterna (modello, Jira, Azure DevOps) + dati + renderer |
| `postgres` | database (pgvector), volume `pgdata` | solo dati, senza uscita |
| `renderer` | file Word, PowerPoint ed Excel; nessun segreto, nessun volume | solo renderer, senza uscita |
| `db-roles`, `migrate` | a esecuzione singola a ogni avvio: ruoli del database e migrazioni | solo dati |

I file caricati stanno nel volume `blobs`, condiviso da web e worker. Ricette e template sono dentro l'immagine (`/app/recipes`, `/app/templates`).

## Prerequisiti

- Un server Linux con Docker Engine e il plugin compose, e il checkout di questo repository.
- Un nome DNS interno per il servizio (esempio: `octobrief.example.internal`) e, se disponibili, certificato e chiave dell'azienda.
- Un'app registrata in Entra ID con redirect URI `https://<nome>/api/auth/callback`, senza permessi Graph.

## Prima installazione

1. Crea il file d'ambiente con i segreti generati (non vengono stampati):
   ```bash
   SITE_HOST=octobrief.example.internal \
   OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0 \
   OIDC_CLIENT_ID=<id dell'app> \
   ADMIN_EMAILS=<email dei primi amministratori, separate da virgola> \
   deploy/init-env.sh
   ```
2. Apri `deploy/.env` e inserisci `OIDC_CLIENT_SECRET`. Il file ha permessi `600` e non entra in git.
3. Certificato:
   - dell'azienda: copia i due file in `deploy/certs/` e imposta `CADDY_TLS=/certs/<certificato> /certs/<chiave>`;
   - senza certificato: lascia `CADDY_TLS=internal`. Caddy usa una sua autorità e i browser chiedono conferma finché non la si distribuisce.
4. Modello: con `LLM_BACKEND=fake` nulla esce dal server e le risposte sono dimostrative. Per il gateway aziendale imposta `LLM_BACKEND=llm-api`, `LLM_API_URL`, `LLM_API_TOKEN`, `LLM_MODEL`; per i vettori `EMBEDDING_BACKEND=ollama` e `OLLAMA_URL`. I nomi sono in `deploy/.env.example`.
5. Avvia:
   ```bash
   deploy/octobrief.sh up
   deploy/octobrief.sh ps
   ```
6. Controlla: `curl https://<nome>/api/health` risponde `{"status":"up",…}`; poi accedi dal browser con un'email di `ADMIN_EMAILS`.

## Comandi di tutti i giorni

| Comando | Cosa fa |
|---|---|
| `deploy/octobrief.sh ps` | stato dei servizi |
| `deploy/octobrief.sh logs worker` | ultime 200 righe di un servizio (`TAIL=1000` per averne di più) |
| `deploy/octobrief.sh up` | avvia, o applica una modifica a `deploy/.env` |
| `deploy/octobrief.sh down` | ferma tutto; i volumi restano |
| `deploy/octobrief.sh compose <argomenti>` | qualunque altro comando compose sull'installazione |

I log sono su stdout, ruotati da Docker (5 file da 20 MB per servizio).

## Aggiornamento

```bash
deploy/octobrief.sh backup
git pull
deploy/octobrief.sh up
```

`up` ricostruisce le immagini e riesegue `migrate`: le migrazioni sono solo in avanti. Per tornare alla versione precedente: `git checkout <versione>`, `deploy/octobrief.sh up`, poi `restore` del backup fatto prima.

## Backup

```bash
deploy/octobrief.sh backup /percorso/backup/$(date +%F)
```

Scrive nella cartella `database.dump` (formato `pg_dump`, coerente anche a servizio acceso), `blobs.tar.gz` (i file caricati) e `SHA256SUMS`. Senza argomento scrive in `deploy/backups/<data-ora>/`.

- Pianificalo ogni notte con cron e copia la cartella su un altro sistema.
- Conserva a parte una copia di `deploy/.env`: senza `SECRETS_KEY` le credenziali delle fonti salvate non si possono più leggere.
- I backup contengono dati dei progetti: vanno protetti come il server e cancellati secondo la stessa regola di conservazione.

## Ripristino

```bash
deploy/octobrief.sh restore /percorso/backup/2026-11-12
```

Verifica le impronte, ferma web, worker e Caddy, sostituisce database e file con quelli del backup e riavvia. Su un server nuovo: prima installazione con lo **stesso** `deploy/.env`, poi `restore`.

Prova il ripristino a intervalli regolari: `bash demo/11-deploy/run.sh` lo fa in locale in due minuti.

## Conservazione dei dati

Il worker cancella all'avvio e poi ogni ora documenti e file più vecchi di `RETENTION_DAYS` (365 se non impostato). Per cambiarlo: modifica `deploy/.env` e `deploy/octobrief.sh up`.

## Cartelle sincronizzate sul server (facoltativo)

Per le fonti alimentate da una cartella che sta sul server (vedi `docs/roadmap.md`, incremento 8): imposta `SYNC_FOLDERS_DIR=<percorso assoluto sull'host>` in `deploy/.env` e avvia con il file aggiuntivo:

```bash
OCTOBRIEF_EXTRA_COMPOSE=deploy/compose.sync.yml deploy/octobrief.sh up
```

La cartella è montata in sola lettura in `/data/sync`: nel riquadro «Collega una cartella sincronizzata» il percorso da indicare è `/data/sync/<progetto>`. Se invece la cartella sta sul PC del PM non serve nulla di questo: la invia l'addon.

## Se qualcosa non va

| Sintomo | Controllo |
|---|---|
| `up` si ferma su `migrate` o `db-roles` | `deploy/octobrief.sh logs migrate`: di solito una password cambiata in `deploy/.env` dopo la prima installazione |
| `web` o `worker` si riavviano | `deploy/octobrief.sh logs web`: `invalid or missing environment keys: …` elenca le chiavi mancanti o non valide |
| Accesso non riuscito | redirect URI dell'app Entra uguale a `PUBLIC_URL` + `/api/auth/callback`; `OIDC_ISSUER` con il tenant giusto |
| I documenti restano «in lettura» | `deploy/octobrief.sh logs worker`; con `llm-api` controlla che il gateway sia raggiungibile dal server |
| Mancano Word, PowerPoint o Excel | `deploy/octobrief.sh ps`: il `renderer` deve essere `healthy` |

## Limiti noti

- Un solo server: nessuna alta disponibilità. Il ripristino da backup è la procedura di recupero.
- Entra ID, gateway `llm-api`, Ollama, Jira e Azure DevOps reali non sono stati provati dal vivo: la demo usa issuer e modello finti.
- L'immagine di web e worker contiene tutto il workspace, strumenti di sviluppo compresi (circa 1,8 GB).
