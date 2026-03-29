// ==================== STATE ====================
const STATE = {
  conversations: [],
  activeConvId: null,
  streamController: null,
  isStreaming: false,
  attachments: [],
  artifacts: [],
  activeArtifactIndex: 0,
  artifactEditMode: false,
  memory: '',
  settings: {},
  params: {
    temperature: 1,
    max_tokens: 4096,
    top_p: 1,
    top_k: null,
    frequency_penalty: 0,
    presence_penalty: 0,
    stop_sequences: '',
    seed: null,
    extended_thinking: false,
    thinking_budget: 8000,
    json_mode: false,
  },
  templates: [],
  spLibrary: [],
  slashDropdownIndex: -1,
  convSearchMatches: [],
  convSearchIndex: 0,
  compareMode: false,
  voiceListening: false,
  voiceRecognition: null,
  branches: {},        // convId -> array of branch points
  editingTemplateId: null,
};

const DEFAULTS = {
  settings: {
    theme: 'dark',
    accent: 'cyan',
    fontSize: 'medium',
    chatStyle: 'bubbles',
    hljsTheme: 'github-dark',
    sendKey: 'enter',
    autoTitle: true,
    autoScroll: true,
    showTokens: true,
    notifications: false,
    defaultProvider: 'anthropic',
    defaultModel: '',
    defaultSystemPrompt: '',
    maxConversations: 100,
    customCSS: '',
    userName: 'User',
  },
};

// ==================== PROVIDERS ====================
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1/messages',
    authType: 'x-api-key',
    models: [
      { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', ctx: 200000, vision: true, cost: 'paid' },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', ctx: 200000, vision: true, cost: 'paid' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', ctx: 200000, vision: true, cost: 'paid' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', ctx: 200000, vision: true, cost: 'paid' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', ctx: 200000, vision: true, cost: 'paid' },
    ],
    supportedFeatures: { vision: true, files: true, streaming: true, functionCalling: true, thinking: true },
    buildRequest(messages, params, systemPrompt) {
      const sysContent = systemPrompt ? [{ type: 'text', text: systemPrompt }] : undefined;
      const msgs = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role,
        content: buildAnthropicContent(m),
      }));
      const body = {
        model: STATE.settings.currentModel || 'claude-sonnet-4-6',
        max_tokens: params.max_tokens || 4096,
        messages: msgs,
        stream: true,
      };
      if (sysContent) body.system = sysContent;
      if (params.temperature !== undefined) body.temperature = params.temperature;
      if (params.top_p !== undefined && params.top_p !== 1) body.top_p = params.top_p;
      if (params.top_k) body.top_k = params.top_k;
      if (params.stop_sequences) body.stop_sequences = params.stop_sequences.split(',').map(s => s.trim()).filter(Boolean);
      if (params.extended_thinking) {
        body.thinking = { type: 'enabled', budget_tokens: params.thinking_budget || 8000 };
        delete body.temperature;
      }
      return body;
    },
    parseStreamChunk(chunk) {
      const results = [];
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta') {
            if (parsed.delta?.type === 'text_delta') results.push({ delta: parsed.delta.text, done: false, type: 'text' });
            else if (parsed.delta?.type === 'thinking_delta') results.push({ delta: parsed.delta.thinking, done: false, type: 'thinking' });
          } else if (parsed.type === 'message_stop') {
            results.push({ delta: '', done: true });
          } else if (parsed.type === 'message_delta' && parsed.usage) {
            results.push({ usage: parsed.usage, done: false });
          }
        } catch {}
      }
      return results;
    },
    getHeaders(key) {
      return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' };
    },
  },

  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1/chat/completions',
    authType: 'bearer',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', ctx: 128000, vision: true, cost: 'paid' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', ctx: 128000, vision: true, cost: 'paid' },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', ctx: 128000, vision: true, cost: 'paid' },
      { id: 'o1', label: 'o1 (Reasoning)', ctx: 200000, vision: false, cost: 'paid' },
      { id: 'o1-mini', label: 'o1-mini', ctx: 128000, vision: false, cost: 'paid' },
      { id: 'o3-mini', label: 'o3-mini', ctx: 200000, vision: false, cost: 'paid' },
      { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', ctx: 16385, vision: false, cost: 'paid' },
    ],
    supportedFeatures: { vision: true, files: false, streaming: true, functionCalling: true, thinking: false },
    buildRequest(messages, params, systemPrompt) {
      const msgs = buildOpenAIMessages(messages, systemPrompt);
      const body = {
        model: STATE.settings.currentModel || 'gpt-4o',
        messages: msgs,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (params.temperature !== undefined) body.temperature = Math.min(params.temperature, 2);
      if (params.max_tokens) body.max_tokens = params.max_tokens;
      if (params.top_p !== 1) body.top_p = params.top_p;
      if (params.frequency_penalty) body.frequency_penalty = params.frequency_penalty;
      if (params.presence_penalty) body.presence_penalty = params.presence_penalty;
      if (params.seed) body.seed = params.seed;
      if (params.stop_sequences) body.stop = params.stop_sequences.split(',').map(s => s.trim()).filter(Boolean);
      if (params.json_mode) body.response_format = { type: 'json_object' };
      return body;
    },
    parseStreamChunk(chunk) {
      const results = [];
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { results.push({ delta: '', done: true }); continue; }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          const finishReason = parsed.choices?.[0]?.finish_reason;
          if (parsed.usage) results.push({ usage: { output_tokens: parsed.usage.completion_tokens, input_tokens: parsed.usage.prompt_tokens }, done: false });
          results.push({ delta, done: finishReason === 'stop' || finishReason === 'length', type: 'text' });
        } catch {}
      }
      return results;
    },
    getHeaders(key) {
      return { 'Authorization': `Bearer ${key}`, 'content-type': 'application/json' };
    },
  },

  gemini: {
    name: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/models',
    authType: 'url-key',
    models: [
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', ctx: 1048576, vision: true, cost: 'free' },
      { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', ctx: 1048576, vision: true, cost: 'free' },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', ctx: 2097152, vision: true, cost: 'paid' },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', ctx: 1048576, vision: true, cost: 'free' },
    ],
    supportedFeatures: { vision: true, files: false, streaming: true, functionCalling: true, thinking: false },
    buildRequest(messages, params, systemPrompt) {
      const contents = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: buildGeminiParts(m),
      }));
      const body = { contents, generationConfig: {} };
      if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
      if (params.temperature !== undefined) body.generationConfig.temperature = params.temperature;
      if (params.max_tokens) body.generationConfig.maxOutputTokens = params.max_tokens;
      if (params.top_p !== 1) body.generationConfig.topP = params.top_p;
      if (params.top_k) body.generationConfig.topK = params.top_k;
      if (params.stop_sequences) body.generationConfig.stopSequences = params.stop_sequences.split(',').map(s => s.trim()).filter(Boolean);
      return body;
    },
    getURL(key, model) {
      return `${this.baseURL}/${model}:streamGenerateContent?key=${key}&alt=sse`;
    },
    parseStreamChunk(chunk) {
      const results = [];
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const done = parsed.candidates?.[0]?.finishReason === 'STOP';
          if (parsed.usageMetadata) results.push({ usage: { input_tokens: parsed.usageMetadata.promptTokenCount, output_tokens: parsed.usageMetadata.candidatesTokenCount }, done: false });
          results.push({ delta: text, done, type: 'text' });
        } catch {}
      }
      return results;
    },
    getHeaders() { return { 'content-type': 'application/json' }; },
  },

  groq: {
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1/chat/completions',
    authType: 'bearer',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', ctx: 128000, vision: false, cost: 'free' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', ctx: 128000, vision: false, cost: 'free' },
      { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B', ctx: 32768, vision: false, cost: 'free' },
      { id: 'gemma2-9b-it', label: 'Gemma 2 9B', ctx: 8192, vision: false, cost: 'free' },
      { id: 'llama-3.2-90b-vision-preview', label: 'Llama 3.2 90B Vision', ctx: 128000, vision: true, cost: 'free' },
    ],
    supportedFeatures: { vision: true, files: false, streaming: true, functionCalling: true, thinking: false },
    buildRequest: null, // Delegated to openAICompatBuild
    parseStreamChunk: null,
    getHeaders(key) { return { 'Authorization': `Bearer ${key}`, 'content-type': 'application/json' }; },
  },

  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1/chat/completions',
    authType: 'bearer',
    models: [
      { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', ctx: 200000, vision: true, cost: 'paid' },
      { id: 'deepseek/deepseek-chat-v3-0324:free', label: 'DeepSeek V3 (Free)', ctx: 65536, vision: false, cost: 'free' },
      { id: 'google/gemini-2.0-flash-exp:free', label: 'Gemini 2.0 Flash (Free)', ctx: 1048576, vision: true, cost: 'free' },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (Free)', ctx: 131072, vision: false, cost: 'free' },
      { id: 'mistralai/mistral-small-3.1-24b-instruct:free', label: 'Mistral Small (Free)', ctx: 128000, vision: true, cost: 'free' },
      { id: 'openai/gpt-4o', label: 'GPT-4o', ctx: 128000, vision: true, cost: 'paid' },
      { id: 'custom', label: '✏ Custom Model ID…', ctx: null, vision: null, cost: null },
    ],
    supportedFeatures: { vision: true, files: false, streaming: true, functionCalling: true, thinking: false },
    buildRequest: null,
    parseStreamChunk: null,
    getHeaders(key) {
      return { 'Authorization': `Bearer ${key}`, 'content-type': 'application/json', 'HTTP-Referer': location.href, 'X-Title': 'NexusAI' };
    },
  },

  mistral: {
    name: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1/chat/completions',
    authType: 'bearer',
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large', ctx: 128000, vision: false, cost: 'paid' },
      { id: 'mistral-small-latest', label: 'Mistral Small', ctx: 128000, vision: false, cost: 'paid' },
      { id: 'codestral-latest', label: 'Codestral', ctx: 256000, vision: false, cost: 'paid' },
      { id: 'open-mistral-nemo', label: 'Mistral Nemo (Free)', ctx: 128000, vision: false, cost: 'free' },
    ],
    supportedFeatures: { vision: false, files: false, streaming: true, functionCalling: true, thinking: false },
    buildRequest: null,
    parseStreamChunk: null,
    getHeaders(key) { return { 'Authorization': `Bearer ${key}`, 'content-type': 'application/json' }; },
  },

  cohere: {
    name: 'Cohere',
    baseURL: 'https://api.cohere.com/v2/chat',
    authType: 'bearer',
    models: [
      { id: 'command-r-plus-08-2024', label: 'Command R+ 08-2024', ctx: 128000, vision: false, cost: 'paid' },
      { id: 'command-r-08-2024', label: 'Command R 08-2024', ctx: 128000, vision: false, cost: 'paid' },
      { id: 'command-r7b-12-2024', label: 'Command R7B', ctx: 128000, vision: false, cost: 'paid' },
    ],
    supportedFeatures: { vision: false, files: false, streaming: true, functionCalling: true, thinking: false },
    buildRequest(messages, params, systemPrompt) {
      const msgs = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: getTextContent(m),
      }));
      const body = {
        model: STATE.settings.currentModel || 'command-r-plus-08-2024',
        messages: msgs, stream: true,
      };
      if (systemPrompt) body.system = systemPrompt;
      if (params.temperature !== undefined) body.temperature = params.temperature;
      if (params.max_tokens) body.max_tokens = params.max_tokens;
      if (params.top_p !== 1) body.p = params.top_p;
      if (params.top_k) body.k = params.top_k;
      if (params.stop_sequences) body.stop_sequences = params.stop_sequences.split(',').map(s => s.trim()).filter(Boolean);
      return body;
    },
    parseStreamChunk(chunk) {
      const results = [];
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'content-delta') results.push({ delta: parsed.delta?.message?.content?.text || '', done: false, type: 'text' });
          else if (parsed.type === 'message-end') results.push({ delta: '', done: true });
        } catch {}
      }
      return results;
    },
    getHeaders(key) { return { 'Authorization': `Bearer ${key}`, 'content-type': 'application/json' }; },
  },

  together: {
    name: 'Together AI',
    baseURL: 'https://api.together.xyz/v1/chat/completions',
    authType: 'bearer',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', label: 'Llama 3.3 70B (Free)', ctx: 131072, vision: false, cost: 'free' },
      { id: 'meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo', label: 'Llama 3.2 90B Vision', ctx: 131072, vision: true, cost: 'paid' },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', label: 'Qwen 2.5 72B', ctx: 32768, vision: false, cost: 'paid' },
      { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', label: 'Mixtral 8x7B', ctx: 32768, vision: false, cost: 'paid' },
    ],
    supportedFeatures: { vision: true, files: false, streaming: true, functionCalling: false, thinking: false },
    buildRequest: null,
    parseStreamChunk: null,
    getHeaders(key) { return { 'Authorization': `Bearer ${key}`, 'content-type': 'application/json' }; },
  },

  ollama: {
    name: 'Ollama / Custom',
    baseURL: 'http://localhost:11434/v1/chat/completions',
    authType: 'none',
    models: [
      { id: 'llama3.2', label: 'llama3.2 (local)', ctx: 128000, vision: false, cost: 'free' },
      { id: 'qwen2.5:7b', label: 'qwen2.5:7b (local)', ctx: 32768, vision: false, cost: 'free' },
      { id: 'mistral', label: 'mistral (local)', ctx: 32768, vision: false, cost: 'free' },
      { id: 'custom', label: '✏ Custom Model ID…', ctx: null, vision: null, cost: null },
    ],
    supportedFeatures: { vision: false, files: false, streaming: true, functionCalling: false, thinking: false },
    buildRequest: null,
    parseStreamChunk: null,
    getHeaders() { return { 'content-type': 'application/json' }; },
    customBaseURL: '',
  },
};

// OpenAI-compatible shared build (used by groq, openrouter, mistral, together, ollama)
function openAICompatBuild(provider, messages, params, systemPrompt) {
  const msgs = buildOpenAIMessages(messages, systemPrompt);
  const body = {
    model: STATE.settings.currentModel || provider.models[0]?.id,
    messages: msgs, stream: true,
  };
  if (params.temperature !== undefined) body.temperature = Math.min(params.temperature, 2);
  if (params.max_tokens) body.max_tokens = params.max_tokens;
  if (params.top_p !== 1) body.top_p = params.top_p;
  if (params.frequency_penalty) body.frequency_penalty = params.frequency_penalty;
  if (params.presence_penalty) body.presence_penalty = params.presence_penalty;
  if (params.seed) body.seed = params.seed;
  if (params.stop_sequences) body.stop = params.stop_sequences.split(',').map(s => s.trim()).filter(Boolean);
  if (params.json_mode) body.response_format = { type: 'json_object' };
  return body;
}
function openAICompatParseChunk(chunk) {
  return PROVIDERS.openai.parseStreamChunk(chunk);
}
['groq','openrouter','mistral','together','ollama'].forEach(k => {
  PROVIDERS[k].buildRequest = (m, p, s) => openAICompatBuild(PROVIDERS[k], m, p, s);
  PROVIDERS[k].parseStreamChunk = openAICompatParseChunk;
});

