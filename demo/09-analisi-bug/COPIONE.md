# Demo 09 — Analisi bug e CR (incremento 6c)

**Durata**: circa 4 minuti. **Cosa dimostra**:
- una ricetta che lavora sui **dati del tracker** (Jira o Azure DevOps): conteggi e elenchi li calcola il codice;
- il prerequisito «una fonte Jira o ADO collegata»;
- file Excel con le tabelle della dashboard.

**Prerequisiti**: Node 24, pnpm 12, Docker avviato; porte 3310, 4320, 5450 e 5451 libere.

Jira è un server finto in locale con 3 bug, 2 change request e 1 storia.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/09-analisi-bug/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | Avvio | `renderer pronto…`, `Jira finto su http://127.0.0.1:…` | — |
| 2 | Fonte Jira | `il worker ha letto le attività di Jira` | Le attività sono dati strutturati, non documenti |
| 3 | Dashboard | `Bug e CR nel tracker: 5`, `Aperti: 3`, `Chiusi: 2`; tabella per tipo; elenco degli aperti con titolo, tipo, stato, priorità | I numeri vengono dal tracker |
| 4 | Perimetro | la storia non compare; il bug aperto sì | Solo i tipi indicati dal PM entrano nel conteggio |
| 5 | Controlli e approvazione | `45x controlli, 0 anomalie aperte`, `documento approvato` | — |
| 6 | File | `demo-09-dashboard.xlsx` inizia con `PK` | Excel dal renderer isolato |

## Nel browser (circa 2 minuti)

7. Apri l'indirizzo stampato alla fine e accedi come **Paola Prova**: la dashboard approvata mostra le tabelle per tipo, priorità e stato.
8. Vai su **Fonti**: «Jira Borea» con l'ultima lettura. Vai su **Chiedi** e domanda «Quanti bug sono aperti?»: con un modello reale la risposta userebbe lo strumento `query_tracker`; il modello finto cerca solo nei documenti.

Per fermare: il `kill` stampato alla fine, poi `docker compose --env-file .env.local --profile renderer stop renderer renderer-gateway`.

## Test

```bash
node scripts/with-env.ts pnpm test:coverage
```
