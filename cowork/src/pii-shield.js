'use strict';

/**
 * Local Reversible Privacy / PII Redaction Shield for mx-Cowork
 *
 * Masks sensitive corporate & personal data locally BEFORE prompts leave the machine
 * (especially useful when using OpenAI, Anthropic, OpenRouter, or external cloud APIs),
 * then restores the original values seamlessly in the displayed response!
 */

const BUILTIN_PATTERNS = [
  {
    label: 'SECRET',
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[0-9A-Za-z-]{16,})\b/g,
  },
  {
    label: 'EMAIL',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    label: 'IBAN',
    re: /\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]{4}){3,7}(?:[\s-]?[A-Z0-9]{1,4})?\b/g,
  },
  {
    label: 'CARD',
    re: /\b(?:\d{4}[\s-]){3}\d{4}\b/g,
  },
  {
    label: 'SSN',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    label: 'PHONE',
    re: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,5}\)[\s.-]?|\b0\d{2,4}[\s./-])\d{3,4}[\s.-]?\d{3,5}\b/g,
  },
  {
    label: 'IP',
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createShieldContext(customTerms = []) {
  const valueToToken = new Map();
  const tokenToValue = new Map();
  const counters = {};

  const parsedCustom = (Array.isArray(customTerms) ? customTerms : String(customTerms || '').split(/[\n,;]+/))
    .map((x) => String(x || '').trim())
    .filter((x) => x.length >= 2)
    .sort((a, b) => b.length - a.length);

  const allocToken = (label, raw) => {
    const key = `${label}::${raw}`;
    if (valueToToken.has(key)) return valueToToken.get(key);
    counters[label] = (counters[label] || 0) + 1;
    const tok = `[${label}_${counters[label]}]`;
    valueToToken.set(key, tok);
    tokenToValue.set(tok, raw);
    return tok;
  };

  function redact(text) {
    let out = String(text ?? '');
    if (!out) return out;

    // 1. Custom confidential company/client/project terms first (case-insensitive)
    for (const term of parsedCustom) {
      const re = new RegExp(escapeRegex(term), 'gi');
      out = out.replace(re, (match) => allocToken('CONFIDENTIAL', match));
    }

    // 2. Built-in PII & secret patterns
    for (const { label, re } of BUILTIN_PATTERNS) {
      out = out.replace(re, (match) => {
        // Avoid redacting localhost or version-like strings as IPs
        if (label === 'IP' && (match === '127.0.0.1' || match === '0.0.0.0')) return match;
        return allocToken(label, match);
      });
    }
    return out;
  }

  function restore(text) {
    let out = String(text ?? '');
    if (!out || tokenToValue.size === 0) return out;
    for (const [tok, orig] of tokenToValue.entries()) {
      out = out.split(tok).join(orig);
    }
    return out;
  }

  function summary() {
    const total = tokenToValue.size;
    return {
      total,
      counts: { ...counters },
    };
  }

  return { redact, restore, summary };
}

module.exports = {
  createShieldContext,
};
