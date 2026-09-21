const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const h = require('../PKU-Video-Helper.user.js');
const base = 'https://resourcese.pku.edu.cn/play/a/playlist.m3u8?token=local-fixture';
const enc = new TextEncoder();
const signal = () => new AbortController().signal;
const ts = () => { const b = new Uint8Array(564); b[0] = b[188] = b[376] = 0x47; return b; };
const mp4 = (n = 32, type = 'ftyp') => { const b = new Uint8Array(n); b.set(enc.encode(type), 4); return b; };
const response = (bytes, url = base) => ({ status: 200, bytes, url, headers: '' });
const playlist = extra => '#EXTM3U\n#EXT-X-TARGETDURATION:10\n' + extra + '\n#EXT-X-ENDLIST';
const sink = () => ({ parts: [], async write(b) { this.parts.push(Buffer.from(b)); } });

test('file picker is called on the real page Window, not a userscript proxy', async () => {
  const handle = { name: 'test.ts' };
  const realWindow = { showSaveFilePicker(options) {
    if (this !== realWindow) throw new TypeError('Illegal invocation');
    assert.deepEqual(options, { suggestedName: 'test.ts' });
    return Promise.resolve(handle);
  } };
  const sandboxProxy = { showSaveFilePicker: realWindow.showSaveFilePicker };
  assert.throws(() => sandboxProxy.showSaveFilePicker({ suggestedName: 'test.ts' }), /Illegal invocation/);
  assert.equal(await h.chooseSaveFile(realWindow, 'test.ts'), handle);
});

