# Demo 12 — Cartella sincronizzata (incremento 8a)

**Durata**: circa 5 minuti. **Cosa dimostra**:
- Octobrief importa una **cartella di file Markdown**: il testo è leggibile da una persona, l'intestazione porta i dati che un testo perderebbe (id e versione alla fonte, date, persone, campi delle attività);
- ogni sistema della cartella diventa una fonte **del suo tipo vero** (Jira, Microsoft 365…), quindi i deliverable funzionano come con il collegamento diretto;
- la cartella arriva in due modi: **letta dal server** a intervalli (stesso computer) oppure **inviata dal PC** con il token della fonte (server on-prem).

**Prerequisiti**: Node 24, pnpm 12, Docker avviato; porte 3310, 4320 e 5450 libere.

Dati sintetici e modello finto. La cartella della demo è scritta da uno script; dall'incremento 8b la scrive l'addon di sincronizzazione.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/12-cartella-sincronizzata/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | Cartella | elenco dei file: `jira/BOR-1.md` … `m365/mail/…`, `m365/riunioni/…` | Una sottocartella per sistema |
| 2 | Un file | intestazione `octobrief: 1`, `system: "jira"`, `type: "record"` e sotto il testo | Un file è insieme documento e dato |
| 3 | Collegamento | `folder_not_allowed` per `/etc`; due fonti con `feed` = `folder` | Il server legge solo sotto `SYNC_FOLDERS_ROOT`; niente credenziali né token |
| 4 | Lettura | 6 attività come dati, 2 documenti, il fatto sul budget, nessun «Carla» nel modello | Stessa pipeline dei caricamenti: fatti con citazione, persone nascoste al modello |
| 5 | Dashboard | `Bug e CR nel tracker: 5 \| Aperti: 3 \| Chiusi: 2` | I deliverable usano i dati della cartella |
| 6 | La cartella cambia | BOR-1 chiuso, BOR-6 rimosso, dashboard `Aperti: 2 \| Chiusi: 3` | «Leggi ora» rilegge; ciò che sparisce alla fonte viene segnato |
| 7 | Invio dal PC | `5 record`; 5 attività nel secondo progetto | Con il server on-prem la cartella non serve sul server |
| 8 | Riepilogo | le fonti con tipo, modo e ultima lettura | — |

## Nel browser (circa 3 minuti)

9. Apri l'indirizzo stampato alla fine (`…/projects/borea-…/sources`) e accedi come **Paola Prova**: le due fonti mostrano «Jira · dalla cartella …» e «Microsoft 365 · dalla cartella …», con ultima lettura e «dati aggiornati al».
10. Su «Jira (cartella sincronizzata)» premi **Leggi ora**: compare «Lettura avviata» e l'ora dell'ultima consegna si aggiorna.
11. Nel riquadro **Collega una cartella sincronizzata** scegli «È sul PC del PM: la invia l'addon», lascia solo «Altri file» e premi **Collega la cartella**: compare il riquadro con il blocco `push` per la configurazione dell'addon e la riga `OCTOBRIEF_TOKEN_FILES=…` per il suo file `.env`.

Per fermare tutto: il comando `kill` stampato alla fine della parte automatica.

## Test

```bash
node scripts/with-env.ts pnpm test:coverage
```
