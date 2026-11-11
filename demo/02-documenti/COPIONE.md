# Demo 02 — Documenti (incremento 2a)

**Durata**: circa 5 minuti. **Cosa dimostra**:
- il caricamento dei documenti su un progetto;
- l'estrazione del testo in un processo isolato, con la posizione di ogni brano;
- la classificazione a regole (tipo, destinatari, data), con i campi incerti da confermare;
- la correzione del PM;
- la protezione dei dati con RLS nel database;
- l'eliminazione e la conservazione.

**Prerequisiti**:
- Node 24, pnpm 12 e Docker avviato;
- porte 3310, 4320 e 5450 libere: se hai lasciato accesa una demo precedente, fermala con il `kill` stampato alla sua fine.

I documenti sono **sintetici**: li genera `tools/synthetic` a partire da un seme e non contengono dati reali.

## Parte automatica (circa 2 minuti)

```bash
KEEP=1 bash demo/02-documenti/run.sh
```

| # | Passo | Output atteso | Cosa dimostra |
|---|---|---|---|
| 1 | Prerequisiti e database | `Schema up to date` (o `Migrations applied: 0002_documents.sql` la prima volta) | La migrazione 0002 crea le tabelle `documents` e `document_chunks` con le policy RLS |
| 2 | Documenti sintetici | 3 file: `SAL-….md`, `Verbale-….docx`, `Nota-fornitore-….txt` | Dati di prova riproducibili, mai dati di clienti |
| 3 | Avvio e progetto | `progetto aurora-…` | Paola crea il progetto; Marco non è membro |
| 4 | Caricamento | 3 righe `→ pending`, poi `✔ … 409` | Il file viene salvato e la sua elaborazione va in coda; lo stesso contenuto due volte viene rifiutato |
| 5 | Elaborazione | `✔ tutti i documenti elaborati`, poi la tabella con tipo, destinatari, data e campi da confermare | Il worker estrae il testo in un processo figlio con limiti di memoria e di tempo, poi classifica a regole senza LLM: SAL → `status_report`, verbale → `meeting_minutes`, data presa dal nome del file |
| 6 | Testo del verbale Word | brani con `{"kind":"paragraph","index":1}` | Ogni brano conserva la sua posizione nel documento: servirà per le citazioni (incremento 2b) |
| 7 | Correzione e protezione | 4 righe `✔` | Il PM sceglie «cliente» come destinatari; Marco riceve 404; nel database il ruolo web senza utente vede 0 righe, impostato su Paola ne vede 3 |
| 8 | Eliminazione | `✔ DELETE: 204`, `✔ file rimosso da BLOB_DIR` | Documento, testo e file vengono rimossi |

## Parte nel browser (circa 3 minuti)

Apri l'indirizzo stampato alla fine dello script, nella forma `http://127.0.0.1:3310/projects/<slug>/memory`.

9. **Accedi come Paola**: nella pagina di login scegli «Paola Prova». Arrivi in Studio; poi premi `G` e `M`, oppure apri la voce Memoria nella barra laterale. *Atteso*: la tabella con SAL e verbale, ciascuno con tipo, destinatari, data con la sua fonte, numero di brani e l'avviso «da confermare» accanto ai campi incerti.
10. **Carica un file**:
    - trascina nella zona tratteggiata `.tmp/demo-02-docs/Backlog-*.csv` oppure il file di trascrizione `.vtt`;
    - *atteso*: il messaggio «… caricato», poi lo stato passa da «In elaborazione» a «Pronto» senza ricaricare la pagina;
    - ricaricando lo stesso file compare l'errore «Il progetto contiene già questo file».
11. **Correggi e controlla**:
    - cambia il tipo di un documento dal menu «Tipo»: l'avviso «da confermare» sparisce;
    - premi l'icona a forma di occhio («Vedi testo»): si apre il testo estratto, con la posizione di ogni brano (`righe 1–3`, `§ 1`…).
12. **Elimina**: premi il cestino e conferma. *Atteso*: «… eliminato», e la riga sparisce dalla tabella.

**Per chiudere**: esegui il `kill -- -<PID>` stampato dallo script.

## Note
- **Formati supportati**: PDF, Word, PowerPoint, Excel, testo, Markdown, CSV e VTT, fino a 50 MB. Un file protetto da password o in un formato non supportato risulta «Non leggibile».
- **Conservazione**: ogni ora il worker elimina i documenti più vecchi di `RETENTION_DAYS` (in `.env.local`, 365 giorni di default). Il comportamento è coperto dai test; per vederlo dal vivo imposta `RETENTION_DAYS=1`, carica un documento e cambia la data di caricamento nel DB.
- **Nel prossimo passo (incremento 2b)**: pseudonimizzazione, compilazione dei fatti con citazioni verificate, embeddings e la sezione «Cosa ho capito».
