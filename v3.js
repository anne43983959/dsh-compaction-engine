// v3 helpers: full-context anchors, evidence pointers, Temporal Facts instruction,
// language detection, and a bounded Evidence Index. Pure functions only.

const BASE_HEAD = [
  'You are now acting as a compaction engine for this AI coding assistant. ',
  'Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. ',
  'Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
].join('\n');

const BASE_RULES = [
  'Rules:',
  '- __LANGUAGE__',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a checkpoint block, it is a PRIOR checkpoint. ',
  '  Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n');

const EXTRA_RULES = [
  '',
  'Additional v3 rules:',
  '- Add one more section after Critical Context:',
  '  ## Temporal Facts',
  '  - <fact>: latest value (seq=N, turn=T; kind=state|requirement; evidence="<short quote>").',
  '    superseded: <old value> (seq=M, turn=U).',
  '- Keep the concrete conversation and the user\'s own wording as the main body. Treat Temporal Facts as a thin index, not a second narrative.',
  '- Use kind=requirement for a user instruction and kind=state for a confirmed result. A short quote from the cited event is enough; if no source is available, write (source=unverified).',
].join('\n');

export function languageRule(language) {
  return language === 'zh'
    ? '用中文写 checkpoint（用户语言）；路径、命令、错误串、标识符、数字和逐字用户引文保留原文，不翻译。'
    : 'Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.';
}

export function buildPtcInstruction({ language = 'en', anchors = '', pointers = '', styleContract = '', hotPrompt = '' } = {}) {
  const parts = [BASE_HEAD, '', BASE_RULES.replace('__LANGUAGE__', languageRule(language))];
  if (styleContract.length > 0) parts.push('', styleContract);
  parts.push(EXTRA_RULES);
  parts.push('', '## Global View Boundary');
  parts.push('- The input contains the historical region to summarize, followed by a RETAINED CURRENT TAIL.');
  parts.push('- Summarize only the historical region; never summarize, quote, or copy the retained tail into the checkpoint or Temporal Facts.');
  parts.push('- Use the retained tail only to recognize completed work and to avoid claiming that a completed historical action is still pending.');
  parts.push('- Source seqs for historical facts must point to historical events; tail seqs are not history.');
  parts.push('', '## Timeline Anchors', anchors.length > 0 ? anchors : '- (none)');
  parts.push('', '## Evidence Pointers', pointers.length > 0 ? pointers : '- (none)');
  const hot = String(hotPrompt ?? '').trim();
  if (hot.length > 0) parts.push('', '## Hot-loaded Prompt Guidance', hot);
  return parts.join('\n');
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

function textOfMessage(message) {
  return textOfContent(message?.content);
}

// Map the exact message objects the base engine derived to their session seq.
// The base buildSummarizationInput passes the same object references, so a
// WeakMap is enough; tool messages also have a toolCallId fallback.
export function buildMessageIndex(session) {
  const index = new WeakMap();
  const byId = new Map();
  const total = Number(session?.seq ?? 0);
  for (let seq = 0; seq < total; seq += 1) {
    const event = session?.eventAt?.(seq);
    if (event === undefined) continue;
    let message;
    if (event.type === 'user/message') message = event.data;
    else if (event.type === 'system/message' || event.type === 'developer/message' || event.type === 'assistant/message' || event.type === 'tool/result') message = event.data?.message;
    if (message !== null && typeof message === 'object') {
      const meta = { seq, turn: event.data?.turn, step: event.data?.step, type: event.type };
      index.set(message, meta);
      if (typeof message.id === 'string' || typeof message.id === 'number') byId.set(message.id, meta);
    }
  }
  index.byId = byId;
  return index;
}

export function selectAnchorEntries(input, messageIndex, toolResults) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const users = [];
  const tools = [];
  const assistants = [];
  for (const message of messages) {
    let meta = messageIndex?.get?.(message);
    if (meta === undefined && message?.id !== undefined) meta = messageIndex?.byId?.get?.(message.id);
    let seq = meta?.seq;
    if (!Number.isInteger(seq) && message?.role === 'tool') {
      const result = toolResults?.get?.(message?.toolCallId);
      if (result !== undefined) {
        seq = result.seq;
        meta = { seq, turn: undefined, step: undefined, type: 'tool/result' };
      }
    }
    if (!Number.isInteger(seq)) continue;
    if (message?.role === 'user') {
      if (message?.source?.kind !== 'user') continue;
      const text = textOfMessage(message).trim();
      if (text.length === 0) continue;
      users.push({ seq, kind: 'user', turn: meta.turn, step: meta.step, text: text.slice(0, 1200) });
      continue;
    }
    if (message?.role === 'tool') {
      const result = toolResults?.get?.(message?.toolCallId);
      const text = result?.text ?? textOfMessage(message);
      if (text.length <= 2000) continue;
      tools.push({
        seq,
        kind: 'tool',
        turn: meta.turn,
        step: meta.step,
        tool: result?.tool ?? 'tool',
        status: result?.isError === true ? 'error' : 'ok',
        chars: text.length,
      });
      continue;
    }
    if (message?.role === 'assistant') {
      const text = textOfMessage(message).trim();
      if (text.length === 0) continue;
      assistants.push({ seq, kind: 'assistant', turn: meta.turn, step: meta.step });
    }
  }
  const entries = [...users.slice(-12), ...tools, ...assistants.slice(-6)];
  entries.sort((left, right) => left.seq - right.seq);
  return entries;
}

