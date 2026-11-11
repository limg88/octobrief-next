# Demo 01 — Accesso e shell

**Durata:** circa 5 minuti: 2 per lo script, 3 nel browser.

**Cosa dimostra:**
- Il login passa da OpenID Connect con lo stesso codice che userà Entra ID; in sviluppo cambia solo l'issuer, che è finto.
- Le sessioni stanno sul server e si possono revocare.
- Le richieste che modificano dati sono protette dal CSRF.
- I ruoli PM e admin vengono letti dal database.
- I progetti hanno un responsabile e dei membri.
- La shell di Studio ha barra laterale, palette ⌘K, scorciatoie da tastiera, tema chiaro/scuro e lingua italiano/inglese.

## Prerequisiti
- Node 24, pnpm 12, Docker in esecuzione, curl.
- Porte libere: `5450` (Postgres), `3310` (web), `4320` (issuer finto).
- Solo persone sintetiche:
  - Paola Prova (PM);
  - Marco Esempio (PM);
  - Alba Amministratrice (admin, tramite `ADMIN_EMAILS`).

## Esecuzione rapida
```bash
KEEP=1 bash demo/01-accesso-e-shell/run.sh
```
I passi 1–7 qui sotto li esegue lo script, che si ferma con `✔ Demo 01 completata.` Ogni verifica che fallisce interrompe lo script.

Con `KEEP=1`, web, worker e issuer finto restano accesi per la parte nel browser (passi 8–12).

## Copione

### Parte automatica (script)
| # | Cosa dire | Cosa si vede |
|---|---|---|
| 1 | "Un comando prepara tutto: dipendenze, Postgres, ruoli, coda e schema versionato." | `Schema up to date` oppure `Migrations applied: 0001_identity_and_projects.sql` |
| 2 | "In sviluppo, al posto di Entra ID parte un issuer OpenID Connect finto. Il codice di login è lo stesso." | `Web pronto su http://127.0.0.1:3310` |
| 3 | "Senza sessione non si entra: le pagine rimandano al login, le API rispondono 401." | `307 …/login?return_to=%2Fprojects%2Fqualsiasi`, `✔ API senza sessione: 401` |
| 4 | "Paola e Marco entrano con il flusso completo: PKCE, state e nonce." | `Paola Prova · ruolo pm · lingua it` |
| 5 | "Paola crea un progetto, che Marco non vede. Paola lo aggiunge e da quel momento Marco lo vede, ma non può gestire i membri." | Il progetto creato in JSON, poi tre `✔` |
| 6 | "Le difese: senza token CSRF si riceve 403, la diagnostica è riservata agli admin, l'admin vede tutti i progetti." | Quattro `✔` |
| 7 | "La lingua è una preferenza salvata nel profilo. Il logout revoca la sessione sul server." | `✔ sessione revocata sul server` |

### Parte nel browser
| # | Cosa fare | Cosa si vede |
|---|---|---|
| 8 | Apri `http://127.0.0.1:3310` e premi **Accedi con Microsoft** | La pagina «Accesso di prova» dell'issuer finto: scegli **Paola Prova** |
| 9 | Nella pagina **Progetti** premi **Nuovo progetto**, scrivi "Migrazione ERP" e il cliente "Beta Sintetica", poi conferma | Il messaggio «Progetto creato» e la Panoramica con Paola come *Responsabile* |
| 10 | Aggiungi `marco.esempio@example.test` nel riquadro **Membri** | Marco compare nell'elenco come *Membro* |
| 11 | Premi **⌘K** (Ctrl+K su Windows), scrivi "memo" e premi Invio. Poi premi **G** e subito dopo **C** | Prima la sezione Memoria, poi Chiedi. Sono pagine segnaposto che indicano in quale incremento arriveranno |
| 12 | Premi ⌘K e scegli **Switch to English**; poi ⌘K e **Toggle light/dark theme**; infine dal menu utente in basso a sinistra scegli **Sign out** | L'interfaccia passa all'inglese e poi al tema chiaro. Il logout riporta al login |

## Qualità (fuori dalla demo)
```bash
pnpm typecheck && pnpm lint && pnpm test:coverage
```
Esito alla chiusura dell'incremento 1:
- 128 test passati.
- Coverage: 94% statement, 88% branch, 96% funzioni, 95% righe.

## Pulizia
1. Con `KEEP=1`, ferma prima i processi rimasti accesi con il comando `kill` stampato alla fine dello script.
2. Poi ferma Postgres:
   ```bash
   docker compose --env-file .env.local down
   ```
