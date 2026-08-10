/** 두 화면이 함께 쓰는 버튼. App.tsx 에 있던 것을 그대로 옮겼다. */

import { Pressable, Text } from 'react-native';

import { ui } from './theme';
import type { Palette } from './theme';

export function Button({
  label,
  onPress,
  disabled,
  colors,
  tone,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  colors: Palette;
  /** 기본은 accent. 'danger' 는 연결을 끊는 버튼처럼 되돌리는 동작에 쓴다. */
  tone?: 'accent' | 'danger';
}) {
  const background = tone === 'danger' ? colors.bad : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        ui.button,
        { backgroundColor: background, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}>
      <Text style={ui.buttonText}>{label}</Text>
    </Pressable>
  );
}
