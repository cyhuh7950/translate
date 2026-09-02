/**
 * 두 화면이 함께 쓰는 색과 스타일 조각.
 *
 * 스파이크 단계의 화면이라 디자인 시스템이 아니다 — App.tsx 에 있던 팔레트를 두 화면이
 * 쓸 수 있게 옮겨둔 것뿐이다. 화면 문구도 한국어를 그대로 쓴다(i18n 대상 아님).
 */

import { StyleSheet } from 'react-native';

export interface Palette {
  bg: string;
  fg: string;
  dim: string;
  border: string;
  field: string;
  accent: string;
  bad: string;
  badBg: string;
  good: string;
}

export const light: Palette = {
  bg: '#F5F7FB',
  fg: '#14213D',
  dim: '#6C7893',
  border: '#E4E9F2',
  field: '#FFFFFF',
  accent: '#1F6BFF',
  bad: '#D94A5A',
  badBg: '#FFF1F3',
  good: '#19A987',
};

export const dark: Palette = {
  bg: '#0b0f14',
  fg: '#e5e7eb',
  dim: '#9ca3af',
  border: '#374151',
  field: '#111827',
  accent: '#3b82f6',
  bad: '#f87171',
  badBg: '#1f1416',
  good: '#4ade80',
};

/** 제품 화면이 공유하는 시각 토큰. 화면별 임의 색상 추가를 막는다. */
export const productTheme = {
  colors: {
    background: '#F5F7FB',
    surface: '#FFFFFF',
    primary: '#1F6BFF',
    accent: '#19C6A3',
    ink: '#14213D',
    muted: '#6C7893',
  },
  radius: { card: 24, control: 16, pill: 999 },
  spacing: { screen: 20, card: 18, section: 16 },
};

export const ui = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 8 },
  title: { fontSize: 28, fontWeight: '800', letterSpacing: -0.6 },
  sub: { fontSize: 14, marginBottom: 14, lineHeight: 20 },
  label: { fontSize: 12, fontWeight: '700', marginTop: 14, marginBottom: 6, letterSpacing: 0.2 },
  input: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 13,
    fontSize: 15,
  },
  multiline: { minHeight: 76, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 10, marginTop: 16 },
  button: { flex: 1, borderRadius: 16, paddingVertical: 15, alignItems: 'center' },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  busyText: { fontSize: 13 },
  box: { borderWidth: 1, borderRadius: 20, padding: 18, marginTop: 16 },
  boxTitle: { fontSize: 11, fontWeight: '800', marginBottom: 8, letterSpacing: 1.1 },
  mono: { fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
});
