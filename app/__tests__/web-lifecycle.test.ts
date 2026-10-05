/** Run the production handsfree functions with browser hardware boundaries injected. */
const source: string = require('fs').readFileSync(
  require('path').resolve(__dirname, '../../web/static/app.js'),
  'utf8',
);
const handsfree = source.slice(
  source.indexOf('async function hfStart()'),
  source.indexOf('/* ---- 마이크 프레임'),
);
const microphone = source.slice(
  source.indexOf('async function micStream()'),
  source.indexOf('/** MediaRecorder 가'),
);

function setup() {
  let grant!: (value: unknown) => void;
  const pending = new Promise(resolve => {
    grant = resolve;
  });
  const track = { stop: jest.fn() };
  const mic = { active: true, getTracks: () => [track] };
  const hf = {
    generation: 0,
    running: false,
    ready: false,
    ws: null,
    ctx: null,
    node: null,
    source: null,
    sink: null,
    turns: new Map(),
  };
  const state = {
    stream: null,
    config: {
      audio: { stt_sample_rate: 16000 },
      stream: { client_frame_ms: 20, path: '/v1/stream' },
    },
  };
  const sockets: {
    close: jest.Mock;
    listeners: Record<string, (event?: unknown) => void>;
  }[] = [];
  class Socket {
    listeners: Record<string, (event?: unknown) => void> = {};
    close = jest.fn();
    constructor() {
      sockets.push(this);
    }
    addEventListener(name: string, fn: (event?: unknown) => void) {
      this.listeners[name] = fn;
    }
  }
  const node = () => ({ connect: jest.fn(), disconnect: jest.fn() });
  const context = {
    state: 'running',
    destination: {},
    close: jest.fn(),
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: node,
    createGain: () => ({ ...node(), gain: { value: 0 } }),
  };
  const dependencies = {
    hf,
    state,
    navigator: { mediaDevices: { getUserMedia: () => pending } },
    hfButton: () => {},
    hfState: () => {},
    setStatus: () => {},
    t: (s: string) => s,
    audioContextAt: () => context,
    AudioWorkletNode: class {
      port = { postMessage: () => {}, onmessage: null };
      disconnect() {}
      connect() {}
    },
    CAPTURE_WORKLET_URL: 'worklet',
    CAPTURE_PROCESSOR: 'capture',
    WebSocket: Socket,
    streamUrl: (s: string) => s,
    hfSend: () => {},
    hfConfigMessage: () => ({}),
    hfFrame: () => {},
    hfEvent: () => {},
    hfAudio: () => {},
    hfStopPlayback: () => {},
    releaseMicIfIdle: () => {
      if (!hf.running && state.stream) track.stop();
    },
    $: () => null,
  };
  const vm = require('vm');
  const functions = vm.runInNewContext(
    microphone + handsfree + '; ({ start: hfStart, stop: hfStop })',
    dependencies,
  );
  return { ...functions, grant: () => grant(mic), track, sockets, context };
}

test('웹 마이크 권한 대기 중 화면 이탈은 늦게 받은 마이크를 놓고 소켓을 만들지 않는다', async () => {
  const screen = setup();
  const opening = screen.start();
  screen.stop();
  screen.grant();
  await opening;
  expect(screen.sockets).toHaveLength(0);
  expect(screen.track.stop).toHaveBeenCalledTimes(1);
});

test('웹 이전 소켓의 지연된 종료는 새 연결을 닫지 않는다', async () => {
  const screen = setup();
  const opening = screen.start();
  screen.grant();
  await opening;
  screen.stop();
  await screen.start();
  screen.sockets[0].listeners.close();
  expect(screen.sockets[1].close).not.toHaveBeenCalled();
  screen.stop();
});
