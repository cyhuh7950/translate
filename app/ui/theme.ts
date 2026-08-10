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
  bg: '#ffffff',
  fg: '#111111',
  dim: '#6b7280',
  border: '#d1d5db',
  field: '#f9fafb',
  accent: '#2563eb',
  bad: '#b91c1c',
  badBg: '#fef2f2',
  good: '#15803d',
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

export const ui = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 4 },
  title: { fontSize: 24, fontWeight: '700' },
  sub: { fontSize: 13, marginBottom: 12, lineHeight: 18 },
  label: { fontSize: 12, marginTop: 12, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  multiline: { minHeight: 76, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 10, marginTop: 20 },
  button: { flex: 1, borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  busyText: { fontSize: 13 },
  box: { borderWidth: 1, borderRadius: 8, padding: 12, marginTop: 16 },
  boxTitle: { fontSize: 11, fontWeight: '700', marginBottom: 6, letterSpacing: 1 },
  mono: { fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
});