// Pricing table (per 1M tokens, USD) - for cost estimator
const PRICING = {
  'claude-opus-4-5': { in: 15, out: 75 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 0.25, out: 1.25 },
  'gpt-4o': { in: 5, out: 15 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4-turbo': { in: 10, out: 30 },
  'o1': { in: 15, out: 60 },
  'o3-mini': { in: 1.1, out: 4.4 },
  'gemini-2.0-flash': { in: 0, out: 0 },
  'gemini-1.5-pro': { in: 3.5, out: 10.5 },
  'llama-3.3-70b-versatile': { in: 0, out: 0 },
  'mistral-large-latest': { in: 2, out: 6 },
  'command-r-plus-08-2024': { in: 2.5, out: 10 },
};

// Context window sizes (also stored in model meta)
function getModelCtx(provider, modelId) {
  const p = PROVIDERS[provider];
  if (!p) return 4096;
  const m = p.models.find(m => m.id === modelId);
  return m?.ctx ?? 128000;
}

// ==================== MESSAGE CONTENT BUILDERS ====================
function buildAnthropicContent(msg) {
  const parts = [];
  for (const c of msg.content) {
    if (c.type === 'text') parts.push({ type: 'text', text: c.text });
    else if (c.type === 'image') parts.push({ type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } });
    else if (c.type === 'file' && c.mediaType === 'application/pdf') parts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: c.data } });
    else if (c.type === 'file') parts.push({ type: 'text', text: `[File: ${c.name}]\n${c.extractedText || ''}` });
  }
  return parts;
}

function buildOpenAIMessages(messages, systemPrompt) {
  const result = [];
  if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
  for (const m of messages.filter(x => x.role !== 'system')) {
    const hasImages = m.content.some(c => c.type === 'image');
    const hasFiles = m.content.some(c => c.type === 'file');
    if (hasImages || hasFiles) {
      const parts = [];
      for (const c of m.content) {
        if (c.type === 'text') parts.push({ type: 'text', text: c.text });
        else if (c.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${c.mediaType};base64,${c.data}` } });
        else if (c.type === 'file') parts.push({ type: 'text', text: `[File: ${c.name}]\n${c.extractedText || ''}` });
      }
      result.push({ role: m.role, content: parts });
    } else {
      result.push({ role: m.role, content: getTextContent(m) });
    }
  }
  return result;
}

function buildGeminiParts(msg) {
  const parts = [];
  for (const c of msg.content) {
    if (c.type === 'text') parts.push({ text: c.text });
    else if (c.type === 'image') parts.push({ inline_data: { mime_type: c.mediaType, data: c.data } });
    else if (c.type === 'file') parts.push({ text: `[File: ${c.name}]\n${c.extractedText || ''}` });
  }
  return parts;
}

function getTextContent(msg) {
  return msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

// ==================== STORAGE ====================
const STORE = {
  save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) { toast('Storage full — some data may not be saved.', 'warning'); } },
  load(key, fallback) { try { const v = localStorage.getItem(key); return v != null ? JSON.parse(v) : fallback; } catch { return fallback; } },
  remove(key) { localStorage.removeItem(key); },
  clear() { localStorage.clear(); },
  saveConversations() { STORE.save('nexus_conversations', STATE.conversations); },
  loadConversations() { STATE.conversations = STORE.load('nexus_conversations', []); },
  saveSettings() { STORE.save('nexus_settings', STATE.settings); },
  loadSettings() { STATE.settings = { ...DEFAULTS.settings, ...STORE.load('nexus_settings', {}) }; },
  saveMemory() { STORE.save('nexus_memory', STATE.memory); },
  loadMemory() { STATE.memory = STORE.load('nexus_memory', ''); },
  saveParams() { STORE.save('nexus_params', STATE.params); },
  loadParams() { STATE.params = { ...STATE.params, ...STORE.load('nexus_params', {}) }; },
  saveTemplates() { STORE.save('nexus_templates', STATE.templates); },
  loadTemplates() { STATE.templates = STORE.load('nexus_templates', getDefaultTemplates()); },
  saveSPLibrary() { STORE.save('nexus_sp_library', STATE.spLibrary); },
  loadSPLibrary() { STATE.spLibrary = STORE.load('nexus_sp_library', []); },
  saveBranches() { STORE.save('nexus_branches', STATE.branches); },
  loadBranches() { STATE.branches = STORE.load('nexus_branches', {}); },
  saveApiKeys(keys) { STORE.save('nexus_api_keys', keys); },
  loadApiKeys() { return STORE.load('nexus_api_keys', {}); },
};

function getDefaultTemplates() {
  return [
    { id: uid(), name: 'Code Review', icon: '🔍', content: 'Please review the following code and suggest improvements:\n\n' },
    { id: uid(), name: 'Explain Like I\'m 5', icon: '👶', content: 'Explain the following in very simple terms, like I\'m 5 years old:\n\n' },
    { id: uid(), name: 'Refactor', icon: '♻️', content: 'Refactor the following code to be cleaner and more maintainable:\n\n' },
    { id: uid(), name: 'Write Tests', icon: '🧪', content: 'Write comprehensive unit tests for the following:\n\n' },
    { id: uid(), name: 'Summarize', icon: '📝', content: 'Summarize the following in 3-5 bullet points:\n\n' },
    { id: uid(), name: 'Translate', icon: '🌐', content: 'Translate the following text to English:\n\n' },
  ];
}

// ==================== UTILS ====================
function uid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36); }
function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function estimateTokens(text) { return Math.ceil((text || '').length / 4); }
function formatDate(ts) { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function formatTime(ts) { return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }

function expandSystemPromptVars(text) {
  const now = new Date();
  return text
    .replace(/\{\{date\}\}/g, now.toLocaleDateString())
    .replace(/\{\{time\}\}/g, now.toLocaleTimeString())
    .replace(/\{\{user_name\}\}/g, STATE.settings.userName || 'User');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a safe delay — long enough for any browser/device to initiate the download
  setTimeout(() => URL.revokeObjectURL(url), 250);
}

function getActiveConversation() { return STATE.conversations.find(c => c.id === STATE.activeConvId) || null; }

function getFullSystemPrompt(conv) {
  let parts = [];
  if (STATE.memory) parts.push(`[Memory]\n${STATE.memory}`);
  const sp = conv?.systemPrompt || STATE.settings.defaultSystemPrompt || '';
  if (sp) parts.push(expandSystemPromptVars(sp));
  if (STATE.params.json_mode) parts.push('You must respond ONLY with valid JSON. No markdown, no preamble, no explanation.');
  return parts.join('\n\n') || null;
}

// AES-GCM encryption helpers
async function encryptData(plaintext, password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const out = { salt: Array.from(salt), iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) };
  return JSON.stringify(out);
}

async function decryptData(encryptedStr, password) {
  const { salt, iv, data } = JSON.parse(encryptedStr);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new Uint8Array(salt), iterations: 100000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, new Uint8Array(data));
  return new TextDecoder().decode(decrypted);
}

// ==================== TOAST NOTIFICATIONS ====================
function toast(msg, type = 'info', duration = 3200) {
  const icons = { success: 'check-circle', error: 'alert-circle', warning: 'alert-triangle', info: 'info' };
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i data-lucide="${icons[type] || 'info'}"></i><span>${escapeHtml(msg)}</span>`;
  container.appendChild(el);
  lucide.createIcons({ nodes: [el] });
  setTimeout(() => {
    el.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ==================== CONVERSATION MANAGEMENT ====================
function createConversation(opts = {}) {
  const conv = {
    id: uid(),
    title: opts.title || 'New conversation',
    provider: opts.provider || STATE.settings.defaultProvider || 'anthropic',
    model: opts.model || STATE.settings.defaultModel || PROVIDERS[STATE.settings.defaultProvider || 'anthropic']?.models[0]?.id,
    systemPrompt: opts.systemPrompt || STATE.settings.defaultSystemPrompt || '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalTokens: { input: 0, output: 0 },
  };
  STATE.conversations.unshift(conv);
  enforceMaxConversations();
  STORE.saveConversations();
  return conv;
}

function enforceMaxConversations() {
  const max = parseInt(STATE.settings.maxConversations) || 100;
  if (STATE.conversations.length <= max) return;

  const removed = STATE.conversations.slice(max);
  STATE.conversations = STATE.conversations.slice(0, max);

  // If the active conversation was sliced off, switch to the newest remaining one
  const activeWasRemoved = removed.some(c => c.id === STATE.activeConvId);
  if (activeWasRemoved) {
    if (STATE.conversations.length > 0) {
      loadConversation(STATE.conversations[0].id);
    } else {
      STATE.activeConvId = null;
      UI.renderMessages([]);
      UI.showEmptyState(true);
    }
    toast('Oldest conversation removed to stay within the limit.', 'warning');
  }
}

function deleteConversation(id) {
  if (!confirm('Delete this conversation?')) return;
  STATE.conversations = STATE.conversations.filter(c => c.id !== id);
  STORE.saveConversations();
  if (STATE.activeConvId === id) {
    if (STATE.conversations.length > 0) loadConversation(STATE.conversations[0].id);
    else { STATE.activeConvId = null; UI.renderMessages([]); UI.showEmptyState(true); }
  }
  renderConvList();
}

function loadConversation(id) {
  const conv = STATE.conversations.find(c => c.id === id);
  if (!conv) return;
  STATE.activeConvId = id;
  STATE.settings.currentModel = conv.model;
  // Sync provider/model selectors
  const provSel = document.getElementById('provider-select');
  const modSel = document.getElementById('model-select');
  if (provSel.value !== conv.provider) {
    provSel.value = conv.provider;
    UI.populateModelSelect(conv.provider);
  }
  modSel.value = conv.model;
  UI.updateModelBadge(conv.provider, conv.model);
  // System prompt
  document.getElementById('system-prompt-input').value = conv.systemPrompt || '';
  UI.renderMessages(conv.messages);
  UI.showEmptyState(conv.messages.length === 0);
  UI.updateTokenBudget();
  renderConvList();
}

function getOrCreateActiveConv() {
  if (STATE.activeConvId) {
    const c = getActiveConversation();
    if (c) return c;
  }
  const provider = document.getElementById('provider-select').value || 'anthropic';
  const model = document.getElementById('model-select').value || PROVIDERS[provider]?.models[0]?.id;
  const conv = createConversation({ provider, model });
  STATE.activeConvId = conv.id;
  renderConvList();
  return conv;
}

function newChat() {
  STATE.activeConvId = null;
  STATE.attachments = [];
  STATE.artifacts = [];
  const inputEl = document.getElementById('user-input');
  inputEl.value = '';
  delete inputEl.dataset.replaceIndex; // clear any stale edit state
  document.getElementById('system-prompt-input').value = STATE.settings.defaultSystemPrompt || '';
  UI.renderMessages([]);
  UI.showEmptyState(true);
  UI.clearAttachmentsPreview();
  UI.closeArtifactPanel();
  UI.updateTokenBudget();
  renderConvList();
  inputEl.focus();
}

function renderConvList() {
  const list = document.getElementById('conv-list');
  const query = document.getElementById('conv-search').value.trim().toLowerCase();
  const convs = query ? STATE.conversations.filter(c => c.title.toLowerCase().includes(query) || c.messages.some(m => getTextContent(m).toLowerCase().includes(query))) : STATE.conversations;

  if (convs.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">${query ? 'No results' : 'No conversations yet'}</div>`;
    return;
  }

  // Group by date
  const now = Date.now();
  const groups = { Today: [], Yesterday: [], 'This Week': [], Older: [] };
  for (const c of convs) {
    const diff = now - c.updatedAt;
    const day = 86400000;
    if (diff < day) groups.Today.push(c);
    else if (diff < 2 * day) groups.Yesterday.push(c);
    else if (diff < 7 * day) groups['This Week'].push(c);
    else groups.Older.push(c);
  }

  let html = '';
  for (const [label, items] of Object.entries(groups)) {
    if (!items.length) continue;
    html += `<div class="conv-group-label">${label}</div>`;
    for (const c of items) {
      const active = c.id === STATE.activeConvId;
      const provColor = getProviderColor(c.provider);
      html += `<div class="conv-item${active ? ' active' : ''}" data-id="${c.id}" title="${escapeHtml(c.title)}">
        <div class="conv-provider-dot" style="background:${provColor}"></div>
        <div class="conv-item-inner">
          <div class="conv-title">${escapeHtml(c.title)}</div>
          <div class="conv-meta">${c.provider} · ${formatDate(c.updatedAt)}</div>
        </div>
        <button class="conv-delete-btn" data-del="${c.id}" title="Delete"><i data-lucide="trash-2" style="width:12px;height:12px"></i></button>
      </div>`;
    }
  }
  list.innerHTML = html;
  lucide.createIcons({ nodes: [list] });

  list.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', e => { if (!e.target.closest('.conv-delete-btn')) loadConversation(el.dataset.id); });
  });
  list.querySelectorAll('.conv-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); deleteConversation(btn.dataset.del); });
  });
}

function getProviderColor(provider) {
  const colors = { anthropic: '#c96a40', openai: '#10a37f', gemini: '#4285f4', groq: '#f55036', openrouter: '#a855f7', mistral: '#ff7000', cohere: '#3a86ff', together: '#e040fb', ollama: '#7cc5e0' };
  return colors[provider] || '#8b949e';
}

function autoTitle(conv) {
  if (!STATE.settings.autoTitle || conv.title !== 'New conversation') return;
  const firstUser = conv.messages.find(m => m.role === 'user');
  if (!firstUser) return;
  const text = getTextContent(firstUser);
  conv.title = text.slice(0, 52).replace(/\n/g, ' ') + (text.length > 52 ? '…' : '');
  STORE.saveConversations();
  renderConvList();
}

function forkConversation(upToMsgIndex) {
  const conv = getActiveConversation();
  if (!conv) return;
  const forked = {
  STATE.conversations.unshift(forked);
  STORE.saveConversations();
  loadConversation(forked.id);
  toast('Conversation forked!', 'success');
}

// ==================== STREAMING ====================
async function sendMessage(opts = {}) {
  const conv = getOrCreateActiveConv();
  const inputEl = document.getElementById('user-input');
  const text = opts.text !== undefined ? opts.text : inputEl.value.trim();
  const attachments = opts.attachments || STATE.attachments;

  if (!text && attachments.length === 0) return;
  if (STATE.isStreaming) return;

  const provider = conv.provider || document.getElementById('provider-select').value;
  const model = conv.model || document.getElementById('model-select').value;
  const apiKeys = STORE.loadApiKeys();
  const key = apiKeys[provider];
  if (!key && provider !== 'ollama') {
    toast(`No API key for ${PROVIDERS[provider]?.name || provider}. Add one in Settings.`, 'error');
    return;
  }

  // Build user message
  const userMsg = {
    id: uid(), role: 'user',
    content: [],
    provider, model,
    timestamp: Date.now(),
    tokens: { input: 0, output: 0 },
    artifacts: [],
  };
  if (text) userMsg.content.push({ type: 'text', text });
  for (const att of attachments) userMsg.content.push(att);
  if (opts.replaceIndex !== undefined) {
    // Editing: branch from that point
    const oldMsg = conv.messages[opts.replaceIndex];
    if (oldMsg) {
      // Save branch
      if (!STATE.branches[conv.id]) STATE.branches[conv.id] = [];
      STATE.branches[conv.id].push({ at: opts.replaceIndex, snapshotTitle: `Branch at msg ${opts.replaceIndex}`, messages: conv.messages.slice() });
      STORE.saveBranches();
    }
    conv.messages = conv.messages.slice(0, opts.replaceIndex);
  }
  conv.messages.push(userMsg);
  conv.updatedAt = Date.now();
  conv.provider = provider;
  conv.model = model;
  conv.systemPrompt = document.getElementById('system-prompt-input').value;
  STATE.settings.currentModel = model;

  inputEl.value = '';
  STATE.attachments = [];
  UI.clearAttachmentsPreview();
  autoResize(inputEl);
  UI.updateCharCount();
  UI.renderMessages(conv.messages);
  UI.showEmptyState(false);
  UI.scrollToBottom();

  autoTitle(conv);

  // Assistant placeholder
  const asstMsg = {
    id: uid(), role: 'assistant',
    content: [{ type: 'text', text: '' }],
    provider, model,
    timestamp: Date.now(),
    tokens: { input: 0, output: 0 },
    artifacts: [], thinking: '',
  };
  conv.messages.push(asstMsg);
  const msgIndex = conv.messages.length - 1;
  UI.renderMessages(conv.messages);
  UI.scrollToBottom();
  STORE.saveConversations();

  STATE.isStreaming = true;
  UI.setStreaming(true);

  const providerObj = PROVIDERS[provider];
  const systemPrompt = getFullSystemPrompt(conv);
  let requestBody;
  try {
    requestBody = providerObj.buildRequest(conv.messages.slice(0, -1), STATE.params, systemPrompt);
  } catch (e) {
    finishStreamWithError(asstMsg, conv, msgIndex, 'Failed to build request: ' + e.message);
    return;
  }

  STATE.streamController = new AbortController();
  let url = providerObj.baseURL;
  let headers = providerObj.getHeaders(key);

  // Gemini URL override
  if (provider === 'gemini') url = providerObj.getURL(key, model);
  // Ollama / custom base URL
  if (provider === 'ollama' && STATE.settings.ollamaBaseURL) {
    url = STATE.settings.ollamaBaseURL.replace(/\/$/, '') + '/v1/chat/completions';
  }

  let fullText = '';
  let fullThinking = '';
  let inputTokens = 0, outputTokens = 0;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: STATE.streamController.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      let friendly = `HTTP ${resp.status}`;
      try { const j = JSON.parse(errBody); friendly = j.error?.message || j.message || friendly; } catch {}
      finishStreamWithError(asstMsg, conv, msgIndex, friendly);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Split on newlines but keep the last potentially-incomplete line in buffer
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline === -1) continue; // no complete line yet
      const chunk = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      const results = providerObj.parseStreamChunk(chunk);
      for (const r of results) {
        if (r.usage) { inputTokens = r.usage.input_tokens || inputTokens; outputTokens = r.usage.output_tokens || outputTokens; }
        if (r.type === 'thinking') { fullThinking += r.delta; asstMsg.thinking = fullThinking; }
        else if (r.delta) { fullText += r.delta; }
        if (r.done) break;
      }
      asstMsg.content[0].text = fullText;
      asstMsg.thinking = fullThinking;
      UI.updateStreamingMessage(asstMsg, msgIndex);
      if (STATE.settings.autoScroll) UI.scrollToBottom();
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      finishStreamWithError(asstMsg, conv, msgIndex, e.message);
      return;
    }
  } finally {
    STATE.isStreaming = false;
    STATE.streamController = null;
    UI.setStreaming(false);
  }

  // Finalize
  asstMsg.content[0].text = fullText;
  asstMsg.tokens = { input: inputTokens, output: outputTokens };
  asstMsg.artifacts = detectArtifacts(fullText);

  conv.totalTokens.input += inputTokens;
  conv.totalTokens.output += outputTokens;
  conv.updatedAt = Date.now();
  STORE.saveConversations();

  UI.renderMessages(conv.messages);
  UI.scrollToBottom();
  UI.updateTokenBudget();

  if (asstMsg.artifacts.length > 0) UI.openArtifactPanel(asstMsg.artifacts);
  if (STATE.settings.notifications && document.hidden) {
    notifyUser('NexusAI', fullText.slice(0, 80) + '…');
  }
}

function finishStreamWithError(asstMsg, conv, msgIndex, errMsg) {
  STATE.isStreaming = false;
  STATE.streamController = null;
  UI.setStreaming(false);
  asstMsg.error = errMsg;
  asstMsg.content[0].text = '';
  conv.updatedAt = Date.now();
  STORE.saveConversations();
  UI.renderMessages(conv.messages);
  toast('Error: ' + errMsg, 'error', 5000);
}

function stopStreaming() {
  if (STATE.streamController) STATE.streamController.abort();
}

function regenerate() {
  const conv = getActiveConversation();
  if (!conv || conv.messages.length < 2) return;

  // Find the last assistant message
  let asstIdx = -1;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].role === 'assistant') { asstIdx = i; break; }
  }
  if (asstIdx === -1) return;

  // Find the user message immediately preceding that assistant message
  let userIdx = -1;
  for (let i = asstIdx - 1; i >= 0; i--) {
    if (conv.messages[i].role === 'user') { userIdx = i; break; }
  }
  if (userIdx === -1) return;

  // Find last user message index — check BEFORE modifying anything
  const lastUserRevIdx = [...conv.messages].reverse().findIndex(m => m.role === 'user');
  if (lastUserRevIdx === -1) return; // no user message to regenerate from
  const userIdx = conv.messages.length - 1 - lastUserRevIdx;

  // Capture user message content before splicing
  const lastUserMsg = conv.messages[userIdx];
  const text = getTextContent(lastUserMsg);
  const attachments = lastUserMsg.content.filter(c => c.type !== 'text');

  // Now safely remove both messages (remove higher index first to preserve lower index)
  const higherIdx = Math.max(asstIdx, userIdx);
  const lowerIdx = Math.min(asstIdx, userIdx);
  conv.messages.splice(higherIdx, 1);
  conv.messages.splice(lowerIdx, 1);

  STORE.saveConversations();
  sendMessage({ text, attachments });
}

