// What a template of the library or of a project may contain. A template is an Office package
// (docx, pptx, xlsx) without active content: no macros, no ActiveX controls or automatic fields,
// no external links and no embedded objects, with a cap on its size compressed and expanded.
//
// The rules here are pure and work on values a strict XML parser has already decoded: element
// local names with their namespace URI (never a prefix), attribute values and texts with their
// references resolved. The parsing is in `@octobrief/extract` (`inspectTemplate`): every XML part
// is parsed strictly (no DTD, no entity other than the predefined ones, any error refuses). The
// renderer checks the same list on every template it uses.

export const TEMPLATE_FORMATS = ['docx', 'pptx', 'xlsx'] as const
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number]

/** Cap on the size of the file as uploaded. */
export const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024
/** Cap on the sum of the expanded sizes of its parts. */
export const MAX_TEMPLATE_EXPANDED_BYTES = 50 * 1024 * 1024
export const MAX_TEMPLATE_ENTRIES = 2000

export const TEMPLATE_REFUSALS = [
  'template_format_unknown',
  'template_unreadable',
  'template_too_large',
  'template_expanded_too_large',
  'template_macro',
  'template_active_content',
  'template_external_link',
  'template_embedded_object',
  'template_part_unknown',
  /** The check did not finish in time: the template is refused, never accepted unchecked. */
  'template_unchecked',
] as const
export type TemplateRefusal = (typeof TEMPLATE_REFUSALS)[number]

/** How long the check of one template may take, and how deep its XML may nest. */
export const TEMPLATE_CHECK_TIMEOUT_MS = 20_000
export const MAX_TEMPLATE_XML_DEPTH = 256

/** The content type of the main part of each format, compared exactly. */
export const MAIN_CONTENT_TYPES: Readonly<Record<TemplateFormat, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
}

/** The namespace of the relationships of a package (the same in strict and transitional). */
export const RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/relationships'
export const CONTENT_TYPES_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/content-types'

/** Extensions of the Office formats that carry macros (or may: the binary workbook). */
const MACRO_EXTENSIONS = new Set([
  'docm',
  'dotm',
  'xlsm',
  'xltm',
  'xlsb',
  'xlam',
  'pptm',
  'potm',
  'ppsm',
  'ppam',
])

const extensionOf = (name: string): string =>
  name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''

/** The format of a template by the extension of its name; null for anything else. */
export function templateFormatOf(fileName: string): TemplateFormat | null {
  const ext = extensionOf(fileName)
  return (TEMPLATE_FORMATS as readonly string[]).includes(ext) ? (ext as TemplateFormat) : null
}

/** Refused by its name alone: a macro-enabled format, or not an Office template. */
export function fileNameRefusal(fileName: string): TemplateRefusal | null {
  if (MACRO_EXTENSIONS.has(extensionOf(fileName))) return 'template_macro'
  return templateFormatOf(fileName) === null ? 'template_format_unknown' : null
}

// Parts ------------------------------------------------------------------------------------------

