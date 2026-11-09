import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { resolveHostModules } from '../resolve-host.js';

const host = resolveHostModules();
if (!process.env.DSH_COMPACTION_BASIC_URL) process.env.DSH_COMPACTION_BASIC_URL = host.basicUrl;
if (!process.env.DSH_TOOLS_URL) process.env.DSH_TOOLS_URL = host.toolsUrl;
if (!process.env.DSH_LLM_URL) process.env.DSH_LLM_URL = host.llmUrl;

const {
  default: CompactionEngine,
  appendSummarySuffix,
  buildContract,
  buildInventory,
  buildReloadCheckpoint,
  collectToolResults,
  extractLoadedSkills,
  extractReadRequests,
  formatToolPointer,
  pointerizeMessages,
  readResultsFor,
  readToolInventory,
  buildEvidenceIndex,
  buildMessageIndex,
  buildPtcInstruction,
  detectSummaryLanguage,
  collectRetainedTail,
  collectCurrentContext,
  estimateInputTokens,
  renderAnchors,
  renderCurrentContextBoundary,
  renderPointers,
  renderRetainedTailBoundary,
  renderRetainedTailState,
  renderStateBoundary,
  validateAndCorrectTemporalFacts,
  selectAnchorEntries,
  HISTORY_DECLARATION,
  STYLE_CONTRACT,
  HOST_MODULES,
} = await import('../index.js');
import { readHotPrompt, clearHotPromptCache } from '../hot-prompt.js';

test('host resolver points at the hosting DSH modules', () => {
  assert.match(host.basicUrl, /dsh-compaction-basic\/lib\/index\.js$/);
  assert.match(host.toolsUrl, /dsh-tools\/lib\/index\.js$/);
  assert.match(host.llmUrl, /dsh-llm\/lib\/index\.js$/);
  assert.ok(['host', 'env'].includes(HOST_MODULES.source));
  assert.ok(typeof HOST_MODULES.toolsUrl === 'string');
});

function sessionFixture() {
  const events = new Map([
    [1, { type: 'tool/ptc-dispatch', data: { name: 'skill', arguments: { name: 'midform-writing' } } }],
    [2, { type: 'tool/call', data: { name: 'skill', arguments: JSON.stringify({ name: 'office-docx' }) } }],
    [3, { type: 'tool/ptc-dispatch', data: { name: 'skill', arguments: { name: 'midform-writing' } } }],
    [4, { type: 'tool/result', data: { message: {} } }],
  ]);
  return {
    // 0.2.2 surfaces hold message events only; skill calls stay in the log.
    surface: { nodes: [4] },
    seq: 5,
    eventAt(seq) { return events.get(seq); },
  };
}

test('extracts loaded skills from tool calls without duplicates', () => {
  assert.deepEqual(sessionFixture().surface.nodes, [4]);
  assert.deepEqual(extractLoadedSkills(sessionFixture()), ['midform-writing', 'office-docx']);
});

test('contract contains style, skills, and historical declaration', () => {
  const contract = buildContract({ session: sessionFixture() });
  assert.match(contract, /Style Contract/);
  assert.match(contract, /midform-writing/);
  assert.match(contract, /office-docx/);
  assert.ok(contract.includes(HISTORY_DECLARATION));
  assert.ok(contract.includes(STYLE_CONTRACT));
});

test('summary suffix appends loaded skills and history', () => {
  const out = appendSummarySuffix([{ type: 'text', text: 'body' }], { session: sessionFixture() });
  assert.equal(out[0].text, 'body');
  assert.match(out[1].text, /midform-writing/);
  assert.match(out[1].text, /以上为历史摘要/);
});

test('formats and parses tool-result pointers', () => {
  const pointer = formatToolPointer(42, 'bash', 'ok', 1200, 'exit 0');
  assert.match(pointer, /TOOL_RESULT seq=42/);
  assert.match(pointer, /read=memory_read\(seq=42\)/);
  assert.deepEqual(extractReadRequests('draft READ seq=42 and READ seq=7; READ seq=42'), [42, 7]);
});