function notifyUser(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') new Notification(title, { body });
  else if (Notification.permission !== 'denied') Notification.requestPermission().then(p => { if (p === 'granted') new Notification(title, { body }); });
}

// ==================== ARTIFACTS ====================
const ARTIFACT_LANGS = ['html', 'css', 'js', 'javascript', 'python', 'svg', 'json', 'markdown', 'md', 'jsx', 'tsx', 'ts', 'typescript', 'bash', 'sh', 'sql', 'rust', 'go', 'cpp', 'c', 'java', 'ruby', 'php', 'yaml', 'toml', 'xml'];

function detectArtifacts(text) {
  const artifacts = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const lang = (m[1] || 'text').toLowerCase();
    const code = m[2];
    if (!code.trim()) continue;
    artifacts.push({ lang, code, id: uid() });
  }
  return artifacts;
}

function getArtifactLabel(lang) {
  const map = { html: 'HTML', css: 'CSS', js: 'JavaScript', javascript: 'JavaScript', python: 'Python', svg: 'SVG', json: 'JSON', markdown: 'Markdown', md: 'Markdown', jsx: 'JSX', tsx: 'TSX', ts: 'TypeScript', typescript: 'TypeScript', bash: 'Bash', sh: 'Shell', sql: 'SQL', rust: 'Rust', go: 'Go', cpp: 'C++', c: 'C', java: 'Java', ruby: 'Ruby', php: 'PHP', yaml: 'YAML', toml: 'TOML', xml: 'XML' };
  return map[lang] || lang.toUpperCase();
}

function getArtifactExt(lang) {
  const map = { javascript: 'js', typescript: 'ts', markdown: 'md', python: 'py', bash: 'sh', sh: 'sh' };
  return map[lang] || lang;
}

// ==================== MEMORY ====================
async function autoExtractMemory() {
  const conv = getActiveConversation();
  if (!conv || conv.messages.length === 0) { toast('No conversation to extract memory from.', 'warning'); return; }
  const provider = conv.provider;
  const apiKeys = STORE.loadApiKeys();
  const key = apiKeys[provider];
  if (!key && provider !== 'ollama') { toast('No API key to auto-extract memory.', 'error'); return; }
  toast('Extracting key facts…', 'info');
  const transcript = conv.messages.filter(m => m.role !== 'system').map(m => `${m.role.toUpperCase()}: ${getTextContent(m)}`).join('\n').slice(0, 6000);
  const extractPrompt = `From this conversation, extract brief key facts, preferences, and important info about the user that should be remembered for future conversations. Be concise. Bullet points only.\n\n${transcript}`;
  try {
    const builtBody = PROVIDERS[provider].buildRequest(
      [{ id: uid(), role: 'user', content: [{ type: 'text', text: extractPrompt }], provider, timestamp: Date.now(), tokens: {}, artifacts: [] }],
      { max_tokens: 400, temperature: 0.3 }, null
    );

    let fetchURL, fetchBody;
    if (provider === 'gemini') {
      // Use non-streaming generateContent endpoint
      fetchURL = `${PROVIDERS.gemini.baseURL}/${conv.model}:generateContent?key=${key}`;
      fetchBody = builtBody; // no stream param needed
    } else {
      fetchURL = PROVIDERS[provider].baseURL;
      fetchBody = { ...builtBody, stream: false };
    }

    const resp = await fetch(fetchURL, {
      method: 'POST',
      headers: PROVIDERS[provider].getHeaders(key),
      body: JSON.stringify(fetchBody),
    });
    if (!resp.ok) throw new Error('API error ' + resp.status);
    const data = await resp.json();
    let extracted = '';
    if (provider === 'anthropic') extracted = data.content?.[0]?.text || '';
    else if (provider === 'gemini') extracted = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    else extracted = data.choices?.[0]?.message?.content || '';
    STATE.memory = (STATE.memory ? STATE.memory + '\n\n' : '') + `[Auto-extracted ${new Date().toLocaleDateString()}]\n${extracted.trim()}`;
    document.getElementById('memory-input').value = STATE.memory;
    STORE.saveMemory();
    toast('Memory updated!', 'success');
  } catch (e) { toast('Auto-extract failed: ' + e.message, 'error'); }
}

// ==================== COMPARE MODE ====================
async function runCompareMode() {
  const msg = document.getElementById('compare-input').value.trim();
  if (!msg) return;
  const apiKeys = STORE.loadApiKeys();
  const sides = ['left', 'right'];

  // Clear previous messages before each run
  ['left','right'].forEach(s => { document.getElementById(`compare-${s}-messages`).innerHTML = ''; });

  for (const side of sides) {
    const prov = document.getElementById(`compare-${side}-provider`).value;
    const model = document.getElementById(`compare-${side}-model`).value;
    const msgDiv = document.getElementById(`compare-${side}-messages`);
    const userBubble = document.createElement('div');
    userBubble.style.cssText = 'padding:10px 14px;background:var(--user-bubble);border-radius:8px;margin-bottom:10px;font-size:13px;';
    userBubble.textContent = msg;
    msgDiv.appendChild(userBubble);
    const asstBubble = document.createElement('div');
    asstBubble.style.cssText = 'padding:10px 14px;background:var(--assistant-bubble);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;font-size:13px;line-height:1.6;white-space:pre-wrap;';
    asstBubble.textContent = '…';
    msgDiv.appendChild(asstBubble);

    const key = apiKeys[prov];
    const fakeMsg = [{ id: uid(), role: 'user', content: [{ type: 'text', text: msg }], timestamp: Date.now(), tokens: {}, artifacts: [] }];
    try {
      // Build request without mutating global STATE — swap and restore atomically
      const savedModel = STATE.settings.currentModel;
      STATE.settings.currentModel = model;
      let body;
      try {
        body = PROVIDERS[prov].buildRequest(fakeMsg, STATE.params, null);
      } finally {
        // Always restore, even if buildRequest throws
        STATE.settings.currentModel = savedModel;
      }
      let url = PROVIDERS[prov].baseURL;
      if (prov === 'gemini') url = PROVIDERS.gemini.getURL(key, model);
      const resp = await fetch(url, { method: 'POST', headers: PROVIDERS[prov].getHeaders(key), body: JSON.stringify(body) });
      if (!resp.ok) { asstBubble.textContent = 'Error: HTTP ' + resp.status; continue; }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const results = PROVIDERS[prov].parseStreamChunk(buffer);
        buffer = '';
        for (const r of results) { if (r.delta && r.type !== 'thinking') full += r.delta; }
        asstBubble.textContent = full || '…';
        msgDiv.scrollTop = msgDiv.scrollHeight;
      }
      asstBubble.innerHTML = renderMarkdown(full);
    } catch (e) { asstBubble.textContent = 'Error: ' + e.message; }
  }
}

// ==================== URL FETCHING ====================
async function fetchURL(url) {
  try {
    const proxyURL = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const resp = await fetch(proxyURL);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    let text = data.contents || '';
    // Strip HTML tags roughly
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 12000);
    return text;
  } catch (e) { throw new Error('Could not fetch URL: ' + e.message); }
}

