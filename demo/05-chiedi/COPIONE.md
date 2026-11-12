# Demo 05 — Chiedi (incremento 4)

**Durata**: circa 5 minuti. **Cosa dimostra**:
- le domande sul progetto: il modello legge con strumenti di sola lettura (ricerca per parole e per significato), poi risponde;
- la verifica frase per frase: ogni frase vale solo se le fonti lette la sostengono, numeri compresi;
- le contraddizioni fra fonti, riportate con tutti i lati;
- la freschezza delle fonti e la segnalazione di una versione più recente;
- l'avanzamento in tempo reale (eventi dal server) e lo storico, privato per persona.

**Prerequisiti**:
- Node 24, pnpm 12 e Docker avviato;
- porte 3310, 4320 e 5450 libere: se hai lasciato accesa una demo precedente, fermala con il `kill` stampato alla sua fine.

Il modello è **finto e deterministico**, i documenti **sintetici**.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/05-chiedi/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | Prerequisiti e database | `Schema up to date` (o `Migrations applied: 0005_ask.sql`) | La migrazione 0005 crea l'indice del testo e la tabella delle domande |
| 2 | Documenti | `4 documenti pronti` | Due SAL in disaccordo sul budget, una nota con una frase-istruzione, una nota con un nome |
| 3 | Avvio e lettura | `4 documenti letti` | Fatti e vettori pronti per la ricerca |
| 4 | Domanda sul budget | `Avanzamento (eventi dal server): queued → … → done`; frasi con `✔ fonte · data`; `⚠ Contraddizione` con due lati; il SAL vecchio marcato `superseded` | Risposta citata, contraddizione in evidenza, versione superata segnalata |
| 5 | Numero inventato | `[frase sospesa: without_source]`, fonte `✘ numbers_not_in_source`, `anomalie: 1` | Un numero che nessuna fonte riporta non viene mai mostrato |
| 6 | Persone | la risposta nomina «Paola Prova»; nessun «Paola» in ciò che il modello ha ricevuto | La pseudonimizzazione vale anche per domande e letture |
| 7 | Domanda senza risposta | `? Manca: …`, `0/1` | Il sistema dice cosa manca invece di inventare |
| 8 | Storico e permessi | 4 domande per Paola; Marco: `404`, poi (da membro) storico vuoto e `404` sulla domanda di Paola | Ogni persona vede solo le proprie domande (RLS) |

Con il marcatore `#inventa` nella domanda il modello finto aggiunge alla prima frase un numero mai letto: serve solo a mostrare il controllo senza un modello reale.

## Parte nel browser (circa 3 minuti)

9. Apri l'indirizzo stampato alla fine (`…/projects/borea-…/ask`) e accedi come **Paola Prova**.
   A destra c'è lo storico delle 4 domande; al centro l'ultima risposta.
10. Apri la prima domanda sul budget: ogni frase ha l'etichetta **Fatto**, la freschezza (**Datato**, con «esiste una versione più recente» sul SAL vecchio) e le fonti con file, posizione e data. Sotto, il riquadro **Fonti in contraddizione** e il conto dei controlli.
11. Scrivi «Quali rischi segnala il fornitore?» e premi **Chiedi**: compaiono «In coda…», «Sto leggendo…», «Sto verificando…» e poi la risposta.

Per fermare tutto: il comando `kill` stampato alla fine della parte automatica.

## Test

```bash
node scripts/with-env.ts pnpm test:coverage   # unit e integrazione, soglia 80%
pnpm e2e                                      # Playwright + axe: login, caricamento, Chiedi
```

`pnpm e2e` avvia da solo web, worker e issuer finto (o riusa quelli accesi). La prima volta: `pnpm exec playwright install chromium`.
