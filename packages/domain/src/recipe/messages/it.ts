import type { RecipeDictionary } from './index.ts'

// The Italian texts of the recipes: errors of validation, differences between versions and the
// names of what they talk about. Written for the PM: no identifiers, no JSON, no paths.

export const it: RecipeDictionary = {
  errors: {
    recipe_malformed: 'La ricetta non ha la forma prevista.',
    recipe_unknown_field:
      "La ricetta contiene un'impostazione non prevista: i controlli comuni non si possono spegnere né aggirare.",
    recipe_schema_unknown: 'La ricetta è in un formato che Octobrief non conosce.',
    lang_not_supported: "La lingua della ricetta non è disponibile: per ora c'è solo l'italiano.",
    column_without_category:
      'La colonna “{name}” non dice che tipo di dato contiene (per esempio importi, costi, ore).',
    value_without_category:
      'Il valore “{name}” non dice che tipo di dato contiene (per esempio importi, costi, ore).',
    section_duplicate: 'La sezione “{section}” compare due volte.',
    block_duplicate: 'Nella sezione “{section}” un elemento compare due volte.',
    column_duplicate: 'La colonna “{name}” compare due volte nella stessa tabella.',
    parameter_duplicate: 'Il dato da chiedere “{name}” compare due volte.',
    check_duplicate: 'Il controllo “{name}” compare due volte.',
    option_duplicate: 'Fra le scelte di “{name}” ce n’è una ripetuta.',
    parameters_too_many_at_once:
      'Al passo {step} si chiedono {count} dati insieme: se ne possono chiedere al più {max} per volta.',
    parameter_range_invalid: 'Per “{name}” il valore minimo supera il massimo.',
    parameter_unknown: 'La ricetta usa un dato da chiedere che non esiste.',
    parameter_not_for_content:
      'Il dato “{name}” serve solo a indicare i destinatari della mail: non può comparire in titoli, filtri, tabelle o calcoli.',
    parameter_wrong_type: 'Il dato “{name}” non è del tipo che serve dove è usato.',
    section_required_and_removable:
      'La sezione “{section}” è obbligatoria e insieme rimovibile: deve essere l’una o l’altra.',
    section_not_in_audience:
      'La sezione “{section}” è per il cliente, ma la ricetta produce solo la versione interna.',
    audience_without_sections: 'Nessuna sezione appartiene alla versione che la ricetta produce.',
    title_parameter_not_allowed:
      'Un titolo della sezione “{section}” mostra “{name}”, un testo libero: in un titolo possono stare solo un periodo, una scelta o un numero.',
    title_with_data:
      'Un titolo della sezione “{section}” contiene dati scritti a mano: un titolo può contenere solo dati chiesti al PM.',
    static_with_data:
      'Un testo fisso della sezione “{section}” contiene dati: i testi fissi non possono contenerne.',
    column_field_unknown: 'La colonna “{name}” legge un campo che la fonte non ha.',
    column_operand_invalid: 'La colonna “{name}” è calcolata da colonne che non esistono.',
    column_category_looser:
      'La colonna “{name}” è dichiarata meno riservata di quanto sia il dato della fonte ({category:categories}).',
    key_column_unknown: 'Una tabella si identifica con una colonna che non ha.',
    value_target_invalid:
      'Il valore “{name}” è calcolato da dati che non esistono o non sono numeri.',
    value_category_looser:
      'Il valore “{name}” è dichiarato meno riservato dei dati da cui è calcolato ({category:categories}).',
    value_cycle: 'Il valore “{name}” è calcolato, anche passando per altri valori, da se stesso.',
    system_view_unknown: 'La ricetta legge dal sistema amministrativo una vista non prevista.',
    system_dates_column_invalid:
      'Il filtro sul periodo usa una colonna che non è una data della vista: scegli una colonna di date.',
    system_column_unknown:
      'La ricetta filtra il sistema amministrativo su una colonna non prevista.',
    query_dates_conflict:
      'Un filtro per data indica sia un periodo sia delle date: deve indicare l’uno o le altre.',
    check_target_unknown: 'Il controllo “{name}” guarda qualcosa che non esiste nella ricetta.',
    check_not_applicable: 'Il controllo “{name}” non si può applicare a ciò che guarda.',
    check_without_constraint: 'Il controllo “{name}” non chiede nulla: indica almeno un limite.',
    freshness_looser_than_default:
      'Le soglie di aggiornamento possono essere solo più severe di quelle predefinite ({warn} e {stop} ore).',
    freshness_invalid:
      'Le soglie di aggiornamento devono essere numeri interi di ore, maggiori di zero.',
    freshness_warn_after_stop: 'La soglia di avviso deve venire prima della soglia di blocco.',
    freshness_on_document_source:
      'Le soglie di aggiornamento valgono solo per i dati dei sistemi, non per i documenti.',
    render_without_md: 'La ricetta deve produrre sempre anche la versione di testo.',
    render_too_many_binary: 'La ricetta può produrre al più un file fra Word, PowerPoint ed Excel.',
    render_format_duplicate: 'Un formato del file è indicato due volte.',
    render_template_without_binary: 'Il modello grafico serve solo se la ricetta produce un file.',
    render_mapping_wrong_format:
      'La sezione “{section}” ha un’impaginazione per un formato che la ricetta non produce.',
    render_section_unknown: 'L’impaginazione indica una sezione che non esiste.',
    render_cell_invalid:
      'Una cella del foglio Excel è collegata a un dato che non esiste, o la ricetta non produce un foglio Excel.',
    render_cell_duplicate: 'Una cella del foglio Excel è collegata due volte.',
    extra_category_target_unknown: 'Una riclassificazione dei dati indica un dato che non esiste.',
    extra_category_not_stricter:
      'Il dato “{name}” può essere solo reso più riservato di {category:categories}, mai meno.',
    extra_category_duplicate: 'Lo stesso dato è riclassificato due volte.',
    number_not_supported:
      'La ricetta contiene un numero troppo grande o troppo piccolo: usa un valore più vicino a quelli reali.',
    exclusion_target_invalid:
      'Un’esclusione indica una tabella che non c’è, o un dato che la tabella non mostra.',
    exclusion_duplicate: 'La stessa tabella ha due esclusioni: vanno riunite in una.',
    exclusion_not_shown:
      'Le righe escluse da “{name}” devono comparire nel documento, sotto «Escluso su richiesta del PM».',
    client_version_condition_invalid:
      'La scelta che decide la versione per il cliente vale solo per una ricetta con le due versioni, e deve indicare una delle sue opzioni.',
  },
  changes: {
    title_changed: 'Il nome della ricetta passa da “{from}” a “{to}”.',
    purpose_changed: 'Cambiato lo scopo della ricetta.',
    audience_changed: 'Ora la ricetta produce {audience:audiences}.',
    section_added: 'Aggiunta la sezione “{section}”.',
    section_removed: 'Tolta la sezione “{section}”.',
    section_moved: 'Spostata la sezione “{section}”.',
    section_renamed: 'La sezione “{from}” ora si chiama “{to}”.',
    section_now_required: 'La sezione “{section}” ora è obbligatoria.',
    section_now_optional: 'La sezione “{section}” ora è facoltativa.',
    section_version_changed: 'La sezione “{section}” ora è {version:versions}.',
    section_now_removable: 'La sezione “{section}” ora si può togliere dal progetto.',
    section_no_longer_removable: 'La sezione “{section}” non si può più togliere dal progetto.',
    block_added: 'Nella sezione “{section}” aggiunto “{name}”.',
    block_removed: 'Nella sezione “{section}” tolto “{name}”.',
    block_changed: 'Nella sezione “{section}” cambiato “{name}”.',
    block_moved: '“{name}” passa dalla sezione “{from}” alla sezione “{to}”.',
    block_reordered: 'Nella sezione “{section}” spostato “{name}”.',
    slot_instructions_changed: 'Nella sezione “{section}” cambiate le istruzioni per “{name}”.',
    column_added: 'Nella tabella “{block}” aggiunta la colonna “{name}”.',
    column_removed: 'Nella tabella “{block}” tolta la colonna “{name}”.',
    column_category_changed: 'La colonna “{name}” ora è trattata come {category:categories}.',
    columns_reordered: 'Nella tabella “{block}” cambiato l’ordine delle colonne.',
    value_category_changed: 'Il valore “{name}” ora è trattato come {category:categories}.',
    parameter_added: 'Aggiunto il dato da chiedere “{name}”.',
    parameter_removed: 'Tolto il dato da chiedere “{name}”.',
    parameter_now_required: 'Il dato “{name}” ora è obbligatorio.',
    parameter_now_optional: 'Il dato “{name}” ora è facoltativo.',
    parameter_changed: 'Cambiato il dato da chiedere “{name}”.',
    prerequisite_added: 'Ora servono dati da: {name}.',
    prerequisite_removed: 'Non servono più dati da: {name}.',
    prerequisite_now_required: 'I dati da {name} ora sono necessari.',
    prerequisite_now_optional: 'I dati da {name} ora si usano solo se ci sono.',
    prerequisite_freshness_changed:
      'Per {name} l’avviso di aggiornamento ora scatta dopo {warn} ore e il blocco dopo {stop} ore.',
    check_added: 'Aggiunto il controllo “{name}”.',
    check_removed: 'Tolto il controllo “{name}”.',
    check_scope_extended: 'Il controllo “{name}” ora vale anche per {targets}.',
    check_scope_changed: 'Il controllo “{name}” ora vale per {targets}.',
    check_changed: 'Cambiato il controllo “{name}”.',
    rule_added: 'Aggiunta la regola di scrittura: «{text}».',
    rule_removed: 'Tolta la regola di scrittura: «{text}».',
    red_team_rule_added: 'Aggiunto il controllo del revisore: «{text}».',
    red_team_rule_removed: 'Tolto il controllo del revisore: «{text}».',
    extra_category_added: 'Il dato “{name}” ora è trattato come {category:categories}.',
    extra_category_removed: 'Il dato “{name}” non è più trattato come {category:categories}.',
    format_added: 'Ora la ricetta produce anche {format:formats}.',
    format_removed: 'La ricetta non produce più {format:formats}.',
    template_changed: 'Cambiato il modello grafico del file.',
    render_mapping_changed: 'Cambiata l’impaginazione del file.',
    examples_changed: 'Cambiati gli esempi della ricetta.',
    recipe_changed: 'Cambiato un dettaglio della ricetta.',
    exclusion_added:
      'Da “{name}” escluso su tua richiesta: {values}. Le righe escluse compaiono nel documento, sotto «Escluso su richiesta del PM».',
    client_version_condition_changed:
      'Cambiata la scelta che decide se il deliverable ha anche la versione per il cliente.',
  },
  clientSources: {
    administrative_system: 'Sistema amministrativo, dati al {date}',
    administrative_system_undated: 'Sistema amministrativo, data dei dati non indicata',
    project_backlog: 'Backlog di progetto, aggiornato al {date}',
    project_backlog_undated: 'Backlog di progetto, data di aggiornamento non indicata',
    project_document: 'Documento di progetto del {date}',
    project_document_undated: 'Documento di progetto, data non indicata',
    project_knowledge: 'Conoscenza di progetto, aggiornata al {date}',
    project_knowledge_undated: 'Conoscenza di progetto, data non indicata',
    pm: 'Indicato dal project manager, al {date}',
    pm_undated: 'Indicato dal project manager',
  },
  audience: {
    internal_data_in_client:
      'Nella versione per il cliente {where} contiene {categories}: sono dati interni. Resta fuori dal file finché non lo accetti con «Accetta così», con una motivazione.',
    internal_source_in_client:
      'Nella versione per il cliente {where} riprende una fonte interna. Resta fuori dal file finché non lo accetti con «Accetta così», con una motivazione.',
    internal_source_and_data_in_client:
      'Nella versione per il cliente {where} riprende una fonte interna e contiene {categories}: sono dati interni. Resta fuori dal file finché non lo accetti con «Accetta così», con una motivazione.',
    internal_note_in_client:
      'La versione per il cliente contiene note interne: le note interne non entrano mai nel file per il cliente.',
    internal_section_in_client:
      'La sezione “{section}” è interna: non entra mai nella versione per il cliente.',
    client_source_note_not_generic:
      'Una nota di fonte della versione per il cliente non è nella forma generica (per esempio «Sistema amministrativo, dati al …»): la versione va preparata di nuovo.',
    story_points_in_client:
      'Nella versione per il cliente {where} contiene story point: il cliente li vedrà. Prima di approvare conferma che vanno lasciati.',
    mixed_script_in_client:
      'Nella versione per il cliente {where} contiene parole scritte con lettere di alfabeti diversi, che possono nascondere un dato interno. Resta fuori dal file finché non lo accetti con «Accetta così», con una motivazione.',
    where_column: 'la colonna “{column}” della tabella “{block}”',
    where_column_untitled: 'la colonna “{column}” di una tabella della sezione “{section}”',
    where_value: 'il valore “{block}”',
    where_segment: 'un testo della sezione “{section}”',
    where_block_title: 'il titolo “{block}”',
    where_section_title: 'il titolo della sezione “{section}”',
    where_document_title: 'il titolo del documento',
    list_and: 'e',
    parameter_not_deduced: 'non dedotto',
    client_version_unavailable:
      'La versione per il cliente non si riesce a preparare da questa bozza: prepara di nuovo la bozza.',
  },
  acceptance: {
    not_acceptable:
      'Questa anomalia non si può accettare: riguarda credenziali o segreti, oppure una parte che non entra mai nel file per il cliente.',
    reason_too_short: 'Per accettare scrivi una motivazione a parole, di almeno 20 caratteri.',
  },
  decision: {
    not_decidable:
      'Questa anomalia non si decide: si accetta con una motivazione o si prepara di nuovo la bozza.',
    reason_too_short: 'Per decidere scrivi una motivazione a parole, di almeno 20 caratteri.',
    choice_missing: 'Indica quale valore vale.',
  },
  confirmation: {
    not_confirmable: 'Questo avviso non chiede una conferma.',
    reason_too_short: 'Per confermare scrivi una motivazione a parole, di almeno 20 caratteri.',
  },
  approval: {
    state_in_preparation: 'In preparazione',
    state_in_review: 'Da approvare',
    state_approving: 'Approvata, file in preparazione',
    state_approved: 'Approvata',
    state_approved_with_accepted_anomalies: 'Approvata con anomalie accettate',
    state_render_failed: 'Approvata, file non riuscito',
    state_superseded: 'Superata da una revisione più recente',
    state_failed: 'Non riuscita',
    state_discarded: 'Scartata',
    reason_finding_after_draft:
      'Dopo la bozza sono emersi rilievi nuovi (una fonte invecchiata o rimossa, un valore o la ricetta cambiati): riapri la revisione per accettarli o deciderli uno per volta.',
    reason_anomaly_open:
      'Ci sono anomalie aperte: accettale una per volta con una motivazione, oppure chiedi una modifica.',
    reason_decision_missing:
      'Ci sono contraddizioni o valori cambiati da decidere, ognuno con una motivazione.',
    reason_story_points_unconfirmed:
      'Il documento per il cliente contiene story point: conferma esplicitamente che possono restare.',
    reason_not_project_member: 'Non fai parte di questo progetto.',
    reason_not_project_pm: 'Solo un PM del progetto può farlo.',
    reason_run_in_preparation: 'La bozza è ancora in preparazione.',
    reason_run_failed: 'Questa esecuzione non è riuscita.',
    reason_run_discarded: 'Questa esecuzione è stata scartata.',
    reason_revision_superseded: 'Questa revisione è stata superata da una più recente.',
    reason_approval_in_progress: 'La revisione è già approvata e il file è in preparazione.',
    reason_already_approved: 'La revisione è già approvata.',
    reason_nothing_to_accept: 'Non ci sono anomalie da accettare.',
    reason_nothing_to_decide: 'Non ci sono contraddizioni o valori cambiati da decidere.',
    reason_nothing_to_confirm: 'Non ci sono avvisi da confermare.',
    reason_snapshot_too_old:
      'I dati di questa bozza sono di oltre {hours} ore fa: prepara di nuovo la bozza invece di modificarla.',
    reason_no_text_slots: 'Questa bozza non ha testi da riscrivere.',
    reason_render_not_failed: 'Si riprova solo dopo un file non riuscito.',
    reason_retry_needs_new_run:
      'Dopo il file non riuscito sono emersi rilievi nuovi: questa revisione non si può più approvare, avvia una nuova esecuzione.',
    reason_not_approved: 'Il file esiste solo dopo l’approvazione.',
    reason_first_revision: 'Questa è la prima revisione: non ci sono differenze da mostrare.',
  },
  redTeam: {
    source_removed:
      'La fonte “{label}” è stata rimossa alla fonte dopo la bozza: prepara di nuovo la bozza, oppure accetta con una motivazione.',
    recipe_changed:
      'La ricetta o le sue impostazioni nel progetto sono cambiate dopo la bozza: prepara di nuovo la bozza, oppure accetta con una motivazione.',
    without_source:
      'Un testo {where} afferma un fatto o riporta dati senza una fonte verificata: resta sospeso finché la bozza non viene preparata di nuovo.',
    source_note_missing:
      'Un elemento {where} cita una fonte che non è fra le note del documento: la bozza va preparata di nuovo.',
    excluded_row_cited:
      'Un testo {where} si appoggia a un elemento che hai escluso dal documento: riscrivilo senza quell’elemento, oppure accetta con una motivazione.',
    suspicious_passage_cited:
      'Un testo {where} si appoggia a un passo di un documento che contiene un’istruzione sospetta: controlla che riporti un dato e non un ordine, poi riscrivilo o accetta con una motivazione.',
    mixed_script:
      'Un testo {where} contiene parole scritte con lettere di alfabeti diversi, che possono nascondere un dato.',
    stale_source:
      'I dati di “{label}” sono di {hours} ore fa, oltre la soglia: i numeri che la citano sono sospesi. Aggiorna la fonte o accetta con una motivazione.',
    source_freshness_unknown:
      'La fonte “{label}” non dice a quando risalgono i suoi dati: i numeri che la citano non si possono considerare aggiornati.',
    source_date_in_future:
      'La fonte “{label}” ha una data nel futuro: la sua freschezza non si può giudicare.',
    connector_with_data:
      'Una frase di collegamento {where} contiene dati senza citarne la fonte: le frasi di raccordo non portano dati.',
    title_with_data:
      'Un titolo {where} contiene dati non chiesti: un titolo può mostrare solo i dati indicati da te.',
    static_with_data: 'Un testo fisso {where} contiene dati: i testi fissi non ne portano.',
    value_without_source: 'Un valore {where} non ha una fonte: al suo posto va «non dedotto».',
    internal_data_in_client: 'Nella versione per il cliente {where} contiene dati interni.',
    internal_note_in_client: 'La versione per il cliente contiene note interne.',
    internal_section_in_client: 'Una sezione interna è nella versione per il cliente.',
    client_source_note_not_generic:
      'Una nota di fonte della versione per il cliente non è nella forma generica.',
    mixed_script_in_client:
      'Nella versione per il cliente {where} contiene parole con lettere di alfabeti diversi.',
    client_version_inconsistent:
      'La bozza non corrisponde alla ricetta o ai dati raccolti: la versione per il cliente non si può preparare. La bozza va preparata di nuovo.',
    credential_in_text:
      'Un testo {where} contiene una credenziale (password o accesso): non si può accettare, la bozza va preparata di nuovo senza.',
    secret_in_text:
      'Un testo {where} contiene una chiave o un segreto: non si può accettare, la bozza va preparata di nuovo senza.',
    credential_in_source_title:
      'Il titolo di un documento citato contiene una credenziale (password o accesso): non si può accettare e la bozza non si corregge dal testo. Rinomina il documento o toglilo dal progetto, poi prepara di nuovo la bozza.',
    secret_in_source_title:
      'Il titolo di un documento citato contiene una chiave o un segreto: non si può accettare e la bozza non si corregge dal testo. Rinomina il documento o toglilo dal progetto, poi prepara di nuovo la bozza.',
    technical_path:
      'Un testo {where} contiene un percorso di file o di sistema: in un documento non serve.',
    technical_identifier:
      'Un testo {where} contiene un identificativo tecnico che non è un dato citato.',
    required_section_missing:
      'Manca la sezione obbligatoria “{section}”: la bozza va preparata di nuovo.',
    section_unexpected: 'La sezione “{section}” non è prevista dalla ricetta, o compare due volte.',
    section_out_of_order: 'La sezione “{section}” non è al suo posto nell’ordine della ricetta.',
    blocks_mismatch: 'Gli elementi della sezione “{section}” non sono quelli della ricetta.',
    columns_mismatch: 'Le colonne {where} non sono quelle della ricetta.',
    row_cells_mismatch: 'Alcune righe {where} non hanno una cella per ogni colonna.',
    contradiction_open:
      'Le fonti non sono d’accordo {where}: decidi tu quale valore vale, con una motivazione.',
    declared_value_changed:
      'Un valore {where} era stato dichiarato al cliente come «{declared}» e ora è «{current}»: decidi tu quale vale, con una motivazione.',
    recipe_check_failed: 'Controllo «{label}»: {message}',
    recipe_check_not_evaluable:
      'Il controllo «{label}» non si può fare: mancano dei valori o non sono numeri.',
    reviewer_finding: 'Il revisore segnala {where}: {message}',
    reviewer_failed:
      'La revisione non è riuscita: il revisore non ha dato un esito leggibile. La bozza va controllata di nuovo.',
    connector_with_name:
      'Una frase di collegamento {where} nomina una persona o un’organizzazione senza citarne la fonte.',
    story_points_in_client: 'Nella versione per il cliente {where} contiene story point.',
    source_freshness_warning:
      'I dati di “{label}” sono di {hours} ore fa: il documento lo segnala.',
    suspicious_instruction:
      'Una fonte usata contiene un testo che sembra un’istruzione: è trattato come dato e non cambia la ricetta.',
    block_remark: 'Lettura dei dati {where}: {message}',
    reviewer_sample:
      'Il revisore ha verificato {where} un campione di {rows} righe: le altre righe non le ha lette.',
    unknown_finding: 'Un controllo ha trovato un problema {where}.',
    where_document: 'nel documento',
    where_section: 'nella sezione “{section}”',
    where_block: 'in “{block}” della sezione “{section}”',
    where_column: 'nella colonna “{column}” di “{block}”',
    where_internal_note: 'in una nota per te',
    excerpt: 'Il testo: «{excerpt}».',
    checks_one: '{n} verifica',
    checks_other: '{n} verifiche',
    anomalies_one: '{n} anomalia',
    anomalies_other: '{n} anomalie',
    warnings_one: '{n} avviso',
    warnings_other: '{n} avvisi',
  },
  categories: {
    contract_amounts: 'importi contrattuali',
    invoiced_amounts: 'importi fatturati',
    costs: 'costi',
    margins: 'margini',
    rates: 'tariffe',
    estimates: 'stime',
    hours: 'ore',
    story_points: 'story point',
    personal: 'dati personali',
    other: 'dati di progetto',
  },
  audiences: {
    internal: 'solo la versione interna',
    client: 'la versione per il cliente',
    both: 'la versione interna e quella per il cliente',
  },
  versions: {
    internal: 'solo nella versione interna',
    client: 'solo nella versione per il cliente',
    both: 'in entrambe le versioni',
  },
  formats: {
    md: 'il testo',
    docx: 'un documento Word',
    pptx: 'una presentazione PowerPoint',
    xlsx: 'un foglio Excel',
  },
  checkKinds: {
    sum_equals: 'somma uguale a un totale',
    sum_at_most: 'somma entro un limite',
    difference_equals: 'differenza fra colonne',
    values_equal: 'uguaglianza fra valori',
    present: 'presenza del dato',
    member_of: 'appartenenza a un elenco',
    count_consistent: 'conteggio coerente',
    date_within_period: 'data entro il periodo',
    unique: 'nessun doppione',
    coverage: 'ogni elemento attribuito',
    implies: 'condizione rispettata',
    equals_previous: 'uguale al valore precedente',
    bounded_text: 'testo entro i limiti',
    agree_by_key: 'stesso valore nelle due fonti',
    all_equal_when: 'stato raggiunto da ogni riga',
    sum_by_key: 'somme per gruppo uguali ai subtotali',
    segments_cited: 'ogni frase con la sua fonte',
    segment_fields: 'campi dichiarati o da assegnare',
  },
  documentKinds: {
    status_report: 'stato avanzamento',
    meeting_minutes: 'verbali',
    transcript: 'trascrizioni',
    contract: 'contratti',
    contract_deliverables: 'deliverable del contratto',
    purchase_order: "ordini d'acquisto",
    invoice: 'fatture',
    timesheet: 'ore lavorate',
    backlog_export: 'export del backlog',
    economics_export: 'dati economici',
    presentation: 'presentazioni',
    generic: 'documenti',
  },
  sourceKinds: {
    manual_upload: 'caricamenti manuali',
    ado: 'Azure DevOps',
    jira: 'Jira',
    teams: 'Teams',
    mail: 'posta',
    sharepoint: 'SharePoint',
    netsuite_dwsi: 'sistema amministrativo',
    local_folder: 'cartella del Mac',
  },
  factKinds: {
    person: 'persone',
    decision: 'decisioni',
    risk: 'rischi',
    action: 'azioni',
    status: 'stato',
    milestone: 'milestone',
    economics: 'dati economici',
    note: 'note',
  },
  library: {
    new_version_available:
      'È disponibile una versione nuova ({version}): il progetto continua a usare la sua finché non scegli di adottarla.',
    pinned_revoked:
      "La versione usata dal progetto non è più pubblicata nella libreria: resta in uso qui, ma conviene passare a un'altra.",
  },
  settings: {
    settings_malformed:
      'Le impostazioni della ricetta per il progetto non hanno la forma prevista.',
    default_parameter_unknown: 'Un valore predefinito riguarda un dato che la ricetta non chiede.',
    default_not_allowed:
      '“{name}” si sceglie ogni volta: non può avere un valore predefinito per il progetto.',
    default_invalid: 'Il valore predefinito di “{name}” non è valido per quel dato.',
    labels_too_many: 'Le etichette del progetto sono troppe: al più {max}.',
    client_version_by_default:
      'Non posso far andare al cliente “{name}” se non dici altro: la versione per il cliente si chiede ogni volta.',
  },
  templates: {
    template_format_unknown:
      'Il file non è un modello Word, PowerPoint o Excel (.docx, .pptx o .xlsx).',
    template_unreadable: 'Il modello non si riesce ad aprire: forse è danneggiato.',
    template_too_large: 'Il modello è troppo grande: al più 10 MB.',
    template_expanded_too_large:
      'Il modello contiene troppi dati una volta aperto: alleggeriscilo (per esempio le immagini) e ricaricalo.',
    template_macro:
      'Il modello contiene macro: salvalo senza macro (.docx, .pptx o .xlsx) e ricaricalo.',
    template_active_content:
      'Il modello contiene contenuti attivi (controlli, campi automatici, formule con funzioni non ammesse, oppure immagini SVG con script o elementi di un programma di grafica): toglili e ricaricalo. Per le immagini SVG basta riesportarle come «SVG semplice».',
    template_external_link:
      'Il modello contiene collegamenti a file, ad altre cartelle di lavoro o a siti esterni (anche dentro formule o immagini SVG): toglili e ricaricalo. Per le immagini SVG basta riesportarle come «SVG semplice».',
    template_unchecked:
      'Il modello non si può controllare: il controllo non è finito in tempo. Semplifica il file e ricaricalo.',
    template_part_unknown:
      'Il modello contiene parti che un modello Word, PowerPoint o Excel non usa: salvalo di nuovo da Office e ricaricalo.',
    template_embedded_object:
      'Il modello contiene oggetti incorporati (per esempio un foglio dentro un documento): toglili e ricaricalo.',
  },
  gathering: {
    period: 'dal {from} al {to}',
    yes: 'sì',
    no: 'no',
    note_work_item: '{source}, elemento {id}',
    note_work_item_counts: '{source}, conteggi',
    note_work_item_counts_decided: '{source}, conteggi con le tue esclusioni e attribuzioni',
    work_item_title: '{title} ({id})',
    work_item_title_not_read: '{id} (titolo non letto)',
    note_parameter: 'Indicato da te: {name}',
    note_fact: 'Conoscenza di progetto: {key}',
    dated_by_acquisition: '{title} (datato al caricamento: il documento non indica una sua data)',
    contradiction_subject: 'Le fonti danno valori diversi su un dato di tipo «{kind:factKinds}»',
    ready: 'Pronta',
    needs_step: 'Serve un passo: {steps}.',
    missing_system_data: 'Mancano dati di sistema aggiornati: {sources}.',
    need_evidence: 'un documento fra questi: {kinds}',
    need_source: 'una fonte fra queste: {kinds}',
    need_fact: 'un dato di tipo «{kind:factKinds}» nella conoscenza',
    need_fact_key: '«{key}» nella conoscenza',
    step_evidence: 'carica un documento fra questi: {kinds}',
    step_source: 'collega una fonte fra queste: {kinds}',
    step_fact: 'aggiungi alla conoscenza un dato di tipo «{kind:factKinds}»',
    step_fact_key: 'aggiungi alla conoscenza «{key}»',
    data_never_synced: '{source} non ha ancora finito un aggiornamento',
    data_stale: '{source} è aggiornato al {date}',
    data_undated: '{source} non dice a quando risalgono i suoi dati',
    list_separator: '; ',
    remark_filter_dropped: 'Senza filtro su «{name}»: il dato non è stato indicato.',
    remark_selection_dropped:
      'Elementi scelti non più disponibili (rimossi alla fonte o fuori dal progetto): {count}.',
    remark_source_not_synced:
      '{source} non ha ancora finito un aggiornamento: i suoi dati non sono compresi.',
    remark_sprint_not_found:
      'Nessun elemento trovato per lo sprint «{sprint}»: controlla il nome, che va scritto come nel tracker.',
    remark_internal_source_left_out:
      '{source} è una fonte interna: in un documento per il cliente i suoi elementi non sono contati. Se contiene i dati del cliente, indicalo nella pagina Fonti.',
    note_parameter_from_documents: 'Indicato da te, dai documenti scelti in «{document}»: {name}',
    rows_without_evidence:
      'Per «{name}» scegli anche in «{document}» il documento da cui hai copiato le righe.',
    rows_invalid: 'In «{name}», riga {row}, il valore di «{column}» non va bene: correggilo.',
    rows_invalid_table:
      'La tabella «{name}» va compilata con almeno una riga e al più quelle ammesse.',
  },
  run: {
    phase_gathering: 'Raccolgo i dati delle fonti',
    phase_writing: 'Scrivo i testi',
    phase_checking: 'Controllo la bozza',
    phase_revising: 'Rivedo i testi',
    status_queued: 'In attesa di partire',
    status_running: 'In preparazione',
    status_ready: 'Bozza pronta',
    status_failed: 'Non riuscita',
    status_discarded: 'Scartata',
    suspended_data: 'Dato sospeso: la fonte non è aggiornata.',
  },
  mail: {
    subject_label: 'Oggetto',
    copy_not_approved: 'Il testo della mail si può copiare solo dopo l’approvazione.',
    not_deduced: 'non dedotto',
    data_as_of: 'Dati al {asOf}, generato il {generated}',
    data_as_of_unknown: 'Data dei dati non indicata, generato il {generated}',
    sources_title: 'Fonti',
    recipient_outside_team:
      'Destinatari che non fanno parte del team del progetto: {addresses}. Controlla che sia voluto prima di usare il testo.',
    recipient_invalid:
      'Indirizzi che non sembrano indirizzi di posta e sono stati lasciati fuori: {addresses}.',
  },
  render: {
    request_invalid: 'La richiesta del file non era completa: riprova.',
    request_too_large: 'Il documento e il modello insieme sono troppo grandi per creare il file.',
    document_invalid:
      'Il documento approvato non ha la forma prevista: il file non è stato creato.',
    layout_unknown_block:
      'La ricetta indica una parte del documento che il documento non contiene.',
    layout_style_missing: 'Il modello Word non ha uno stile che la ricetta indica.',
    layout_slide_layout_missing: 'Il modello PowerPoint non ha un layout che la ricetta indica.',
    layout_sheet_missing: 'Il modello Excel non ha un foglio che la ricetta indica.',
    named_cell_missing: 'Il modello Excel non ha una cella con nome che la ricetta indica.',
    render_failed: 'Il file non si è riusciti a creare con questo modello.',
    render_timeout: 'La creazione del file ha richiesto troppo tempo ed è stata fermata.',
    file_unreadable: 'Il file creato non si riesce ad aprire: non è stato salvato.',
    file_too_large: 'Il file creato è troppo grande: non è stato salvato.',
    file_formula:
      'Il file creato conteneva una formula che il modello non aveva: non è stato salvato.',
    template_part_changed:
      'Il file creato ha cambiato intestazione, piè di pagina o immagini del modello.',
    count_mismatch:
      'Il file creato non contiene tutte le parti del documento approvato (sezioni, slide, tabelle o celle).',
  },
  deliverable: {
    sources_title: 'Fonti',
    internal_notes_title: 'Note per il PM',
    data_as_of: 'Dati al {asOf}, generato il {generated}',
    data_as_of_unknown: 'Data dei dati non indicata, generato il {generated}',
    not_deduced: 'non dedotto',
    note: '{n}. {label}, dati al {asOf}',
    note_undated: '{n}. {label}',
    renderer_unavailable:
      'Il servizio che crea i file non ha risposto, nemmeno dopo alcuni tentativi: nessun file è stato salvato. Riprova più tardi.',
    document_changed:
      'Il documento non corrisponde più a quello approvato: nessun file è stato salvato.',
    client_version_changed:
      'La versione per il cliente non corrisponde più a quella approvata (per esempio è cambiato chi può vedere una fonte): nessun file è stato salvato. Riprova per approvarla di nuovo.',
    recipe_unavailable:
      'La ricetta o le sue impostazioni, come le ha usate questa esecuzione, non si ritrovano: nessun file è stato salvato. Avvia una nuova esecuzione.',
    template_missing:
      'Il modello grafico usato da questa esecuzione non è più disponibile: nessun file è stato salvato. Avvia una nuova esecuzione.',
    file_check_failed: 'Un controllo del file non è riuscito: nessun file è stato salvato.',
    render_error:
      "Non è stato possibile creare i file per un errore imprevisto: nessun file è stato salvato. Riprova; se succede di nuovo, avvisa l'amministratore PMO.",
    file_not_stored:
      'I file sono stati creati ma non si sono potuti salvare, nemmeno dopo alcuni tentativi: nessun file è disponibile. Riprova più tardi.',
    render_stuck:
      'La creazione dei file si è interrotta: nessun file è stato salvato. Puoi riprovare ad approvare.',
  },
  patch: {
    excluded_title: 'Escluso su richiesta del PM',
    default_set: 'Nel progetto “{name}” ora vale, se non dici altro, {value}.',
    threshold_freshness: 'aggiornamento dei dati di {name}',
    threshold_length: 'lunghezza di “{name}”',
    patch_malformed:
      'Non sono riuscito a tradurre la richiesta in una modifica della ricetta: prova a dirla con altre parole.',
    target_unknown:
      'La richiesta parla di una parte che la ricetta non ha: controlla il nome della sezione, della tabella o del controllo.',
    nothing_to_change: 'La ricetta fa già quello che chiedi: non c’è niente da cambiare.',
    default_only_in_project:
      'I valori predefiniti si scelgono nella ricetta di un progetto, non nella libreria.',
    default_invalid: 'Il valore predefinito di “{name}” non è tra quelli ammessi.',
    exclusion_conflict:
      'Da “{name}” stai già escludendo righe in un altro modo: scrivi le righe da escludere nello stesso modo.',
    parameters_changed:
      'I dati che la ricetta ti chiede non si cambiano con una modifica a parole.',
    recipe_changed:
      'Nome, scopo, destinatari e impaginazione della ricetta non si cambiano con una modifica a parole.',
    section_removed:
      'Non posso togliere la sezione “{section}”: è obbligatoria. Una modifica a parole può solo rendere la ricetta più severa.',
    section_made_optional:
      'Non posso rendere facoltativa la sezione “{section}”: oggi è obbligatoria, e una modifica a parole può solo rendere la ricetta più severa.',
    section_made_removable:
      'Non posso permettere di togliere la sezione “{section}” dal progetto: oggi non si può togliere.',
    section_to_client:
      'Non posso portare la sezione interna “{section}” nella versione per il cliente.',
    section_changed:
      'Non posso cambiare il contenuto della sezione “{section}”: a parole posso solo aggiungere o rendere più severo.',
    prerequisite_removed:
      'Non posso togliere i dati da {name} che la ricetta chiede: una modifica a parole può solo rendere la ricetta più severa.',
    prerequisite_made_optional:
      'Non posso usare i dati da {name} solo «se ci sono»: oggi sono necessari.',
    threshold_loosened:
      'Non posso allentare la soglia di {name} rispetto alla versione in uso: posso solo renderla più severa.',
    rule_removed:
      'Non posso togliere né riscrivere la regola di scrittura «{text}»: posso solo aggiungerne di nuove.',
    red_team_rule_removed:
      'Non posso togliere né riscrivere il controllo del revisore «{text}»: posso solo aggiungerne di nuovi.',
    check_removed:
      'Non posso togliere il controllo “{name}”: una modifica a parole può solo rendere la ricetta più severa.',
    check_class_lowered:
      'Non posso trasformare il controllo “{name}” in un controllo sulla sola forma: oggi controlla i dati.',
    check_weakened:
      'Non posso allentare il controllo “{name}”: una modifica a parole può solo rendere la ricetta più severa.',
    category_removed: 'Non posso togliere l’etichetta interna dal dato “{name}”.',
    exclusion_removed:
      'Non posso far tornare righe escluse o nasconderne l’elenco con una modifica a parole.',
    label_bypassed:
      'Non posso mostrare “{name}” nella versione per il cliente come un dato meno riservato di quanto la ricetta lo tratta oggi.',
    labelled_section_replaced:
      'Questa modifica toglie una sezione con dati riservati e insieme aggiunge dati per il cliente: falla in due modifiche separate.',
    block_id_reused:
      'Una parte della sezione tolta “{section}” torna con lo stesso nome: aggiungila con un nome nuovo.',
    client_version_condition_changed:
      'Non posso cambiare né togliere la scelta che decide se il deliverable va anche al cliente: oggi la versione per il cliente c’è solo quando la chiedi tu.',
    client_version_by_default:
      'Non posso far andare al cliente “{name}” se non dici altro: la versione per il cliente si chiede ogni volta.',
    rule_loosening:
      'La regola «{text}» chiede di saltare, tacere o allentare un controllo, o di portare fuori dati interni: scrivila come una regola più severa (per esempio «Segnala sempre …»).',
    request_invalid:
      'La richiesta è vuota o troppo lunga: scrivi in poche frasi che cosa cambiare nella ricetta.',
  },
  minutes: {
    participants_outside_team:
      'Partecipanti che non fanno parte del team del progetto: {names}. La loro organizzazione non è dedotta: indicala tu, se serve.',
  },
}
