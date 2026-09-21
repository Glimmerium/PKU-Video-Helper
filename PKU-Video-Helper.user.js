// ==UserScript==
// @name         北大课程回放下载补丁（兼容 PKU Art）
// @namespace    local.pku.video.helper
// @version      1.0.3
// @description  使用播放器实际媒体地址下载回放；识别 HTML 错误页；仅作用于回放播放器。
// @match        https://onlineroomse.pku.edu.cn/player*
// @run-at       document-start
// @grant        unsafeWindow
// @license      MIT
// ==/UserScript==

/* Independent implementation. PKU Art's public source documents the player
 * response schema (list[].sub_content.save_playback.contents). This script
 * does not use its legacy downloadVideo.action conversion.
 * No password, cookie-reading API, account mutation API or remote dependency.
 */
(function () {
  'use strict';
  const HOSTS = new Set(['resourcese.pku.edu.cn', 'resource.pku.edu.cn', 'onlineroomse.pku.edu.cn']);
  const MiB = 1024 * 1024;
  const decoder = new TextDecoder();
  function fail(message) { throw new Error(message); }
  function safeURL(value, base) {
    const u = new URL(value, base);
    if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.username || u.password || (u.port && u.port !== '443'))
      fail('媒体地址不在已允许的北大回放服务器内。');
    u.hash = '';
    return u.href;
  }
  function mediaURL(value, base) {
    try {
      const url = safeURL(value, base);
      if (/\.(m3u8|mp4)(?:$|\?)/i.test(url)) return url;
    } catch (_) { /* Ignore unrelated player resources. */ }
    return null;
  }
  function filename(value) {
    let s = String(value || '课程回放').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 140);
    if (!s) s = '课程回放';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s)) s = '_' + s;
    return s;
  }
  function chooseSaveFile(realWindow, suggestedName) {
    // Tampermonkey's sandbox window is a proxy. Native Window methods must
    // receive the actual page Window, never the sandbox as their receiver.
    return realWindow.showSaveFilePicker({ suggestedName });
  }
  function classify(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Verify binary signatures before interpreting MIME labels or text.
    if (b.length >= 377 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return 'ts';
    if (b.length >= 12 && /^(ftyp|styp|moof|moov|sidx|free|mdat)$/.test(decoder.decode(b.subarray(4, 8)))) return 'mp4';
    const text = decoder.decode(b.subarray(0, 2048)).replace(/^\uFEFF/, '').trimStart();
    if (/^(?:<!doctype|<html|<head|<body|<\?xml|<!--)/i.test(text)) return 'error';
    // An encrypted segment or key may happen to start with '[' or '{'.
    // A leading byte alone is not evidence that it is a JSON error response.
    if (/^[\[{]/.test(text) && b.length <= 16384) {
      try { JSON.parse(decoder.decode(b).replace(/^\uFEFF/, '')); return 'error'; } catch (_) { /* Binary or non-JSON content. */ }
    }
    if (text.startsWith('#EXTM3U')) return 'hls';
    return 'unknown';
  }
  function responseInfo(url, status, contentType, bytes) {
    const bodyKind = classify(bytes);
    const info = { status, host: new URL(url).hostname, contentType,
      transport: 'page-xhr-with-credentials', byteLength: bytes.byteLength, bodyKind };
    if (bodyKind === 'error') {
      const snippet = decoder.decode(bytes.subarray(0, 4096));
      // Only report fixed diagnostic labels, never arbitrary response text.
      info.errorHints = [
        ['permission', /无权限|没有权限|权限不足|forbidden|access denied/i],
        ['login', /登录|登陆|sign in|log in/i],
        ['expired', /过期|失效|expired/i],
        ['not-found', /不存在|not found/i]
      ].filter(([, pattern]) => pattern.test(snippet)).map(([label]) => label);
    }
    return info;
  }
  function requireMedia(bytes, expected) {
    const kind = classify(bytes);
    if (kind === 'error') fail('服务器返回了网页或错误信息，已停止，未将 HTM 当作视频保存。请重新登录并重新打开回放。');
    if (kind !== expected) fail('返回内容不是预期的视频格式，已停止保存。');
  }
  function attrs(text) {
    const result = {};
    const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g;
    let m;
    while ((m = re.exec(text))) result[m[1]] = m[2] === undefined ? m[3] : m[2];
    return result;
  }
  function rangeSpec(raw, previous, url) {
    const m = /^(\d+)(?:@(\d+))?$/.exec(raw);
    if (!m) fail('无法识别视频字节范围。');
    const length = Number(m[1]);
    const start = m[2] !== undefined ? Number(m[2]) : previous && previous.url === url ? previous.end + 1 : NaN;
    const end = start + length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || length <= 0 || start < 0) fail('视频字节范围不完整。');
    return { start, end, url };
  }
  function parsePlaylist(text, base) {
    const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(s => s.trim());
    if (lines[0] !== '#EXTM3U') fail('返回的不是播放清单，可能是登录页或过期链接。');
    if (lines.some(s => s.startsWith('#EXT-X-SESSION-KEY:'))) fail('暂不支持 SESSION-KEY 类型的播放清单。');
    const variants = [], audio = [], segments = [];
    let nextVariant = null, key = null, map = null, sequence = 0n, pendingRange = null, previous = null, duration = 0;
    for (const line of lines.slice(1)) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) nextVariant = attrs(line.slice(18));
      else if (line.startsWith('#EXT-X-MEDIA:')) audio.push(attrs(line.slice(13)));
      else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const value = line.slice(22);
        if (!/^\d+$/.test(value)) fail('无效的播放序号。');
        sequence = BigInt(value);
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const a = attrs(line.slice(11));
        if (a.METHOD === 'NONE') key = null;
        else {
          if (a.METHOD !== 'AES-128' || (a.KEYFORMAT && a.KEYFORMAT !== 'identity')) fail('此回放使用暂不支持的加密格式（如 DRM / SAMPLE-AES）。');
          if (!a.URI) fail('播放清单缺少密钥地址。');
          key = { url: safeURL(a.URI, base), iv: a.IV || null };
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = attrs(line.slice(11));
        if (!a.URI) fail('缺少视频初始化片段。');
        const url = safeURL(a.URI, base);
        map = { url, range: a.BYTERANGE ? rangeSpec(a.BYTERANGE, null, url) : null, key };
        if (key && !key.iv) fail('加密初始化片段缺少 IV。');
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) pendingRange = line.slice(17);
      else if (line === '#EXT-X-DISCONTINUITY') fail('回放含不连续时间线；本版停止下载，以免生成声画错位的文件。');
      else if (line === '#EXT-X-GAP') fail('回放清单包含缺失片段。');
      else if (line.startsWith('#EXTINF:')) duration += Number.parseFloat(line.slice(8)) || 0;
      else if (line && !line.startsWith('#')) {
        const url = safeURL(line, base);
        if (nextVariant) { variants.push({ ...nextVariant, url }); nextVariant = null; }
        else {
          const range = pendingRange ? rangeSpec(pendingRange, previous, url) : null;
          segments.push({ url, range, key, map, sequence: sequence++ });
          previous = range;
          pendingRange = null;
        }
      }
    }
    if (nextVariant || pendingRange) fail('播放清单不完整。');
    if (variants.length) {
      const usable = variants.filter(v => !audio.some(a => a.TYPE === 'AUDIO' && a['GROUP-ID'] === v.AUDIO && a.URI));
      if (!usable.length) fail('此回放音频与视频分开存储，本版不支持合并，已停止以免下载出无声视频。');
      usable.sort((a, b) => Number(b.BANDWIDTH || 0) - Number(a.BANDWIDTH || 0));
      return { variants: usable };
    }
    if (!lines.includes('#EXT-X-ENDLIST')) fail('这仍是直播或未完成的回放，请等待录制结束后下载。');
    if (!segments.length) fail('回放清单中没有视频片段。');
    const firstMap = JSON.stringify(segments[0].map);
    if (segments.some(s => JSON.stringify(s.map) !== firstMap)) fail('回放中途切换了初始化片段，本版不支持合并。');
    return { segments, duration, extension: segments[0].map ? 'mp4' : 'ts' };
  }
  function ivBytes(hex, sequence) {
    let value;
    if (hex) {
      if (!/^0x[0-9a-f]{1,32}$/i.test(hex)) fail('AES-128 IV 格式不正确。');
      value = BigInt(hex);
    } else value = BigInt(sequence);
    if (value < 0n || value >= 1n << 128n) fail('播放序号超出范围。');
    const iv = new Uint8Array(16);
    for (let i = 15; i >= 0; i--) { iv[i] = Number(value & 255n); value >>= 8n; }
    return iv;
  }
  function contentRange(headers) {
    const m = /^content-range:\s*bytes (\d+)-(\d+)\/(\d+)\s*$/mi.exec(headers);
    if (!m) return null;
    const [start, end, total] = m.slice(1).map(Number);
    if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
    return { start, end, total };
  }
  function checkRange(response, requested) {
    const range = contentRange(response.headers);
    if (response.status !== 206 || !range || range.start !== requested.start || range.end !== requested.end || response.bytes.byteLength !== range.end - range.start + 1)
      fail('服务器没有正确返回指定的视频片段，已停止以免文件损坏。');
    return range;
  }
  function extractInfo(data, base) {
    const result = [];
    for (const item of Array.isArray(data?.list) ? data.list : []) {
      try {
        const content = typeof item.sub_content === 'string' ? JSON.parse(item.sub_content) : item.sub_content;
        const value = content?.save_playback?.contents;
        const url = typeof value === 'string' ? mediaURL(value, base) : null;
        if (url) result.push({ url, name: [item.title, item.sub_title, item.lecturer_name].filter(Boolean).join(' - ') });
      } catch (_) { /* An unrelated or malformed item must not break playback. */ }
    }
    return result;
  }
  async function prepare(url, request, signal, depth = 0) {
    if (depth > 5) fail('播放清单嵌套过深。');
    if (/\.m3u8(?:$|\?)/i.test(url)) {
      const r = await request(url, { signal, maxBytes: 2 * MiB });
      const playlist = parsePlaylist(decoder.decode(r.bytes), r.url);
      if (playlist.variants) return prepare(playlist.variants[0].url, request, signal, depth + 1);
      return { kind: 'hls', url: r.url, ...playlist };
    }
    const r = await request(url, { signal, range: { start: 0, end: MiB - 1 }, maxBytes: 16 * MiB });
    requireMedia(r.bytes, 'mp4');
    if (r.status === 200) return { kind: 'direct', url: r.url, extension: 'mp4', total: r.bytes.byteLength, initial: r.bytes };
    const range = contentRange(r.headers);
    if (!range || range.start !== 0 || range.end !== Math.min(MiB - 1, range.total - 1) || r.bytes.byteLength !== range.end + 1)
      fail('服务器返回的 MP4 范围信息不完整。');
    return { kind: 'direct', url: r.url, extension: 'mp4', total: range.total, initial: r.bytes };
  }
  async function download(plan, request, sink, signal, progress, cryptoAPI) {
    let written = 0;
    const keys = new Map();
    const check = () => { if (signal.aborted) throw new DOMException('已取消', 'AbortError'); };
    const write = async data => { check(); await sink.write(data); written += data.byteLength; };
    async function part(item) {
      check();
      const r = await request(item.url, { signal, range: item.range, maxBytes: 64 * MiB });
      if (item.range) checkRange(r, item.range);
      if (classify(r.bytes) === 'error') fail('视频片段返回了网页或错误信息，请重新打开回放获取新链接。');
      let bytes = r.bytes;
      if (item.key) {
        if (!keys.has(item.key.url)) {
          const keyResponse = await request(item.key.url, { signal, maxBytes: 1024 });
          if (keyResponse.bytes.byteLength !== 16) fail('服务器未返回有效的 AES-128 视频密钥。');
          keys.set(item.key.url, await cryptoAPI.subtle.importKey('raw', keyResponse.bytes, 'AES-CBC', false, ['decrypt']));
        }
        try {
          bytes = new Uint8Array(await cryptoAPI.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes(item.key.iv, item.sequence || 0n) }, keys.get(item.key.url), bytes));
        } catch (_) { fail('视频片段解密失败，请重新打开回放。'); }
      }
      requireMedia(bytes, plan.extension === 'ts' ? 'ts' : 'mp4');
      return bytes;
    }
    if (plan.kind === 'direct') {
      await write(plan.initial);
      progress(written / plan.total, written);
      while (written < plan.total) {
        check();
        const range = { start: written, end: Math.min(written + 8 * MiB - 1, plan.total - 1) };
        const r = await request(plan.url, { signal, range, maxBytes: 9 * MiB });
        if (classify(r.bytes) === 'error') fail('下载地址已失效，服务器返回了网页。');
        if (checkRange(r, range).total !== plan.total) fail('视频总长度在下载中发生变化，已停止。');
        await write(r.bytes);
        progress(written / plan.total, written);
      }
    } else {
      if (plan.segments[0].map) await write(await part(plan.segments[0].map));
      for (let i = 0; i < plan.segments.length; i++) {
        await write(await part(plan.segments[i]));
        progress((i + 1) / plan.segments.length, written);
      }
    }
    check();
    return written;
  }

  // Pure functions and downloader are testable without a browser or account.
  if (typeof module === 'object' && module.exports) {
    module.exports = { safeURL, mediaURL, filename, chooseSaveFile, classify, responseInfo, attrs, parsePlaylist, ivBytes, contentRange, checkRange, extractInfo, prepare, download, requestOnce };
    return;
  }
  if (location.hostname !== 'onlineroomse.pku.edu.cn' || location.pathname !== '/player') return;
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const sources = new Map();
  let ui, plan = null, controller = null, busy = false, lastError = '', capturedTitle = '';
  let stage = 'waiting', failedStage = '', mediaProbePassed = false, lastResponseInfo = null;
  const status = message => { if (ui) ui.status.textContent = message; };
  function addSource(raw, name = '', origin = '播放器') {
    const url = mediaURL(raw, location.href);
    if (!url) return;
    const old = sources.get(url);
    if (name) capturedTitle = name;
    if (old && (!name || old.name === name)) return;
    sources.set(url, { url, name: name || old?.name || '', origin });
    renderSources();
  }
  function capture(data) {
    for (const item of extractInfo(data, location.href)) addSource(item.url, item.name, '回放信息');
  }
  function isInfoURL(raw) {
    try { const u = new URL(raw, location.href); return u.origin === location.origin && u.pathname.includes('get-sub-info-by-auth-data'); }
    catch (_) { return false; }
  }
  // Observe only the playback-info response. Do not read request headers,
  // credentials, unrelated response bodies, or change requests/responses.
  try {
    const originalOpen = page.XMLHttpRequest.prototype.open;
    page.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (isInfoURL(url)) this.addEventListener('load', function () {
        try { capture(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch (_) { /* Ignore. */ }
      }, { once: true });
      return originalOpen.call(this, method, url, ...rest);
    };
    const originalFetch = page.fetch;
    page.fetch = function (...args) {
      const result = originalFetch.apply(this, args);
      if (isInfoURL(typeof args[0] === 'string' ? args[0] : args[0]?.url)) {
        result.then(r => r.clone().json()).then(capture).catch(() => {});
      }
      return result;
    };
  } catch (_) { /* Performance and DOM discovery remain available. */ }
  function scan() {
    for (const e of performance.getEntriesByType('resource')) addSource(e.name, '', '实际加载地址');
    for (const e of document.querySelectorAll('video, video source')) addSource(e.currentSrc || e.src, '', '视频元素');
  }
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) addSource(e.name, '', '实际加载地址'); }).observe({ type: 'resource', buffered: true });
  } catch (_) { /* Manual scan remains available. */ }

  function requestOnce(url, options, requestWindow) {
    const { signal, range, maxBytes = 64 * MiB } = options;
    safeURL(url);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('已取消', 'AbortError'));
      let handle, done = false;
      const finish = (fn, value) => { if (!done) { done = true; signal?.removeEventListener('abort', abort); fn(value); } };
      const abort = () => { if (done) return; finish(reject, new DOMException('已取消', 'AbortError')); handle?.abort(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        // Match the real cmcPlayer HLS transport: page XHR + credentials.
        // Browser supplies cookies, Origin and Referer in the same context as
        // normal playback; never copy credentials into extension requests.
        handle = new requestWindow.XMLHttpRequest();
        handle.open('GET', url, true);
        handle.responseType = 'arraybuffer';
        handle.withCredentials = true;
        handle.timeout = 60000;
        if (range) handle.setRequestHeader('Range', `bytes=${range.start}-${range.end}`);
        handle.onprogress = e => {
            if (e.loaded > maxBytes || (e.lengthComputable && e.total > maxBytes)) {
              finish(reject, new Error('单次响应过大（可能不支持分段读取）。已停止，避免耗尽内存。'));
              handle?.abort();
            }
        };
        handle.onload = () => {
            const r = handle;
            const bytes = new Uint8Array(r.response || new ArrayBuffer(0));
            const info = responseInfo(url, r.status, r.getResponseHeader('Content-Type') || '', bytes);
            try {
              if (r.status === 401 || r.status === 403) fail(`媒体服务器拒绝访问（${r.status}）。请重新登录、重新打开回放并播放几秒后重试。`);
              if (r.status !== 200 && r.status !== 206) {
                const error = new Error(`媒体请求失败（HTTP ${r.status}）。`);
                error.retryable = r.status === 429 || r.status >= 500;
                throw error;
              }
              const finalURL = safeURL(r.responseURL || url);
              const headers = r.getAllResponseHeaders();
              if (bytes.byteLength > maxBytes) fail('媒体响应超过单次大小限制。');
              if (!bytes.byteLength) fail('服务器返回了空文件。');
              if (info.bodyKind === 'error')
                fail('已检查响应正文，确认是 HTML/JSON 错误页，已停止保存。可复制脱敏诊断查看错误类别。');
              // Some media servers mislabel binary fragments as text/html.
              // download() still validates TS/MP4 bytes (after AES decryption).
              finish(resolve, { status: r.status, bytes, headers, url: finalURL, responseInfo: info });
            } catch (e) {
              e.responseInfo = info;
              finish(reject, e);
            }
        };
        handle.onerror = () => finish(reject, Object.assign(new Error('页面媒体请求失败。请确认这节回放能正常播放；网络或 CORS 拒绝也会导致此错误。'), { retryable: true }));
        handle.ontimeout = () => finish(reject, Object.assign(new Error('媒体请求超时。'), { retryable: true }));
        handle.onabort = abort;
        handle.send();
      } catch (_) { finish(reject, new Error('无法创建播放器页面内的下载请求。')); }
    });
  }
  async function request(url, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await requestOnce(url, options, page);
        lastResponseInfo = result.responseInfo;
        return result;
      }
      catch (e) {
        if (!e.retryable || attempt >= 2 || options.signal?.aborted) throw e;
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
  }
  function renderSources() {
    if (!ui || busy) return;
    const selected = ui.select.value;
    ui.select.replaceChildren();
    let i = 0;
    for (const item of sources.values()) {
      const option = document.createElement('option');
      option.value = item.url;
      option.textContent = `${++i}. ${/\.m3u8(?:$|\?)/i.test(item.url) ? '分段回放' : 'MP4'} · ${item.name || item.origin}`;
      ui.select.appendChild(option);
    }
    if (sources.has(selected)) ui.select.value = selected;
    if (!busy && !plan) status(sources.size ? '已找到媒体地址。点击“解析回放”，再保存。' : '等待回放加载。请播放几秒，再点“重新检测”。');
    ui.prepare.disabled = busy || !sources.size;
  }
  function setBusy(value) {
    busy = value;
    ui.select.disabled = value;
    ui.scan.disabled = value;
    ui.prepare.disabled = value || !sources.size;
    ui.save.disabled = value || !plan;
    ui.cancel.disabled = !value;
  }
  function showError(e) {
    if (e.name === 'AbortError') status('已取消；未完成的写入已中止。');
    else {
      failedStage = stage;
      lastError = e.message;
      lastResponseInfo = e.responseInfo || lastResponseInfo;
      const labels = { playlist: '解析清单', probe: '读取视频片段', picker: '选择保存位置', writing: '写入本地文件', download: '下载媒体', closing: '完成保存' };
      status(`失败阶段：${labels[stage] || stage}\n${e.message}`);
    }
  }
  async function resolveSource() {
    controller = new AbortController();
    plan = null;
    mediaProbePassed = false;
    lastError = ''; failedStage = ''; lastResponseInfo = null; stage = 'playlist';
    setBusy(true);
    status('正在检查真实媒体内容…');
    try {
      const chosen = ui.select.value;
      const candidate = await prepare(chosen, request, controller.signal);
      stage = 'probe';
      status('清单已解析，正在试读首个视频片段，确认媒体访问权限…');
      if (candidate.kind === 'hls') {
        await download({ ...candidate, segments: candidate.segments.slice(0, 1) }, request,
          { async write() {} }, controller.signal, () => {}, crypto);
      }
      mediaProbePassed = true;
      plan = candidate;
      const entry = sources.get(chosen);
      plan.name = filename(entry?.name || capturedTitle || document.querySelector('.course-info__header')?.textContent || document.title);
      const detail = plan.kind === 'hls' ? `${plan.segments.length} 个片段，约 ${Math.round(plan.duration / 60)} 分钟` : `${(plan.total / MiB).toFixed(1)} MB`;
      stage = 'ready';
      status(`清单与首段视频读取成功：${detail}。将保存为 .${plan.extension}。${plan.extension === 'ts' ? 'TS 是原始视频格式，可用 VLC 播放。' : ''}`);
    } catch (e) { showError(e); }
    finally { setBusy(false); }
  }
  async function saveVideo() {
    if (!plan || busy) return;
    const currentPlan = plan;
    if (typeof page.showSaveFilePicker !== 'function' || window.top !== window.self) {
      status('请在 Chrome 中将回放播放器单独打开为标签页后重试；大视频需要浏览器的“另存为”写入功能。');
      return;
    }
    controller = new AbortController();
    lastError = ''; failedStage = ''; lastResponseInfo = null; stage = 'picker';
    setBusy(true);
    let sink;
    try {
      // Must be invoked directly during this click, before network awaits.
      const handle = await chooseSaveFile(page, `${currentPlan.name}.${currentPlan.extension}`);
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
      stage = 'writing';
      sink = await handle.createWritable();
      stage = 'download';
      const bytes = await download(currentPlan, request, sink, controller.signal,
        (fraction, size) => status(`下载中 ${(fraction * 100).toFixed(1)}% · ${(size / MiB).toFixed(1)} MB。请保持此页打开。`), crypto);
      stage = 'closing';
      await sink.close();
      sink = null;
      stage = 'complete';
      status(`保存完成：${currentPlan.name}.${currentPlan.extension}（${(bytes / MiB).toFixed(1)} MB）`);
    } catch (e) {
      if (sink) try { await sink.abort(); } catch (_) { /* Browser may already have aborted. */ }
      showError(e);
    } finally { setBusy(false); }
  }
  function mount() {
    if (!document.body) return;
    const host = document.createElement('div');
    host.id = 'pku-video-helper';
    host.style.cssText = 'position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483647!important;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial} *{box-sizing:border-box} section{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;width:355px;max-width:calc(100vw - 40px);color:#20212a;background:#fff;border:1px solid #ddd;border-radius:14px;box-shadow:0 8px 35px #0003;padding:16px}
      header{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:16px} small{display:block;color:#686875;margin:7px 0 12px;font-size:12px} select{width:100%;padding:7px;border:1px solid #ddd;border-radius:7px;background:#fafafa;color:#222} .buttons{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0} button{font:inherit;font-size:13px;cursor:pointer;border:1px solid #d8d8dd;background:#fafafa;color:#222;border-radius:7px;padding:6px 10px} button.primary{background:#8d1833;border-color:#8d1833;color:#fff} button:disabled{opacity:.45;cursor:default} p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;font-size:13px} #collapse{padding:0 8px} a{color:#8d1833}
    </style><section><header>课程回放下载补丁 <button id="collapse" aria-label="收起或展开">−</button></header><div id="body"><small>兼容 PKU Art · 仅下载当前回放 · v1.0.3</small><select aria-label="选择媒体源" id="sources"></select><div class="buttons"><button id="scan">重新检测</button><button id="prepare">解析回放</button><button id="save" class="primary" disabled>保存视频</button><button id="cancel" disabled>取消</button></div><p id="status" role="status" aria-live="polite">等待回放加载…</p><small>下载进度显示在这里。不要关闭或刷新页面。</small><button id="diagnostic">复制脱敏诊断</button><p id="open"></p></div></section>`;
    document.body.appendChild(host);
    ui = Object.fromEntries(['prepare', 'save', 'cancel', 'scan', 'status'].map(id => [id, root.getElementById(id)]));
    ui.select = root.getElementById('sources');
    ui.prepare.addEventListener('click', resolveSource);
    ui.save.addEventListener('click', saveVideo);
    ui.scan.addEventListener('click', () => { scan(); renderSources(); });
    ui.cancel.addEventListener('click', () => controller?.abort());
    ui.select.addEventListener('change', () => { plan = null; ui.save.disabled = true; status('已切换媒体源，请重新解析。'); });
    root.getElementById('collapse').addEventListener('click', () => {
      const body = root.getElementById('body'); body.hidden = !body.hidden;
      root.getElementById('collapse').textContent = body.hidden ? '+' : '−';
    });
    root.getElementById('diagnostic').addEventListener('click', async () => {
      const report = JSON.stringify({ version: '1.0.3', page: location.origin + location.pathname, sourceCount: sources.size,
        sources: [...sources.values()].map(x => ({ host: new URL(x.url).hostname, type: /\.m3u8(?:$|\?)/i.test(x.url) ? 'hls' : 'mp4' })),
        filePicker: typeof page.showSaveFilePicker, topLevel: window.top === window.self,
        transport: 'page-xhr-with-credentials', stage, failedStage, mediaProbePassed, lastResponseInfo, lastError }, null, 2);
      try { await navigator.clipboard.writeText(report); status('已复制诊断信息，不含完整媒体链接、令牌、账号或课程名称。'); }
      catch (_) { status(report); }
    });
    if (window.top !== window.self) {
      const a = document.createElement('a'); a.href = location.href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '点击将播放器单独打开，再下载'; root.getElementById('open').appendChild(a);
    }
    scan(); renderSources();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
})();