// ==================== COST ESTIMATOR ====================
function showCostEstimator() {
  const conv = getActiveConversation();
  const provider = document.getElementById('provider-select').value;
  const model = document.getElementById('model-select').value;
  const inputText = document.getElementById('user-input').value;
  const historyTokens = conv ? conv.messages.reduce((a, m) => a + estimateTokens(getTextContent(m)), 0) : 0;
  const newTokens = estimateTokens(inputText);
  const totalIn = historyTokens + newTokens;
  const estOut = STATE.params.max_tokens;
  const pricing = PRICING[model] || { in: 0, out: 0 };
  const inCost = (totalIn / 1_000_000) * pricing.in;
  const outCost = (estOut / 1_000_000) * pricing.out;
  const totalCost = inCost + outCost;
  document.getElementById('cost-body').innerHTML = `
    <div class="cost-breakdown">
      <div class="cost-row"><span class="cost-label">Provider / Model</span><span>${PROVIDERS[provider]?.name} / ${model}</span></div>
      <div class="cost-row"><span class="cost-label">Context history tokens</span><span class="cost-value">${historyTokens.toLocaleString()}</span></div>
      <div class="cost-row"><span class="cost-label">New message tokens (est.)</span><span class="cost-value">${newTokens.toLocaleString()}</span></div>
      <div class="cost-row"><span class="cost-label">Total input tokens</span><span class="cost-value">${totalIn.toLocaleString()}</span></div>
      <div class="cost-row"><span class="cost-label">Input price (per 1M)</span><span class="cost-value">$${pricing.in.toFixed(2)}</span></div>
      <div class="cost-row"><span class="cost-label">Est. output tokens (max)</span><span class="cost-value">${estOut.toLocaleString()}</span></div>
      <div class="cost-row"><span class="cost-label">Output price (per 1M)</span><span class="cost-value">$${pricing.out.toFixed(2)}</span></div>
      <div class="cost-row"><span class="cost-label cost-total">Estimated total cost</span><span class="cost-value">$${totalCost < 0.001 ? '<$0.001' : totalCost.toFixed(4)}</span></div>
    </div>
    ${pricing.in === 0 && pricing.out === 0 ? '<p style="font-size:12px;color:var(--text-muted);margin-top:12px">This model appears to be free tier — no cost data available.</p>' : ''}
    <p style="font-size:11px;color:var(--text-muted);margin-top:10px">Estimates only. Actual costs depend on exact tokenization and provider billing.</p>
  `;
  document.getElementById('cost-overlay').classList.remove('hidden');
}



// ==================== MARKDOWN & RENDERING ====================
function copyCodeFromHeader(btn) {
  const code = btn.closest('.code-block-header')?.nextElementSibling?.querySelector('code');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent);
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

function openArtifactFromHeader(btn) {
  const lang = btn.dataset.lang;
  const code = btn.closest('.code-block-header')?.nextElementSibling?.querySelector('code');
  if (!code) return;
  UI.openArtifactPanel([{ lang, code: code.textContent, id: uid() }]);
}

function renderMarkdown(text) {
  if (!text) return '';
  try {
    const dirty = marked.parse(text, { breaks: true, gfm: true });
    const raw = (typeof DOMPurify !== 'undefined')
      ? DOMPurify.sanitize(dirty, { ADD_TAGS: ['iframe'], ADD_ATTR: ['target'] })
      : dirty;
    // Enhance code blocks with header and copy/artifact buttons
    const div = document.createElement('div');
    div.innerHTML = raw;
    div.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code');
      if (!code) return;
      const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
      const lang = langClass ? langClass.replace('language-', '') : 'text';
      const label = getArtifactLabel(lang);
      const header = document.createElement('div');
      header.className = 'code-block-header';
      const isArtifactLang = ARTIFACT_LANGS.includes(lang.toLowerCase());
      header.innerHTML = `<span class="code-lang-label">${label}</span><div class="code-block-actions"><button class="code-action-btn copy-code-btn" onclick="copyCodeFromHeader(this)">Copy</button>${isArtifactLang ? `<button class="artifact-open-btn show-artifact-btn" data-lang="${lang}" onclick="openArtifactFromHeader(this)">View in Panel</button>` : ''}</div>`;
      pre.parentNode.insertBefore(header, pre);
      const wrapper = document.createElement('div');
      wrapper.style.position = 'relative';
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
      // Syntax highlight
      try { hljs.highlightElement(code); } catch {}
    });
    return div.innerHTML;
  } catch { return escapeHtml(text).replace(/\n/g, '<br>'); }
}

function renderJsonTree(obj, depth = 0) {
  if (obj === null) return `<span class="json-null">null</span>`;
  if (typeof obj === 'boolean') return `<span class="json-bool">${obj}</span>`;
  if (typeof obj === 'number') return `<span class="json-number">${obj}</span>`;
  if (typeof obj === 'string') return `<span class="json-string">"${escapeHtml(obj)}"</span>`;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '<span>[]</span>';
    const items = obj.map((v,i) => `<li>[${i}]: ${renderJsonTree(v, depth+1)}</li>`).join('');
    return `<span class="json-toggle" data-open="1">Array[${obj.length}]</span><ul>${items}</ul>`;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return '<span>{}</span>';
    const items = keys.map(k => `<li><span class="json-key">"${escapeHtml(k)}"</span>: ${renderJsonTree(obj[k], depth+1)}</li>`).join('');
    return `<span class="json-toggle" data-open="1">Object{${keys.length}}</span><ul>${items}</ul>`;
  }
  return String(obj);
}

// ==================== UI ====================
const UI = {
  renderMessages(messages) {
    const list = document.getElementById('messages-list');
    list.innerHTML = '';
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const el = this.createMessageElement(msg, i, messages);
      list.appendChild(el);
    }
    lucide.createIcons({ nodes: [list] });
    // Re-apply active in-conversation search highlights after re-render
    const activeQuery = document.getElementById('conv-search-input')?.value;
    if (activeQuery) setTimeout(() => convSearch(activeQuery), 0);
  },

  createMessageElement(msg, idx, allMsgs) {
    const el = document.createElement('div');
    el.className = `message ${msg.role}`;
    el.dataset.msgId = msg.id;
    el.dataset.msgIdx = idx;

    const avatarIcon = msg.role === 'user' ? (STATE.settings.userName?.[0]?.toUpperCase() || 'U') : '⬡';
    const isLast = idx === allMsgs.length - 1;
    const isLastAsst = msg.role === 'assistant' && allMsgs.slice(idx+1).every(m => m.role !== 'assistant');

    // Images
    let imagesHTML = '';
    const imgContent = msg.content.filter(c => c.type === 'image');
    if (imgContent.length) {
      imagesHTML = `<div class="message-images">${imgContent.map(c => `<img class="message-image-thumb" src="data:${c.mediaType};base64,${c.data}" alt="Attached image">`).join('')}</div>`;
    }

    // Files
    let filesHTML = '';
    const fileContent = msg.content.filter(c => c.type === 'file');
    if (fileContent.length) {
      filesHTML = fileContent.map(c => `<div class="message-file-pill"><i data-lucide="file-text"></i>${escapeHtml(c.name)}</div>`).join('');
    }

    // Thinking block
    let thinkingHTML = '';
    if (msg.thinking) {
      thinkingHTML = `<div class="thinking-block">
        <div class="thinking-header" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('visible')">
          <i data-lucide="brain" style="width:13px;height:13px"></i> Reasoning
          <i data-lucide="chevron-right" class="thinking-toggle-icon" style="width:12px;height:12px;margin-left:auto"></i>
        </div>
        <div class="thinking-content">${escapeHtml(msg.thinking)}</div>
      </div>`;
    }

    // Main content
    let bodyHTML = '';
    if (msg.error) {
      bodyHTML = `<div class="message-error"><i data-lucide="alert-circle"></i><div><div>${escapeHtml(msg.error)}</div><button class="retry-btn" onclick="regenerate()">Retry</button></div></div>`;
    } else {
      const textC = msg.content.find(c => c.type === 'text');
      const textVal = textC?.text || '';
      if (msg.role === 'assistant') {
        bodyHTML = renderMarkdown(textVal);
      } else {
        bodyHTML = `<p style="white-space:pre-wrap;word-break:break-word">${escapeHtml(textVal)}</p>`;
      }
    }

    // Streaming cursor (if this is the last message and streaming)
    const showCursor = STATE.isStreaming && isLast && msg.role === 'assistant';
    const cursor = showCursor ? '<span class="streaming-cursor"></span>' : '';

    // Token info
    const tokenInfo = STATE.settings.showTokens && (msg.tokens?.input || msg.tokens?.output)
      ? `<span class="token-info">↑${msg.tokens.input} ↓${msg.tokens.output}</span>` : '';

    // Actions
    let actionsHTML = '';
    // Store message ID on element; event listeners use data lookups instead of inline JS
    const msgId = msg.id;
    if (msg.role === 'user') {
      actionsHTML = `<div class="message-actions">
        <button class="msg-action-btn" data-action="edit" data-idx="${idx}"><i data-lucide="edit-2"></i> Edit</button>
        <button class="msg-action-btn" data-action="copy" data-msg-id="${escapeHtml(msgId)}"><i data-lucide="copy"></i> Copy</button>
        <button class="msg-action-btn" data-action="fork" data-idx="${idx}"><i data-lucide="git-fork"></i> Fork</button>
      </div>`;
    } else {
      actionsHTML = `<div class="message-actions">
        <button class="msg-action-btn" data-action="copy" data-msg-id="${escapeHtml(msgId)}"><i data-lucide="copy"></i> Copy</button>
        ${isLastAsst ? `<button class="msg-action-btn" data-action="regenerate"><i data-lucide="refresh-cw"></i> Regenerate</button>` : ''}
        ${msg.artifacts?.length ? `<button class="msg-action-btn" data-action="open-artifacts" data-msg-id="${escapeHtml(msgId)}"><i data-lucide="panel-right"></i> Artifacts</button>` : ''}
      </div>`;
    }

    el.innerHTML = `
      <div class="message-avatar">${avatarIcon}</div>
      <div class="message-body">
        ${thinkingHTML}
        <div class="message-bubble">
          ${imagesHTML}${filesHTML}${bodyHTML}${cursor}
        </div>
        <div class="message-meta">
          <span class="message-timestamp">${formatTime(msg.timestamp)}</span>
          ${tokenInfo}
        </div>
        ${actionsHTML}
      </div>`;
    return el;
  },

  updateStreamingMessage(msg, idx) {
    const list = document.getElementById('messages-list');
    const el = list.children[idx];
    if (!el) return;
    const bubble = el.querySelector('.message-bubble');
    if (!bubble) return;
    const textVal = msg.content[0]?.text || '';

    // Thinking
    let thinkingHTML = '';
    if (msg.thinking) {
      thinkingHTML = `<div class="thinking-block"><div class="thinking-header" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('visible')"><i data-lucide="brain" style="width:13px;height:13px"></i> Reasoning <i data-lucide="chevron-right" class="thinking-toggle-icon" style="width:12px;height:12px;margin-left:auto"></i></div><div class="thinking-content">${escapeHtml(msg.thinking)}</div></div>`;
    }

    bubble.innerHTML = renderMarkdown(textVal) + '<span class="streaming-cursor"></span>';
    // Update thinking block above bubble
    const body = el.querySelector('.message-body');
    const existingThink = body.querySelector('.thinking-block');
    if (existingThink) existingThink.outerHTML = thinkingHTML;
    else if (msg.thinking) body.insertAdjacentHTML('afterbegin', thinkingHTML);
    lucide.createIcons({ nodes: [bubble] });
  },

  editMessage(idx) {
    const conv = getActiveConversation();
    if (!conv) return;
    const msg = conv.messages[idx];
    if (!msg) return;
    const text = getTextContent(msg);
    const inputEl = document.getElementById('user-input');
    inputEl.value = text;
    autoResize(inputEl);
    inputEl.focus();
    // On next send, replace from this index
    inputEl.dataset.replaceIndex = String(idx);

    // Add a visible cancel-edit button if not already present
    let cancelBtn = document.getElementById('cancel-edit-btn');
    if (!cancelBtn) {
      cancelBtn = document.createElement('button');
      cancelBtn.id = 'cancel-edit-btn';
      cancelBtn.className = 'btn-sm';
      cancelBtn.style.cssText = 'position:absolute;top:-32px;right:0;background:var(--bg-tertiary);border-color:var(--warning);color:var(--warning);font-size:11px;z-index:10;';
      cancelBtn.textContent = '✕ Cancel edit';
      cancelBtn.addEventListener('click', () => {
        delete inputEl.dataset.replaceIndex;
        inputEl.value = '';
        autoResize(inputEl);
        cancelBtn.remove();
      });
      document.getElementById('textarea-wrapper').style.position = 'relative';
      document.getElementById('textarea-wrapper').appendChild(cancelBtn);
    }
    toast('Editing message — send to replace from this point.', 'info');
  },

  showEmptyState(show) {
    document.getElementById('empty-state').style.display = show ? 'flex' : 'none';
  },

  scrollToBottom() {
    const c = document.getElementById('messages-container');
    c.scrollTop = c.scrollHeight;
  },

  setStreaming(on) {
    document.getElementById('send-btn').classList.toggle('hidden', on);
    document.getElementById('stop-btn').classList.toggle('hidden', !on);
  },

  updateCharCount() {
    const val = document.getElementById('user-input').value;
    const chars = val.length;
    const tokens = estimateTokens(val);
    document.getElementById('char-token-count').textContent = `${chars} chars / ~${tokens} tokens`;
  },

  updateTokenBudget() {
    const conv = getActiveConversation();
    const fill = document.getElementById('token-budget-fill');
    const label = document.getElementById('token-budget-label');
    if (!conv) { fill.style.width = '0%'; label.textContent = '0 / — tokens'; return; }
    const provider = conv.provider || 'anthropic';
    const model = conv.model;
    const ctx = getModelCtx(provider, model);
    const used = conv.totalTokens.input + conv.totalTokens.output;
    const pct = ctx ? Math.min((used / ctx) * 100, 100) : 0;
    fill.style.width = pct + '%';
    fill.className = 'token-budget-fill' + (pct > 90 ? ' danger' : pct > 70 ? ' warning' : '');
    label.textContent = ctx ? `${used.toLocaleString()} / ${(ctx/1000).toFixed(0)}K tokens` : `${used.toLocaleString()} tokens`;
  },

  populateModelSelect(provider) {
    const sel = document.getElementById('model-select');
    const p = PROVIDERS[provider];
    if (!p) return;
    sel.innerHTML = p.models.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
    // Custom model option for openrouter/ollama
    if (['openrouter','ollama'].includes(provider)) {
      const customInput = document.getElementById('custom-model-input');
      if (customInput) customInput.classList.toggle('hidden', sel.value !== 'custom');
    }
    sel.value = STATE.settings.currentModel || p.models[0]?.id;
    this.updateModelBadge(provider, sel.value);
  },

  updateModelBadge(provider, modelId) {
    const p = PROVIDERS[provider];
    const m = p?.models.find(x => x.id === modelId);
    const badge = document.getElementById('model-meta-badge');
    if (!badge) return;
    if (!m) { badge.innerHTML = ''; return; }
    let html = '';
    if (m.cost === 'free') html += '<span class="badge badge-free">Free</span>';
    else if (m.cost === 'paid') html += '<span class="badge badge-paid">Paid</span>';
    if (m.vision) html += '<span class="badge badge-vision">👁 Vision</span>';
    if (m.ctx) html += `<span class="badge" style="background:var(--bg-tertiary);color:var(--text-muted)">${(m.ctx/1000).toFixed(0)}K ctx</span>`;
    badge.innerHTML = html;
  },

  clearAttachmentsPreview() {
    STATE.attachments = [];
    const preview = document.getElementById('attachments-preview');
    preview.innerHTML = '';
    preview.classList.add('hidden');
  },

  addAttachmentPreview(att) {
    const preview = document.getElementById('attachments-preview');
    preview.classList.remove('hidden');
    const item = document.createElement('div');
    item.className = 'attachment-item';
    item.dataset.attId = att.id;
    if (att.type === 'image') {
      item.innerHTML = `<img class="attachment-img-thumb" src="data:${att.mediaType};base64,${att.data}" alt="${escapeHtml(att.name || 'Image')}"><button class="attachment-remove" data-att="${att.id}">×</button>`;
    } else {
      item.innerHTML = `<div class="attachment-file-pill"><i data-lucide="file-text"></i><span>${escapeHtml(att.name)}</span></div><button class="attachment-remove" data-att="${att.id}">×</button>`;
    }
    item.querySelector('.attachment-remove').addEventListener('click', () => {
      STATE.attachments = STATE.attachments.filter(a => a.id !== att.id);
      item.remove();
      if (!STATE.attachments.length) preview.classList.add('hidden');
    });
    preview.appendChild(item);
    lucide.createIcons({ nodes: [item] });
  },

  openArtifactPanel(artifacts) {
    if (!artifacts || artifacts.length === 0) return;
    STATE.artifacts = artifacts;
    STATE.activeArtifactIndex = 0;
    document.getElementById('artifact-panel').classList.remove('hidden');
    this.renderArtifactTabs();
    this.renderArtifact(0);
  },

  closeArtifactPanel() {
    document.getElementById('artifact-panel').classList.add('hidden');
    STATE.artifacts = [];
    STATE.activeArtifactIndex = 0;
  },

  renderArtifactTabs() {
    const tabs = document.getElementById('artifact-tabs');
    tabs.innerHTML = STATE.artifacts.map((a, i) =>
      `<div class="artifact-tab${i === STATE.activeArtifactIndex ? ' active' : ''}" data-idx="${i}">${getArtifactLabel(a.lang)}</div>`
    ).join('');
    tabs.querySelectorAll('.artifact-tab').forEach(t => {
      t.addEventListener('click', () => {
        STATE.activeArtifactIndex = parseInt(t.dataset.idx);
        this.renderArtifactTabs();
        this.renderArtifact(STATE.activeArtifactIndex);
      });
    });
  },

  renderArtifact(idx) {
    const art = STATE.artifacts[idx];
    if (!art) return;
    const iframe = document.getElementById('artifact-iframe');
    const codeArea = document.getElementById('artifact-code-area');
    const editArea = document.getElementById('artifact-edit-area');
    editArea.classList.add('hidden');
    STATE.artifactEditMode = false;
    document.getElementById('artifact-edit-toggle').classList.remove('active');

    const lang = art.lang.toLowerCase();
    if (lang === 'html') {
      iframe.classList.remove('hidden');
      codeArea.classList.add('hidden');
      iframe.srcdoc = art.code;
    } else if (lang === 'svg') {
      iframe.classList.remove('hidden');
      codeArea.classList.add('hidden');
      iframe.srcdoc = `<html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:${document.documentElement.getAttribute('data-theme')==='light'?'#f6f8fa':'#0d1117'}">${art.code}</body></html>`;
    } else if (lang === 'json') {
      iframe.classList.add('hidden');
      codeArea.classList.remove('hidden');
      codeArea.className = 'json-tree-container';
      try {
        const parsed = JSON.parse(art.code);
        codeArea.innerHTML = `<ul style="list-style:none;padding:0">${renderJsonTree(parsed)}</ul>`;
        codeArea.querySelectorAll('.json-toggle').forEach(t => {
          t.addEventListener('click', () => {
            t.classList.toggle('collapsed');
            const next = t.nextElementSibling;
            if (next) next.style.display = t.classList.contains('collapsed') ? 'none' : '';
          });
        });
      } catch { codeArea.innerHTML = `<pre>${escapeHtml(art.code)}</pre>`; }
    } else if (lang === 'markdown' || lang === 'md') {
      iframe.classList.add('hidden');
      codeArea.classList.remove('hidden');
      codeArea.className = 'md-preview-container';
      codeArea.innerHTML = renderMarkdown(art.code);
    } else {
      iframe.classList.add('hidden');
      codeArea.classList.remove('hidden');
      codeArea.className = 'artifact-code-area';
      const highlighted = (() => { try { return hljs.highlight(art.code, { language: lang, ignoreIllegals: true }).value; } catch { return escapeHtml(art.code); } })();
      codeArea.innerHTML = `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
    }
  },

  toggleArtifactEdit() {
    const art = STATE.artifacts[STATE.activeArtifactIndex];
    if (!art) return;
    const editArea = document.getElementById('artifact-edit-area');
    const editTextarea = document.getElementById('artifact-edit-textarea');
    STATE.artifactEditMode = !STATE.artifactEditMode;
    editArea.classList.toggle('hidden', !STATE.artifactEditMode);
    editArea.classList.toggle('visible', STATE.artifactEditMode);
    document.getElementById('artifact-edit-toggle').classList.toggle('active', STATE.artifactEditMode);
    if (STATE.artifactEditMode) editTextarea.value = art.code;
  },

  rerenderArtifact() {
    const art = STATE.artifacts[STATE.activeArtifactIndex];
    if (!art) return;
    art.code = document.getElementById('artifact-edit-textarea').value;
    this.renderArtifact(STATE.activeArtifactIndex);
    toast('Artifact re-rendered', 'success');
  },
};

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied!', 'success'));
}


// ==================== SETTINGS UI ====================
function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  overlay.classList.remove('hidden');
  populateSettingsUI();
}

function populateSettingsUI() {
  const s = STATE.settings;
  const apiKeys = STORE.loadApiKeys();

  // API Keys
  const keysList = document.getElementById('api-keys-list');
  keysList.innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `
    <div class="api-key-row">
      <span class="api-key-provider-name">${p.name}</span>
      <input type="password" id="key-${id}" value="${escapeHtml(apiKeys[id] || '')}" placeholder="Enter API key…">
      <button class="btn-icon" onclick="toggleKeyVisibility('${id}')" title="Show/hide"><i data-lucide="eye"></i></button>
      <button class="btn-sm" onclick="testApiKey('${id}')"><i data-lucide="zap"></i> Test</button>
    </div>
    ${id === 'ollama' ? `<div style="margin:4px 0 10px 108px"><input type="text" id="key-ollama-url" value="${escapeHtml(STATE.settings.ollamaBaseURL||'http://localhost:11434')}" placeholder="Base URL (default: http://localhost:11434)" style="font-size:12px"></div>` : ''}
  `).join('');
  lucide.createIcons({ nodes: [keysList] });

  // Appearance
  document.querySelectorAll('input[name="theme"]').forEach(r => r.checked = r.value === s.theme);
  document.querySelectorAll('.color-swatch').forEach(sw => sw.classList.toggle('active', sw.dataset.accent === s.accent));
  document.querySelectorAll('input[name="fontSize"]').forEach(r => r.checked = r.value === (s.fontSize || 'medium'));
  document.querySelectorAll('input[name="chatStyle"]').forEach(r => r.checked = r.value === (s.chatStyle || 'bubbles'));
  document.getElementById('hljs-theme-select').value = s.hljsTheme || 'github-dark';

  // Behavior
  document.querySelectorAll('input[name="sendKey"]').forEach(r => r.checked = r.value === (s.sendKey || 'enter'));
  document.getElementById('auto-title-toggle').checked = s.autoTitle !== false;
  document.getElementById('auto-scroll-toggle').checked = s.autoScroll !== false;
  document.getElementById('show-tokens-toggle').checked = s.showTokens !== false;
  document.getElementById('notifications-toggle').checked = !!s.notifications;
  const defProvSel = document.getElementById('default-provider-select');
  defProvSel.innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${p.name}</option>`).join('');
  defProvSel.value = s.defaultProvider || 'anthropic';
  document.getElementById('default-system-prompt').value = s.defaultSystemPrompt || '';
  document.getElementById('max-conversations').value = s.maxConversations || 100;

  // Templates
  renderTemplatesList();

  // Custom CSS
  document.getElementById('custom-css-input').value = s.customCSS || '';
}