/** Images and fonts: their content type must say so, and images must start as they claim. */
const IMAGE_MAGIC: Readonly<Record<string, readonly (readonly number[])[]>> = {
  png: [[0x89, 0x50, 0x4e, 0x47]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  jpe: [[0xff, 0xd8, 0xff]],
  jfif: [[0xff, 0xd8, 0xff]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  bmp: [[0x42, 0x4d]],
  tif: [
    [0x49, 0x49, 0x2a, 0x00],
    [0x4d, 0x4d, 0x00, 0x2a],
  ],
  tiff: [
    [0x49, 0x49, 0x2a, 0x00],
    [0x4d, 0x4d, 0x00, 0x2a],
  ],
  emf: [[0x01, 0x00, 0x00, 0x00]],
  wmf: [
    [0xd7, 0xcd, 0xc6, 0x9a],
    [0x01, 0x00, 0x09, 0x00],
    [0x02, 0x00, 0x09, 0x00],
  ],
  webp: [[0x52, 0x49, 0x46, 0x46]],
}
/**
 * Fonts whose first bytes can be checked. An obfuscated font (`odttf`) and the embedded font data
 * of a presentation (`fntdata`) have no signature to check: only their content type is.
 */
const FONT_MAGIC: Readonly<Record<string, readonly (readonly number[])[]>> = {
  ttf: [
    [0x00, 0x01, 0x00, 0x00],
    [0x74, 0x72, 0x75, 0x65],
    [0x4f, 0x54, 0x54, 0x4f],
  ],
  otf: [[0x4f, 0x54, 0x54, 0x4f]],
  woff: [[0x77, 0x4f, 0x46, 0x46]],
  woff2: [[0x77, 0x4f, 0x46, 0x32]],
}
const FONT_EXTENSIONS = new Set(['fntdata', 'odttf', 'ttf', 'otf', 'woff', 'woff2'])
const startsWithAny = (head: Uint8Array, magic: readonly (readonly number[])[]): boolean =>
  magic.some((m) => m.every((b, i) => head[i] === b))

/**
 * Whether a part named as an image or a font is declared as something else: such a part is
 * refused, whatever its content (an SVG is an image declared as XML, and is read as XML).
 */
export function mediaPartMismatch(name: string, contentType: string | null): boolean {
  const ext = extensionOf(name)
  if (ext === 'svg') return contentType === null || !/^image\/svg\+xml$/i.test(contentType.trim())
  if (IMAGE_MAGIC[ext] !== undefined) return contentType === null || !/^image\//i.test(contentType)
  if (FONT_EXTENSIONS.has(ext)) return contentType === null || !isFontContentType(contentType)
  return false
}
const XML_EXTENSIONS = new Set(['xml', 'rels', 'vml'])

/** Whether a content type is XML: then the part is parsed and checked, whatever its name. */
export function isXmlContentType(contentType: string): boolean {
  const base = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  return base.endsWith('+xml') || base === 'application/xml' || base === 'text/xml'
}

const isFontContentType = (ct: string): boolean =>
  /^(font\/|application\/(x-font|font-|vnd\.ms-(opentype|fontobject)|vnd\.openxmlformats-officedocument\.obfuscatedfont|x-fontdata))/i.test(
    ct,
  )

/**
 * Whether a part that is not XML may be in a template: an image whose content type is an image and
 * whose first bytes are of its kind, a font declared as a font, or the printer settings. Any other
 * part, or a part without a content type, is `template_part_unknown`.
 */
export function binaryPartFinding(
  name: string,
  contentType: string | null,
  head: Uint8Array,
): TemplateRefusal | null {
  const ext = extensionOf(name)
  if (contentType === null) return 'template_part_unknown'
  const magic = IMAGE_MAGIC[ext]
  if (magic !== undefined) {
    if (!/^image\//i.test(contentType)) return 'template_part_unknown'
    return startsWithAny(head, magic) ? null : 'template_part_unknown'
  }
  if (FONT_EXTENSIONS.has(ext)) {
    if (!isFontContentType(contentType)) return 'template_part_unknown'
    const fontMagic = FONT_MAGIC[ext]
    return fontMagic === undefined || startsWithAny(head, fontMagic)
      ? null
      : 'template_part_unknown'
  }
  // A binary part other than the printer settings is refused by its name (partNameFindings).
  if (ext === 'bin') return null
  return 'template_part_unknown'
}

/** Whether a part with this name is read as XML even without a declared XML content type. */
export function isXmlPartName(name: string): boolean {
  return XML_EXTENSIONS.has(extensionOf(name))
}

/** What the name of a part says about it (folders of macros, controls, objects, links). */
export function partNameFindings(name: string): TemplateRefusal[] {
  const n = name.toLowerCase()
  const out: TemplateRefusal[] = []
  if (n.includes('vbaproject') || n.includes('vbadata') || /(^|\/)macrosheets\//.test(n)) {
    out.push('template_macro')
  }
  if (/(^|\/)activex\//.test(n) || n.includes('customui')) out.push('template_active_content')
  if (/(^|\/)embeddings\//.test(n) || n.includes('oleobject')) out.push('template_embedded_object')
  if (
    /(^|\/)externallinks\//.test(n) ||
    n.endsWith('/connections.xml') ||
    n.includes('querytables/')
  ) {
    out.push('template_external_link')
  }
  if (n.endsWith('.bin') && !n.includes('printersettings') && !/(^|\/)embeddings\//.test(n)) {
    out.push('template_active_content')
  }
  return out
}

/** What a declared content type says about its part. */
export function contentTypeFindings(contentType: string): TemplateRefusal[] {
  const out: TemplateRefusal[] = []
  if (/macroEnabled|vbaProject|macrosheet/i.test(contentType)) out.push('template_macro')
  if (/oleObject/i.test(contentType)) out.push('template_embedded_object')
  if (/activeX|webextension|dialogsheet|customui|ui\.extensibility/i.test(contentType)) {
    out.push('template_active_content')
  }
  if (/spreadsheetml\.(connections|queryTable)\+xml|externalLink/i.test(contentType)) {
    out.push('template_external_link')
  }
  return out
}

// Relationships ----------------------------------------------------------------------------------

/** The last segment of a relationship type, lower case. */
const RELATIONSHIP_FINDINGS: Readonly<Record<string, TemplateRefusal>> = {
  vbaproject: 'template_macro',
  wordvbadata: 'template_macro',
  keymapcustomizations: 'template_macro',
  xlmacrosheet: 'template_macro',
  xlintlmacrosheet: 'template_macro',
  control: 'template_active_content',
  activexcontrolbinary: 'template_active_content',
  oleobject: 'template_embedded_object',
  package: 'template_embedded_object',
  afchunk: 'template_embedded_object',
  attachedtemplate: 'template_external_link',
  externallink: 'template_external_link',
  externallinkpath: 'template_external_link',
  subdocument: 'template_external_link',
  frame: 'template_external_link',
  connections: 'template_external_link',
  querytable: 'template_external_link',
  extensibility: 'template_active_content',
  dialogsheet: 'template_active_content',
  attachedtoolbars: 'template_active_content',
}

/** A type of relationship: an absolute URI without query, fragment or spaces. */
const RELATIONSHIP_TYPE = /^[a-z][a-z0-9+.-]*:\/\/[^?#\s]+$/i
/** A path that leaves the package, once read as Office reads it: a scheme, a UNC path. */
const LEAVING = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/**
 * The white space and controls trimmed at both ends of a target or a link: the C0 controls, the
 * space, DEL and the Unicode spaces (no-break, next line, byte order mark…). Written out, the
 * same in the renderer, so both gates trim the same characters.
 */
export const EDGE_CHARACTERS =
  '\\u0000-\\u0020\\u007f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
const EDGES = new RegExp(`^[${EDGE_CHARACTERS}]+|[${EDGE_CHARACTERS}]+$`, 'g')

/**
 * A target or a link as Office or a browser may resolve it: tabs and line breaks dropped wherever
 * they are, controls and spaces trimmed at both ends, an escaped dot, slash or backslash read as
 * what it stands for, and a backslash as a slash.
 */
function resolvedPath(value: string): string {
  return value
    .replace(/[\t\n\r]/g, '')
    .replace(EDGES, '')
    .replace(/%(2e|2f|5c)/gi, (escaped) => decodeURIComponent(escaped))
    .replaceAll('\\', '/')
}

/** Whether a target or a link points outside the package (`/\host`, `\/host`, `file:`…). */
export function leavesPackage(value: string): boolean {
  return LEAVING.test(resolvedPath(value))
}

/** Whether a target, resolved against the folder of its part, climbs above the package root. */
function climbsOut(target: string, base: string): boolean {
  const path = resolvedPath(target)
  const segments = path.startsWith('/') ? [] : base.split('/').filter((s) => s !== '')
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return true
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return false
}

/**
 * What a relationship says, from its decoded attributes: a type it must have (one that cannot be
 * read is `template_unreadable`), a target mode that may only be absent or `Internal`, and an
 * internal target that stays in the package, also once resolved against `base`, the folder of the
 * part the relationship belongs to (empty for the package itself).
 */
export function relationshipFindings(
  type: string | undefined,
  targetMode: string | undefined,
  target?: string,
  base?: string,
): TemplateRefusal[] {
  const out: TemplateRefusal[] = []
  if (targetMode !== undefined && targetMode !== 'Internal') out.push('template_external_link')
  else if (
    target !== undefined &&
    (leavesPackage(target) || (base !== undefined && climbsOut(target, base)))
  ) {
    out.push('template_external_link')
  }
  const trimmed = (type ?? '').trim()
  if (type === undefined || !RELATIONSHIP_TYPE.test(trimmed)) {
    out.push('template_unreadable')
    return out
  }
  const kind = trimmed.split('/').pop()?.toLowerCase() ?? ''
  if (kind === '') {
    out.push('template_unreadable')
    return out
  }
  if (kind.startsWith('webextension')) out.push('template_active_content')
  const finding = Object.hasOwn(RELATIONSHIP_FINDINGS, kind)
    ? RELATIONSHIP_FINDINGS[kind]
    : undefined
  if (finding) out.push(finding)
  return out
}

// Elements, fields and formulas ------------------------------------------------------------------

const WORDPROCESSING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
])

/** Elements that are embedded objects or controls, by local name (any namespace unless noted). */
const EMBEDDED_ELEMENTS = new Set(['OLEObject', 'oleObj', 'oleObject', 'oleObjects'])
const CONTROL_ELEMENTS = new Set(['control', 'controls'])

/** The data source of a mail merge: a connection to a database or a file outside the package. */
const MAIL_MERGE_SOURCES = new Set(['connectString', 'query', 'dataSource', 'headerSource'])

/** What an element is, by its namespace URI and local name. */
export function elementFindings(uri: string, local: string): TemplateRefusal[] {
  if (EMBEDDED_ELEMENTS.has(local)) return ['template_embedded_object']
  if (local === 'object' && WORDPROCESSING_NAMESPACES.has(uri)) return ['template_embedded_object']
  if (CONTROL_ELEMENTS.has(local)) return ['template_active_content']
  if (local === 'FmlaMacro') return ['template_macro']
  // A script in an SVG image, a ribbon of its own (customUI, whatever the part is called).
  if (local === 'script' || local === 'customUI') return ['template_active_content']
  // A mail merge, with or without a source: a neutral template never needs one.
  if (
    (local === 'mailMerge' || MAIL_MERGE_SOURCES.has(local)) &&
    WORDPROCESSING_NAMESPACES.has(uri)
  ) {
    return ['template_external_link']
  }
  return []
}

/**
 * Elements whose text is a formula (cells, names, rules, validations, tables, chart series), by
 * local name in any namespace: Office keeps formulas under many namespaces of its own (`c15`,
 * `c16`, `cx`, `x15`…), so a list of namespaces would leave some out. Only the equations of
 * Office Math (`OMML_NAMESPACES`), whose `f` is a fraction, are not formulas.
 */
export const FORMULA_ELEMENTS: ReadonlySet<string> = new Set([
  'f',
  'definedName',
  'formula',
  'formula1',
  'formula2',
  'calculatedColumnFormula',
  'totalsRowFormula',
])
/** The namespaces of Office Math, transitional and strict. */
export const OMML_NAMESPACES: ReadonlySet<string> = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/math',
  'http://purl.oclc.org/ooxml/officeDocument/math',
])
/** The namespace of the Excel 2010 extensions, whose `formula1`/`formula2` hold an `xm:f`. */
export const X14_NAMESPACE = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
/** The chart extensions of Office 2013, whose `sqref` (in `fullRef`) is a reference. */
const C15_NAMESPACE = 'http://schemas.microsoft.com/office/drawing/2012/chart'

/** Whether an element holds a formula as its text. */
export function isFormulaElement(uri: string, local: string): boolean {
  if (local === 'sqref' && uri === C15_NAMESPACE) return true
  return FORMULA_ELEMENTS.has(local) && !OMML_NAMESPACES.has(uri)
}

/**
 * Whether a formula element only wraps the formula it holds (`x14:formula1` and `x14:formula2`
 * wrap an `xm:f`): its own text may only be white space.
 */
export function isFormulaWrapper(uri: string, local: string): boolean {
  return uri === X14_NAMESPACE && (local === 'formula1' || local === 'formula2')
}

/** Attributes whose value is a formula: calculated items and fields of a pivot table, the text
 * link of a drawing shape. */
export const FORMULA_ATTRIBUTES: ReadonlySet<string> = new Set(['formula', 'textlink'])

/** An image inline in a link: only a raster image, never an SVG (which could run or fetch). */
const RASTER_DATA = /^data:image\/(?:png|jpeg|gif|webp)[;,]/i

/**
 * What a decoded attribute with this local name and value points to (`href` of an SVG, a link):
 * outside the package, or above its root once resolved against `base`, the folder of its part.
 */
export function hrefFindings(local: string, value: string, base?: string): TemplateRefusal[] {
  if (local !== 'href') return []
  if (RASTER_DATA.test(resolvedPath(value))) return []
  if (leavesPackage(value) || (base !== undefined && climbsOut(value, base))) {
    return ['template_external_link']
  }
  return []
}

/** The namespace of SVG: its rules apply there, and to every element of an `.svg` part. */
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/**
 * Elements of an SVG image that run or fetch something: a foreign object (HTML inside the image),
 * an animation (`set` can rewrite a link), a style sheet (`@import`, `url(…)`), a script.
 */
const SVG_ACTIVE_ELEMENTS = new Set([
  'foreignObject',
  'set',
  'animate',
  'animateMotion',
  'animateTransform',
  'animateColor',
  'style',
  'script',
  'handler',
  'listener',
])

export function svgElementFindings(local: string): TemplateRefusal[] {
  return SVG_ACTIVE_ELEMENTS.has(local) ? ['template_active_content'] : []
}

/** A `url(` that is not a reference inside the image (`url(#id)`), a `src(` or an `image-set(`. */
const OUTSIDE_URL = /url\s*\(\s*(?!#)|src\s*\(|image-set\s*\(/i
/** The namespace of `xml:base`, which would move every relative link of the image elsewhere. */
export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
/** The namespace of the links of an SVG image (`xlink:href`): its attributes are allowed. */
export const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'

/**
 * The only namespaces of elements inside the `metadata` of an SVG besides SVG itself: RDF,
 * Dublin Core (elements and terms) and Creative Commons. Anything else there is refused.
 */
export const METADATA_NAMESPACES: ReadonlySet<string> = new Set([
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://purl.org/dc/elements/1.1/',
  'http://purl.org/dc/terms/',
  'http://creativecommons.org/ns#',
  'http://web.resource.org/cc/',
])

/** Attributes of a metadata element that would fetch something. */
const METADATA_URL_ATTRIBUTES = new Set(['src', 'data', 'action'])

/**
 * What an attribute of a metadata element (RDF, Dublin Core, Creative Commons) points to: an
 * attribute that fetches (`src`, `data`, `action`) or any value that leaves the package, even a
 * licence (`rdf:resource="https://creativecommons.org/…"`).
 */
export function metadataAttributeFindings(local: string, value: string): TemplateRefusal[] {
  if (METADATA_URL_ATTRIBUTES.has(local) || leavesPackage(value)) return ['template_external_link']
  return []
}

/**
 * What an attribute of an SVG element does: an event handler (`on…`) or a `style` attribute is
 * refused outright; a presentation attribute may only refer to the image itself (`url(#id)`), and a
 * value with an escape and a parenthesis (`u\72l(…)`) is refused, as CSS would read the escape;
 * `xml:base` is refused, as it moves every relative link of the image.
 */
export function svgAttributeFindings(local: string, value: string, uri = ''): TemplateRefusal[] {
  if (uri === XML_NAMESPACE && local === 'base') return ['template_external_link']
  if (/^on/i.test(local) || local === 'style') return ['template_active_content']
  if (OUTSIDE_URL.test(value) || (value.includes('\\') && value.includes('('))) {
    return ['template_external_link']
  }
  return []
}

/** The namespaces of WordprocessingML, transitional and strict: fields are read only there. */
export const WORDPROCESSING_NAMESPACE_URIS: ReadonlySet<string> = WORDPROCESSING_NAMESPACES

/** The elements of fields (`fldChar`, `instrText`, `fldSimple` and the deleted instruction). */
export const FIELD_ELEMENTS = {
  character: 'fldChar',
  instruction: 'instrText',
  deletedInstruction: 'delInstrText',
  simple: 'fldSimple',
  /** The attribute of a field character that says which it is. */
  characterType: 'fldCharType',
  /** The attribute of a simple field that holds its instruction. */
  simpleInstruction: 'instr',
} as const
export const FIELD_CHARACTER_TYPES: ReadonlySet<string> = new Set(['begin', 'separate', 'end'])
/** What a field character may carry: the data of a form field or of the field, never inert. */
export const FIELD_CHARACTER_DATA: ReadonlySet<string> = new Set(['ffData', 'fldData'])
/**
 * The only WordprocessingML elements between the beginning of a field and its separator, outside
 * the formatting of a run: runs, their formatting, the instruction, field characters and simple
 * fields (a nested field, refused as such), proofing marks and bookmarks. Anything else there
 * (`t`, `delText`, `sym`, `tab`, a paragraph, another namespace) could carry characters that
 * Office reads as part of the instruction.
 */
export const FIELD_INSTRUCTION_ELEMENTS: ReadonlySet<string> = new Set([
  'r',
  'rPr',
  'instrText',
  'fldChar',
  'fldSimple',
  'proofErr',
  'bookmarkStart',
  'bookmarkEnd',
])

/**
 * The only fields a template may have: inert page numbers, dates and times, with simple format
 * switches. A denylist of field types is a race (fields nest, build words, refer to bookmarks):
 * any other instruction is refused.
 */
const INERT_FIELD =
  /^\s*(?:PAGE|NUMPAGES|SECTIONPAGES|DATE|TIME)(?:\s+(?:\\@\s*"[^"\\]*"|\\\*\s*(?:MERGEFORMAT|Arabic|roman|ROMAN)))*\s*$/i

/** What the full, decoded instruction of one field asks: nothing, or active content. */
export function fieldInstructionFindings(instruction: string): TemplateRefusal[] {
  return INERT_FIELD.test(instruction) ? [] : ['template_active_content']
}

/** What a formula holds: an allowlist of tokens, in `formula.ts`. */
export { formulaFindings } from './formula.ts'

/** What a decoded attribute value does (the actions of a slide). */
export function attributeValueFindings(value: string): TemplateRefusal[] {
  if (/^\s*ppaction:\/\/macro/i.test(value)) return ['template_macro']
  if (/^\s*ppaction:\/\/program/i.test(value)) return ['template_active_content']
  return []
}

/** The refusals in the order of `TEMPLATE_REFUSALS`, each once. */
export function orderedRefusals(found: Iterable<TemplateRefusal>): TemplateRefusal[] {
  const set = new Set(found)
  return TEMPLATE_REFUSALS.filter((r) => set.has(r))
}
