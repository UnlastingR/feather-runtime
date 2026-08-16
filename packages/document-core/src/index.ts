import { formatFromExtension, toMarkdownBytes } from '@firecrawl/anydoc';
import { classifyPdfAsync } from '@firecrawl/pdf-inspector';
import TurndownService from 'turndown';
import { RuntimeError } from '@feather/shared';

export interface DocumentParseResult {
  markdown: string;
  metadata: Record<string, unknown>;
  parser: string;
  confidence: number;
}

export interface DocumentParser {
  supports(mime: string, extension: string): boolean;
  parse(input: Buffer, context: { mime: string; extension: string }): Promise<DocumentParseResult>;
}

const anyDocExtensions = new Set([
  'doc',
  'docx',
  'docm',
  'ppt',
  'pps',
  'pot',
  'pptx',
  'pptm',
  'ppsx',
  'ppsm',
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'odt',
  'ods',
  'odp',
  'rtf',
  'epub',
  'csv',
  'pdf',
]);

export class AnyDocAdapter implements DocumentParser {
  supports(_mime: string, extension: string): boolean {
    return anyDocExtensions.has(extension.replace(/^\./, '').toLowerCase());
  }

  async parse(
    input: Buffer,
    context: { mime: string; extension: string },
  ): Promise<DocumentParseResult> {
    const extension = context.extension.replace(/^\./, '').toLowerCase();
    if (extension === 'pdf' || context.mime === 'application/pdf') {
      const classification = await classifyPdfAsync(input);
      if (
        classification.pdfType === 'Scanned' ||
        classification.pdfType === 'ImageBased' ||
        classification.pagesNeedingOcr.length > 0
      ) {
        throw new RuntimeError(
          'OCR_REQUIRED',
          `PDF requires OCR (${classification.pdfType}; ${classification.pagesNeedingOcr.length} pages flagged)`,
          false,
          'document',
        );
      }
      const markdown = await toMarkdownBytes(input);
      return {
        markdown,
        metadata: {
          pdfType: classification.pdfType,
          pageCount: classification.pageCount,
          pagesNeedingOcr: classification.pagesNeedingOcr,
        },
        parser: 'anydoc+pdf-inspector',
        confidence: classification.confidence,
      };
    }
    const formatHint = extension === 'csv' ? formatFromExtension('csv') : undefined;
    const markdown = formatHint
      ? await toMarkdownBytes(input, formatHint)
      : await toMarkdownBytes(input);
    return { markdown, metadata: { extension }, parser: 'anydoc', confidence: 0.95 };
  }
}

export class PlainTextDocumentAdapter implements DocumentParser {
  supports(mime: string, extension: string): boolean {
    return (
      mime.startsWith('text/plain') ||
      ['txt', 'md', 'markdown'].includes(extension.replace(/^\./, '').toLowerCase())
    );
  }

  async parse(input: Buffer): Promise<DocumentParseResult> {
    return {
      markdown: input.toString('utf8'),
      metadata: {},
      parser: 'plain-text',
      confidence: 0.99,
    };
  }
}

export class HtmlDocumentAdapter implements DocumentParser {
  supports(mime: string, extension: string): boolean {
    return (
      mime.includes('html') || ['html', 'htm'].includes(extension.replace(/^\./, '').toLowerCase())
    );
  }

  async parse(input: Buffer): Promise<DocumentParseResult> {
    const markdown = new TurndownService({ headingStyle: 'atx' }).turndown(input.toString('utf8'));
    return { markdown, metadata: {}, parser: 'html-turndown', confidence: 0.95 };
  }
}

export class DocumentRouter {
  private readonly parsers: DocumentParser[];

  constructor(
    parsers: DocumentParser[] = [
      new PlainTextDocumentAdapter(),
      new HtmlDocumentAdapter(),
      new AnyDocAdapter(),
    ],
  ) {
    this.parsers = parsers;
  }

  async parse(
    input: Buffer,
    context: { mime: string; extension: string },
  ): Promise<DocumentParseResult> {
    const parser = this.parsers.find((candidate) =>
      candidate.supports(context.mime, context.extension),
    );
    if (!parser)
      throw new RuntimeError(
        'INVALID_INPUT',
        `Unsupported document type: ${context.mime} / ${context.extension}`,
        false,
        'document',
      );
    return parser.parse(input, context);
  }
}
