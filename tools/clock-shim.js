// 시스템 시계를 CLOCK_OFFSET_MS만큼 옮긴 채 테스트를 돌린다.
//   node --require tools/clock-shim.js --test test/
//   (test/ 밖에 두는 이유: node --test가 test/ 하위 .js를 전부 테스트 파일로 센다)
//
// **왜 필요한가.** lib/slug.js의 checkDatePlausible이 "미래 날짜는 카메라 시계
// 오류"라고 판정하므로, 날짜를 하드코딩한 테스트가 `new Date()` 기본값에 의존하면
// 시계가 그 날짜보다 이전인 머신·CI에서 조용히 깨진다. 실측으로 시계를 1년
// 뒤로 돌렸을 때 2건이 실패했고, 그건 테스트가 시간에 종속됐다는 신호였다.
// 이제 모든 시간 종속 테스트가 now를 주입하며, 이 shim이 그것을 강제한다.
const OFFSET = Number(process.env.CLOCK_OFFSET_MS || 0);
const RealDate = Date;
class ShimDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + OFFSET);
    else super(...args);
  }
  static now() { return RealDate.now() + OFFSET; }
}
global.Date = ShimDate;
