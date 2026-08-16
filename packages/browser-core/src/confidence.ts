export interface ConfidenceSignals {
  statusCode?: number;
  contentType?: string;
  bodySize?: number;
  title?: string;
  textLength?: number;
  mainContentLength?: number;
  targetSelectorsFound?: number;
  targetSelectorsExpected?: number;
  antiBotMarkers?: number;
  jsRequiredMarkers?: number;
  jsExceptions?: number;
  networkFailures?: number;
  loginRedirect?: boolean;
}

export interface ConfidenceResult {
  score: number;
  reasons: string[];
}

export function scoreExtraction(signals: ConfidenceSignals): ConfidenceResult {
  let score = 0.5;
  const reasons: string[] = [];

  if (signals.statusCode !== undefined) {
    if (signals.statusCode >= 200 && signals.statusCode < 300) {
      score += 0.12;
      reasons.push('status-ok');
    } else if (signals.statusCode >= 400) {
      score -= 0.35;
      reasons.push('status-error');
    }
  }

  if (signals.contentType?.includes('text/html')) score += 0.05;
  if ((signals.bodySize ?? 0) >= 512) score += 0.05;
  if ((signals.title?.trim().length ?? 0) >= 3) {
    score += 0.04;
    reasons.push('title-present');
  }
  if ((signals.textLength ?? 0) >= 400) {
    score += 0.12;
    reasons.push('text-length-ok');
  } else if ((signals.textLength ?? 0) < 80) {
    score -= 0.18;
    reasons.push('text-too-short');
  }
  if ((signals.mainContentLength ?? 0) >= 250) {
    score += 0.1;
    reasons.push('main-content-present');
  }

  const expected = signals.targetSelectorsExpected ?? 0;
  if (expected > 0) {
    const ratio = Math.min(1, (signals.targetSelectorsFound ?? 0) / expected);
    score += 0.22 * ratio;
    score -= 0.18 * (1 - ratio);
    reasons.push(ratio === 1 ? 'target-selectors-present' : 'target-selectors-missing');
  }

  const antiBot = signals.antiBotMarkers ?? 0;
  if (antiBot > 0) {
    score -= Math.min(0.5, antiBot * 0.2);
    reasons.push('anti-bot-marker');
  }
  const jsRequired = signals.jsRequiredMarkers ?? 0;
  if (jsRequired > 0) {
    score -= Math.min(0.35, jsRequired * 0.12);
    reasons.push('js-required-marker');
  }
  const jsExceptions = signals.jsExceptions ?? 0;
  if (jsExceptions > 0) {
    score -= Math.min(0.3, jsExceptions * 0.08);
    reasons.push('js-exceptions');
  }
  const networkFailures = signals.networkFailures ?? 0;
  if (networkFailures > 0) {
    score -= Math.min(0.2, networkFailures * 0.04);
    reasons.push('network-failures');
  }
  if (signals.loginRedirect) {
    score -= 0.3;
    reasons.push('login-redirect');
  }

  return { score: Math.max(0, Math.min(1, Number(score.toFixed(3)))), reasons };
}
