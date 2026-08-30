/**
 * `notifications.ts` 배선 검사 (`DESIGN.md` §15).
 *
 * 실제로 기기에 알림이 뜨는지는 여기서 알 수 없다 — 그것은 네이티브이고 실기기/에뮬레이터
 * 에서만 확인된다. 여기서 보는 것은 그 앞뒤의 배선이다: 권한을 묻는지, 스케줄이 트리거
 * 알림으로 정확히 옮겨지는지, 재예약이 기존 것을 지우고 다시 거는지, 알림을 탭했을 때
 * (콜드 스타트/포그라운드 둘 다) 핸들러가 불리는지.
 *
 * 라이브러리는 jest.config.js 가 공식 목(`jest-mock.js`)으로 바꿔 끼운다.
 */

import {
  AuthorizationStatus,
  EventType,
  RepeatFrequency,
  TriggerType,
} from '@notifee/react-native';
import {
  cancelLangLearnNotifications,
  ensurePermission,
  onLangLearnNotificationPress,
  scheduleLangLearnNotifications,
} from '../notifications';

function mockClient() {
  return require('@notifee/react-native').default;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('권한을 묻고 채널을 만든 뒤, 허용 여부를 돌려준다', async () => {
  const client = mockClient();
  client.getNotificationSettings.mockResolvedValueOnce({
    authorizationStatus: AuthorizationStatus.AUTHORIZED,
  });

  const granted = await ensurePermission();

  expect(client.requestPermission).toHaveBeenCalled();
  expect(client.createChannel).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'lang_learn' }),
  );
  expect(granted).toBe(true);
});

test('거부되면 false를 돌려주고, 예외가 나도 던지지 않는다', async () => {
  const client = mockClient();
  client.getNotificationSettings.mockResolvedValueOnce({
    authorizationStatus: AuthorizationStatus.DENIED,
  });
  expect(await ensurePermission()).toBe(false);

  client.requestPermission.mockRejectedValueOnce(new Error('boom'));
  await expect(ensurePermission()).resolves.toBe(false);
});

test('스케줄 각 항목을 슬롯 ID로 트리거 알림으로 만든다', async () => {
  const client = mockClient();
  client.getTriggerNotificationIds.mockResolvedValueOnce([]);

  await scheduleLangLearnNotifications([
    { time: '08:00', count: 3 },
    { time: '20:00', count: 5 },
  ]);

  expect(client.createTriggerNotification).toHaveBeenCalledTimes(2);

  const [firstNotification, firstTrigger] = client.createTriggerNotification.mock.calls[0];
  expect(firstNotification.id).toBe('lang_learn_slot_0');
  expect(firstNotification.body).toContain('3개');
  expect(firstTrigger.type).toBe(TriggerType.TIMESTAMP);
  expect(firstTrigger.repeatFrequency).toBe(RepeatFrequency.DAILY);
  expect(firstTrigger.timestamp).toBeGreaterThan(Date.now());

  const [secondNotification] = client.createTriggerNotification.mock.calls[1];
  expect(secondNotification.id).toBe('lang_learn_slot_1');
});

test('다시 부르면 이전 학습 알림만 지우고 새로 건다 — 다른 알림은 건드리지 않는다', async () => {
  const client = mockClient();
  client.getTriggerNotificationIds.mockResolvedValueOnce([
    'lang_learn_slot_0',
    'lang_learn_slot_1',
    'other_feature_id',
  ]);

  await scheduleLangLearnNotifications([{ time: '08:00', count: 3 }]);

  expect(client.cancelTriggerNotifications).toHaveBeenCalledWith([
    'lang_learn_slot_0',
    'lang_learn_slot_1',
  ]);
});

test('예약이 하나도 없으면 지우기를 호출하지 않는다', async () => {
  const client = mockClient();
  client.getTriggerNotificationIds.mockResolvedValueOnce([]);

  await cancelLangLearnNotifications();

  expect(client.cancelTriggerNotifications).not.toHaveBeenCalled();
});

test('콜드 스타트로 학습 알림을 탭해 열었으면 즉시 핸들러를 부른다', async () => {
  const client = mockClient();
  client.getInitialNotification.mockResolvedValueOnce({
    notification: { id: 'lang_learn_slot_0' },
  });

  const handler = jest.fn();
  onLangLearnNotificationPress(handler);
  await Promise.resolve();
  await Promise.resolve();

  expect(handler).toHaveBeenCalledTimes(1);
});

test('다른 알림으로 콜드 스타트했으면 핸들러를 부르지 않는다', async () => {
  const client = mockClient();
  client.getInitialNotification.mockResolvedValueOnce({
    notification: { id: 'other_feature_id' },
  });

  const handler = jest.fn();
  onLangLearnNotificationPress(handler);
  await Promise.resolve();
  await Promise.resolve();

  expect(handler).not.toHaveBeenCalled();
});

test('포그라운드에서 학습 알림을 탭하면 핸들러를 부른다', async () => {
  const client = mockClient();
  client.getInitialNotification.mockResolvedValueOnce(null);
  let emit: (event: unknown) => void = () => {};
  client.onForegroundEvent.mockImplementationOnce((cb: (event: unknown) => void) => {
    emit = cb;
    return jest.fn();
  });

  const handler = jest.fn();
  onLangLearnNotificationPress(handler);

  emit({ type: EventType.PRESS, detail: { notification: { id: 'lang_learn_slot_1' } } });
  expect(handler).toHaveBeenCalledTimes(1);

  // PRESS 가 아니거나 우리 알림이 아니면 무시한다.
  emit({ type: EventType.DISMISSED, detail: { notification: { id: 'lang_learn_slot_1' } } });
  emit({ type: EventType.PRESS, detail: { notification: { id: 'other_feature_id' } } });
  expect(handler).toHaveBeenCalledTimes(1);
});

test('구독 해제 함수는 notifee가 돌려준 것을 그대로 넘긴다', () => {
  const client = mockClient();
  client.getInitialNotification.mockResolvedValueOnce(null);
  const unsubscribe = jest.fn();
  client.onForegroundEvent.mockReturnValueOnce(unsubscribe);

  const result = onLangLearnNotificationPress(() => {});
  expect(result).toBe(unsubscribe);
});
