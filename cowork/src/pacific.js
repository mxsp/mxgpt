'use strict';

/**
 * Pacific Council — Multi-Agent Debate & Weighted Voting Engine for mx-Cowork
 *
 * Convenes up to 6 arguing specialist agents (1 vote each) + 1 Pacific Chief (3 votes):
 *   Phase 1: Parallel specialist proposals & trade-off analysis
 *   Phase 2: Cross-examination & specialist voting (1 vote each)
 *   Phase 3: Chief review, 3-vote weighted ballot, deterministic tally & winning execution mandate
 *   Phase 4: Hand-off to long-horizon closed-loop execution (runAgenticToolLoop)
 */

const endpoint = require('./endpoint');
const storage = require('./storage');

const CHIEF_VOTE_WEIGHT = 3;
const MAX_ARGUING_AGENTS = 6;

const PACIFIC_ROLES = [
  {
    id: 'architect',
    name: 'Systems Architect',
    badge: 'ARCH',
    stance: 'Prioritize clean modular architecture, maintainable boundaries, and clear data models.',
  },
  {
    id: 'engineer',
    name: 'Implementation Engineer',
    badge: 'ENG',
    stance: 'Prioritize pragmatic, fast, clean code using installed tools/libraries with zero over-engineering.',
  },
  {
    id: 'qa',
    name: 'QA & Security Reviewer',
    badge: 'QA',
    stance: 'Hunt for edge cases, security flaws, broken assumptions, and insist on concrete automated verification.',
  },
  {
    id: 'domain',
    name: 'Office & Data Specialist',
    badge: 'DATA',
    stance: 'Focus on Excel formulas, multi-sheet structure, Word/PPTX deliverables, UX clarity, and data integrity.',
  },
  {
    id: 'devops',
    name: 'DevOps & Reliability Lead',
    badge: 'OPS',
    stance: 'Ensure dependencies, .venv/containers, ports, cross-platform Windows/Linux portability, and error recovery.',
  },
  {
    id: 'critic',
    name: "Devil's Advocate",
    badge: 'CRITIC',
    stance: 'Challenge consensus, expose hidden risks or simpler alternatives, and stress-test every proposal.',
  },
];

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  return null;
}

function selectCouncilAgents(prompt, maxAgents = MAX_ARGUING_AGENTS) {
  const cap = Math.max(2, Math.min(MAX_ARGUING_AGENTS, Number(maxAgents) || MAX_ARGUING_AGENTS));
  const txt = String(prompt || '').trim();
  // Always convene up to 6 agents for complex tasks; for shorter focused asks, still pick 4-6 relevant roles
  if (txt.length >= 90 || /\b(complex|architecture|full[- ]?stack|system|bom|sbom|supply chain|refactor|migrate|multi|excel|flask|dashboard|production)\b/i.test(txt)) {
    return PACIFIC_ROLES.slice(0, cap);
  }
  return PACIFIC_ROLES.slice(0, Math.min(4, cap));
}

function tallyPacificVotes(proposals = [], votes = []) {
  const validIds = new Set(proposals.map((p) => p.id));
  const fallbackId = proposals[0]?.id || 'architect';
  const buckets = new Map();
  for (const p of proposals) {
    buckets.set(p.id, {
      id: p.id,
      name: p.name,
      optionTitle: p.optionTitle || p.name,
      votes: 0,
      voters: [],
    });
  }

  for (const v of votes || []) {
    const target = validIds.has(v.voteFor) ? v.voteFor : fallbackId;
    const weight = Math.max(1, Number(v.weight) || 1);
    const b = buckets.get(target);
    if (b) {
      b.votes += weight;
      b.voters.push({
        voterId: v.voterId,
        voterName: v.voterName,
        weight,
        isChief: Boolean(v.isChief),
        rationale: String(v.rationale || '').slice(0, 180),
      });
    }
  }

  const ranked = [...buckets.values()].sort((a, b) => {
    if (b.votes !== a.votes) return b.votes - a.votes;
    const aHasChief = a.voters.some((x) => x.isChief) ? 1 : 0;
    const bHasChief = b.voters.some((x) => x.isChief) ? 1 : 0;
    return bHasChief - aHasChief;
  });

  const totalVotes = ranked.reduce((acc, r) => acc + r.votes, 0);
  return {
    winner: ranked[0] || null,
    ranked,
    totalVotes,
    chiefWeight: CHIEF_VOTE_WEIGHT,
  };
}

