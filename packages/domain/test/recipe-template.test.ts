import { describe, expect, it } from 'vitest'
import {
  attributeValueFindings,
  binaryPartFinding,
  contentTypeFindings,
  elementFindings,
  fieldInstructionFindings,
  fileNameRefusal,
  formulaFindings,
  hrefFindings,
  isXmlContentType,
  mediaPartMismatch,
  orderedRefusals,
  partNameFindings,
  recipeText,
  relationshipFindings,
  svgAttributeFindings,
  svgElementFindings,
  TEMPLATE_REFUSALS,
  templateFormatOf,
} from '../src/recipe/index.ts'
import { growthSlope, MAX_GROWTH_SLOPE, TIMING_TEST_TIMEOUT_MS } from './timing.ts'

const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

describe('the name of a template', () => {
  it('knows the three Office formats by their extension', () => {
    expect(templateFormatOf('a.docx')).toBe('docx')
    expect(templateFormatOf('B.PPTX')).toBe('pptx')
    expect(templateFormatOf('c.xlsx')).toBe('xlsx')
    expect(templateFormatOf('d.docm')).toBeNull()
    expect(templateFormatOf('noextension')).toBeNull()
  })

  it('refuses a macro-enabled format and anything that is not a template', () => {
    for (const name of ['a.docm', 'a.xlsm', 'a.pptm', 'a.dotm', 'a.xlsb']) {
      expect(fileNameRefusal(name)).toBe('template_macro')
    }
    expect(fileNameRefusal('a.pdf')).toBe('template_format_unknown')
    expect(fileNameRefusal('a.docx')).toBeNull()
  })
})

describe('the parts of a template', () => {
  it('refuses parts of macros, controls, objects and links by their name', () => {
    expect(partNameFindings('word/vbaProject.bin')).toContain('template_macro')
    expect(partNameFindings('xl/macrosheets/sheet1.xml')).toEqual(['template_macro'])
    expect(partNameFindings('word/activeX/activeX1.xml')).toEqual(['template_active_content'])
    expect(partNameFindings('word/embeddings/x.docx')).toEqual(['template_embedded_object'])
    expect(partNameFindings('xl/externalLinks/externalLink1.xml')).toEqual([
      'template_external_link',
    ])
    expect(partNameFindings('xl/printerSettings/printerSettings1.bin')).toEqual([])
    expect(partNameFindings('word/document.xml')).toEqual([])
  })

  it('refuses content types of macros, objects and controls', () => {
    expect(contentTypeFindings('application/vnd.ms-excel.macrosheet+xml')).toEqual([
      'template_macro',
    ])
    expect(contentTypeFindings('application/vnd.ms-word.document.macroEnabled.main+xml')).toEqual([
      'template_macro',
    ])
    expect(contentTypeFindings('application/vnd.openxmlformats-officedocument.oleObject')).toEqual([
      'template_embedded_object',
    ])
    expect(contentTypeFindings('application/vnd.ms-office.activeX+xml')).toEqual([
      'template_active_content',
    ])
  })

  it('reads as XML every part declared with an XML content type', () => {
    expect(isXmlContentType('application/xml')).toBe(true)
    expect(isXmlContentType('application/vnd.ms-excel.macrosheet+xml')).toBe(true)
    expect(isXmlContentType('image/png')).toBe(false)
  })

  it('accepts an image or a font only as what it claims to be', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
    expect(binaryPartFinding('word/media/a.png', 'image/png', png)).toBeNull()
    expect(binaryPartFinding('word/media/a.png', 'application/octet-stream', png)).toBe(
      'template_part_unknown',
    )
    expect(binaryPartFinding('word/media/a.png', 'image/png', new Uint8Array([60, 63]))).toBe(
      'template_part_unknown',
    )
    expect(binaryPartFinding('word/media/a.png', null, png)).toBe('template_part_unknown')
    expect(
      binaryPartFinding(
        'word/fonts/a.odttf',
        'application/vnd.openxmlformats-officedocument.obfuscatedFont',
        png,
      ),
    ).toBeNull()
    expect(binaryPartFinding('word/run.exe', 'application/octet-stream', png)).toBe(
      'template_part_unknown',
    )
  })
})

