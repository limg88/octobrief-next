# Demo 11 — Deploy on-prem (incremento 7)

**Durata**: circa 5 minuti (la prima volta la costruzione delle immagini aggiunge 2–3 minuti). **Cosa dimostra**:
- l'installazione di produzione parte **da zero con un comando**: immagini, database, ruoli, migrazioni, web, worker, renderer e Caddy;
- all'esterno è pubblicato **solo HTTPS**: database e renderer non hanno porte, il renderer non ha uscita verso la rete, il web non conosce le credenziali del worker;
- **backup e ripristino** riportano progetti, storico e file caricati dopo la perdita dei volumi.

**Prerequisiti**: Docker avviato, Node 24, `curl`, `openssl`; porte 8443 e 4321 libere. Non servono `pnpm install` né il database di sviluppo.

La demo usa un progetto compose a parte (`octobrief-demo-11`) con i suoi volumi: non tocca il database di sviluppo. L'accesso passa per l'issuer finto, aggiunto solo qui da `deploy/compose.demo.yml`; modello finto e dati sintetici.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/11-deploy/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | File d'ambiente | elenco `Added …` senza valori; permessi `600` | I segreti sono generati sul server e non vengono mai stampati |
| 2 | Avvio da zero | tabella dei servizi: solo `caddy` pubblica `8443` (e `web` la porta dell'issuer finto, solo in demo) | Un comando porta su tutta l'installazione; ruoli e migrazioni sono servizi a esecuzione singola |
| 3 | Superficie esposta | sei `✔`: HTTPS, nessuna porta per Postgres e renderer, renderer senza uscita, web non root e senza credenziali del worker | Il minimo necessario è raggiungibile; ogni processo ha solo i suoi segreti |
| 4 | Uso | progetto creato, documenti letti, risposta con `✔` sulle fonti | Web, worker e coda lavorano insieme dietro Caddy, streaming compreso |
| 5 | Backup | `database.dump`, `blobs.tar.gz`, `SHA256SUMS` | Un comando salva database e file |
| 6 | Perdita dei dati | `nessun progetto` | I volumi sono stati cancellati davvero |
| 7 | Ripristino | progetto, file e storico tornati | Il backup basta a ricostruire l'installazione |

## Nel browser (circa 2 minuti)

8. Apri `https://localhost:8443`: il browser segnala il certificato dell'autorità interna di Caddy; conferma. In produzione si usano i certificati dell'azienda (vedi runbook).
9. Accedi come **Paola Prova**: c'è il progetto «Aurora …» con i documenti e, in **Chiedi**, la domanda sul budget con le sue fonti.
10. Apri `docs/runbook.md`: installazione, aggiornamento, backup, ripristino e controlli sono gli stessi comandi visti qui.

Per fermare e cancellare: il comando stampato alla fine (`deploy/octobrief.sh down -v` con le tre variabili della demo).

## Test

```bash
node scripts/with-env.ts pnpm test:coverage
```
