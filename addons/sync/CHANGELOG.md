# Changelog — @octobrief/sync

L'addon ha una versione propria, indipendente da quella di Octobrief. Il formato dei file che scrive è versionato a parte (`octobrief: 1` nell'intestazione).

## 0.1.2 — 2026-11-12

- Microsoft 365: `m365.model` sceglie il modello con cui è lanciato Claude.

## 0.1.1 — 2026-11-12

- Azure DevOps: un progetto con molte aree e iterazioni non fallisce più con `source_http_error`; il perimetro è la radice delle aree.
- NetSuite/DWSI: `host` può essere un indirizzo IPv4 di rete privata.
- Una fonte non riuscita dice anche quale passo è fallito (`provider_failed: warehouse: …`).

## 0.1.0 — 2026-11-12

Prima versione.

- Comandi `init`, `check`, `pull`, `push`, con ripetizione periodica (`everyMinutes`, `--every`, `--once`).
- Fonti: Jira e Azure DevOps (connettori in sola lettura), NetSuite tramite DWSI, Microsoft 365 tramite Claude e il connettore del PM.
- Data di inizio (`since`, `--since`) per tutte le fonti o per ciascuna.
- Cartella di file Markdown con intestazione dati; scrittura solo di ciò che cambia; rimozioni; rapporto `_stato.md`.
- Avviso sulla scadenza del PAT di Azure DevOps.
- Contiene i comandi dell'alimentatore precedente (`folder`, `file`, `m365`, `dwsi`, `command`), prima in `apps/feeder`.
