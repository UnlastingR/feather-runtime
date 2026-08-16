import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { scoreExtraction, type ConfidenceResult } from './confidence.js';

export interface ExtractedPage {
  title: string;
  text: string;
  markdown: string;
  confidence: ConfidenceResult;
  selectorMatches: number;
}

const antiBotPatterns = [
  /captcha/i,
  /verify (?:you are|that you are) human/i,
  /cloudflare.*challenge/i,
  /attention required/i,
  /access denied/i,
];
const jsRequiredPatterns = [
  /enable javascript/i,
  /javascript is required/i,
  /requires javascript/i,
];

export function extractHtml(
  html: string,
  options: { statusCode?: number; contentType?: string; selectors?: string[] } = {},
): ExtractedPage {
  const { document } = parseHTML(html);
  const title = document.title ?? '';
  const selectorMatches = (options.selectors ?? []).filter((selector) => {
    try {
      return document.querySelector(selector) !== null;
    } catch {
      return false;
    }
  }).length;

  const article = new Readability(document).parse();
  const mainHtml = article?.content ?? document.body?.innerHTML ?? '';
  const text = (article?.textContent ?? document.body?.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const bodyMarkdown = turndown.turndown(mainHtml).trim();
  const readableTitle = (article?.title ?? title).trim();
  const markdown =
    readableTitle && !/^#{1,6}\s/m.test(bodyMarkdown)
      ? `# ${readableTitle}\n\n${bodyMarkdown}`.trim()
      : bodyMarkdown;
  const antiBotMarkers = antiBotPatterns.filter((pattern) => pattern.test(html)).length;
  const jsRequiredMarkers = jsRequiredPatterns.filter((pattern) => pattern.test(html)).length;
  const confidence = scoreExtraction({
    ...(options.statusCode !== undefined ? { statusCode: options.statusCode } : {}),
    ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
    bodySize: Buffer.byteLength(html),
    title,
    textLength: text.length,
    mainContentLength: markdown.length,
    targetSelectorsFound: selectorMatches,
    targetSelectorsExpected: options.selectors?.length ?? 0,
    antiBotMarkers,
    jsRequiredMarkers,
  });

  return { title, text, markdown, confidence, selectorMatches };
}
