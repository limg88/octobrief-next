# Demo 08 — Stima dei costi (incremento 6b)

**Durata**: circa 3 minuti. **Cosa dimostra**:
- una ricetta **solo interna**: tariffe, giorni e costi non hanno una versione per il cliente;
- i conti li controlla il codice: subtotali per fase, contingenza e totale devono tornare;
- file Excel dal renderer isolato.

**Prerequisiti**: Node 24, pnpm 12, Docker avviato; porte 3310, 4320, 5450 e 5451 libere.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/08-stima-costi/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1–2 | Avvio | `renderer pronto…`, `progetto aurora-…` | — |
| 3 | Stima con un errore | `3 anomalie aperte`: costi per fase, totale, contingenza; non approvabile | Un costo sbagliato di 1.000 € fa scattare tre controlli della ricetta |
| 4 | Stima corretta | `0 anomalie aperte` e i valori calcolati (giorni 30, costo 13.000,00, contingenza 10%, totale 14.300,00) | I totali sono calcolati dal sistema, non scritti dal modello |
| 5 | Approvazione | due file `…-interno.md` e `…-interno.xlsx`; `solo file per uso interno` | Nessuna versione per il cliente; Excel dal template neutro |

## Nel browser (circa 1 minuto)

6. Apri l'indirizzo stampato alla fine, accedi come **Paola Prova**: ci sono le due stime. Quella con l'errore mostra le tre anomalie, ciascuna con il campo per motivare un'eventuale accettazione; quella corretta ha i file da scaricare.

Per fermare: il `kill` stampato alla fine, poi `docker compose --env-file .env.local --profile renderer stop renderer renderer-gateway`.

## Test

```bash
node scripts/with-env.ts pnpm test:coverage
```
