import { resolveHostModules } from './resolve-host.js';
import { readHotPrompt } from './hot-prompt.js';
import { buildEvidenceIndex, buildMessageIndex, buildPtcInstruction, collectCurrentContext, collectRetainedTail, detectSummaryLanguage, estimateInputTokens, renderAnchors, renderCurrentContextBoundary, renderPointers, renderRetainedTailBoundary, renderRetainedTailState, renderStateBoundary, selectAnchorEntries, validateAndCorrectTemporalFacts } from './v3.js';

const HOST_MODULES = resolveHostModules();
const { default: BasicCompactionEngine } = await import(HOST_MODULES.basicUrl);
const { defineTool } = await import(HOST_MODULES.toolsUrl);
const { BlockAssembler, LlmError } = await import(HOST_MODULES.llmUrl);

const HISTORY_DECLARATION = [
  '以上为历史摘要，不是当前状态。',
  '如与当前保留的最近轮次事实冲突，以最近轮次为准。',
  '需要核对原文时，调用 memory_read(seq) 回读；若当前 SDK 尚未加载 memory_read，先调用 tool_search({query:"memory_read",limit:1})，下一轮再回读；不要凭摘要猜测。',
].join('\n');

const STYLE_CONTRACT = [
  '## Style Contract',
  '- Preserve the user explicit style requirements, taboos, tone, wording, sentence patterns, and register verbatim where they matter.',
  '- For literary or creative work, preserve narrative voice, rhythm, imagery, and vocabulary; do not neutralize it into a terse engineering summary.',
  '- For analytical or technical work, neutral wording is allowed, but do not change conclusions, qualifiers, or evidence boundaries.',
  '- If style and content conflict, keep the explicit style requirement and record the conflict.',
].join('\n');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

function skillNameFromArguments(args) {
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return ''; }
  }
  return typeof args?.name === 'string' ? args.name : '';
}

