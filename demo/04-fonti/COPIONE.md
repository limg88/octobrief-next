# Demo 04 — Fonti e alimentatori (incremento 3)

**Durata**: circa 5 minuti. **Cosa dimostra**:
- le fonti alimentate dal PC del PM (Microsoft 365, cartelle, file) senza permessi Graph: un alimentatore consegna con un token;
- le fonti lette dal worker (Jira) con credenziali in sola lettura, verificate e cifrate;
- la freschezza: ogni documento porta la data del sistema di origine, ogni fonte dice a quando sono aggiornati i suoi dati;
- la pseudonimizzazione delle persone nominate dalle fonti;
- i permessi: token, RLS, rigenerazione.

**Prerequisiti**:
- Node 24, pnpm 12 e Docker avviato;
- porte 3310, 4320 e 5450 libere: se hai lasciato accesa una demo precedente, fermala con il `kill` stampato alla sua fine.

Tutto è **sintetico**: la posta è un file JSON di esempio, Jira è un server finto in locale.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/04-fonti/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | Prerequisiti e database | `Schema up to date` (o `Migrations applied: 0004_sources.sql`), `SECRETS_KEY presente` | La migrazione 0004 crea le fonti; la chiave dei segreti è generata in locale |
| 2 | Jira finto e documenti | `Jira finto su http://127.0.0.1:…` | Nessun sistema reale coinvolto |
| 3 | Avvio e progetto | `progetto borea-…` | — |
| 4 | Fonte «Microsoft 365» | `token obf_…`; l'elenco delle fonti non restituisce mai il token | Il token si vede una volta sola; nel database c'è solo il suo hash |
| 5 | L'alimentatore consegna la posta | `file: 2 nuovi…`, poi `0 nuovi… 2 invariati`; con token sbagliato: 401 | Consegna idempotente, autenticata dal token |
| 6 | Fonte «Cartella» | `folder: 2 nuovi…`; 4 documenti con fonte, data alla fonte e data del documento | Stessa pipeline dei caricamenti; la mail porta la data del sistema, il file la data nel nome |
| 7 | Persone | «Carla Cliente» registrata; nessun «Carla» nel modello; nel fatto il nome c'è | Le persone nominate dalle fonti sono nascoste a ogni modello |
| 8 | Fonte «Jira» | token sbagliato: `source_auth_failed`; perimetro `project:10001`; credenziale cifrata; 3 attività; export del backlog | Credenziali verificate prima di salvare e cifrate; il worker legge solo il perimetro scelto |
| 9 | Permessi | Marco: `404`; il vecchio token non vale più | RLS sulle fonti; rigenerazione immediata |

## Parte nel browser (circa 3 minuti)

10. Apri l'indirizzo stampato alla fine (`…/projects/borea-…/sources`) e accedi come **Paola Prova**.
    La tabella mostra le tre fonti con documenti, ultima consegna e «dati aggiornati al».
11. Su «Jira Borea» premi **Leggi ora**: parte una lettura fuori orario. Su «Posta e riunioni» premi **Nuovo token**: compare il riquadro con il token da copiare.
12. Vai su **Memoria** (`G` poi `M`): i documenti arrivati dalle fonti mostrano «da Posta e riunioni», «da Cartella di progetto», «da Jira Borea». Sotto, «Cosa ho capito» contiene anche i fatti letti dalla mail.

Per fermare tutto: il comando `kill` stampato alla fine della parte automatica.

## Sul PC del PM, con i sistemi reali (non incluso nella demo)

Il token arriva dalla pagina Fonti e va passato in `OCTOBRIEF_FEEDER_TOKEN` (mai sulla riga di comando).

```bash
# Microsoft 365 tramite Claude e il connettore M365 del PM (sola lettura)
node apps/feeder/src/cli.ts m365 --server https://<octobrief> --source <id fonte> \
  --query "progetto Borea" --days 7

# NetSuite DWSI con credenziali in sola lettura (la connessione resta su questo PC)
DWSI_PASSWORD=… node apps/feeder/src/cli.ts dwsi --server https://<octobrief> --source <id fonte> \
  --host <host> --database <db> --user <utente> --codes PRJ000123 --owner <email del PM> --tls plaintext

# Una cartella (per esempio una libreria SharePoint sincronizzata)
node apps/feeder/src/cli.ts folder --server https://<octobrief> --source <id fonte> --path ~/Progetti/Borea
```

Questi tre modi sono coperti da test con sistemi finti, ma `m365` e `dwsi` **non sono stati provati contro i sistemi reali**.

## Test

```bash
node scripts/with-env.ts pnpm test:coverage
```
