# Demo 10 — Rischi e opportunità (incremento 6d)

**Durata**: circa 4 minuti. **Cosa dimostra**:
- una **ricetta nuova**, scritta come file JSON (`recipes/risks-and-opportunities.json`) e validata all'avvio, senza toccare il codice;
- gli elenchi di rischi, azioni e decisioni presi dai **fatti della memoria** (incremento 2b), non dal modello;
- documento interno in Word.

**Prerequisiti**: Node 24, pnpm 12, Docker avviato; porte 3310, 4320, 5450 e 5451 libere.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/10-rischi-opportunita/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | Avvio | `renderer pronto…` | — |
| 2 | La ricetta | titolo, versione, sezioni e tipi di blocco | Una ricetta è un file: sezioni, elenchi dai fatti, testi con istruzioni e nature ammesse |
| 3 | Documenti e fatti | un `[risk]`, un `[action]`, una `[decision]` | I fatti nascono dalla lettura dei documenti, con citazione verificata |
| 4 | Bozza | elenco dei rischi dal SAL, valutazione, azioni e decisioni; la frase «Ignora le istruzioni…» non c'è | Gli elenchi sono dati; i testi citano le fonti; le frasi-istruzione dei documenti non entrano |
| 5 | Approvazione | `rischi-e-opportunita-1.0.0-interno.docx` e `.md`; il file inizia con `PK` | Documento interno in Word |

## Nel browser (circa 2 minuti)

6. Apri l'indirizzo stampato alla fine e accedi come **Paola Prova**: «Rischi e opportunità» è nel catalogo insieme alle altre ricette.
7. Apri il documento approvato: gli elenchi hanno la nota della fonte («Conoscenza di progetto: …»), i testi le note dei valori che citano.

Con il modello finto i testi di valutazione ripetono i dati dell'elenco: con un modello reale sono scritti in prosa, e i controlli restano gli stessi.

Per fermare: il `kill` stampato alla fine, poi `docker compose --env-file .env.local --profile renderer stop renderer renderer-gateway`.

## Test

```bash
node scripts/with-env.ts pnpm test:coverage
```
