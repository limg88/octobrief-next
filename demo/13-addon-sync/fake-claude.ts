// A stand-in for Claude with the Microsoft 365 connector (see fake-claude.sh): reads the window
// and the section from the prompt and prints, as the real one would, a JSON result whose text
// holds the delivery. Synthetic data: one mail and one meeting with its transcript.
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? ''
const [, from = '', to = ''] = /dal (\S+) \(compreso\) al (\S+) \(escluso\)/.exec(prompt) ?? []
const inWindow = (day: string) => from <= day && day < to

const people = [
  { displayName: 'Carla Cliente', email: 'carla.cliente@cliente.example', untrusted: true },
  { displayName: 'Paola Prova', email: 'paola.prova@example.test' },
]
const mail = {
  externalId: 'mail-budget-1',
  version: '2026-11-10T09:00:00Z',
  title: 'RE: Budget Borea',
  mediaType: 'text/markdown',
  text: 'Da: Carla Cliente <carla.cliente@cliente.example>\nA: Paola Prova\nData: 10 novembre 2026\nOggetto: RE: Budget Borea\n\nIl budget approvato dal comitato resta di 890.000 euro.\nCarla Cliente deve confermare la data del collaudo entro venerdì.',
  originAt: '2026-11-10T09:00:00Z',
  url: null,
  people,
}
const meeting = {
  externalId: 'meeting-weekly-1',
  version: '2026-11-11T09:00:00Z',
  title: 'Allineamento settimanale Borea',
  mediaType: 'text/markdown',
  text: "Riunione Teams dell'11 novembre 2026. Partecipanti: Paola Prova, Carla Cliente.\n\nCarla Cliente: il rischio principale resta il ritardo del fornitore.\nPaola Prova: la consegna del modulo è prevista per il 30 novembre 2026.",
  originAt: '2026-11-11T09:00:00Z',
  url: null,
  kind: 'transcript',
  people,
}

const documents = []
if (prompt.includes('mail di Outlook') && inWindow('2026-11-10')) documents.push(mail)
if (prompt.includes('riunioni di Teams') && inWindow('2026-11-11')) documents.push(meeting)
const answer = JSON.stringify({ truncated: false, documents })
console.log(JSON.stringify({ type: 'result', result: `Ecco gli elementi trovati:\n${answer}` }))
