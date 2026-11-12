# Demo 06 — Deliverable: SAL economico e Mail al cliente (incremento 5)

**Durata**: circa 5 minuti. **Cosa dimostra**:
- il motore delle ricette: il codice raccoglie i dati, il modello scrive solo i testi, centinaia di controlli deterministici giudicano la bozza;
- le anomalie: cosa blocca l'approvazione, cosa si corregge chiedendo una modifica, cosa il PM può accettare con una motivazione;
- l'approvazione e i file: Markdown scritto dal sistema, Excel prodotto da un renderer Python isolato a partire dal modulo SAL;
- due ricette con lo stesso motore: **SAL economico** e **Mail al cliente**.

**Prerequisiti**:
- Node 24, pnpm 12 e Docker avviato;
- porte 3310, 4320, 5450 e 5451 libere: se hai lasciato accesa una demo precedente, fermala con il `kill` stampato alla sua fine.

Il modello è **finto**: in questa demo mette apposta, nel primo testo della prima bozza, una cifra che nessuna fonte riporta (`LLM_FAKE_INVENT_IN_DRAFTS=true`), per mostrare l'anomalia e la sua correzione. I dati sono **sintetici**.

## Parte automatica (circa 3 minuti; la prima volta costruisce l'immagine del renderer)

```bash
KEEP=1 bash demo/06-deliverable/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | Database e renderer | `renderer pronto su http://127.0.0.1:5451` | Il renderer gira su una rete interna senza uscita, non root, in sola lettura |
| 2 | Dati sintetici | `ordine: Ordine-OA-…md · fatture: …` | Nessun dato reale |
| 3 | Progetto e documenti | `Ordine-… → purchase_order` | L'ordine è classificato dalle regole: è il prerequisito del SAL |
| 4 | Catalogo | 8 ricette con formati e destinatari | Le ricette sono file validati all'avvio |
| 5 | Bozza del SAL | `Revisione 1: 3xx controlli, 4 anomalie aperte`; la prima cita «123.456 euro»; `approvazione rifiutata: 409` | Il modello ha scritto un solo testo; il resto viene dai dati. Un dato senza fonte blocca |
| 6 | Chiedi modifica | `seconda revisione pronta`; `la cifra inventata non c'è più` | Si riscrive solo il testo indicato; il resto del documento non cambia |
| 7 | Accetta con motivazione | due lettere: `400`; una frase: `200`; `0 anomalie aperte, 1 accettate` | Solo le anomalie accettabili, e solo con una motivazione che resta agli atti |
| 8 | Approva | `sal-economico-1.0.0-cliente.md` e `.xlsx`; il file inizia con `PK`; anteprima del Markdown | Il file Excel nasce dal modulo SAL nel renderer isolato; Marco (non membro) non può approvare |
| 9 | Mail al cliente | bozza, oggetto riscritto, `mail approvata`, testo della mail; `due deliverable approvati` | Stesso motore, altra ricetta, solo Markdown |

I file scaricati restano in `.tmp/demo-06-sal-cliente.xlsx`, `.tmp/demo-06-sal-cliente.md` e `.tmp/demo-06-mail.md`.

## Parte nel browser (circa 2 minuti)

10. Apri l'indirizzo stampato alla fine (`…/projects/aurora-…/deliverables`) e accedi come **Paola Prova**.
    A sinistra ci sono il catalogo delle ricette e i due documenti approvati.
11. Apri «SAL economico»: stato «Approvato», i due file da scaricare, il conto dei controlli, l'anomalia accettata con la sua nota, e sotto il documento con valori, tabelle e fonti numerate.
12. Dal catalogo scegli «Mail al cliente», compila il modulo (tipo, cosa si chiede, a chi, entro quando) e premi **Prepara il documento**: vedi le fasi («Raccolgo i dati…», «Scrivo i testi…», «Controllo il documento…»), poi l'anomalia sull'oggetto. Scrivi cosa cambiare e premi **Chiedi modifica**; quando non restano anomalie aperte, **Approva**.

Per fermare tutto: il comando `kill` stampato alla fine della parte automatica, poi
`docker compose --env-file .env.local --profile renderer stop renderer renderer-gateway`.

## Test

```bash
node scripts/with-env.ts pnpm test:coverage   # unit e integrazione, soglia 80%
pnpm e2e                                      # Playwright + axe
docker build -f apps/renderer/Dockerfile --target test -t octobrief-new-renderer:test . \
  && docker run --rm octobrief-new-renderer:test   # i 465 test Python del renderer
```