describe('relationships', () => {
  it('refuses any target mode other than Internal', () => {
    expect(relationshipFindings(`${RT}hyperlink`, 'External')).toEqual(['template_external_link'])
    expect(relationshipFindings(`${RT}hyperlink`, 'external')).toEqual(['template_external_link'])
    expect(relationshipFindings(`${RT}styles`, 'Internal')).toEqual([])
    expect(relationshipFindings(`${RT}styles`, undefined)).toEqual([])
  })

  it('refuses a relationship without a readable type', () => {
    expect(relationshipFindings(undefined, undefined)).toEqual(['template_unreadable'])
    expect(relationshipFindings('oleObject', undefined)).toEqual(['template_unreadable'])
  })

  it('refuses the types of macros, objects, sub-documents and frames', () => {
    for (const [kind, refusal] of [
      ['oleObject', 'template_embedded_object'],
      ['package', 'template_embedded_object'],
      ['aFChunk', 'template_embedded_object'],
      ['subDocument', 'template_external_link'],
      ['frame', 'template_external_link'],
      ['attachedTemplate', 'template_external_link'],
      ['xlMacrosheet', 'template_macro'],
      ['xlIntlMacrosheet', 'template_macro'],
      ['vbaProject', 'template_macro'],
      ['control', 'template_active_content'],
    ] as const) {
      expect(relationshipFindings(`${RT}${kind}`, undefined)).toEqual([refusal])
    }
  })
})

describe('elements, fields and formulas', () => {
  it('refuses embedded objects and controls by local name, never by prefix', () => {
    expect(elementFindings('urn:schemas-microsoft-com:office:office', 'OLEObject')).toEqual([
      'template_embedded_object',
    ])
    expect(elementFindings(W, 'object')).toEqual(['template_embedded_object'])
    expect(elementFindings('urn:other', 'object')).toEqual([])
    expect(elementFindings(W, 'control')).toEqual(['template_active_content'])
    expect(elementFindings('urn:x', 'FmlaMacro')).toEqual(['template_macro'])
    expect(elementFindings(W, 'p')).toEqual([])
  })

  it('accepts only inert fields: page numbers, dates and times with simple formats', () => {
    for (const inert of [
      ' PAGE ',
      'NUMPAGES \\* MERGEFORMAT',
      'SECTIONPAGES \\* Arabic',
      ' DATE \\@ "dd/MM/yyyy" \\* MERGEFORMAT ',
      'TIME \\@ "HH:mm"',
      'page \\* roman',
    ]) {
      expect(fieldInstructionFindings(inert)).toEqual([])
    }
  })

  it('refuses every other field, whatever it looks like', () => {
    // Built at run time: field codes that act, link, nest or refer to bookmarks.
    for (const field of [
      ['DDE', 'AUTO c "x"'].join(''),
      ' INCLUDETEXT "c:\\a.docx" ',
      'DATABASE \\d "x"',
      'MACROBUTTON FileOpen x',
      'QUOTE "TEXT"',
      'SET a "x"',
      'REF a',
      'mybookmark',
      'HYPERLINK "https://example.test"',
      'TOC \\o "1-3"',
      'PAGE \\* CHARFORMAT',
      'DATE \\@ "d\\"x"',
      'PAGEREF a',
      '',
    ]) {
      expect(fieldInstructionFindings(field)).toEqual(['template_active_content'])
    }
  })

  it('reads formulas that call out or run something', () => {
    expect(formulaFindings('1<2+WEBSERVICE("https://example.test")')).toEqual([
      'template_external_link',
    ])
    expect(formulaFindings("cmd|' /C calc'!A0")).toEqual(['template_active_content'])
    expect(formulaFindings('SUM(A1:A3)')).toEqual([])
  })

  it('reads the actions of a slide', () => {
    expect(attributeValueFindings('ppaction://macro?name=x')).toEqual(['template_macro'])
    expect(attributeValueFindings('ppaction://program')).toEqual(['template_active_content'])
    expect(attributeValueFindings('ppaction://hlinksldjump')).toEqual([])
  })
})

