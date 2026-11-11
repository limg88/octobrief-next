// Italian vocabulary: month names, document-kind keywords, audience markers and the phrases of
// suspicious instructions (Italian and English, since documents mix both).
//
// RULE for the suspicious patterns: a false positive is fixed by NARROWING the pattern that
// produced it, never by adding exclusions or widening a pattern to "allow" a phrase. Every
// regular expression is linear in the text: quantifiers are bounded, and no group that can match
// the same characters is nested in another repetition.
//
// Text is normalized before matching (NFKC, invisible characters removed, every run of
// whitespace collapsed to one space), so patterns write a single space between words. Patterns
// whose source starts with `^` are line anchored and run on the text with its line breaks kept.

/** Month names and abbreviations (lowercase, no final dot) to month numbers 1-12. */
export const MONTHS: Readonly<Record<string, number>> = {
  gennaio: 1,
  gen: 1,
  febbraio: 2,
  feb: 2,
  marzo: 3,
  mar: 3,
  aprile: 4,
  apr: 4,
  maggio: 5,
  mag: 5,
  giugno: 6,
  giu: 6,
  luglio: 7,
  lug: 7,
  agosto: 8,
  ago: 8,
  settembre: 9,
  set: 9,
  sett: 9,
  ottobre: 10,
  ott: 10,
  novembre: 11,
  nov: 11,
  dicembre: 12,
  dic: 12,
}

/**
 * What each kind of fact is, as the compile tells the model: one short definition per kind, so
 * that a proposal or an observation is never taken for a decision, and an action says who and
 * by when.
 */
export const FACT_KIND_DEFINITIONS = {
  person:
    'una persona del progetto con il suo ruolo o la sua responsabilità; il nome resta il segnaposto ricevuto',
  decision:
    "una scelta presa o concordata (approvata, decisa, confermata). Una proposta, un'ipotesi, un'opinione, una domanda o un'osservazione non sono decisioni",
  risk: 'un rischio, un problema o un ostacolo che può incidere sul progetto, con il suo effetto se il testo lo dice',
  action:
    "un'attività da fare: chi la fa ed entro quando, se il testo lo dice; il responsabile resta il segnaposto ricevuto; value è la scadenza, se c'è, altrimenti null",
  status: "lo stato di avanzamento di un'attività, di un rilascio, di un modulo o del progetto",
  milestone: 'una tappa o una scadenza del progetto, con la sua data se il testo la dice',
  economics: 'un importo, un costo, un budget, un ordine o una fattura, con la cifra nel value',
  note: 'un altro fatto di progetto utile che non rientra nei tipi precedenti',
} as const

export type KindName =
  | 'status_report'
  | 'meeting_minutes'
  | 'transcript'
  | 'contract'
  | 'contract_deliverables'
  | 'purchase_order'
  | 'invoice'
  | 'timesheet'
  | 'backlog_export'
  | 'presentation'

/**
 * Keywords per kind, as lowercase words searched in the file name and in the first characters
 * of the text. The order decides a tie: the first kind with a keyword wins.
 */
export const KIND_KEYWORDS: ReadonlyArray<readonly [KindName, readonly string[]]> = [
  ['meeting_minutes', ['verbale', 'minuta', 'minutes', 'riunione', 'meeting']],
  ['transcript', ['trascrizione', 'transcript']],
  ['status_report', ['sal', 'stato avanzamento', 'status report', 'avanzamento lavori']],
  ['contract_deliverables', ['elenco dei deliverable', 'elenco deliverable', 'deliverable']],
  ['purchase_order', ['ordine di acquisto', "ordine d'acquisto", 'purchase order', 'ordine']],
  ['invoice', ['fattura', 'invoice']],
  ['contract', ['contratto', 'contract', 'accordo quadro', 'capitolato']],
  ['timesheet', ['timesheet', 'foglio ore', 'ore lavorate', 'consuntivo ore']],
  ['backlog_export', ['backlog', 'jira', 'export ticket', 'user stories', 'sprint']],
  ['presentation', ['presentazione', 'slide', 'deck']],
]

/** Too common in running text to decide a kind from it: read in the file name only. */
export const NAME_ONLY_KEYWORDS: readonly string[] = [
  'riunione',
  'meeting',
  'sprint',
  // The delivery kinds are mentioned in the text of many other documents (a contract speaks of
  // invoices): they are decided by the file name or by the first line of the text.
  'elenco dei deliverable',
  'elenco deliverable',
  'deliverable',
  'ordine di acquisto',
  "ordine d'acquisto",
  'purchase order',
  'ordine',
  'fattura',
  'invoice',
]

