const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function localizationFromHTML(html) {
  const dictionary = html.match(/^const I18N_EN = Object\.assign\(Object\.create\(null\), \{[\s\S]*?^\}\);/m);
  const extensions = [...html.matchAll(/^Object\.assign\(I18N_EN, \{[\s\S]*?^\}\);/gm)];
  const translate = html.match(/^function uiT\(source, params = \{\}\)\{[\s\S]*?^\}/m);
  const aiHelpers = html.match(/^function aiUI\(source, params = \{\}\)\{[\s\S]*?(?=^const AIClient = )/m);
  if (!dictionary || !translate || !aiHelpers) throw new Error('The real AI localization helpers were not found in svg-tweak.html');
  // Exercise the same translator, message recipes and redaction helpers as the
  // browser. Only the initial language is supplied by this DOM-free VM harness.
  return [dictionary[0], ...extensions.map(match => match[0]), 'let uiLanguage = "zh-CN";', translate[0], aiHelpers[0]].join('\n');
}

async function run(source, localizationSource) {
  if (!localizationSource) localizationSource = localizationFromHTML(fs.readFileSync(path.join(__dirname, '..', 'svg-tweak.html'), 'utf8'));
  function harness(fetch = async () => { throw new Error('Unexpected fetch in unit test'); }, language = 'zh-CN') {
    const timers = [];
    const context = vm.createContext({
      URL, AbortController, fetch,
      setTimeout(fn, ms) { const timer = { fn, ms, cleared:false }; timers.push(timer); return timer; },
      clearTimeout(timer) { if (timer) timer.cleared = true; }
    });
    const client = vm.runInContext(localizationSource + '\n' + source + '\nAIClient;', context);
    vm.runInContext('uiLanguage = ' + JSON.stringify(language), context);
    return { client, timers, cleaned() { assert(timers.every(t => t.cleared), 'request timer was not released'); } };
  }
  function externalSignal(aborted = false) {
    const listeners = new Set();
    return {
      listeners,
      signal: {
        get aborted() { return aborted; },
        addEventListener(_type, listener) { listeners.add(listener); },
        removeEventListener(_type, listener) { listeners.delete(listener); }
      },
      abort() { aborted = true; for (const listener of listeners) listener(); }
    };
  }
  const response = (data, status = 200) => ({ ok:status >= 200 && status < 300, status, text:async () => typeof data === 'string' ? data : JSON.stringify(data) });
  const modelResponse = content => ({ choices:[{ finish_reason:'stop', message:{ content } }] });
  const config = { baseURL:'https://example.test/v1', model:'test-model', apiKey:'s[e]c$ret"token' };
  const messages = [{ role:'user', content:'调整文字，不要联网测试。' }];
  const waitingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name:'AbortError' })), { once:true });
  });

  const endpoints = harness().client;
  for (const [base, expected] of [
    ['https://example.test', 'https://example.test/chat/completions'],
    ['https://example.test/v1/', 'https://example.test/v1/chat/completions'],
    ['https://example.test/v1/chat/completions/', 'https://example.test/v1/chat/completions'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1/chat/completions'],
    ['http://127.0.0.1:1234', 'http://127.0.0.1:1234/chat/completions'],
    ['http://[::1]:1234/v1', 'http://[::1]:1234/v1/chat/completions']
  ]) assert.equal(endpoints.endpoint(base), expected);
  for (const base of ['', 'not a url', 'http://example.test/v1', 'ftp://localhost/v1', 'https://name:pass@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/v1?', 'https://example.test/v1#secret']) {
    assert.throws(() => endpoints.endpoint(base), undefined, base);
  }

  let posted;
  const plain = harness(async (url, options) => {
    posted = { url, options }; return response(modelResponse('{"summary":"已准备","operations":[]}'));
  });
  const signal = externalSignal();
  assert.equal(await plain.client.complete(config, messages, { signal:signal.signal }), '{"summary":"已准备","operations":[]}');
  assert.equal(posted.url, 'https://example.test/v1/chat/completions');
  assert.equal(posted.options.method, 'POST');
  assert.equal(posted.options.headers.Authorization, 'Bearer ' + config.apiKey);
  assert.deepEqual(JSON.parse(posted.options.body), { model:'test-model', messages, stream:false });
  assert.equal(plain.timers[0].ms, 180000);
  assert.equal(signal.listeners.size, 0);
  plain.cleaned();

  const noKey = harness(async (_url, options) => {
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
    return response(modelResponse([{ type:'text', text:'第一段' }, { type:'image', image_url:'ignored' }, { type:'text', text:'\n第二段' }]));
  });
  assert.equal(await noKey.client.complete({ ...config, apiKey:'' }, messages), '第一段\n第二段');
  noKey.cleaned();

  const tools = harness(async () => response({ choices:[{ finish_reason:'tool_calls', message:{ content:null, tool_calls:[{ function:{ name:'edit', arguments:'{"summary":"工具方案","operations":[]}' } }] } }] }));
  assert.equal(await tools.client.complete(config, messages), '{"summary":"工具方案","operations":[]}');
  tools.cleaned();

  for (const [data, status, expected] of [
    [{ error:{ message:'bad key ' + config.apiKey + ' repeated ' + config.apiKey } }, 401, /HTTP 401/],
    ['upstream failed: ' + config.apiKey, 502, /HTTP 502/],
    ['', 200, /空响应/],
    ['{"choices":', 200, /不是有效 JSON/],
    ['null', 200, /没有模型响应/],
    [{ error:{ message:'provider says ' + config.apiKey } }, 200, /服务返回错误/],
    [{ choices:[{ message:{ content:'' } }] }, 200, /没有返回可用内容/],
    [{ choices:[{ finish_reason:'length', message:{ content:'{"summary":"partial' } }] }, 200, /截断/]
  ]) {
    const test = harness(async () => response(data, status));
    const external = externalSignal();
    await assert.rejects(test.client.complete(config, messages, { signal:external.signal }), error => {
      assert.match(error.message, expected);
      assert.equal(error.message.includes(config.apiKey), false, 'API key leaked into an error');
      return true;
    });
    assert.equal(external.listeners.size, 0);
    test.cleaned();
  }

  const network = harness(async () => { throw new TypeError('Failed to fetch ' + config.apiKey); });
  await assert.rejects(network.client.complete(config, messages), error => {
    assert.match(error.message, /网络.*CORS/);
    assert.equal(error.message.includes(config.apiKey), false);
    return true;
  });
  network.cleaned();

  const english = harness(async () => response({error:{message:'provider says ' + config.apiKey}}, 401), 'en');
  await assert.rejects(english.client.complete(config, messages), error => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /[\u3400-\u9fff]/, 'nested API errors and redaction must use the real English translator');
    assert.equal(error.message.includes(config.apiKey), false);
    return true;
  });
  await assert.rejects(english.client.complete({...config, model:''}, messages), /model name/i);
  english.cleaned();

  const early = harness();
  const alreadyAborted = externalSignal(true);
  await assert.rejects(early.client.complete(config, messages, { signal:alreadyAborted.signal }), /请求已取消/);
  assert.equal(early.timers.length, 0);
  assert.equal(alreadyAborted.listeners.size, 0);
  await assert.rejects(early.client.complete({ ...config, model:'' }, messages), /模型名称/);
  await assert.rejects(early.client.complete(config, []), /没有可发送/);

  const cancelled = harness(waitingFetch);
  const cancellingSignal = externalSignal();
  const userRequest = cancelled.client.complete(config, messages, { signal:cancellingSignal.signal });
  cancellingSignal.abort();
  cancelled.timers[0].fn();
  await assert.rejects(userRequest, /请求已取消/);
  assert.equal(cancellingSignal.listeners.size, 0);
  cancelled.cleaned();

  const timeout = harness(waitingFetch);
  const timeoutSignal = externalSignal();
  const timedRequest = timeout.client.complete(config, messages, { signal:timeoutSignal.signal });
  timeout.timers[0].fn();
  timeoutSignal.abort();
  await assert.rejects(timedRequest, /超过 180 秒/);
  assert.equal(timeoutSignal.listeners.size, 0);
  timeout.cleaned();

  const plan = { summary:'只回答问题也可以', operations:[] };
  assert.equal(JSON.stringify(endpoints.parsePlan(JSON.stringify(plan))), JSON.stringify(plan));
  assert.equal(JSON.stringify(endpoints.parsePlan('```json\n' + JSON.stringify(plan) + '\n```')), JSON.stringify(plan));
  assert.equal(endpoints.parsePlan(JSON.stringify({ summary:'批量', operations:Array(100).fill({}) })).operations.length, 100);
  for (const invalid of ['not json', 'null', '[]', '{}', '{"summary":1,"operations":[]}', '{"summary":"x","operations":{}}', JSON.stringify({ summary:'too many', operations:Array(101).fill({}) }), '说明文字\n```json\n' + JSON.stringify(plan) + '\n```']) {
    assert.throws(() => endpoints.parsePlan(invalid), undefined, invalid.slice(0, 80));
  }
  console.log('PASS: AI API endpoint, mocked transport, key redaction, text blocks, tools, cancel/timeout and plan parsing (no external calls)');
}

if (require.main === module) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'svg-tweak.html'), 'utf8');
  const match = html.match(/const AIClient = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
  if (!match) throw new Error('AIClient was not found in svg-tweak.html');
  run(match[0], localizationFromHTML(html)).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { run };