export function renderAnchors(entries) {
  return entries.map(entry => {
    const head = '- seq=' + entry.seq
      + (entry.turn === undefined ? '' : ' turn=' + entry.turn)
      + (entry.step === undefined ? '' : ' step=' + entry.step)
      + ' kind=' + entry.kind;
    if (entry.kind === 'user') return head + ': ' + entry.text;
    if (entry.kind === 'tool') return head + ' tool=' + entry.tool + ' status=' + entry.status + ' chars=' + entry.chars;
    return head;
  }).join('\n');
}

export function renderPointers(entries) {
  return entries.map(entry => {
    const head = '- seq=' + entry.seq
      + (entry.turn === undefined ? '' : ' turn=' + entry.turn)
      + (entry.step === undefined ? '' : ' step=' + entry.step)
      + ' kind=' + entry.kind;
    const read = ' read=memory_read(seq=' + entry.seq + ')';
    if (entry.kind === 'tool') return head + ' tool=' + entry.tool + ' status=' + entry.status + ' chars=' + entry.chars + read;
    return head + read;
  }).join('\n');
}

export function extractCitedSeqs(text) {
  const found = new Set();
  const pattern = /(?:memory_read\(seq=|READ seq=|\(seq=)(\d+)/g;
  for (const match of String(text ?? '').matchAll(pattern)) {
    const seq = Number(match[1]);
    if (Number.isSafeInteger(seq)) found.add(seq);
  }
  return found;
}

export function buildEvidenceIndex(entries, summaryText, inputTokens, options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 12;
  const hardCap = Number.isInteger(options.hardCap) ? options.hardCap : 1500;
  const ratio = typeof options.ratio === 'number' ? options.ratio : 0.15;
  const minimumInputTokens = Number.isInteger(options.minimumInputTokens) ? options.minimumInputTokens : 20000;
  if (!Number.isInteger(inputTokens) || inputTokens < minimumInputTokens) return '';
  const tools = (Array.isArray(entries) ? entries : []).filter(entry => entry.kind === 'tool');
  if (tools.length === 0) return '';
  const cited = extractCitedSeqs(summaryText);
  const candidates = tools
    .filter(entry => !cited.has(entry.seq))
    .sort((left, right) => right.seq - left.seq);
  if (candidates.length === 0) return '';
  const budget = Math.min(hardCap, Math.max(600, Math.floor(String(summaryText ?? '').length * ratio)));
  const entryLines = candidates.map(entry => '- seq=' + entry.seq + ' tool=' + entry.tool + ' status=' + entry.status + ' chars=' + entry.chars + ' read=memory_read(seq=' + entry.seq + ')');
  const render = (shown) => {
    const omitted = tools.length - shown;
    const lines = [
      '## Evidence Index',
      '- eligible: ' + tools.length + ' tool results >=2000 chars; showing ' + shown,
      ...entryLines.slice(0, shown),
    ];
    if (omitted > 0) lines.push('- omitted: ' + omitted + ' more; full set remains in the session log');
    return lines.join('\n');
  };
  let shown = Math.min(entryLines.length, maxEntries);
  if (shown <= 0) return '';
  let text = render(shown);
  while (shown > 0 && text.length > budget) {
    shown -= 1;
    text = shown > 0 ? render(shown) : '';
  }
  return shown > 0 && text.length > 0 ? text : '';
}

function messageFromEvent(event) {
  if (event?.type === 'user/message') return event.data;
  if (event?.type === 'system/message' || event?.type === 'developer/message' || event?.type === 'assistant/message' || event?.type === 'tool/result') return event.data?.message;
  return undefined;
}

function isoTime(time) {
  if (!Number.isFinite(time)) return '';
  try { return new Date(time).toISOString(); } catch { return ''; }
}

export function collectRetainedTail(session, input, messageIndex) {
  const seqs = [];
  for (const message of Array.isArray(input?.messages) ? input.messages : []) {
    const meta = messageIndex?.get?.(message);
    if (Number.isInteger(meta?.seq)) seqs.push(meta.seq);
  }
  const asOfSeq = seqs.length === 0 ? -1 : Math.max(...seqs);
  const entries = [];
  const markers = [];
  if (asOfSeq >= 0) {
    const total = Number(session?.seq ?? 0);
    for (let seq = asOfSeq + 1; seq < total; seq += 1) {
      const event = session?.eventAt?.(seq);
      if (event === undefined) continue;
      if (event.type === 'turn/end') {
        markers.push({ seq, turn: event.data?.turn, reason: event.data?.reason?.kind, time: event.time });
        continue;
      }
      const message = messageFromEvent(event);
      if (message === undefined || message === null || typeof message !== 'object') continue;
      entries.push({
        seq,
        type: event.type,
        message,
        role: message.role,
        turn: event.data?.turn,
        step: event.data?.step,
        time: event.time,
      });
    }
  }
  const lastAssistant = [...entries].reverse().find(entry => entry.role === 'assistant');
  const lastUser = [...entries].reverse().find(entry => entry.role === 'user');
  const lastTurnEnd = markers.length === 0 ? undefined : markers[markers.length - 1];
  return {
    asOfSeq,
    entries,
    messages: entries.map(entry => entry.message),
    lastAssistant,
    lastUser,
    lastTurnEnd,
    lastTailSeq: entries.length === 0 ? asOfSeq : entries[entries.length - 1].seq,
  };
}

export function collectCurrentContext(session, input) {
  if (typeof session?.deriveMessages === 'function') {
    try {
      const messages = session.deriveMessages();
      if (Array.isArray(messages) && messages.length > 0) {
        return { messages, fromSession: true };
      }
    } catch {
      // Fall back to the base summarization input.
    }
  }
  return { messages: Array.isArray(input?.messages) ? input.messages : [], fromSession: false };
}

export function renderCurrentContextBoundary(retained) {
  return [
    'CURRENT CONTEXT — SUMMARIZE HISTORY ONLY',
    'The historical region ends at seq=' + retained.asOfSeq + '.',
    'Messages after that cutoff are unshadowed current context; use them only to understand the current state.',
    'If an earlier checkpoint summary is present, re-summarize it as needed; keep facts and instructions that matter to the current work, and discard unrelated older detail.',
    'Do not invent facts, do not promote current-tail state into the historical checkpoint, and do not copy the current tail.',
    'The final answer is a historical checkpoint; the unshadowed tail remains outside it.',
  ].join('\n');
}

export function renderRetainedTailBoundary(retained) {
  return [
    'RETAINED CURRENT TAIL — NOT PART OF THE HISTORICAL REGION',
    'The historical region you must summarize ends at seq=' + retained.asOfSeq + '.',
    'The following messages are the latest unshadowed turns; they are already in the live context.',
    'Do not summarize, quote, or add them to the checkpoint. Use them only to recognize completed work and avoid contradictory current-state claims.',
    'If the tail shows a final answer or turn completion, treat historical pending actions as historical; do not claim they are still pending.',
  ].join('\n');
}

export function renderRetainedTailState(retained) {
  const lines = [
    'RETAINED TAIL STATE (authoritative, not history)',
    '- historical cutoff: seq=' + retained.asOfSeq,
    '- last tail message: seq=' + retained.lastTailSeq,
  ];
  if (retained.lastAssistant !== undefined) {
    lines.push('- last assistant: seq=' + retained.lastAssistant.seq
      + (retained.lastAssistant.turn === undefined ? '' : ' turn=' + retained.lastAssistant.turn)
      + (retained.lastAssistant.time === undefined ? '' : ' time=' + isoTime(retained.lastAssistant.time)));
  }
  if (retained.lastUser !== undefined) {
    lines.push('- last user: seq=' + retained.lastUser.seq
      + (retained.lastUser.turn === undefined ? '' : ' turn=' + retained.lastUser.turn));
  }
  if (retained.lastTurnEnd !== undefined) {
    lines.push('- last turn/end: seq=' + retained.lastTurnEnd.seq
      + (retained.lastTurnEnd.turn === undefined ? '' : ' turn=' + retained.lastTurnEnd.turn)
      + (retained.lastTurnEnd.reason === undefined ? '' : ' reason=' + retained.lastTurnEnd.reason));
  }
  lines.push('- The tail is current context; do not copy it into Temporal Facts or the historical checkpoint.');
  return lines.join('\n');
}

function normalizeEvidence(value) {
  return String(value ?? '').normalize('NFKC').replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/\s+/g, ' ').trim();
}

function evidenceFromLine(line) {
  const match = String(line ?? '').match(/evidence\s*[=:]\s*(?:"([^"]{4,500})"|“([^”]{4,500})”|「([^」]{4,500})」)/i);
  return match === null ? '' : (match[1] ?? match[2] ?? match[3]);
}

function sourceTextForSeq(session, seq) {
  const event = session?.eventAt?.(seq);
  if (event === undefined || event === null) return '';
  const message = event.type === 'user/message' ? event.data : event.data?.message;
  const text = textOfMessage(message);
  if (String(text).trim().length > 0) return text;
  try { return JSON.stringify(event.data ?? ''); } catch { return ''; }
}

function sourceRole(session, seq) {
  const type = session?.eventAt?.(seq)?.type;
  if (type === 'tool/result' || type === 'assistant/message') return 'state';
  if (type === 'user/message') return 'requirement';
  return 'other';
}

function isEvidenceContinuation(line) {
  return /^\s+evidence\s*[=:]/i.test(String(line ?? ''));
}

function claimOfLine(line) {
  const before = String(line).split(/superseded:/i)[0];
  return before
    .replace(/[(（][^)）]*seq=[^)）]*[)）]/gi, '')
    .replace(/evidence\s*[=:]\s*(?:"[^"]*"|“[^”]*”|「[^」]*」)/gi, '');
}

