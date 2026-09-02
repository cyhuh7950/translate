import { TtsPlayer } from '../audio/playback';
import { encodeWav } from '../audio/pcm';

describe('TtsPlayer 재생 상태', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('네이티브 onEnded가 오지 않아도 오디오 길이 후 재생 상태를 해제한다', async () => {
    jest.useFakeTimers();
    const states: boolean[] = [];
    const player = new TtsPlayer({ onPlayingChange: playing => states.push(playing) });
    const audio = encodeWav(new Int16Array(4410).fill(1), 44100, 1);

    player.enqueue(audio, 44100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(states).toEqual([true]);

    jest.advanceTimersByTime(1100);

    expect(states).toEqual([true, false]);
    player.dispose();
  });
});