/**
 * Single words that decide a delivery kind by themselves only weakly: a kind they decide in a
 * file name is still asked of the PM.
 */
export const WEAK_KEYWORDS: readonly string[] = ['ordine', 'deliverable', 'fattura', 'invoice']

/** Where a keyword does not decide its kind: «ordine del giorno», a sprint deliverable. */
export const KEYWORD_VETOES: Readonly<Record<string, RegExp>> = {
  ordine: /(?<![a-z\d])ordine[ _-]+del[ _-]+giorno(?![a-z\d])/,
  deliverable: /(?<![a-z\d])sprint(?![a-z\d])/,
}

/** The kinds that the first line of the text (its title) can decide, whatever the file is called. */
export const HEADING_KINDS: readonly KindName[] = [
  'contract_deliverables',
  'purchase_order',
  'invoice',
]

/** Media type fragment that decides the kind without looking at words. */
export const PRESENTATION_MEDIA_TYPE = 'presentationml'

const NOT_AFTER_LETTER = '(?<![a-z\\d])'
const NOT_BEFORE_LETTER = '(?![a-z\\d])'

/** Explicit client-facing markers in a file name (lowercase); «non per il cliente» is not one. */
export const CLIENT_NAME_MARKERS: readonly RegExp[] = [
  new RegExp(`${NOT_AFTER_LETTER}(?<!non[ _-]+)per[ _-]+(?:il[ _-]+)?cliente${NOT_BEFORE_LETTER}`),
  new RegExp(`${NOT_AFTER_LETTER}client[ _-]?facing${NOT_BEFORE_LETTER}`),
  new RegExp(`${NOT_AFTER_LETTER}customer[ _-]?facing${NOT_BEFORE_LETTER}`),
]

/** Explicit internal markers in a file name (lowercase). They win over client markers. */
export const INTERNAL_NAME_MARKERS: readonly RegExp[] = [
  new RegExp(
    NOT_AFTER_LETTER +
      '(?:interno|interna|uso[ _-]interno|bozza[ _-]interna|riservat[oa]|confidenzial[ei]|internal|confidential)' +
      NOT_BEFORE_LETTER,
  ),
]

/** An explicit header line of the text, e.g. «Destinatario: cliente». */
export const CLIENT_HEADER_LINE: RegExp =
  /^[ \t]{0,20}(?:destinatari[oa]|audience|pubblico)[ \t]{0,3}:[ \t]{0,3}(?:il[ \t]+|al[ \t]+)?(?:cliente|client|customer)[ \t]{0,20}$/im

/** An explicit header line of the text, e.g. «Destinatario: interno». */
export const INTERNAL_HEADER_LINE: RegExp =
  /^[ \t]{0,20}(?:destinatari[oa]|audience|pubblico)[ \t]{0,3}:[ \t]{0,3}(?:solo[ \t]+)?(?:uso[ \t]+)?(?:interno|internal)[ \t]{0,20}$/im

// ---------------------------------------------------------------------------------------------
// Suspicious instructions

/** Case-insensitive first letter of each word, for the few patterns that must be case sensitive. */
const anyCase = (words: readonly string[]) =>
  words.map((w) => `[${w[0]?.toUpperCase()}${w[0]}]${w.slice(1)}`).join('|')

const GREETING = anyCase(['dear', 'caro', 'cara', 'ciao', 'ehi', 'hey', 'hello', 'hi'])
const NOTE = anyCase(['note', 'nota', 'message', 'messaggio', 'instructions', 'istruzioni'])
/** Second-person commands that follow «AI,» / «assistant:». */
const COMMANDS =
  'you|tu|devi|dovrai|dovresti|please|per favore|ora|adesso|now|subito|ignore|ignora|rispondi|reply|answer|fai|do|send|invia|reveal|rivela|forget|dimentica|scrivi|write|print|stampa|output|esegui|execute|obey|obbedisci|usa|use|summari[sz]e|riassumi'
const COMMANDS_ANY = anyCase(COMMANDS.split('|'))
/**
 * Unambiguous imperatives only, for the lowercase «ai:» / «ia,» address: «ai» is also an Italian
 * preposition, so words like «ora» or «tu» that can follow it in running text are left out.
 */
const IMPERATIVES =
  'ignora|ignore|rispondi|reply|answer|invia|send|rivela|reveal|dimentica|forget|scrivi|write|stampa|print|esegui|execute|obbedisci|obey|riassumi|summari[sz]e|devi'

