// CLI 인자 헬퍼.
//
// 기존 호출처는 모듈 최상위에서 process.argv를 읽는 getArg/validateKnownFlags를
// 그대로 쓴다. 다만 그 형태는 오류 시 process.exit()을 부르기 때문에 테스트에서
// require조차 할 수 없다 — 그래서 argv와 오류 처리기를 주입할 수 있는
// createCliArgs 팩토리를 함께 노출한다.

function createCliArgs(argv, onError) {
  const fail = onError || ((msg) => {
    console.error(msg);
    process.exit(1);
  });

  function getArg(name) {
    const idx = argv.indexOf(name);
    if (idx === -1) return null;
    if (idx + 1 >= argv.length) {
      return fail(`Error: ${name}에 값이 필요합니다.`);
    }
    const val = argv[idx + 1];
    if (val.startsWith('--')) {
      return fail(`Error: ${name}의 값으로 또 다른 플래그 "${val}"가 들어왔습니다. 값을 명시하세요.`);
    }
    return val;
  }

  function validateKnownFlags(known) {
    const seen = new Set();
    for (const arg of argv) {
      if (!arg.startsWith('--')) continue;
      if (!known.includes(arg)) {
        return fail(`Error: 알 수 없는 플래그 "${arg}". 사용 가능: ${known.join(', ')}`);
      }
      if (seen.has(arg)) {
        return fail(`Error: 플래그 "${arg}"가 중복 지정되었습니다.`);
      }
      seen.add(arg);
    }
    return undefined;
  }

  return { getArg, validateKnownFlags };
}

const processArgs = createCliArgs(process.argv.slice(2));

module.exports = {
  createCliArgs,
  getArg: processArgs.getArg,
  validateKnownFlags: processArgs.validateKnownFlags,
};