async function runPacificCouncil({
  prompt,
  workspace,
  blueprint = '',
  activeViewContextBlock = '',
  chiefModel,
  workerModel,
  maxAgents = MAX_ARGUING_AGENTS,
  chatId = '',
  chatTitle = '',
  mask = (s) => s,
  unmask = (s) => s,
  signal,
  onEvent,
}) {
  const startedAt = Date.now();
  const agents = selectCouncilAgents(prompt, maxAgents);
  const state = {
    phase: 'proposals',
    chiefWeight: CHIEF_VOTE_WEIGHT,
    agentCount: agents.length,
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      badge: a.badge,
      status: 'thinking',
      optionTitle: '',
      proposal: '',
      critique: '',
      voteFor: '',
      weight: 1,
    })),
    chief: {
      name: 'Pacific Chief',
      weight: CHIEF_VOTE_WEIGHT,
      status: 'waiting',
      voteFor: '',
      rationale: '',
      mergedPlan: '',
    },
    tally: null,
    elapsedMs: 0,
  };

  const emitState = () => {
    state.elapsedMs = Date.now() - startedAt;
    onEvent?.('pacific_state', JSON.parse(JSON.stringify(state)));
  };

  onEvent?.('phase', { phase: 'planning', label: `Pacific Council (${agents.length} agents + Chief ×3) debating…` });
  emitState();

  const sharedContext = [
    `Workspace: ${workspace}`,
    blueprint ? `[Project Blueprint]\n${blueprint.slice(0, 2600)}` : '',
    activeViewContextBlock ? activeViewContextBlock.slice(0, 2400) : '',
    `[User Task]\n${prompt}`,
  ].filter(Boolean).join('\n\n');

  // ---- Phase 1: Parallel specialist proposals
  const proposals = await Promise.all(
    agents.map(async (agent) => {
      if (signal?.aborted) {
        return { id: agent.id, name: agent.name, optionTitle: agent.name, proposal: 'Aborted', keySteps: [], mainRisk: '' };
      }
      const sys = `You are "${agent.name}" on the Pacific Engineering & Office Council (1 of ${agents.length} arguing specialists; Chief holds 3 votes).
Stance: ${agent.stance}
Return ONLY valid JSON:
{
  "optionTitle": "3-6 word name for your proposed approach",
  "proposal": "2-3 crisp sentences arguing for your concrete plan",
  "keySteps": ["step 1", "step 2", "step 3"],
  "mainRisk": "1 sentence on the biggest risk to watch"
}`;
      try {
        const res = await endpoint.chatCompletion({
          tier: 'fast',
          model: workerModel,
          systemPrompt: sys,
          messages: [{ role: 'user', content: mask(sharedContext) }],
          think: 'off',
          priority: 'subagent',
          signal,
        });
        storage.recordUsage({
          chatId,
          chatTitle,
          model: res.model || workerModel,
          role: 'worker',
          tier: 'fast',
          promptTokens: res.usage?.promptTokens || Math.round(sharedContext.length / 4),
          evalTokens: res.usage?.evalTokens || Math.round((res.content || '').length / 4),
          elapsedMs: res.elapsedMs || 0,
          tokensPerSec: res.usage?.tokensPerSec || 0,
        });
        const clean = unmask(res.content || '');
        const parsed = extractJson(clean) || {};
        const item = {
          id: agent.id,
          name: agent.name,
          optionTitle: String(parsed.optionTitle || `${agent.name} Plan`).slice(0, 60),
          proposal: String(parsed.proposal || clean.slice(0, 320)).slice(0, 420),
          keySteps: Array.isArray(parsed.keySteps) ? parsed.keySteps.map((s) => String(s)).slice(0, 5) : [],
          mainRisk: String(parsed.mainRisk || '').slice(0, 200),
        };
        const stAgent = state.agents.find((x) => x.id === agent.id);
        if (stAgent) {
          stAgent.status = 'proposed';
          stAgent.optionTitle = item.optionTitle;
          stAgent.proposal = item.proposal;
        }
        emitState();
        return item;
      } catch (err) {
        const stAgent = state.agents.find((x) => x.id === agent.id);
        if (stAgent) {
          stAgent.status = 'error';
          stAgent.proposal = `Error: ${err.message}`;
        }
        emitState();
        return {
          id: agent.id,
          name: agent.name,
          optionTitle: `${agent.name} Plan`,
          proposal: `Proposal unavailable (${err.message})`,
          keySteps: [],
          mainRisk: '',
        };
      }
    })
  );

  if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

  // ---- Phase 2: Debate & Specialist Voting (1 vote each)
  state.phase = 'voting';
  onEvent?.('phase', { phase: 'delegating', label: `Pacific Council cross-examining & voting (${agents.length} × 1 vote + Chief × 3)…` });
  emitState();

  const proposalsDigest = proposals.map((p) =>
    `- Option [${p.id}] "${p.optionTitle}" (${p.name}): ${p.proposal}${p.keySteps.length ? ` Steps: ${p.keySteps.join(' -> ')}` : ''}${p.mainRisk ? ` Risk: ${p.mainRisk}` : ''}`
  ).join('\n');

  const validOptionIds = proposals.map((p) => p.id);

  const specialistVotes = await Promise.all(
    agents.map(async (agent) => {
      if (signal?.aborted) {
        return { voterId: agent.id, voterName: agent.name, weight: 1, isChief: false, voteFor: validOptionIds[0], rationale: 'Aborted' };
      }
      const sys = `You are "${agent.name}" voting in the Pacific Council (your vote weight = 1; Chief holds 3 votes).
Critique the weakest point in another proposal, then vote for the single strongest option ID from: ${validOptionIds.join(', ')}.
Return ONLY valid JSON:
{
  "critique": "1 sharp sentence challenging a flaw or blind spot in the debate",
  "voteFor": "<one of: ${validOptionIds.join(' | ')}>",
  "rationale": "1 sentence explaining your vote"
}`;
      try {
        const res = await endpoint.chatCompletion({
          tier: 'fast',
          model: workerModel,
          systemPrompt: sys,
          messages: [{ role: 'user', content: mask(`Task: ${prompt}\n\nProposals:\n${proposalsDigest}`) }],
          think: 'off',
          priority: 'subagent',
          signal,
        });
        const parsed = extractJson(unmask(res.content || '')) || {};
        const pick = validOptionIds.includes(parsed.voteFor) ? parsed.voteFor : agent.id;
        const vote = {
          voterId: agent.id,
          voterName: agent.name,
          weight: 1,
          isChief: false,
          voteFor: pick,
          critique: String(parsed.critique || '').slice(0, 220),
          rationale: String(parsed.rationale || '').slice(0, 180),
        };
        const stAgent = state.agents.find((x) => x.id === agent.id);
        if (stAgent) {
          stAgent.status = 'voted';
          stAgent.critique = vote.critique;
          stAgent.voteFor = vote.voteFor;
        }
        emitState();
        return vote;
      } catch {
        const stAgent = state.agents.find((x) => x.id === agent.id);
        if (stAgent) { stAgent.status = 'voted'; stAgent.voteFor = agent.id; }
        emitState();
        return { voterId: agent.id, voterName: agent.name, weight: 1, isChief: false, voteFor: agent.id, critique: '', rationale: 'Backed own proposal' };
      }
    })
  );

  if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

  // ---- Phase 3: Pacific Chief casts 3 weighted votes & synthesizes winning execution mandate
  state.chief.status = 'deciding';
  onEvent?.('phase', { phase: 'synthesizing', label: 'Pacific Chief casting 3 votes & finalizing execution plan…' });
  emitState();

  const debateDigest = specialistVotes.map((v) =>
    `- ${v.voterName} (1 vote → [${v.voteFor}]): ${v.critique ? `Critique: ${v.critique} | ` : ''}${v.rationale}`
  ).join('\n');

  const chiefSys = `You are the Pacific Chief — final decision maker on the Pacific Council.
Each specialist has 1 vote; YOU hold ${CHIEF_VOTE_WEIGHT} votes.
Review all proposals and critiques, cast your ${CHIEF_VOTE_WEIGHT} votes for the best option ID (${validOptionIds.join(', ')}), and synthesize one unified, battle-tested execution plan that incorporates the strongest critiques.
Return ONLY valid JSON:
{
  "voteFor": "<one of: ${validOptionIds.join(' | ')}>",
  "rationale": "1-2 sentences explaining why your 3 votes back this approach",
  "mergedPlan": "Concise numbered execution plan (4-8 concrete steps with verification criteria)",
  "risksToAvoid": ["risk 1", "risk 2"]
}`;

  let chiefVote = {
    voterId: 'chief',
    voterName: 'Pacific Chief',
    weight: CHIEF_VOTE_WEIGHT,
    isChief: true,
    voteFor: validOptionIds[0],
    rationale: 'Selected strongest balanced approach.',
    mergedPlan: proposals[0]?.proposal || prompt,
    risksToAvoid: [],
  };

  try {
    const chiefRes = await endpoint.chatCompletion({
      tier: 'smart',
      model: chiefModel,
      systemPrompt: chiefSys,
      messages: [{ role: 'user', content: mask(`Task: ${prompt}\n\nProposals:\n${proposalsDigest}\n\nDebate & Specialist Votes:\n${debateDigest}`) }],
      think: 'off',
      priority: 'smart',
      signal,
    });
    const parsed = extractJson(unmask(chiefRes.content || '')) || {};
    chiefVote = {
      voterId: 'chief',
      voterName: 'Pacific Chief',
      weight: CHIEF_VOTE_WEIGHT,
      isChief: true,
      voteFor: validOptionIds.includes(parsed.voteFor) ? parsed.voteFor : validOptionIds[0],
      rationale: String(parsed.rationale || 'Backed strongest architecture & verification plan.').slice(0, 320),
      mergedPlan: String(parsed.mergedPlan || proposals[0]?.proposal || '').slice(0, 1800),
      risksToAvoid: Array.isArray(parsed.risksToAvoid) ? parsed.risksToAvoid.map((r) => String(r)).slice(0, 5) : [],
    };
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  const allVotes = [...specialistVotes, chiefVote];
  const tally = tallyPacificVotes(proposals, allVotes);

  state.phase = 'executing';
  state.chief = {
    name: 'Pacific Chief',
    weight: CHIEF_VOTE_WEIGHT,
    status: 'decided',
    voteFor: chiefVote.voteFor,
    rationale: chiefVote.rationale,
    mergedPlan: chiefVote.mergedPlan,
  };
  state.tally = tally;
  emitState();

  const winningProposal = proposals.find((p) => p.id === tally.winner?.id) || proposals[0];
  const winningPlanPrompt = [
    `[Pacific Council Decision — ${tally.winner?.optionTitle || 'Winning Plan'} won with ${tally.winner?.votes || 0}/${tally.totalVotes} weighted votes (Chief ×${CHIEF_VOTE_WEIGHT} + ${agents.length} specialists ×1)]`,
    `Chief Rationale: ${chiefVote.rationale}`,
    `Winning Approach (${winningProposal?.name || ''}): ${winningProposal?.proposal || ''}`,
    chiefVote.mergedPlan ? `Merged Execution Plan:\n${chiefVote.mergedPlan}` : '',
    chiefVote.risksToAvoid?.length ? `Key Risks to Avoid:\n- ${chiefVote.risksToAvoid.join('\n- ')}` : '',
    `Now execute this winning plan end-to-end using your tools until every deliverable is created, tested, and verified.`,
  ].filter(Boolean).join('\n\n');

  return {
    council: JSON.parse(JSON.stringify(state)),
    proposals,
    votes: allVotes,
    tally,
    winningPlanPrompt,
  };
}

module.exports = {
  PACIFIC_ROLES,
  CHIEF_VOTE_WEIGHT,
  MAX_ARGUING_AGENTS,
  selectCouncilAgents,
  tallyPacificVotes,
  runPacificCouncil,
};
