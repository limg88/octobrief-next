# Demo 07 — Verbale da trascritto (incremento 6a)

**Durata**: circa 4 minuti. **Cosa dimostra**:
- i testi scritti da un **agente con pochi strumenti**: per ogni testo cerca nel progetto, legge il trascritto e cita il punto esatto;
- i nomi di chi parla nel trascritto, riconosciuti all'elaborazione del documento e nascosti al modello;
- controlli della ricetta, accettazione motivata, approvazione e file Word dal renderer isolato.

**Prerequisiti**: Node 24, pnpm 12, Docker avviato; porte 3310, 4320, 5450 e 5451 libere.

Modello finto e dati sintetici.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/07-verbale/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | Database e renderer | `renderer pronto…` | — |
| 2 | Trascritto | `il file .vtt è riconosciuto come trascritto` e alcune righe del file | Il prerequisito della ricetta è soddisfatto dalla classificazione a regole |
| 3 | Bozza | data, partecipanti, decisione, azione e rischio, ciascuno con la sua nota `[n]` | Ogni testo cita il punto del trascritto da cui viene |
| 4 | Strumenti e nomi | `Strumenti chiamati dall'agente: {"search_knowledge":…,"read_evidence":…}`; nessun nome nel modello; nomi presenti nel verbale | L'agente ha solo strumenti di lettura; oratori e partecipanti sono pseudonimizzati |
| 5 | Controlli e approvazione | un'anomalia accettabile sugli action item, accettata con motivazione; `documento approvato` | La ricetta ha i suoi controlli; l'eccezione resta motivata |
| 6 | File | `demo-07-verbale.docx` inizia con `PK`; anteprima del Markdown | Word prodotto dal renderer isolato dal template neutro |

## Nel browser (circa 2 minuti)

7. Apri l'indirizzo stampato alla fine, accedi come **Paola Prova** e apri «Verbale da trascritto»: stato, file da scaricare e documento con le fonti numerate.
8. Scarica il `.docx` e aprilo: le sezioni «non dedotte» sono quelle di cui il trascritto non dice nulla.

Per fermare: il `kill` stampato alla fine, poi `docker compose --env-file .env.local --profile renderer stop renderer renderer-gateway`.

## Test

```bash
node scripts/with-env.ts pnpm test:coverage
```
