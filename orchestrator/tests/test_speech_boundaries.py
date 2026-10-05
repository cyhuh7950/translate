"""Synthetic PCM regressions; these do not measure devices or engine accuracy."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

import numpy as np
from starlette.websockets import WebSocketState
from app.core.config import Config
from app.core.adapters.vad.energy import EnergyVad
from app.core.adapters.turn.policies import HalfDuplex
from app.modules.translate.streaming import StreamHandler

ROOT = Path(__file__).resolve().parents[2]
RATE = 16000

def tone(ms, rms=0.02):
    t = np.arange(RATE * ms // 1000) / RATE
    return np.round(np.sin(2 * np.pi * 220 * t) * rms * np.sqrt(2) * 32768).astype(np.int16)

def silence(ms=1000):
    return np.zeros(RATE * ms // 1000, dtype=np.int16)

class Socket:
    headers = {}
    client_state = WebSocketState.CONNECTED
    def __init__(self):
        self.events = []
        self.audio = []
    async def send_json(self, event):
        self.events.append(event)
    async def send_bytes(self, data):
        self.audio.append(data)

class VadTests(unittest.TestCase):
    def setUp(self):
        self.cfg = Config(str(ROOT / 'config'))
    def test_quiet_first_utterance_without_noise_warmup(self):
        vad = EnergyVad(self.cfg.get('vad'), RATE)
        events = vad.push(tone(1000)) + vad.push(silence())
        ends = [e for e in events if e.state == 'speech_end' and not e.dropped]
        self.assertEqual(len(ends), 1)
        self.assertEqual(ends[0].speech_ms, 1000)
    def test_short_quiet_response_is_kept(self):
        vad = EnergyVad(self.cfg.get('vad'), RATE)
        events = vad.push(tone(160)) + vad.push(silence())
        ends = [e for e in events if e.state == 'speech_end' and not e.dropped]
        self.assertEqual(len(ends), 1)
        self.assertEqual(ends[0].speech_ms, 160)
    def test_short_loud_response_is_kept(self):
        vad = EnergyVad(self.cfg.get('vad'), RATE)
        events = vad.push(tone(160, .08)) + vad.push(silence())
        self.assertTrue(any(e.state == 'speech_end' and not e.dropped for e in events))
    def test_low_background_noise_does_not_become_speech(self):
        vad = EnergyVad(self.cfg.get('vad'), RATE)
        self.assertEqual(vad.push(tone(2000, 0.004)) + vad.flush(), [])

class OutputBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        cfg = Config(str(ROOT / 'config'))
        self.ws = Socket()
        self.handler = StreamHandler(self.ws, SimpleNamespace(config=cfg), None)
        self.handler._vad = EnergyVad(cfg.get('vad'), RATE)
        self.handler._turn = HalfDuplex(cfg.get('turn'))
        self.handler._sample_rate = RATE
        self.handler._channels = 1
        self.handler._route = lambda: {}
    async def output(self):
        await self.handler._on_stage('tts.final', {
            'audio': b'previous-tts', 'duration': 1., 'seg': 1, 'from': 'a', 'to': 'b',
        })
    async def test_tts_waits_for_next_utterance_and_blocks_output_echo(self):
        h = self.handler
        await h._on_audio(tone(300, .08).tobytes())
        output = asyncio.create_task(self.output())
        try:
            await asyncio.sleep(0)
            self.assertEqual(self.ws.audio, [])
            await h._on_audio(tone(800, .08).tobytes())
            await h._on_audio(silence(600).tobytes())
            await asyncio.wait_for(output, .2)
            self.assertEqual(h._queue.get_nowait().speech_ms, 1100)
            self.assertEqual(self.ws.audio, [b'previous-tts'])
            await h._on_audio(tone(1000, .08).tobytes())
            await h._on_audio(silence().tobytes())
            self.assertTrue(h._queue.empty(), 'output echo must not enter STT')
            await h._on_text(json.dumps({'type': 'control', 'action': 'playback', 'state': 'end'}))
            await h._on_audio(tone(320).tobytes())
            await h._on_audio(silence().tobytes())
            self.assertEqual(h._queue.get_nowait().speech_ms, 320)
        finally:
            output.cancel()
            await asyncio.gather(output, return_exceptions=True)
    async def test_tts_does_not_cut_off_speech_before_start_confirmation(self):
        h = self.handler
        await h._on_audio(tone(40, .08).tobytes())
        output = asyncio.create_task(self.output())
        try:
            await asyncio.sleep(0)
            self.assertEqual(self.ws.audio, [])
            await h._on_audio(tone(280, .08).tobytes())
            await h._on_text('{"type":"control","action":"flush"}')
            await asyncio.wait_for(output, .2)
            self.assertEqual(h._queue.get_nowait().speech_ms, 320)
        finally:
            output.cancel()
            await asyncio.gather(output, return_exceptions=True)
    async def test_too_short_speech_reports_drop_to_client(self):
        h = self.handler
        await h._on_audio(tone(80, .08).tobytes())
        await h._on_audio(silence().tobytes())
        self.assertTrue(h._queue.empty())
        self.assertTrue(any(e['type'] == 'vad' and e.get('dropped') for e in self.ws.events))

    async def test_cancel_discards_pending_input_and_waiting_output_with_notice(self):
        h = self.handler
        await h._on_audio(tone(300, .08).tobytes())
        output = asyncio.create_task(self.output())
        h._current = output
        await asyncio.sleep(0)
        await h._cancel()
        await asyncio.gather(output, return_exceptions=True)
        self.assertEqual(self.ws.audio, [])
        self.assertTrue(h._queue.empty())
        self.assertTrue(any(e['type'] == 'cancelled' for e in self.ws.events))
    async def test_output_without_duration_still_blocks_echo_until_playback_end(self):
        h = self.handler
        await h._on_stage('tts.final', {'audio': b'unknown-duration', 'duration': None})
        await h._on_audio(tone(1000, .08).tobytes())
        await h._on_audio(silence().tobytes())
        self.assertTrue(h._queue.empty())

if __name__ == '__main__':
    unittest.main()