function saveSettings() {
  const apiKeys = STORE.loadApiKeys();
  Object.keys(PROVIDERS).forEach(id => {
    const el = document.getElementById(`key-${id}`);
    if (el) { const v = el.value.trim(); if (v) apiKeys[id] = v; else delete apiKeys[id]; }
  });
  const ollamaURL = document.getElementById('key-ollama-url');
  if (ollamaURL) STATE.settings.ollamaBaseURL = ollamaURL.value.trim();
  STORE.saveApiKeys(apiKeys);

  STATE.settings.theme = document.querySelector('input[name="theme"]:checked')?.value || 'dark';
  STATE.settings.fontSize = document.querySelector('input[name="fontSize"]:checked')?.value || 'medium';
  STATE.settings.chatStyle = document.querySelector('input[name="chatStyle"]:checked')?.value || 'bubbles';
  STATE.settings.hljsTheme = document.getElementById('hljs-theme-select').value;
  STATE.settings.sendKey = document.querySelector('input[name="sendKey"]:checked')?.value || 'enter';
  STATE.settings.autoTitle = document.getElementById('auto-title-toggle').checked;
  STATE.settings.autoScroll = document.getElementById('auto-scroll-toggle').checked;
  STATE.settings.showTokens = document.getElementById('show-tokens-toggle').checked;
  STATE.settings.notifications = document.getElementById('notifications-toggle').checked;
  STATE.settings.defaultProvider = document.getElementById('default-provider-select').value;
  STATE.settings.defaultSystemPrompt = document.getElementById('default-system-prompt').value;
  STATE.settings.maxConversations = parseInt(document.getElementById('max-conversations').value) || 100;
  STATE.settings.customCSS = document.getElementById('custom-css-input').value;
  STORE.saveSettings();
  applySettings();
  document.getElementById('settings-overlay').classList.add('hidden');
  toast('Settings saved!', 'success');
}

