'use strict';

/**
 * Email Drafting Studio Backend — RFC-5322 .eml generation + Fast/Smart AI refinements.
 */

const endpoint = require('./endpoint');
const storage = require('./storage');

function toEml(draft) {
  const date = new Date().toUTCString();
  const safe = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  const lines = [
    `Date: ${date}`,
    `To: ${safe(draft.to)}`,
  ];
  if (draft.cc) lines.push(`Cc: ${safe(draft.cc)}`);
  lines.push(
    `Subject: ${safe(draft.subject || '(No subject)')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'X-Unsent: 1',
    '',
    String(draft.body || '').replace(/\r?\n/g, '\r\n'),
  );
  return lines.join('\r\n');
}

const REFINE_PROMPTS = {
  shorter: 'Make this email significantly shorter, crisper, and punchier while keeping every key fact and call-to-action.',
  formal: 'Rewrite this email in a polished, executive, professional tone.',
  friendly: 'Rewrite this email in a warm, natural, friendly yet professional coworker tone.',
  direct: 'Rewrite this email to be direct, structured with bullet points if helpful, and crystal clear on next steps.',
  fix_grammar: 'Fix any grammar, spelling, clarity, or flow issues without changing the meaning or length unnecessarily.',
  translate_de: 'Translate this email naturally into idiomatic, professional German (keep Subject and Body clearly formatted).',
  translate_en: 'Translate this email naturally into idiomatic, professional English (keep Subject and Body clearly formatted).',
};

async function refineDraft({ draft, action = 'formal', customInstruction = '', tier = 'fast', signal }) {
  const instr = customInstruction
    ? String(customInstruction).trim()
    : (REFINE_PROMPTS[action] || REFINE_PROMPTS.formal);

  const sys = `You are an expert executive email writer. Return ONLY valid JSON with keys "subject" and "body" (no markdown fences, no commentary).`;
  const userMsg = `Instruction: ${instr}\n\nCurrent email:\nTo: ${draft.to || ''}\nSubject: ${draft.subject || ''}\nBody:\n${draft.body || ''}`;

  const res = await endpoint.chatCompletion({
    tier,
    systemPrompt: sys,
    messages: [{ role: 'user', content: userMsg }],
    think: 'off',
    priority: 'fast',
    signal,
  });

  const raw = res.content.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.body === 'string') {
        return {
          subject: typeof parsed.subject === 'string' ? parsed.subject : draft.subject,
          body: parsed.body,
          usage: res.usage,
          model: res.model,
        };
      }
    } catch {}
  }

  // Fallback if model returned plain text
  let subject = draft.subject || '';
  let body = raw;
  const subM = raw.match(/^Subject:\s*(.+)$/im);
  if (subM) {
    subject = subM[1].trim();
    body = raw.replace(/^Subject:.*\r?\n+/im, '').trim();
  }
  return { subject, body, usage: res.usage, model: res.model };
}

function appendSignature(body) {
  const sig = (storage.getSettings().emailSignature || '').trim();
  if (!sig) return body;
  if (body.includes(sig)) return body;
  return `${body.trimEnd()}\n\n${sig}`;
}

module.exports = {
  toEml,
  refineDraft,
  appendSignature,
};