function literalTokens(line) {
  const claim = claimOfLine(line);
  const tokens = new Set();
  for (const match of claim.matchAll(/\b\d[\d,.]*\b/g)) {
    const value = match[0].replace(/,/g, '');
    if (value.length > 0) tokens.add(value);
  }
  for (const match of claim.matchAll(/#[0-9a-fA-F]{6}\b/g)) tokens.add(match[0].toUpperCase());
  for (const match of claim.matchAll(/[A-Za-z]:\\[^\s，。；；)）]+/g)) tokens.add(match[0]);
  for (const match of claim.matchAll(/[\w.-]+\.(?:md|docx|py|ts|json|txt|yaml|yml)\b/gi)) tokens.add(match[0]);
  for (const match of claim.matchAll(/[「“"]([^」”"]{2,160})[」”"]/g)) tokens.add(match[1]);
  return [...tokens].map(normalizeEvidence).filter(token => token.length > 0);
}

function evidenceGrounded(evidence, source, literals) {
  const quote = normalizeEvidence(evidence);
  const haystack = normalizeEvidence(source);
  if (quote.length < 4 || !haystack.includes(quote)) return false;
  return literals.every(token => quote.includes(token));
}

function findEvidenceSeq(session, evidence, literals, kind) {
  const quote = normalizeEvidence(evidence);
  if (quote.length < 4) return [];
  const matches = [];
  const total = Number(session?.seq ?? 0);
  for (let seq = 0; seq < total; seq += 1) {
    if (sourceRole(session, seq) !== kind) continue;
    const source = sourceTextForSeq(session, seq);
    if (evidenceGrounded(quote, source, literals)) matches.push(seq);
  }
  return matches;
}

export function validateAndCorrectTemporalFacts(text, input, messageIndex, session) {
  const source = String(text ?? '');
  const start = source.indexOf('## Temporal Facts');
  if (start < 0) return { text: source, audit: '', corrections: [], unverified: [] };
  const next = source.indexOf('\n## ', start + 1);
  const block = next < 0 ? source.slice(start) : source.slice(start, next);
  const lines = block.split('\n');
  const priorUnverified = lines.filter(line => line.startsWith('- ') && /source=unverified/i.test(line));
  const corrections = [];
  const unverified = [];
  let verified = 0;
  let verifiedState = 0;
  let verifiedRequirement = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('- ')) continue;
    const citation = line.match(/[(（]([^)）]*seq=(\d+)(?:,\s*turn=(\d+))?[^)）]*)[)）]/i);
    if (citation === null) continue;
    if (/source=unverified/i.test(citation[1])) continue;
    const citedSeq = Number(citation[2]);
    const citedTurn = citation[3] === undefined ? undefined : Number(citation[3]);
    const kind = (citation[1].match(/kind\s*=\s*(requirement|state)\b/i)?.[1] ?? '').toLowerCase();
    if (kind.length === 0) {
      unverified.push(line.slice(0, 180));
      lines[index] = line.replace(citation[0], '(source=unverified)');
      continue;
    }
    let evidence = evidenceFromLine(line);
    let evidenceLine = -1;
    if (evidence.length === 0 && index + 1 < lines.length && isEvidenceContinuation(lines[index + 1])) {
      evidence = evidenceFromLine(lines[index + 1]);
      if (evidence.length > 0) evidenceLine = index + 1;
    }
    const literals = literalTokens(line);
    if (evidence.length === 0) {
      unverified.push(line.slice(0, 180));
      lines[index] = line.replace(citation[0], '(source=unverified)');
      continue;
    }
    const citedText = sourceTextForSeq(session, citedSeq);
    if (sourceRole(session, citedSeq) === kind && evidenceGrounded(evidence, citedText, literals)) {
      verified += 1;
      if (kind === 'state') verifiedState += 1;
      else verifiedRequirement += 1;
      continue;
    }
    const matches = findEvidenceSeq(session, evidence, literals, kind);
    if (matches.length === 1) {
      const candidateSeq = matches[0];
      const candidateTurn = session?.eventAt?.(candidateSeq)?.data?.turn;
      const open = citation[0].startsWith('（') ? '（' : '(';
      const close = citation[0].endsWith('）') ? '）' : ')';
      const separator = citation[0].includes('；') ? '；' : ';';
      const kindPart = separator + 'kind=' + kind;
      const evidencePart = evidence.length > 0 ? separator + 'evidence="' + evidence + '"' : '';
      const replacement = candidateTurn === undefined
        ? open + 'seq=' + candidateSeq + kindPart + evidencePart + close
        : open + 'seq=' + candidateSeq + ', turn=' + candidateTurn + kindPart + evidencePart + close;
      lines[index] = line.replace(citation[0], replacement);
      corrections.push('seq=' + citedSeq + ' -> seq=' + candidateSeq + ': ' + line.slice(0, 140));
      continue;
    }
    unverified.push(line.slice(0, 180));
    lines[index] = line.replace(citation[0], '(source=unverified)');
    if (evidenceLine >= 0) lines[evidenceLine] = '';
  }
  for (const line of priorUnverified) {
    const detail = line.slice(0, 180);
    if (!unverified.includes(detail)) unverified.push(detail);
  }
  const correctedBlock = lines.join('\n');
  const corrected = source.slice(0, start) + correctedBlock + (next < 0 ? '' : source.slice(next));
  const auditLines = [];
  if (verified > 0) auditLines.push('- verified by evidence quote: ' + verified + ' fact(s)');
  if (corrections.length > 0) auditLines.push(...corrections.map(item => '- corrected: ' + item));
  if (unverified.length > 0) auditLines.push(...unverified.map(item => '- unverified: ' + item));
  if (unverified.length > 0) auditLines.push('- unverified facts are not accepted as sourced history; their citations were removed.');
  const audit = auditLines.length === 0 ? '' : ['## Fact Audit', ...auditLines].join('\n');
  return { text: corrected, audit, corrections, unverified, verified, verifiedState, verifiedRequirement };
}