function applySettings() {
  const s = STATE.settings;
  const html = document.documentElement;

  // Theme
  if (s.theme === 'system') html.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  else html.setAttribute('data-theme', s.theme);

  html.setAttribute('data-accent', s.accent || 'cyan');
  html.setAttribute('data-font-size', s.fontSize || 'medium');
  html.setAttribute('data-chat-style', s.chatStyle || 'bubbles');

  // Highlight.js theme
  const hljsLink = document.getElementById('hljs-theme-link');
  if (hljsLink) hljsLink.href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${s.hljsTheme || 'github-dark'}.min.css`;

  // Custom CSS
  document.getElementById('custom-user-css').textContent = s.customCSS || '';

  // Send key hint
  const hint = document.getElementById('send-mode-hint');
  if (hint) hint.textContent = s.sendKey === 'shift-enter' ? 'Shift+Enter to send · Enter for newline' : 'Enter to send · Shift+Enter for newline';

  // Notifications permission
  if (s.notifications && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

function toggleKeyVisibility(id) {
  const input = document.getElementById(`key-${id}`);
  if (input) input.type = input.type === 'password' ? 'text' : 'password';
}

async function testApiKey(providerId) {
  const input = document.getElementById(`key-${providerId}`);
  const key = input?.value?.trim();
  if (!key) { toast('Enter a key first.', 'warning'); return; }
  toast(`Testing ${PROVIDERS[providerId].name} key…`, 'info');
  try {
    const p = PROVIDERS[providerId];
    const testMsg = [{ id: uid(), role: 'user', content: [{ type: 'text', text: 'Hi' }], timestamp: Date.now(), tokens: {}, artifacts: [] }];
    const savedModel = STATE.settings.currentModel;
    STATE.settings.currentModel = p.models[0]?.id;
    const builtBody = p.buildRequest(testMsg, { max_tokens: 8, temperature: 0 }, null);
    STATE.settings.currentModel = savedModel;

    let url, headers, body;

    if (providerId === 'gemini') {
      // Gemini non-streaming uses generateContent (no alt=sse)
      url = `${p.baseURL}/${p.models[0]?.id}:generateContent?key=${key}`;
      headers = p.getHeaders(key);
      // Remove stream-specific config if present
      const { ...geminiBody } = builtBody;
      body = geminiBody;
    } else {
      url = p.baseURL;
      headers = p.getHeaders(key);
      body = { ...builtBody, stream: false };
    }

    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (resp.ok) {
      toast(`${p.name} key works! ✓`, 'success');
    } else {
      try {
        const e = await resp.json();
        toast(`${p.name}: ${e.error?.message || 'Error ' + resp.status}`, 'error', 5000);
      } catch {
        toast(`${p.name}: Error ${resp.status}`, 'error', 5000);
      }
    }
  } catch (e) { toast(`Test failed: ${e.message}`, 'error'); }
}

// ==================== TEMPLATES UI ====================
function renderTemplatesList() {
  const list = document.getElementById('templates-list');
  if (!list) return;
  list.innerHTML = '';
  if (!STATE.templates.length) { list.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No templates yet.</p>'; return; }
  list.className = 'template-list';
  for (const t of STATE.templates) {
    const item = document.createElement('div');
    item.className = 'template-item';
    item.innerHTML = `<span class="template-item-icon">${t.icon || '📝'}</span><span class="template-item-name">${escapeHtml(t.name)}</span><div class="template-item-actions"><button class="btn-sm" data-edit="${t.id}"><i data-lucide="edit-2"></i></button><button class="btn-sm btn-danger" data-del="${t.id}"><i data-lucide="trash-2"></i></button></div>`;
    item.querySelector('[data-edit]').addEventListener('click', () => openTemplateEdit(t.id));
    item.querySelector('[data-del]').addEventListener('click', () => { if (confirm('Delete template?')) { STATE.templates = STATE.templates.filter(x => x.id !== t.id); STORE.saveTemplates(); renderTemplatesList(); } });
    list.appendChild(item);
    lucide.createIcons({ nodes: [item] });
  }
}

function openTemplateEdit(id) {
  STATE.editingTemplateId = id || null;
  const t = id ? STATE.templates.find(x => x.id === id) : null;
  document.getElementById('template-edit-title').textContent = t ? 'Edit Template' : 'Add Template';
  document.getElementById('template-edit-name').value = t?.name || '';
  document.getElementById('template-edit-icon').value = t?.icon || '📝';
  document.getElementById('template-edit-content').value = t?.content || '';
  document.getElementById('template-edit-overlay').classList.remove('hidden');
  document.getElementById('settings-overlay').classList.add('hidden');
}

function saveTemplateEdit() {
  const name = document.getElementById('template-edit-name').value.trim();
  const icon = document.getElementById('template-edit-icon').value.trim() || '📝';
  const content = document.getElementById('template-edit-content').value;
  if (!name) { toast('Template needs a name.', 'warning'); return; }
  if (STATE.editingTemplateId) {
    const t = STATE.templates.find(x => x.id === STATE.editingTemplateId);
    if (t) { t.name = name; t.icon = icon; t.content = content; }
  } else {
    STATE.templates.push({ id: uid(), name, icon, content });
  }
  STORE.saveTemplates();
  document.getElementById('template-edit-overlay').classList.add('hidden');
  document.getElementById('settings-overlay').classList.remove('hidden');
  renderTemplatesList();
  toast('Template saved!', 'success');
}

// ==================== SLASH COMMANDS / TEMPLATES ====================
function renderSlashDropdown(query) {
  const dropdown = document.getElementById('slash-dropdown');
  const filtered = STATE.templates.filter(t => !query || t.name.toLowerCase().includes(query.toLowerCase()));
  if (!filtered.length) { dropdown.classList.add('hidden'); return; }
  dropdown.classList.remove('hidden');
  dropdown.innerHTML = filtered.map((t, i) => `<div class="slash-item${i === STATE.slashDropdownIndex ? ' selected' : ''}" data-idx="${i}">
    <span class="slash-item-icon">${t.icon || '📝'}</span>
    <div style="min-width:0"><div class="slash-item-name">${escapeHtml(t.name)}</div><div class="slash-item-preview">${escapeHtml(t.content.slice(0, 60))}</div></div>
  </div>`).join('');
  dropdown.querySelectorAll('.slash-item').forEach((el, i) => {
    el.addEventListener('click', () => applyTemplate(filtered[i]));
  });
  dropdown._filtered = filtered;
}

function applyTemplate(t) {
  const input = document.getElementById('user-input');
  input.value = t.content;
  autoResize(input);
  UI.updateCharCount();
  document.getElementById('slash-dropdown').classList.add('hidden');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ==================== SYSTEM PROMPT LIBRARY ====================
function renderSPLibrary() {
  const list = document.getElementById('sp-library-list');
  list.innerHTML = '';
  if (!STATE.spLibrary.length) { list.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No saved prompts yet.</p>'; return; }
  for (const sp of STATE.spLibrary) {
    const item = document.createElement('div');
    item.className = 'sp-library-item';
    item.innerHTML = `<div style="flex:1;min-width:0"><div class="sp-library-item-name">${escapeHtml(sp.name)}</div><div class="sp-library-item-preview">${escapeHtml(sp.content.slice(0,80))}…</div></div><button class="btn-sm btn-primary sp-apply-btn">Apply</button><button class="btn-icon" data-del="${sp.id}" style="flex-shrink:0"><i data-lucide="trash-2"></i></button>`;
    item.querySelector('.sp-apply-btn').addEventListener('click', () => {
      document.getElementById('system-prompt-input').value = sp.content;
      document.getElementById('sp-library-overlay').classList.add('hidden');
      toast(`"${sp.name}" applied`, 'success');
    });
    item.querySelector('[data-del]').addEventListener('click', () => {
      STATE.spLibrary = STATE.spLibrary.filter(x => x.id !== sp.id);
      STORE.saveSPLibrary();
      renderSPLibrary();
    });
    list.appendChild(item);
    lucide.createIcons({ nodes: [item] });
  }
}

// ==================== IN-CONVERSATION SEARCH ====================
function convSearch(query) {
  // Clear highlights — use replaceWith(textNode) to avoid HTML entity corruption
  document.querySelectorAll('.search-highlight').forEach(el => {
    el.replaceWith(document.createTextNode(el.textContent));
  });
  STATE.convSearchMatches = [];
  STATE.convSearchIndex = 0;
  if (!query) { updateConvSearchCount(); return; }
  const bubbles = document.querySelectorAll('.message-bubble');
  const q = query.toLowerCase();
  bubbles.forEach(bubble => {
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);
    textNodes.forEach(tn => {
      const idx = tn.textContent.toLowerCase().indexOf(q);
      if (idx === -1) return;
      const span = document.createElement('span');
      span.className = 'search-highlight';
      const before = document.createTextNode(tn.textContent.slice(0, idx));
      span.textContent = tn.textContent.slice(idx, idx + query.length);
      const after = document.createTextNode(tn.textContent.slice(idx + query.length));
      const frag = document.createDocumentFragment();
      frag.appendChild(before); frag.appendChild(span); frag.appendChild(after);
      tn.parentNode.replaceChild(frag, tn);
      STATE.convSearchMatches.push(span);
    });
  });
  highlightCurrentMatch();
  updateConvSearchCount();
}

function highlightCurrentMatch() {
  document.querySelectorAll('.search-highlight.current').forEach(el => el.classList.remove('current'));
  const m = STATE.convSearchMatches[STATE.convSearchIndex];
  if (m) { m.classList.add('current'); m.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

function updateConvSearchCount() {
  document.getElementById('conv-search-count').textContent = STATE.convSearchMatches.length ? `${STATE.convSearchIndex + 1}/${STATE.convSearchMatches.length}` : '0/0';
}

// ==================== EXPORT / SHARE ====================
function exportConversationAs(format) {
  const conv = getActiveConversation();
  if (!conv) { toast('No active conversation.', 'warning'); return; }
  if (format === 'markdown') {
    let md = `# ${conv.title}\n_Provider: ${conv.provider} / ${conv.model}_\n\n`;
    conv.messages.forEach(m => { md += `**${m.role === 'user' ? 'User' : 'Assistant'}:**\n${getTextContent(m)}\n\n---\n\n`; });
    downloadFile(md, `${conv.title}.md`, 'text/markdown');
  } else if (format === 'txt') {
    let txt = conv.messages.map(m => `[${m.role.toUpperCase()}]\n${getTextContent(m)}`).join('\n\n');
    downloadFile(txt, `${conv.title}.txt`, 'text/plain');
  } else if (format === 'json') {
    downloadFile(JSON.stringify(conv, null, 2), `${conv.title}.json`, 'application/json');
  } else if (format === 'html') {
    shareAsHTML(conv);
  }
  document.getElementById('export-conv-overlay').classList.add('hidden');
  toast('Exported!', 'success');
}

function shareAsHTML(conv) {
  const msgs = conv.messages.map(m => {
    const text = getTextContent(m);
    const rendered = m.role === 'assistant' ? `<div class="msg-content">${marked.parse(text)}</div>` : `<div class="msg-content" style="white-space:pre-wrap">${escapeHtml(text)}</div>`;
    return `<div class="msg ${m.role}"><strong class="msg-role">${m.role === 'user' ? '👤 User' : '🤖 Assistant'}</strong>${rendered}</div>`;
  }).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(conv.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"><\/script>
<style>body{font-family:'IBM Plex Sans',sans-serif;max-width:820px;margin:40px auto;padding:0 20px;background:#0d1117;color:#f0f6fc;line-height:1.6}h1{border-bottom:1px solid #30363d;padding-bottom:10px;font-size:22px}.meta{color:#8b949e;font-size:13px;margin-bottom:30px}.msg{margin:18px 0;padding:14px 18px;border-radius:12px;border:1px solid #30363d}.msg.user{background:#1a2332;border-top-right-radius:4px}.msg.assistant{background:#161b22;border-top-left-radius:4px}.msg-role{display:block;margin-bottom:8px;font-size:13px;color:#8b949e}pre{background:#21262d;padding:12px;border-radius:8px;overflow-x:auto}code{background:#21262d;padding:2px 5px;border-radius:4px;font-size:13px}a{color:#00d4ff}table{border-collapse:collapse;width:100%}th,td{border:1px solid #30363d;padding:8px 12px}</style></head>
<body><h1>${escapeHtml(conv.title)}</h1><div class="meta">${conv.provider} · ${conv.model} · Exported ${new Date().toLocaleString()}</div>${msgs}</body></html>`;
  downloadFile(html, `${conv.title}.html`, 'text/html');
}

// ==================== VOICE INPUT ====================
function toggleVoiceInput() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) { toast('Web Speech API not available in this browser.', 'error'); return; }
  if (STATE.voiceListening) {
    STATE.voiceRecognition?.stop();
    STATE.voiceListening = false;
    document.getElementById('voice-btn').classList.remove('voice-active');
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SpeechRecognition();
  rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
  let voiceFinal = '';
  rec.onresult = e => {
    const input = document.getElementById('user-input');
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) voiceFinal += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    input.value = voiceFinal + interim;
    autoResize(input);
    UI.updateCharCount();
  };
  rec.onerror = e => { toast('Voice error: ' + e.error, 'error'); STATE.voiceListening = false; document.getElementById('voice-btn').classList.remove('voice-active'); };
  rec.onend = () => { STATE.voiceListening = false; document.getElementById('voice-btn').classList.remove('voice-active'); };
  rec.start();
  STATE.voiceRecognition = rec;
  STATE.voiceListening = true;
  document.getElementById('voice-btn').classList.add('voice-active');
  toast('Listening…', 'info', 2000);
}

// ==================== BRANCH VISUALIZER ====================
function showBranchVisualizer() {
  const conv = getActiveConversation();
  const container = document.getElementById('branch-tree-container');
  if (!conv) { container.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No active conversation.</p>'; return; }
  const branches = STATE.branches[conv.id] || [];
  if (!branches.length) { container.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No branches yet. Edit a user message and re-send to create a branch.</p>'; document.getElementById('branch-overlay').classList.remove('hidden'); return; }
  let html = `<div class="branch-tree"><div class="branch-node active-node"><span class="branch-line">●</span> <span><strong>Current</strong> — ${conv.messages.length} messages</span></div>`;
  branches.forEach((b, i) => {
    html += `<div class="branch-node" data-branch="${i}" style="padding-left:24px"><span class="branch-line">└─</span> Branch at msg ${b.at} <span class="branch-msg-preview">(${b.messages.length} msgs)</span><button class="btn-sm" style="margin-left:auto" onclick="restoreBranch(${i})">Restore</button></div>`;
  });
  html += '</div>';
  container.innerHTML = html;
  document.getElementById('branch-overlay').classList.remove('hidden');
}

function restoreBranch(branchIdx) {
  const conv = getActiveConversation();
  if (!conv) return;
  const branches = STATE.branches[conv.id] || [];
  const b = branches[branchIdx];
  if (!b) return;
  if (!confirm('Restore this branch? Current messages will be saved as a new branch.')) return;
  // Save current as branch
  branches.push({ at: conv.messages.length - 1, messages: [...conv.messages] });
  conv.messages = b.messages;
  conv.updatedAt = Date.now();
  STORE.saveConversations();
  STORE.saveBranches();
  UI.renderMessages(conv.messages);
  toast('Branch restored!', 'success');
  document.getElementById('branch-overlay').classList.add('hidden');
}

// ==================== COMPARE MODE SETUP ====================
function openCompareMode() {
  const comp = document.getElementById('compare-overlay');
  comp.classList.remove('hidden');
  ['left', 'right'].forEach(s => { document.getElementById(`compare-${s}-messages`).innerHTML = ''; });
  const sides = ['left', 'right'];
  const providerKeys = Object.keys(PROVIDERS);
  sides.forEach((side, si) => {
    const pSel = document.getElementById(`compare-${side}-provider`);
    const mSel = document.getElementById(`compare-${side}-model`);
    pSel.innerHTML = providerKeys.map(id => `<option value="${id}"${id === (si === 0 ? 'anthropic' : 'openai') ? ' selected' : ''}>${PROVIDERS[id].name}</option>`).join('');
    const defProv = si === 0 ? 'anthropic' : 'openai';
    mSel.innerHTML = PROVIDERS[defProv].models.map(m => `<option value="${m.id}">${m.label}</option>`).join('');

    // Clone the select to wipe all previously attached listeners before adding a fresh one
    const freshPSel = pSel.cloneNode(true);
    pSel.parentNode.replaceChild(freshPSel, pSel);
    freshPSel.addEventListener('change', () => {
      mSel.innerHTML = PROVIDERS[freshPSel.value].models.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
    });
  });
}

// ==================== PARAMS PANEL ====================
const PARAM_DEFS = [
  { key: 'temperature', label: 'Temperature', type: 'range', min: 0, max: 2, step: 0.01, default: 1 },
  { key: 'max_tokens', label: 'Max Tokens', type: 'range', min: 256, max: 128000, step: 256, default: 4096 },
  { key: 'top_p', label: 'Top P', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
  { key: 'top_k', label: 'Top K', type: 'number', min: 1, max: 1000, default: '' },
  { key: 'frequency_penalty', label: 'Frequency Penalty', type: 'range', min: -2, max: 2, step: 0.01, default: 0 },
  { key: 'presence_penalty', label: 'Presence Penalty', type: 'range', min: -2, max: 2, step: 0.01, default: 0 },
  { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 999999, default: '' },
  { key: 'stop_sequences', label: 'Stop Sequences', type: 'text', placeholder: 'comma, separated', default: '' },
];

function buildParamsGrid() {
  const grid = document.getElementById('params-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const def of PARAM_DEFS) {
    const val = STATE.params[def.key] ?? def.default;
    const div = document.createElement('div');
    div.className = 'params-group';
    if (def.type === 'range') {
      div.innerHTML = `<div class="params-label"><span>${def.label}</span><span class="params-value" id="pv-${def.key}">${val}</span></div>
        <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${val}" id="ps-${def.key}">`;
      div.querySelector('input').addEventListener('input', e => {
        STATE.params[def.key] = parseFloat(e.target.value);
        document.getElementById(`pv-${def.key}`).textContent = STATE.params[def.key];
        STORE.saveParams();
      });
    } else if (def.type === 'number') {
      div.innerHTML = `<div class="params-label">${def.label}</div><input type="number" min="${def.min}" max="${def.max}" value="${val||''}" placeholder="default" id="ps-${def.key}" style="width:100%">`;
      div.querySelector('input').addEventListener('change', e => { STATE.params[def.key] = e.target.value ? parseInt(e.target.value) : null; STORE.saveParams(); });
    } else {
      div.innerHTML = `<div class="params-label">${def.label}</div><input type="text" value="${escapeHtml(val)}" placeholder="${def.placeholder||''}" id="ps-${def.key}" style="width:100%">`;
      div.querySelector('input').addEventListener('input', e => { STATE.params[def.key] = e.target.value; STORE.saveParams(); });
    }
    grid.appendChild(div);
  }

  // Extended thinking toggle (Anthropic)
  const thinkDiv = document.createElement('div');
  thinkDiv.className = 'params-group';
  thinkDiv.innerHTML = `<label class="toggle-switch"><input type="checkbox" id="ps-extended-thinking" ${STATE.params.extended_thinking ? 'checked':''}> Extended Thinking (Anthropic)</label>
    <div id="thinking-budget-wrap" style="margin-top:8px;${STATE.params.extended_thinking?'':'display:none'}"><div class="params-label"><span>Thinking Budget Tokens</span><span class="params-value" id="pv-thinking-budget">${STATE.params.thinking_budget||8000}</span></div><input type="range" min="1000" max="32000" step="500" value="${STATE.params.thinking_budget||8000}" id="ps-thinking-budget"></div>`;
  thinkDiv.querySelector('#ps-extended-thinking').addEventListener('change', e => {
    STATE.params.extended_thinking = e.target.checked;
    document.getElementById('thinking-budget-wrap').style.display = e.target.checked ? 'block' : 'none';
    STORE.saveParams();
  });
  thinkDiv.querySelector('#ps-thinking-budget')?.addEventListener('input', e => {
    STATE.params.thinking_budget = parseInt(e.target.value);
    document.getElementById('pv-thinking-budget').textContent = STATE.params.thinking_budget;
  });
  grid.appendChild(thinkDiv);

  // JSON mode toggle
  const jsonDiv = document.createElement('div');
  jsonDiv.className = 'params-group';
  jsonDiv.innerHTML = `<label class="toggle-switch"><input type="checkbox" id="ps-json-mode" ${STATE.params.json_mode ? 'checked':''}> JSON Mode (force JSON output)</label>`;
  jsonDiv.querySelector('input').addEventListener('change', e => { STATE.params.json_mode = e.target.checked; STORE.saveParams(); });
  grid.appendChild(jsonDiv);
}