const ARTICLE = "(?:the |l['’]|all['’])?"
const ADDRESSEE = 'chatbot|llm|chatgpt|claude|gpt-?\\d*|language model|modello linguistico'
const ASSISTANT_WORD = 'assistant|assistente'
const IGNORE_VERB = 'ignore|disregard|forget|override|bypass'
const IGNORE_VERB_IT =
  'ignora|ignorare|dimentica|dimenticare|trascura|bypassa|scavalca|disattiva|salta'
const FILLER =
  '(?:(?:all|any|of|the|your|my|previous|prior|above|earlier|preceding|system|existing|completely|totally|entirely|every|these|those) ){0,5}'
const FILLER_IT =
  '(?:(?:tutte|tutti|le|i|gli|la|il|lo|ogni|completamente|del tutto|pure|ora|quelle|queste|di|tue|vostre|precedenti|sopra) ){0,5}'

const EMAIL = '[\\w.+-]{1,64}@[\\w-]{1,63}(?:\\.[\\w-]{1,63}){1,4}'
const URL = 'https?://[^\\s]{1,200}'
const DEST = `(?:${EMAIL}|${URL})`
const SEND_EN = 'send|forward|email|mail|post|upload|transmit|leak|exfiltrate|share'
const SEND_IT =
  'invia|inviare|manda|mandare|inoltra|inoltrare|spedisci|spedire|pubblica|trasmetti|condividi'
const EXFIL_EN =
  '(?:everything|all (?:of )?(?:the |your )?(?:data|files|documents|information|context|conversation)|the (?:whole |entire |full )?(?:conversation|context|prompt|system prompt|chat history)|this (?:conversation|data|context)|these data|your (?:instructions|prompt|system prompt))'
const EXFIL_IT =
  '(?:tutto|tutti i (?:dati|file|documenti)|tutte le informazioni|questi dati|la conversazione|il prompt|il system prompt|il contesto|la cronologia|le tue istruzioni)'

const TARGET_EN = 'ignore|bypass|override|skip|disable|disregard|send|share|reveal|disclose|leak'
const TARGET_IT =
  'ignorare|aggirare|bypassare|saltare|disattivare|inviare|condividere|rivelare|divulgare'

type Patterns = readonly RegExp[]