test('builds reload checkpoint and inventory', () => {
  assert.match(buildReloadCheckpoint(['midform-writing']), /reload required: midform-writing/);
  assert.deepEqual(buildInventory({ skills: ['a', 'a'], loadedSchemas: ['read'] }), {
    skills: ['a'], tools: [], loadedSchemas: ['read'], evicted: [], requiredTools: [],
  });
});

test('pointerizes large tool results and resolves READ by seq', () => {
  const session = {
    seq: 3,
    eventAt(seq) {
      if (seq === 0) return { seq: 0, type: 'tool/call', data: { callId: 'call-1', name: 'run_code', arguments: '{}' } };
      if (seq === 1) return { seq: 1, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'x'.repeat(3000) }] } } };
      if (seq === 2) return { seq: 2, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: 'short' }] } } };
      return undefined;
    },
  };
  const results = collectToolResults(session);
  assert.equal(results.size, 2);
  assert.equal(results.get('call-1').tool, 'run_code');
  assert.equal(results.get('call-2').isError, true);
  const messages = pointerizeMessages([
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'x'.repeat(3000) }] },
    { role: 'tool', toolCallId: 'call-2', content: [{ type: 'text', text: 'short' }] },
  ], results);
  assert.match(messages[0].content[0].text, /TOOL_RESULT seq=1 tool=run_code/);
  assert.equal(messages[1].content[0].text, 'short');
  assert.match(readResultsFor([1], results)[0], /READ seq=1/);
});

test('collects tool results from the legacy flat event shape', () => {
  const session = {
    seq: 1,
    eventAt(seq) {
      if (seq === 0) return { seq: 0, type: 'tool/result', data: { toolCallId: 'call-9', isError: true, message: { content: [{ type: 'text', text: 'flat' }] } } };
      return undefined;
    },
  };
  const results = collectToolResults(session);
  assert.equal(results.size, 1);
  assert.equal(results.get('call-9').seq, 0);
  assert.equal(results.get('call-9').text, 'flat');
  assert.equal(results.get('call-9').isError, true);
});

test('contract reports missing and present companion tools without failing', () => {
  const base = { session: sessionFixture() };
  assert.match(buildContract(base), /tool inventory: unavailable/);
  const withTools = { ...base, ctx: { tools: { get: () => ({ name: 'tool_inventory' }) } } };
  assert.match(buildContract(withTools), /tool inventory: available/);
});

test('reads the shared tool inventory and renders it in the contract and suffix', async () => {
  const definition = {
    execute: async () => ({
      selected: ['read', 'grep'],
      required: ['read'],
      capacity: 16,
      headroom: 14,
      autoUnloadMax: 2,
      exceptionLatched: false,
    }),
  };
  const agent = { session: sessionFixture(), ctx: { tools: { get: () => definition } } };
  const inventory = await readToolInventory(agent);
  assert.equal(inventory.available, true);
  const contract = buildContract(agent, inventory);
  assert.match(contract, /tool inventory: available/);
  assert.match(contract, /selected: 2 tools \(read, grep\)/);
  assert.match(contract, /required: read/);
  assert.match(contract, /capacity: 16; headroom: 14/);
  const suffix = appendSummarySuffix([{ type: 'text', text: 'body' }], agent, inventory);
  assert.match(suffix[1].text, /tool inventory: available/);
  assert.match(suffix[1].text, /required: read/);
});

test('inventory read failure is reported without failing the contract', async () => {
  const definition = { execute: async () => { throw new Error('inventory boom'); } };
  const agent = { session: sessionFixture(), ctx: { tools: { get: () => definition } } };
  const inventory = await readToolInventory(agent);
  assert.equal(inventory.available, false);
  assert.match(inventory.reason, /inventory boom/);
  const contract = buildContract(agent, inventory);
  assert.match(contract, /tool inventory: unavailable/);
  assert.match(contract, /reason: inventory boom/);
});