test('rejects HTML error pages, including actual reported PKU permission error', () => {
  const b = enc.encode('<!DOCTYPE html><html><body><h3>您无权限访问当前课程中的课堂实录资源 .</h3></body></html>');
  assert.equal(h.classify(b), 'error');
  assert.throws(() => h.parsePlaylist(new TextDecoder().decode(b), base), /不是播放清单/);
});
test('media URLs retain signed query and allow only exact permitted HTTPS hosts', () => {
  assert.equal(h.safeURL('part.ts?sign=abc%2F123', base), 'https://resourcese.pku.edu.cn/play/a/part.ts?sign=abc%2F123');
  for (const url of ['https://resourcese.pku.edu.cn.evil.example/a', 'http://resourcese.pku.edu.cn/a', 'https://a:b@resourcese.pku.edu.cn/a', 'https://course.pku.edu.cn/webapps/assignment', 'https://resourcese.pku.edu.cn:9999/a'])
    assert.throws(() => h.safeURL(url), /不在/);
});
test('extracts real playback URL without converting it to old download endpoint', () => {
  const data = { list: [{ title: '示例课程', sub_title: '测试', lecturer_name: '教师', sub_content: JSON.stringify({ save_playback: { is_m3u8: 'yes', contents: base } }) }] };
  assert.deepEqual(h.extractInfo(data, base), [{ url: base, name: '示例课程 - 测试 - 教师' }]);
  assert.deepEqual(h.extractInfo({ list: [{ sub_content: 'broken' }] }, base), []);
});
test('parses relative HLS URLs and 64-bit media sequence without precision loss', () => {
  const p = h.parsePlaylist(playlist('#EXT-X-MEDIA-SEQUENCE:9007199254740993\n#EXTINF:4.5,\n0.ts?sig=a\n#EXTINF:5.5,\n/part/1.ts'), base);
  assert.equal(p.segments[0].sequence, 9007199254740993n);
  assert.equal(p.segments[1].sequence, 9007199254740994n);
  assert.equal(p.duration, 10);
  assert.equal(p.extension, 'ts');
  assert.equal(p.segments[1].url, 'https://resourcese.pku.edu.cn/part/1.ts');
});
test('master playlist picks highest available bandwidth and rejects missing external audio', () => {
  const p = h.parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="a,b"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200\nhigh.m3u8', base);
  assert.ok(p.variants[0].url.endsWith('high.m3u8'));
  assert.throws(() => h.parsePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200,AUDIO="a"\nvideo.m3u8', base), /音频与视频/);
});
test('fMP4 byte ranges, implicit range offsets, and initialization map', () => {
  const p = h.parsePlaylist(playlist('#EXT-X-MAP:URI="all.mp4",BYTERANGE="32@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:100@32\nall.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:100\nall.mp4'), base);
  assert.equal(p.extension, 'mp4');
  assert.equal(p.segments[1].range.start, 132);
  assert.equal(p.segments[0].map.range.end, 31);
  assert.throws(() => h.parsePlaylist(playlist('#EXT-X-BYTERANGE:10\na.ts'), base), /范围不完整/);
});
test('unsupported streams fail explicitly instead of producing damaged or silent files', () => {
  for (const [input, message] of [
    ['#EXTM3U\n#EXTINF:1,\na.ts', /直播/],
    [playlist('#EXT-X-DISCONTINUITY\na.ts'), /不连续/],
    [playlist('#EXT-X-GAP\na.ts'), /缺失/],
    [playlist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\na.ts'), /加密/],
    [playlist('#EXT-X-MAP:URI="a.mp4"\nx.m4s\n#EXT-X-MAP:URI="b.mp4"\ny.m4s'), /初始化/],
  ]) assert.throws(() => h.parsePlaylist(input, base), message);
});
test('AES-128 IV uses big endian full sequence and supports explicit IV', () => {
  assert.equal(Buffer.from(h.ivBytes(null, 258n)).toString('hex'), '00000000000000000000000000000102');
  assert.equal(Buffer.from(h.ivBytes('0xff', 0n)).toString('hex'), '000000000000000000000000000000ff');
  assert.throws(() => h.ivBytes('oops', 0n), /IV/);
});
test('prepares nested master playlist using final redirected base URL', async () => {
  const seen = [];
  const request = async url => {
    seen.push(url);
    return seen.length === 1
      ? response(enc.encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8'), 'https://resourcese.pku.edu.cn/new/master.m3u8')
      : response(enc.encode(playlist('#EXTINF:2,\na.ts')), url);
  };
  const p = await h.prepare(base, request, signal());
  assert.equal(seen[1], 'https://resourcese.pku.edu.cn/new/child.m3u8');
  assert.equal(p.segments[0].url, 'https://resourcese.pku.edu.cn/new/a.ts');
});
test('complete TS download writes all segments in order and reports full completion', async () => {
  const plan = { kind: 'hls', ...h.parsePlaylist(playlist('#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts'), base) };
  const out = sink(), progress = [];
  const bytes = await h.download(plan, async url => response(ts(), url), out, signal(), (p, n) => progress.push([p, n]), webcrypto);
  assert.equal(bytes, 1128);
  assert.equal(out.parts.length, 2);
  assert.deepEqual(progress.at(-1), [1, 1128]);
});
test('AES encrypted segment downloads decrypt with authorized playlist key', async () => {
  const raw = new Uint8Array(16).fill(13);
  const key = await webcrypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['encrypt']);
  const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: h.ivBytes(null, 5n) }, key, ts()));
  const plan = { kind: 'hls', ...h.parsePlaylist(playlist('#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\na.ts'), base) };
  const out = sink();
  await h.download(plan, async url => response(url.endsWith('/key') ? raw : encrypted, url), out, signal(), () => {}, webcrypto);
  assert.deepEqual(out.parts[0], Buffer.from(ts()));
});
test('fMP4 output includes init exactly once and both media fragments', async () => {
  const plan = { kind: 'hls', ...h.parsePlaylist(playlist('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXTINF:1,\nb.m4s'), base) };
  const out = sink();
  await h.download(plan, async url => response(mp4(32, url.endsWith('init.mp4') ? 'ftyp' : 'moof'), url), out, signal(), () => {}, webcrypto);
  assert.equal(out.parts.length, 3);
  assert.equal(out.parts[0].subarray(4, 8).toString(), 'ftyp');
});
test('HTML returned midway aborts without appending HTML to video', async () => {
  const plan = { kind: 'hls', ...h.parsePlaylist(playlist('#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts'), base) };
  const out = sink();
  await assert.rejects(h.download(plan, async url => response(url.endsWith('a.ts') ? ts() : enc.encode('<html>login</html>'), url), out, signal(), () => {}, webcrypto), /网页/);
  assert.equal(out.parts.length, 1);
});
test('direct MP4 ranges reconstruct the exact original bytes', async () => {
  const original = mp4(2 * 1024 * 1024 + 3);
  original[original.length - 1] = 42;
  const url = 'https://resourcese.pku.edu.cn/a.mp4';
  const request = async (u, { range }) => {
    const end = Math.min(range.end, original.length - 1);
    return { status: 206, url: u, bytes: original.slice(range.start, end + 1), headers: `Content-Range: bytes ${range.start}-${end}/${original.length}` };
  };
  const plan = await h.prepare(url, request, signal());
  const out = sink();
  await h.download(plan, request, out, signal(), () => {}, webcrypto);
  assert.deepEqual(Buffer.concat(out.parts), Buffer.from(original));
});
test('incorrect byte range cannot silently duplicate full resource', () => {
  assert.throws(() => h.checkRange(response(mp4()), { start: 1, end: 10 }), /指定的视频片段/);
});
test('cancelled download writes nothing', async () => {
  const controller = new AbortController(); controller.abort();
  const out = sink();
  await assert.rejects(h.download({ kind: 'direct', initial: mp4(), total: 32 }, () => {}, out, controller.signal, () => {}, webcrypto), { name: 'AbortError' });
  assert.equal(out.parts.length, 0);
});
test('filename removes Windows forbidden characters and device names', () => {
  assert.equal(h.filename('课程:1/2?'), '课程_1_2_');
  assert.equal(h.filename('CON'), '_CON');
});
test('page XHR uses playback credentials, rejects error pages and cancels once', async () => {
  let instance, respond = true, aborted = 0;
  class FakeXHR {
    constructor() { instance = this; this.headers = {}; }
    open(method, url, asyncFlag) { this.method = method; this.responseURL = url; this.asyncFlag = asyncFlag; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    getAllResponseHeaders() { return 'Content-Type: text/html'; }
    getResponseHeader() { return 'text/html'; }
    send() {
      if (!respond) return;
      this.status = 200; this.response = enc.encode('<html>error</html>').buffer;
      queueMicrotask(() => this.onload());
    }
    abort() { aborted++; this.onabort(); }
  }
  const pageWindow = { XMLHttpRequest: FakeXHR };
  await assert.rejects(h.requestOnce('https://resourcese.pku.edu.cn/a.mp4', { signal: signal() }, pageWindow), /错误页/);
  assert.equal(instance.method, 'GET');
  assert.equal(instance.withCredentials, true);
  assert.equal(instance.asyncFlag, true);
  assert.equal(instance.headers.Cookie, undefined);
  assert.equal(instance.headers.Authorization, undefined);
  assert.equal(instance.headers.Referer, undefined);
  respond = false;
  const controller = new AbortController();
  const promise = h.requestOnce(base, { signal: controller.signal }, pageWindow); controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(aborted, 1);
});

function mockedPage(bytes, contentType) {
  return { XMLHttpRequest: class {
    open(method, url) { this.responseURL = url; }
    getAllResponseHeaders() { return `Content-Type: ${contentType}`; }
    getResponseHeader() { return contentType; }
    send() { this.status = 200; this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); queueMicrotask(() => this.onload()); }
  } };
}