export const SUSPICIOUS = {
  addressed_to_assistant: [
    // Greeting plus a name of an AI («Dear AI,»); «Ciao AI team» is not one.
    new RegExp(`\\b(?:${GREETING}) (?:AI|IA)(?= ?[,:!])`),
    new RegExp(`\\b(?:dear|caro|cara|ciao|ehi|hey|hello|hi) (?:${ADDRESSEE})(?= ?[,:!])`, 'i'),
    /\b(?:dear|caro|cara|ciao|ehi|hey|hello|hi) (?:assistant|assistente virtuale|assistente ia)(?= ?[,:!])/i,
    // A name, a colon or comma, then a command.
    new RegExp(`\\b(?:AI|IA)[,:] (?:${COMMANDS_ANY})\\b`),
    // Lowercase «ai: ignora …», only before an unambiguous imperative.
    new RegExp(`\\b(?:ai|ia) ?[,:] (?:${IMPERATIVES})\\b`, 'i'),
    new RegExp(`\\b(?:${ADDRESSEE}|${ASSISTANT_WORD})[,:] (?:${COMMANDS})\\b`, 'i'),
    // «Note to the AI», «Nota per l'assistente:».
    new RegExp(`\\b(?:${NOTE}) (?:to|for|per|al|alla) ${ARTICLE}(?:AI|IA)\\b`),
    new RegExp(
      '\\b(?:note|nota|message|messaggio|instructions?|istruzioni) (?:to|for|per|al|alla) ' +
        ARTICLE +
        '(?:' +
        ADDRESSEE +
        '|assistente virtuale|assistente ia|(?:' +
        ASSISTANT_WORD +
        ') ?:)',
      'i',
    ),
    // «If you are an AI».
    /\b(?:[Ii]f you are|[Ss]e sei) (?:an? |un[ao]? |un['’])?(?:AI|IA)\b/,
    new RegExp(
      "\\b(?:if you are|se sei) (?:an? |un[ao]? |un['’])?(?:" +
        ADDRESSEE +
        '|ai assistant|virtual assistant|assistente virtuale|assistente ia)\\b',
      'i',
    ),
    // Role play.
    /\byou are now (?:dan|an? (?:ai|assistant|chatbot|llm|unrestricted|new)|in (?:developer|jailbreak|debug) mode)\b/i,
    /\b(?:da ora|d['’]ora in poi) sei (?:un[ao]? )?(?:ia|ai|assistente|chatbot|nuovo|senza)\b/i,
  ],
  ignore_rules: [
    // Instructions, prompts, directives: assistant-directed objects by themselves.
    new RegExp(`\\b(?:${IGNORE_VERB}) ${FILLER}(?:instructions?|prompts?|directives)\\b`, 'i'),
    new RegExp(`\\b(?:${IGNORE_VERB_IT}) ${FILLER_IT}(?:istruzioni|direttive|prompt)\\b`, 'i'),
    // Rules, guidelines, constraints: only when qualified as yours / earlier / the system's.
    new RegExp(
      '\\b(?:' +
        IGNORE_VERB +
        ') (?:(?:all|any|of|the|completely|totally|entirely|every) ){0,4}(?:your|my|previous|prior|above|earlier|preceding|system) (?:(?:previous|prior|above|earlier|preceding|system|existing) ){0,3}(?:rules|guidelines|constraints|restrictions|policies|safety)\\b',
      'i',
    ),
    new RegExp(
      '\\b(?:' +
        IGNORE_VERB_IT +
        ') (?:(?:tutte|tutti|le|i|gli|la|il|lo|ogni|completamente|del tutto|pure|ora|quelle|queste) ){0,4}(?:(?:tue|vostre|precedenti|di sistema) (?:regole|linee guida|vincoli|restrizioni)|(?:regole|linee guida|vincoli|restrizioni) (?:precedenti|di sistema|iniziali|dategli|date))',
      'i',
    ),
    // «Ignore the above», «Forget everything you were told», «Ignora quanto detto prima».
    /\b(?:ignore|disregard) (?:the )?above\b/i,
    /\b(?:forget|ignore|disregard) (?:everything|all|anything) (?:that )?you (?:were|was|have been|are|had been) (?:told|given|taught)\b/i,
    /\b(?:ignora|ignorare|dimentica|dimenticare) (?:tutto )?(?:ciò che ti è stato (?:detto|dato|insegnato)|quanto (?:detto|scritto) (?:prima|sopra)|quanto sopra)\b/i,
    /\b(?:do not|don['’]t|never) (?:follow|obey) (?:(?:all|any|the) ){0,2}(?:your|previous|prior|above|system) (?:(?:previous|prior|system) ){0,2}(?:rules|instructions|guidelines|directives)\b/i,
  ],
  send_externally: [
    new RegExp(`\\b(?:${SEND_EN}) (?:me |us )?${EXFIL_EN}[^.]{0,80}?${DEST}`, 'i'),
    new RegExp(`\\b(?:${SEND_IT}) ${EXFIL_IT}[^.]{0,80}?${DEST}`, 'i'),
  ],
  false_authorization: [
    new RegExp(
      '\\byou (?:are|have been) (?:authori[sz]ed|allowed|permitted|cleared) to (?:' +
        TARGET_EN +
        ')\\b',
      'i',
    ),
    new RegExp(
      '\\byou have (?:my )?(?:permission|full access|admin access|authori[sz]ation|clearance) to (?:' +
        TARGET_EN +
        ')\\b',
      'i',
    ),
    /\b(?:authori[sz]ed|approved) by (?:the )?(?:pm|project manager|admin(?:istrator)?|management|ceo) to (?:ignore|bypass|override|send|share|disclose)\b/i,
    /\bthis (?:message|instruction|request) (?:comes )?from (?:the )?(?:system|admin(?:istrator)?|developer)(?: \w{1,20})?[,:;] (?:so )?(?:you|ignore|follow|obey|comply)\b/i,
    new RegExp(`\\bsei (?:autorizzato|autorizzata|abilitato|abilitata) a (?:${TARGET_IT})\\b`, 'i'),
    new RegExp(
      "\\bhai (?:il permesso|l['’]autorizzazione|il via libera|via libera) (?:di|a) (?:" +
        TARGET_IT +
        ')\\b',
      'i',
    ),
    /\bautorizzato (?:dal|dalla) (?:pm|project manager|amministratore|direzione|ceo) a (?:ignorare|aggirare|inviare|condividere|rivelare)\b/i,
    /\bquesto (?:messaggio|ordine) (?:proviene|arriva) (?:dal|dallo) (?:sistema|amministratore|sviluppatore)[,:;] (?:tu |devi|ignora|obbedisci|esegui)/i,
  ],
  persistent_memory: [
    /\b(?:in|for) all (?:of )?your (?:future|next|subsequent) (?:answers|replies|responses|conversations|sessions|chats)\b/i,
    /\bfrom now on,? you\b/i,
    /\b(?:remember|memori[sz]e|save|store) (?:this|that|the following)\b[^.]{0,40}? (?:forever|permanently|for all future|in your memory)\b/i,
    /\b(?:update|add to|write (?:in|to)) your (?:long-term )?(?:memory|knowledge base)\b/i,
    /\b(?:nelle|in tutte le) tue (?:prossime|future|successive) (?:risposte|conversazioni|sessioni|chat)\b/i,
    /\bricorda(?:ti)? (?:questo |quanto segue )?per sempre\b/i,
    /\b(?:ricorda|memorizza|salva)(?:ti)? (?:questo|quanto segue)\b[^.]{0,40}? (?:per sempre|permanentemente|nella tua memoria|in memoria)\b/i,
    /\b(?:da ora|d['’]ora) in poi,? (?:tu |devi|dovrai|rispondi|ricorda)/i,
    /\b(?:aggiorna|aggiungi alla|scrivi nella) (?:la )?tua (?:memoria|base di conoscenza)\b/i,
  ],
  prompt_delimiter: [
    /<\/?(?:system|assistant|instructions?|prompt) ?>/i,
    /<\|[a-z_]{1,32}\|>/i,
    /\[\/?(?:INST|SYS|SYSTEM)\]/,
    /<<\/?SYS>>/,
    /-{3,} ?(?:BEGIN|END) (?:SYSTEM )?PROMPT/i,
    // Role headers of Markdown / Alpaca style prompts, and a «System:» line speaking to the model.
    // Leading horizontal whitespace and extra spaces are tolerated (bounded, so still linear).
    /^[ \t]{0,20}#{2,4}[ \t]{0,10}(?:instruction|system|response|input)s?:?/im,
    /^[ \t]{0,20}system[ \t]{0,10}:[ \t]{0,10}(?:you|tu)\b/im,
  ],
  write_system: [
    /\b(?:modify|change|edit|update|overwrite|replace|reset|disable|delete) your (?:system prompt|instructions|rules|settings|configuration|permissions|guidelines|memory)\b/i,
    /\b(?:grant|give) (?:me|yourself|us) (?:admin|root|full) (?:access|rights|permissions)\b/i,
    /\b(?:modifica|cambia|aggiorna|sovrascrivi|sostituisci|disattiva|cancella|elimina) (?:le tue|il tuo|la tua|i tuoi) (?:istruzioni|regole|impostazioni|configurazione|permessi|prompt|memoria|linee guida)\b/i,
    /\b(?:modifica|cambia|aggiorna|sovrascrivi|sostituisci) (?:il )?prompt di sistema\b/i,
    /\b(?:dammi|concedimi|assegnami) (?:l['’]accesso|i permessi|i diritti) (?:da )?(?:amministratore|admin|root|completi)\b/i,
  ],
} as const satisfies Record<string, Patterns>

/**
 * The patterns the compile guard trusts to REJECT a statement of knowledge. High precision: text
 * clearly addressed to an assistant, or clearly telling it to override its instructions, send data
 * out, keep something in memory or change the system. `false_authorization` only flags: on its own
 * it can be an ordinary sentence of a project.
 */
export const INSTRUCTION_PATTERNS = [
  'addressed_to_assistant',
  'ignore_rules',
  'send_externally',
  'persistent_memory',
  'prompt_delimiter',
  'write_system',
] as const satisfies ReadonlyArray<keyof typeof SUSPICIOUS>

/**
 * A number written alone: optional sign, groups of three digits split by a dot (thousands) and an
 * optional comma decimal part. 1.200 is 1200; 1.5 is not a number in this notation.
 */
export const PURE_NUMBER: RegExp = /^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/

/** A run of digits with inner dots or commas, as written in running text (linear: no nesting). */
export const NUMBER_TOKEN: RegExp = /\d+(?:[.,]\d+)*/g

/**
 * Characters that can sit between the digits of one number: thousands dots, the decimal comma
 * and the spaces some documents use for thousands (space, no-break, narrow no-break, thin).
 */
export const NUMBER_SEPARATOR: RegExp = /^[., \u00a0\u202f\u2009]$/

/** A number in Italian notation: dots split thousands, an optional comma starts the decimals. */
export const GROUPED_NUMBER: RegExp = /^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/

// ---------------------------------------------------------------------------------------------
// Data in running text (answer checks)
//
// These patterns run on text already passed through `asciiDigits` and lowercased (identifiers:
// original case). A number starts only where no digit, dot or comma precedes it, so each pattern
// tries one bounded match per number: linear in the text.

const NUM = '(?<![\\d.,])\\d{1,15}(?:[.,]\\d{1,15}){0,6}'
const NOT_WORD_AFTER = '(?![\\p{L}\\d])'
const NOT_WORD_BEFORE = '(?<![\\p{L}\\d])'

/** Full month names: on their own they name a date («entro novembre»). */
export const FULL_MONTHS: readonly string[] = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
]

const ALL_MONTHS = Object.keys(MONTHS).join('|')

/** An amount in euro: «1.200 €», «€ 1.200», «12 k€», «30 euro», «3 mila euro». */
export const AMOUNT: RegExp = new RegExp(
  `€ ?\\d|${NUM} ?(?:k ?€|€|(?:mila |milioni (?:di )?|mln |k ?)?(?:euro|eur)${NOT_WORD_AFTER})`,
  'u',
)

/** A percentage: «45%», «45 %», «30 per cento», «30 percento». */
export const PERCENTAGE: RegExp = new RegExp(`${NUM} ?(?:%|per ?cento${NOT_WORD_AFTER})`, 'u')

/**
 * A date: «05/03/2026», «5-3-26», «2026-03-05», «3 novembre 2026», «3 nov 2026», «novembre 2026»,
 * «1° dicembre», or a full month name on its own. An abbreviation alone («set», «mar») is a word.
 */
export const DATES: readonly RegExp[] = [
  /(?<![\d.,/-])\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?![\d/-])/u,
  /(?<![\d.,/-])\d{4}-\d{1,2}-\d{1,2}(?![\d/-])/u,
  new RegExp(`${NOT_WORD_BEFORE}\\d{1,2}[°º]? ?(?:${ALL_MONTHS})\\.?(?!\\p{L})`, 'u'),
  new RegExp(`${NOT_WORD_BEFORE}(?:${ALL_MONTHS})\\.? ?\\d{4}(?!\\d)`, 'u'),
  new RegExp(`${NOT_WORD_BEFORE}(?:${FULL_MONTHS.join('|')})${NOT_WORD_AFTER}`, 'u'),
  // Relative dates and weekdays: «ieri», «domani», «venerdì», «la settimana scorsa», «tra due mesi».
  new RegExp(
    `${NOT_WORD_BEFORE}(?:ieri|oggi|domani|dopodomani|stamattina|stasera|stanotte|(?:lune|marte|mercole|giove|vener)d[iì]|sabato|domenica)${NOT_WORD_AFTER}`,
    'u',
  ),
  new RegExp(
    `${NOT_WORD_BEFORE}(?:settimana|mese|anno|bimestre|trimestre|quadrimestre|semestre) (?:scors[oa]|prossim[oa]|passat[oa])${NOT_WORD_AFTER}`,
    'u',
  ),
  new RegExp(
    `${NOT_WORD_BEFORE}(?:tra|fra) (?:[^ ]{1,20} )?(?:or[ae]|giorn[oi]|settiman[ae]|mes[ei]|ann[oi])${NOT_WORD_AFTER}`,
    'u',
  ),
]

/**
 * The pieces Italian cardinals are written with, and their values: «ventitré» is venti + tré,
 * «trentotto» trent + otto, «duecentocinquanta» due + cento + cinquanta, «tremila» tre + mila.
 * «un» is left out, since on its own it is the article; ordinals («terzo») are not cardinals.
 */
export const NUMBER_PIECES: Readonly<Record<string, number>> = {
  uno: 1,
  due: 2,
  tre: 3,
  tré: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
  undici: 11,
  dodici: 12,
  tredici: 13,
  quattordici: 14,
  quindici: 15,
  sedici: 16,
  diciassette: 17,
  diciotto: 18,
  diciannove: 19,
  venti: 20,
  vent: 20,
  trenta: 30,
  trent: 30,
  quaranta: 40,
  quarant: 40,
  cinquanta: 50,
  cinquant: 50,
  sessanta: 60,
  sessant: 60,
  settanta: 70,
  settant: 70,
  ottanta: 80,
  ottant: 80,
  novanta: 90,
  novant: 90,
  cento: 100,
  cent: 100,
  mille: 1000,
  mila: 1000,
  milione: 1_000_000,
  milioni: 1_000_000,
  miliardo: 1_000_000_000,
  miliardi: 1_000_000_000,
}

/** Pieces that multiply what comes before them («duecento», «tremila», «due milioni»). */
export const MULTIPLIER_PIECES: ReadonlySet<string> = new Set([
  'cento',
  'cent',
  'mille',
  'mila',
  'milione',
  'milioni',
  'miliardo',
  'miliardi',
])

/** Multipliers that, written alone, act as a unit of the number before them («due milioni»). */
export const UNIT_LIKE_PIECES: ReadonlySet<string> = new Set([
  'mila',
  'milione',
  'milioni',
  'miliardo',
  'miliardi',
])

/**
 * Roles, groups and common words: a person subject made only of them (particles aside) is not a
 * name to hide from the model («fornitore», «team qa», «il cliente»).
 */
export const NOT_PERSON_WORDS: ReadonlySet<string> = new Set([
  'il',
  'i',
  'gli',
  'un',
  'uno',
  'una',
  'qa',
  'dev',
  'test',
  'fornitore',
  'fornitori',
  'cliente',
  'clienti',
  'team',
  'gruppo',
  'responsabile',
  'responsabili',
  'referente',
  'referenti',
  'direttore',
  'direzione',
  'manager',
  'ufficio',
  'reparto',
  'area',
  'società',
  'azienda',
  'comitato',
  'utente',
  'utenti',
  'consulente',
  'consulenti',
  'sponsor',
  'pm',
  'pmo',
  'tecnico',
  'legale',
  'commerciale',
  'amministrazione',
  'acquisti',
  'progetto',
  'finale',
])

/**
 * Particles and articles that are part of names («Paola Della Rossa», «Lo Russo»): they never make
 * a subject a role. Compared in lowercase; «d'» glued to a word counts as one too.
 */
export const NAME_PARTICLES: ReadonlySet<string> = new Set([
  'la',
  'lo',
  'le',
  'de',
  'di',
  'da',
  'del',
  'della',
  'dei',
  'degli',
  'van',
  'von',
])

/** Words that are never numbers, though they look like one: the articles. */
export const NOT_NUMBERS: ReadonlySet<string> = new Set(['un', 'uno', 'una'])

/**
 * Units and measures: a small cardinal in words («tre», «sei») counts as a number only within one
 * word of one of them («tre settimane», «sei nuove risorse», «giornate: dodici»). «ora» is left
 * out: it is also «now».
 */
export const MEASURE_WORDS: ReadonlySet<string> = new Set([
  'giorni',
  'giorno',
  'settimane',
  'settimana',
  'mesi',
  'mese',
  'anni',
  'anno',
  'ore',
  'minuti',
  'minuto',
  '€',
  'euro',
  'eur',
  '%',
  'percento',
  'persone',
  'persona',
  'utenti',
  'utente',
  'risorse',
  'risorsa',
  'fte',
  'giornate',
  'giornata',
  'sprint',
  'release',
  'punti',
  'punto',
  'ticket',
  'milioni',
  'migliaia',
])

/** Measures of two words. */
export const MEASURE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['per', 'cento'],
  ['story', 'point'],
  ['story', 'points'],
  ['work', 'item'],
  ['work', 'items'],
]

/** Measures that make the number a percentage. */
export const PERCENT_MEASURES: ReadonlySet<string> = new Set(['%', 'percento', 'per cento'])

/** «metà», «mezzo»: a part, counted only before a measure or one of `PART_OBJECTS`. */
export const PART_WORDS: ReadonlySet<string> = new Set(['metà', 'mezzo', 'mezza'])

/** Fractions after «un»: «un terzo», «un quarto», «un quinto». */
export const FRACTION_WORDS: ReadonlySet<string> = new Set(['terzo', 'quarto', 'quinto'])

/** What a part can be of: «metà del budget», «un terzo dei costi». */
export const PART_OBJECTS: ReadonlyArray<readonly [string, string]> = [
  ['del', 'budget'],
  ['dei', 'costi'],
  ['del', 'tempo'],
]

/** An identifier: a UUID, or a ticket key such as «PROJ-12» (matched on the original case). */
export const IDENTIFIERS: readonly RegExp[] = [
  /(?<![\p{L}\d])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\p{L}\d])/iu,
  /(?<![\p{L}\d-])[A-Z][A-Z0-9]{1,9}-\d{1,9}(?![\p{L}\d])/u,
]

/**
 * Common words of the language and of project work, in lower case: a name a person outside the
 * organization chose, or a part of the name of a person a source saw, made only of them is never
 * hidden on its own («budget», «rischio», «giorni»). English words are here too: project texts
 * mix them in. Particles of names (`NAME_PARTICLES`) and roles (`NOT_PERSON_WORDS`) count as well.
 */
export const COMMON_WORDS: ReadonlySet<string> = new Set([
  // Articles, prepositions, conjunctions, pronouns and frequent verbs.
  'il',
  'lo',
  'la',
  'i',
  'gli',
  'le',
  'un',
  'uno',
  'una',
  'di',
  'a',
  'da',
  'in',
  'con',
  'su',
  'per',
  'tra',
  'fra',
  'del',
  'dello',
  'della',
  'dei',
  'degli',
  'delle',
  'al',
  'allo',
  'alla',
  'ai',
  'agli',
  'alle',
  'dal',
  'dalla',
  'dai',
  'nel',
  'nella',
  'nei',
  'sul',
  'sulla',
  'sui',
  'e',
  'ed',
  'o',
  'od',
  'ma',
  'se',
  'che',
  'chi',
  'cui',
  'non',
  'come',
  'dove',
  'quando',
  'anche',
  'più',
  'meno',
  'molto',
  'poco',
  'tutto',
  'tutti',
  'tutte',
  'ogni',
  'questo',
  'questa',
  'quello',
  'quella',
  'sono',
  'era',
  'essere',
  'avere',
  'fare',
  'fatto',
  'stato',
  'stata',
  'già',
  'ancora',
  'sempre',
  'mai',
  'oggi',
  'ieri',
  'domani',
  'ora',
  'dopo',
  'prima',
  'entro',
  'circa',
  'solo',
  'nuovo',
  'nuova',
  'alto',
  'alta',
  'basso',
  'bassa',
  'sì',
  'no',
  'ok',
  'nota',
  'note',
  'the',
  'of',
  'and',
  'or',
  'to',
  'for',
  'with',
  'on',
  'at',
  'by',
  'from',
  'is',
  'are',
  'was',
  'be',
  'it',
  'this',
  'that',
  'not',
  'all',
  'new',
  'old',
  'yes',
  'high',
  'low',
  'go',
  'live',
  'up',
  'out',
  'off',
  'due',
  'next',
  'last',
  'done',
  'open',
  'closed',
  // Project work.
  'budget',
  'costo',
  'costi',
  'ricavo',
  'ricavi',
  'margine',
  'margini',
  'tariffa',
  'tariffe',
  'stima',
  'stime',
  'fattura',
  'fatture',
  'ordine',
  'ordini',
  'contratto',
  'offerta',
  'preventivo',
  'consuntivo',
  'importo',
  'totale',
  'residuo',
  'residua',
  'avanzamento',
  'stato',
  'fase',
  'fasi',
  'rischio',
  'rischi',
  'problema',
  'problemi',
  'criticità',
  'ritardo',
  'ritardi',
  'scadenza',
  'scadenze',
  'consegna',
  'consegne',
  'rilascio',
  'rilasci',
  'milestone',
  'sprint',
  'backlog',
  'attività',
  'compito',
  'task',
  'issue',
  'bug',
  'epic',
  'story',
  'feature',
  'requisito',
  'requisiti',
  'piano',
  'pianificazione',
  'riunione',
  'meeting',
  'verbale',
  'report',
  'sal',
  'progetto',
  'progetti',
  'cliente',
  'clienti',
  'fornitore',
  'team',
  'risorsa',
  'risorse',
  'giorni',
  'giorno',
  'settimane',
  'settimana',
  'mesi',
  'mese',
  'anni',
  'anno',
  'ore',
  'euro',
  'go-live',
  'golive',
  'test',
  'collaudo',
  'produzione',
  'ambiente',
  'versione',
  'documento',
  'allegato',
  'aggiornamento',
  'approvazione',
  'approvato',
  'chiuso',
  'aperto',
  'bloccato',
  'completato',
  'risk',
  'cost',
  'costs',
  'revenue',
  'status',
  'release',
  'delivery',
  'deadline',
  'plan',
  'project',
  'client',
  'customer',
  'invoice',
  'order',
  'estimate',
  'hours',
  'days',
  'weeks',
  'review',
  'update',
  'approval',
  'blocked',
  'urgent',
  'urgente',
  'info',
  'admin',
  'support',
  'supporto',
  'noreply',
  'no-reply',
  'help',
  'service',
  'servizio',
  'sistema',
])
