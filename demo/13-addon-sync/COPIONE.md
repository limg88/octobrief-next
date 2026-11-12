# Demo 13 — Addon di sincronizzazione (incrementi 8b e 8c)

**Durata**: circa 5 minuti. **Cosa dimostra**:
- l'addon `octobrief-sync` (pacchetto `addons/sync`, versionato a parte) legge **Jira**, **Azure DevOps** e **Microsoft 365** (tramite Claude) e tiene aggiornata una **cartella ordinata di file Markdown**;
- la **data di inizio** (`since`) limita cosa viene letto, e spostarla indietro recupera il periodo mancante;
- i segreti stanno in un file `.env` privato, mai nella configurazione; il **PAT di Azure DevOps in scadenza** è segnalato un giorno prima;
- la cartella arriva a Octobrief **letta dal server** oppure **inviata dal PC** (`push`), con intervalli configurabili da entrambe le parti.

**Prerequisiti**: Node 24, pnpm 12, Docker avviato; porte 3310, 4320 e 5450 libere.

Tutti i sistemi sono finti e in locale: un Jira e un Azure DevOps sintetici e un programma che risponde al posto di Claude con il connettore Microsoft 365. NetSuite/DWSI non è nella demo (richiede un database): l'addon lo legge con lo stesso meccanismo.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/13-addon-sync/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | Sistemi finti | gli indirizzi locali di Jira e Azure DevOps | — |
| 2 | Configurazione | l'esempio scritto da `init`; `nessun segreto nella configurazione` | La configurazione nomina solo le variabili; i valori stanno nel file `.env` |
| 3 | `check` | due `accesso riuscito` e `ATTENZIONE: Il PAT di Azure DevOps scade il …` | Si controlla tutto prima di leggere; il PAT che scade è segnalato |
| 4 | Prima passata | `jira: 4 scritti`, `ado: 3 scritti`, `m365: 2 scritti`; l'elenco dei file; `_stato.md` | Una sottocartella per sistema; BOR-4, fermo da agosto, non è letto perché precede il 1° ottobre |
| 5 | Octobrief legge | 5 attività come dati, il fatto sul budget, nessun «Carla» nel modello | Le fonti sono del tipo vero; le persone lette da Claude restano nascoste al modello |
| 6 | Le fonti cambiano | seconda passata; BOR-1 `Done`; 6 attività | Si legge solo ciò che è cambiato; Octobrief segue |
| 7 | Data precedente | `jira: 1 scritti, 4 invariati`; ora c'è `bor-4` | `--since 2026-08-01` recupera il periodo mancante senza riscrivere il resto |
| 8 | Periodico | `Ogni 1 minuti; Ctrl+C per fermare.` | L'addon resta acceso e ripete |
| 9 | `push` | tre righe `… nuovi … record`; 7 attività nel secondo progetto | Con il server on-prem la cartella parte dal PC, con il token di ogni fonte |

Ciò che cambia a una fonte negli ultimi 10 minuti arriva alla passata successiva: Jira e Azure DevOps indicizzano con ritardo, e il connettore aspetta per non perdere nulla.

## Nel browser (circa 3 minuti)

10. Apri l'indirizzo stampato alla fine (`…/projects/borea-…/sources`) e accedi come **Paola Prova**: tre fonti, «Jira · dalla cartella …», «Azure DevOps · dalla cartella …», «Microsoft 365 · dalla cartella …», con ultima lettura e «dati aggiornati al».
11. Vai su **Memoria**: «RE Budget Borea.md» e «Allineamento settimanale Borea.md» sono arrivati «da m365 (cartella sincronizzata)»; in «Cosa ho capito» c'è il budget di 890.000 euro.
12. Vai su **Chiedi** e domanda «Qual è il budget approvato?»: la risposta cita la mail.
13. Apri in un editor la cartella stampata al passo 4: `_stato.md` riassume ogni sistema, e ogni file si legge anche senza Octobrief.

Per fermare tutto: il comando `kill` stampato alla fine della parte automatica.

## Test

```bash
node scripts/with-env.ts pnpm test:coverage
```