export function renderStateBoundary(retained, session) {
  const currentSeq = Math.max(0, Number(session?.seq ?? 0) - 1);
  const lines = [
    '## State Boundary (authoritative)',
    '- summaryScope: history only',
    '- asOf: seq=' + retained.asOfSeq,
    '- current: seq=' + currentSeq,
  ];
  if (retained.lastAssistant !== undefined) {
    lines.push('- tail final assistant: seq=' + retained.lastAssistant.seq
      + (retained.lastAssistant.turn === undefined ? '' : ' turn=' + retained.lastAssistant.turn));
  }
  if (retained.lastTurnEnd !== undefined) {
    lines.push('- tail turn/end: seq=' + retained.lastTurnEnd.seq
      + (retained.lastTurnEnd.reason === undefined ? '' : ' reason=' + retained.lastTurnEnd.reason));
  }
  const completed = retained.lastTurnEnd?.reason === 'completed' && retained.lastAssistant !== undefined;
  lines.push('- currentAction: ' + (completed
    ? 'final assistant already exists in the retained tail; do not resend it'
    : retained.lastTurnEnd !== undefined
      ? 'turn completed in the retained tail; do not repeat historical pending work'
      : 'no retained tail after the summary cutoff; treat summary as history'));
  return lines.join('\n');
}

