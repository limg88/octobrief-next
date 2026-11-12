# Importare un progetto reale con l'addon di sincronizzazione

Passi per portare in Octobrief un progetto che ha Jira, Azure DevOps, Microsoft 365 e NetSuite (DWSI). I valori fra `<…>` sono i tuoi; nomi di clienti, host e credenziali **non vanno mai nel repository**. Riferimento dei comandi: [addons/sync/README.md](../addons/sync/README.md).

## 1. Prepara configurazione e segreti (una volta)

```bash
mkdir -p ~/.octobrief && chmod 700 ~/.octobrief
node addons/sync/src/cli.ts init ~/.octobrief/<progetto>.json
```

Apri il file e sostituisci i valori:
- `folder`: `~/OctobriefSync/<progetto>` scritto per esteso (percorso assoluto). Su questo computer `pnpm db:setup` ha già impostato `SYNC_FOLDERS_ROOT=~/OctobriefSync`: la cartella deve stare lì sotto.
- `since`: il giorno da cui partire, per esempio `01/01/2026`.
- `envFile`: `~/.octobrief/<progetto>.env`, per esteso.
- togli i blocchi dei sistemi che il progetto non ha.

Crea il file dei segreti, leggibile solo da te:

```bash
(umask 077; cat > ~/.octobrief/<progetto>.env) <<'ENV'
JIRA_TOKEN=<token API di Atlassian>
ADO_PAT=<personal access token, in sola lettura>
DWSI_PASSWORD=<password dell'utente in sola lettura>
ENV
```

| Sistema | Cosa serve | Note |
|---|---|---|
| Jira Cloud | token API dell'account (id.atlassian.com → Sicurezza → Token API) | `site` è il nome prima di `.atlassian.net`; `projects` le chiavi dei progetti |
| Azure DevOps | PAT con soli permessi di lettura su Work Items | segna il giorno di scadenza in `patExpiresOn`; se il progetto ADO contiene più commesse, elenca in `areas` solo le aree della tua (es. `["Team A"]`), altrimenti si legge tutto il progetto |
| NetSuite / DWSI | utente in sola lettura del database | senza TLS: `"tls": "plaintext"`, solo in VPN; `host` è un nome o un indirizzo IPv4 di rete privata |
| Microsoft 365 | Claude Code installato, con il connettore Microsoft 365 collegato al tuo account | vedi il punto 3 |

## 2. Controlla prima di leggere

```bash
node addons/sync/src/cli.ts check --config ~/.octobrief/<progetto>.json
```

Deve dire `accesso riuscito` per Jira e Azure DevOps. Se dice `source_auth_failed` il token è sbagliato o scaduto; `source_not_configured` vuol dire che la chiave o il nome del progetto non corrispondono a nulla che il token vede; `source_not_found` che un'area di `ado.areas` non esiste nel progetto. Se cambi `areas` (o i progetti di Jira), alla passata successiva la cartella di quella fonte viene svuotata e riletta dal giorno di inizio.

## 3. Microsoft 365 tramite Claude

L'addon lancia `claude -p` e gli permette solo gli strumenti elencati in `m365.allowedTools`. Verifica il nome del connettore sul tuo computer:

```bash
claude mcp list
```

`check` chiede a Claude se ha il connettore: «connettore NON disponibile (m365: connector_unavailable)» significa che `claude -p` lanciato dal terminale non lo vede, anche se in una sessione interattiva c'è. Se il nome non è `claude_ai_Microsoft_365`, metti in `allowedTools` il prefisso giusto, `mcp__<nome>`. Con `"model": "sonnet"` (o un altro nome che `claude --model` accetta) scegli il modello di queste chiamate; senza, vale quello predefinito di Claude Code. Poi indica il perimetro:
- `keywords`: parole, frasi e **indirizzi email** (persone del cliente, liste di distribuzione);
- `outlook.folders` e `outlook.mailboxes`: cartelle e caselle condivise da leggere;
- `teams.channels` (`Team/Canale`) e `teams.chats`;
- `sharepoint.paths`: indirizzi di siti o cartelle.

Prova con un periodo breve prima di recuperare mesi:

```bash
node addons/sync/src/cli.ts pull --once --config ~/.octobrief/<progetto>.json --since <una settimana fa>
```

Il recupero da una data lontana è una chiamata a Claude per settimana e per sezione (posta, Teams, file): da gennaio a novembre sono più di cento chiamate, lente e con un costo in token. Le passate successive leggono solo l'ultimo giorno.

## 4. Prima passata e passate periodiche

```bash
node addons/sync/src/cli.ts pull --once --config ~/.octobrief/<progetto>.json   # una volta
node addons/sync/src/cli.ts pull --config ~/.octobrief/<progetto>.json          # ogni everyMinutes
```

Apri `~/OctobriefSync/<progetto>/_stato.md`: per ogni sistema dice quanti elementi ci sono, da quando, fino a quando e l'esito dell'ultima passata.

Per tenerlo acceso senza un terminale aperto, su macOS: un agente `launchd` (`~/Library/LaunchAgents/…plist`) che esegue lo stesso comando con `RunAtLoad` e `KeepAlive`.

## 5. Collega la cartella in Octobrief

Nel progetto, pagina **Fonti**, riquadro **Collega una cartella sincronizzata**:

- **Octobrief sullo stesso computer**: scegli «È su questa macchina: la legge il server», scrivi il percorso della cartella e spunta i sistemi presenti. Il worker la rilegge ogni `SYNC_INTERVAL_MINUTES` (15 se non impostato in `.env.local`); «Leggi ora» lo fa subito.
- **Octobrief sul server**: scegli «È sul PC del PM: la invia l'addon». Octobrief mostra **una volta sola** il blocco `push` da incollare nella configurazione e le righe `OCTOBRIEF_TOKEN_…` da aggiungere al file `.env`. Poi, in un secondo terminale:
  ```bash
  node addons/sync/src/cli.ts push --config ~/.octobrief/<progetto>.json
  ```

Da qui il progetto si usa come gli altri: Memoria, Chiedi, Deliverable.

## 6. Quando scade il PAT di Azure DevOps

`check` e `_stato.md` avvisano dal giorno prima. Alla scadenza la passata di Azure DevOps dà `source_auth_failed` e le altre fonti continuano. Per rinnovare: genera un nuovo PAT in sola lettura, sostituisci `ADO_PAT` nel file `.env`, aggiorna `patExpiresOn`. Non serve altro: la passata successiva riprende da dove si era fermata.

## Limiti

- I sistemi reali non sono stati provati durante lo sviluppo: la demo usa sistemi finti. I primi `check` e `pull --once` sul progetto reale sono la verifica vera; riporta i codici d'errore che compaiono.
- Il nome degli strumenti del connettore Microsoft 365 e la sua disponibilità per `claude -p` vanno verificati sul computer del PM.
- Microsoft 365 passa da un modello: il testo può essere troncato o riformulato. Per ciò che deve essere esatto (contratti, verbali firmati) carica il file a mano.
- Gli export di Jira e Azure DevOps si accumulano: ogni passata che trova modifiche scrive un nuovo «Export … del gg/mm».