const PRESETS = {
  creative: { temperature: 1.4, top_p: 0.95, frequency_penalty: 0.3, presence_penalty: 0.3 },
  balanced: { temperature: 1.0, top_p: 1, frequency_penalty: 0, presence_penalty: 0 },
  precise: { temperature: 0.2, top_p: 0.7, frequency_penalty: 0, presence_penalty: 0 },
};

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  Object.assign(STATE.params, preset);
  buildParamsGrid();
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
}


// ==================== FILE HANDLING ====================
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
}

async function handleImageFiles(files) {
  const provider = document.getElementById('provider-select').value;
  const p = PROVIDERS[provider];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (!p?.supportedFeatures?.vision) {
      toast(`${p?.name || provider} doesn't support vision. Image will be attached but may be ignored.`, 'warning');
    }
    const b64 = await fileToBase64(file);
    const att = { id: uid(), type: 'image', mediaType: file.type, data: b64, name: file.name };
    STATE.attachments.push(att);
    UI.addAttachmentPreview(att);
  }
}

async function handleDocFiles(files) {
  const provider = document.getElementById('provider-select').value;
  for (const file of files) {
    if (file.type === 'application/pdf') {
      if (PROVIDERS[provider]?.supportedFeatures?.files) {
        const b64 = await fileToBase64(file);
        const att = { id: uid(), type: 'file', mediaType: 'application/pdf', data: b64, name: file.name };
        STATE.attachments.push(att);
        UI.addAttachmentPreview(att);
      } else {
        toast(`Extracting text from PDF "${file.name}"…`, 'info');
        try {
          const text = await extractPDFText(file);
          const att = { id: uid(), type: 'file', mediaType: 'text/plain', name: file.name, extractedText: text };
          STATE.attachments.push(att);
          UI.addAttachmentPreview(att);
          toast(`PDF extracted (${text.length} chars)`, 'success');
        } catch (e) { toast('PDF extraction failed: ' + e.message, 'error'); }
      }
    } else {
      // Plain text files
      const text = await file.text();
      const att = { id: uid(), type: 'file', mediaType: file.type || 'text/plain', name: file.name, extractedText: `[File: ${file.name}]\n${text}` };
      STATE.attachments.push(att);
      UI.addAttachmentPreview(att);
    }
  }
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = () => rej(new Error('FileReader error'));
    r.readAsDataURL(file);
  });
}

async function extractPDFText(file) {
  if (!window.pdfjsLib) throw new Error('PDF.js not loaded');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(s => s.str).join(' ') + '\n';
  }
  return text;
}

// ==================== IMPORT / EXPORT (SETTINGS) ====================
function exportAllConversations() {
  const data = JSON.stringify({ conversations: STATE.conversations, exportedAt: new Date().toISOString() }, null, 2);
  downloadFile(data, `nexusai-conversations-${Date.now()}.json`, 'application/json');
  toast('Conversations exported!', 'success');
}

async function exportEncryptedSettings() {
  const pw = document.getElementById('export-password').value;
  if (!pw) { toast('Enter an encryption password.', 'warning'); return; }
  const data = JSON.stringify({ settings: STATE.settings, apiKeys: STORE.loadApiKeys(), spLibrary: STATE.spLibrary, templates: STATE.templates, params: STATE.params });
  try {
    const encrypted = await encryptData(data, pw);
    downloadFile(encrypted, `nexusai-settings-${Date.now()}.json`, 'application/json');
    toast('Settings exported (encrypted)!', 'success');
  } catch (e) { toast('Encryption failed: ' + e.message, 'error'); }
}

function importConversations(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      const convs = data.conversations || data;
      if (!Array.isArray(convs)) throw new Error('Invalid format');
      STATE.conversations = [...STATE.conversations, ...convs];
      STORE.saveConversations();
      renderConvList();
      toast(`Imported ${convs.length} conversations!`, 'success');
    } catch (err) { toast('Import failed: ' + err.message, 'error'); }
  };
  reader.readAsText(file);
}

async function importEncryptedSettings(file) {
  const pw = document.getElementById('import-password').value;
  if (!pw) { toast('Enter the decryption password.', 'warning'); return; }
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const decrypted = await decryptData(e.target.result, pw);
      const data = JSON.parse(decrypted);
      if (data.settings) { STATE.settings = { ...STATE.settings, ...data.settings }; STORE.saveSettings(); }
      if (data.apiKeys) STORE.saveApiKeys(data.apiKeys);
      if (data.spLibrary) { STATE.spLibrary = data.spLibrary; STORE.saveSPLibrary(); }
      if (data.templates) { STATE.templates = data.templates; STORE.saveTemplates(); }
      if (data.params) { STATE.params = { ...STATE.params, ...data.params }; STORE.saveParams(); }
      applySettings();
      // Re-sync all UI that depends on freshly imported state
      buildParamsGrid();
      populateSettingsUI();
      renderTemplatesList();
      toast('Settings imported successfully!', 'success');
      document.getElementById('settings-overlay').classList.add('hidden');
    } catch (e) { toast('Decryption failed — wrong password?', 'error'); }
  };
  reader.readAsText(file);
}

// ==================== KEYBOARD SHORTCUTS ====================
const SHORTCUTS = [
  { keys: 'Ctrl+K', desc: 'New conversation', action: () => newChat() },
  { keys: 'Ctrl+/', desc: 'Open settings', action: () => openSettings() },
  { keys: 'Ctrl+M', desc: 'Open memory editor', action: () => { document.getElementById('memory-panel').classList.toggle('hidden'); document.getElementById('memory-input').value = STATE.memory; } },
  { keys: 'Ctrl+E', desc: 'Toggle artifact panel', action: () => { const p = document.getElementById('artifact-panel'); if (p.classList.contains('hidden') && STATE.artifacts.length) UI.openArtifactPanel(STATE.artifacts); else UI.closeArtifactPanel(); } },
  { keys: 'Ctrl+Shift+C', desc: 'Copy last assistant message', action: () => { const conv = getActiveConversation(); const last = [...(conv?.messages||[])].reverse().find(m => m.role==='assistant'); if (last) copyText(getTextContent(last)); } },
  { keys: 'Ctrl+R', desc: 'Regenerate last response', action: () => regenerate() },
  { keys: 'Escape', desc: 'Close any open panel', action: () => closeAllPanels() },
  { keys: '?', desc: 'Show keyboard shortcuts', action: () => document.getElementById('shortcuts-overlay').classList.toggle('hidden') },
];

function buildShortcutsModal() {
  const grid = document.getElementById('shortcuts-grid');
  grid.innerHTML = SHORTCUTS.map(s => `<div class="shortcut-item"><span class="shortcut-key">${s.keys}</span><span class="shortcut-desc">${s.desc}</span></div>`).join('');
}

function closeAllPanels() {
  ['settings-overlay','sp-library-overlay','shortcuts-overlay','branch-overlay','cost-overlay','template-edit-overlay','export-conv-overlay'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
  document.getElementById('memory-panel').classList.add('hidden');
  document.getElementById('params-panel').classList.add('hidden');
  document.getElementById('compare-overlay').classList.add('hidden');
}

// ==================== DRAG & DROP ====================
function setupDragDrop() {
  const app = document.getElementById('app');
  const overlay = document.getElementById('drop-overlay');
  let dragCounter = 0;
  app.addEventListener('dragenter', e => { e.preventDefault(); dragCounter++; overlay.classList.remove('hidden'); });
  app.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; overlay.classList.add('hidden'); } });
  app.addEventListener('dragover', e => e.preventDefault());
  app.addEventListener('drop', async e => {
    e.preventDefault(); dragCounter = 0; overlay.classList.add('hidden');
    const files = Array.from(e.dataTransfer.files);
    const imgs = files.filter(f => f.type.startsWith('image/'));
    const docs = files.filter(f => !f.type.startsWith('image/'));
    if (imgs.length) await handleImageFiles(imgs);
    if (docs.length) await handleDocFiles(docs);
  });
}

