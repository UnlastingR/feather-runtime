import type { Engine } from '@feather/protocol';

export interface DomainPolicy {
  preferredEngine?: Engine;
  forceEngine?: Exclude<Engine, 'auto' | 'document' | 'ocr'>;
  allowHttp?: boolean;
  allowLightpanda?: boolean;
  allowChromium?: boolean;
  requiresChromium?: boolean;
}

export interface EngineHint {
  preferred: 'http' | 'lightpanda' | 'chromium';
  fallback?: 'http' | 'lightpanda' | 'chromium';
  confidence: number;
}

export interface EngineRouteInput {
  actionType: 'scrape' | 'browser' | 'document';
  requiresAuthentication: boolean;
  requiresPayment: boolean;
  destructive: boolean;
  preferredEngine: Engine;
  policy?: DomainPolicy;
  hint?: EngineHint;
}

export function routeEngine(
  input: EngineRouteInput,
): 'http' | 'document' | 'lightpanda' | 'chromium' {
  if (input.actionType === 'document') return 'document';
  if (input.policy?.forceEngine) return input.policy.forceEngine;
  if (
    input.requiresAuthentication ||
    input.requiresPayment ||
    input.destructive ||
    input.policy?.requiresChromium
  )
    return 'chromium';
  if (input.preferredEngine !== 'auto') {
    if (
      input.preferredEngine === 'http' ||
      input.preferredEngine === 'lightpanda' ||
      input.preferredEngine === 'chromium'
    )
      return input.preferredEngine;
  }
  if (input.hint && input.hint.confidence >= 0.9) {
    if (input.hint.preferred === 'http' && input.policy?.allowHttp !== false) return 'http';
    if (input.hint.preferred === 'lightpanda' && input.policy?.allowLightpanda !== false)
      return 'lightpanda';
    if (input.hint.preferred === 'chromium' && input.policy?.allowChromium !== false)
      return 'chromium';
  }
  if (input.policy?.preferredEngine === 'lightpanda' && input.policy.allowLightpanda !== false)
    return 'lightpanda';
  if (input.policy?.preferredEngine === 'chromium' && input.policy.allowChromium !== false)
    return 'chromium';
  return input.policy?.allowHttp === false ? 'lightpanda' : 'http';
}

export function fallbackAfter(
  engine: 'http' | 'lightpanda' | 'chromium',
  policy?: DomainPolicy,
): 'lightpanda' | 'chromium' | null {
  if (engine === 'http')
    return policy?.allowLightpanda === false
      ? policy?.allowChromium === false
        ? null
        : 'chromium'
      : 'lightpanda';
  if (engine === 'lightpanda') return policy?.allowChromium === false ? null : 'chromium';
  return null;
}
