/**
 * 언어 학습 알림을 기기에 예약한다 (`DESIGN.md` §15).
 *
 * 서버는 FCM 등으로 푸시를 쏘지 않는다 — 앱이 스스로 예약한다. 매일 반복되는 로컬
 * 알림이라 `@notifee/react-native` 의 트리거 알림(TIMESTAMP + DAILY 반복)으로 충분하고,
 * 서버 없이도 동작한다.
 *
 * 정확한 시각을 요구하지 않는다 (§15 — "며칠에 한 번 몇 분 어긋나는 정도는 감내 가능").
 * 그래서 `AndroidAllowWhileIdle` 같은 정확한 알람 모드를 쓰지 않는다 — 그것은
 * `SCHEDULE_EXACT_ALARM` 권한을 요구하는데, 이 앱에는 그 권한을 받을 만한 값이 없다.
 * 기본 트리거는 배터리 최적화의 영향을 받아 몇 분 밀릴 수 있지만 그걸로 충분하다.
 *
 * 왜 늦게 부르는가
 * ---------------
 * `audio/module.ts` · `storage.ts` 와 같은 이유다. 네이티브 모듈이라 JS 만 새로고침하고
 * APK 를 다시 빌드하지 않으면 못 찾을 수 있다. 이 계층에서 실패해도 앱의 나머지가
 * 죽어서는 안 되므로, 호출부가 감싸 쓰거나(스케줄링은 실패해도 무해) 이 파일 안에서
 * 잡는다.
 */

import type NotifeeModule from '@notifee/react-native';
import { AndroidImportance, AuthorizationStatus, EventType, RepeatFrequency, TriggerType } from '@notifee/react-native';

/**
 * 실물 모듈(기본 export)만 늦게 부른다. 위의 값 import(enum)들은 네이티브를 건드리지 않는
 * 순수 상수라 안전하다 — `index.js` 가 최상단에서 싱글턴을 만들긴 하지만, 그 생성자는
 * `NativeModules['NotifeeApiModule']` 을 조회만 할 뿐 없어도 던지지 않는다
 * (`audio/module.ts` 의 라이브러리와 다른 점). 실제 네이티브 호출은 아래 함수들 안에서만
 * 일어나므로, 그 시점에만 실패가 나면 되고 이 파일을 import 하는 것 자체는 안전하다.
 */
function notifee(): typeof NotifeeModule {
  return require('@notifee/react-native').default;
}

/** `lang_learn.schedule` 의 한 항목 (`PLAN_LANG_LEARN.md` 의 설정 스키마). */
export interface ScheduleSlot {
  /** "HH:MM", 24시간제. */
  time: string;
  count: number;
}

const CHANNEL_ID = 'lang_learn';
/** 슬롯 인덱스로 고정 ID를 만든다 — 재예약 시 같은 ID면 notifee가 덮어쓴다. */
function notificationId(index: number): string {
  return `lang_learn_slot_${index}`;
}

/**
 * 알림 채널을 만들고 권한을 요청한다. Android 13(API 33) 이상은 런타임에 알림 권한을
 * 물어야 하고, 그 아래는 이 호출이 즉시 허용으로 돌아온다.
 *
 * 실패해도 던지지 않는다 — 권한이 없으면 이후 예약이 그냥 알림을 못 띄울 뿐이고,
 * 앱의 나머지 기능에는 영향이 없다.
 */
export async function ensurePermission(): Promise<boolean> {
  try {
    const client = notifee();
    await client.requestPermission();
    await client.createChannel({ id: CHANNEL_ID, name: '언어 학습 알림' });
    const settings = await client.getNotificationSettings();
    return settings.authorizationStatus === AuthorizationStatus.AUTHORIZED;
  } catch (err) {
    console.warn('[notifications] 권한 요청에 실패했다', err);
    return false;
  }
}

/** "HH:MM" 을 오늘 또는(이미 지났으면) 내일의 그 시각으로 바꾼다. */
function nextOccurrence(time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const next = new Date();
  next.setSeconds(0, 0);
  next.setHours(h, m);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

/**
 * 학습 설정의 스케줄 전체를 다시 예약한다. 기존 예약을 지우고 새로 거는 방식이라
 * 스케줄이 바뀔 때마다 이 함수 하나만 다시 부르면 된다 (`PLAN_LANG_LEARN.md` §앱작업3).
 */
export async function scheduleLangLearnNotifications(schedule: ScheduleSlot[]): Promise<void> {
  try {
    const client = notifee();
    await cancelLangLearnNotifications();
    for (const [index, slot] of schedule.entries()) {
      await client.createTriggerNotification(
        {
          id: notificationId(index),
          title: '언어 학습 시간',
          body: `문제 ${slot.count}개가 준비돼 있다. 탭해서 시작한다.`,
          android: {
            channelId: CHANNEL_ID,
            importance: AndroidImportance.DEFAULT,
            pressAction: { id: 'open_lang_learn' },
          },
        },
        {
          type: TriggerType.TIMESTAMP,
          timestamp: nextOccurrence(slot.time).getTime(),
          repeatFrequency: RepeatFrequency.DAILY,
        },
      );
    }
  } catch (err) {
    console.warn('[notifications] 학습 알림 예약에 실패했다', err);
  }
}

/** 예약된 학습 알림을 전부 지운다. */
export async function cancelLangLearnNotifications(): Promise<void> {
  try {
    const client = notifee();
    const ids = await client.getTriggerNotificationIds();
    const ours = ids.filter(id => id.startsWith('lang_learn_slot_'));
    if (ours.length) await client.cancelTriggerNotifications(ours);
  } catch (err) {
    console.warn('[notifications] 학습 알림을 지우지 못했다', err);
  }
}

/**
 * 알림을 탭해서 앱을 열었을 때 호출된다. 포그라운드(앱이 떠 있는 채로 탭)와
 * 콜드 스타트(앱이 죽은 채로 탭) 두 경로를 하나로 합친다.
 *
 * 반환하는 함수를 호출하면 포그라운드 리스너 구독이 풀린다.
 */
export function onLangLearnNotificationPress(handler: () => void): () => void {
  const client = notifee();

  client
    .getInitialNotification()
    .then(initial => {
      if (initial?.notification.id?.startsWith('lang_learn_slot_')) handler();
    })
    .catch(err => console.warn('[notifications] 콜드 스타트 알림 확인 실패', err));

  return client.onForegroundEvent(({ type, detail }) => {
    if (type === EventType.PRESS && detail.notification?.id?.startsWith('lang_learn_slot_')) {
      handler();
    }
  });
}