test('mislabeled HTML MIME does not prevent valid HLS and TS download', async () => {
  const manifest = enc.encode(playlist('#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts'));
  const request = (url, options) => h.requestOnce(url, options, mockedPage(url.includes('.m3u8') ? manifest : ts(), 'text/html; charset=utf-8'));
  const plan = await h.prepare(base, request, signal());
  const out = sink();
  await h.download(plan, request, out, signal(), () => {}, webcrypto);
  assert.deepEqual(Buffer.concat(out.parts), Buffer.concat([Buffer.from(ts()), Buffer.from(ts())]));
  const r = await request(plan.segments[0].url, { signal: signal() });
  assert.equal(r.responseInfo.bodyKind, 'ts');
  assert.equal(r.responseInfo.byteLength, 564);
});

test('real HTML or JSON errors are rejected regardless of Content-Type without exposing body or URL secrets', async () => {
  for (const body of ['<html>无权限 secret-ticket</html>', '{"error":"access denied", "token":"secret-ticket"}']) {
    for (const mime of ['text/html', 'video/mp2t', 'application/octet-stream']) {
      await assert.rejects(h.requestOnce(base, { signal: signal() }, mockedPage(enc.encode(body), mime)), error => {
        assert.equal(error.responseInfo.bodyKind, 'error');
        assert.deepEqual(error.responseInfo.errorHints, ['permission']);
        assert.doesNotMatch(JSON.stringify(error.responseInfo), /secret-ticket|local-fixture|token=/);
        return true;
      });
    }
  }
});

test('random binary beginning with a JSON-like byte is not mistaken for JSON', async () => {
  for (const first of [0x5b, 0x7b]) {
    const key = new Uint8Array(16).fill(0xff); key[0] = first;
    assert.equal(h.classify(key), 'unknown');
    const r = await h.requestOnce(base, { signal: signal() }, mockedPage(key, 'text/html'));
    assert.deepEqual(r.bytes, key);
  }
});

test('unknown binary with HTML MIME still cannot be saved as a TS video', async () => {
  const plan = { kind: 'hls', ...h.parsePlaylist(playlist('#EXTINF:1,\na.ts'), base) };
  const out = sink();
  const request = (url, options) => h.requestOnce(url, options, mockedPage(new Uint8Array(564), 'text/html'));
  await assert.rejects(h.download(plan, request, out, signal(), () => {}, webcrypto), /不是预期的视频格式/);
  assert.equal(out.parts.length, 0);
});
