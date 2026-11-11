# Demo 00 — Fondamenta

**Durata:** circa 3 minuti (5 alla prima esecuzione, per scaricare l'immagine di Postgres).
**Cosa dimostra:** il nuovo progetto ha le fondamenta in piedi. Database, coda dei lavori, worker e API sono avviati e collegati tra loro, ciascuno con il proprio ruolo nel database. Il contratto delle API è pubblicato in formato OpenAPI.

## Prerequisiti
- Node 24, pnpm 12, Docker in esecuzione, curl.
- Porte libere: `5450` (Postgres) e `3310` (web).

## Esecuzione rapida
```bash
bash demo/00-fondamenta/run.sh
```
Lo script esegue da solo tutti i passi qui sotto e si ferma con `✔ Demo 00 completata.` Se vuoi lasciare web e worker accesi per aprire il browser, lancia invece `KEEP=1 bash demo/00-fondamenta/run.sh`.

## Copione passo per passo

| # | Cosa fare / dire | Comando | Risultato atteso |
|---|---|---|---|
| 1 | "Partiamo da una macchina con solo Node, pnpm e Docker." | `node -v && pnpm -v && docker --version` | Le tre versioni |
| 2 | "Un solo comando prepara il database: Postgres 17 con pgvector, tre ruoli distinti (owner, web, worker) e lo schema della coda. Le password sono generate in `.env.local` e non finiscono mai nel repository." | `pnpm db:setup` | `Postgres ready on 127.0.0.1:5450` |
| 3 | "Avvio web e worker insieme." | `pnpm dev` (in un secondo terminale) | Nel log del worker compare `worker started`; Next risponde su `http://127.0.0.1:3310` |
| 4 | "Il sistema controlla da solo le sue dipendenze." | `curl -s http://127.0.0.1:3310/api/health` | `{"status":"up","components":[{"name":"database","status":"up"},{"name":"queue","status":"up"}]}` |
| 5 | "Il web non esegue mai lavoro pesante: lo mette in coda. Lo dimostro con un ping." | `curl -s -X POST http://127.0.0.1:3310/api/system/pings` | `{"jobId":"<uuid>"}`, risposta HTTP 202 |
| 6 | "Il worker lo prende in carico e lo completa." | `curl -s http://127.0.0.1:3310/api/system/pings/<uuid>` | `"status":"completed"`; nel terminale del worker compare la riga JSON `ping received` con lo stesso `jobId` |
| 7 | "Il contratto delle API è generato dal codice: frontend e test lo useranno come unica fonte di verità." | Apri `http://127.0.0.1:3310/api/openapi.json` | Tre percorsi: `/api/health`, `/api/system/pings`, `/api/system/pings/{jobId}` |
| 8 | "La pagina iniziale è provvisoria: la shell di Studio arriva con l'incremento 1." | Apri `http://127.0.0.1:3310` | Stato del sistema `up`, con i due componenti |

## Qualità (fuori dalla demo, alla chiusura dell'incremento)
```bash
pnpm typecheck        # TypeScript strict su tutti i pacchetti
pnpm lint             # Biome + regole di architettura (dependency-cruiser)
pnpm test:coverage    # test unitari e di integrazione, soglia 80%
```
Esito alla chiusura dell'incremento 0: 31 test passati; coverage al 92% sugli statement, 85% sui branch, 92% sulle funzioni e 96% sulle righe.

## Pulizia
Prima ferma `pnpm dev` con Ctrl+C: se Postgres si spegne mentre web e worker sono accesi, il worker registra `queue error` ogni due secondi finché il database non torna.
```bash
docker compose --env-file .env.local down      # ferma Postgres (i dati restano)
docker compose --env-file .env.local down -v   # cancella anche i dati
```
