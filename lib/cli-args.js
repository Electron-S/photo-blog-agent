const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  if (idx + 1 >= args.length) {
    console.error(`Error: ${name}에 값이 필요합니다.`);
    process.exit(1);
  }
  const val = args[idx + 1];
  if (val.startsWith('--')) {
    console.error(`Error: ${name}의 값으로 또 다른 플래그 "${val}"가 들어왔습니다. 값을 명시하세요.`);
    process.exit(1);
  }
  return val;
}

function validateKnownFlags(known) {
  const seen = new Set();
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    if (!known.includes(arg)) {
      console.error(`Error: 알 수 없는 플래그 "${arg}". 사용 가능: ${known.join(', ')}`);
      process.exit(1);
    }
    if (seen.has(arg)) {
      console.error(`Error: 플래그 "${arg}"가 중복 지정되었습니다.`);
      process.exit(1);
    }
    seen.add(arg);
  }
}

module.exports = { getArg, validateKnownFlags };