export function detectSummaryLanguage(sessionOrTexts) {
  let texts = [];
  if (Array.isArray(sessionOrTexts)) {
    texts = sessionOrTexts;
  } else {
    const session = sessionOrTexts;
    const total = Number(session?.seq ?? 0);
    for (let seq = 0; seq < total; seq += 1) {
      const event = session?.eventAt?.(seq);
      if (event?.type !== 'user/message') continue;
      if (event.data?.source?.kind !== 'user') continue;
      const text = textOfMessage(event.data).trim();
      if (text.length > 0) texts.push(text);
    }
    texts = texts.slice(-20);
  }
  let cjk = 0;
  let latin = 0;
  for (const text of texts) {
    for (const char of String(text ?? '')) {
      if (/[\u4e00-\u9fff]/.test(char)) cjk += 1;
      else if (/[A-Za-z]/.test(char)) latin += 1;
    }
  }
  if (cjk + latin === 0) return 'en';
  return cjk / (cjk + latin) > 0.3 ? 'zh' : 'en';
}

function estimateTextTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const char of String(text ?? '')) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function estimateInputTokens(messages) {
  let tokens = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message?.content === 'string') {
      tokens += estimateTextTokens(message.content);
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'text' || block?.type === 'reasoning') {
        tokens += estimateTextTokens(block.text);
      } else if (block?.type === 'tool-call') {
        tokens += estimateTextTokens(JSON.stringify(block.arguments ?? block));
      }
    }
  }
  return tokens;
}
