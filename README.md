# Octobrief

Co-pilota per i Project Manager. Il PM interroga la memoria del progetto e riceve deliverable verificati (SAL, mail al cliente, verbali, stime). Ogni numero ha la sua fonte e la sua data, le contraddizioni tra le fonti vengono mostrate e niente esce senza la sua approvazione.

Questo repository unisce il meglio di due versioni precedenti:
- la UX di *Studio*, da octobrief;
- l'architettura e il motore deterministico di octobrief-next.

Le decisioni sono raccolte in [docs/roadmap.md](docs/roadmap.md).

> Repository pubblico: non contiene dati di clienti. Segreti e configurazioni locali stanno in `.env.local`, che è escluso da git. I dati delle demo sono sintetici.

## Avvio rapido
Requisiti: Node 24, pnpm 12, Docker.

```bash
pnpm install
pnpm db:setup     # Postgres su 127.0.0.1:5450, ruoli, coda; genera .env.local
pnpm dev          # web su http://127.0.0.1:3310, worker e issuer di login finto su :4320
```
In sviluppo il login usa un issuer OpenID Connect finto (`tools/fake-oidc`), con persone sintetiche: Paola (PM), Marco (PM) e Alba (admin). Per passare a Entra ID vedi [docs/roadmap.md](docs/roadmap.md), sezione «Scelte prese durante l'incremento 1».

## Struttura
```
packages/
  domain/          regole di dominio pure, senza dipendenze
  application/     casi d'uso e porte (interfacce verso l'esterno)
  infrastructure/  adattatori: Postgres (migrazioni SQL in migrations/, RLS), coda pg-boss, OIDC, file (BLOB_DIR), estrazione del testo, configurazione, log
  api/             interfaccia HTTP (Hono + OpenAPI), indipendente da Next
apps/
  web/             Next.js: UI di Studio e montaggio dell'API; composition root del web
  worker/          esegue i lavori in coda; composition root del worker
tools/
  fake-oidc/       issuer OpenID Connect finto per sviluppo, test e demo (mai in produzione)
  synthetic/       generatore di documenti sintetici per le demo (`node tools/synthetic/src/cli.ts <cartella>`)
demo/              una demo per ogni incremento (run.sh + COPIONE.md)
```
Le dipendenze puntano solo verso l'interno:

`domain` ← `application` ← `infrastructure` / `api` ← `apps`

La regola è verificata con `pnpm lint` (dependency-cruiser).

## Comandi
| Comando | Cosa fa |
|---|---|
| `pnpm dev` | avvia web e worker |
| `pnpm typecheck` | TypeScript strict su tutto il monorepo |
| `pnpm lint` | Biome + regole di architettura |
| `pnpm test` | test unitari e di integrazione (serve `pnpm db:setup`) |
| `pnpm test:coverage` | test con soglia di coverage all'80% |
| `pnpm build` | build di produzione del web |

## Demo
Vedi [demo/README.md](demo/README.md).