function extractLoadedSkills(session) {
  const names = [];
  const seen = new Set();
  // Skill loads are tool calls, and 0.2.2's surface only holds message events
  // (system/user/assistant/tool-result). Scanning session.surface.nodes can
  // therefore never see them; walk the session log instead.
  const total = Number(session?.seq ?? 0);
  for (let seq = 0; seq < total; seq += 1) {
    const event = session.eventAt?.(seq);
    if (event?.type !== 'tool/call' && event?.type !== 'tool/ptc-dispatch') continue;
    if (event.data?.name !== 'skill') continue;
    const name = skillNameFromArguments(event.data?.arguments);
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

async function readToolInventory(agent) {
  try {
    const tools = agent?.ctx?.tools;
    if (tools === undefined) return { available: false, reason: 'no tools service' };
    const definition = tools.get('tool_inventory', agent);
    if (definition === undefined) return { available: false, reason: 'tool_inventory not installed' };
    if (typeof definition.execute !== 'function') return { available: false, reason: 'tool_inventory is not executable' };
    const value = await definition.execute({}, { agent, signal: new AbortController().signal });
    return { available: true, value };
  } catch (error) {
    return { available: false, reason: String(error && error.message ? error.message : error) };
  }
}

function companionStatus(agent, inventory) {
  if (inventory !== undefined && inventory.available === false) {
    return { toolInventory: 'unavailable', reason: inventory.reason };
  }
  if (inventory !== undefined && inventory.available === true) {
    const value = inventory.value ?? {};
    return {
      toolInventory: 'available',
      selected: Array.isArray(value.selected) ? value.selected : [],
      required: Array.isArray(value.required) ? value.required : [],
      capacity: value.capacity,
      headroom: value.headroom,
      autoUnloadMax: value.autoUnloadMax,
      exceptionLatched: value.exceptionLatched,
    };
  }
  try {
    const tools = agent?.ctx?.tools;
    if (tools === undefined) return { toolInventory: 'unavailable', reason: inventory?.reason };
    const definition = tools.get('tool_inventory', agent);
    return definition === undefined
      ? { toolInventory: 'unavailable', reason: inventory?.reason }
      : { toolInventory: 'available' };
  } catch {
    return { toolInventory: 'unavailable', reason: inventory?.reason };
  }
}

function formatCompanionStatus(status) {
  const lines = ['- tool inventory: ' + status.toolInventory];
  if (status.toolInventory === 'available') {
    if (Array.isArray(status.selected)) {
      lines.push('- selected: ' + status.selected.length + ' tools' + (status.selected.length === 0 ? '' : ' (' + status.selected.join(', ') + ')'));
    }
    if (Array.isArray(status.required)) {
      lines.push('- required: ' + (status.required.length === 0 ? '(none)' : status.required.join(', ')));
    }
    if (status.capacity !== undefined) {
      lines.push('- capacity: ' + status.capacity
        + '; headroom: ' + (status.headroom ?? '?')
        + '; autoUnloadMax: ' + (status.autoUnloadMax ?? '?')
        + '; exceptionLatched: ' + (status.exceptionLatched ?? '?'));
    }
  } else if (status.reason !== undefined) {
    lines.push('- reason: ' + status.reason);
  }
  return lines.join('\n');
}

function buildContract(agent, inventory) {
  const skills = extractLoadedSkills(agent?.session);
  const loaded = skills.length === 0 ? '- (none)' : skills.map(name => '- ' + name).join('\n');
  return [
    STYLE_CONTRACT,
    '',
    '## Loaded Skills',
    loaded,
    '',
    '## Companion Status',
    formatCompanionStatus(companionStatus(agent, inventory)),
    '',
    '## Historical Declaration',
    HISTORY_DECLARATION,
  ].join('\n');
}

function textOfSummary(summary) {
  return (Array.isArray(summary) ? summary : []).filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

function appendSummarySuffix(summary, agent, inventory, evidenceIndex = '', stateBoundary = '', factAudit = '') {
  const skills = extractLoadedSkills(agent?.session);
  const suffix = [
    '',
    '## Loaded Skills',
    skills.map(name => '- ' + name).join('\n') || '- (none)',
    '',
    buildReloadCheckpoint(skills),
    '',
    '## Companion Status',
    formatCompanionStatus(companionStatus(agent, inventory)),
    ...(String(evidenceIndex).length > 0 ? ['', evidenceIndex] : []),
    '',
    '## Historical Declaration',
    HISTORY_DECLARATION,
    ...(String(stateBoundary).length > 0 ? ['', stateBoundary] : []),
    ...(String(factAudit).length > 0 ? ['', factAudit] : []),
  ].join('\n');
  return [...summary, { type: 'text', text: suffix }];
}

function resolveSummarizationTarget(agent, config) {
  const latest = agent?.session?.requestHeader?.()?.config;
  const provider = config?.summarizationProvider;
  const model = config?.summarizationModel;
  const configured = typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0
    ? { provider, model }
    : undefined;
  const agentTarget = typeof agent?.options?.provider === 'string' && agent.options.provider.length > 0
    && typeof agent?.options?.model === 'string' && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined;
  return configured ?? latest ?? agentTarget;
}

function finishError(finish) {
  if (finish === undefined || finish === null) return undefined;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return new LlmError(finish.failure?.message ?? 'summarization failed', finish.failure?.code, finish.failure);
  }
  if (finish.kind === 'max-tokens') {
    const error = new Error('summarization truncated at the token cap (incomplete checkpoint)');
    error.code = 'MAX_TOKENS';
    return error;
  }
  return undefined;
}

function summaryText(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (list.some(block => block?.type === 'image')) throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT');
  return list.filter(block => block?.type === 'text');
}

export default class CompactionEngine extends BasicCompactionEngine {
  static inject = [...BasicCompactionEngine.inject, 'tools'];

  constructor(ctx, config = {}) {
    super(ctx, config);
    const origin = HOST_MODULES.source === 'env'
      ? 'env overrides'
      : 'dsh ' + (HOST_MODULES.runtimeVersion ?? '?') + ' @ ' + (HOST_MODULES.versionRoot ?? '?');
    this.ctx.logger.info(
      '[compaction-engine] host modules: ' + origin +
      '; base ' + (HOST_MODULES.basicVersion ?? '?') +
      '; tools ' + (HOST_MODULES.toolsVersion ?? '?'),
    );
    this.registerMemoryRead();
  }

  registerMemoryRead() {
    if (this.ctx.tools.get('memory_read') !== undefined) return;
    const dispose = this.ctx.tools.register(defineTool({
      name: 'memory_read',
      description: 'Return one original session event by its numeric seq. Use it to verify facts omitted as tool-result pointers; do not guess from a summary.',
      parameters: {
        seq: { type: 'integer', required: true, description: 'Session event seq to read.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            seq: { type: 'integer', required: true, description: 'Read seq.' },
            type: { type: 'string', required: true, description: 'Session event type.' },
            content: { type: 'string', required: true, description: 'Canonical JSON of the event data.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: 'seq=' + value.seq + ' type=' + value.type + '\n' + value.content }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('memory_read requires an agent session');
        const event = exec.agent.session.eventAt(args.seq);
        if (event === undefined) throw new Error('memory_read: no event at seq ' + args.seq);
        const content = JSON.stringify(event.data);
        return { seq: event.seq, type: event.type, content: content.length > 12000 ? content.slice(0, 12000) + '…[truncated]' : content };
      },
    }));
    this.ctx.on('dispose', dispose);
  }

  static Config = BasicCompactionEngine.Config;

  async summarizePtc(input, agent, signal, instruction) {
    const config = this.config ?? {};
    const target = resolveSummarizationTarget(agent, config);
    if (target === undefined) throw new Error('no provider/model available for PTC summarization');
    const assembler = new BlockAssembler();
    const messages = [...(input.messages ?? []), { role: 'user', content: [{ type: 'text', text: instruction }] }];
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: agent?.session?.toolHistory?.(),
      ...(Array.isArray(input.tools) ? { tools: [...input.tools] } : {}),
      maxTokens: config.maxTokens,
      sessionId: agent?.session?.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    };
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
    const error = finishError(assembler.finish);
    if (error !== undefined) throw error;
    const rawOutput = assembler.blocks();
    const summary = summaryText(rawOutput);
    if (!summary.some(block => String(block?.text ?? '').trim().length > 0)) {
      throw new Error('summarization produced no text summary content');
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens: config.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    };
  }

  async shouldPointerize(input, agent, signal) {
    try {
      const config = this.config ?? {};
      const target = resolveSummarizationTarget(agent, config);
      if (target === undefined) return false;
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
      const window = info?.context?.contextWindow;
      if (!Number.isInteger(window) || window <= 0) return false;
      const jsonTokens = (value) => {
        try { return estimateInputTokens([{ content: [{ type: 'text', text: JSON.stringify(value ?? null) }] }]); }
        catch { return 0; }
      };
      const messageTokens = estimateInputTokens(input.messages);
      const toolHistoryTokens = jsonTokens(agent?.session?.toolHistory?.());
      const toolsTokens = jsonTokens(input.tools);
      const reserved = Number(config.maxTokens);
      const completionReserve = Number.isFinite(reserved) && reserved > 0 ? reserved : 0;
      const usable = window - completionReserve - Math.ceil(window * 0.05);
      return messageTokens + toolHistoryTokens + toolsTokens > usable;
    } catch {
      return false;
    }
  }

  auditDraft(result, context) {
    const text = textOfSummary(result.summary);
    const findings = [];
    const required = ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code', 'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context', 'Temporal Facts'];
    for (const section of required) {
      if (!text.includes('## ' + section)) findings.push({ code: 'missing_section', detail: section });
    }
    const facts = text.includes('## Temporal Facts');
    if (facts) {
      const factCheck = validateAndCorrectTemporalFacts(text, context.input, context.messageIndex, context.session);
      for (const item of factCheck.corrections) findings.push({ code: 'source_corrected', detail: item });
      for (const item of factCheck.unverified) {
        const hint = /kind\s*=\s*state\b/i.test(item) ? '; state needs an assistant/tool source or kind=requirement' : '';
        findings.push({ code: 'unverified_fact', detail: item + hint });
      }
      const verifiedState = Number(factCheck.verifiedState ?? 0);
      if (verifiedState === 0) findings.push({ code: 'no_verified_state_fact', detail: 'Temporal Facts has no state fact with a matching assistant/tool source' });
    }
    return { findings };
  }

  async summarize(input, agent, signal) {
    const preset = agent?.session?.header?.agentPreset;
    if (preset !== 'ptc') return super.summarize(input, agent, signal);
    const session = agent?.session;
    const toolResults = collectToolResults(session);
    const messageIndex = buildMessageIndex(session);
    const retained = collectRetainedTail(session, input, messageIndex);
    const current = collectCurrentContext(session, input);
    const sourceMessages = current.messages;
    let messages = sourceMessages;
    const currentInput = { ...input, messages };
    const anchors = selectAnchorEntries(currentInput, messageIndex, toolResults);
    const language = detectSummaryLanguage(session);
    const inventory = await readToolInventory(agent);
    const hotPrompt = readHotPrompt();
    if (hotPrompt.text.length > 0) {
      this.ctx.logger.info('[compaction-engine] hot prompt loaded: ' + hotPrompt.path + ' sha256=' + hotPrompt.hash);
    }
    const instruction = buildPtcInstruction({
      language,
      anchors: renderAnchors(anchors),
      pointers: renderPointers(anchors),
      styleContract: STYLE_CONTRACT,
      hotPrompt: hotPrompt.text,
    });
    let emergency = false;
    if (await this.shouldPointerize(currentInput, agent, signal)) {
      emergency = true;
      messages = pointerizeMessages(messages, toolResults);
    }
    if (current.fromSession) {
      messages = [
        ...messages,
        { role: 'user', content: [{ type: 'text', text: renderCurrentContextBoundary(retained) }] },
      ];
    } else if (retained.messages.length > 0) {
      messages = [
        ...messages,
        { role: 'user', content: [{ type: 'text', text: renderRetainedTailBoundary(retained) }] },
        ...retained.messages,
        { role: 'user', content: [{ type: 'text', text: renderRetainedTailState(retained) }] },
      ];
    }
    let result;
    try {
      result = await this.summarizePtc({ ...input, messages }, agent, signal, instruction);
      if (emergency) {
        const readSeqs = extractReadRequests(textOfSummary(result.summary));
        if (readSeqs.length > 0 && readSeqs.length <= 8) {
          const readMessage = {
            role: 'user',
            content: [{ type: 'text', text: 'Read results requested by the draft. Use them as evidence; do not emit another READ request.\n\n' + readResultsFor(readSeqs, toolResults).join('\n\n') }],
          };
          result = await this.summarizePtc({ ...input, messages: [...messages, readMessage] }, agent, signal, instruction);
        }
      }
    } catch (error) {
      this.ctx.logger.warn('[compaction-engine] PTC summarize failed, falling back to base: ' + (error && error.message ? error.message : String(error)));
      result = await super.summarize({ ...input, messages }, agent, signal);
    }
    let reviewFindings = [];
    if (this.config?.reviewPass !== false) {
      try {
        const draftResult = result;
        const audit = this.auditDraft(result, { input, messageIndex, session });
        if (audit.findings.length > 0) {
          const notes = audit.findings.map(item => '- ' + item.code + ': ' + item.detail).join('\n');
          const reviewMessage = {
            role: 'user',
            content: [{ type: 'text', text: [
              'EXTERNAL REVIEW NOTES — not part of the checkpoint output',
              notes,
              '',
              'DRAFT CHECKPOINT:',
              textOfSummary(result.summary),
              '',
              'Apply these review notes to the draft. Keep the draft as the body: preserve its concrete history, user wording, corrections, and length. Do not summarize the draft again, do not add a review section, and do not self-audit. Return only the corrected checkpoint. For a state fact, cite an assistant or tool event; if the only evidence is a user instruction, use kind=requirement or remove the fact.',
            ].join('\n') }],
          };
          const revised = await this.summarizePtc({ ...input, messages: [...messages, reviewMessage] }, agent, signal, instruction);
          const postReview = this.auditDraft(revised, { input, messageIndex, session });
          const missing = postReview.findings.filter(item => item.code === 'missing_section');
          if (missing.length > 0) {
            result = draftResult;
            reviewFindings = postReview.findings;
            this.ctx.logger.warn('[compaction-engine] external review rejected: missing sections; draft kept');
          } else {
            result = revised;
            reviewFindings = postReview.findings;
            this.ctx.logger.info('[compaction-engine] external review applied: ' + audit.findings.length + ' finding(s); post-review ' + postReview.findings.length + ' finding(s)');
          }
        }
      } catch (error) {
        this.ctx.logger.warn('[compaction-engine] external review skipped: ' + (error && error.message ? error.message : String(error)));
      }
    }
    const modelText = textOfSummary(result.summary);
    const factCheck = validateAndCorrectTemporalFacts(modelText, { ...input, messages: sourceMessages }, messageIndex, session);
    if (factCheck.text !== modelText) {
      result = { ...result, summary: [{ type: 'text', text: factCheck.text }] };
    }
    let audit = factCheck.audit;
    if (reviewFindings.length > 0) {
      const lines = reviewFindings.map(item => '- review: ' + item.code + ': ' + item.detail).join('\n');
      audit = (audit.length > 0 ? audit + '\n' : '## Fact Audit\n') + lines;
    }
    const evidenceIndex = buildEvidenceIndex(anchors, textOfSummary(result.summary), estimateInputTokens(sourceMessages));
    const stateBoundary = retained.messages.length > 0 ? renderStateBoundary(retained, session) : '';
    return { ...result, summary: appendSummarySuffix(result.summary, agent, inventory, evidenceIndex, stateBoundary, audit) };
  }
}


const TOOL_POINTER_PATTERN = /\[\[TOOL_RESULT seq=(\d+) tool=([^ ]+) status=([^ ]+)(?: tokens=(\d+))?(?: summary="([^"]*)")? read=memory_read\(seq=\1\)\]\]/g;
const READ_PATTERN = /READ seq=(\d+)/g;

function formatToolPointer(seq, tool, status, tokens, summary) {
  const safeSummary = String(summary ?? '').replace(/"/g, "'");
  return '[[TOOL_RESULT seq=' + seq + ' tool=' + tool + ' status=' + status
    + (Number.isFinite(tokens) ? ' tokens=' + tokens : '')
    + (safeSummary ? ' summary="' + safeSummary + '"' : '')
    + ' read=memory_read(seq=' + seq + ')]]';
}

function extractReadRequests(text) {
  const found = [];
  const seen = new Set();
  for (const match of String(text ?? '').matchAll(READ_PATTERN)) {
    const seq = Number(match[1]);
    if (Number.isSafeInteger(seq) && !seen.has(seq)) {
      seen.add(seq);
      found.push(seq);
    }
  }
  return found;
}

function buildReloadCheckpoint(skillNames) {
  const names = Array.isArray(skillNames) ? skillNames : [];
  return [
    '## Reload Skills Checkpoint',
    names.length === 0
      ? '- no previously loaded skill needs reloading'
      : names.map(name => '- reload required: ' + name).join('\n'),
  ].join('\n');
}


function collectToolResults(session) {
  const map = new Map();
  const names = new Map();
  const total = Number(session?.seq ?? 0);
  for (let seq = 0; seq < total; seq += 1) {
    const event = session.eventAt?.(seq);
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      names.set(event.data.callId, event.data.name);
    } else if (event?.type === 'tool/ptc-dispatch' && typeof event.data?.subCallId === 'string') {
      names.set(event.data.subCallId, event.data.name);
    }
  }
  for (let seq = 0; seq < total; seq += 1) {
    const event = session.eventAt?.(seq);
    if (event?.type !== 'tool/result') continue;
    const message = event.data?.message;
    // 0.2.2 records the call id under data.message.toolCallId; the flat
    // data.toolCallId shape is kept for older fixtures and harnesses.
    const toolCallId = event.data?.toolCallId ?? message?.toolCallId;
    if (typeof toolCallId !== 'string') continue;
    const text = (message?.content ?? [])
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('\n');
    const tool = names.get(message?.source?.callId) ?? names.get(toolCallId) ?? 'tool';
    map.set(toolCallId, {
      seq: event.seq,
      tool,
      text,
      isError: (event.data?.isError ?? message?.isError) === true,
    });
  }
  return map;
}

function pointerizeMessages(messages, toolResults, thresholdChars = 2000) {
  return messages.map(message => {
    if (message?.role !== 'tool') return message;
    const result = toolResults.get(message.toolCallId);
    if (result === undefined || result.text.length <= thresholdChars) return message;
    const pointer = formatToolPointer(result.seq, result.tool ?? 'tool', result.isError ? 'error' : 'ok', undefined, 'output omitted; read original');
    return { ...message, content: [{ type: 'text', text: pointer }] };
  });
}

function readResultsFor(seqs, toolResults) {
  const bySeq = new Map([...toolResults.values()].map(result => [result.seq, result]));
  return seqs.map(seq => {
    const result = bySeq.get(seq);
    if (result === undefined) return '[[READ seq=' + seq + ' not found]]';
    const bounded = result.text.length > 4000 ? result.text.slice(0, 4000) + '\n…[truncated]' : result.text;
    return '[[READ seq=' + seq + ' tool-result]]\n' + bounded;
  });
}

function buildInventory({ skills, tools, loadedSchemas, evicted, requiredTools } = {}) {
  return {
    skills: Array.isArray(skills) ? [...new Set(skills)] : [],
    tools: Array.isArray(tools) ? [...tools] : [],
    loadedSchemas: Array.isArray(loadedSchemas) ? [...loadedSchemas] : [],
    evicted: Array.isArray(evicted) ? [...evicted] : [],
    requiredTools: Array.isArray(requiredTools) ? [...new Set(requiredTools)] : [],
  };
}

export { appendSummarySuffix, buildContract, buildEvidenceIndex, buildInventory, buildMessageIndex, buildPtcInstruction, buildReloadCheckpoint, collectCurrentContext, collectRetainedTail, collectToolResults, companionStatus, detectSummaryLanguage, estimateInputTokens, extractLoadedSkills, extractReadRequests, formatCompanionStatus, formatToolPointer, pointerizeMessages, readResultsFor, readToolInventory, renderAnchors, renderCurrentContextBoundary, renderPointers, renderRetainedTailBoundary, renderRetainedTailState, renderStateBoundary, selectAnchorEntries, validateAndCorrectTemporalFacts, HISTORY_DECLARATION, STYLE_CONTRACT, HOST_MODULES, resolveHostModules };