// ==================== PWA ====================
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ==================== INIT ====================
function init() {
  // Load data
  STORE.loadSettings();
  STORE.loadConversations();
  STORE.loadMemory();
  STORE.loadParams();
  STORE.loadTemplates();
  STORE.loadSPLibrary();
  STORE.loadBranches();

  // Apply settings
  applySettings();

  // Lucide icons
  lucide.createIcons();

  // Populate provider selector
  const provSel = document.getElementById('provider-select');
  provSel.innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${p.name}</option>`).join('');
  provSel.value = STATE.settings.defaultProvider || 'anthropic';
  UI.populateModelSelect(provSel.value);

  // Render conv list
  renderConvList();

  // Load last conversation
  if (STATE.conversations.length > 0) loadConversation(STATE.conversations[0].id);
  else UI.showEmptyState(true);

  // Build params grid
  buildParamsGrid();
  buildShortcutsModal();
  setupDragDrop();
  registerSW();

  // ===== EVENT LISTENERS =====

  // Sidebar toggle
  // Message action delegation — registered once here, not on every re-render
  document.getElementById('messages-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const conv = getActiveConversation();
    if (action === 'edit') {
      UI.editMessage(parseInt(btn.dataset.idx, 10));
    } else if (action === 'copy') {
      const m = conv?.messages.find(x => x.id === btn.dataset.msgId);
      if (m) copyText(getTextContent(m));
    } else if (action === 'fork') {
      forkConversation(parseInt(btn.dataset.idx, 10));
    } else if (action === 'regenerate') {
      regenerate();
    } else if (action === 'open-artifacts') {
      const m = conv?.messages.find(x => x.id === btn.dataset.msgId);
      if (m?.artifacts?.length) UI.openArtifactPanel(m.artifacts);
    }
  });

  // Sidebar toggle
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    if (window.innerWidth <= 860) sb.classList.toggle('mobile-open');
    else sb.classList.toggle('sidebar-hidden');
  });

  // New chat
  document.getElementById('new-chat-btn').addEventListener('click', newChat);

  // Conversation search
  document.getElementById('conv-search').addEventListener('input', renderConvList);

  // Provider / model change
  provSel.addEventListener('change', e => {
    UI.populateModelSelect(e.target.value);
    const conv = getActiveConversation();
    if (conv) { conv.provider = e.target.value; conv.model = document.getElementById('model-select').value; STORE.saveConversations(); }
    STATE.settings.currentModel = document.getElementById('model-select').value;
  });
 document.getElementById('model-select').addEventListener('change', e => {
    document.getElementById('custom-model-input').classList.toggle('hidden', e.target.value !== 'custom');
    UI.updateModelBadge(provSel.value, e.target.value);
    STATE.settings.currentModel = e.target.value;
    const conv = getActiveConversation();
    if (conv) { conv.model = e.target.value; STORE.saveConversations(); }
    UI.updateTokenBudget();
  });

  document.getElementById('custom-model-input').addEventListener('input', e => {
    STATE.settings.currentModel = e.target.value;
    const conv = getActiveConversation();
    if (conv) { conv.model = e.target.value; STORE.saveConversations(); }
  });

  // System prompt toggle
  const spBar = document.getElementById('system-prompt-bar');
  document.getElementById('sp-toggle-btn').addEventListener('click', () => {
    spBar.classList.toggle('expanded');
    document.getElementById('sp-toggle-btn').classList.toggle('active', spBar.classList.contains('expanded'));
  });
  document.getElementById('system-prompt-input').addEventListener('input', () => {
    const conv = getActiveConversation();
    if (conv) { conv.systemPrompt = document.getElementById('system-prompt-input').value; STORE.saveConversations(); }
  });
  document.getElementById('sp-save-default-btn').addEventListener('click', () => {
    STATE.settings.defaultSystemPrompt = document.getElementById('system-prompt-input').value;
    STORE.saveSettings();
    toast('Set as default system prompt.', 'success');
  });
  document.getElementById('sp-library-btn').addEventListener('click', () => {
    renderSPLibrary();
    document.getElementById('sp-library-overlay').classList.remove('hidden');
  });

  // Input textarea
  const inputEl = document.getElementById('user-input');
  inputEl.addEventListener('input', e => {
    autoResize(inputEl);
    UI.updateCharCount();
    const val = inputEl.value;
    if (val.startsWith('/')) {
      const query = val.slice(1);
      STATE.slashDropdownIndex = -1;
      renderSlashDropdown(query);
    } else {
      document.getElementById('slash-dropdown').classList.add('hidden');
    }
  });

  inputEl.addEventListener('keydown', e => {
    const dropdown = document.getElementById('slash-dropdown');
    const dropdownVisible = !dropdown.classList.contains('hidden');
    if (dropdownVisible) {
      const filtered = dropdown._filtered || [];
      if (e.key === 'ArrowDown') { e.preventDefault(); STATE.slashDropdownIndex = Math.min(STATE.slashDropdownIndex + 1, filtered.length - 1); renderSlashDropdown(inputEl.value.slice(1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); STATE.slashDropdownIndex = Math.max(STATE.slashDropdownIndex - 1, 0); renderSlashDropdown(inputEl.value.slice(1)); return; }
      if (e.key === 'Enter' && STATE.slashDropdownIndex >= 0) { e.preventDefault(); applyTemplate(filtered[STATE.slashDropdownIndex]); return; }
      if (e.key === 'Escape') { dropdown.classList.add('hidden'); return; }
    }

    const useShiftEnter = STATE.settings.sendKey === 'shift-enter';
    const shouldSend = useShiftEnter ? (e.key === 'Enter' && e.shiftKey) : (e.key === 'Enter' && !e.shiftKey);
    const shouldNewline = useShiftEnter ? (e.key === 'Enter' && !e.shiftKey) : (e.key === 'Enter' && e.shiftKey);

    if (shouldSend && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });

  // Paste image from clipboard
  inputEl.addEventListener('paste', async e => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) await handleImageFiles([file]);
      }
    }
  });

  function doSend() {
    const rawIdx = inputEl.dataset.replaceIndex;
    const replaceIndex = rawIdx !== undefined ? parseInt(rawIdx, 10) : undefined;
    delete inputEl.dataset.replaceIndex;
    // Remove cancel-edit button if present
    document.getElementById('cancel-edit-btn')?.remove();
    sendMessage({ replaceIndex: (replaceIndex !== undefined && !isNaN(replaceIndex)) ? replaceIndex : undefined, attachments: [...STATE.attachments] });
  }

  document.getElementById('send-btn').addEventListener('click', doSend);
  document.getElementById('stop-btn').addEventListener('click', stopStreaming);

  // Attach buttons
  document.getElementById('attach-image-btn').addEventListener('click', () => document.getElementById('image-file-input').click());
  document.getElementById('attach-file-btn').addEventListener('click', () => document.getElementById('doc-file-input').click());
  document.getElementById('image-file-input').addEventListener('change', async e => { await handleImageFiles(Array.from(e.target.files)); e.target.value = ''; });
  document.getElementById('doc-file-input').addEventListener('change', async e => { await handleDocFiles(Array.from(e.target.files)); e.target.value = ''; });

  // Voice
  document.getElementById('voice-btn').addEventListener('click', toggleVoiceInput);

  // URL fetch
  document.getElementById('url-fetch-toggle-btn').addEventListener('click', () => {
    document.getElementById('url-fetch-bar').classList.toggle('hidden');
    if (!document.getElementById('url-fetch-bar').classList.contains('hidden')) document.getElementById('url-fetch-input').focus();
  });
  document.getElementById('url-fetch-close').addEventListener('click', () => document.getElementById('url-fetch-bar').classList.add('hidden'));
  document.getElementById('url-fetch-btn').addEventListener('click', async () => {
    const url = document.getElementById('url-fetch-input').value.trim();
    if (!url) return;
    toast('Fetching URL…', 'info');
    try {
      const text = await fetchURL(url);
      const att = { id: uid(), type: 'file', mediaType: 'text/plain', name: new URL(url).hostname, extractedText: `[Fetched from ${url}]\n\n${text}` };
      STATE.attachments.push(att);
      UI.addAttachmentPreview(att);
      document.getElementById('url-fetch-bar').classList.add('hidden');
      document.getElementById('url-fetch-input').value = '';
      toast('Page fetched and attached!', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  // Params panel
  document.getElementById('params-btn').addEventListener('click', () => {
    document.getElementById('params-panel').classList.toggle('hidden');
    document.getElementById('memory-panel').classList.add('hidden');
  });
  document.getElementById('params-close').addEventListener('click', () => document.getElementById('params-panel').classList.add('hidden'));
  document.getElementById('params-apply').addEventListener('click', () => { STORE.saveParams(); document.getElementById('params-panel').classList.add('hidden'); toast('Parameters applied!', 'success'); });
  document.getElementById('params-save-preset').addEventListener('click', () => {
    const name = prompt('Preset name:');
    if (name) { PRESETS[name] = { ...STATE.params }; toast(`Preset "${name}" saved.`, 'success'); }
  });
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  // Memory panel
  document.getElementById('memory-btn').addEventListener('click', () => {
    document.getElementById('memory-panel').classList.toggle('hidden');
    document.getElementById('params-panel').classList.add('hidden');
    document.getElementById('memory-input').value = STATE.memory;
  });
  document.getElementById('memory-close').addEventListener('click', () => document.getElementById('memory-panel').classList.add('hidden'));
  document.getElementById('memory-save-btn').addEventListener('click', () => { STATE.memory = document.getElementById('memory-input').value; STORE.saveMemory(); toast('Memory saved!', 'success'); });
  document.getElementById('memory-clear-btn').addEventListener('click', () => { if (confirm('Clear all memory?')) { STATE.memory = ''; document.getElementById('memory-input').value = ''; STORE.saveMemory(); toast('Memory cleared.', 'success'); } });
  document.getElementById('auto-memory-btn').addEventListener('click', autoExtractMemory);

  // Cost estimator
  document.getElementById('cost-estimate-btn').addEventListener('click', showCostEstimator);
  document.getElementById('cost-close').addEventListener('click', () => document.getElementById('cost-overlay').classList.add('hidden'));

  // Settings
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', () => document.getElementById('settings-overlay').classList.add('hidden'));
  document.getElementById('settings-cancel').addEventListener('click', () => document.getElementById('settings-overlay').classList.add('hidden'));
  document.getElementById('settings-save').addEventListener('click', saveSettings);

  // Settings tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabNav = btn.closest('.tab-nav');
      const modal = btn.closest('.modal, .modal-body');
      tabNav.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tabId = btn.dataset.tab;
      modal.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      document.getElementById(`tab-${tabId}`)?.classList.add('active');
    });
  });

  // Color swatches
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      STATE.settings.accent = sw.dataset.accent;
      document.documentElement.setAttribute('data-accent', sw.dataset.accent);
    });
  });

  // System prompt library overlay
  document.getElementById('sp-library-close').addEventListener('click', () => document.getElementById('sp-library-overlay').classList.add('hidden'));
  document.getElementById('sp-save-to-library-btn').addEventListener('click', () => {
    const name = document.getElementById('sp-library-name').value.trim() || `Prompt ${STATE.spLibrary.length + 1}`;
    const content = document.getElementById('system-prompt-input').value;
    if (!content) { toast('No prompt to save.', 'warning'); return; }
    STATE.spLibrary.push({ id: uid(), name, content });
    STORE.saveSPLibrary();
    renderSPLibrary();
    document.getElementById('sp-library-name').value = '';
    toast('Saved to library!', 'success');
  });

  // In-conversation search
  document.getElementById('conv-search-toggle-btn').addEventListener('click', () => {
    document.getElementById('conv-search-bar').classList.toggle('hidden');
    if (!document.getElementById('conv-search-bar').classList.contains('hidden')) document.getElementById('conv-search-input').focus();
  });
  document.getElementById('conv-search-close').addEventListener('click', () => {
    document.getElementById('conv-search-bar').classList.add('hidden');
    convSearch('');
  });
  document.getElementById('conv-search-input').addEventListener('input', e => convSearch(e.target.value));
  document.getElementById('conv-search-prev').addEventListener('click', () => {
    if (!STATE.convSearchMatches.length) return;
    STATE.convSearchIndex = (STATE.convSearchIndex - 1 + STATE.convSearchMatches.length) % STATE.convSearchMatches.length;
    highlightCurrentMatch(); updateConvSearchCount();
  });
  document.getElementById('conv-search-next').addEventListener('click', () => {
    if (!STATE.convSearchMatches.length) return;
    STATE.convSearchIndex = (STATE.convSearchIndex + 1) % STATE.convSearchMatches.length;
    highlightCurrentMatch(); updateConvSearchCount();
  });

  // Artifact panel
  document.getElementById('artifact-close-btn').addEventListener('click', () => UI.closeArtifactPanel());
  document.getElementById('artifact-edit-toggle').addEventListener('click', () => UI.toggleArtifactEdit());
  document.getElementById('artifact-rerender-btn').addEventListener('click', () => UI.rerenderArtifact());
  document.getElementById('artifact-edit-cancel').addEventListener('click', () => {
    document.getElementById('artifact-edit-area').classList.add('hidden');
    document.getElementById('artifact-edit-area').classList.remove('visible');
    STATE.artifactEditMode = false;
    document.getElementById('artifact-edit-toggle').classList.remove('active');
  });
  document.getElementById('artifact-copy-btn').addEventListener('click', () => {
    const art = STATE.artifacts[STATE.activeArtifactIndex];
    if (art) { navigator.clipboard.writeText(art.code); toast('Code copied!', 'success'); }
  });
  document.getElementById('artifact-download-btn').addEventListener('click', () => {
    const art = STATE.artifacts[STATE.activeArtifactIndex];
    if (art) downloadFile(art.code, `artifact.${getArtifactExt(art.lang)}`, 'text/plain');
  });
  document.getElementById('artifact-open-tab-btn').addEventListener('click', () => {
    const art = STATE.artifacts[STATE.activeArtifactIndex];
    if (!art) return;
    if (art.lang === 'html') { const w = window.open(''); w.document.write(art.code); }
    else { const blob = new Blob([art.code], { type: 'text/plain' }); window.open(URL.createObjectURL(blob)); }
  });

  // Export conversation
  document.getElementById('export-conv-btn').addEventListener('click', () => document.getElementById('export-conv-overlay').classList.remove('hidden'));
  document.getElementById('export-conv-modal-close').addEventListener('click', () => document.getElementById('export-conv-overlay').classList.add('hidden'));
  document.getElementById('export-md-btn').addEventListener('click', () => exportConversationAs('markdown'));
  document.getElementById('export-txt-btn').addEventListener('click', () => exportConversationAs('txt'));
  document.getElementById('export-json-btn').addEventListener('click', () => exportConversationAs('json'));
  document.getElementById('export-html-share-btn').addEventListener('click', () => exportConversationAs('html'));
  document.getElementById('share-conv-btn').addEventListener('click', () => { const conv = getActiveConversation(); if (conv) shareAsHTML(conv); else toast('No active conversation.','warning'); });

  // Fork
  document.getElementById('fork-conv-btn').addEventListener('click', () => forkConversation());

  // Compare mode
  document.getElementById('compare-mode-btn').addEventListener('click', openCompareMode);
  document.getElementById('compare-close').addEventListener('click', () => document.getElementById('compare-overlay').classList.add('hidden'));
  document.getElementById('compare-send-btn').addEventListener('click', runCompareMode);

  // Branch vis
  document.getElementById('branch-vis-btn').addEventListener('click', showBranchVisualizer);
  document.getElementById('branch-close').addEventListener('click', () => document.getElementById('branch-overlay').classList.add('hidden'));

  // Shortcuts
  document.getElementById('shortcuts-btn').addEventListener('click', () => document.getElementById('shortcuts-overlay').classList.remove('hidden'));
  document.getElementById('shortcuts-close').addEventListener('click', () => document.getElementById('shortcuts-overlay').classList.add('hidden'));

  // Templates
  document.getElementById('add-template-btn').addEventListener('click', () => openTemplateEdit(null));
  document.getElementById('template-edit-close').addEventListener('click', () => { document.getElementById('template-edit-overlay').classList.add('hidden'); document.getElementById('settings-overlay').classList.remove('hidden'); });
  document.getElementById('template-edit-cancel').addEventListener('click', () => { document.getElementById('template-edit-overlay').classList.add('hidden'); document.getElementById('settings-overlay').classList.remove('hidden'); });
  document.getElementById('template-edit-save').addEventListener('click', saveTemplateEdit);

  // Export/import settings
  document.getElementById('export-all-conv-btn').addEventListener('click', exportAllConversations);
  document.getElementById('export-settings-btn').addEventListener('click', exportEncryptedSettings);
  document.getElementById('import-conv-btn').addEventListener('click', () => document.getElementById('import-conv-file').click());
  document.getElementById('import-conv-file').addEventListener('change', e => { if (e.target.files[0]) importConversations(e.target.files[0]); e.target.value = ''; });
  document.getElementById('import-settings-btn').addEventListener('click', () => document.getElementById('import-settings-file').click());
  document.getElementById('import-settings-file').addEventListener('change', async e => { if (e.target.files[0]) await importEncryptedSettings(e.target.files[0]); e.target.value = ''; });
  document.getElementById('clear-all-data-btn').addEventListener('click', () => {
    if (confirm('Delete ALL conversations, settings, and API keys? This cannot be undone.')) { STORE.clear(); location.reload(); }
  });

  // Custom CSS
  document.getElementById('apply-custom-css-btn').addEventListener('click', () => {
    document.getElementById('custom-user-css').textContent = document.getElementById('custom-css-input').value;
    toast('Custom CSS applied!', 'success');
  });
  document.getElementById('clear-custom-css-btn').addEventListener('click', () => {
    document.getElementById('custom-css-input').value = '';
    document.getElementById('custom-user-css').textContent = '';
  });

  // Highlight.js theme change
  document.getElementById('hljs-theme-select').addEventListener('change', e => {
    document.getElementById('hljs-theme-link').href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${e.target.value}.min.css`;
    STATE.settings.hljsTheme = e.target.value;
  });

  // Keyboard shortcut handler
  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
    if (e.key === 'Escape') { closeAllPanels(); return; }
    if (!inInput && e.key === '?') { document.getElementById('shortcuts-overlay').classList.remove('hidden'); return; }
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'k') { e.preventDefault(); newChat(); }
      else if (e.key === '/') { e.preventDefault(); openSettings(); }
      else if (e.key === 'm') { e.preventDefault(); document.getElementById('memory-panel').classList.toggle('hidden'); document.getElementById('memory-input').value = STATE.memory; }
      else if (e.key === 'e') { e.preventDefault(); const p = document.getElementById('artifact-panel'); if (p.classList.contains('hidden') && STATE.artifacts.length) UI.openArtifactPanel(STATE.artifacts); else UI.closeArtifactPanel(); }
      else if (e.key === 'r' && !e.shiftKey) { e.preventDefault(); regenerate(); }
      else if (e.key === 'C' && e.shiftKey) { e.preventDefault(); const conv = getActiveConversation(); const last = [...(conv?.messages||[])].reverse().find(m => m.role==='assistant'); if (last) copyText(getTextContent(last)); }
      else if (e.key === 'f') { e.preventDefault(); document.getElementById('conv-search-bar').classList.remove('hidden'); document.getElementById('conv-search-input').focus(); }
    }
  });

  // Close overlays on backdrop click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
  });

  // System dark mode watch
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (STATE.settings.theme === 'system') applySettings(); });

  // Auto-resize textarea on load
  autoResize(inputEl);
  UI.updateCharCount();

  console.log('%cNexusAI ready.', 'color:#00d4ff;font-weight:bold;font-size:16px');
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', init);