describe('more active and external content', () => {
  const MS = 'http://schemas.microsoft.com/office/2006/relationships/'
  it('refuses ribbons, connections, query tables, add-ins, dialog sheets and toolbars', () => {
    expect(relationshipFindings(`${MS}ui/extensibility`, undefined)).toEqual([
      'template_active_content',
    ])
    expect(
      relationshipFindings(
        'http://schemas.microsoft.com/office/2007/relationships/ui/extensibility',
        undefined,
      ),
    ).toEqual(['template_active_content'])
    expect(relationshipFindings(`${RT}connections`, undefined)).toEqual(['template_external_link'])
    expect(relationshipFindings(`${RT}queryTable`, undefined)).toEqual(['template_external_link'])
    for (const kind of ['webextension', 'webextensiontaskpanes']) {
      expect(
        relationshipFindings(
          `http://schemas.microsoft.com/office/2011/relationships/${kind}`,
          undefined,
        ),
      ).toEqual(['template_active_content'])
    }
    expect(relationshipFindings(`${RT}dialogsheet`, undefined)).toEqual(['template_active_content'])
    expect(relationshipFindings(`${MS}attachedToolbars`, undefined)).toEqual([
      'template_active_content',
    ])
    expect(
      contentTypeFindings(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml',
      ),
    ).toEqual(['template_external_link'])
    expect(
      contentTypeFindings(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.queryTable+xml',
      ),
    ).toEqual(['template_external_link'])
  })

  it('refuses a type with a query and an internal target that leaves the package', () => {
    expect(relationshipFindings(`${RT}oleObject?x`, undefined)).toEqual(['template_unreadable'])
    expect(relationshipFindings(`${RT}image`, undefined, 'http://example.test/a.png')).toEqual([
      'template_external_link',
    ])
    expect(relationshipFindings(`${RT}image`, 'Internal', '\\\\srv\\s\\a.png')).toEqual([
      'template_external_link',
    ])
    expect(relationshipFindings(`${RT}image`, undefined, 'media/image1.png')).toEqual([])
  })

  it('refuses the data source of a mail merge, scripts and links out of an SVG', () => {
    expect(elementFindings(W, 'connectString')).toEqual(['template_external_link'])
    expect(elementFindings(W, 'mailMerge')).toEqual(['template_external_link'])
    expect(
      elementFindings('http://purl.oclc.org/ooxml/wordprocessingml/main', 'mailMerge'),
    ).toEqual(['template_external_link'])
    expect(elementFindings('urn:other', 'mailMerge')).toEqual([])
    expect(elementFindings(W, 'query')).toEqual(['template_external_link'])
    expect(elementFindings('http://www.w3.org/2000/svg', 'script')).toEqual([
      'template_active_content',
    ])
    expect(hrefFindings('href', 'http://example.test/a.png')).toEqual(['template_external_link'])
    expect(hrefFindings('href', '#part')).toEqual([])
    expect(hrefFindings('href', 'data:image/png;base64,AAAA')).toEqual([])
  })

  it(
    'reads a long run of pipes in linear time',
    () => {
      const FULL = 200_000
      const { slope } = growthSlope((fraction) => {
        const formula = '|'.repeat(Math.round(FULL * fraction))
        return () => formulaFindings(formula)
      })
      expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
      expect(formulaFindings(`${['cm', 'd'].join('')}|' /C x'!A0`)).toEqual([
        'template_active_content',
      ])
    },
    TIMING_TEST_TIMEOUT_MS,
  )

  it(
    'reads long runs of quotes and brackets in linear time',
    () => {
      const FULL = 200_000
      for (const piece of ["'", "''", '[', '[a.', ']']) {
        const { slope } = growthSlope((fraction) => {
          const formula = piece.repeat(Math.round((FULL * fraction) / piece.length))
          return () => formulaFindings(formula)
        })
        expect(slope, piece).toBeLessThan(MAX_GROWTH_SLOPE)
      }
    },
    TIMING_TEST_TIMEOUT_MS,
  )

  it('refuses an image or a font declared as something else, and a font that is not one', () => {
    expect(mediaPartMismatch('word/media/i.png', 'application/xml')).toBe(true)
    expect(mediaPartMismatch('word/media/i.svg', 'image/svg+xml')).toBe(false)
    expect(mediaPartMismatch('word/media/i.svg', 'application/xml')).toBe(true)
    expect(mediaPartMismatch('word/document.xml', 'application/xml')).toBe(false)
    const notAFont = new TextEncoder().encode('MZ not a font')
    expect(binaryPartFinding('word/fonts/f.ttf', 'application/x-font-ttf', notAFont)).toBe(
      'template_part_unknown',
    )
    const ttf = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0, 0])
    expect(binaryPartFinding('word/fonts/f.ttf', 'application/x-font-ttf', ttf)).toBeNull()
  })
})

