# octobrief-sync — addon di sincronizzazione

Tiene aggiornata una **cartella di file Markdown** con ciò che un progetto ha in Jira, Azure DevOps, Microsoft 365 e NetSuite, e la fa arrivare a Octobrief. Gira sul computer del PM, con le credenziali del PM, in sola lettura.

Versione: vedi `package.json` e [CHANGELOG](CHANGELOG.md). Guida passo passo per un progetto reale: [docs/sync.md](../../docs/sync.md). Prova completa con sistemi finti: `demo/13-addon-sync`.

## Come funziona

```
Jira ─┐
ADO ──┤  pull (ogni N minuti)   ┌─ jira/…md           letta dal server (stesso computer)
M365 ─┼────────────────────────▶│  ado/…md      ─────▶ oppure
DWSI ─┘                         │  m365/mail|riunioni|file/…md   push (server on-prem)
                                │  netsuite/<vista>/…md
                                └─ _stato.md
```

Ogni file ha in testa un'intestazione con i dati (id e versione alla fonte, date, persone, campi) e sotto il testo leggibile. Octobrief ricostruisce da lì sia il documento sia il dato strutturato.

## Comandi

```bash
node addons/sync/src/cli.ts init  <file.json>            # configurazione di esempio
node addons/sync/src/cli.ts check --config <file.json>   # configurazione, segreti, accessi
node addons/sync/src/cli.ts pull  --config <file.json>   # fonti → cartella, ogni everyMinutes
node addons/sync/src/cli.ts push  --config <file.json>   # cartella → Octobrief sul server
```

| Opzione | Effetto |
|---|---|
| `--once` | una sola passata, poi esce |
| `--every <minuti>` | intervallo, al posto di `everyMinutes` |
| `--since <giorno>` | data di inizio per questa esecuzione: `2026-01-01` o `01/01/2026` |

## Configurazione

Un file JSON **fuori dal repository**. Non contiene segreti: solo il **nome** delle variabili d'ambiente che li tengono (`tokenEnv`, `patEnv`, `passwordEnv`). I valori stanno nel file indicato da `envFile`, con permessi `600`.

| Chiave | Significato |
|---|---|
| `folder` | la cartella da tenere aggiornata (percorso assoluto), una per progetto |
| `everyMinutes` | ogni quanto ripetere (30 se manca) |
| `since` | giorno da cui leggere, per tutte le fonti; ogni fonte può avere il suo |
| `envFile` | file privato `NOME=valore` con i segreti |
| `jira` | `site`, `email`, `tokenEnv`, `projects` (chiavi; vuoto: tutti quelli visibili) |
| `ado` | `organization`, `project`, `patEnv`, `patExpiresOn` (giorno di scadenza del PAT) |
| `dwsi` | `host`, `port`, `database`, `user`, `passwordEnv`, `codes` (commesse), `owner`, `tls` |
| `m365` | `keywords` (parole, frasi, indirizzi email), `outlook.folders`, `outlook.mailboxes`, `teams.channels`, `teams.chats`, `sharepoint.paths`, `days`, `claude`, `allowedTools` |
| `push` | `server` e, per ogni sistema, `id` della fonte e `tokenEnv`: li mostra Octobrief quando colleghi la cartella «inviata dal PC» |

## Cosa sapere

- **Data di inizio**. Jira e Azure DevOps: solo ciò che è stato creato o modificato da quel giorno. Microsoft 365: dal giorno indicato a oggi, una settimana per volta. DWSI: vale solo per i timesheet; ordini, fatture e ricavi si leggono sempre interi, perché residui e totali ne hanno bisogno. Spostarla indietro recupera il periodo mancante; spostarla avanti non cancella nulla.
- **Ultimi 10 minuti**. Ciò che cambia in Jira o Azure DevOps negli ultimi 10 minuti arriva alla passata successiva.
- **PAT di Azure DevOps**. Con `patExpiresOn` l'addon avvisa dal giorno prima, in console e in `_stato.md`. Quando scade: generane uno nuovo, aggiorna il file `.env`, aggiorna `patExpiresOn`.
- **Microsoft 365 passa da Claude**. L'addon lancia `claude -p` con i soli strumenti indicati in `allowedTools` e chiede elementi in JSON; i file li scrive l'addon. Il contenuto lo produce un modello: può troncare o riformulare, e ogni passata consuma token. I file lo dichiarano (`via: "claude"`). Una finestra con più di 50 elementi viene divisa in due.
- **DWSI senza TLS** (`"tls": "plaintext"`): solo in VPN, verso un host privato.
- **La cartella contiene dati del progetto in chiaro**: tienila fuori dai repository e su un disco cifrato.
- **Una fonte che fallisce non ferma le altre**: l'esito di ciascuna è in `_stato.md`, con un codice (`source_auth_failed`, `source_unreachable`, `provider_failed`…).

## Test

```bash
pnpm exec vitest run addons/sync
```