function anchorSessionFixture() {
  const userMessage = { id: 'u-anchor', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续修订：电解槽以碱性电解水为起点。' }] };
  const toolMessage = { role: 'tool', toolCallId: 'call-anchor', content: [{ type: 'text', text: 'x'.repeat(3000) }] };
  const assistantMessage = { id: 'a-anchor', role: 'assistant', content: [{ type: 'text', text: '已更新。' }] };
  const events = new Map([
    [0, { seq: 0, type: 'user/message', data: { ...userMessage, turn: 1, step: 1 } }],
    [1, { seq: 1, type: 'tool/result', data: { turn: 1, step: 2, message: toolMessage } }],
    [2, { seq: 2, type: 'assistant/message', data: { turn: 1, step: 3, message: assistantMessage } }],
  ]);
  const session = { seq: 3, eventAt(seq) { return events.get(seq); } };
  return { session, messages: [userMessage, toolMessage, assistantMessage] };
}

test('builds timeline anchors and evidence pointers from the exact input messages', () => {
  const { session, messages } = anchorSessionFixture();
  const index = buildMessageIndex(session);
  const entries = selectAnchorEntries({ messages }, index, { get: () => undefined });
  const anchors = renderAnchors(entries);
  const pointers = renderPointers(entries);
  assert.match(anchors, /seq=0 .*kind=user/);
  assert.match(anchors, /seq=1 .*kind=tool/);
  assert.match(pointers, /memory_read\(seq=1\)/);
});

test('detects the summary language from real user messages', () => {
  const { session } = anchorSessionFixture();
  assert.equal(detectSummaryLanguage(session), 'zh');
  assert.equal(detectSummaryLanguage([{ role: 'user', content: [{ type: 'text', text: 'continue' }] }]), 'en');
});

test('builds a PTC instruction with Temporal Facts, anchors, pointers and language', () => {
  const text = buildPtcInstruction({
    language: 'zh',
    anchors: '- seq=1 kind=user: 继续',
    pointers: '- seq=1 kind=user read=memory_read(seq=1)',
    styleContract: 'style',
  });
  assert.match(text, /## Temporal Facts/);
  assert.match(text, /## Timeline Anchors/);
  assert.match(text, /## Evidence Pointers/);
  assert.match(text, /## Global View Boundary/);
  assert.match(text, /用中文写 checkpoint/);
  assert.match(text, /style/);
});

test('hot-loads the optional per-home compaction prompt', () => {
  const dir = fs.mkdtempSync('.sandbox/hot-prompt-test-');
  const file = path.join(dir, 'compaction-prompt.md');
  fs.writeFileSync(file, 'first guidance', 'utf8');
  clearHotPromptCache();
  const first = readHotPrompt({ path: file });
  assert.equal(first.text, 'first guidance');
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  fs.writeFileSync(file, 'second guidance is longer', 'utf8');
  const second = readHotPrompt({ path: file });
  assert.equal(second.text, 'second guidance is longer');
  assert.notEqual(second.hash, first.hash);
  const missing = readHotPrompt({ path: file + '.missing' });
  assert.equal(missing.text, '');
});

test('includes hot prompt guidance after the stable instruction contract', () => {
  const text = buildPtcInstruction({ language: 'en', hotPrompt: 'Keep exact source quotes.' });
  assert.match(text, /## Temporal Facts/);
  assert.match(text, /## Hot-loaded Prompt Guidance/);
  assert.match(text, /Keep exact source quotes\./);
});

test('builds a bounded evidence index with omitted count', () => {
  const entries = [];
  for (let i = 1; i <= 15; i += 1) {
    entries.push({ seq: i, kind: 'tool', tool: 'run_code', status: 'ok', chars: 3000 });
  }
  const text = buildEvidenceIndex(entries, 'summary '.repeat(200), 30000);
  assert.match(text, /## Evidence Index/);
  assert.match(text, /eligible: 15/);
  assert.match(text, /omitted:/);
  assert.ok(text.length <= 1500);
});


test('PTC summarize defaults to full context and appends the v3 suffix', async () => {
  const userMessage = { id: 'u-live', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续修订：电解槽以碱性电解水为起点。' }] };
  const toolMessage = { role: 'tool', toolCallId: 'call-live', content: [{ type: 'text', text: 'y'.repeat(100000) }] };
  const assistantMessage = { id: 'a-live', role: 'assistant', content: [{ type: 'text', text: '已更新。' }] };
  const events = new Map([
    [0, { seq: 0, type: 'user/message', data: { ...userMessage, turn: 1, step: 1 } }],
    [1, { seq: 1, type: 'tool/result', data: { turn: 1, step: 2, message: toolMessage } }],
    [2, { seq: 2, type: 'assistant/message', data: { turn: 1, step: 3, message: assistantMessage } }],
  ]);
  const session = { header: { agentPreset: 'ptc' }, seq: 3, eventAt(seq) { return events.get(seq); } };
  const definition = { execute: async () => ({ selected: [], required: [], capacity: 16, headroom: 16, autoUnloadMax: 1, exceptionLatched: false }) };
  const agent = { session, ctx: { tools: { get: () => definition } }, options: {} };
  const engine = Object.create(CompactionEngine.prototype);
  engine.ctx = { logger: { warn() {} } };
  engine.config = { reviewPass: false };
  engine.shouldPointerize = async () => false;
  engine.seen = [];
  engine.summarizePtc = async (input, _agent, _signal, instruction) => {
    engine.seen.push({ messages: input.messages, instruction });
    return { summary: [{ type: 'text', text: 'body' }], rawOutput: [], llmStreamCall: true, provider: 'p', model: 'm', maxTokens: 1 };
  };
  const input = { messages: [userMessage, toolMessage, assistantMessage] };
  const result = await engine.summarize(input, agent, undefined);
  assert.equal(engine.seen.length, 1);
  assert.equal(engine.seen[0].messages.length, 3);
  assert.match(engine.seen[0].instruction, /## Temporal Facts/);
  assert.match(engine.seen[0].instruction, /## Timeline Anchors/);
  assert.match(engine.seen[0].instruction, /## Evidence Pointers/);
  const suffix = result.summary[result.summary.length - 1].text;
  assert.match(suffix, /## Loaded Skills/);
  assert.match(suffix, /## Reload Skills Checkpoint/);
  assert.match(suffix, /## Companion Status/);
  assert.match(suffix, /## Evidence Index/);
  assert.match(suffix, /## Historical Declaration/);
});


test('summarizePtc calls the host LLM stream with the PTC instruction', async () => {
  const engine = Object.create(CompactionEngine.prototype);
  let seen = null;
  engine.config = { maxTokens: 64 };
  engine.ctx = {
    llm: {
      async *stream(options) {
        seen = options;
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '中文摘要' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '中文摘要' } };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  const agent = {
    session: {
      id: 'session-test',
      requestHeader: () => ({ config: { provider: 'provider-test', model: 'model-test' } }),
      toolHistory: () => [],
    },
  };
  const result = await engine.summarizePtc({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, agent, undefined, 'PTC-INSTRUCTION');
  assert.equal(result.summary[0].text, '中文摘要');
  assert.equal(result.provider, 'provider-test');
  assert.equal(result.model, 'model-test');
  assert.equal(seen.messages[seen.messages.length - 1].content[0].text, 'PTC-INSTRUCTION');
});


test('collects the unshadowed retained tail after the summarized cutoff', () => {
  const user = { id: 'u-hist', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'history user' }] };
  const assistant = { id: 'a-hist', role: 'assistant', content: [{ type: 'text', text: 'history assistant' }] };
  const tail = { id: 'a-tail', role: 'assistant', content: [{ type: 'text', text: 'final answer in tail' }] };
  const events = new Map([
    [0, { seq: 0, type: 'user/message', data: user, time: 1 }],
    [1, { seq: 1, type: 'assistant/message', data: { message: assistant, turn: 1, step: 1 }, time: 2 }],
    [2, { seq: 2, type: 'assistant/message', data: { message: tail, turn: 1, step: 2 }, time: 3 }],
    [3, { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 4 }],
  ]);
  const session = { seq: 4, eventAt(seq) { return events.get(seq); } };
  const index = buildMessageIndex(session);
  const retained = collectRetainedTail(session, { messages: [user, assistant] }, index);
  assert.equal(retained.asOfSeq, 1);
  assert.equal(retained.messages.length, 1);
  assert.equal(retained.messages[0].content[0].text, 'final answer in tail');
  assert.equal(retained.lastAssistant.seq, 2);
  assert.equal(retained.lastTurnEnd.seq, 3);
  assert.match(renderRetainedTailBoundary(retained), /RETAINED CURRENT TAIL/);
  assert.match(renderRetainedTailState(retained), /turn\/end: seq=3/);
});

test('PTC summarize sends the retained tail to the summarizer with a boundary', async () => {
  const user = { id: 'u-global', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'history request' }] };
  const assistant = { id: 'a-global', role: 'assistant', content: [{ type: 'text', text: 'history reply' }] };
  const tail = { id: 'a-tail-global', role: 'assistant', content: [{ type: 'text', text: 'FINAL ANSWER IN TAIL' }] };
  const events = new Map([
    [0, { seq: 0, type: 'user/message', data: user }],
    [1, { seq: 1, type: 'assistant/message', data: { message: assistant, turn: 1, step: 1 } }],
    [2, { seq: 2, type: 'assistant/message', data: { message: tail, turn: 1, step: 2 } }],
    [3, { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }],
  ]);
  const session = { header: { agentPreset: 'ptc' }, seq: 4, eventAt(seq) { return events.get(seq); } };
  const definition = { execute: async () => ({ selected: [], required: [], capacity: 16, headroom: 16, autoUnloadMax: 1, exceptionLatched: false }) };
  const agent = { session, ctx: { tools: { get: () => definition } }, options: {} };
  const engine = Object.create(CompactionEngine.prototype);
  engine.ctx = { logger: { warn() {} } };
  engine.config = { reviewPass: false };
  engine.shouldPointerize = async () => false;
  engine.seen = [];
  engine.summarizePtc = async (input, _agent, _signal, instruction) => {
    engine.seen.push({ messages: input.messages, instruction });
    return { summary: [{ type: 'text', text: 'body' }], rawOutput: [], llmStreamCall: true, provider: 'p', model: 'm', maxTokens: 1 };
  };
  const result = await engine.summarize({ messages: [user, assistant] }, agent, undefined);
  const messages = engine.seen[0].messages;
  assert.equal(messages.length, 5);
  assert.match(JSON.stringify(messages[2]), /RETAINED CURRENT TAIL/);
  assert.match(JSON.stringify(messages[3]), /FINAL ANSWER IN TAIL/);
  assert.match(JSON.stringify(messages[4]), /turn\/end: seq=3/);
  assert.match(engine.seen[0].instruction, /## Global View Boundary/);
});


test('applies one external review pass to the draft', async () => {
  const user = { id: 'u-review', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'history' }] };
  const events = new Map([[0, { seq: 0, type: 'user/message', data: user }]]);
  const session = { header: { agentPreset: 'ptc' }, seq: 1, eventAt(seq) { return events.get(seq); } };
  const definition = { execute: async () => ({ selected: [], required: [], capacity: 16, headroom: 16, autoUnloadMax: 1, exceptionLatched: false }) };
  const agent = { session, ctx: { tools: { get: () => definition } }, options: {} };
  const engine = Object.create(CompactionEngine.prototype);
  engine.ctx = { logger: { warn() {}, info() {} } };
  engine.config = {};
  engine.shouldPointerize = async () => false;
  engine.auditDraft = () => ({ findings: [{ code: 'no_state_fact', detail: 'draft has requirements only' }] });
  let calls = 0;
  engine.summarizePtc = async () => {
    calls += 1;
    return { summary: [{ type: 'text', text: calls === 1 ? 'draft' : 'revised' }], rawOutput: [], llmStreamCall: true, provider: 'p', model: 'm', maxTokens: 1 };
  };
  const result = await engine.summarize({ messages: [user] }, agent, undefined);
  assert.equal(calls, 2);
  assert.equal(result.summary[0].text, 'revised');
});

test('does not consume an adjacent fact as next-line evidence', () => {
  const user = { id: 'u-adj', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '共 33 页。' }] };
  const events = new Map([[0, { seq: 0, type: 'user/message', data: user }]]);
  const session = { seq: 1, eventAt(seq) { return events.get(seq); } };
  const index = buildMessageIndex(session);
  const source = '## Temporal Facts\n- 章数规模：11 章（seq=0, turn=1；kind=state）。\n- 页数规模：33 页（seq=0, turn=1；kind=requirement；evidence="共 33 页"）。\n';
  const result = validateAndCorrectTemporalFacts(source, { messages: [user] }, index, session);
  assert.doesNotMatch(result.text, /evidence removed/);
  assert.match(result.text, /页数规模：33 页/);
  assert.match(result.text, /章数规模：11 章\(source=unverified\)/);
});

test('returns verified state counts and preserves prior unverified facts in audit', () => {
  const assistant = { id: 'a-state', role: 'assistant', content: [{ type: 'text', text: '已完成：共 10 章，10,867 个汉字。' }] };
  const events = new Map([[0, { seq: 0, type: 'assistant/message', data: { message: assistant } }]]);
  const session = { seq: 1, eventAt(seq) { return events.get(seq); } };
  const index = buildMessageIndex(session);
  const source = '## Temporal Facts\n- 全书规模：10 章，10,867 个汉字（seq=0, turn=1；kind=state；evidence="共 10 章，10,867 个汉字"）。\n- 旧值：浅色(source=unverified)。\n';
  const result = validateAndCorrectTemporalFacts(source, { messages: [assistant] }, index, session);
  assert.equal(result.verifiedState, 1);
  assert.match(result.audit, /unverified/);
  assert.match(result.text, /source=unverified/);
});

test('falls back to the draft when reviewed output loses required sections', async () => {
  const user = { id: 'u-fallback', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'history' }] };
  const events = new Map([[0, { seq: 0, type: 'user/message', data: user }]]);
  const session = { header: { agentPreset: 'ptc' }, seq: 1, eventAt(seq) { return events.get(seq); } };
  const definition = { execute: async () => ({ selected: [], required: [], capacity: 16, headroom: 16, autoUnloadMax: 1, exceptionLatched: false }) };
  const agent = { session, ctx: { tools: { get: () => definition } }, options: {} };
  const engine = Object.create(CompactionEngine.prototype);
  engine.ctx = { logger: { warn() {}, info() {} } };
  engine.config = {};
  engine.shouldPointerize = async () => false;
  let audits = 0;
  engine.auditDraft = () => {
    audits += 1;
    return audits === 1
      ? { findings: [{ code: 'no_verified_state_fact', detail: 'need state' }] }
      : { findings: [{ code: 'missing_section', detail: 'Critical Context' }] };
  };
  let calls = 0;
  engine.summarizePtc = async () => {
    calls += 1;
    return { summary: [{ type: 'text', text: calls === 1 ? 'draft' : 'revised' }], rawOutput: [], llmStreamCall: true, provider: 'p', model: 'm', maxTokens: 1 };
  };
  const result = await engine.summarize({ messages: [user] }, agent, undefined);
  assert.equal(calls, 2);
  assert.equal(result.summary[0].text, 'draft');
  assert.match(result.summary[result.summary.length - 1].text, /review: .*missing_section/);
});

test('corrects a Temporal Facts source seq only from a verbatim evidence quote', () => {
  const user = { id: 'u-fact', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'history' }] };
  const tool = { id: 't-fact', role: 'tool', content: [{ type: 'text', text: '正文 20872 个汉字，60 篇参考文献，33 页，18 个公式。' }] };
  const events = new Map([
    [0, { seq: 0, type: 'user/message', data: user, time: 1 }],
    [1, { seq: 1, type: 'tool/result', data: { message: tool, turn: 11, step: 1 }, time: 2 }],
  ]);
  const session = { seq: 2, eventAt(seq) { return events.get(seq); } };
  const index = buildMessageIndex(session);
  const source = '## Temporal Facts\n- 正文规模：20872 个汉字（seq=9, turn=1；kind=state；evidence="正文 20872 个汉字"）。\n';
  const result = validateAndCorrectTemporalFacts(source, { messages: [user, tool] }, index, session);
  assert.match(result.text, /（seq=1, turn=11；kind=state；evidence="正文 20872 个汉字"）/);
  assert.doesNotMatch(result.text, /seq=9/);
  assert.match(result.audit, /corrected: seq=9 -> seq=1/);
});

test('marks a fact unverified without an exact evidence quote', () => {
  const user = { id: 'u-fact2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '最后两章较短，合并一下' }] };
  const events = new Map([[0, { seq: 0, type: 'user/message', data: user, time: 1 }]]);
  const session = { seq: 1, eventAt(seq) { return events.get(seq); } };
  const index = buildMessageIndex(session);
  const source = '## Temporal Facts\n- 当前总章数：9 章（seq=0, turn=1；kind=state；evidence="最后两章较短，合并一下"）。\n';
  const result = validateAndCorrectTemporalFacts(source, { messages: [user] }, index, session);
  assert.match(result.text, /source=unverified/);
  assert.doesNotMatch(result.text, /seq=0/);
  assert.match(result.audit, /unverified/);
});

test('rejects a state fact whose only quote is a user requirement', () => {
  const user = { id: 'u-kind', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '标题下小字已经与当前内容不符，修改一下' }] };
  const events = new Map([[0, { seq: 0, type: 'user/message', data: user, time: 1 }]]);
  const session = { seq: 1, eventAt(seq) { return events.get(seq); } };
  const index = buildMessageIndex(session);
  const source = '## Temporal Facts\n- 标题下小字：已改为当前规矩（seq=0, turn=1；kind=state；evidence="标题下小字已经与当前内容不符，修改一下"）。\n';
  const result = validateAndCorrectTemporalFacts(source, { messages: [user] }, index, session);
  assert.match(result.text, /source=unverified/);
  assert.doesNotMatch(result.text, /seq=0/);
  assert.match(result.audit, /unverified/);
});

test('accepts a fact only when its evidence and literals are present', () => {
  const user = { id: 'u-fact3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '合计 73,797 个汉字。' }] };
  const events = new Map([[0, { seq: 0, type: 'user/message', data: user, time: 1 }]]);
  const session = { seq: 1, eventAt(seq) { return events.get(seq); } };
  const index = buildMessageIndex(session);
  const source = '## Temporal Facts\n- 全文汉字数：73,797（seq=0, turn=1；kind=requirement；evidence="合计 73,797 个汉字"）。\n';
  const result = validateAndCorrectTemporalFacts(source, { messages: [user] }, index, session);
  assert.match(result.text, /seq=0, turn=1；kind=requirement；evidence="合计 73,797 个汉字"/);
  assert.match(result.audit, /verified by evidence quote: 1/);
});

test('renders an authoritative state boundary for a completed tail', () => {
  const retained = {
    asOfSeq: 10,
    lastTailSeq: 12,
    lastAssistant: { seq: 12, turn: 2 },
    lastTurnEnd: { seq: 13, turn: 2, reason: 'completed' },
  };
  const text = renderStateBoundary(retained, { seq: 14 });
  assert.match(text, /## State Boundary \(authoritative\)/);
  assert.match(text, /final assistant already exists/);
  assert.match(text, /do not resend/);
  assert.match(text, /current: seq=13/);
});
