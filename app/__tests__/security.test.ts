declare const __dirname: string;

const fs = require('fs');
const path = require('path');
const appRoot = path.resolve(__dirname, '..');

describe('공개 저장소 보안 경계', () => {
  it('Android 키스토어를 추적 예외로 허용하지 않고 기본 서명을 사용한다', () => {
    const ignore = fs.readFileSync(path.join(appRoot, '.gitignore'), 'utf8');
    const gradle = fs.readFileSync(path.join(appRoot, 'android', 'app', 'build.gradle'), 'utf8');

    expect(ignore).toContain('*.keystore');
    expect(ignore).not.toContain('!debug.keystore');
    expect(gradle).not.toContain("storeFile file('debug.keystore')");
  });
});