describe('refusals', () => {
  it('are given once, in a fixed order, each with a text for the PM', () => {
    expect(orderedRefusals(['template_macro', 'template_unreadable', 'template_macro'])).toEqual([
      'template_unreadable',
      'template_macro',
    ])
    for (const r of TEMPLATE_REFUSALS) expect(recipeText('templates', r, {}, 'it')).not.toBe('')
  })
})

const SVG_NS = 'http://www.w3.org/2000/svg'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const IMAGE = `${RT}image`

describe('targets and links that leave the package', () => {
  it('reads a backslash as a slash, whatever the mix', () => {
    for (const target of [
      '\\\\host\\share',
      '/\\host\\share',
      '\\/host/share',
      '/\\/evil',
      '//h',
    ]) {
      expect(relationshipFindings(IMAGE, undefined, target), target).toEqual([
        'template_external_link',
      ])
    }
    for (const href of ['/\\evil.example/p.png', '\\/evil.example/x', 'http://e']) {
      expect(hrefFindings('href', href), href).toEqual(['template_external_link'])
    }
    expect(hrefFindings('href', '#x')).toEqual([])
  })

  it('refuses an internal target that climbs out of the package from its part', () => {
    expect(relationshipFindings(IMAGE, undefined, '../media/a.png', 'word')).toEqual([])
    expect(relationshipFindings(IMAGE, undefined, 'media/a.png', 'word')).toEqual([])
    expect(relationshipFindings(IMAGE, undefined, '/word/media/a.png', 'word')).toEqual([])
    for (const target of ['../../x.png', '..\\..\\..\\x', '%2e%2e/%2e%2e/x', '/../x']) {
      expect(relationshipFindings(IMAGE, undefined, target, 'word'), target).toEqual([
        'template_external_link',
      ])
    }
    expect(relationshipFindings(IMAGE, undefined, '../x', '')).toEqual(['template_external_link'])
  })

  it('refuses a link that climbs out of the package from its part', () => {
    expect(hrefFindings('href', 'image2.png', 'word/media')).toEqual([])
    expect(hrefFindings('href', '../media/a.png', 'word/media')).toEqual([])
    expect(hrefFindings('href', '#g', 'word/media')).toEqual([])
    for (const href of ['../../../a.png', '..\\..\\..\\a.png', '/../a.png']) {
      expect(hrefFindings('href', href, 'word/media'), href).toEqual(['template_external_link'])
    }
  })
})

describe('targets and links with control characters and odd white space', () => {
  it('drops tabs and line breaks and trims controls before reading a target', () => {
    for (const value of [
      'h\tttp://evil.example/p.png',
      'java\nscript:alert(1)',
      '/\t/evil.example/p.png',
      'fi\rle:x',
      '\\\t\\evil\\s\\x.png',
      '\u0000\u001fhttp://e',
      '\ufeffhttp://e',
      '\u0085http://e',
      '\u00a0//e',
    ]) {
      expect(hrefFindings('href', value, 'word/media'), JSON.stringify(value)).toEqual([
        'template_external_link',
      ])
      expect(relationshipFindings(IMAGE, undefined, value, 'word'), JSON.stringify(value)).toEqual([
        'template_external_link',
      ])
    }
    expect(relationshipFindings(IMAGE, undefined, '.\t./.\t./.\t./x.png', 'word')).toEqual([
      'template_external_link',
    ])
  })

  it('accepts only raster images inline, whatever the white space before them', () => {
    for (const ok of [
      'data:image/png;base64,AA',
      '\ufeffdata:image/jpeg,AA',
      ' data:image/webp,A',
    ]) {
      expect(hrefFindings('href', ok), ok).toEqual([])
    }
    for (const no of ['data:image/svg+xml,<svg/>', 'data:text/html,x', '\u0085data:image/gif']) {
      expect(hrefFindings('href', no), no).toEqual(['template_external_link'])
    }
  })
})

describe('formulas that read another workbook by its path', () => {
  it('refuses a quoted sheet with a path and a bracketed file name', () => {
    for (const formula of [
      "'\\\\evil\\s\\[a.xlsx]Sheet1'!A1",
      "'http://evil/[a.xlsx]Sheet1'!A1",
      "SUM('C:\\dati\\[b.xlsx]Foglio'!A1:A3)",
      '[a.xlsx]Sheet1!A1',
      "'[a.xlsx]Sheet 1'!A1",
    ]) {
      expect(formulaFindings(formula), formula).toEqual(['template_external_link'])
    }
  })

  it('keeps references to its own sheets and structured references to its tables', () => {
    const workbook = {
      sheets: new Set(['il mio foglio', 'sheet1', 'sheet2', "sal's"]),
      names: new Set<string>(),
      tables: new Set(['table1']),
    }
    for (const formula of [
      "'Il mio foglio'!A1",
      'Sheet1!A1+1',
      'SUM(Table1[[#This Row],[Col]])',
      'Table1[Col.x]+Sheet2!A1',
      "'SAL''s'!$C$4",
    ]) {
      expect(formulaFindings(formula, workbook), formula).toEqual([])
    }
  })
})

describe('active content and outside references in an SVG image', () => {
  it('refuses handlers and listeners, xml:base and source functions', () => {
    for (const local of ['handler', 'listener']) {
      expect(svgElementFindings(local), local).toEqual(['template_active_content'])
    }
    expect(svgAttributeFindings('base', 'http://e/', XML_NS)).toEqual(['template_external_link'])
    expect(svgAttributeFindings('base', 'x', '')).toEqual([])
    expect(svgAttributeFindings('fill', 'src("x.svg")')).toEqual(['template_external_link'])
    expect(svgAttributeFindings('fill', 'image-set("x.png" 1x)')).toEqual([
      'template_external_link',
    ])
  })
})

describe('the SVG rules, as before', () => {
  it('refuses foreign objects, animations, style sheets and scripts', () => {
    for (const local of ['foreignObject', 'set', 'animate', 'animateMotion', 'style', 'script']) {
      expect(svgElementFindings(local), local).toEqual(['template_active_content'])
    }
    expect(svgElementFindings('rect')).toEqual([])
  })

  it('refuses event handlers, style attributes and urls that are not of the image itself', () => {
    expect(svgAttributeFindings('onload', 'alert(1)')).toEqual(['template_active_content'])
    expect(svgAttributeFindings('ONCLICK', 'x')).toEqual(['template_active_content'])
    expect(svgAttributeFindings('style', 'fill:red')).toEqual(['template_active_content'])
    expect(svgAttributeFindings('fill', 'url(http://evil.example/x.svg#p)')).toEqual([
      'template_external_link',
    ])
    expect(svgAttributeFindings('fill', 'URL( "x.svg#p")')).toEqual(['template_external_link'])
    expect(svgAttributeFindings('fill', 'u\\72l(x)')).toEqual(['template_external_link'])
    expect(svgAttributeFindings('fill', 'url(#gradient)')).toEqual([])
    expect(svgAttributeFindings('fill', 'red')).toEqual([])
    expect(elementFindings(SVG_NS, 'rect')).toEqual([])
  })
})
